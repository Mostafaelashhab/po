// Dynamic timeframe selection. For each pair, every candidate frame is scored on how
// readable it is right now, and the roles are chosen from those scores:
//   setup frames        → frames clean enough to look for setups on (others are still
//                         analysed and logged, but cannot open an opportunity)
//   context (MID)       → among the allowed higher frames, the one with the clearest trend/structure
//   confirmation/entry  → among the allowed lower frames, the least noisy one; none if all are
//                         noisy (then the entry is at the setup frame's own candle closes)
// MACRO stays the largest frame of the profile option. Pure logic.
(function (G) {
  const OTC = G.OTC, U = OTC.U;

  // Readability of one frame from its own closed candles and features (0–100 each).
  function quality(candles, f, hist = null) {
    if (!f?.ready || candles.length < 30) return { score: 0, ready: false };
    const c = candles.slice(-20);
    const range = (x) => x.high - x.low || 1e-12;
    const body = U.mean(c.map((x) => Math.abs(x.close - x.open) / range(x)));       // clean candles vs wicks/dojis
    const path = c.slice(1).reduce((s, x, i) => s + Math.abs(x.close - c[i].close), 0) || 1e-12;
    const er = Math.abs(c[c.length - 1].close - c[0].close) / path;                    // efficiency: trend vs noise
    const flat = c.filter((x) => x.high === x.low).length / c.length;                   // frozen / no-tick candles
    const clarity = Math.max(f.trend.strength ?? 0, f.structure.quality ?? 0);
    const vol = { NORMAL: 100, HIGH: 35, LOW: 30, UNKNOWN: 50 }[f.volatility.state] ?? 50;
    // track record of setups on this frame (P(edge) of the frame as a whole), neutral without data
    const track = hist == null ? 50 : U.clamp(hist);
    const parts = { clarity: Math.round(clarity), noise: Math.round(100 * er), candles: Math.round(100 * body), volatility: vol, track: Math.round(track) };
    let score = 0.3 * clarity + 0.25 * 100 * er + 0.2 * 100 * body + 0.15 * vol + 0.1 * track;
    if (flat > 0.2) score *= 0.5;
    return { score: Math.round(U.clamp(score)), ready: true, parts };
  }

  // q: { tf → quality } for the frames this pair has; cfg.frameSelect.options[setupTf] lists allowed roles.
  // Returns { setupFrames: [tf], profiles: { tf → { PRIMARY, MID, MACRO, TIMING } }, scores: { tf → score }, why: { tf → code } }
  function choose(q, cfg = OTC.DEFAULT_CONFIG) {
    const fs = cfg.frameSelect, out = { setupFrames: [], profiles: {}, scores: {}, why: {} };
    for (const [tf, x] of Object.entries(q)) out.scores[tf] = x.score;
    const clarity = (tf) => (q[tf]?.ready ? q[tf].parts.clarity * 0.6 + q[tf].score * 0.4 : -1);
    const clean = (tf) => (q[tf]?.ready ? q[tf].parts.noise * 0.5 + q[tf].parts.candles * 0.5 : -1);
    for (const tf of cfg.setupFrames || []) {
      const opt = fs.options[tf];
      if (!opt) continue;
      const mid = [...opt.MID].sort((a, b) => clarity(b) - clarity(a))[0];
      const timing = opt.TIMING.filter(Boolean).filter((t) => clean(t) >= fs.minConfirmQuality).sort((a, b) => clean(b) - clean(a))[0] ?? null;
      out.profiles[tf] = { PRIMARY: +tf, MID: mid, MACRO: opt.MACRO, TIMING: timing };
      if (!q[tf]?.ready) out.why[tf] = 'not_ready';
      else if (q[tf].score < fs.minSetupQuality) out.why[tf] = 'unclear';
      else { out.setupFrames.push(+tf); out.why[tf] = 'ok'; }
    }
    return out;
  }

  OTC.FrameSelect = { quality, choose };
})(typeof globalThis !== 'undefined' ? globalThis : this);
