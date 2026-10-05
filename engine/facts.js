// Plain facts about one analysis, without numbers or indicator jargon, for the
// user interface. Codes only — the wording lives in ui/ar.js.
(function (G) {
  const OTC = G.OTC, U = OTC.U, H = OTC.Strategies.H;

  // Library strategy → kind of opportunity.
  const SETUP_KIND = {
    trend_pullback: 'pullback', ema_pullback: 'pullback', fib_trend_pullback: 'pullback', bb_trend_continuation: 'pullback', ema_fib_pa: 'pullback',
    fib_382: 'pullback', fib_500: 'pullback', fib_618: 'pullback', fib_786: 'pullback', fib_structure: 'pullback',
    breakout_retest: 'retest', bos_retest: 'retest',
    range_breakout: 'breakout', resistance_breakout: 'breakout', support_breakout: 'breakout', trendline_breakout: 'breakout', compression_breakout: 'breakout',
    momentum_breakout: 'breakout', bb_band_breakout: 'breakout', bb_squeeze: 'breakout', bb_expansion: 'breakout', bos_continuation: 'breakout',
    range_bounce: 'range', support_bounce: 'range', resistance_rejection: 'range', mean_reversion: 'range', range_liquidity_sweep: 'range', bb_mean_reversion: 'range', bb_band_rejection: 'range',
  };
  const FAMILY_KIND = { trend: 'trend', breakout: 'breakout', reversal: 'reversal', liquidity: 'reversal', range: 'range', momentum: 'momentum',
    priceaction: 'pattern', structure: 'trend', confluence: 'trend', fibonacci: 'pullback', bollinger: 'range', discovered: 'discovered' };

  function setupKind(id) {
    if (!id) return null;
    if (/^DISC-/.test(id)) return 'discovered';
    return SETUP_KIND[id] || FAMILY_KIND[OTC.Strategies.get(id)?.family] || 'trend';
  }

  // Why the engine skipped, as codes.
  const SKIP_CODES = [
    [/no keltner_trend_pullback signal/, 'no_keltner'], [/no mode strategy signal/, 'no_youtube'],
    [/learned filter/, 'filter'], [/^risk:/, 'risk'], [/higher-timeframe conflict/, 'htf_conflict'],
    [/missing|stale|candles|frozen|timeframe|duplicat|malformed|far from chart|no price tick|unavailable|data missing|future/, 'data'],
    [/^regime /, 'regime'], [/window missed|chasing|opposite move|not closed yet|timing changed/, 'timing'],
    [/disagree|conflict strongly|point (CALL|PUT)/, 'conflict'], [/resistance|support/, 'level'], [/extended|abnormal/, 'late'],
    [/no active setup|no tradable setup|no setup/, 'no_setup'], [/confidence/, 'weak'], [/scanner/, 'scanner'],
  ];
  const skipCode = (r) => (SKIP_CODES.find(([re]) => re.test(r)) || [null, 'other'])[1];

  function from(X, a, { timing = null } = {}) {
    const f = X.f5;
    const dir = a.decision !== 'SKIP' ? a.decision : a.lean || null;
    const out = {
      decision: a.decision, dir, regime: X.regime?.regime || null,
      conf: a.confidence ?? 0, level: (a.confidence ?? 0) >= 80 ? 'high' : (a.confidence ?? 0) >= 65 ? 'mid' : 'low',
      tf: { 60: X.f60?.ready ? X.f60.trend.dir : null, 15: X.f15?.ready ? X.f15.trend.dir : null, 5: f?.ready ? f.trend.dir : null, 1: X.f1?.ready ? X.f1.trend.dir : null },
      // trend per actual frame (seconds) for the active profile; `tf` above is by role (kept for old records)
      trend: Object.fromEntries([[OTC.TF.MACRO, X.f60], [OTC.TF.MID, X.f15], [OTC.TF.PRIMARY, f], [OTC.TF.TIMING, X.f1]]
        .filter(([t, x]) => t && x?.ready).map(([t, x]) => [t, x.trend.dir])),
      frame: OTC.TF.PRIMARY,
      kind: setupKind(a.setup), setup: a.setup || null,
      skip: [...new Set((a.skipReasons || []).map(skipCode))],
      risks: [], zone: null, momentum: null, pattern: null, align: null, timing: null,
    };
    if (!f?.ready || !dir) return out;
    const s = U.side(dir);
    out.zone = H.touchedLevel(X, s, 0.4) ? 'level' : (s.up ? f.bb.pctB <= 0.15 : f.bb.pctB >= 0.85) ? 'band'
      : H.fibZone(f, s, 0.382, 0.786) ? 'fib' : H.opposingDist(X, s) < 1 ? 'opposing' : 'open';
    out.momentum = f.momentum.dir === dir ? 'with' : f.momentum.dir === 'NEUTRAL' ? 'weak' : 'against';
    out.pattern = f.pa.patterns.filter((p) => p.dir === dir && p.strength >= 55).sort((x, y) => y.strength - x.strength)[0]?.name || null;
    const h = OTC.Pipeline.htfScore(X, dir);
    out.align = h >= 75 ? 'high' : h >= 50 ? 'mid' : 'low';
    const seen = new Set();
    for (const x of a.contradiction?.against || []) {
      if (!x.code || (x.severity === 'low' && !x.hard) || seen.has(x.code)) continue;
      seen.add(x.code);
      out.risks.push({ code: x.code, severity: x.severity, hard: !!x.hard });
    }
    if (timing) out.timing = { ok: !!timing.ok, elapsed: Math.round(timing.elapsed ?? 0) };
    return out;
  }

  OTC.Facts = { from, setupKind, skipCode };
})(typeof globalThis !== 'undefined' ? globalThis : this);
