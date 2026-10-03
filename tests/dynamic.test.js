// Dynamic multi-timeframe engine: expiry choice, copy-trade evidence, opportunity lifecycle.
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load.js');

const { OTC, AR } = load();
const cfg = OTC.config();
const T = 1_700_000_100 - (1_700_000_100 % 3600);

// ── expiry ───────────────────────────────────────────────────────────────────
test('expiry: setup-based when there is no history, scaled by the setup frame', () => {
  const e1 = OTC.Expiry.choose({ tf: 60, kind: 'momentum', cfg });
  assert.equal(e1.source, 'setup');
  assert.equal(e1.sec, 60);
  const e5 = OTC.Expiry.choose({ tf: 300, kind: 'pullback', cfg });
  assert.equal(e5.sec, 600); // 2 candles of 5M
  const e15 = OTC.Expiry.choose({ tf: 900, kind: 'momentum', cfg });
  assert.equal(e15.sec, 900);
});

test('expiry: fast markets and nearby levels shorten it, slow markets lengthen it', () => {
  const fast = OTC.Expiry.choose({ tf: 300, kind: 'pullback', f: { volatility: { state: 'HIGH' } }, cfg });
  const slow = OTC.Expiry.choose({ tf: 300, kind: 'pullback', f: { volatility: { state: 'LOW' } }, cfg });
  const near = OTC.Expiry.choose({ tf: 300, kind: 'pullback', levelAtr: 0.5, cfg });
  assert.ok(fast.sec < 600 && near.sec < 600 && slow.sec > 600, `${fast.sec} ${near.sec} ${slow.sec}`);
  assert.ok(fast.reason.adj.includes('fast'));
});

test('expiry: only durations the platform offers', () => {
  const e = OTC.Expiry.choose({ tf: 300, kind: 'pullback', available: [60, 180, 300], cfg });
  assert.equal(e.sec, 300);
  const d = OTC.Expiry.choose({ tf: 300, kind: 'pullback', available: [45, 7200], cfg }); // nothing usable → own choices
  assert.ok(cfg.expiryChoices.includes(d.sec));
});

test('expiry: history wins only with enough outcomes, several horizons and a positive lower bound', () => {
  const good = (sec) => ({ n: 80, wr: sec === 180 ? 66 : 52, lo: sec === 180 ? 58 : 44, be: 54 }); // history by seconds
  const h = OTC.Expiry.choose({ tf: 60, kind: 'momentum', history: good, cfg });
  assert.equal(h.source, 'history');
  assert.equal(h.sec, 180);
  const thin = OTC.Expiry.choose({ tf: 60, kind: 'momentum', history: (m) => ({ n: 10, wr: 80, lo: 70, be: 54 }), cfg });
  assert.equal(thin.source, 'setup');
  const noEdge = OTC.Expiry.choose({ tf: 60, kind: 'momentum', history: () => ({ n: 200, wr: 55, lo: 50, be: 54 }), cfg });
  assert.equal(noEdge.source, 'setup');
});

test('expiry: a discovered strategy keeps its validated duration', () => {
  const e = OTC.Expiry.choose({ tf: 300, kind: 'momentum', fixedSec: 600, cfg });
  assert.equal(e.source, 'discovered');
  assert.equal(e.sec, 600);
});

// ── copy trade ───────────────────────────────────────────────────────────────
test('copy trade: nothing → no direction', () => {
  const r = OTC.CopyTrade.evaluate([], { now: T });
  assert.equal(r.dir, null);
  assert.equal(r.total, 0);
});

test('copy trade: fresh agreeing trades give a modest lean, never a decision', () => {
  const s = [0, 10, 20].map((d) => ({ dir: 'CALL', at: T - 30 + d, left: 120, elapsed: 0, price: 1.1, copies: 3 }));
  const r = OTC.CopyTrade.evaluate(s, { now: T, price: 1.1, atr: 0.001 });
  assert.equal(r.dir, 'CALL');
  assert.ok(r.synced && r.fresh && !r.late);
  assert.ok(r.confidence <= 65 && r.confidence >= 55, String(r.confidence));
});

test('copy trade: late, flipping or split trades are discounted or ignored', () => {
  const late = OTC.CopyTrade.evaluate([{ dir: 'CALL', at: T - 20, left: 120, elapsed: 0, price: 1.1 }, { dir: 'CALL', at: T - 10, left: 120, elapsed: 0, price: 1.1 }],
    { now: T, price: 1.101, atr: 0.001 });
  assert.ok(late.late);
  assert.ok(late.confidence < 52);
  const flip = OTC.CopyTrade.evaluate([{ dir: 'CALL', at: T - 30, left: 120 }, { dir: 'PUT', at: T - 20, left: 120 }, { dir: 'CALL', at: T - 10, left: 120 }], { now: T });
  assert.equal(flip.dir, null);
  assert.ok(flip.flipping);
  const old = OTC.CopyTrade.evaluate([{ dir: 'CALL', at: T - 600, left: 60 }], { now: T });
  assert.equal(old.total, 0);
});

// ── opportunity lifecycle ────────────────────────────────────────────────────
const spec = (o = {}) => ({ asset: 'EURUSD_otc', tf: 300, timingTf: 60, setupTime: T, closePrice: 1.1, atr: 0.001, dir: 'CALL',
  kind: 'pullback', confidence: 70, invalidation: 1.098, ...o });
const c1 = (time, open, close, high = Math.max(open, close), low = Math.min(open, close)) => ({ tf: 60, time, open, high, low, close });

test('opportunity: a strong setup without a timing frame enters at the setup close', () => {
  const { opp, enter } = OTC.Opportunity.create(spec({ timingTf: null, tf: 60 }), cfg);
  assert.equal(opp.state, 'ENTER_NOW');
  assert.equal(enter.time, T + 60);
  assert.equal(enter.price, 1.1);
});

test('opportunity: waits for a confirmation candle, then enters at its close', () => {
  let { opp, enter } = OTC.Opportunity.create(spec(), cfg);
  assert.equal(opp.state, 'WAIT_FOR_CONFIRMATION');
  assert.equal(enter, null);
  ({ opp, enter } = OTC.Opportunity.step(opp, { kind: 'tick', now: T + 330, price: 1.1001 }, cfg));
  assert.equal(enter, null);
  ({ opp, enter } = OTC.Opportunity.step(opp, { kind: 'close', now: T + 360, price: 1.10005, candle: c1(T + 300, 1.1, 1.10005), candleAtr: 0.0004 }, cfg));
  assert.equal(opp.state, 'WAIT_FOR_CONFIRMATION'); // weak body: keep waiting
  ({ opp, enter } = OTC.Opportunity.step(opp, { kind: 'close', now: T + 420, price: 1.1003, candle: c1(T + 360, 1.10005, 1.1003), candleAtr: 0.0004 }, cfg));
  assert.equal(opp.state, 'ENTER_NOW');
  assert.equal(enter.time, T + 420);
  assert.equal(enter.why, 'confirmed');
  OTC.Opportunity.markEntered(opp, T + 421, 'paper');
  assert.equal(opp.state, 'ENTERED');
  assert.equal(OTC.Opportunity.isActive(opp), false);
});

test('opportunity: invalidation, strong opposite candle, missed move and expiry end it', () => {
  let { opp } = OTC.Opportunity.create(spec(), cfg);
  ({ opp } = OTC.Opportunity.step(opp, { kind: 'tick', now: T + 320, price: 1.0975 }, cfg));
  assert.equal(opp.state, 'INVALIDATED');

  ({ opp } = OTC.Opportunity.create(spec(), cfg));
  ({ opp } = OTC.Opportunity.step(opp, { kind: 'close', now: T + 360, price: 1.0995, candle: c1(T + 300, 1.1, 1.0995), candleAtr: 0.0004 }, cfg));
  assert.equal(opp.state, 'INVALIDATED');

  ({ opp } = OTC.Opportunity.create(spec(), cfg));
  ({ opp } = OTC.Opportunity.step(opp, { kind: 'tick', now: T + 330, price: 1.1012 }, cfg));
  assert.equal(opp.state, 'MISSED_ENTRY');

  ({ opp } = OTC.Opportunity.create(spec(), cfg));
  ({ opp } = OTC.Opportunity.step(opp, { kind: 'tick', now: opp.expiresAt, price: 1.1 }, cfg));
  assert.equal(opp.state, 'EXPIRED');
});

test('opportunity: an opposite setup on another frame invalidates it', () => {
  let { opp } = OTC.Opportunity.create(spec(), cfg);
  ({ opp } = OTC.Opportunity.step(opp, { kind: 'close', now: T + 360, price: 1.1, reanalysis: { tf: 60, decision: 'PUT' } }, cfg));
  assert.equal(opp.state, 'INVALIDATED');
  assert.match(opp.history.at(-1).why, /opposite_setup_60/);
});

test('opportunity: price ran → wait for retest; comes back → enter', () => {
  let { opp } = OTC.Opportunity.create(spec({ closePrice: 1.1 }), cfg);
  ({ opp } = OTC.Opportunity.step(opp, { kind: 'close', now: T + 360, price: 1.1007, candle: c1(T + 300, 1.10065, 1.1007), candleAtr: 0.0004 }, cfg));
  assert.equal(opp.state, 'WAIT_FOR_RETEST');
  const r = OTC.Opportunity.step(opp, { kind: 'close', now: T + 420, price: 1.1001, candle: c1(T + 360, 1.1007, 1.1001), candleAtr: 0.0004 }, cfg);
  assert.equal(r.opp.state, 'ENTER_NOW');
  assert.equal(r.enter.why, 'retest');
});

test('opportunity: price against → wait for a rejection candle', () => {
  const s = OTC.Opportunity.create(spec({ confidence: 85, closePrice: 1.1, invalidation: 1.0985 }), cfg);
  // created at close with price == close → strong setup enters immediately
  assert.equal(s.opp.state, 'ENTER_NOW');
  let opp = { ...OTC.Opportunity.create(spec({ invalidation: 1.0985 }), cfg).opp, state: 'CONFIRMED' };
  ({ opp } = OTC.Opportunity.step(opp, { kind: 'close', now: T + 360, price: 1.0994, candle: c1(T + 300, 1.0996, 1.0994), candleAtr: 0.0004 }, cfg));
  assert.equal(opp.state, 'WAIT_FOR_REJECTION');
  // bullish candle with a long lower wick
  const r = OTC.Opportunity.step(opp, { kind: 'close', now: T + 420, price: 1.0996, candle: c1(T + 360, 1.0994, 1.0996, 1.0997, 1.0989) }, cfg);
  assert.equal(r.opp.state, 'ENTER_NOW');
  assert.equal(r.enter.why, 'rejection');
});

// ── calibrated confidence ────────────────────────────────────────────────────
test('calibration: P(edge) is a probability of beating break-even, not a vote count', () => {
  const C = OTC.Calibration;
  assert.ok(Math.abs(C.ibeta(0.5, 2, 2) - 0.5) < 1e-9);
  assert.ok(Math.abs(C.ibeta(0.3, 1, 1) - 0.3) < 1e-9);
  // no data → the sceptical prior says exactly 50%
  assert.ok(Math.abs(C.pEdge(0, 0, 54.05) - 0.5) < 0.02);
  // 60% over 50 trades is not enough for 92%; 62% over 300 is
  assert.ok(C.pEdge(30, 20, 54.05) < 0.92);
  assert.ok(C.pEdge(186, 114, 54.05) > 0.92);
  // at break-even it stays near 50% however much data there is
  assert.ok(Math.abs(C.pEdge(5405, 4595, 54.05) - 0.5) < 0.05);
});

// records of one cohort: frame 300, trend_pullback CALL in TRENDING_UP; wins with probability pWin at 10 minutes
function cohort(n, pWin, { seed = 1, from = 1_690_000_000, flipAfter = null } = {}) {
  const { rng } = require('./load.js');
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const t = from + i * 1800, p = flipAfter != null && i >= flipAfter ? 1 - pWin : pWin, win = r() < p;
    out.push({ id: `opp|EURUSD_otc|300|${t}`, kind: 'opp', tf: 60, frame: 300, asset: 'EURUSD_otc', source: 'live', ts: t, decision: 'CALL', lean: 'CALL',
      setup: 'trend_pullback', setupKind: 'pullback', regime: 'TRENDING_UP', payout: 85, path: ['DISCOVERED', 'CONFIRMED', 'GATED'], entryPrice: 1,
      exits: { 5: win ? 1.0001 : 0.9999, 10: win ? 1.0001 : 0.9999 }, status: 'resolved' });
  }
  return out;
}
const candidate = { frame: 300, setup: 'trend_pullback', kind: 'pullback', dir: 'CALL', regime: 'TRENDING_UP', asset: 'EURUSD_otc', payout: 85 };

test('calibration: cohort tables split old (duration choice) from new (out-of-sample confidence)', () => {
  const T = OTC.Calibration.buildTables(cohort(200, 0.7), cfg);
  const t = T.entries['300|trend_pullback|CALL|TRENDING_UP'];
  assert.ok(t && t[600], 'horizons are in seconds (these records keep minutes: tf 60)');
  assert.equal(t[600].sel[0] + t[600].sel[1], 120);
  assert.equal(t[600].oos[0] + t[600].oos[1], 80);
  assert.equal(t[600].folds.length, 3);
});

test('calibration: a strong stable edge passes 92%; no edge, a thin sample or an unstable one never does', () => {
  const A = (recs) => OTC.Calibration.assess(candidate, OTC.Calibration.buildTables(recs, cfg), { cfg });
  const strong = A(cohort(400, 0.72));
  assert.equal(strong.source, 'entries');
  assert.ok(strong.p >= 92, JSON.stringify(strong));
  assert.ok([300, 600].includes(strong.expirySec));
  const none = A(cohort(400, 0.54, { seed: 2 }));
  assert.ok(none.p < 92, String(none.p));
  const thin = A(cohort(40, 0.8, { seed: 3 }));
  assert.equal(thin.p, 0, 'fewer than minOOS out-of-sample outcomes: no confidence at all');
  assert.equal(thin.reason, 'no_history');
  // edge only in the first two thirds: the last fold is below break-even
  const decayed = A(cohort(400, 0.8, { seed: 4, flipAfter: 300 }));
  assert.equal(decayed.stable, false);
  assert.ok(decayed.p <= cfg.gate.unstableCap);
});

test('calibration: monitor rejects the model when entries it let through on measured evidence lose', () => {
  const recs = [];
  for (let i = 0; i < 60; i++) recs.push({ kind: 'opp', lean: 'CALL', expirySec: 300, path: ['ENTERED'], cal: { p: 75, reason: 'measured' }, entryPrice: 1, payout: 92, exits: { 5: i % 3 ? 0.999 : 1.001 } });
  const m = OTC.Calibration.monitor(recs, cfg);
  assert.equal(m.status, 'REJECTED');
  const ok = OTC.Calibration.monitor(recs.map((r, i) => ({ ...r, exits: { 5: i % 4 ? 1.001 : 0.999 } })), cfg);
  assert.notEqual(ok.status, 'REJECTED');
  assert.equal(OTC.Calibration.monitor(recs.slice(0, 10), cfg).status, 'COLLECTING');
  // entries without measured confidence (cold start) never decide the model's fate
  const cold = recs.map((r) => ({ ...r, cal: { p: 0, reason: 'no_history' } }));
  const mc = OTC.Calibration.monitor(cold, cfg);
  assert.equal(mc.status, 'COLLECTING');
  assert.equal(mc.rows[0].n, 60);
});

// ── frame selection ──────────────────────────────────────────────────────────
test('frame selection: clean frames become setup frames; noisy confirmation frames are dropped', () => {
  const { makeCandles } = require('./load.js');
  const trend = makeCandles({ tf: 300, segments: [{ n: 200, drift: 0.8, vol: 0.0004 }], seed: 5 });
  const chop = makeCandles({ tf: 60, segments: [{ n: 200, drift: 0, vol: 0.0004 }], seed: 6 }).map((c) => ({ ...c, open: c.close, high: c.close + 0.0006, low: c.close - 0.0006 }));
  const q5 = OTC.FrameSelect.quality(trend, OTC.Features.compute(trend, 300));
  const q1 = OTC.FrameSelect.quality(chop, OTC.Features.compute(chop, 60));
  assert.ok(q5.score > q1.score, `${q5.score} vs ${q1.score}`);
  const sel = OTC.FrameSelect.choose({ 300: q5, 60: q1, 900: q5, 1800: q5 }, cfg);
  assert.ok(sel.setupFrames.includes(300));
  assert.equal(sel.profiles[300].TIMING, null, 'noisy 1M is not used to confirm');
  assert.equal(sel.profiles[900].TIMING, 300);
  assert.equal(sel.why[60], 'unclear');
});

test('wording: an entry the system will not place is never shown as "enter now"', () => {
  const now = T + 302;
  const base = { state: 'ENTERED', dir: 'CALL', tf: 300, timingTf: 60, kind: 'pullback', entry: { time: T + 300, tf: 60, why: 'confirmed' },
    expiry: { sec: 300, source: 'setup', reason: { tf: 300, adj: [] } }, alsoOn: [], facts: { level: 'high', dir: 'CALL', risks: [] },
    cal: { qualified: true, measured: false, p: 0, payout: 92, minPayout: 92 } };
  const d0 = AR.decision({ opp: base }, now);
  assert.equal(d0.title, 'ادخل الآن');
  const shadow = AR.decision({ opp: { ...base, action: { action: 'shadow' } } }, now);
  assert.equal(shadow.title, 'الزوج غير مفتوح للتنفيذ');
  assert.notEqual(shadow.key, 'enter');
  const risk = AR.decision({ opp: { ...base, action: { action: 'risk', detail: ['COOLDOWN', 'MAX_CONCURRENT'] } } }, now);
  assert.equal(risk.title, 'منعتها الحماية');
  assert.match(risk.rows[0][1], /استراحة بعد صفقة خاسرة، توجد صفقة مفتوحة بالفعل/);
  const done = AR.decision({ opp: { ...base, action: { action: 'confirmed' } } }, now);
  assert.equal(done.title, 'تم التنفيذ');
});
