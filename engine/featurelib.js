// Feature Library + rule language for the Strategy Discovery Engine.
//
// A feature reads one value from the analysis context (all timeframes, regime,
// time, pair, the engine's own analysis). The same vector() runs on historical
// data during discovery and on live data in the tabs, so a discovered rule means
// exactly the same thing in both places.
//
// Rules are built from ATOMS:
//   { f: 'm5.rsi', op: '<=', v: 40 }          numeric threshold (only from the feature's coarse grid)
//   { f: 'm5.rsi', op: 'between', v: [30, 40] }
//   { f: 't60.dir', op: '==', v: 'UP' }       categorical
//   { f: 't60.dir', op: '!=', v: 'DOWN' }     NOT
//   { f: 'pa.bull_engulf', op: '==', v: true } boolean
//   { or: [atomA, atomB] }                    OR of two atoms of the same group
// A rule = { dir: 'CALL'|'PUT', expiry: N, all: [atoms], none: [atoms] (negative conditions) }
// Thresholds come from fixed, coarse grids so a rule can't hinge on "RSI < 37.21".
(function (G) {
  const OTC = G.OTC, U = OTC.U;
  const FEATURES = [];
  const BY_ID = new Map();
  const add = (def) => { if (BY_ID.has(def.id)) throw new Error(`duplicate feature ${def.id}`); FEATURES.push(def); BY_ID.set(def.id, def); };
  const num = (id, label, group, tf, get, grid, extra = {}) => add({ id, label, group, tf, type: 'num', get, grid, ...extra });
  const cat = (id, label, group, tf, get, values, extra = {}) => add({ id, label, group, tf, type: 'cat', get, values, ...extra });
  const bool = (id, label, group, tf, get, extra = {}) => add({ id, label, group, tf, type: 'bool', get, ...extra });

  const NEG = { fn: 'neg' }, INV100 = { fn: 'inv100' }, INV1 = { fn: 'inv1' }, SAME = { fn: 'same' };
  const DIRMAP = { UP: 'DOWN', DOWN: 'UP', CALL: 'PUT', PUT: 'CALL', BULL: 'BEAR', BEAR: 'BULL', G: 'R', R: 'G' };
  const sideMirror = (id) => ({ id, map: DIRMAP });
  const fin = (v) => (v == null || !Number.isFinite(v) ? null : v);
  const capd = (v) => (v == null ? null : Number.isFinite(v) ? v : 99); // Infinity distance → "far"
  const dirOf = (x) => (x ? x.dir : null);
  const recentDir = (e, k = 3) => (e && e.ago <= k ? e.dir : 'none');
  const trendTF = (f) => (f?.ready ? f.trend.dir : null);
  const TFS = { 1: 'f1', 5: 'f5', 15: 'f15', 60: 'f60' };
  const TFL = { 1: '1M', 5: '5M', 15: '15M', 60: '1H' };

  // Candle class for sequences: U+ big green, U green, N doji, D red, D+ big red.
  const cls = (c, atr) => {
    const b = Math.abs(c[4] - c[1]), r = c[2] - c[3] || 1e-12;
    if (b <= 0.1 * r) return 'N';
    if (c[4] > c[1]) return b >= atr ? 'U+' : 'U';
    return b >= atr ? 'D+' : 'D';
  };
  const SEQMAP = { 'U+': 'D+', U: 'D', N: 'N', D: 'U', 'D+': 'U+' };
  const seq = (f, k) => (f?.ready && f.recent.length >= k ? f.recent.slice(-k).map((c) => cls(c, f.atr)).join(',') : null);

  // ── PRICE (5M, plus 1M) ────────────────────────────────────────────────────
  for (const t of [5, 1]) {
    const k = TFS[t], L = TFL[t], P = `p${t}`;
    const f = (C) => C[k];
    cat(`${P}.color`, `${L} candle colour`, 'price', t, (C) => (f(C)?.ready ? f(C).pa.candle.color : null), ['G', 'R', 'D'], { mirror: { id: `${P}.color`, map: DIRMAP }, concept: 'candle_color' });
    num(`${P}.body_atr`, `${L} body (ATR)`, 'price', t, (C) => fin(f(C)?.pa?.candle.bodyAtr), [0.25, 0.5, 0.75, 1, 1.5, 2], { mirror: SAME });
    num(`${P}.upper_wick`, `${L} upper wick (share of range)`, 'price', t, (C) => fin(f(C)?.pa?.candle.upperWick), [0.1, 0.2, 0.3, 0.4, 0.5, 0.6], { mirror: { id: `${P}.lower_wick`, fn: 'same' } });
    num(`${P}.lower_wick`, `${L} lower wick (share of range)`, 'price', t, (C) => fin(f(C)?.pa?.candle.lowerWick), [0.1, 0.2, 0.3, 0.4, 0.5, 0.6], { mirror: { id: `${P}.upper_wick`, fn: 'same' } });
  }
  const f5 = (C) => C.f5;
  num('p5.range_atr', '5M range (ATR)', 'price', 5, (C) => fin(f5(C)?.pa?.candle.rangeAtr), [0.5, 0.75, 1, 1.5, 2, 3], { mirror: SAME });
  num('p5.body_ratio', '5M body / range', 'price', 5, (C) => fin(f5(C)?.pa?.candle.bodyRatio), [0.2, 0.4, 0.6, 0.8], { mirror: SAME });
  num('p5.close_pos', '5M close position in range', 'price', 5, (C) => fin(f5(C)?.pa?.candle.closePos), [0.2, 0.4, 0.6, 0.8], { mirror: INV1 });
  num('p5.run_green', '5M consecutive green candles', 'price', 5, (C) => fin(f5(C)?.momentum?.run.green), [1, 2, 3, 4, 5], { mirror: { id: 'p5.run_red', fn: 'same' } });
  num('p5.run_red', '5M consecutive red candles', 'price', 5, (C) => fin(f5(C)?.momentum?.run.red), [1, 2, 3, 4, 5], { mirror: { id: 'p5.run_green', fn: 'same' } });
  cat('p5.prev_rel', '5M vs previous candle', 'price', 5, (C) => f5(C)?.pa?.prevRelation ?? null, ['outside', 'inside', 'closed_above', 'closed_below', 'overlap'],
    { mirror: { id: 'p5.prev_rel', map: { closed_above: 'closed_below', closed_below: 'closed_above' } } });
  const chg = (C, k) => { const f = f5(C); if (!f?.ready || f.recent.length <= k) return null; const r = f.recent; return (r[r.length - 1][4] - r[r.length - 1 - k][4]) / f.atr; };
  num('p5.chg1_atr', '5M 1-candle change (ATR)', 'price', 5, (C) => fin(chg(C, 1)), [-1.5, -1, -0.5, 0, 0.5, 1, 1.5], { mirror: NEG });
  num('p5.chg3_atr', '5M 3-candle change (ATR)', 'price', 5, (C) => fin(chg(C, 3)), [-3, -2, -1, 0, 1, 2, 3], { mirror: NEG });
  num('p5.chg1_bp', '5M 1-candle change (basis points)', 'price', 5, (C) => { const f = f5(C); if (!f?.ready) return null; const r = f.recent; return ((r[r.length - 1][4] / r[r.length - 2][4]) - 1) * 1e4; }, [-10, -5, -2, 0, 2, 5, 10], { mirror: NEG });
  num('p5.accel', '5M momentum change (ATR)', 'price', 5, (C) => (f5(C)?.ready ? f5(C).momentum.candleMom - f5(C).momentum.prevMom : null), [-1.5, -0.75, 0, 0.75, 1.5], { mirror: NEG });
  for (const k of [2, 3]) {
    cat(`seq${k}`, `last ${k} 5M candles`, 'sequence', 5, (C) => seq(f5(C), k), null, { mirror: { id: `seq${k}`, seq: true }, maxValues: 60 });
  }

  // Candlestick patterns (5M) and composite "any" groups. OR-able within the group.
  const PATS = [['bull_engulf', 'bullish_engulfing', 'CALL', 'bear_engulf'], ['bear_engulf', 'bearish_engulfing', 'PUT', 'bull_engulf'],
    ['pin_bull', 'pin_bar', 'CALL', 'pin_bear'], ['pin_bear', 'pin_bar', 'PUT', 'pin_bull'], ['hammer', 'hammer', 'CALL', 'shooting_star'],
    ['shooting_star', 'shooting_star', 'PUT', 'hammer'], ['doji', 'doji', null, 'doji'], ['doji_rej_bull', 'doji_rejection', 'CALL', 'doji_rej_bear'],
    ['doji_rej_bear', 'doji_rejection', 'PUT', 'doji_rej_bull'], ['inside_bar', 'inside_bar', null, 'inside_bar'], ['outside_bull', 'outside_bar', 'CALL', 'outside_bear'],
    ['outside_bear', 'outside_bar', 'PUT', 'outside_bull'], ['morning_star', 'morning_star', 'CALL', 'evening_star'], ['evening_star', 'evening_star', 'PUT', 'morning_star'],
    ['tweezer_bottom', 'tweezer_bottom', 'CALL', 'tweezer_top'], ['tweezer_top', 'tweezer_top', 'PUT', 'tweezer_bottom'],
    ['lwr_bull', 'long_wick_rejection', 'CALL', 'lwr_bear'], ['lwr_bear', 'long_wick_rejection', 'PUT', 'lwr_bull'],
    ['strong_bull', 'strong_body', 'CALL', 'strong_bear'], ['strong_bear', 'strong_body', 'PUT', 'strong_bull']];
  const hasPat = (C, name, dir) => !!f5(C)?.ready && f5(C).pa.patterns.some((p) => p.name === name && p.dir === dir);
  for (const [id, name, dir, mir] of PATS) {
    bool(`pa.${id}`, `5M ${name.replace(/_/g, ' ')}${dir ? ` (${dir === 'CALL' ? 'bullish' : 'bearish'})` : ''}`, 'pattern', 5, (C) => (f5(C)?.ready ? hasPat(C, name, dir) : null), { mirror: { id: `pa.${mir}` }, orable: true });
  }
  bool('pa.bull_rejection', '5M bullish rejection (pin / hammer / long lower wick / doji)', 'pattern', 5,
    (C) => (f5(C)?.ready ? ['pin_bar', 'hammer', 'long_wick_rejection', 'doji_rejection'].some((n) => hasPat(C, n, 'CALL')) : null), { mirror: { id: 'pa.bear_rejection' }, orable: true });
  bool('pa.bear_rejection', '5M bearish rejection (pin / star / long upper wick / doji)', 'pattern', 5,
    (C) => (f5(C)?.ready ? ['pin_bar', 'shooting_star', 'long_wick_rejection', 'doji_rejection'].some((n) => hasPat(C, n, 'PUT')) : null), { mirror: { id: 'pa.bull_rejection' }, orable: true });
  bool('p1.rej_bull', '1M bullish rejection (lower wick ≥ 50%)', 'pattern', 1, (C) => (C.f1?.ready ? C.f1.pa.candle.lowerWick >= 0.5 : null), { mirror: { id: 'p1.rej_bear' }, orable: true });
  bool('p1.rej_bear', '1M bearish rejection (upper wick ≥ 50%)', 'pattern', 1, (C) => (C.f1?.ready ? C.f1.pa.candle.upperWick >= 0.5 : null), { mirror: { id: 'p1.rej_bull' }, orable: true });

  // ── STRUCTURE ──────────────────────────────────────────────────────────────
  for (const t of [5, 15, 60]) {
    const k = TFS[t], L = TFL[t];
    cat(`s${t}.trend`, `${L} swing structure`, 'structure', t, (C) => (C[k]?.ready ? C[k].structure.trend : null), ['BULL', 'BEAR', 'RANGE', 'UNCLEAR'], { mirror: sideMirror(`s${t}.trend`), concept: 'structure' });
    cat(`s${t}.last`, `${L} latest swing label`, 'structure', t, (C) => (C[k]?.ready ? C[k].structure.lastLabel : null), ['HH', 'HL', 'LH', 'LL'],
      { mirror: { id: `s${t}.last`, map: { HH: 'LL', LL: 'HH', HL: 'LH', LH: 'HL' } }, concept: 'swing_label' });
  }
  for (const t of [5, 15]) {
    const k = TFS[t], L = TFL[t];
    cat(`s${t}.bos`, `${L} break of structure (≤3 bars)`, 'structure', t, (C) => (C[k]?.ready ? recentDir(C[k].structure.bos) : null), ['CALL', 'PUT', 'none'], { mirror: sideMirror(`s${t}.bos`), concept: 'bos' });
    cat(`s${t}.choch`, `${L} change of character (≤3 bars)`, 'structure', t, (C) => (C[k]?.ready ? recentDir(C[k].structure.choch) : null), ['CALL', 'PUT', 'none'], { mirror: sideMirror(`s${t}.choch`), concept: 'choch' });
    cat(`s${t}.sweep`, `${L} liquidity sweep`, 'liquidity', t, (C) => (C[k]?.ready ? dirOf(C[k].liquidity.sweep) || 'none' : null), ['CALL', 'PUT', 'none'], { mirror: sideMirror(`s${t}.sweep`), concept: 'sweep' });
  }
  cat('s5.sfp', '5M swing failure', 'liquidity', 5, (C) => (f5(C)?.ready ? dirOf(f5(C).structure.sfp) || 'none' : null), ['CALL', 'PUT', 'none'], { mirror: sideMirror('s5.sfp') });
  bool('s5.sweep_confirmed', '5M sweep confirmed by rejection', 'liquidity', 5, (C) => (f5(C)?.ready ? !!f5(C).liquidity.sweep?.confirmed : null), { mirror: { id: 's5.sweep_confirmed' } });
  bool('s5.equal_levels_taken', '5M equal highs/lows swept', 'liquidity', 5, (C) => (f5(C)?.ready ? !!f5(C).liquidity.sweep?.equal : null), { mirror: { id: 's5.equal_levels_taken' } });
  const BRK = { REAL_BREAKOUT: 'REAL', WEAK_BREAKOUT: 'WEAK', FALSE_BREAKOUT: 'FALSE', BREAKOUT_RETEST: 'RETEST' };
  cat('s5.breakout', '5M breakout state', 'breakout', 5, (C) => { const b = f5(C)?.breakout; if (!f5(C)?.ready) return null; return b.status ? `${BRK[b.status]}_${b.dir === 'CALL' ? 'UP' : 'DN'}` : 'none'; },
    ['REAL_UP', 'REAL_DN', 'WEAK_UP', 'WEAK_DN', 'FALSE_UP', 'FALSE_DN', 'RETEST_UP', 'RETEST_DN', 'none'],
    { mirror: { id: 's5.breakout', map: Object.fromEntries(['REAL', 'WEAK', 'FALSE', 'RETEST'].flatMap((x) => [[`${x}_UP`, `${x}_DN`], [`${x}_DN`, `${x}_UP`]])) } });
  num('s5.breakout_ext', '5M breakout extension (ATR)', 'breakout', 5, (C) => fin(f5(C)?.breakout?.extension), [0.25, 0.5, 1, 1.5, 2.5], { mirror: SAME });
  num('s5.range_atr', '5M prior range height (ATR)', 'breakout', 5, (C) => fin(f5(C)?.breakout?.rangeAtr), [2, 3, 4, 6, 8], { mirror: SAME });
  bool('s5.compression', '5M compression (8 bars ≤ 2.5 ATR)', 'volatility', 5, (C) => (f5(C)?.ready ? f5(C).breakout.compression.is : null), { mirror: { id: 's5.compression' } });
  cat('s5.trendline', '5M trendline break', 'breakout', 5, (C) => (f5(C)?.ready ? dirOf(f5(C).breakout.trendline) || 'none' : null), ['CALL', 'PUT', 'none'], { mirror: sideMirror('s5.trendline') });

  // ── TREND ──────────────────────────────────────────────────────────────────
  for (const t of [1, 5, 15, 60]) {
    const k = TFS[t], L = TFL[t];
    cat(`t${t}.dir`, `${L} trend`, 'trend', t, (C) => trendTF(C[k]), ['UP', 'DOWN', 'FLAT'], { mirror: sideMirror(`t${t}.dir`), concept: 'trend' });
    if (t === 1) continue;
    cat(`t${t}.order`, `${L} EMA 9/21/50 order`, 'trend', t, (C) => (C[k]?.ready ? C[k].trend.order : null), ['BULL', 'BEAR', 'MIXED'], { mirror: sideMirror(`t${t}.order`), concept: 'ema_order' });
    num(`t${t}.slope21`, `${L} EMA21 slope (ATR/bar)`, 'trend', t, (C) => fin(C[k]?.trend?.slope21), [-0.15, -0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1, 0.15], { mirror: NEG, concept: 'ema_slope' });
    num(`t${t}.dist_e21`, `${L} distance from EMA21 (ATR)`, 'trend', t, (C) => fin(C[k]?.trend?.dist.e21), [-3, -2, -1.5, -1, -0.5, -0.25, 0, 0.25, 0.5, 1, 1.5, 2, 3],
      { mirror: NEG, concept: 'ema_dist', variants: t === 5 ? ['t5.dist_e18', 't5.dist_e24'] : null });
  }
  for (const [e, lab] of [['e9', 'EMA9'], ['e18', 'EMA18'], ['e24', 'EMA24'], ['e50', 'EMA50'], ['e200', 'EMA200']]) {
    num(`t5.dist_${e}`, `5M distance from ${lab} (ATR)`, 'trend', 5, (C) => fin(f5(C)?.trend?.dist[e]), [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3], { mirror: NEG, concept: 'ema_dist' });
  }
  num('t5.sep', '5M EMA9−EMA50 separation (ATR)', 'trend', 5, (C) => fin(f5(C)?.trend?.separation), [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3], { mirror: NEG });
  num('t5.sep_change', '5M EMA separation change over 5 bars (ATR)', 'trend', 5,
    (C) => { const t = f5(C)?.trend; return t && t.separation != null && t.sepPrev != null ? Math.abs(t.separation) - Math.abs(t.sepPrev) : null; }, [-1, -0.5, -0.2, 0, 0.2, 0.5, 1], { mirror: SAME });
  cat('t5.cross', '5M EMA9/21 cross (≤2 bars)', 'trend', 5, (C) => (f5(C)?.ready ? dirOf(f5(C).trend.cross) || 'none' : null), ['CALL', 'PUT', 'none'], { mirror: sideMirror('t5.cross') });
  num('t5.adx', '5M ADX', 'trend', 5, (C) => fin(f5(C)?.trend?.adx), [15, 20, 25, 30, 40], { mirror: SAME });
  num('t5.er', '5M efficiency ratio', 'trend', 5, (C) => fin(f5(C)?.trend?.er), [0.1, 0.2, 0.3, 0.4, 0.5], { mirror: SAME });

  // ── MOMENTUM ───────────────────────────────────────────────────────────────
  const rsiZone = (r) => (r == null ? null : r < 30 ? 'OS' : r < 45 ? 'LOW' : r <= 55 ? 'MID' : r <= 70 ? 'HIGH' : 'OB');
  for (const t of [5, 15, 1]) {
    const k = TFS[t], L = TFL[t];
    num(`m${t}.rsi`, `${L} RSI`, 'momentum', t, (C) => fin(C[k]?.momentum?.rsi), [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80], { mirror: INV100, concept: 'rsi' });
    cat(`m${t}.rsi_zone`, `${L} RSI zone`, 'momentum', t, (C) => rsiZone(fin(C[k]?.momentum?.rsi)), ['OS', 'LOW', 'MID', 'HIGH', 'OB'],
      { mirror: { id: `m${t}.rsi_zone`, map: { OS: 'OB', OB: 'OS', LOW: 'HIGH', HIGH: 'LOW' } }, concept: 'rsi_zone' });
  }
  const m5 = (C) => f5(C)?.momentum;
  num('m5.rsi_slope', '5M RSI change over 2 bars', 'momentum', 5, (C) => fin(m5(C)?.rsiSlope), [-10, -5, -2, 0, 2, 5, 10], { mirror: NEG });
  cat('m5.rsi_cross50', '5M RSI crossed 50', 'momentum', 5, (C) => { const m = m5(C); if (!m || m.rsi == null || m.rsiPrev == null) return null; return m.rsiPrev < 50 && m.rsi >= 50 ? 'CALL' : m.rsiPrev > 50 && m.rsi <= 50 ? 'PUT' : 'none'; }, ['CALL', 'PUT', 'none'], { mirror: sideMirror('m5.rsi_cross50') });
  num('m5.macd_hist_atr', '5M MACD histogram (ATR)', 'momentum', 5, (C) => (f5(C)?.ready && m5(C).macd.hist != null ? m5(C).macd.hist / f5(C).atr : null), [-0.3, -0.15, -0.05, 0, 0.05, 0.15, 0.3], { mirror: NEG });
  cat('m5.macd_slope', '5M MACD histogram direction', 'momentum', 5, (C) => { const m = m5(C)?.macd; return m && m.hist != null && m.histPrev != null ? (m.hist > m.histPrev ? 'UP' : m.hist < m.histPrev ? 'DOWN' : 'FLAT') : null; }, ['UP', 'DOWN', 'FLAT'], { mirror: sideMirror('m5.macd_slope') });
  cat('m5.macd_flip', '5M MACD histogram flip', 'momentum', 5, (C) => (m5(C) ? m5(C).macd.flip || 'none' : null), ['CALL', 'PUT', 'none'], { mirror: sideMirror('m5.macd_flip') });
  num('m5.stoch_k', '5M Stochastic %K', 'momentum', 5, (C) => fin(m5(C)?.stoch.k), [10, 20, 30, 50, 70, 80, 90], { mirror: INV100 });
  cat('m5.stoch_cross', '5M Stochastic cross', 'momentum', 5, (C) => (m5(C) ? m5(C).stoch.cross || 'none' : null), ['CALL', 'PUT', 'none'], { mirror: sideMirror('m5.stoch_cross') });
  cat('m5.roc_cross', '5M ROC crossed 0', 'momentum', 5, (C) => { const m = m5(C); if (!m || m.roc == null || m.rocPrev == null) return null; return m.rocPrev <= 0 && m.roc > 0 ? 'CALL' : m.rocPrev >= 0 && m.roc < 0 ? 'PUT' : 'none'; }, ['CALL', 'PUT', 'none'], { mirror: sideMirror('m5.roc_cross') });
  cat('m5.dir', '5M momentum', 'momentum', 5, (C) => m5(C)?.dir ?? null, ['CALL', 'PUT', 'NEUTRAL'], { mirror: sideMirror('m5.dir') });
  bool('m5.accel', '5M momentum accelerating', 'momentum', 5, (C) => m5(C)?.accel ?? null, { mirror: { id: 'm5.accel' } });
  bool('m5.decel', '5M momentum decelerating', 'momentum', 5, (C) => m5(C)?.decel ?? null, { mirror: { id: 'm5.decel' } });
  bool('m5.weak_up', '5M up-momentum weakening', 'momentum', 5, (C) => m5(C)?.weakening.up ?? null, { mirror: { id: 'm5.weak_down' } });
  bool('m5.weak_down', '5M down-momentum weakening', 'momentum', 5, (C) => m5(C)?.weakening.down ?? null, { mirror: { id: 'm5.weak_up' } });
  bool('m5.exh_up', '5M up-move exhausted', 'momentum', 5, (C) => m5(C)?.exhaustion.up ?? null, { mirror: { id: 'm5.exh_down' } });
  bool('m5.exh_down', '5M down-move exhausted', 'momentum', 5, (C) => m5(C)?.exhaustion.down ?? null, { mirror: { id: 'm5.exh_up' } });
  bool('m5.recover_up', '5M momentum recovering up', 'momentum', 5, (C) => m5(C)?.recovering.up ?? null, { mirror: { id: 'm5.recover_down' } });
  bool('m5.recover_down', '5M momentum rolling over', 'momentum', 5, (C) => m5(C)?.recovering.down ?? null, { mirror: { id: 'm5.recover_up' } });
  cat('d5.rsi', '5M RSI divergence', 'divergence', 5, (C) => (f5(C)?.ready ? dirOf(f5(C).divergence.rsi) || 'none' : null), ['CALL', 'PUT', 'none'], { mirror: sideMirror('d5.rsi') });
  cat('d5.macd', '5M MACD divergence', 'divergence', 5, (C) => (f5(C)?.ready ? dirOf(f5(C).divergence.macd) || 'none' : null), ['CALL', 'PUT', 'none'], { mirror: sideMirror('d5.macd') });

  // ── VOLATILITY + BOLLINGER ─────────────────────────────────────────────────
  const v5 = (C) => f5(C)?.volatility, b5 = (C) => f5(C)?.bb;
  num('v5.atr_pct', '5M ATR percentile (100 bars)', 'volatility', 5, (C) => fin(v5(C)?.atrPct), [10, 25, 50, 75, 90], { mirror: SAME });
  num('v5.atr_ratio', '5M ATR vs its median', 'volatility', 5, (C) => fin(v5(C)?.atrRatio), [0.7, 0.85, 1, 1.2, 1.5], { mirror: SAME });
  num('v5.range5', '5M average range of last 5 (ATR)', 'volatility', 5, (C) => { const f = f5(C); if (!f?.ready) return null; return U.mean(f.recent.slice(-5).map((c) => c[2] - c[3])) / f.atr; }, [0.6, 0.8, 1, 1.3, 1.6], { mirror: SAME });
  cat('v5.state', '5M volatility state', 'volatility', 5, (C) => v5(C)?.state ?? null, ['HIGH', 'NORMAL', 'LOW', 'UNKNOWN'], { mirror: { id: 'v5.state', map: {} } });
  bool('v5.abnormal', '5M abnormal candle', 'volatility', 5, (C) => v5(C)?.abnormal ?? null, { mirror: { id: 'v5.abnormal' } });
  num('pair.atr_bp', 'ATR in basis points of price', 'pair', 5, (C) => (f5(C)?.ready ? (f5(C).atr / f5(C).price) * 1e4 : null), [1, 2, 3, 5, 8], { mirror: SAME });
  num('b5.width_pct', '5M Bollinger bandwidth percentile', 'bollinger', 5, (C) => fin(b5(C)?.widthPct), [10, 20, 30, 50, 70, 90], { mirror: SAME });
  cat('b5.width_trend', '5M Bollinger bands', 'bollinger', 5, (C) => { const b = b5(C); if (!b || b.width == null || b.widthPrev3 == null) return null; return b.width > b.widthPrev3 * 1.15 ? 'EXPANDING' : b.width < b.widthPrev3 * 0.87 ? 'CONTRACTING' : 'STEADY'; }, ['EXPANDING', 'CONTRACTING', 'STEADY'], { mirror: { id: 'b5.width_trend', map: {} } });
  bool('b5.squeeze', '5M Bollinger squeeze', 'bollinger', 5, (C) => b5(C)?.squeeze ?? null, { mirror: { id: 'b5.squeeze' } });
  bool('b5.squeeze_recent', '5M squeeze in last 6 bars', 'bollinger', 5, (C) => b5(C)?.squeezeRecent ?? null, { mirror: { id: 'b5.squeeze_recent' } });
  for (const t of [5, 15]) {
    num(`b${t}.pctb`, `${TFL[t]} %B (position in bands)`, 'bollinger', t, (C) => fin(C[TFS[t]]?.bb?.pctB), [0, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 1], { mirror: INV1, concept: 'pctb' });
  }
  const bandDist = (C, up) => { const f = f5(C); return f?.ready ? (up ? f.bb.upper - f.price : f.price - f.bb.lower) / f.atr : null; };
  num('b5.dist_upper', '5M distance to upper band (ATR)', 'bollinger', 5, (C) => fin(bandDist(C, true)), [0, 0.25, 0.5, 1, 2], { mirror: { id: 'b5.dist_lower', fn: 'same' } });
  num('b5.dist_lower', '5M distance to lower band (ATR)', 'bollinger', 5, (C) => fin(bandDist(C, false)), [0, 0.25, 0.5, 1, 2], { mirror: { id: 'b5.dist_upper', fn: 'same' } });
  for (const [id, lab, key, mir] of [['b5.touch_upper', 'touched upper band', 'touchUpper', 'b5.touch_lower'], ['b5.touch_lower', 'touched lower band', 'touchLower', 'b5.touch_upper'],
    ['b5.reject_upper', 'rejected at upper band', 'rejectUpper', 'b5.reject_lower'], ['b5.reject_lower', 'rejected at lower band', 'rejectLower', 'b5.reject_upper'],
    ['b5.break_upper', 'closed above upper band', 'breakUpper', 'b5.break_lower'], ['b5.break_lower', 'closed below lower band', 'breakLower', 'b5.break_upper']]) {
    bool(id, `5M ${lab}`, 'bollinger', 5, (C) => b5(C)?.[key] ?? null, { mirror: { id: mir }, orable: true });
  }
  cat('b5.crossed_mid', '5M crossed middle band', 'bollinger', 5, (C) => (b5(C) ? b5(C).crossedMid || 'none' : null), ['CALL', 'PUT', 'none'], { mirror: sideMirror('b5.crossed_mid') });

  // ── FIBONACCI ──────────────────────────────────────────────────────────────
  const fib = (C) => (f5(C)?.ready ? f5(C).fib : null);
  cat('f5.leg', '5M last impulse leg', 'fibonacci', 5, (C) => { const f = fib(C); return f ? (f.valid ? (f.dir === 'CALL' ? 'UP' : 'DOWN') : 'none') : null; }, ['UP', 'DOWN', 'none'], { mirror: sideMirror('f5.leg') });
  const ZONES = [[0, 0.236, '0–23.6'], [0.236, 0.382, '23.6–38.2'], [0.382, 0.5, '38.2–50'], [0.5, 0.618, '50–61.8'], [0.618, 0.786, '61.8–78.6'], [0.786, 99, '>78.6']];
  cat('f5.zone', '5M retracement zone of the leg', 'fibonacci', 5, (C) => { const f = fib(C); if (!f) return null; if (!f.valid || f.barsSinceEnd < 2) return 'none'; return ZONES.find(([a, b]) => f.depth >= a && f.depth < b)[2]; },
    [...ZONES.map((z) => z[2]), 'none'], { mirror: { id: 'f5.zone', map: {} } });
  num('f5.depth', '5M retracement depth', 'fibonacci', 5, (C) => { const f = fib(C); return f?.valid && f.barsSinceEnd >= 2 ? f.depth : null; }, [0.236, 0.382, 0.5, 0.618, 0.786, 1], { mirror: SAME });
  for (const r of [0.236, 0.382, 0.5, 0.618, 0.786]) {
    num(`f5.dist_${Math.round(r * 1000)}`, `5M distance to ${(r * 100).toFixed(1)}% level (ATR)`, 'fibonacci', 5,
      (C) => { const f = fib(C); if (!f?.valid || f.barsSinceEnd < 2) return null; return Math.abs(f5(C).price - f.levels[r]) / f5(C).atr; }, [0.25, 0.5, 1, 2], { mirror: SAME });
  }
  bool('f5.on_sr', '5M Fibonacci level sits on a 2-touch S/R level', 'fibonacci', 5, (C) => { if (!C.X || !f5(C)?.ready || !fib(C)?.valid) return null; return !!OTC.Strategies.H.fibAtLevel(C.X, U.side(fib(C).dir)); }, { mirror: { id: 'f5.on_sr' } });
  bool('f5.with_structure', '5M leg direction matches swing structure', 'fibonacci', 5, (C) => { const f = fib(C), s = f5(C)?.structure; if (!f || !s) return null; return f.valid && ((f.dir === 'CALL' && s.trend === 'BULL') || (f.dir === 'PUT' && s.trend === 'BEAR')); }, { mirror: { id: 'f5.with_structure' } });

  // ── SUPPORT / RESISTANCE ───────────────────────────────────────────────────
  const lv = (C) => f5(C)?.levels;
  num('r5.dist_sup', '5M distance to support (ATR)', 'sr', 5, (C) => capd(lv(C)?.distSup), [0.25, 0.5, 1, 2, 3], { mirror: { id: 'r5.dist_res', fn: 'same' } });
  num('r5.dist_res', '5M distance to resistance (ATR)', 'sr', 5, (C) => capd(lv(C)?.distRes), [0.25, 0.5, 1, 2, 3], { mirror: { id: 'r5.dist_sup', fn: 'same' } });
  num('r5.sup_touches', '5M support touches', 'sr', 5, (C) => (lv(C) ? lv(C).nearestSup?.touches ?? 0 : null), [1, 2, 3, 4], { mirror: { id: 'r5.res_touches', fn: 'same' } });
  num('r5.res_touches', '5M resistance touches', 'sr', 5, (C) => (lv(C) ? lv(C).nearestRes?.touches ?? 0 : null), [1, 2, 3, 4], { mirror: { id: 'r5.sup_touches', fn: 'same' } });
  num('r5.sup_strength', '5M support strength', 'sr', 5, (C) => (lv(C) ? lv(C).nearestSup?.strength ?? 0 : null), [30, 50, 70, 90], { mirror: { id: 'r5.res_strength', fn: 'same' } });
  num('r5.res_strength', '5M resistance strength', 'sr', 5, (C) => (lv(C) ? lv(C).nearestRes?.strength ?? 0 : null), [30, 50, 70, 90], { mirror: { id: 'r5.sup_strength', fn: 'same' } });
  const htfLevel = (C, above) => {
    if (!C.X || !f5(C)?.ready) return null;
    const p = f5(C).price, xs = C.X.levels.filter((l) => l.tf !== OTC.TF.PRIMARY && (above ? l.price > p : l.price < p)).map((l) => Math.abs(l.price - p) / f5(C).atr);
    return xs.length ? Math.min(...xs) : 99;
  };
  num('rH.dist_res', 'distance to 15M/1H resistance (5M ATR)', 'sr', 60, (C) => htfLevel(C, true), [0.25, 0.5, 1, 2, 4], { mirror: { id: 'rH.dist_sup', fn: 'same' } });
  num('rH.dist_sup', 'distance to 15M/1H support (5M ATR)', 'sr', 60, (C) => htfLevel(C, false), [0.25, 0.5, 1, 2, 4], { mirror: { id: 'rH.dist_res', fn: 'same' } });
  const touched = (C, dir) => (C.X && f5(C)?.ready ? !!OTC.Strategies.H.touchedLevel(C.X, U.side(dir), 0.3) : null);
  bool('r.touched_sup', 'touched a support and closed above', 'sr', 5, (C) => touched(C, 'CALL'), { mirror: { id: 'r.touched_res' }, orable: true });
  bool('r.touched_res', 'touched a resistance and closed below', 'sr', 5, (C) => touched(C, 'PUT'), { mirror: { id: 'r.touched_sup' }, orable: true });
  const broke = (C, dir) => (C.X && f5(C)?.ready ? !!OTC.Strategies.H.brokeLevel(C.X, U.side(dir)) : null);
  bool('r.broke_res', 'closed through a 2-touch resistance', 'sr', 5, (C) => broke(C, 'CALL'), { mirror: { id: 'r.broke_sup' } });
  bool('r.broke_sup', 'closed through a 2-touch support', 'sr', 5, (C) => broke(C, 'PUT'), { mirror: { id: 'r.broke_res' } });
  num('r.psych_above', 'distance to round number above (ATR)', 'sr', 5, (C) => fin(lv(C)?.psych.distAbove), [0.25, 0.5, 1], { mirror: { id: 'r.psych_below', fn: 'same' } });
  num('r.psych_below', 'distance to round number below (ATR)', 'sr', 5, (C) => fin(lv(C)?.psych.distBelow), [0.25, 0.5, 1], { mirror: { id: 'r.psych_above', fn: 'same' } });

  // ── TIME ───────────────────────────────────────────────────────────────────
  const hourOf = (C) => new Date(C.time * 1000).getUTCHours();
  cat('time.hour', 'hour (UTC)', 'time', 0, (C) => (C.time ? String(hourOf(C)).padStart(2, '0') : null), Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')), { mirror: { id: 'time.hour', map: {} } });
  cat('time.session', 'session (UTC)', 'time', 0, (C) => (C.time ? OTC.Stats?.session?.(C.time) ?? null : null), ['Asia', 'London', 'London/NY', 'New York', 'Late'], { mirror: { id: 'time.session', map: {} } });
  cat('time.min15', 'quarter of the hour', 'time', 0, (C) => (C.time ? `:${String(Math.floor(new Date(C.time * 1000).getUTCMinutes() / 15) * 15).padStart(2, '0')}` : null), [':00', ':15', ':30', ':45'], { mirror: { id: 'time.min15', map: {} } });
  cat('time.dow', 'day of week (UTC)', 'time', 0, (C) => (C.time ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(C.time * 1000).getUTCDay()] : null), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], { mirror: { id: 'time.dow', map: {} } });
  // candleTime is the decided candle's open time; position counts 5M candles into the larger candle
  cat('time.pos15', 'candle position in its context (mid) candle', 'time', 0, (C) => (C.candleTime != null ? String(Math.floor((C.candleTime % OTC.TF.MID) / OTC.TF.PRIMARY) + 1) : null), null, { mirror: { id: 'time.pos15', map: {} } });
  cat('time.pos60', 'candle position in its macro candle', 'time', 0, (C) => (C.candleTime != null ? `${Math.floor((C.candleTime % OTC.TF.MACRO) / (OTC.TF.MACRO / 4)) + 1}/4` : null), ['1/4', '2/4', '3/4', '4/4'], { mirror: { id: 'time.pos60', map: {} } });

  // ── CONTEXT ────────────────────────────────────────────────────────────────
  const REG_MIRROR = { TRENDING_UP: 'TRENDING_DOWN', TRENDING_DOWN: 'TRENDING_UP' };
  cat('ctx.regime', 'market regime', 'context', 5, (C) => C.X?.regime?.regime ?? null, OTC.REGIMES, { mirror: { id: 'ctx.regime', map: REG_MIRROR } });
  cat('ctx.htf', 'trend agreement across 5M/15M/1H', 'context', 60, (C) => {
    const [a, b, c] = [trendTF(C.f5), trendTF(C.f15), trendTF(C.f60)];
    if (!a || !b || !c) return null;
    if (a === 'UP' && b === 'UP' && c === 'UP') return 'ALL_UP';
    if (a === 'DOWN' && b === 'DOWN' && c === 'DOWN') return 'ALL_DOWN';
    if ((b === 'UP' && c === 'DOWN') || (b === 'DOWN' && c === 'UP')) return 'HTF_CONFLICT';
    if (b === 'UP' || c === 'UP') return b === 'DOWN' || c === 'DOWN' ? 'HTF_CONFLICT' : 'HTF_UP';
    if (b === 'DOWN' || c === 'DOWN') return 'HTF_DOWN';
    return 'HTF_FLAT';
  }, ['ALL_UP', 'ALL_DOWN', 'HTF_UP', 'HTF_DOWN', 'HTF_CONFLICT', 'HTF_FLAT'],
  { mirror: { id: 'ctx.htf', map: { ALL_UP: 'ALL_DOWN', ALL_DOWN: 'ALL_UP', HTF_UP: 'HTF_DOWN', HTF_DOWN: 'HTF_UP' } }, concept: 'trend' });
  num('ctx.scanner', 'scanner score', 'context', 5, (C) => fin(C.scan?.score), [40, 50, 60, 70, 80], { mirror: SAME });
  cat('eng.decision', 'engine decision', 'engine', 5, (C) => C.analysis?.decision ?? null, ['CALL', 'PUT', 'SKIP'], { mirror: sideMirror('eng.decision'), post: true });
  cat('eng.lean', 'engine lean', 'engine', 5, (C) => (C.analysis ? C.analysis.lean || 'none' : null), ['CALL', 'PUT', 'none'], { mirror: sideMirror('eng.lean'), post: true });
  num('eng.deep', 'engine deep score', 'engine', 5, (C) => fin(C.analysis?.confidence), [30, 40, 50, 60, 70, 80], { mirror: SAME, post: true });
  cat('pair', 'pair', 'pair', 0, (C) => C.asset ?? null, null, { mirror: { id: 'pair', map: {} }, maxValues: 60 });

  // Existing library strategies as features (for the combination and variation engines).
  // Added lazily so the library is loaded first; `post` = needs the engine's analysis.
  let stratAdded = false;
  function ensureStrategyFeatures() {
    if (stratAdded || !OTC.Strategies?.list) return;
    stratAdded = true;
    for (const st of OTC.Strategies.list()) {
      if (BY_ID.has(`strat.${st.id}`) || st.family === 'discovered') continue;
      cat(`strat.${st.id}`, `${st.name} fired`, 'strategy', 5, (C) => {
        if (!C.analysis) return null;
        const x = C.analysis.fired?.find((y) => y.strategy === st.id);
        return x ? x.direction : 'none';
      }, ['CALL', 'PUT', 'none'], { mirror: sideMirror(`strat.${st.id}`), post: true, strategy: st.id });
    }
  }

  // ── vectors ────────────────────────────────────────────────────────────────
  // C: { f5, f15, f60, f1, X, scan, analysis, time (decision time), candleTime, asset }
  function context(X, extras = {}) {
    return { f5: X.f5, f15: X.f15, f60: X.f60, f1: X.f1, X, ...extras };
  }
  function vector(C) {
    ensureStrategyFeatures();
    const out = {};
    for (const f of FEATURES) {
      let v = null;
      try { v = f.get(C); } catch (_) { v = null; }
      out[f.id] = v === undefined ? null : v;
    }
    return out;
  }

  // ── atoms ──────────────────────────────────────────────────────────────────
  const fmtNum = (v) => (Number.isInteger(v) ? String(v) : String(+v.toFixed(4)));
  function atomKey(a) {
    if (a.or) return `(${a.or.map(atomKey).sort().join('|')})`;
    if (a.op === 'between') return `${a.f} in [${fmtNum(a.v[0])},${fmtNum(a.v[1])}${a.closedHi ? ']' : ')'}`;
    return `${a.f}${a.op}${typeof a.v === 'number' ? fmtNum(a.v) : String(a.v)}`;
  }
  function test(a, vec) {
    if (a.or) return a.or.some((x) => test(x, vec));
    const v = vec[a.f];
    if (v == null || (typeof v === 'number' && Number.isNaN(v))) return false;
    switch (a.op) {
      case '<=': return v <= a.v;
      case '>=': return v >= a.v;
      case 'between': return v >= a.v[0] && v < a.v[1];
      case '==': return v === a.v;
      case '!=': return v !== a.v;
      default: return false;
    }
  }
  const NICE_OP = { '<=': '≤', '>=': '≥', '==': '=', '!=': '≠' };
  function label(a) {
    if (a.or) return `(${a.or.map(label).join(' OR ')})`;
    const f = BY_ID.get(a.f), name = f ? f.label : a.f;
    if (f?.type === 'bool') return a.v ? name : `NOT ${name}`;
    if (a.op === 'between') return `${name} in ${fmtNum(a.v[0])}…${fmtNum(a.v[1])}`;
    return `${name} ${NICE_OP[a.op] || a.op} ${typeof a.v === 'number' ? fmtNum(a.v) : a.v}`;
  }

  // Equivalent forms collapse to one key: atoms are sorted, ≤/≥ on the same feature
  // merge into a range, and "x != v" on a two-valued feature becomes "x == other".
  function normalize(rule) {
    const merge = (atoms) => {
      const byF = new Map(), rest = [];
      for (const a of atoms) {
        if (!a.or && (a.op === '<=' || a.op === '>=')) {
          const r = byF.get(a.f) || { lo: -Infinity, hi: Infinity };
          if (a.op === '>=') r.lo = Math.max(r.lo, a.v); else r.hi = Math.min(r.hi, a.v);
          byF.set(a.f, r);
        } else if (!a.or && a.op === '!=') {
          const f = BY_ID.get(a.f);
          const others = f?.type === 'bool' ? [!a.v] : f?.values?.filter((x) => x !== a.v);
          rest.push(others && others.length === 1 ? { f: a.f, op: '==', v: others[0] } : a);
        } else rest.push(a);
      }
      for (const [f, r] of byF) {
        if (r.lo > -Infinity && r.hi < Infinity) rest.push({ f, op: 'between', v: [r.lo, r.hi], closedHi: true });
        else rest.push(r.lo > -Infinity ? { f, op: '>=', v: r.lo } : { f, op: '<=', v: r.hi });
      }
      const seen = new Set();
      return rest.filter((a) => { const k = atomKey(a); if (seen.has(k)) return false; seen.add(k); return true; }).sort((x, y) => (atomKey(x) < atomKey(y) ? -1 : 1));
    };
    return { ...rule, all: merge(rule.all || []), none: merge(rule.none || []) };
  }
  // "between" from merged ≤ and ≥ includes the upper bound
  const testN = (a, vec) => (a.op === 'between' && a.closedHi ? (vec[a.f] != null && vec[a.f] >= a.v[0] && vec[a.f] <= a.v[1]) : test(a, vec));

  function ruleKey(rule) {
    const r = normalize(rule);
    return `${r.dir}|E${r.expiry}|${r.all.map(atomKey).join('&')}${r.none.length ? `|NOT ${r.none.map(atomKey).join('&')}` : ''}${r.pairs?.length ? `|pairs=${[...r.pairs].sort().join(',')}` : ''}`;
  }
  function matches(rule, vec, asset = null) {
    if (rule.pairs?.length && asset && !rule.pairs.includes(asset)) return false;
    return rule.all.every((a) => testN(a, vec)) && !(rule.none || []).some((a) => testN(a, vec));
  }

  // CALL ↔ PUT version of an atom, or null if it has no meaningful mirror.
  function mirrorAtom(a) {
    if (a.or) { const xs = a.or.map(mirrorAtom); return xs.every(Boolean) ? { or: xs } : null; }
    const f = BY_ID.get(a.f), m = f?.mirror;
    if (!m) return null;
    const id = m.id || a.f;
    if (f.type === 'bool') return { f: id, op: a.op, v: a.v };
    if (f.type === 'cat') {
      if (m.seq) return { f: id, op: a.op, v: String(a.v).split(',').map((x) => SEQMAP[x] || x).join(',') };
      return { f: id, op: a.op, v: m.map?.[a.v] ?? a.v };
    }
    const flipOp = { '<=': '>=', '>=': '<=' };
    const val = (v) => (m.fn === 'neg' ? -v : m.fn === 'inv100' ? 100 - v : m.fn === 'inv1' ? 1 - v : v);
    if (a.op === 'between') { const [x, y] = [val(a.v[0]), val(a.v[1])].sort((p, q) => p - q); return { f: id, op: 'between', v: [x, y] }; }
    return { f: id, op: m.fn === 'same' ? a.op : flipOp[a.op], v: val(a.v) };
  }
  function mirrorRule(rule) {
    const all = rule.all.map(mirrorAtom), none = (rule.none || []).map(mirrorAtom);
    if (all.some((x) => !x) || none.some((x) => !x)) return null;
    return { ...rule, dir: U.opp(rule.dir), all, none };
  }

  const tfOfAtom = (a) => (a.or ? Math.max(...a.or.map(tfOfAtom)) : BY_ID.get(a.f)?.tf ?? 0);
  const groupOf = (a) => (a.or ? BY_ID.get(a.or[0].f)?.group : BY_ID.get(a.f)?.group);
  // Same concept on several timeframes (e.g. 15M and 1H trend) is one idea, not several:
  // the first counts 1, each further timeframe 0.5. An OR group counts 1.5.
  function complexity(rule) {
    const seen = new Map();
    let c = 0;
    for (const a of [...rule.all, ...(rule.none || [])]) {
      const f = a.or ? null : BY_ID.get(a.f), concept = f?.concept;
      const w = a.or ? 1.5 : 1;
      if (concept) { const k = seen.get(concept) || 0; c += k ? 0.5 : w; seen.set(concept, k + 1); } else c += w;
    }
    return c;
  }

  function name(rule) {
    const parts = rule.all.slice(0, 4).map(label);
    return `${rule.dir} · ${parts.join(' + ')}${rule.all.length > 4 ? ' + …' : ''}${rule.none?.length ? ` · avoid ${rule.none.map(label).join(', ')}` : ''}`;
  }

  OTC.FeatureLib = { FEATURES, BY_ID, get: (id) => BY_ID.get(id), ensureStrategyFeatures, context, vector, test: testN, atomKey, label, normalize, ruleKey,
    matches, mirrorAtom, mirrorRule, complexity, name, tfOfAtom, groupOf, cls, ZONES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
