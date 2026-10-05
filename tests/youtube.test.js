// The "استراتيجيات يوتيوب" mode: the videos' strategies stay out of the normal engine, and in their mode each one
// decides only on its own frame, with its own duration.
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeCandles } = require('./load.js');

const { OTC } = load();
const Y = OTC.YouTube;

test('YouTube strategies: hidden from the normal engine and its consensus', () => {
  const ids = [...Y.ids()];
  assert.equal(ids.length, 18, '15 of the creators\' strategies + 2 tuned versions + Keltner (Pocket Option\'s 35 and 6 dropped ones are out of the mode)');
  for (const id of ['yt_cci_psar', 'yt_sma_stoch', 'yt_fractal_ema', 'yt_alligator_rsi', 'yt_supertrend_5s', 'yt_aroon_keltner']) assert.ok(!ids.includes(id), id);
  assert.equal(Y.all().length, 59);
  assert.ok(!ids.some((id) => id.startsWith('po_')));
  assert.ok(!OTC.Strategies.list().some((s) => s.family === 'youtube'), 'they never vote in the consensus');
  assert.equal(OTC.Strategies.listAll().filter((s) => s.family === 'youtube').length, 58);
  const cs = makeCandles({ tf: 60, seed: 4, segments: [{ n: 200, drift: 0.1, vol: 0.0004 }] });
  const X = OTC.withProfile(60, () => OTC.Pipeline.buildContext({ 60: cs }, {}));
  const fired = OTC.withProfile(60, () => OTC.Strategies.runAll(X));
  assert.ok(!fired.some((x) => x.strategy.startsWith('yt_')));
  assert.deepEqual([...Y.frames()], [5, 15, 30, 60, 300, 600]);
});

test('YouTube mode: each strategy fires only on its own frame, without errors, and brings its own duration', () => {
  const cfg = OTC.config({ solo: Y.ids(), soloFrames: Y.frames(), soloOff: [] });
  const seen = new Set();
  for (const tf of [5, 15, 30, 60]) {
    const cs = makeCandles({ tf, seed: 7 + tf, segments: [{ n: 120, drift: 0.3, vol: 0.0004 }, { n: 120, drift: -0.3, vol: 0.0004 }, { n: 160, drift: 0, vol: 0.0006 }] });
    for (let i = 230; i < cs.length; i += 1) {
      const win = cs.slice(Math.max(0, i - 199), i + 1);
      const r = OTC.withProfile(tf, () => { const X = OTC.Pipeline.buildContext({ [tf]: win }, { cfg }); const fired = OTC.Strategies.runAll(X); return { X, fired, a: OTC.Pipeline.deepAnalyze(X, { reliability: null, meta: { asset: 'EURUSD_otc', time: cs[i].time + tf, candleTime: cs[i].time } }) }; });
      assert.equal(r.fired.errors.length, 0, r.fired.errors.join(' | '));
      for (const x of r.fired.filter((f) => f.active && f.strategy.startsWith('yt_'))) { assert.equal(OTC.Strategies.get(x.strategy).frame, tf, `${x.strategy} fired on ${tf}s`); seen.add(x.strategy); }
      if (r.a.decision !== 'SKIP') {
        const st = OTC.Strategies.get(r.a.setup);
        assert.ok(Y.ids().includes(r.a.setup));
        if (st.frame) assert.equal(st.frame, tf);
        if (st.family === 'youtube') assert.equal(r.a.soloExpiry, st.expirySec);
      } else assert.ok(r.a.skipReasons.some((s) => /no mode strategy signal|mode strategies disagree|unavailable/.test(s)), r.a.skipReasons.join(' | '));
    }
  }
  assert.ok(seen.size >= 8, `strategies that fired: ${[...seen].join(', ')}`);
});

test('YouTube mode: a hole in another frame does not stop a strategy that reads only its own frame', () => {
  const cs = makeCandles({ tf: 15, seed: 21, segments: [{ n: 220, drift: 0.2, vol: 0.0004 }] });
  const cfg = OTC.config({ solo: Y.ids(), soloFrames: Y.frames() });
  const dq = { ok: false, issues: [{ severity: 'fatal', tf: 60, detail: '1 missing candle(s) 3 bars ago' }, { severity: 'fatal', tf: 5, detail: '2 missing candle(s) 1 bars ago' }] };
  const a = OTC.withProfile(15, () => { const X = OTC.Pipeline.buildContext({ 15: cs }, { cfg }); return OTC.Pipeline.deepAnalyze(X, { dq, reliability: null, meta: { asset: 'EURUSD_otc', time: cs.at(-1).time + 15, candleTime: cs.at(-1).time } }); });
  assert.ok(!a.skipReasons.some((s) => /missing/.test(s)), a.skipReasons.join(' | '));
  assert.ok(a.riskFlags.some((s) => /1M 1 missing/.test(s)), 'still noted');
  const own = OTC.withProfile(15, () => { const X = OTC.Pipeline.buildContext({ 15: cs }, { cfg }); return OTC.Pipeline.deepAnalyze(X, { dq: { ok: false, issues: [{ severity: 'fatal', tf: 15, detail: '1 missing candle(s) 2 bars ago' }] }, reliability: null, meta: { asset: 'EURUSD_otc', time: cs.at(-1).time + 15, candleTime: cs.at(-1).time } }); });
  assert.ok(own.skipReasons.some((s) => /15S 1 missing/.test(s)), 'a hole in its own frame still stops it (its indicators would be wrong)');
});

test('a switched-off strategy of the mode no longer decides', () => {
  const ids = Y.ids();
  const cs = makeCandles({ tf: 60, seed: 31, segments: [{ n: 150, drift: 0.2, vol: 0.0004 }, { n: 150, drift: -0.2, vol: 0.0005 }] });
  let fired = 0;
  for (let i = 200; i < cs.length; i++) {
    const win = cs.slice(i - 199, i + 1), meta = { asset: 'EURUSD_otc', time: cs[i].time + 60, candleTime: cs[i].time };
    const on = OTC.withProfile(60, () => OTC.Pipeline.deepAnalyze(OTC.Pipeline.buildContext({ 60: win }, { cfg: OTC.config({ solo: ids, soloFrames: Y.frames(), soloOff: [] }) }), { reliability: null, meta }));
    if (on.setup !== 'yt_three_candles' || on.decision === 'SKIP') continue;
    fired++;
    const off = OTC.withProfile(60, () => OTC.Pipeline.deepAnalyze(OTC.Pipeline.buildContext({ 60: win }, { cfg: OTC.config({ solo: ids, soloFrames: Y.frames(), soloOff: ['yt_three_candles'] }) }), { reliability: null, meta }));
    assert.notEqual(off.setup, 'yt_three_candles');
    assert.ok(!(off.combo || '').includes('yt_three_candles'));
  }
  assert.ok(fired > 0, 'the strategy fired at least once while on');
  // only the six that won on real trades stay on
  assert.deepEqual([...Y.ids()].filter((id) => !OTC.DEFAULT_CONFIG.soloOff.includes(id)).sort(), ['yt_bollinger_supertrend', 'yt_ichimoku_williams', 'yt_stoch_cross', 'yt_supertrend_rsi', 'yt_williams_macd', 'yt_wma_stoch_macd']);
});

test('«AC + CCI + الأظرف»: buys when the three line up on a rising line, never on a flat one', () => {
  const r = Y.RULES.find((x) => x.id === 'yt_ac_cci_envelopes');
  assert.equal(r.frame, 60); assert.equal(r.expirySec, 120);
  // flat, then a steady climb that speeds up: buying pressure, CCI above +100, the WMA line climbing
  const cs = []; let p = 1.1;
  for (let i = 0; i < 80; i++) { const d = i < 50 ? (i % 2 ? 0.00002 : -0.00002) : 0.00004 * (i - 49); const o = p; p += d; cs.push({ time: i * 60, open: o, close: p, high: Math.max(o, p) + 0.00001, low: Math.min(o, p) - 0.00001 }); }
  const fired = cs.map((_, i) => (i > 30 ? r.rule(cs.slice(0, i + 1), i) : 0));
  assert.ok(fired.includes(1), 'a buy on the climb');
  assert.ok(!fired.slice(0, 50).some((x) => x), 'nothing while the line is flat');
  assert.ok(!fired.includes(-1));
});

test('«5 شموع ← عكسها (30ث)»: five candles one colour after one of the other → the other way', () => {
  const r = Y.RULES.find((x) => x.id === 'yt_5candles_rev30');
  assert.equal(r.frame, 30); assert.equal(r.expirySec, 120);
  const mk = (cols) => cols.map((c, i) => ({ time: i * 30, open: 1, close: 1 + c * 0.0001, high: 1.0002, low: 0.9998 }));
  assert.equal(r.rule(mk([1, 1, -1, 1, 1, 1, 1, 1]), 7), -1, 'red, then five green → sell');
  assert.equal(r.rule(mk([1, 1, 1, -1, -1, -1, -1, -1]), 7), 1, 'green, then five red → buy');
  assert.equal(r.rule(mk([1, 1, 1, 1, 1, 1, 1, 1]), 7), 0, 'six green: no opposite candle before the five');
  assert.equal(r.rule(mk([1, 1, -1, 1, 1, -1, 1, 1]), 7), 0);
});

test('«RSI + MACD مع الاتجاه»: only the way the last 12 minutes went — RSI back under 70 / MACD crossing down sells in a fall', () => {
  const r = Y.RULES.find((x) => x.id === 'yt_rsi_macd_trend');
  assert.equal(r.frame, 5); assert.equal(r.expirySec, 15);
  // a steady fall, then a sharp bounce (RSI over 70) that fades: a sell, never a buy
  const cs = []; let p = 1.1;
  for (let i = 0; i < 200; i++) { const d = i < 170 ? -0.00002 : i < 185 ? 0.00006 : -0.00004; const o = p; p += d; cs.push({ time: i * 5, open: o, close: p, high: Math.max(o, p), low: Math.min(o, p) }); }
  const fired = cs.map((_, i) => (i >= 160 ? r.rule(cs.slice(0, i + 1), i) : 0));
  assert.ok(fired.includes(-1), 'a sell when the bounce fades');
  assert.ok(!fired.includes(1), 'no buy against the falling trend');
  assert.ok(Y.ids().includes('yt_rsi_macd_trend'));
  assert.ok(OTC.DEFAULT_CONFIG.soloGuard.ids.includes('yt_rsi_macd_trend'), 'on trial');
});

test('«ستوكاستك مع الاتجاه» and «الدخول في التراجع»: with the trend only, never against it or in a sideways market', () => {
  const st = Y.RULES.find((x) => x.id === 'yt_stoch_trend'), pb = Y.RULES.find((x) => x.id === 'yt_pullback_trend');
  assert.equal(st.frame, 5); assert.equal(st.expirySec, 60); assert.equal(pb.expirySec, 60);
  const mk = (moves) => { const cs = []; let p = 1.1; moves.forEach((d, i) => { const o = p; p += d; cs.push({ time: i * 5, open: o, close: p, high: Math.max(o, p) + 0.000005, low: Math.min(o, p) - 0.000005 }); }); return cs; };
  // a rise in steps: 4 up, 3 down — the pullbacks are bought, nothing is sold
  const up = mk(Array.from({ length: 200 }, (_, i) => (i % 7 < 4 ? 0.00003 : -0.00002)));
  const fp = up.map((_, i) => (i >= 199 ? pb.rule(up.slice(0, i + 1), i) : 0)), fs = up.map((_, i) => (i >= 150 ? st.rule(up, i) : 0));
  assert.ok(!fp.includes(-1) && !fs.includes(-1), 'no sell in a rising market');
  assert.equal(pb.rule(up, 199), [0, 1][+(199 % 7 === 6)], 'bought on the third candle down');
  // back and forth (no trend): the Stochastic one stays out
  const flat = mk(Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.00003 : -0.00003)));
  assert.ok(flat.every((_, i) => i < 150 || st.rule(flat, i) === 0));
  assert.ok(Y.ids().includes('yt_stoch_trend') && Y.ids().includes('yt_pullback_trend'));
});
