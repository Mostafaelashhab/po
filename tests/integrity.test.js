// Integrity watch: settling against the trades, targeting the placed ones, abnormal speed, a fast platform clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load.js');

const { OTC } = load();
const I = OTC.Integrity;
const T0 = 1_790_000_000;
const placedRec = (i, po, mk, extra = {}) => ({ kind: 'opp', id: `p${i}`, ts: T0 + i, decision: 'CALL', expirySec: 60, entryPrice: 1, exits: { 5: 1, 60: i % 2 ? 1.001 : 0.999 },
  exec: { action: 'auto', dir: 'CALL', forensics: { poOutcome: po, marketOutcome: mk, closeDevBp: 0 } }, ...extra });

test('integrity: PO settling against the trades far more often than for them is flagged; an even split is not', () => {
  const even = [...Array(40)].map((_, i) => placedRec(i, i < 4 ? 'L' : i < 8 ? 'W' : 'W', i < 4 ? 'W' : i < 8 ? 'L' : 'W'));
  const a = I.settlement(even);
  assert.equal(a.status, 'clean'); assert.equal(a.against, 4); assert.equal(a.forUs, 4);
  const bad = [...Array(40)].map((_, i) => placedRec(i, i < 9 ? 'L' : i < 10 ? 'W' : 'W', i < 9 ? 'W' : i < 10 ? 'L' : 'W'));
  const b = I.settlement(bad);
  assert.equal(b.status, 'suspicious');
  assert.equal(b.flags[0].code, 'settle_against');
  // a few odd trades prove nothing
  assert.equal(I.settlement([...Array(10)].map((_, i) => placedRec(i, i < 3 ? 'L' : 'W', 'W'))).status, 'few');
});

test('integrity: placed trades losing much more than the same signals not placed is flagged', () => {
  const rec = (i, action, win) => ({ kind: 'opp', id: `${action}${i}`, ts: T0 + i, decision: 'CALL', expirySec: 60, entryPrice: 1, exits: { 60: win ? 1.001 : 0.999 }, exec: { action, dir: 'CALL' } });
  const rs = [...[...Array(100)].map((_, i) => rec(i, 'auto', i % 10 < 3)), ...[...Array(300)].map((_, i) => rec(i, 'paper', i % 2 === 0))];
  const r = I.settlement(rs);
  assert.ok(r.flags.some((f) => f.code === 'placed_lose_more'), JSON.stringify(r.flags));
  assert.equal(r.placed.rate, 30); assert.equal(r.notPlaced.rate, 50);
});

test('integrity: a pair moving several times faster than its own normal', () => {
  const pts = new Map(); let p = 1.1;
  for (let t = T0 - 1800; t <= T0; t++) { p += (t % 2 ? 1 : -1) * (t > T0 - 30 ? 0.0005 : 0.0001); pts.set(t, p); }
  const s = I.speed(pts, T0);
  assert.ok(s.ratio > 4 && s.ratio < 6, JSON.stringify(s));
  const calm = new Map([...pts].map(([t], i) => [t, 1.1 + (i % 2) * 0.0001]));
  assert.ok(Math.abs(I.speed(calm, T0).ratio - 1) < 0.05);
  assert.equal(I.speed(new Map([[T0, 1]]), T0), null, 'no data, no verdict');
});

test('integrity: the platform clock running 3 % fast', () => {
  const s = [...Array(60)].map((_, k) => [k * 10, 7200 + k * 10 * 0.03]);
  assert.equal(I.clockDrift(s), 0.03);
  assert.equal(I.clockDrift([...Array(60)].map((_, k) => [k * 10, 7200])), 0);
  assert.equal(I.clockDrift(s.slice(0, 10)), null);
  assert.ok(Math.abs(I.binomTail(9, 10) - 11 / 1024) < 1e-12);
});
