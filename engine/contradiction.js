// Contradiction Engine. For every candidate direction it asks "what says this
// trade could be wrong?" and returns the evidence AGAINST with a severity.
// `hard` items force SKIP no matter how high the other scores are.
(function (G) {
  const OTC = G.OTC, U = OTC.U, H = OTC.Strategies.H;
  const PENALTY = { low: 4, medium: 8, high: 15 };

  function evaluate(X, dir, confluence, fired, cfg = OTC.DEFAULT_CONFIG) {
    const s = U.side(dir), f = X.f5, out = [];
    const add = (label, severity, hard = false, code = null) => out.push({ label, severity, hard, code });
    const tfName = (tf) => OTC.TF_LABEL[tf] || `${tf}s`;

    // Higher timeframes
    const a15 = H.trendAgainst(X.f15, s), a60 = H.trendAgainst(X.f60, s);
    if (a15 && a60 && (X.f15.trend.strength >= 50 || X.f60.trend.strength >= 50)) add('strong higher-timeframe conflict (15M and 1H against)', 'high', true, 'htf_conflict');
    else {
      if (a60) add('1H trend against', 'medium', false, 'h1_against');
      if (a15) add('15M trend against', 'medium', false, 'm15_against');
    }
    if (!X.f15?.ready || !X.f60?.ready) add('higher-timeframe data missing', cfg.requireHTF ? 'high' : 'medium', cfg.requireHTF, 'data');

    // Opposing levels on any timeframe
    const ahead = (X.levels || []).filter((l) => (s.up ? l.price > f.price : l.price < f.price) && (l.touches >= 2 || l.tf !== OTC.TF.PRIMARY))
      .map((l) => ({ ...l, d: Math.abs(l.price - f.price) / f.atr })).sort((a, b) => a.d - b.d)[0];
    if (ahead && ahead.d < cfg.opposingLevelAtr) add(`strong ${tfName(ahead.tf)} ${s.up ? 'resistance' : 'support'} ${ahead.d.toFixed(2)} ATR ahead`, 'high', true, 'level_close');
    else if (ahead && ahead.d < 1) add(`${tfName(ahead.tf)} ${s.up ? 'resistance' : 'support'} ${ahead.d.toFixed(2)} ATR ahead`, 'medium', false, 'level_near');
    const psychD = s.up ? f.levels.psych.distAbove : f.levels.psych.distBelow;
    if (psychD < 0.3 && psychD > 0) add('round-number level just ahead', 'low', false, 'round');

    // Momentum
    const m = f.momentum;
    if (m.dir === s.opp) add('5M momentum points the other way', 'medium', false, 'momentum_against');
    if (m.weakening[s.up ? 'up' : 'down']) add('momentum weakening', 'low', false, 'momentum_weak');
    if (m.exhaustion[s.up ? 'up' : 'down']) add('move looks exhausted', 'medium', false, 'exhausted');
    if (s.up ? m.rsi > 75 : m.rsi < 25) add(`RSI ${Math.round(m.rsi)} stretched in trade direction`, 'low', false, 'stretched');

    // Entry location / lateness
    if (f.trend.dist.e21 * s.sg > 2) add(`price ${f.trend.dist.e21.toFixed(1)} ATR from EMA21 — entry late`, 'medium', false, 'late');
    if (f.breakout.status && f.breakout.dir === dir && f.breakout.exhausted) add('breakout already extended', 'high', true, 'late');
    if (f.pa.candle.color === (s.up ? 'R' : 'G') && f.pa.candle.bodyAtr >= 0.8) add('last 5M candle strongly against', 'medium', false, 'candle_against');

    // Volatility
    if (f.volatility.abnormal) add(`abnormal candle ${f.volatility.lastRange.toFixed(1)}× ATR`, 'high', true, 'abnormal');
    else if (f.volatility.state === 'HIGH') add('volatility in top 10%', 'medium', false, 'volatility');

    // Other strategies and modules
    const opp = (fired || []).filter((x) => x.active && x.direction === s.opp);
    const mine = (fired || []).filter((x) => x.active && x.direction === dir);
    if (opp.length) {
      const bestOpp = opp[0].confidence, bestMine = mine[0]?.confidence ?? 0;
      if (bestOpp >= bestMine - 10) add(`strategies conflict strongly (${opp[0].name} ${s.opp} ${bestOpp})`, 'high', true, 'conflict');
      else add(`${opp.length} active strateg${opp.length > 1 ? 'ies' : 'y'} point ${s.opp}`, 'medium', false, 'conflict_soft');
    }
    if (confluence) {
      const cl = confluence.clusters[dir];
      if (confluence.direction === s.opp) add('overall confluence points the other way', 'high', false, 'confluence_against');
      else if (cl.oppose.length >= 2) add(`${cl.oppose.length} evidence clusters against (${cl.oppose.join(', ')})`, 'medium', false, 'evidence_against');
      for (const [k, m] of Object.entries(confluence.modules)) {
        if (m.dir !== s.opp) continue;
        if (k === 'signal') add(`platform signal says ${s.opp}`, 'medium', false, 'signal_against');
        else add(`${k}: ${m.reason}`, 'low', false, `module_${k}`);
      }
    }

    // 1M timing (optional; never overrides the decision on its own except as one item)
    if (X.f1?.ready) {
      const c1 = X.f1.pa.candle;
      if (c1.color === (s.up ? 'R' : 'G') && c1.bodyAtr >= 1) add('last 1M candle strongly against', 'medium', false, 'm1_against');
    }

    const penalty = Math.min(40, U.sum(out.map((x) => PENALTY[x.severity])));
    return { against: out, hard: out.filter((x) => x.hard).map((x) => x.label), penalty };
  }

  OTC.Contradiction = { evaluate, PENALTY };
})(typeof globalThis !== 'undefined' ? globalThis : this);
