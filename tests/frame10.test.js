// The 10-minute frame and the Keltner trend pullback: the frame is a full setup frame, and the strategy fires on
// exactly the rule that was backtested (5 closes in the trend half of EMA 20 ± 2 ATR 10, then a touch of the middle
// line that closes back on the trend side).
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeCandles } = require('./load.js');

const ctx = load(), { OTC, Ind } = ctx, AR = ctx.AR;

test('10-minute frame: a setup frame with its own roles, fed, labelled, enterable', () => {
  assert.ok(OTC.PROFILES[600] && OTC.PROFILES[600].PRIMARY === 600);
  assert.ok([...OTC.FEED_TFS].includes(600));
  assert.equal(OTC.TF_LABEL[600], '10M');
  const cfg = OTC.DEFAULT_CONFIG;
  assert.ok([...cfg.setupFrames].includes(600));
  assert.ok(cfg.entryWindowByFrame[600] > 0 && cfg.opportunity.validityCandles[600] >= 1);
  // the feed builds 10-minute candles from ticks / 1M candles
  const f = new OTC.Feed.Feed('X'), T0 = 1_790_000_000 - (1_790_000_000 % 600);
  let closed = 0;
  for (let t = T0; t < T0 + 1300; t++) for (const x of f.ingest(t, 1 + t * 1e-7)) if (x.tf === 600) closed++;
  assert.equal(closed, 2, 'two 10-minute candles closed in 21+ minutes of ticks');
});

test('Keltner trend pullback fires on exactly the backtested rule, on the 10-minute frame', () => {
  // trending 10-minute candles with pullbacks: 190 candles (inside the features window of 200)
  const cs = makeCandles({ tf: 600, seed: 3, segments: [{ n: 60, drift: 0.35, vol: 0.0004 }, { n: 60, drift: -0.35, vol: 0.0004 }, { n: 70, drift: 0.3, vol: 0.0004 }] });
  const rule = (upTo) => {
    const c = cs.slice(0, upTo + 1), closes = c.map((x) => x.close), e = Ind.ema(closes, 20), a = Ind.atr(c, 10), n = c.length - 1;
    if (e[n - 5] == null || a[n - 5] == null) return 0;
    for (const s of [1, -1]) {
      const half = [5, 4, 3, 2, 1].every((q) => { const j = n - q; return s > 0 ? c[j].close > e[j] && c[j].close <= e[j] + 2 * a[j] : c[j].close < e[j] && c[j].close >= e[j] - 2 * a[j]; });
      const touch = s > 0 ? c[n].low <= e[n] && c[n].close > e[n] : c[n].high >= e[n] && c[n].close < e[n];
      if (half && touch) return s;
    }
    return 0;
  };
  let fired = 0, matched = 0, checked = 0;
  for (let i = 40; i < cs.length; i++) {
    const want = rule(i);
    const X = OTC.withProfile(600, () => OTC.Pipeline.buildContext({ 600: cs.slice(0, i + 1) }, {}));
    if (!X.f5?.ready) continue;
    const out = OTC.withProfile(600, () => OTC.Strategies.runAll(X)).find((x) => x.strategy === 'keltner_trend_pullback');
    const got = out ? (out.direction === 'CALL' ? 1 : -1) : 0;
    checked++; if (want) fired++;
    if (got === want) matched++;
    if (out) assert.ok(out.active, 'no hand-made objections: it is the pure rule');
  }
  assert.ok(fired >= 3, `the rule fired ${fired} times`);
  assert.equal(matched, checked, 'the strategy and the backtested rule agree on every candle');
});

test('10-minute frame trades last 30 minutes (the tested duration; PO has no M10), and the reason says so', () => {
  const cfg = OTC.DEFAULT_CONFIG;
  assert.equal(cfg.frameExpirySec[600], 1800);
  assert.equal(cfg.onlyFrame, null, 'the system chooses frames unless the user picks one');
  const ex = OTC.Expiry.choose({ tf: 600, kind: 'trend', available: [3, 15, 30, 60, 180, 300, 1800, 3600, 14400], cfg, fixedSec: 1800, fixedSource: 'frame' });
  assert.equal(ex.sec, 1800);
  assert.equal(ex.source, 'frame');
  assert.match(AR.expiryWhy({ ...ex, reason: { ...ex.reason, tf: 600 } }), /10 دقائق/);
});

test('Keltner 10-minute mode: that strategy alone decides — no consensus, regime or contradiction filters', () => {
  const cs = makeCandles({ tf: 600, seed: 3, segments: [{ n: 60, drift: 0.35, vol: 0.0004 }, { n: 60, drift: -0.35, vol: 0.0004 }, { n: 70, drift: 0.3, vol: 0.0004 }] });
  const cfg = OTC.config({ solo: 'keltner_trend_pullback', onlyFrame: 600 });
  let entries = 0, skips = 0, normalEntries = 0;
  for (let i = 40; i < cs.length; i++) {
    const at = (c) => OTC.withProfile(600, () => { const X = OTC.Pipeline.buildContext({ 600: cs.slice(0, i + 1) }, { cfg: c }); return X.f5?.ready ? { X, a: OTC.Pipeline.deepAnalyze(X, { reliability: null, meta: { asset: 'EURUSD_otc', time: cs[i].time + 600, candleTime: cs[i].time } }) } : null; });
    const r = at(cfg); if (!r) continue;
    const k = OTC.withProfile(600, () => OTC.Strategies.runAll(r.X)).find((x) => x.strategy === 'keltner_trend_pullback' && x.active);
    if (k) { entries++; assert.equal(r.a.decision, k.direction, `candle ${i}: the Keltner signal is the decision`); assert.equal(r.a.setup, 'keltner_trend_pullback'); assert.ok(r.a.confidence >= cfg.opportunity.enterNowConfidence, 'entered at the setup close, as tested'); }
    else { skips++; assert.equal(r.a.decision, 'SKIP'); assert.ok(r.a.skipReasons.some((s) => /no keltner_trend_pullback signal/.test(s))); }
    if (at(OTC.DEFAULT_CONFIG).a.decision !== 'SKIP') normalEntries++;
  }
  assert.ok(entries >= 3 && skips > entries, `${entries} entries, ${skips} skips`);
});
