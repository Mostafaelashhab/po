// Strategy Library. Every entry is a hypothesis, not a known edge: the stats
// engine decides which ones (if any) are worth anything, per regime/pair/expiry.
// To add a strategy, call define() — nothing else in the engine needs to change.
(function (G) {
  const OTC = G.OTC, { define, H } = OTC.Strategies;
  const { R, O, A } = H;
  const TREND = ['TRENDING_UP', 'TRENDING_DOWN'];
  const RANGE = ['RANGING', 'LOW_VOLATILITY'];
  const BRK = ['BREAKOUT', 'TRENDING_UP', 'TRENDING_DOWN', 'LOW_VOLATILITY', 'TRANSITIONING'];
  const REV = ['REVERSAL', 'RANGING'];
  const ANY = ['TRENDING_UP', 'TRENDING_DOWN', 'RANGING', 'BREAKOUT', 'REVERSAL', 'LOW_VOLATILITY'];
  const only = (s, dir) => R(`direction ${dir}`, s.dir === dir);
  const lvlInvalid = (s, X) => [`5M close ${s.up ? 'below' : 'above'} ${(s.up ? X.f5.last.low : X.f5.last.high).toFixed(5)}`];
  // Common contradictions most strategies share.
  const common = (s, X) => [
    A('1H and 15M trend against', H.htfAgainst(X, s), 'high'),
    A('opposing level < 0.5 ATR', H.opposingDist(X, s) < 0.5, 'high'),
    A('momentum exhausted in trade direction', H.exhausted(X.f5, s)),
  ];
  const def = (d) => define({ against: common, invalidation: lvlInvalid, ...d });

  // ── TREND ──────────────────────────────────────────────────────────────────
  def({ id: 'trend_following', name: 'Trend Following', family: 'trend', regimes: TREND,
    conditions: (s, X) => [R('5M trend with', H.trendWith(X.f5, s)), R('EMA 9/21/50 ordered', H.orderWith(X.f5, s)),
      O('15M trend with', H.trendWith(X.f15, s)), O('momentum with', H.momWith(X.f5, s)), O('candle with', H.candleWith(X.f5, s)),
      O('room ≥ 1 ATR', H.roomAhead(X, s, 1))] });
  def({ id: 'trend_continuation', name: 'Trend Continuation', family: 'trend', regimes: TREND,
    conditions: (s, X) => [R('structure with', H.structWith(X.f5, s)), R('5M trend with', H.trendWith(X.f5, s)),
      R('closed beyond previous candle', H.closedBeyondPrev(X.f5, s)), O('momentum accelerating', X.f5.momentum.accel && H.momWith(X.f5, s)),
      O('room ≥ 1 ATR', H.roomAhead(X, s, 1))] });
  def({ id: 'trend_pullback', name: 'Trend Pullback', family: 'trend', regimes: TREND,
    conditions: (s, X) => [R('5M trend with', H.trendWith(X.f5, s)), R('pulled back to EMA9', H.pulledBackTo(X.f5, s, 'e9', 0.2, 4)),
      R('resumed: candle with', H.candleWith(X.f5, s)), O('reversal pattern', H.anyPattern(X.f5, s)),
      O('RSI healthy', s.up ? H.rsiIn(X.f5, 40, 65) : H.rsiIn(X.f5, 35, 60)), O('15M trend with', H.trendWith(X.f15, s))] });
  def({ id: 'ema_pullback', name: 'EMA Pullback', family: 'trend', regimes: TREND,
    conditions: (s, X) => [R('EMA order with', H.orderWith(X.f5, s)), R('touched EMA21 and held', H.pulledBackTo(X.f5, s, 'e21', 0.3, 3)),
      R('candle with', H.candleWith(X.f5, s)), O('EMA21 slope', X.f5.trend.slope21 * s.sg > 0.05), O('pattern', H.anyPattern(X.f5, s))] });
  // Keltner trend pullback (2026-10-04): price held 5 candles in one half of the Keltner channel (EMA 20 ± 2 ATR 10),
  // then a candle touched the middle line and closed back on the trend side → with the trend. The one rule from 30+
  // YouTube strategies that stayed above break-even on 10M / shifted-10M / 15M views of the user's data (30-minute
  // trades: 57.6% of 177, 56.5%, 56.2%) — not proven: one of ~60 rules tested on the same 3 days. Measured live like
  // every other strategy; it trades only if its own record proves it.
  def({ id: 'keltner_trend_pullback', name: 'Keltner Trend Pullback', family: 'trend', regimes: ANY, against: () => [], frame: 600, expirySec: 1800,
    conditions: (s, X) => {
      const k = X.f5?.keltner, c = H.recent(X.f5, 6);
      if (!k || c.length < 6) return [R('Keltner channel ready', false)];
      const half = [0, 1, 2, 3, 4].every((j) => (s.up ? c[j].close > k.mid[j] && c[j].close <= k.up[j] : c[j].close < k.mid[j] && c[j].close >= k.lo[j]));
      const x = c[5], touch = s.up ? x.low <= k.mid[5] && x.close > k.mid[5] : x.high >= k.mid[5] && x.close < k.mid[5];
      return [R('5 candles in the trend half of the Keltner channel', half), R('touched the middle line and closed back', touch)];
    } });
  def({ id: 'ma_alignment', name: 'Moving Average Alignment', family: 'trend', regimes: TREND,
    conditions: (s, X) => [R('EMA 9/21/50 ordered', H.orderWith(X.f5, s)), R('price beyond EMA9', X.f5.trend.dist.e9 * s.sg > 0),
      O('price on EMA200 side', X.f5.trend.dist.e200 == null || X.f5.trend.dist.e200 * s.sg > 0), O('EMA50 slope', X.f5.trend.slope50 * s.sg > 0.02),
      O('15M EMA order with', H.orderWith(X.f15, s))] });
  def({ id: 'momentum_continuation', name: 'Momentum Continuation', family: 'trend', regimes: TREND,
    conditions: (s, X) => [R('5M trend with', H.trendWith(X.f5, s)), R('momentum with ≥ 50', H.momWith(X.f5, s) && X.f5.momentum.strength >= 50),
      R('accelerating', X.f5.momentum.accel), O('not exhausted', !H.exhausted(X.f5, s)), O('room ≥ 1 ATR', H.roomAhead(X, s, 1))] });
  def({ id: 'htf_trend_continuation', name: 'Higher-Timeframe Trend Continuation', family: 'trend', regimes: TREND,
    conditions: (s, X) => [R('1H trend with', H.trendWith(X.f60, s)), R('15M trend with', H.trendWith(X.f15, s)),
      R('5M candle with', H.candleWith(X.f5, s)), O('5M RSI turning with', H.rsiRising(X.f5, s)), O('5M structure with', H.structWith(X.f5, s)),
      O('room ≥ 1 ATR', H.roomAhead(X, s, 1))] });

  // ── BREAKOUT ───────────────────────────────────────────────────────────────
  const brk = (X, s, statuses, maxAgo = 1) => { const b = X.f5.breakout; return b.status && statuses.includes(b.status) && b.dir === s.dir && b.ago <= maxAgo; };
  const brkAgainst = (s, X) => [...common(s, X), A('breakout exhausted', X.f5.breakout.exhausted, 'high')];
  def({ id: 'range_breakout', name: 'Range Breakout', family: 'breakout', regimes: BRK, against: brkAgainst,
    conditions: (s, X) => [R('real breakout', brk(X, s, ['REAL_BREAKOUT'])), R('came out of a range ≤ 6 ATR', X.f5.breakout.rangeAtr <= 6),
      O('bands expanding', X.f5.bb.expansion), O('momentum with', H.momWith(X.f5, s)), O('15M not against', !H.trendAgainst(X.f15, s))] });
  def({ id: 'resistance_breakout', name: 'Resistance Breakout', family: 'breakout', regimes: BRK, against: brkAgainst,
    conditions: (s, X) => [only(s, 'CALL'), R('closed through 2-touch resistance', H.brokeLevel(X, s)),
      O('strong body', X.f5.pa.candle.bodyRatio >= 0.6), O('momentum with', H.momWith(X.f5, s))] });
  def({ id: 'support_breakout', name: 'Support Breakout', family: 'breakout', regimes: BRK, against: brkAgainst,
    conditions: (s, X) => [only(s, 'PUT'), R('closed through 2-touch support', H.brokeLevel(X, s)),
      O('strong body', X.f5.pa.candle.bodyRatio >= 0.6), O('momentum with', H.momWith(X.f5, s))] });
  def({ id: 'trendline_breakout', name: 'Trendline Breakout', family: 'breakout', regimes: BRK, against: brkAgainst,
    conditions: (s, X) => [R('trendline broken', X.f5.breakout.trendline?.dir === s.dir && X.f5.breakout.trendline.ago <= 1),
      R('candle with, body ≥ 0.5 ATR', H.candleWith(X.f5, s) && X.f5.pa.candle.bodyAtr >= 0.5),
      O('momentum with', H.momWith(X.f5, s)), O('15M not against', !H.trendAgainst(X.f15, s))] });
  def({ id: 'breakout_retest', name: 'Breakout Retest', family: 'breakout', regimes: BRK, against: brkAgainst,
    conditions: (s, X) => [R('breakout retested and held', brk(X, s, ['BREAKOUT_RETEST'], 3)), R('candle with', H.candleWith(X.f5, s)),
      O('momentum with', H.momWith(X.f5, s)), O('room ≥ 1 ATR', H.roomAhead(X, s, 1))] });
  def({ id: 'compression_breakout', name: 'Compression Breakout', family: 'breakout', regimes: BRK, against: brkAgainst,
    conditions: (s, X) => [R('real breakout', brk(X, s, ['REAL_BREAKOUT'])), R('tight range ≤ 3.5 ATR', X.f5.breakout.rangeAtr <= 3.5),
      O('squeeze before', X.f5.bb.squeezeRecent), O('bands expanding', X.f5.bb.expansion), O('strong body', H.pattern(X.f5, s, 'strong_body'))] });
  def({ id: 'momentum_breakout', name: 'Momentum Breakout', family: 'breakout', regimes: BRK, against: brkAgainst,
    conditions: (s, X) => [R('real breakout', brk(X, s, ['REAL_BREAKOUT'])), R('momentum with ≥ 60', H.momWith(X.f5, s) && X.f5.momentum.strength >= 60),
      R('accelerating', X.f5.momentum.accel), O('HTF with', H.htfWith(X, s))] });

  // ── REVERSAL ───────────────────────────────────────────────────────────────
  const revAgainst = (s, X) => [...common(s, X).slice(0, 2), A('strong trend against (ADX ≥ 30)', H.strongTrendAgainst(X.f5, s))];
  const rdef = (d) => def({ against: revAgainst, ...d });
  rdef({ id: 'support_reversal', name: 'Support Reversal', family: 'reversal', regimes: REV,
    conditions: (s, X) => [only(s, 'CALL'), R('touched support and closed above', H.touchedLevel(X, s, 0.3, 2)),
      R('bullish candle or pattern', H.candleWith(X.f5, s) || H.anyPattern(X.f5, s)), O('RSI < 45', H.rsiIn(X.f5, 0, 45)),
      O('momentum recovering', X.f5.momentum.recovering.up)] });
  rdef({ id: 'resistance_reversal', name: 'Resistance Reversal', family: 'reversal', regimes: REV,
    conditions: (s, X) => [only(s, 'PUT'), R('touched resistance and closed below', H.touchedLevel(X, s, 0.3, 2)),
      R('bearish candle or pattern', H.candleWith(X.f5, s) || H.anyPattern(X.f5, s)), O('RSI > 55', H.rsiIn(X.f5, 55, 100)),
      O('momentum rolling over', X.f5.momentum.recovering.down)] });
  rdef({ id: 'exhaustion_reversal', name: 'Exhaustion Reversal', family: 'reversal', regimes: REV,
    conditions: (s, X) => [R('opposite move exhausted', H.exhaustedAgainst(X.f5, s)), R('reversal pattern', H.anyPattern(X.f5, s)),
      O('RSI extreme', s.up ? H.rsiIn(X.f5, 0, 30) : H.rsiIn(X.f5, 70, 100)), O('at a level', H.touchedLevel(X, s, 0.4))] });
  rdef({ id: 'rsi_divergence', name: 'RSI Divergence', family: 'reversal', regimes: REV,
    conditions: (s, X) => [R('RSI regular divergence', X.f5.divergence.rsi?.dir === s.dir), R('candle with', H.candleWith(X.f5, s)),
      O('at a level', H.touchedLevel(X, s, 0.5)), O('structure event', X.f5.structure.sfp?.dir === s.dir || X.f5.structure.choch?.dir === s.dir)] });
  rdef({ id: 'macd_divergence', name: 'MACD Divergence', family: 'reversal', regimes: REV,
    conditions: (s, X) => [R('MACD regular divergence', X.f5.divergence.macd?.dir === s.dir), R('candle with', H.candleWith(X.f5, s)),
      O('histogram turning', H.macdWith(X.f5, s)), O('at a level', H.touchedLevel(X, s, 0.5))] });
  rdef({ id: 'liquidity_sweep_reversal', name: 'Liquidity Sweep Reversal', family: 'liquidity', regimes: ['REVERSAL', 'RANGING', 'TRENDING_UP', 'TRENDING_DOWN'],
    conditions: (s, X) => [R('liquidity swept', X.f5.liquidity.sweep?.dir === s.dir), R('confirmed rejection', X.f5.liquidity.sweep?.confirmed),
      O('wick ≥ 40%', (X.f5.liquidity.sweep?.wick ?? 0) >= 0.4), O('at a level', H.touchedLevel(X, s, 0.5)),
      O('divergence', X.f5.divergence.rsi?.dir === s.dir || X.f5.divergence.macd?.dir === s.dir)] });
  rdef({ id: 'failed_breakout_reversal', name: 'Failed Breakout Reversal', family: 'reversal', regimes: REV,
    conditions: (s, X) => [R('breakout failed the other way', X.f5.breakout.status === 'FALSE_BREAKOUT' && X.f5.breakout.dir === s.opp),
      R('candle with', H.candleWith(X.f5, s)), O('back inside by ≥ 0.2 ATR', X.f5.breakout.level != null && (X.f5.price - X.f5.breakout.level) * s.sg >= 0.2 * X.f5.atr),
      O('momentum with', H.momWith(X.f5, s))] });
  rdef({ id: 'choch_reversal', name: 'CHOCH Reversal', family: 'reversal', regimes: ['REVERSAL', 'TRANSITIONING', 'RANGING'], tags: ['structure'],
    conditions: (s, X) => [R('change of character', X.f5.structure.choch?.dir === s.dir && X.f5.structure.choch.ago <= 3), R('candle with', H.candleWith(X.f5, s)),
      O('prior exhaustion or divergence', H.exhaustedAgainst(X.f5, s) || X.f5.divergence.rsi?.dir === s.dir), O('HTF not against', !H.htfAgainst(X, s))] });

  // ── RANGE ──────────────────────────────────────────────────────────────────
  const rangeAgainst = (s, X) => [...common(s, X).slice(0, 2), A('market is trending (ADX ≥ 25)', !H.adxBelow(X.f5, 25), 'high')];
  const gdef = (d) => def({ against: rangeAgainst, ...d });
  gdef({ id: 'range_bounce', name: 'Range Bounce', family: 'range', regimes: RANGE,
    conditions: (s, X) => [R('flat trend', X.f5.trend.dir === 'FLAT'), R('at range edge', s.up ? X.f5.bb.pctB <= 0.15 : X.f5.bb.pctB >= 0.85),
      R('candle with', H.candleWith(X.f5, s)), O('rejection wick', s.up ? X.f5.pa.candle.lowerWick >= 0.3 : X.f5.pa.candle.upperWick >= 0.3),
      O('RSI stretched', s.up ? H.rsiIn(X.f5, 0, 40) : H.rsiIn(X.f5, 60, 100))] });
  gdef({ id: 'support_bounce', name: 'Support Bounce', family: 'range', regimes: RANGE,
    conditions: (s, X) => [only(s, 'CALL'), R('touched support', H.touchedLevel(X, s, 0.3)), R('candle with', H.candleWith(X.f5, s)),
      O('pattern', H.anyPattern(X.f5, s)), O('RSI < 45', H.rsiIn(X.f5, 0, 45))] });
  gdef({ id: 'resistance_rejection', name: 'Resistance Rejection', family: 'range', regimes: RANGE,
    conditions: (s, X) => [only(s, 'PUT'), R('touched resistance', H.touchedLevel(X, s, 0.3)), R('candle with', H.candleWith(X.f5, s)),
      O('pattern', H.anyPattern(X.f5, s)), O('RSI > 55', H.rsiIn(X.f5, 55, 100))] });
  gdef({ id: 'mean_reversion', name: 'Mean Reversion', family: 'range', regimes: RANGE,
    conditions: (s, X) => [R('stretched ≥ 1.5 ATR from EMA21', X.f5.trend.dist.e21 * -s.sg >= 1.5), R('turning: candle with', H.candleWith(X.f5, s)),
      R('ADX < 25', H.adxBelow(X.f5, 25)), O('RSI extreme', s.up ? H.rsiIn(X.f5, 0, 35) : H.rsiIn(X.f5, 65, 100)),
      O('band touched', s.up ? X.f5.bb.touchLower : X.f5.bb.touchUpper)] });
  gdef({ id: 'range_liquidity_sweep', name: 'Range Liquidity Sweep', family: 'liquidity', regimes: RANGE,
    conditions: (s, X) => [R('liquidity swept', X.f5.liquidity.sweep?.dir === s.dir), R('ranging', H.adxBelow(X.f5, 22) || X.f5.structure.trend === 'RANGE'),
      O('confirmed', X.f5.liquidity.sweep?.confirmed), O('at a level', H.touchedLevel(X, s, 0.5))] });

  // ── PRICE ACTION (pattern + location; never the pattern alone) ─────────────
  const location = (X, s) => !!H.touchedLevel(X, s, 0.4) || (s.up ? X.f5.bb.touchLower : X.f5.bb.touchUpper)
    || (H.trendWith(X.f5, s) && H.pulledBackTo(X.f5, s, 'e21', 0.4, 3));
  const pa = (id, name, pattern, dirs, extra = () => []) => def({ id, name, family: 'priceaction', regimes: ANY,
    conditions: (s, X) => [R('direction', dirs.includes(s.dir)), R(`${name} pattern`, H.pattern(X.f5, s, pattern)),
      R('at a level, band or trend pullback', location(X, s)), O('HTF not against', !H.htfAgainst(X, s)), ...extra(s, X)] });
  pa('bullish_engulfing', 'Bullish Engulfing', 'bullish_engulfing', ['CALL'], (s, X) => [O('RSI < 60', H.rsiIn(X.f5, 0, 60))]);
  pa('bearish_engulfing', 'Bearish Engulfing', 'bearish_engulfing', ['PUT'], (s, X) => [O('RSI > 40', H.rsiIn(X.f5, 40, 100))]);
  pa('pin_bar', 'Pin Bar', 'pin_bar', ['CALL', 'PUT'], (s, X) => [O('trend not strongly against', !H.strongTrendAgainst(X.f5, s))]);
  pa('hammer', 'Hammer', 'hammer', ['CALL'], (s, X) => [O('RSI < 45', H.rsiIn(X.f5, 0, 45))]);
  pa('shooting_star', 'Shooting Star', 'shooting_star', ['PUT'], (s, X) => [O('RSI > 55', H.rsiIn(X.f5, 55, 100))]);
  pa('doji_rejection', 'Doji Rejection', 'doji_rejection', ['CALL', 'PUT']);
  pa('outside_bar', 'Outside Bar', 'outside_bar', ['CALL', 'PUT'], (s, X) => [O('closed near extreme', s.up ? X.f5.pa.candle.closePos >= 0.8 : X.f5.pa.candle.closePos <= 0.2)]);
  pa('morning_star', 'Morning Star', 'morning_star', ['CALL']);
  pa('evening_star', 'Evening Star', 'evening_star', ['PUT']);
  pa('tweezer_bottom', 'Tweezer Bottom', 'tweezer_bottom', ['CALL']);
  pa('tweezer_top', 'Tweezer Top', 'tweezer_top', ['PUT']);
  pa('long_wick_rejection', 'Long-Wick Rejection', 'long_wick_rejection', ['CALL', 'PUT'], (s, X) => [O('RSI stretched', s.up ? H.rsiIn(X.f5, 0, 45) : H.rsiIn(X.f5, 55, 100))]);
  def({ id: 'inside_bar_break', name: 'Inside Bar', family: 'priceaction', regimes: ANY,
    conditions: (s, X) => [R('inside bar broken', H.insideBreak(X.f5, s)), R('5M trend with', H.trendWith(X.f5, s)), O('momentum with', H.momWith(X.f5, s))] });
  def({ id: 'strong_body_continuation', name: 'Strong Body Continuation', family: 'priceaction', regimes: TREND,
    conditions: (s, X) => [R('strong body candle', H.pattern(X.f5, s, 'strong_body')), R('5M trend with', H.trendWith(X.f5, s)),
      O('room ≥ 1 ATR', H.roomAhead(X, s, 1)), O('15M with', H.trendWith(X.f15, s))] });

  // ── STRUCTURE ──────────────────────────────────────────────────────────────
  def({ id: 'bos_continuation', name: 'BOS Continuation', family: 'structure', regimes: [...TREND, 'BREAKOUT'],
    conditions: (s, X) => [R('break of structure', X.f5.structure.bos?.dir === s.dir && X.f5.structure.bos.ago <= 2), R('5M trend with', H.trendWith(X.f5, s)),
      O('momentum with', H.momWith(X.f5, s)), O('room ≥ 1 ATR', H.roomAhead(X, s, 1))] });
  def({ id: 'bos_retest', name: 'BOS Retest', family: 'structure', regimes: [...TREND, 'BREAKOUT'],
    conditions: (s, X) => {
      const b = X.f5.structure.bos, c = H.recent(X.f5, 2);
      const retest = b?.dir === s.dir && b.ago >= 2 && b.ago <= 8 && c.some((x) => (s.up ? x.low <= b.level + 0.3 * X.f5.atr && x.close > b.level : x.high >= b.level - 0.3 * X.f5.atr && x.close < b.level));
      return [R('BOS level retested and held', retest), R('candle with', H.candleWith(X.f5, s)), O('momentum with', H.momWith(X.f5, s))];
    } });
  def({ id: 'hh_hl_continuation', name: 'Higher High / Higher Low Continuation', family: 'structure', regimes: TREND,
    conditions: (s, X) => [only(s, 'CALL'), R('HH + HL', X.f5.structure.hhhl), R('candle with', H.candleWith(X.f5, s)), O('5M trend with', H.trendWith(X.f5, s))] });
  def({ id: 'lh_ll_continuation', name: 'Lower High / Lower Low Continuation', family: 'structure', regimes: TREND,
    conditions: (s, X) => [only(s, 'PUT'), R('LH + LL', X.f5.structure.lhll), R('candle with', H.candleWith(X.f5, s)), O('5M trend with', H.trendWith(X.f5, s))] });
  rdef({ id: 'swing_failure', name: 'Swing Failure', family: 'structure', regimes: [...REV, 'TRANSITIONING'],
    conditions: (s, X) => [R('swing failure', X.f5.structure.sfp?.dir === s.dir), R('candle with', H.candleWith(X.f5, s)), O('at a level', H.touchedLevel(X, s, 0.4))] });
  rdef({ id: 'liquidity_sweep', name: 'Liquidity Sweep (equal highs/lows)', family: 'liquidity', regimes: [...REV, 'TRANSITIONING'],
    conditions: (s, X) => [R('liquidity swept', X.f5.liquidity.sweep?.dir === s.dir), R('equal highs/lows taken', X.f5.liquidity.sweep?.equal),
      O('confirmed', X.f5.liquidity.sweep?.confirmed)] });

  // ── INDICATOR CONFLUENCE ───────────────────────────────────────────────────
  def({ id: 'ema_rsi', name: 'EMA + RSI', family: 'confluence', regimes: TREND,
    conditions: (s, X) => [R('EMA order with', H.orderWith(X.f5, s)), R('RSI on trend side, rising', (s.up ? H.rsiIn(X.f5, 50, 70) : H.rsiIn(X.f5, 30, 50)) && H.rsiRising(X.f5, s)),
      R('price beyond EMA21', X.f5.trend.dist.e21 * s.sg > 0), O('recent pullback', H.pulledBackTo(X.f5, s, 'e21', 0.5, 5))] });
  def({ id: 'ema_macd', name: 'EMA + MACD', family: 'confluence', regimes: TREND,
    conditions: (s, X) => [R('EMA order with', H.orderWith(X.f5, s)), R('MACD flip or growing with', X.f5.momentum.macd.flip === s.dir || H.macdWith(X.f5, s)),
      O('price beyond EMA21', X.f5.trend.dist.e21 * s.sg > 0)] });
  def({ id: 'ema_bollinger', name: 'EMA + Bollinger', family: 'confluence', regimes: TREND,
    conditions: (s, X) => [R('5M trend with', H.trendWith(X.f5, s)), R('crossed back over middle band', X.f5.bb.crossedMid === s.dir),
      O('momentum with', H.momWith(X.f5, s))] });
  def({ id: 'rsi_sr', name: 'RSI + Support/Resistance', family: 'confluence', regimes: [...RANGE, 'REVERSAL'],
    conditions: (s, X) => [R('at a level', H.touchedLevel(X, s, 0.3)), R('RSI stretched and turning', (s.up ? H.rsiIn(X.f5, 0, 40) : H.rsiIn(X.f5, 60, 100)) && H.rsiRising(X.f5, s)),
      O('pattern', H.anyPattern(X.f5, s))] });
  def({ id: 'macd_structure', name: 'MACD + Structure', family: 'confluence', regimes: [...TREND, 'REVERSAL', 'BREAKOUT'],
    conditions: (s, X) => [R('MACD flip', X.f5.momentum.macd.flip === s.dir),
      R('structure with or fresh BOS/CHOCH', H.structWith(X.f5, s) || [X.f5.structure.bos, X.f5.structure.choch].some((e) => e?.dir === s.dir && e.ago <= 3))] });
  def({ id: 'fib_structure', name: 'Fibonacci + Structure', family: 'fibonacci', regimes: TREND,
    conditions: (s, X) => [R('retraced 38–79%', H.fibZone(X.f5, s, 0.382, 0.786)), R('structure with', H.structWith(X.f5, s)), R('candle with', H.candleWith(X.f5, s))] });
  def({ id: 'bollinger_pa', name: 'Bollinger + Price Action', family: 'bollinger', regimes: [...RANGE, 'REVERSAL'],
    conditions: (s, X) => [R('band touched', s.up ? X.f5.bb.touchLower : X.f5.bb.touchUpper), R('reversal pattern', H.anyPattern(X.f5, s)),
      O('RSI stretched', s.up ? H.rsiIn(X.f5, 0, 40) : H.rsiIn(X.f5, 60, 100))] });
  rdef({ id: 'rsi_div_structure', name: 'RSI + Divergence + Structure', family: 'confluence', regimes: REV,
    conditions: (s, X) => [R('RSI divergence', X.f5.divergence.rsi?.dir === s.dir),
      R('structure event (SFP/CHOCH/sweep)', X.f5.structure.sfp?.dir === s.dir || X.f5.structure.choch?.dir === s.dir || X.f5.liquidity.sweep?.dir === s.dir),
      R('candle with', H.candleWith(X.f5, s))] });
  def({ id: 'ema_fib_pa', name: 'EMA + Fibonacci + Price Action', family: 'confluence', regimes: TREND,
    conditions: (s, X) => [R('EMA order with', H.orderWith(X.f5, s)), R('retraced 38–62%', H.fibZone(X.f5, s, 0.382, 0.618)), R('pattern', H.anyPattern(X.f5, s))] });

  // ── FIBONACCI ──────────────────────────────────────────────────────────────
  for (const r of [0.382, 0.5, 0.618, 0.786]) {
    def({ id: `fib_${Math.round(r * 1000)}`, name: `${(r * 100).toFixed(1).replace('.0', '')} Retracement`, family: 'fibonacci', regimes: [...TREND, 'RANGING'],
      conditions: (s, X) => [R(`pullback reached ${(r * 100).toFixed(1)}%`, H.fibNear(X.f5, s, r)), R('resumed: candle with', H.candleWith(X.f5, s)),
        O('5M trend with', H.trendWith(X.f5, s)), O('pattern', H.anyPattern(X.f5, s))] });
  }
  def({ id: 'fib_support', name: 'Fibonacci + Support', family: 'fibonacci', regimes: [...TREND, 'RANGING'],
    conditions: (s, X) => [only(s, 'CALL'), R('fib level on a 2-touch support', H.fibAtLevel(X, s)), R('touched it and closed above', H.touchedLevel(X, s, 0.3, 2)),
      O('candle with', H.candleWith(X.f5, s))] });
  def({ id: 'fib_resistance', name: 'Fibonacci + Resistance', family: 'fibonacci', regimes: [...TREND, 'RANGING'],
    conditions: (s, X) => [only(s, 'PUT'), R('fib level on a 2-touch resistance', H.fibAtLevel(X, s)), R('touched it and closed below', H.touchedLevel(X, s, 0.3, 2)),
      O('candle with', H.candleWith(X.f5, s))] });
  def({ id: 'fib_trend_pullback', name: 'Fibonacci + Trend Pullback', family: 'fibonacci', regimes: TREND,
    conditions: (s, X) => [R('5M and 15M trend with', H.trendWith(X.f5, s) && H.trendWith(X.f15, s)), R('retraced 38–62%', H.fibZone(X.f5, s, 0.382, 0.618)),
      R('candle with', H.candleWith(X.f5, s)), O('momentum recovering', X.f5.momentum.recovering[s.up ? 'up' : 'down'])] });

  // ── BOLLINGER ──────────────────────────────────────────────────────────────
  def({ id: 'bb_band_rejection', name: 'Band Rejection', family: 'bollinger', regimes: [...RANGE, 'REVERSAL'], against: rangeAgainst,
    conditions: (s, X) => [R('band rejected', s.up ? X.f5.bb.rejectLower : X.f5.bb.rejectUpper), R('bands not expanding', !X.f5.bb.expansion),
      O('RSI stretched', s.up ? H.rsiIn(X.f5, 0, 35) : H.rsiIn(X.f5, 65, 100))] });
  def({ id: 'bb_band_breakout', name: 'Band Breakout', family: 'bollinger', regimes: BRK, against: brkAgainst,
    conditions: (s, X) => [R('closed outside band with body', s.up ? X.f5.bb.breakUpper : X.f5.bb.breakLower), R('bands expanding', X.f5.bb.expansion),
      O('momentum with', H.momWith(X.f5, s))] });
  def({ id: 'bb_squeeze', name: 'Bollinger Squeeze', family: 'bollinger', regimes: BRK, against: brkAgainst,
    conditions: (s, X) => [R('squeeze in last 6 bars', X.f5.bb.squeezeRecent), R('broke out of the squeeze', s.up ? X.f5.bb.breakUpper || X.f5.bb.pctB > 0.9 : X.f5.bb.breakLower || X.f5.bb.pctB < 0.1),
      R('candle with', H.candleWith(X.f5, s))] });
  def({ id: 'bb_expansion', name: 'Band Expansion', family: 'bollinger', regimes: BRK, against: brkAgainst,
    conditions: (s, X) => [R('bands expanding', X.f5.bb.expansion), R('strong candle with', H.pattern(X.f5, s, 'strong_body')), R('5M trend with', H.trendWith(X.f5, s))] });
  def({ id: 'bb_mean_reversion', name: 'Bollinger Mean Reversion', family: 'bollinger', regimes: RANGE, against: rangeAgainst,
    conditions: (s, X) => [R('band rejected', s.up ? X.f5.bb.rejectLower : X.f5.bb.rejectUpper), R('ADX < 25', H.adxBelow(X.f5, 25)),
      O('RSI < 35 / > 65', s.up ? H.rsiIn(X.f5, 0, 35) : H.rsiIn(X.f5, 65, 100)), O('pattern', H.anyPattern(X.f5, s))] });
  def({ id: 'bb_trend_continuation', name: 'Bollinger Trend Continuation', family: 'bollinger', regimes: TREND,
    conditions: (s, X) => {
      const f = X.f5, c = H.recent(f, 2);
      const touchedMid = c.some((x) => (s.up ? x.low <= f.bb.mid + 0.2 * f.atr : x.high >= f.bb.mid - 0.2 * f.atr));
      return [R('5M trend with', H.trendWith(f, s)), R('pulled back to middle band, held', touchedMid && (f.price - f.bb.mid) * s.sg > 0), R('candle with', H.candleWith(f, s))];
    } });

  // ── MOMENTUM ───────────────────────────────────────────────────────────────
  def({ id: 'rsi_momentum', name: 'RSI Momentum', family: 'momentum', regimes: [...TREND, 'BREAKOUT'],
    conditions: (s, X) => {
      const m = X.f5.momentum;
      return [R('RSI crossed 50', m.rsiPrev != null && (s.up ? m.rsiPrev < 50 && m.rsi >= 50 : m.rsiPrev > 50 && m.rsi <= 50)),
        R('trend not against', !H.trendAgainst(X.f5, s)), O('MACD with', H.macdWith(X.f5, s))];
    } });
  def({ id: 'macd_momentum', name: 'MACD Momentum', family: 'momentum', regimes: [...TREND, 'BREAKOUT'],
    conditions: (s, X) => [R('MACD histogram flip', X.f5.momentum.macd.flip === s.dir), R('price beyond EMA21', X.f5.trend.dist.e21 * s.sg > 0),
      O('RSI side', s.up ? H.rsiIn(X.f5, 50, 70) : H.rsiIn(X.f5, 30, 50))] });
  def({ id: 'stoch_momentum', name: 'Stochastic Momentum', family: 'momentum', regimes: [...TREND, 'RANGING'],
    conditions: (s, X) => [R('%K/%D cross', X.f5.momentum.stoch.cross === s.dir), R('5M trend with', H.trendWith(X.f5, s)),
      O('not overbought/oversold against', s.up ? X.f5.momentum.stoch.k < 80 : X.f5.momentum.stoch.k > 20)] });
  def({ id: 'roc_momentum', name: 'ROC Momentum', family: 'momentum', regimes: [...TREND, 'BREAKOUT'],
    conditions: (s, X) => {
      const m = X.f5.momentum;
      return [R('ROC crossed 0', m.rocPrev != null && (s.up ? m.rocPrev <= 0 && m.roc > 0 : m.rocPrev >= 0 && m.roc < 0)), R('5M trend with', H.trendWith(X.f5, s)),
        O('candle with', H.candleWith(X.f5, s))];
    } });
  def({ id: 'candle_momentum', name: 'Candle Momentum', family: 'momentum', regimes: [...TREND, 'BREAKOUT'],
    conditions: (s, X) => [R('3-candle push ≥ 1.5 ATR', X.f5.momentum.candleMom * s.sg >= 1.5), R('last candle with', H.candleWith(X.f5, s)),
      O('not exhausted', !H.exhausted(X.f5, s))] });
  def({ id: 'consecutive_candle_momentum', name: 'Consecutive Candle Momentum', family: 'momentum', regimes: TREND,
    conditions: (s, X) => {
      const run = X.f5.momentum.run[s.up ? 'green' : 'red'];
      return [R('3–4 candles in a row', run >= 3 && run <= 4), R('bodies not shrinking', !X.f5.momentum.decel), O('5M trend with', H.trendWith(X.f5, s))];
    } });
  def({ id: 'momentum_acceleration', name: 'Momentum Acceleration', family: 'momentum', regimes: [...TREND, 'BREAKOUT'],
    conditions: (s, X) => [R('candle push accelerating', X.f5.momentum.accel && X.f5.momentum.candleMom * s.sg > 0), R('MACD growing with', H.macdWith(X.f5, s)),
      O('room ≥ 1 ATR', H.roomAhead(X, s, 1))] });
  rdef({ id: 'momentum_exhaustion', name: 'Momentum Exhaustion', family: 'momentum', regimes: REV,
    conditions: (s, X) => [R('opposite move exhausted', H.exhaustedAgainst(X.f5, s)), R('opposite MACD weakening', X.f5.momentum.weakening[s.up ? 'down' : 'up']),
      R('candle with', H.candleWith(X.f5, s))] });
})(typeof globalThis !== 'undefined' ? globalThis : this);
