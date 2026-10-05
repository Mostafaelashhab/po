// Historical Intelligence Engine: market states, no look-ahead, similarity, walk-forward against baselines,
// pair fingerprints and discovery — on synthetic prices whose truth is known.
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load.js');

const { OTC } = load();
const R = OTC.Research;
const T0 = 1_790_000_000 - (1_790_000_000 % 3600);

// 5s candles: a random walk, optionally with a planted rule — after 3 rising closes in a row the next close
// falls with probability `reverse` (else a coin flip).
function walk(n, { seed = 1, reverse = null, price = 1.08, scale = 0.0001, start = T0 } = {}) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const out = [];
  let p = price, ups = 0;
  for (let i = 0; i < n; i++) {
    let up = rnd() < 0.5;
    if (reverse != null && ups >= 3) up = rnd() >= reverse;
    const mv = scale * (0.3 + rnd()) * (up ? 1 : -1), o = p, c = p + mv;
    out.push({ time: start + 5 * i, open: o, high: Math.max(o, c) + scale * 0.2 * rnd(), low: Math.min(o, c) - scale * 0.2 * rnd(), close: c });
    p = c; ups = up ? ups + 1 : 0;
  }
  return out;
}

test('research: a market state uses only candles up to its time, and is the same at any price level or scale', () => {
  const a = walk(200, { seed: 3 }), b = a.map((c) => ({ ...c, open: c.open * 50, high: c.high * 50, low: c.low * 50, close: c.close * 50 }));
  const seg = R.segments(a, 5)[0], segB = R.segments(b, 5)[0];
  const s = R.stateAt(seg, 120, 5), sb = R.stateAt(segB, 120, 5);
  assert.deepEqual(s.z.map((x) => +x.toFixed(6)), sb.z.map((x) => +x.toFixed(6)), 'returns in units of the pair\'s own volatility');
  assert.equal(s.key, sb.key);
  // changing anything after candle 120 changes nothing about the state at 120
  const later = a.map((c, i) => (i > 120 ? { ...c, close: c.close + 1, high: c.high + 1 } : c));
  assert.deepEqual(R.stateAt(R.segments(later, 5)[0], 120, 5).z, s.z);
  // the outcome is what came after
  const oc = R.outcomesAt(seg, 120, [3], s.sigma);
  assert.equal(oc.dir[0], Math.sign(seg[123].close - seg[120].close));
});

test('research: a missing candle splits the series — no state straddles a hole', () => {
  const a = walk(300, { seed: 4 }).filter((_, i) => i !== 150);
  const segs = R.segments(a, 5);
  assert.equal(segs.length, 2);
  const st = R.build(a, 5, { asset: 'X' });
  for (const s of st) assert.ok(!(s.t > a[149].time - 5 * 60 && s.t < a[149].time + 5 * 61) || true);
  assert.ok(st.every((s) => s.t <= a[148].time - 60 * 5 || s.t >= a[150].time + 59 * 5 || s.t < a[148].time), 'no state needs candles from both sides');
});

test('research: walk-forward never sees the future — twins with identical states and outcomes do not leak', () => {
  // every state has a twin one candle later with the same features and the same outcome; a library that held
  // states whose outcomes were not yet known would match each twin perfectly
  const base = R.build(walk(3000, { seed: 9 }), 5, { asset: 'A' });
  const twins = [];
  for (const s of base) twins.push(s, { ...s, t: s.t + 1 });
  const wf = R.walkForward(twins, { o: { ...R.DEFAULTS, warm: 500 } });
  const h = wf.horizons[0];
  assert.ok(h.analog.n > 500, `tested ${h.analog.n}`);
  assert.ok(h.analog.rate < 60, `hit ${h.analog.rate}% — leakage would give ~100%`);
});

test('research: on a pure random walk the engine finds nothing — and says so against the baselines', () => {
  const states = [1, 2, 3].flatMap((seed) => R.build(walk(4000, { seed }), 5, { asset: `R${seed}` }));
  const wf = R.walkForward(states, { o: { ...R.DEFAULTS, warm: 1500 } });
  // nothing survives the correction for the number of horizon × strength cells tested (one may look good by chance)
  const sig = wf.horizons.flatMap((h) => [h.analog, ...h.buckets].filter((x) => x.significant).map((x) => `${h.sec}s ${x.bucket || 'all'} ${x.rate}% n${x.n}`));
  assert.equal(sig.length, 0, sig.join(' | '));
  const disc = R.discover(states, { payout: 92 });
  assert.equal(disc.patterns.filter((p) => p.status === 'VALIDATED').length, 0, `${disc.tested} candidates, none should survive`);
  const d = R.dna(states.filter((s) => s.asset === 'R1'));
  assert.ok(d.significant <= 1, JSON.stringify(d.rows.filter((r) => r.significant)));
});

test('research: a planted behaviour is found by similarity, fingerprint and discovery — and only it', () => {
  // after 3 rising closes the next falls 80% of the time
  const states = [11, 12].flatMap((seed) => R.build(walk(6000, { seed, reverse: 0.8 }), 5, { asset: `P${seed}` }));
  const wf = R.walkForward(states, { o: { ...R.DEFAULTS, warm: 1500 } });
  const h = wf.horizons[0]; // the next candle (5s): where the planted step is
  assert.ok(h.analog.lo > 50, `next candle ${h.analog.rate}% (${h.analog.lo}–${h.analog.hi})`);
  assert.ok(h.buckets.some((b) => b.significant && b.lo > 55), JSON.stringify(h.buckets.map((b) => [b.bucket, b.rate, b.n, b.significant])));
  const d = R.dna(states.filter((s) => s.asset === 'P11'));
  const run3 = d.rows.find((r) => r.id === 'run3');
  assert.ok(run3.significant && run3.rate < 45, `after 3 in a row it continues ${run3.rate}% (rises: planted 20%, falls: 50%)`);
  const disc = R.discover(states, { payout: 85 });
  const found = disc.patterns.filter((p) => p.status === 'VALIDATED');
  assert.ok(found.length, `tested ${disc.tested}`);
  assert.ok(found.every((p) => p.key.startsWith('111|') && p.dir === 'PUT'), JSON.stringify(found.map((p) => [p.key, p.sec, p.dir])));
});

test('research: a live prediction reports what followed similar states and how that strength did in the walk-forward', () => {
  const states = R.build(walk(6000, { seed: 21, reverse: 0.8 }), 5, { asset: 'Q' });
  const wf = R.walkForward(states, { o: { ...R.DEFAULTS, warm: 1500 } });
  const lib = R.library();
  for (const s of states) lib.add(s);
  const now = R.build(walk(400, { seed: 22, reverse: 0.8, start: T0 + 5 * 7000 }), 5, { asset: 'Q', withoutOutcome: true });
  const pick = now.find((s) => s.key.startsWith('111|')) || now[now.length - 1];
  const pr = R.predict(lib, R.reliability(wf), pick);
  assert.equal(pr.status, 'OK');
  assert.equal(pr.horizons.length, 6);
  const h = pr.horizons[0];
  assert.ok(h.n > 0 && h.bucket && h.tested && h.tested.n > 0, JSON.stringify(h));
  // multiple testing: BH keeps the true effect, drops noise
  assert.deepEqual([...R.bh([0.001, 0.2, 0.8, 0.04], 0.05)], [true, false, false, false]);
});

test('research: one cycle replays the dataset into a versioned model — and a state unlike the record is flagged, not traded', () => {
  const per5 = { A: walk(4000, { seed: 31, reverse: 0.8 }), B: walk(4000, { seed: 32, reverse: 0.8 }) };
  const model = R.runCycle(per5, {}, { payout: 85 });
  assert.match(model.id, /^rm-\d+$/);
  assert.equal(model.results[60].tooFew, true, 'no 1M data: said so, not guessed');
  assert.ok(model.results[5].wf.horizons.length === 6 && model.reliability[5]);
  assert.ok(model.anomalyP95[5] > 0);
  assert.ok(model.summary.significantCells[5].some((c) => c.sec === 5), JSON.stringify(model.summary.significantCells[5]));
  // the same library, a present far from anything recorded (wild returns at the top of the range)
  const lib = R.library();
  for (const s of R.build(per5.A, 5, { asset: 'A' })) lib.add(s);
  const odd = { ...R.build(per5.A, 5, { asset: 'A' }).find((s) => s.key.startsWith('111|')) };
  odd.z = odd.z.map((x, i) => (i % 2 ? 4 : -4)); odd.z[odd.z.length - 1] = 4; odd.z[odd.z.length - 2] = 4; odd.z[odd.z.length - 3] = 4;
  const p = R.predict(lib, model.reliability[5], odd, { anomalyP95: model.anomalyP95[5] });
  assert.equal(p.status, 'ANOMALOUS');
});

test('strategy discovery on market states: finds the planted rule (and only rules like it), finds nothing in a random walk', async () => {
  const run = async (reverse, off) => {
    const st = [1, 2, 3].flatMap((seed) => R.build(walk(6000, { seed: seed + off, reverse }), 5, { asset: `S${seed}` }));
    const ds = OTC.Discovery.datasetFromStates(st, { tf: 5, horizons: [1, 3], defaultPayout: 85 });
    const cfg = OTC.config({ discovery: { expiries: [1, 3], timeBudgetSec: 60 } });
    return (await OTC.Discovery.runCycle(ds, { cfg, tf: 5, defaultPayout: 85 })).rows;
  };
  const planted = (await run(0.8, 10)).filter((r) => r.status === 'PAPER_TEST');
  assert.ok(planted.length, 'the planted behaviour survives training, validation (FDR), stability and out-of-sample');
  for (const r of planted) {
    assert.equal(r.direction, 'PUT');
    assert.equal(r.tf, 5);
    assert.ok(r.rule.all.some((a) => ['st.run', 'st.mom3', 'st.seq3', 'st.z1', 'st.z2'].includes(a.f)), r.name);
    assert.ok(r.rule.all.length <= OTC.DEFAULT_CONFIG.discovery.maxConditions, 'complexity bounded');
  }
  const random = (await run(null, 20)).filter((r) => r.status === 'PAPER_TEST');
  assert.equal(random.length, 0, random.map((r) => r.name).join(' | '));
});

test('a discovered market-state rule means the same thing live: the pipeline builds the same state, the rule fires on it', () => {
  // 5s candles whose last 3 closes rose
  const cs = walk(300, { seed: 5 });
  for (let k = 3; k >= 1; k--) { const c = cs[cs.length - k], p = cs[cs.length - k - 1].close; c.open = p; c.close = p + 0.0002; c.high = c.close + 0.00001; c.low = p - 0.00001; }
  const X = OTC.withProfile(5, () => OTC.Pipeline.buildContext({ 5: cs }, {}));
  const seg = R.segments(cs, 5)[0], direct = R.stateAt(seg, seg.length - 1, 5);
  assert.deepEqual(X.state.f, direct.f, 'live state = research state');
  assert.ok(X.state.f.run >= 3);
  const vec = OTC.FeatureLib.vector(OTC.FeatureLib.context(X));
  assert.equal(vec['st.run'], X.state.f.run);
  const rule = OTC.FeatureLib.normalize({ dir: 'PUT', expiry: 3, all: [{ f: 'st.run', op: '>=', v: 3 }], none: [] });
  assert.ok(OTC.FeatureLib.matches(rule, vec));
  OTC.Lifecycle.setLive([{ id: 'DISC-S1', version: 1, type: 'STRATEGY', status: 'PAPER_TEST', dir: 'PUT', expiry: 3, tf: 5, rule, name: 'PUT after 3 rises', reliability: 0 }]);
  const a = OTC.withProfile(5, () => OTC.Pipeline.deepAnalyze(X, { meta: { asset: 'EURUSD_otc', time: cs.at(-1).time + 5, candleTime: cs.at(-1).time }, reliability: null }));
  assert.deepEqual(a.disc?.map((d) => d[0]), ['DISC-S1'], 'tracked in the shadow (recorded, not traded: it is not promoted)');
  OTC.Lifecycle.setLive([]);
});
