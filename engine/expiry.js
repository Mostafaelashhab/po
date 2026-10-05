// Dynamic Expiry Engine. No fixed expiry: each opportunity gets the duration that fits
// its setup, and — once enough history exists — the duration that has actually worked
// for this kind of setup in this regime.
//
//   1. Evidence: if past opportunities/setups of the same kind and regime have enough
//      resolved outcomes at several horizons, pick the horizon with the best lower bound
//      above break-even.
//   2. Otherwise the setup itself: setup frame × candles typical for the setup kind,
//      shortened in fast markets / near a level, lengthened in slow markets.
//   3. Snap to a duration the platform actually offers for the pair.
(function (G) {
  const OTC = G.OTC, U = OTC.U;

  // How many setup candles a setup of this kind usually needs to play out (starting assumption).
  const CANDLES = { momentum: 1, breakout: 1, retest: 2, pullback: 2, trend: 2, reversal: 1, range: 1, pattern: 1, discovered: 1 };

  function snap(sec, available) {
    if (!available?.length) return sec;
    return available.reduce((a, b) => (Math.abs(Math.log(b / sec)) < Math.abs(Math.log(a / sec)) ? b : a));
  }

  // opts:
  //   tf          setup frame (s);  kind: setup kind (facts.kind)
  //   f           features of the setup frame (volatility, momentum)
  //   levelAtr    distance to the nearest opposing level in setup-frame ATR (or Infinity)
  //   available   expiries the platform offers (s), already ⊂ cfg.expiryChoices
  //   history     (seconds) → { n, lo, be } | null, outcomes of similar past setups at that horizon
  //   fixedSec    a discovered strategy's own validated expiry (wins over everything)
  function choose({ tf = 300, kind = 'trend', f = null, levelAtr = Infinity, available = null, history = null, fixedSec = null, fixedSource = null, cfg = OTC.DEFAULT_CONFIG } = {}) {
    const choices = (available?.length ? available : cfg.expiryChoices).filter((s) => cfg.expiryChoices.includes(s) && (tf < 60 || s >= 60));
    const pool = choices.length ? choices : cfg.expiryChoices;
    if (fixedSec) return { sec: snap(fixedSec, pool), source: fixedSource || 'discovered', reason: { code: fixedSource || 'discovered', sec: fixedSec }, candidates: [] };

    // 1. evidence from similar past setups
    const minN = Math.max(30, Math.round((cfg.validation?.minTrain ?? 50) * 0.6));
    const candidates = [];
    if (history) {
      for (const s of pool) {
        const h = history(s);
        if (h && h.n >= minN && h.lo != null) candidates.push({ sec: s, n: h.n, wr: h.wr, lo: h.lo, be: h.be, edge: h.lo - h.be });
      }
      const best = candidates.filter((c) => c.edge > 0).sort((a, b) => b.edge - a.edge)[0];
      if (best && candidates.length >= 2) return { sec: best.sec, source: 'history', reason: { code: 'history', sec: best.sec, wr: best.wr, n: best.n }, candidates };
    }

    // 2. what the setup needs
    let sec = tf * (CANDLES[kind] ?? 1);
    const adj = [];
    const vol = f?.volatility?.state;
    if (vol === 'HIGH') { sec *= 0.6; adj.push('fast'); }
    else if (vol === 'LOW') { sec *= 1.5; adj.push('slow'); }
    if (f?.momentum?.accel) { sec *= 0.8; adj.push('accelerating'); }
    if (levelAtr < 1.2) { sec *= 0.7; adj.push('level_close'); }
    sec = U.clamp(sec, Math.min(tf, 60), 1800); // seconds frames may go below a minute, minute frames never do
    return { sec: snap(sec, pool), source: 'setup', reason: { code: 'setup', tf, kind, adj, raw: Math.round(sec) }, candidates };
  }

  OTC.Expiry = { choose, snap, CANDLES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
