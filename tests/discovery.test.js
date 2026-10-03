const test = require('node:test');
const assert = require('node:assert/strict');
const { load, rng, makeCandles } = require('./load.js');
const { planted } = require('./synth.js');

const { OTC } = load();
const FL = OTC.FeatureLib, D = OTC.Discovery;
const same = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);
const T0 = 1_700_000_000 - (1_700_000_000 % 3600);
const cfg = OTC.config({ discovery: { timeBudgetSec: 120 } });
const dc = cfg.discovery;

// Hand-built dataset: rows with chosen feature values and outcomes (1 up, −1 down).
function fakeDs(n, fn, { seed = 1, assets = ['EURUSD_otc'] } = {}) {
  const r = rng(seed), rows = [];
  for (let i = 0; i < n; i++) {
    const asset = assets[i % assets.length];
    const { vec, pUp } = fn(i, r);
    const o = () => (r() < pUp ? 1 : -1);
    rows.push({ time: T0 + Math.floor(i / assets.length) * 300 + 300, asset, payout: 85, entry: 1, out: [o(), o(), o()], vec });
  }
  return D.columnar(rows, dc);
}

// ── feature library and rule language ───────────────────────────────────────
test('feature library: live vector has every feature; values from a real context', () => {
  const c5 = makeCandles({ start: T0, segments: [{ n: 400, drift: 0.3, vol: 0.0004 }] });
  const series = { 300: c5, 900: OTC.U.aggregate(c5, 300, 900), 3600: OTC.U.aggregate(c5, 300, 3600) };
  const X = OTC.Pipeline.buildContext(series, { cfg });
  const a = OTC.Pipeline.deepAnalyze(X, {});
  const v = FL.vector(FL.context(X, { analysis: a, time: c5[399].time + 300, candleTime: c5[399].time, asset: 'EURUSD_otc' }));
  for (const f of FL.FEATURES) assert.ok(f.id in v, f.id);
  assert.ok(FL.FEATURES.length >= 150, `${FL.FEATURES.length} features`);
  assert.equal(v['t5.dir'], X.f5.trend.dir);
  assert.ok(typeof v['m5.rsi'] === 'number');
  assert.equal(v['pair'], 'EURUSD_otc');
  assert.ok(['CALL', 'PUT', 'none'].includes(v['strat.trend_following']));
});

test('rule keys: equivalent rules normalise to one key', () => {
  const a = { dir: 'CALL', expiry: 1, all: [{ f: 'm5.rsi', op: '>=', v: 30 }, { f: 'm5.rsi', op: '<=', v: 40 }, { f: 't60.dir', op: '==', v: 'UP' }] };
  const b = { dir: 'CALL', expiry: 1, all: [{ f: 't60.dir', op: '==', v: 'UP' }, { f: 'm5.rsi', op: '<=', v: 40 }, { f: 'm5.rsi', op: '>=', v: 30 }] };
  assert.equal(FL.ruleKey(a), FL.ruleKey(b));
  // "not false" on a boolean is "true"; duplicates collapse
  const c = { dir: 'PUT', expiry: 2, all: [{ f: 'pa.doji', op: '!=', v: false }, { f: 'pa.doji', op: '==', v: true }] };
  assert.equal(FL.normalize(c).all.length, 1);
  assert.notEqual(FL.ruleKey(a), FL.ruleKey({ ...a, dir: 'PUT' }));
  assert.notEqual(FL.ruleKey(a), FL.ruleKey({ ...a, expiry: 2 }));
});

test('mirror: CALL ↔ PUT versions of atoms are consistent and reversible', () => {
  const cases = [
    [{ f: 'm5.rsi', op: '<=', v: 30 }, { f: 'm5.rsi', op: '>=', v: 70 }],
    [{ f: 't5.dist_e21', op: '>=', v: 0.5 }, { f: 't5.dist_e21', op: '<=', v: -0.5 }],
    [{ f: 'p5.lower_wick', op: '>=', v: 0.5 }, { f: 'p5.upper_wick', op: '>=', v: 0.5 }],
    [{ f: 't60.dir', op: '==', v: 'UP' }, { f: 't60.dir', op: '==', v: 'DOWN' }],
    [{ f: 'pa.bull_engulf', op: '==', v: true }, { f: 'pa.bear_engulf', op: '==', v: true }],
    [{ f: 'seq3', op: '==', v: 'U+,D,U' }, { f: 'seq3', op: '==', v: 'D+,U,D' }],
    [{ f: 'ctx.regime', op: '==', v: 'TRENDING_UP' }, { f: 'ctx.regime', op: '==', v: 'TRENDING_DOWN' }],
  ];
  for (const [a, m] of cases) {
    same(FL.mirrorAtom(a), m);
    same(FL.mirrorAtom(FL.mirrorAtom(a)), a);
  }
  assert.equal(FL.mirrorRule({ dir: 'CALL', expiry: 1, all: [cases[0][0]] }).dir, 'PUT');
});

test('complexity: the same concept on several timeframes counts as one idea', () => {
  const r = { dir: 'CALL', expiry: 1, all: [{ f: 't5.dir', op: '==', v: 'UP' }, { f: 't15.dir', op: '==', v: 'UP' }, { f: 't60.dir', op: '==', v: 'UP' }] };
  assert.equal(FL.complexity(r), 2);
  assert.equal(FL.complexity({ ...r, all: [r.all[0], { f: 'm5.rsi', op: '<=', v: 40 }] }), 2);
});

// ── evaluation ───────────────────────────────────────────────────────────────
test('evaluation: non-overlapping per pair, ties excluded, EV and break-even from payouts', () => {
  const ds = fakeDs(60, (i) => ({ vec: { 'pa.doji': true }, pUp: i % 2 ? 1 : 0 }), { seed: 2 });
  const rule = { dir: 'CALL', expiry: 3, all: [{ f: 'pa.doji', op: '==', v: true }] };
  const s = D.evalRule(ds, rule, 0, ds.n);
  assert.equal(s.matched, 60);
  assert.equal(s.n + s.t, 20); // every third row (3-candle expiry) counts
  assert.equal(s.skippedOverlap, 40);
  assert.ok(Math.abs(s.be - OTC.U.breakEven(85)) < 1e-6);
  assert.ok(Math.abs(s.ev - (s.w * 0.85 - s.l) / (s.n + s.t)) < 1e-9);
  // two pairs at the same times are counted separately
  const ds2 = fakeDs(60, () => ({ vec: { 'pa.doji': true }, pUp: 1 }), { assets: ['EURUSD_otc', 'GBPUSD_otc'] });
  assert.equal(D.evalRule(ds2, { ...rule, expiry: 1 }, 0, ds2.n).n, 60);
});

test('splits are chronological and on time boundaries', () => {
  const ds = fakeDs(1000, () => ({ vec: {}, pUp: 0.5 }), { assets: ['A', 'B'].map((x) => `${x}AAUSD_otc`) });
  const sp = D.splits(ds, [0.6, 0.2, 0.2]);
  assert.ok(ds.time[sp.cut1 - 1] < ds.time[sp.cut1]);
  assert.ok(ds.time[sp.cut2 - 1] < ds.time[sp.cut2]);
  assert.ok(Math.abs(sp.cut1 - 600) <= 2 && Math.abs(sp.cut2 - 800) <= 2);
});

test('statistics helpers: BH q-values, two-proportion z, binomial p-value', () => {
  const q = D.bhQ([0.01, 0.04, 0.03, 0.5]);
  // sorted p: .01 .03 .04 .5 → q = .04, .0533, .0533, .5
  assert.ok(Math.abs(q[0] - 0.04) < 1e-9 && Math.abs(q[2] - 0.16 / 3) < 1e-9 && Math.abs(q[1] - 0.16 / 3) < 1e-9 && Math.abs(q[3] - 0.5) < 1e-9);
  assert.ok(D.twoPropZ(30, 100, 60, 100) < -4);
  assert.ok(D.pAbove(70, 100, 0.54) < 0.01 && D.pAbove(54, 100, 0.54) > 0.4);
  assert.equal(D.sampleClass(99, dc), 'INSUFFICIENT');
  assert.equal(D.sampleClass(150, dc), 'PRELIMINARY');
  assert.equal(D.sampleClass(500, dc), 'RESEARCH');
  assert.equal(D.sampleClass(5000, dc), 'STRONGER');
});

// ── anti-overfitting tools ───────────────────────────────────────────────────
test('robustness: a rule that only works in one narrow bucket is LOW; a broad effect is HIGH', () => {
  const narrow = fakeDs(9000, (i, r) => { const rsi = 20 + r() * 60; return { vec: { 'm5.rsi': rsi }, pUp: rsi >= 30 && rsi < 35 ? 0.9 : 0.4 }; }, { seed: 3 });
  const sp = D.splits(narrow, [0.6, 0.2, 0.2]);
  const rule = { dir: 'CALL', expiry: 1, all: [{ f: 'm5.rsi', op: 'between', v: [30, 35] }], none: [] };
  const rb = OTC.Discovery.robustness(narrow, rule, sp, dc, D.evalRule(narrow, rule, ...sp.train));
  assert.equal(rb.label, 'LOW', JSON.stringify(rb.neighbors.map((x) => [x.why, x.wr])));
  const broad = fakeDs(9000, (i, r) => { const rsi = 20 + r() * 60; return { vec: { 'm5.rsi': rsi }, pUp: rsi < 45 ? 0.72 : 0.45 }; }, { seed: 4 });
  const sp2 = D.splits(broad, [0.6, 0.2, 0.2]);
  const rule2 = { dir: 'CALL', expiry: 1, all: [{ f: 'm5.rsi', op: '<=', v: 35 }], none: [] };
  assert.equal(OTC.Discovery.robustness(broad, rule2, sp2, dc, D.evalRule(broad, rule2, ...sp2.train)).label, 'HIGH');
});

test('importance and simplification remove a condition that adds nothing', () => {
  const ds = fakeDs(8000, (i, r) => { const a = r() < 0.3, b = r() < 0.5; return { vec: { 'pa.doji': a, 'm5.accel': b }, pUp: a ? 0.75 : 0.45 }; }, { seed: 5 });
  const sp = D.splits(ds, [0.6, 0.2, 0.2]);
  const rule = { dir: 'CALL', expiry: 1, all: [{ f: 'pa.doji', op: '==', v: true }, { f: 'm5.accel', op: '==', v: true }], none: [] };
  const imp = OTC.Discovery.importance(ds, rule, sp, dc, D.evalRule(ds, rule, ...sp.train));
  assert.equal(imp[0].condition, FL.label(rule.all[0]));
  assert.ok(imp[0].drop > imp[1].drop);
  const simp = D.simplify(ds, rule, sp.train, dc);
  same(simp.rule.all, [{ f: 'pa.doji', op: '==', v: true }]);
});

test('negative conditions: finds the condition under which a working rule fails', () => {
  const ds = fakeDs(12000, (i, r) => { const a = r() < 0.4, c = r() < 0.3; return { vec: { 'pa.doji': a, 'b5.squeeze': c }, pUp: a ? (c ? 0.35 : 0.8) : 0.5 }; }, { seed: 6 });
  const sp = D.splits(ds, [0.6, 0.2, 0.2]);
  const { pool } = D.buildAtoms(ds, sp.train, dc);
  const negs = D.findNegatives(ds, pool, { dir: 'CALL', expiry: 1, all: [{ f: 'pa.doji', op: '==', v: true }], none: [] }, sp, dc);
  assert.ok(negs.some((n) => n.atom.f === 'b5.squeeze' && n.atom.v === true), JSON.stringify(negs.map((n) => n.atom)));
});

// ── storage rows ─────────────────────────────────────────────────────────────
test('rows: ids are stable across runs, versions are added, live stages survive re-evaluation', () => {
  const rule = FL.normalize({ dir: 'CALL', expiry: 1, all: [{ f: 'pa.doji', op: '==', v: true }] });
  const cand = (status) => ({ rule, key: FL.ruleKey(rule), type: 'STRATEGY', origin: 'discovery', status, statusReason: 'x', history: [], flags: [],
    train: { n: 200, w: 120, l: 80, t: 0 }, val: { n: 60 }, oos: { n: 60 }, complexity: 1, dir: 'CALL', expiry: 1, name: 'n' });
  const r1 = OTC.Discovery.toRows([cand('PAPER_TEST')], [], 'RUN-1', 1000).rows[0];
  assert.equal(r1.strategy_id, 'DISC-00001');
  assert.equal(r1.version, 1);
  const promoted = { ...r1, status: 'PROMOTED' };
  const r2 = OTC.Discovery.toRows([cand('PAPER_TEST')], [promoted], 'RUN-2', 2000).rows[0];
  assert.equal(r2.strategy_id, 'DISC-00001');
  assert.equal(r2.version, 2);
  assert.equal(r2.status, 'PROMOTED');
  assert.notEqual(r2.key, r1.key);
  const r3 = OTC.Discovery.toRows([cand('OVERFIT')], [promoted], 'RUN-3', 3000).rows[0];
  assert.equal(r3.status, 'WATCHLIST');
  assert.match(r3.status_reason, /re-evaluation/);
  const other = OTC.Discovery.toRows([{ ...cand('REJECTED'), rule: { ...rule, expiry: 2 }, key: FL.ruleKey({ ...rule, expiry: 2 }) }], [promoted], 'RUN-4', 4000).rows[0];
  assert.equal(other.strategy_id, 'DISC-00002');
});

// ── lifecycle and live layer ─────────────────────────────────────────────────
const liveRec = (i, asset, dir, win, id) => ({ id: `r${i}`, source: 'live', asset, ts: 2000 + i * 600, candleTime: 1700 + i * 600, entryPrice: 1, exits: { 1: win ? (dir === 'CALL' ? 1.1 : 0.9) : (dir === 'CALL' ? 0.9 : 1.1) }, payout: 85, disc: [[id, dir, 1]] });

test('lifecycle: paper test passes → WATCHLIST, fails → REJECTED; promoted decays → WATCHLIST → DECAYING', () => {
  const row = { strategy_id: 'DISC-00009', type: 'STRATEGY', direction: 'CALL', expiry: 1, status: 'PAPER_TEST', live_since: 0, version: 1 };
  const good = Array.from({ length: 80 }, (_, i) => liveRec(i, 'EURUSD_otc', 'CALL', i % 4 !== 0, 'DISC-00009'));
  assert.equal(OTC.Lifecycle.liveLifecycle(row, good, dc).status, 'WATCHLIST');
  const bad = Array.from({ length: 80 }, (_, i) => liveRec(i, 'EURUSD_otc', 'CALL', i % 2 === 0 && i % 4 !== 0, 'DISC-00009'));
  assert.equal(OTC.Lifecycle.liveLifecycle(row, bad, dc).status, 'REJECTED');
  assert.ok(OTC.Lifecycle.liveLifecycle(row, good.slice(0, 10), dc).unchanged);
  const promoted = { ...row, status: 'PROMOTED' };
  const slipping = Array.from({ length: 60 }, (_, i) => liveRec(i, 'EURUSD_otc', 'CALL', i % 2 === 0, 'DISC-00009'));
  assert.equal(OTC.Lifecycle.liveLifecycle(promoted, slipping, dc).status, 'WATCHLIST');
  const collapsing = Array.from({ length: 60 }, (_, i) => liveRec(i, 'EURUSD_otc', 'CALL', i % 3 === 0, 'DISC-00009'));
  assert.equal(OTC.Lifecycle.liveLifecycle(promoted, collapsing, dc).status, 'DECAYING');
  // a new version row keeps the history
  const nv = OTC.Lifecycle.nextVersion({ ...row, history: [{ stage: 'PAPER_TEST' }] }, 'WATCHLIST', 'ok', 5);
  assert.equal(nv.version, 2);
  assert.equal(nv.history.length, 2);
});

test('ensemble: correlated strategies count once, opposite votes cancel', () => {
  const d = (id, dir, rel, cluster) => ({ id, dir, reliability: rel, cluster });
  const a = OTC.Lifecycle.ensemble([d('A', 'CALL', 5, 'C1'), d('B', 'CALL', 5, 'C1'), d('C', 'CALL', 5, 'C1')]);
  const b = OTC.Lifecycle.ensemble([d('A', 'CALL', 5, 'C1'), d('B', 'CALL', 5, 'C2'), d('C', 'CALL', 5, 'C3')]);
  assert.ok(b.CALL.score > a.CALL.score);
  assert.equal(a.CALL.clusters, 1);
  assert.equal(OTC.Lifecycle.ensemble([d('A', 'CALL', 5, 'C1'), d('B', 'PUT', 5, 'C2')]).dir, null);
});

test('live layer: promoted strategy can trade when the engine skips; promoted filter blocks; tracked ones are recorded', () => {
  const c5 = makeCandles({ start: T0, segments: [{ n: 400, drift: 0.3, vol: 0.0004 }], seed: 3 });
  const series = { 300: c5, 900: OTC.Pipeline.htfWithPartial(OTC.U.aggregate(c5, 300, 900), c5, 900), 3600: OTC.Pipeline.htfWithPartial(OTC.U.aggregate(c5, 300, 3600), c5, 3600) };
  const X = OTC.Pipeline.buildContext(series, { cfg });
  const dq = OTC.DataQuality.checkSnapshot(series, { cfg });
  const meta = { asset: 'EURUSD_otc', time: c5[399].time + 300, candleTime: c5[399].time };
  const always = (dir, extra = {}) => ({ id: `DISC-${dir}`, version: 1, type: 'STRATEGY', status: 'PROMOTED', dir, expiry: 1, reliability: 5, cluster: 'C1', name: 'test',
    rule: { dir, expiry: 1, all: [{ f: 'pair', op: '==', v: 'EURUSD_otc' }], none: [] }, ...extra });
  try {
    const base = OTC.Pipeline.deepAnalyze(X, { dq, scan: { score: 0 } });
    assert.equal(base.decision, 'SKIP');
    // the lean direction is not blocked by a hard veto in this up-trend context; use whichever side passes
    OTC.Lifecycle.setLive([always('CALL')]);
    const a = OTC.Pipeline.deepAnalyze(X, { dq, scan: { score: 0 }, meta });
    same(a.disc, [['DISC-CALL', 'CALL', 1]]);
    if (!OTC.Contradiction.evaluate(X, 'CALL', a.confluence, a.fired, cfg).hard.length) {
      assert.equal(a.decision, 'CALL');
      assert.equal(a.setup, 'DISC-CALL');
    }
    // a promoted filter on the engine's own lean blocks a CALL decision
    OTC.Lifecycle.setLive([always('CALL'), { ...always('CALL'), id: 'FILT-1', type: 'FILTER', basis: 'eng.lean' }]);
    const b = OTC.Pipeline.deepAnalyze(X, { dq, scan: { score: 0 }, meta });
    assert.ok(b.disc.some((x) => x[0] === 'FILT-1'));
    // without meta (backtests, discovery datasets) the live layer never runs
    assert.equal(OTC.Pipeline.deepAnalyze(X, { dq, scan: { score: 0 } }).disc, undefined);
    // PAPER_TEST strategies are recorded but never trade
    OTC.Lifecycle.setLive([always('PUT', { status: 'PAPER_TEST' })]);
    const c = OTC.Pipeline.deepAnalyze(X, { dq, scan: { score: 0 }, meta });
    assert.equal(c.decision, 'SKIP');
    same(c.disc, [['DISC-PUT', 'PUT', 1]]);
  } finally { OTC.Lifecycle.setLive([]); }
});

test('profiles: regime wildcard and discovered ids', () => {
  const rec = { decision: 'CALL', regime: 'RANGING', strategies: [], disc: [['DISC-00007', 'CALL', 3]] };
  assert.equal(OTC.Stats.matchProfile(rec, ['DISC-00007|*|E2'], null), 'DISC-00007|*|E2');
  assert.equal(OTC.Stats.matchProfile(rec, ['DISC-00007|*|E2'], 1), null);
  assert.equal(OTC.Stats.matchProfile({ ...rec, disc: [['DISC-00007', 'PUT', 3]] }, ['DISC-00007|*|E2'], null), null);
});

// ── full cycles ──────────────────────────────────────────────────────────────
const dsPlanted = OTC.Discovery.buildDataset([{ asset: 'EURUSD_otc', c5: planted({ n: 4500, edge: 0.74 }) }], { cfg, yieldEvery: 0 });
const dsNoise = OTC.Discovery.buildDataset([{ asset: 'EURUSD_otc', c5: planted({ n: 4500, edge: 0.5, seed: 21 }) }], { cfg, yieldEvery: 0 });

test('cycle on a planted edge: rediscovers it, validates it, and the search walk-forward holds', async () => {
  const res = await OTC.Discovery.runCycle(await dsPlanted, { cfg, nowMs: 1, runId: 'RUN-P' });
  const passed = res.rows.filter((r) => r.status === 'PAPER_TEST' && r.type === 'STRATEGY');
  assert.ok(passed.length > 0, res.report.message);
  const wick = passed.find((r) => r.direction === 'CALL' && r.rule.all.some((a) => /lower_wick|lwr_bull|bull_rejection|pin_bull|hammer/.test(a.f || JSON.stringify(a))));
  assert.ok(wick, passed.map((r) => r.name).join('\n'));
  assert.ok(wick.out_of_sample_results.wr > 60);
  assert.ok(wick.explanation.includes('not a known cause'));
  assert.ok(res.report.processWalkForward.wr > res.report.processWalkForward.be);
  // nothing is ever promoted by a cycle
  assert.equal(res.rows.filter((r) => r.status === 'PROMOTED').length, 0);
  // every stored row keeps the exact rule and the data fingerprint of its run
  assert.ok(res.rows.every((r) => r.ruleKey && r.rule && r.run_id === 'RUN-P'));
  assert.ok(res.run.dataset.hash);
});

test('cycle on pure noise: finds nothing and says so', async () => {
  const res = await OTC.Discovery.runCycle(await dsNoise, { cfg, nowMs: 1, runId: 'RUN-N' });
  assert.equal(res.rows.filter((r) => r.status === 'PAPER_TEST' && r.type === 'STRATEGY').length, 0, res.rows.filter((r) => r.status === 'PAPER_TEST').map((r) => r.name).join('\n'));
  assert.equal(res.report.nothingFound, true);
  assert.match(res.report.message, /not lowered/);
  assert.ok(res.report.processWalkForward.wr < res.report.processWalkForward.be);
});

test('a second cycle re-evaluates earlier finds under the same ids and mutates them', async () => {
  const ds = await dsPlanted;
  const first = await OTC.Discovery.runCycle(ds, { cfg: OTC.config({ discovery: { processWalkForward: false } }), nowMs: 1, runId: 'RUN-1' });
  const latest = OTC.Lifecycle.latest(first.rows);
  const second = await OTC.Discovery.runCycle(ds, { cfg: OTC.config({ discovery: { processWalkForward: false } }), existing: latest, previousRuns: [first.run], nowMs: 2, runId: 'RUN-2' });
  const tracked = latest.filter((r) => r.status === 'PAPER_TEST');
  for (const t of tracked) {
    const again = second.rows.find((r) => r.strategy_id === t.strategy_id);
    assert.ok(again, `${t.strategy_id} re-evaluated`);
    assert.equal(again.version, t.version + 1);
  }
  assert.ok(second.rows.some((r) => r.origin === 'mutation'));
  assert.ok(second.report.oosReuse >= 1);
});
