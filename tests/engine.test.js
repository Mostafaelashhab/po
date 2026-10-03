// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeCandles } = require('./load.js');

const ctx = load();
const { OTC, Ind } = ctx;
const cfg = OTC.config();
const T0 = 1_700_000_100 - (1_700_000_100 % 3600);
// Objects from the vm context have other prototypes; compare their JSON.
const same = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);

const up = (n = 300, seed = 3) => makeCandles({ start: T0, segments: [{ n, drift: 0.45, vol: 0.0004 }], seed });
const down = (n = 300, seed = 4) => makeCandles({ start: T0, segments: [{ n, drift: -0.45, vol: 0.0004 }], seed });
const flat = (n = 300, seed = 5) => makeCandles({ start: T0, segments: [{ n, drift: 0, vol: 0.0004 }], seed });
const ctxFor = (c5) => {
  const series = {
    300: c5,
    900: OTC.Pipeline.htfWithPartial(OTC.U.aggregate(c5, 300, 900), c5, 900),
    3600: OTC.Pipeline.htfWithPartial(OTC.U.aggregate(c5, 300, 3600), c5, 3600),
  };
  return { series, X: OTC.Pipeline.buildContext(series, { cfg }) };
};
const candle = (time, o, h, l, c) => ({ time, open: o, high: h, low: l, close: c });

// ── core ─────────────────────────────────────────────────────────────────────
test('aggregate keeps only complete buckets, or flags a partial last one', () => {
  const c = flat(7).map((x, i) => ({ ...x, time: T0 + i * 300 }));
  const full = OTC.U.aggregate(c, 300, 900);
  assert.equal(full.length, 2);
  assert.equal(full[0].open, c[0].open);
  assert.equal(full[0].close, c[2].close);
  assert.equal(full[0].high, Math.max(c[0].high, c[1].high, c[2].high));
  const part = OTC.U.aggregate(c, 300, 900, { allowPartialLast: true });
  assert.equal(part.length, 3);
  assert.equal(part[2].partial, true);
  // a missing candle inside a bucket makes it incomplete
  const gap = c.filter((_, i) => i !== 1);
  assert.equal(OTC.U.aggregate(gap, 300, 900).length, 1);
});

test('config merge keeps defaults and replaces arrays', () => {
  const c = OTC.config({ risk: { maxTradesPerDay: 3 }, expiries: [2] });
  assert.equal(c.risk.maxTradesPerDay, 3);
  assert.equal(c.risk.maxConsecutiveLosses, OTC.DEFAULT_CONFIG.risk.maxConsecutiveLosses);
  same(c.expiries, [2]);
  same(OTC.DEFAULT_CONFIG.expiries, [1, 2, 3]);
});

test('currencies, labels and break-even', () => {
  assert.deepEqual([...OTC.U.currencies('EURUSD_otc')], ['EUR', 'USD']);
  assert.equal(OTC.U.pairLabel('AUDCAD_otc'), 'AUD/CAD OTC');
  assert.ok(Math.abs(OTC.U.breakEven(85) - 54.05) < 0.01);
});

// ── indicators ───────────────────────────────────────────────────────────────
test('indicator sanity', () => {
  const k = Array(40).fill(1.1);
  assert.ok(Math.abs(Ind.ema(k, 9)[39] - 1.1) < 1e-12);
  const rising = Array.from({ length: 40 }, (_, i) => 1 + i * 0.001);
  assert.equal(Ind.rsi(rising, 14)[39], 100);
  const bb = Ind.bollinger(k, 20, 2);
  assert.ok(Math.abs(bb.upper[39] - 1.1) < 1e-12);
});

// ── data quality ─────────────────────────────────────────────────────────────
test('data quality: clean series passes', () => {
  const c = flat(100);
  const r = OTC.DataQuality.checkSeries(c, { tf: 300, now: c[99].time + 300 + 3, minCount: 60 });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
});

test('data quality: catches missing, duplicate, stale, misaligned, frozen, malformed, wrong timeframe', () => {
  const c = flat(100);
  const codes = (arr, o = {}) => OTC.DataQuality.checkSeries(arr, { tf: 300, minCount: 60, ...o }).issues.map((i) => i.code);
  assert.ok(codes(c.filter((_, i) => i !== 95)).includes('MISSING_RECENT'));
  assert.ok(codes([...c.slice(0, 50), c[49], ...c.slice(50)]).includes('DUPLICATE'));
  assert.ok(codes(c, { now: c[99].time + 3000 }).includes('STALE'));
  assert.ok(codes(c.map((x) => ({ ...x, time: x.time + 7 }))).includes('WRONG_TIMEFRAME'));
  const frozen = c.map((x, i) => (i > 90 ? { ...x, open: 1.1, high: 1.1, low: 1.1, close: 1.1 } : x));
  assert.ok(codes(frozen).includes('FROZEN'));
  const bad = c.map((x, i) => (i === 80 ? { ...x, high: x.low - 0.01 } : x));
  assert.ok(codes(bad).includes('INVALID_OHLC'));
  assert.ok(codes(c.slice(0, 10)).includes('TOO_FEW'));
  // 1-minute candles labelled as 5M
  const m1 = flat(100).map((x, i) => ({ ...x, time: T0 + i * 60 }));
  assert.ok(codes(m1).includes('WRONG_TIMEFRAME'));
  assert.ok(codes(c, { lastPrice: 50 }).includes('PRICE_MISMATCH'));
});

test('data quality snapshot: missing higher timeframes are fatal only when required', () => {
  const c = flat(100);
  const s = { 300: c };
  assert.equal(OTC.DataQuality.checkSnapshot(s, { cfg }).ok, false);
  assert.equal(OTC.DataQuality.checkSnapshot(s, { cfg: OTC.config({ requireHTF: false }) }).ok, true);
  assert.equal(OTC.DataQuality.checkSnapshot(s, { cfg: OTC.config({ requireHTF: false }), lastTickAgeSec: 60 }).ok, false);
});

// ── features ─────────────────────────────────────────────────────────────────
test('trend and structure: up vs down', () => {
  const fu = OTC.Features.compute(up(), 300), fd = OTC.Features.compute(down(), 300);
  assert.equal(fu.trend.dir, 'UP');
  assert.equal(fu.trend.order, 'BULL');
  assert.equal(fd.trend.dir, 'DOWN');
  assert.equal(fd.trend.order, 'BEAR');
  assert.notEqual(fu.structure.trend, 'BEAR');
  assert.notEqual(fd.structure.trend, 'BULL');
});

test('price action: engulfing, pin bar, doji, inside bar are recognised', () => {
  const base = flat(60);
  const t = base[59].time;
  const a = base.slice(-1)[0].close;
  const withLast = (...cs) => [...base.slice(0, 60 - cs.length), ...cs.map((x, i) => ({ ...x, time: t - (cs.length - 1 - i) * 300 }))];
  const names = (c) => OTC.Features.compute(c, 300).pa.patterns.map((p) => `${p.name}:${p.dir}`);
  assert.ok(names(withLast(candle(0, a + 0.0004, a + 0.00045, a - 0.00005, a), candle(0, a - 0.0001, a + 0.0007, a - 0.00015, a + 0.0006))).includes('bullish_engulfing:CALL'));
  assert.ok(names(withLast(candle(0, a, a + 0.0001, a - 0.0012, a + 0.00008))).includes('pin_bar:CALL'));
  assert.ok(names(withLast(candle(0, a, a + 0.0012, a - 0.0001, a - 0.00008))).includes('pin_bar:PUT'));
  assert.ok(names(withLast(candle(0, a, a + 0.0004, a - 0.0004, a + 0.00001))).some((n) => n.startsWith('doji')));
  assert.ok(names(withLast(candle(0, a, a + 0.001, a - 0.001, a + 0.0005), candle(0, a + 0.0002, a + 0.0004, a - 0.0003, a + 0.0001))).includes('inside_bar:null'));
});

test('breakout engine: real breakout vs false breakout', () => {
  const box = flat(60, 11).map((x) => ({ ...x, high: Math.min(x.high, 1.0805), low: Math.max(x.low, 1.0795), open: 1.08, close: 1.08 + (x.close - x.open) * 0.1 }));
  const t = box[59].time;
  const real = [...box.slice(0, 59), candle(t, 1.0801, 1.0822, 1.08, 1.0821)];
  const fr = OTC.Features.compute(real, 300).breakout;
  assert.equal(fr.dir, 'CALL');
  assert.equal(fr.status, 'REAL_BREAKOUT');
  const fake = [...box.slice(0, 58), candle(t - 300, 1.0801, 1.0822, 1.08, 1.0821), candle(t, 1.0821, 1.0822, 1.0796, 1.0798)];
  assert.equal(OTC.Features.compute(fake, 300).breakout.status, 'FALSE_BREAKOUT');
});

test('liquidity sweep: wick below the pool, close back inside', () => {
  const base = flat(60, 12);
  const lo = Math.min(...base.slice(-30, -2).map((x) => x.low));
  const t = base[59].time, p = base[58].close;
  const c = [...base.slice(0, 59), candle(t, p, p + 0.0001, lo - 0.0008, p + 0.00005)];
  const sw = OTC.Features.compute(c, 300).liquidity.sweep;
  assert.equal(sw?.dir, 'CALL');
});

test('fibonacci measures retracement depth of the last leg', () => {
  // up-leg of 40 candles then a pullback of ~half
  const leg = makeCandles({ start: T0, segments: [{ n: 60, drift: 0, vol: 0.0002 }, { n: 25, drift: 1, vol: 0.0006 }, { n: 8, drift: -1, vol: 0.0009 }], seed: 9 });
  const f = OTC.Features.compute(leg, 300).fib;
  assert.equal(f.valid, true);
  assert.equal(f.dir, 'CALL');
  assert.ok(f.depth > 0.1 && f.depth < 0.9, `depth ${f.depth}`);
});

// ── regime ───────────────────────────────────────────────────────────────────
test('regime: trending series classify as trending, abnormal candle as high volatility', () => {
  assert.equal(ctxFor(up(400)).X.regime.regime, 'TRENDING_UP');
  assert.equal(ctxFor(down(400)).X.regime.regime, 'TRENDING_DOWN');
  const c = flat(400);
  const l = c[399];
  c[399] = { ...l, high: l.open + 0.01, close: l.open + 0.009 };
  assert.equal(ctxFor(c).X.regime.regime, 'HIGH_VOLATILITY');
});

// ── strategy factory ─────────────────────────────────────────────────────────
test('library: every strategy runs without errors and has ≥ 2 required conditions', () => {
  const ids = OTC.Strategies.list().map((s) => s.id);
  assert.ok(ids.length >= 70, `${ids.length} strategies`);
  for (const c5 of [up(400), down(400), flat(400), flat(400, 21)]) {
    const fired = OTC.Strategies.runAll(ctxFor(c5).X);
    assert.deepEqual([...fired.errors], []);
  }
});

test('factory: rejects single-condition strategies and duplicate ids; ambiguous strategies report nothing', () => {
  const { define, H } = OTC.Strategies;
  const lone = define({ id: '__lone', name: 'lone', family: 'test', conditions: () => [H.R('only one', true)] });
  assert.throws(() => lone.evaluate(ctxFor(flat()).X), /at least 2 required/);
  OTC.Strategies.registry.delete('__lone');
  assert.throws(() => define({ id: 'trend_following', name: 'dup', family: 'x', conditions: () => [] }), /duplicate/);
  const both = define({ id: '__both', name: 'both', family: 'test', conditions: () => [H.R('a', true), H.R('b', true)] });
  assert.equal(both.evaluate(ctxFor(flat()).X), null);
  OTC.Strategies.registry.delete('__both');
});

test('strategy output has the standard fields', () => {
  const fired = OTC.Strategies.runAll(ctxFor(up(400)).X, { allowedFamilies: cfg.regimeFamilies.TRENDING_UP });
  assert.ok(fired.length > 0);
  for (const k of ['strategy', 'direction', 'confidence', 'regime', 'conditions_met', 'conditions_failed', 'supporting_evidence', 'contradicting_evidence', 'invalidation_conditions', 'active']) {
    assert.ok(k in fired[0], k);
  }
  assert.ok(fired.some((x) => x.direction === 'CALL'));
});

// ── confluence and contradiction ─────────────────────────────────────────────
test('confluence: correlated modules count less than independent ones', () => {
  const { X } = ctxFor(flat());
  const neutral = { dir: 'NEUTRAL', confidence: 50 };
  const fake = (votes) => {
    const m = {};
    for (const k of Object.keys(OTC.Confluence.MODULES)) m[k] = { ...neutral };
    Object.assign(m, votes);
    m.volatility.quality = 1;
    return m;
  };
  const score = (votes) => {
    const orig = { ...OTC.Confluence.MODULES };
    for (const k of Object.keys(orig)) OTC.Confluence.MODULES[k] = () => fake(votes)[k];
    try { return OTC.Confluence.evaluate(X, cfg).scores.CALL; } finally { Object.assign(OTC.Confluence.MODULES, orig); }
  };
  const correlated = score({ trend: { dir: 'CALL', confidence: 80 }, momentum: { dir: 'CALL', confidence: 80 } });
  const independent = score({ trend: { dir: 'CALL', confidence: 80 }, structure: { dir: 'CALL', confidence: 80 } });
  assert.ok(independent > correlated, `${independent} vs ${correlated}`);
});

test('contradiction: strong opposing level and higher-timeframe conflict are hard vetoes', () => {
  const { X } = ctxFor(down(400));
  const r = OTC.Contradiction.evaluate(X, 'CALL', null, [], cfg);
  assert.ok(r.hard.some((h) => /higher-timeframe conflict/.test(h)), JSON.stringify(r.hard));
  const X2 = { ...X, levels: [...X.levels, { price: X.f5.price + 0.1 * X.f5.atr, touches: 3, tf: 3600, strength: 80 }] };
  const r2 = OTC.Contradiction.evaluate(X2, 'CALL', null, [], cfg);
  assert.ok(r2.hard.some((h) => /resistance/.test(h)));
});

// ── pipeline ─────────────────────────────────────────────────────────────────
test('pipeline: decisions are always CALL / PUT / SKIP, bad data → SKIP', () => {
  for (const c5 of [up(400), down(400), flat(400)]) {
    const { X, series } = ctxFor(c5);
    const dq = OTC.DataQuality.checkSnapshot(series, { cfg });
    const a = OTC.Pipeline.deepAnalyze(X, { dq, scan: OTC.Pipeline.fastScan(X) });
    assert.ok(['CALL', 'PUT', 'SKIP'].includes(a.decision));
    if (a.decision === 'SKIP') assert.ok(a.skipReasons.length > 0);
  }
  const { X, series } = ctxFor(up(400));
  const broken = { ...series, 300: series[300].filter((_, i) => i !== 395) };
  const dq = OTC.DataQuality.checkSnapshot(broken, { cfg });
  assert.equal(dq.ok, false);
  assert.equal(OTC.Pipeline.deepAnalyze(X, { dq }).decision, 'SKIP');
});

test('pipeline: unclear regime and low scanner score force SKIP', () => {
  const { X } = ctxFor(up(400));
  const unclear = { ...X, regime: { ...X.regime, regime: 'UNCLEAR' } };
  assert.equal(OTC.Pipeline.deepAnalyze(unclear, {}).decision, 'SKIP');
  const a = OTC.Pipeline.deepAnalyze(X, { scan: { score: 10 } });
  assert.equal(a.decision, 'SKIP');
  assert.ok(a.skipReasons.some((r) => /scanner/.test(r)));
});

test('htfWithPartial: closed HTF candles plus the forming one from 5M', () => {
  const c5 = flat(40).map((x, i) => ({ ...x, time: T0 + i * 300 })); // T0 is on an hour boundary
  const closed = OTC.U.aggregate(c5, 300, 3600);
  const s = OTC.Pipeline.htfWithPartial(closed, c5, 3600);
  assert.equal(s.length, 4);
  assert.equal(s[3].partial, true);
  assert.equal(s[3].time, T0 + 3 * 3600);
  assert.equal(s[3].close, c5[39].close);
  // when the 5M close also closes the hour, the last candle is complete
  const s2 = OTC.Pipeline.htfWithPartial(closed, c5.slice(0, 36), 3600);
  assert.equal(s2.length, 3);
  assert.ok(!s2[2].partial);
});

// ── risk engine ──────────────────────────────────────────────────────────────
test('risk: limits, cooldowns, duplicates, concurrency and currency conflicts', () => {
  const now = T0 + 10000;
  let st = OTC.Risk.newRiskState(now);
  const cand = { asset: 'EURUSD_otc', dir: 'CALL', candleTime: now - 300 };
  assert.equal(OTC.Risk.check(cand, st, cfg, now).ok, true);
  const codes = (s, c = cand, sel = []) => OTC.Risk.check(c, s, cfg, now, sel).flags.map((f) => f.code);
  assert.ok(codes({ ...st, emergency: 'x' }).includes('EMERGENCY'));
  assert.ok(codes({ ...st, trades: 20 }).includes('MAX_TRADES'));
  assert.ok(codes({ ...st, consecLosses: 4 }).includes('LOSS_STREAK'));
  assert.ok(codes({ ...st, net: -5 }).includes('DAILY_STOP'));
  assert.ok(codes({ ...st, lastLossAt: now - 60 }).includes('COOLDOWN'));
  st = OTC.Risk.recordOpen(st, { ...cand, until: now + 600 });
  assert.ok(codes(st).includes('DUPLICATE'));
  assert.ok(codes(st, { asset: 'GBPJPY_otc', dir: 'CALL', candleTime: now }).includes('MAX_CONCURRENT'));
  // EUR/USD CALL (short USD) vs USD/JPY CALL (long USD) conflict
  const free = OTC.Risk.newRiskState(now), c2 = OTC.config({ risk: { maxConcurrent: 3 } });
  const f = OTC.Risk.check({ asset: 'USDJPY_otc', dir: 'CALL', candleTime: now }, free, c2, now, [cand]).flags.map((x) => x.code);
  assert.ok(f.includes('EXPOSURE_CONFLICT'));
  assert.equal(OTC.Risk.check({ asset: 'USDJPY_otc', dir: 'PUT', candleTime: now }, free, c2, now, [cand]).ok, true);
  // results and day roll
  let s3 = OTC.Risk.recordResult(st, { asset: 'EURUSD_otc', candleTime: cand.candleTime, result: 'L', units: -1, at: now });
  assert.equal(s3.consecLosses, 1);
  assert.equal(s3.open.length, 0);
  s3 = OTC.Risk.rollDay(s3, now + 86400);
  assert.equal(s3.trades, 0);
  assert.equal(s3.consecLosses, 0);
});

test('entry timing: window, chasing and sudden opposite moves', () => {
  const base = { candleTime: T0, closePrice: 1.08, atr: 0.001, dir: 'CALL', cfg };
  assert.equal(OTC.Risk.entryTiming({ ...base, nowSec: T0 + 305, price: 1.0801 }).ok, true);
  assert.match(OTC.Risk.entryTiming({ ...base, nowSec: T0 + 360, price: 1.08 }).flags.join(), /window missed/);
  assert.match(OTC.Risk.entryTiming({ ...base, nowSec: T0 + 305, price: 1.0807 }).flags.join(), /chasing/);
  assert.match(OTC.Risk.entryTiming({ ...base, nowSec: T0 + 305, price: 1.0793 }).flags.join(), /opposite/);
});

// ── orchestrator ─────────────────────────────────────────────────────────────
test('orchestrator: ranks simultaneous candidates and lets the risk engine pick', () => {
  const now = T0 + 305;
  const mk = (asset, dir, deep) => ({ id: asset, asset, dir, deep, candleTime: T0, evidenceAgainst: [], timing: { quality: 100 } });
  const ranked = OTC.Orchestrator.rank([mk('EURUSD_otc', 'CALL', 72), mk('GBPUSD_otc', 'CALL', 88)], cfg, now);
  assert.equal(ranked[0].asset, 'GBPUSD_otc');
  const { selected, rejected } = OTC.Orchestrator.selectBatch(ranked, OTC.Risk.newRiskState(now), cfg, now);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].asset, 'GBPUSD_otc');
  assert.equal(rejected[0].flags[0].code, 'MAX_CONCURRENT');
  // history can reorder: a setup with a proven record beats a slightly higher raw score
  const perf = (c) => (c.asset === 'EURUSD_otc' ? { n: 200, lo: 62, be: 54 } : null);
  assert.equal(OTC.Orchestrator.rank([mk('EURUSD_otc', 'CALL', 80), mk('GBPUSD_otc', 'CALL', 88)], cfg, now, perf)[0].asset, 'EURUSD_otc');
});

test('orchestrator: resolves outcomes from later closes (keyed by candle end time)', () => {
  const rec = { id: 'x', asset: 'A', candleTime: T0, ts: T0 + 300, entryPrice: 1.08, exits: {}, status: 'pending', payout: 85 };
  // keyed by the END time of the candle whose close ends each horizon
  const closes = new Map([[T0 + 600, 1.081], [T0 + 900, 1.079]]);
  OTC.Orchestrator.resolve(rec, closes, [1, 2, 3], T0 + 1000);
  assert.equal(rec.status, 'pending');
  same(OTC.Orchestrator.paperResult(rec, 'CALL', 1), { result: 'W', units: 0.85 });
  assert.equal(OTC.Orchestrator.paperResult(rec, 'CALL', 2).result, 'L');
  closes.set(T0 + 1200, 1.08);
  OTC.Orchestrator.resolve(rec, closes, [1, 2, 3], T0 + 1300);
  assert.equal(rec.status, 'resolved');
  assert.equal(OTC.Stats.outcome(rec, 'PUT', 3), 'T');
  // an opportunity record (tf 1): exits keyed by seconds after entry, 5s and 1M closes alike
  const opp = { id: 'o', kind: 'opp', tf: 1, asset: 'A', ts: T0 + 35, entryPrice: 1.08, exits: {}, status: 'pending' };
  OTC.Orchestrator.resolve(opp, new Map([[T0 + 40, 1.0801], [T0 + 95, 1.0799]]), [5, 60], T0 + 100);
  same(opp.exits, { 5: 1.0801, 60: 1.0799 });
  assert.equal(opp.status, 'resolved');
});

// ── feed ─────────────────────────────────────────────────────────────────────
test('feed: seconds frames fill a few tick-less candles flat; longer gaps stay gaps', () => {
  const F = new OTC.Feed.Feed('EURUSD_otc');
  F.ingest(T0 + 1, 1.1);
  F.ingest(T0 + 3, 1.2);
  F.ingest(T0 + 21, 1.3); // nothing during T0+5 … T0+19
  const c5 = F.series[5].closed();
  same(c5.map((c) => c.time - T0), [0, 5, 10, 15]);
  assert.ok(c5.slice(1).every((c) => c.filled && c.open === 1.2 && c.high === 1.2 && c.close === 1.2));
  // the minute frame is untouched: no fill above seconds frames
  assert.equal(F.series[60].closed().length, 0);
  F.ingest(T0 + 21 + 5 * 40, 1.4); // 40 candles without a tick: too long to invent
  assert.equal(F.series[5].closed().filter((c) => c.filled).length, 3);
});

test('feed: builds candles from ticks on every timeframe, marks the first one partial', () => {
  const F = new OTC.Feed.Feed('EURUSD_otc');
  const start = T0 + 100; // mid-candle start
  const closes = [];
  for (let s = 0; s < 3600 * 2; s += 1) {
    const ts = start + s, p = 1.08 + Math.sin(s / 300) * 0.001;
    for (const x of F.ingest(ts, p)) closes.push(x);
  }
  const c5 = F.series[300].closed();
  assert.ok(c5.length >= 22);
  assert.ok(c5.every((c) => c.time % 300 === 0));
  assert.ok(!c5.some((c) => c.time === T0)); // the partial first candle is excluded
  assert.ok(closes.some((x) => x.tf === 3600));
  // history repairs the partial first candle and is authoritative
  F.merge(300, [{ time: T0, open: 1.07, high: 1.09, low: 1.06, close: 1.08 }]);
  assert.equal(F.series[300].closed()[0].time, T0);
  // out-of-order ticks are ignored
  same(F.ingest(start, 2), []);
  const snap = F.snapshot();
  assert.ok(snap[900].length > 0);
});

test('feed: pairs are independent', () => {
  const a = new OTC.Feed.Feed('EURUSD_otc'), b = new OTC.Feed.Feed('GBPUSD_otc');
  for (let s = 0; s < 1000; s++) { a.ingest(T0 + s, 1.08); b.ingest(T0 + s, 1.27); }
  assert.equal(a.series[300].closed()[0].close, 1.08);
  assert.equal(b.series[300].closed()[0].close, 1.27);
});

// ── statistics ───────────────────────────────────────────────────────────────
test('wilson interval known values', () => {
  // 7/10 looks like 70%, but at 90% confidence it could be as low as 44%; 70/100 → 62%.
  const w = OTC.Stats.wilson(7, 10);
  assert.ok(Math.abs(w.lo - 44.17) < 0.05, w.lo);
  const w2 = OTC.Stats.wilson(70, 100);
  assert.ok(Math.abs(w2.lo - 62.01) < 0.05, w2.lo);
});

const synthRecords = (n, pWin, { seed = 1, setup = 'trend_following', regime = 'TRENDING_UP', asset = 'EURUSD_otc', start = T0 } = {}) => {
  const { rng } = require('./load.js');
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const win = r() < pWin, t = start + i * 900; // every 3rd candle so E1–E3 never overlap
    out.push({ id: `${asset}${i}`, source: 'backtest', asset, candleTime: t, ts: t + 300, payout: 85, decision: 'CALL', lean: 'CALL',
      deep: 60 + Math.floor(r() * 40), regime, setup, combo: setup, strategies: [[setup, 'CALL', 80, 1]], modules: { trend: ['CALL', 70] },
      entryPrice: 1, exits: { 1: win ? 1.001 : 0.999, 2: win ? 1.001 : 0.999, 3: win ? 1.001 : 0.999 }, status: 'resolved' });
  }
  return out;
};

test('stats: group counts, EV and non-overlap', () => {
  const recs = synthRecords(200, 0.6);
  const all = OTC.Stats.by(recs, 'all', { expiry: 1 })[0];
  assert.equal(all.n, 200);
  assert.ok(Math.abs(all.ev - (all.w * 0.85 - all.l) / 200) < 1e-9);
  // consecutive 5M records with a 3-candle expiry overlap: only every 3rd counts
  const dense = recs.map((r, i) => ({ ...r, candleTime: T0 + i * 300, ts: T0 + i * 300 + 300 }));
  assert.equal(OTC.Stats.by(dense, 'all', { expiry: 3 })[0].n, Math.ceil(200 / 3));
  assert.equal(OTC.Stats.by(dense, 'all', { expiry: 3, nonOverlap: false })[0].n, 200);
});

test('stats: chronological split and calibration buckets', () => {
  const recs = synthRecords(100, 0.5).reverse();
  const s = OTC.Stats.split(recs, [0.6, 0.2, 0.2]);
  assert.equal(s.train.length, 60);
  assert.ok(s.train[59].ts < s.validation[0].ts && s.validation[19].ts < s.oos[0].ts);
  const cal = OTC.Stats.calibration(recs);
  assert.ok(cal.length >= 5);
  assert.ok(cal.every((r) => /^\d+–\d+$/.test(r.key)));
});

test('validation: a real edge validates, a coin flip does not', () => {
  const vcfg = OTC.config({ validation: { minTrain: 50, minHoldout: 25 } });
  const edge = OTC.Stats.discoverProfiles(synthRecords(600, 0.68, { seed: 2 }), vcfg, { expiries: [1] });
  const row = edge.results.find((r) => r.key === 'trend_following|TRENDING_UP');
  assert.equal(row.status, 'VALIDATED', row.why);
  const coin = OTC.Stats.discoverProfiles(synthRecords(600, 0.5, { seed: 3 }), vcfg, { expiries: [1] });
  assert.notEqual(coin.results.find((r) => r.key === 'trend_following|TRENDING_UP').status, 'VALIDATED');
  // an edge that disappears in the newest data fails out-of-sample
  const decay = [...synthRecords(420, 0.7, { seed: 4 }), ...synthRecords(180, 0.4, { seed: 5, start: T0 + 420 * 900 }).map((r) => ({ ...r, id: `late${r.id}` }))];
  const st = OTC.Stats.discoverProfiles(decay, vcfg, { expiries: [1] }).results.find((r) => r.key === 'trend_following|TRENDING_UP').status;
  assert.notEqual(st, 'VALIDATED');
});

test('matchProfile requires regime, expiry and every strategy in the profile', () => {
  const rec = { decision: 'CALL', regime: 'TRENDING_UP', strategies: [['a', 'CALL', 80, 1], ['b', 'CALL', 70, 1], ['c', 'PUT', 70, 1]] };
  assert.equal(OTC.Stats.matchProfile(rec, ['a+b|TRENDING_UP|E1'], 1), 'a+b|TRENDING_UP|E1');
  assert.equal(OTC.Stats.matchProfile(rec, ['a+c|TRENDING_UP|E1'], 1), null);
  assert.equal(OTC.Stats.matchProfile(rec, ['a|RANGING|E1'], 1), null);
  assert.equal(OTC.Stats.matchProfile(rec, ['a|TRENDING_UP|E2'], 1), null);
});

test('candle research measures streak behaviour', () => {
  const r = OTC.Stats.candleResearch(flat(500));
  assert.ok(r.sameColorAfterRun.length > 0);
  assert.ok(r.returnAutocorr > -1 && r.returnAutocorr < 1);
});

// ── replay ───────────────────────────────────────────────────────────────────
test('replay: deterministic, records resolved, no strategy errors, no lookahead', async () => {
  const c5 = makeCandles({ start: T0, segments: [{ n: 500, drift: 0.3, vol: 0.0004 }, { n: 300, drift: -0.3, vol: 0.0005 }], seed: 8 });
  const a = await OTC.Replay.replay(c5, { asset: 'EURUSD_otc', payout: 85, cfg, yieldEvery: 0 });
  const b = await OTC.Replay.replay(c5, { asset: 'EURUSD_otc', payout: 85, cfg, yieldEvery: 0 });
  assert.ok(a.length > 300);
  assert.deepEqual(a.map((r) => r.decision), b.map((r) => r.decision));
  assert.ok(a.every((r) => r.status === 'resolved'));
  assert.ok(!a.some((r) => r.riskFlags.some((f) => /strategy error/.test(f))));
  // no lookahead: changing candles AFTER a decision must not change that decision
  const k = 600, cut = c5.slice(0, k + 1).concat(c5.slice(k + 1).map((x) => ({ ...x, close: x.close + 0.01, high: x.high + 0.01, low: x.low + 0.01, open: x.open + 0.01 })));
  const c = await OTC.Replay.replay(cut, { asset: 'EURUSD_otc', payout: 85, cfg, yieldEvery: 0 });
  const at = (rs) => rs.find((r) => r.candleTime === c5[k].time);
  assert.equal(at(c).decision, at(a).decision);
  assert.equal(at(c).deep, at(a).deep);
});

test('null test: on a pure random walk the engine has no edge (guards against lookahead bias)', async () => {
  const c5 = makeCandles({ start: T0, segments: [{ n: 3000, drift: 0, vol: 0.0004 }], seed: 99 });
  const recs = await OTC.Replay.replay(c5, { asset: 'EURUSD_otc', payout: 85, cfg, yieldEvery: 0 });
  const all = OTC.Stats.by(recs, 'all', { basis: 'lean', expiry: 1, nonOverlap: false })[0];
  assert.ok(all.n > 2000, `n ${all.n}`);
  // ~1% standard error; a leak of future prices would push this far above 50%
  assert.ok(all.wr > 46 && all.wr < 54, `lean win rate on noise: ${all.wr.toFixed(1)}% of ${all.n}`);
  for (const r of OTC.Stats.strategyMatrix(recs, cfg, { expiry: 1 }).filter((x) => x.n >= 200)) {
    assert.ok(r.wr < 60, `${r.strategy} wins ${r.wr.toFixed(1)}% of ${r.n} on pure noise`);
  }
});
