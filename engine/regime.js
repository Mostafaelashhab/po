// Market Regime Detection. Scores each regime from 5M features (15M/1H as
// context) and picks the strongest. Weak or close calls → UNCLEAR / TRANSITIONING,
// which by default allow no trades.
(function (G) {
  const OTC = G.OTC, { clamp } = OTC.U;

  function classify(f5, f15 = null, f60 = null) {
    if (!f5?.ready) return { regime: 'UNCLEAR', confidence: 0, scores: {}, reasons: ['not enough 5M data'] };
    const t = f5.trend, s = f5.structure, m = f5.momentum, bb = f5.bb, br = f5.breakout, v = f5.volatility;
    const reasons = {};
    const sc = {};
    const note = (k, txt) => (reasons[k] = reasons[k] || []).push(txt);

    // Trending
    for (const [k, dir, sdir] of [['TRENDING_UP', 'UP', 'BULL'], ['TRENDING_DOWN', 'DOWN', 'BEAR']]) {
      let x = 0;
      if (t.dir === dir) { x += 35 + 0.35 * t.strength; note(k, `5M EMA trend ${dir.toLowerCase()} (strength ${Math.round(t.strength)})`); }
      if (s.trend === sdir) { x += 15; note(k, `5M structure ${sdir}`); }
      if (t.adx >= 22) x += 5;
      if (f15?.ready && f15.trend.dir === dir) { x += 10; note(k, `15M trend agrees`); }
      if (f60?.ready && f60.trend.dir === dir) { x += 5; note(k, `1H trend agrees`); }
      sc[k] = x;
    }

    // Ranging
    {
      let x = 0;
      if ((t.adx ?? 99) < 20) { x += 25; note('RANGING', `ADX ${Math.round(t.adx)} < 20`); }
      if (t.er < 0.25) { x += 20; note('RANGING', `efficiency ratio ${t.er.toFixed(2)}`); }
      if (s.trend === 'RANGE') { x += 20; note('RANGING', 'mixed swing structure'); }
      if (Math.abs(t.slope21) < 0.03) { x += 15; note('RANGING', 'EMA21 flat'); }
      if (!bb.expansion) x += 5;
      sc.RANGING = x;
    }

    // Breakout
    {
      let x = 0;
      if ((br.status === 'REAL_BREAKOUT' || br.status === 'BREAKOUT_RETEST') && br.ago <= 3) {
        x += 55; note('BREAKOUT', `${br.status} ${br.dir} ${br.ago} bar(s) ago`);
        if (bb.expansion) { x += 15; note('BREAKOUT', 'bands expanding'); }
        if (br.rangeAtr <= 4) { x += 10; note('BREAKOUT', 'came out of a tight range'); }
      }
      sc.BREAKOUT = x;
    }

    // Reversal
    {
      let x = 0;
      if (s.choch && s.choch.ago <= 5) { x += 40; note('REVERSAL', `CHOCH ${s.choch.dir} ${s.choch.ago} bar(s) ago`); }
      const div = f5.divergence.rsi || f5.divergence.macd;
      if (div) { x += 20; note('REVERSAL', `${f5.divergence.rsi ? 'RSI' : 'MACD'} divergence ${div.dir}`); }
      const sw = f5.liquidity.sweep;
      if ((sw && sw.confirmed) || s.sfp) { x += 20; note('REVERSAL', sw ? `liquidity sweep ${sw.dir}` : `swing failure ${s.sfp.dir}`); }
      if ((t.dir === 'UP' && m.exhaustion.up) || (t.dir === 'DOWN' && m.exhaustion.down)) { x += 15; note('REVERSAL', 'trend exhaustion'); }
      sc.REVERSAL = x;
    }

    // Volatility regimes
    // Extreme = an abnormal candle, or ATR at its 100-bar high AND well above its usual level
    // (a slow drift up in volatility alone is not a reason to stop trading).
    const extreme = v.abnormal || ((v.atrPct ?? 0) >= 97 && (v.atrRatio ?? 0) >= 1.5);
    sc.HIGH_VOLATILITY = extreme ? 90 : (v.atrPct ?? 0) >= 90 && (v.atrRatio ?? 0) >= 1.3 ? 50 : 0;
    if (sc.HIGH_VOLATILITY) note('HIGH_VOLATILITY', v.abnormal ? `abnormal candle ${v.lastRange.toFixed(1)}×ATR` : `ATR ${v.atrRatio.toFixed(1)}× its median (percentile ${Math.round(v.atrPct)})`);
    sc.LOW_VOLATILITY = ((v.atrPct ?? 50) <= 10 ? 45 : 0) + (bb.squeeze ? 25 : 0);
    if (sc.LOW_VOLATILITY) note('LOW_VOLATILITY', `ATR pct ${Math.round(v.atrPct ?? 0)}${bb.squeeze ? ', Bollinger squeeze' : ''}`);

    const ranked = Object.entries(sc).sort((a, b) => b[1] - a[1]);
    const [top, second] = ranked;
    let regime = top[0], confidence = clamp(top[1]);
    // Extreme volatility overrides everything.
    if (sc.HIGH_VOLATILITY >= 90) { regime = 'HIGH_VOLATILITY'; confidence = 90; }
    else if (top[1] < 45) regime = 'UNCLEAR';
    else if (second && second[1] >= 45 && top[1] - second[1] < 8 && conflicting(top[0], second[0])) regime = 'TRANSITIONING';
    return {
      regime, confidence, scores: sc, reasons: reasons[regime] || reasons[top[0]] || [],
      runnerUp: second ? { regime: second[0], score: second[1] } : null,
      volatility: v.state,
    };
  }

  // Two regimes that suggest different playbooks.
  function conflicting(a, b) {
    const groups = [['TRENDING_UP', 'BREAKOUT'], ['TRENDING_DOWN', 'BREAKOUT'], ['LOW_VOLATILITY', 'RANGING']];
    return !groups.some((g) => g.includes(a) && g.includes(b));
  }

  OTC.Regime = { classify };
})(typeof globalThis !== 'undefined' ? globalThis : this);
