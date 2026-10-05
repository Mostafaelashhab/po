// OTC Randomness & Edge Audit: on noise it must say NO_EDGE_FOUND; a planted edge must be found, priced and
// called EDGE_FOUND; the null test must separate the two; the data report must see holes and bad candles.
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load.js');

const { OTC } = load();
const A = OTC.Audit;
const T0 = 1_790_000_000 - (1_790_000_000 % 3600);

// 5s candles: a random walk; optional planted rules — after 3 rising closes the next falls with probability
// `reverse`; the 5s candle at second 0 of each minute rises with probability `minuteUp`
function walk(n, { seed = 1, reverse = null, minuteUp = null, tf = 5, start = T0, price = 1.08, scale = 0.0001 } = {}) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const out = [];
  let p = price, ups = 0;
  for (let i = 0; i < n; i++) {
    const t = start + tf * i;
    let up = rnd() < 0.5;
    if (reverse != null && ups >= 3) up = rnd() >= reverse;
    if (minuteUp != null && t % 60 === 0) up = rnd() < minuteUp;
    const mv = scale * (0.3 + rnd()) * (up ? 1 : -1), o = p, c = p + mv;
    out.push({ time: t, open: o, high: Math.max(o, c) + scale * 0.2 * rnd(), low: Math.min(o, c) - scale * 0.2 * rnd(), close: c });
    p = c; ups = up ? ups + 1 : 0;
  }
  return out;
}
const pairs = (k, n, o = {}) => Object.fromEntries(Array.from({ length: k }, (_, i) => [`P${i}`, walk(n, { ...o, seed: (o.seed || 1) * 100 + i })]));

test('audit: statistics — chi-square tail, Benjamini–Hochberg, break-even, Wilson', () => {
  assert.ok(Math.abs(A.chi2p(3.841, 1) - 0.05) < 0.002);
  assert.ok(Math.abs(A.chi2p(11.07, 5) - 0.05) < 0.002);
  assert.ok(Math.abs(A.chi2p(31.41, 20) - 0.05) < 0.003);
  const q = A.bhq([0.001, 0.2, 0.8, 0.04]);
  assert.ok(q[0] < 0.05 && q[3] > 0.05 && q[1] > 0.05);
  assert.equal(+A.breakEven(92).toFixed(4), 52.0833);
  assert.equal(+A.breakEven(80).toFixed(2), 55.56);
  const [lo, hi] = A.wilson(60, 100);
  assert.ok(lo > 50 && hi < 70);
});

test('audit: the data report sees holes, duplicates, bad candles, frozen prices and jumps', () => {
  const cs = walk(500, { seed: 3 });
  cs.splice(100, 5);                                       // a hole of 5 candles
  cs.push({ ...cs[200] });                                 // a duplicate
  cs[300] = { ...cs[300], high: cs[300].low - 0.001 };     // high below low
  for (let i = 400; i < 415; i++) cs[i] = { ...cs[i], open: cs[399].close, close: cs[399].close, high: cs[399].close, low: cs[399].close };
  cs[450] = { ...cs[450], close: cs[450].close + 0.01, high: cs[450].close + 0.01 };
  const q = A.quality({ X: cs }, 5);
  assert.equal(q.gaps, 1);
  assert.equal(q.missing, 5);
  assert.equal(q.duplicates, 1);
  assert.ok(q.invalid >= 1);
  assert.equal(q.flatRuns, 1);
  assert.ok(q.jumps10 >= 1);
  assert.equal(q.misaligned, 0);
});

test('audit: on a pure random walk nothing survives — NO_EDGE_FOUND, and noise looks the same', () => {
  const per5 = pairs(6, 7000, { seed: 1 }), per1 = pairs(4, 3000, { seed: 2, tf: 60 });
  const r = A.audit({ per5, per1 }, { nulls: false });
  assert.ok(r.tests.total > 500, `${r.tests.total} hypotheses`);
  assert.equal(r.rows.filter((x) => x.exploitable).length, 0, r.rows.filter((x) => x.exploitable).map((x) => `${x.id} ${x.oos.rate}`).join(' | '));
  assert.equal(r.verdict.status, 'NO_EDGE_FOUND', JSON.stringify(r.verdict));
  // about 5% nominal by chance; corrected, nearly nothing
  assert.ok(r.tests.nominal < r.tests.total * 0.1, `${r.tests.nominal} nominal of ${r.tests.total}`);
  assert.ok(r.tests.significantDirectional <= 2, r.rows.filter((x) => x.significant && x.directional).map((x) => x.id).join(' | '));
  assert.ok(r.noise.permutation && r.noise.gauss);
  // the best out-of-sample result on OTC is no better than the best on shuffled data by much
  assert.ok(r.noise.permutation.otc.bestOos < 60, JSON.stringify(r.noise.permutation));
  // every hypothesis carries a status from the spec
  const allowed = new Set(['STRONG_EDGE', 'WEAK_EDGE', 'NO_EDGE', 'NOISY_RESULT', 'OVERFIT', 'INSUFFICIENT_DATA', 'UNSTABLE', 'PERIOD_SPECIFIC', 'REGIME_SPECIFIC', 'STRUCTURE_NOT_DIRECTIONAL']);
  assert.ok(r.rows.every((x) => allowed.has(x.status)), [...new Set(r.rows.map((x) => x.status))].join(','));
  // money: at 92% the break-even is 52.08%; every horizon's best result is priced
  assert.equal(r.economics.find((e) => e.payout === 92).breakEven, 52.083);
  assert.ok(r.bestByHorizon.length >= 5 && r.bestByHorizon.every((b) => typeof b.ev[92] === 'number'));
});

test('audit: a planted edge is found, out of sample, in both halves, priced — EDGE_FOUND', () => {
  const per5 = pairs(4, 7000, { seed: 5, reverse: 0.8 });
  const r = A.audit({ per5, per1: {} }, { nulls: false, selfNull: false });
  assert.equal(r.verdict.status, 'EDGE_FOUND', JSON.stringify(r.verdict.reasons));
  const pat = r.rows.find((x) => x.id === 'pat.5.UUU.h1');
  assert.ok(pat && pat.status === 'STRONG_EDGE' && pat.label.endsWith('DOWN') && pat.oos.rate > 70, JSON.stringify(pat));
  assert.ok(pat.halves.every((h) => h > 60));
  // a lagged memory shows in the autocorrelation and the transition test
  assert.ok(r.rows.find((x) => x.id === 'trans.5.k3.h1').significant);
  // edges are things the data shows, not guesses: none on 1M (no data there)
  assert.ok(r.verdict.edges.every((e) => e.tf === 5));
});

test('audit: a time-of-day trick (first 5 s of each minute rises 70%) is found by the timing tests', () => {
  const per5 = pairs(4, 8000, { seed: 9, minuteUp: 0.7 });
  const r = A.audit({ per5, per1: {} }, { nulls: false, selfNull: false, cross: false });
  const slot = r.rows.find((x) => x.id === 'time.5.second of the minute.0');
  assert.ok(slot && slot.significant && slot.label.endsWith('UP') && slot.oos.rate > 62, JSON.stringify(slot));
  const others = r.rows.filter((x) => x.id.startsWith('time.5.second of the minute.') && x.id !== 'time.5.second of the minute.0' && x.significant);
  assert.equal(others.length, 0, others.map((x) => x.id).join(','));
});

test('audit: the null test — the pattern engines find in a planted dataset what they cannot find in noise', () => {
  const planted = A.runNulls({ per5: pairs(3, 4000, { seed: 7, reverse: 0.8 }), per1: {} }, { keep5: 4000 });
  const c = planted.compare[5];
  assert.ok(c, JSON.stringify(Object.keys(planted.compare)));
  assert.ok(c.bestHit.beatsAll, JSON.stringify(c.bestHit));
  assert.ok(c.patternsValidated.real > 0 && c.patternsValidated.nullMax === 0, JSON.stringify(c.patternsValidated));
  assert.deepEqual([...planted.models], ['permutation', 'bootstrap', 'sign', 'block', 'gauss']);
  // noise keeps the pairs, times and sizes of the real data
  const src = walk(500, { seed: 4 }), s = A.synth({ X: src }, 5, 'permutation', 1).X;
  assert.equal(s.length, src.length);
  assert.deepEqual([...s].map((x) => x.time), src.map((x) => x.time));
  const mv = (cs) => [...cs].slice(1).map((x, i) => +(x.close - cs[i].close).toFixed(10)).sort();
  assert.deepEqual(mv(s), mv(src), 'a permutation keeps every move, only the order changes');
});

test('audit: copy signals, PO signals and the engine\'s own entries are audited from the records', () => {
  let s = 3; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const opps = [];
  for (let i = 0; i < 400; i++) {
    const lean = rnd() < 0.5 ? 'CALL' : 'PUT', p0 = 1.1, exits = {};
    for (const h of [5, 10, 15, 30, 60, 120, 180, 300]) exits[h] = p0 + (rnd() < 0.5 ? 1 : -1) * 0.0001;
    opps.push({ kind: 'opp', tf: 1, asset: `A${i % 7}`, ts: T0 + i * 400, entryPrice: p0, exits, lean, origin: i % 2 ? 'copy' : 'engine', state: i % 2 ? 'GATED' : 'ENTERED',
      expirySec: 60, copy: { copies: i % 60, pnl: rnd() < 0.5 ? '+' : '-', elapsed: i % 90, calls: 3, puts: 1, total: 4 } });
  }
  const sigStats = { '*|1|3': { up: 260, down: 240 }, '*|5|7': { up: 90, down: 110 } };
  const r = A.audit({ per5: {}, per1: {}, opps, sigStats }, { nulls: false, selfNull: false });
  const copy = r.rows.find((x) => x.id === 'copy.every copy signal');
  assert.ok(copy && copy.n >= 150 && !copy.significant, JSON.stringify(copy));
  assert.ok(r.rows.some((x) => x.family === 'platform-signal'));
  assert.ok(r.rows.some((x) => x.id === 'expiry.60'));
  assert.ok(r.rows.some((x) => x.family === 'entry-timing'));
  assert.equal(r.verdict.status, 'INSUFFICIENT_DATA', 'no price data: says so, not a verdict');
});
