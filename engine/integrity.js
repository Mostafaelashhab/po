// Integrity watch: is the platform playing with the trades (settling them worse than the market, or moving the
// price against the trades the bot places), and is the market running abnormally fast? Every check is a test with
// a threshold chance rarely reaches — a few odd trades prove nothing (on 2026-10-04 the user's 173 real trades
// showed no sign of either).
(function (G) {
  const OTC = G.OTC;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  // P(X ≥ k) for X ~ Binomial(n, ½)
  const binomTail = (k, n) => { let p = 0, c = 1; for (let i = 0; i <= n; i++) { if (i >= k) p += c; c = (c * (n - i)) / (i + 1); } return p / 2 ** n; };
  const meanSd = (a) => { const n = a.length, m = sum(a) / n, v = n > 1 ? sum(a.map((x) => (x - m) ** 2)) / (n - 1) : 0; return { n, m, v }; };

  // Settlement and targeting, from the opportunity records.
  //  • mismatch: trades where PO's result and the market's (at PO's own open and close times) differ — PO against us
  //    vs. for us; fair settling makes them about even;
  //  • closeDev: PO's close price vs the market's at that second, + = worse for the trade (sign test; |x| > 20 bp is
  //    a lookup slip, not a price);
  //  • targeted: trades the bot placed win less (from the signal price) than the same strategies' signals it didn't
  //    place, or the price runs against them in the first 5 seconds more than against those not placed.
  function settlement(records, { minMismatch = 5, p = 0.05 } = {}) {
    const placed = (r) => ['auto', 'manual'].includes(r.exec?.action), paper = (r) => r.exec?.action === 'paper';
    const opps = records.filter((r) => r.kind === 'opp' && r.exec);
    const f = opps.filter((r) => placed(r) && r.exec.forensics).map((r) => r.exec.forensics);
    const against = f.filter((x) => x.poOutcome === 'L' && x.marketOutcome === 'W').length, forUs = f.filter((x) => x.poOutcome === 'W' && x.marketOutcome === 'L').length;
    const dev = f.map((x) => x.closeDevBp).filter((x) => x != null && x !== 0 && Math.abs(x) <= 20), worse = dev.filter((x) => x > 0).length;
    const won = (r) => { const d = (r.exec?.dir || r.decision) === 'CALL' ? 1 : -1, e = r.expirySec, a = r.entryPrice, b = r.exits?.[e]; return a == null || b == null || a === b ? null : Math.sign(b - a) === d; };
    const rate = (rs) => { const v = rs.map(won).filter((x) => x != null); return { n: v.length, w: v.filter(Boolean).length }; };
    const P = rate(opps.filter(placed)), Q = rate(opps.filter(paper));
    const early = (rs) => rs.map((r) => { const b = r.exits?.[5], a = r.entryPrice; if (a == null || b == null) return null; return ((b - a) / a) * 1e4 * ((r.exec?.dir || r.decision) === 'CALL' ? 1 : -1); }).filter((x) => x != null && Math.abs(x) <= 50);
    const eP = meanSd(early(opps.filter(placed))), eQ = meanSd(early(opps.filter(paper)));
    const flags = [];
    const pMis = binomTail(against, against + forUs);
    if (against >= minMismatch && pMis < p) flags.push({ code: 'settle_against', against, forUs, p: +pMis.toFixed(4) });
    const pDev = binomTail(worse, dev.length);
    if (dev.length >= 20 && pDev < p / 5) flags.push({ code: 'close_worse', worse, of: dev.length, p: +pDev.toFixed(4) });
    let zWin = null;
    if (P.n >= 50 && Q.n >= 50) { const p1 = P.w / P.n, p2 = Q.w / Q.n, pp = (P.w + Q.w) / (P.n + Q.n); zWin = (p1 - p2) / Math.sqrt(pp * (1 - pp) * (1 / P.n + 1 / Q.n)); if (zWin <= -2.33) flags.push({ code: 'placed_lose_more', placed: +(100 * p1).toFixed(1), notPlaced: +(100 * p2).toFixed(1), z: +zWin.toFixed(2) }); }
    let zEarly = null;
    if (eP.n >= 50 && eQ.n >= 50) { zEarly = (eP.m - eQ.m) / Math.sqrt(eP.v / eP.n + eQ.v / eQ.n || 1e-12); if (zEarly <= -2.33) flags.push({ code: 'moves_against_placed', placedBp: +eP.m.toFixed(2), notPlacedBp: +eQ.m.toFixed(2), z: +zEarly.toFixed(2) }); }
    return { status: flags.length ? 'suspicious' : f.length >= 30 ? 'clean' : 'few', trades: f.length, against, forUs, closeWorse: worse, closeOf: dev.length,
      placed: P.n ? { n: P.n, rate: +((100 * P.w) / P.n).toFixed(1) } : null, notPlaced: Q.n ? { n: Q.n, rate: +((100 * Q.w) / Q.n).toFixed(1) } : null,
      earlyBp: eP.n ? { placed: +eP.m.toFixed(2), notPlaced: eQ.n ? +eQ.m.toFixed(2) : null } : null, flags };
  }

  // Speed of one pair: the mean absolute 1-second move (bp) over the last `recentSec` vs the pair's own normal (the
  // median of its per-minute means over the last `baseSec`). points: Map or [[time, price]] (1 s apart where known).
  function speed(points, nowSec, { recentSec = 30, baseSec = 1800, minRecent = 15, minBase = 10 } = {}) {
    const pts = [...(points instanceof Map ? points.entries() : points)].filter(([t]) => t > nowSec - baseSec && t <= nowSec + 1).sort((a, b) => a[0] - b[0]);
    const moves = [];
    for (let i = 1; i < pts.length; i++) if (pts[i][0] - pts[i - 1][0] === 1 && pts[i - 1][1] > 0) moves.push([pts[i][0], (Math.abs(pts[i][1] - pts[i - 1][1]) / pts[i - 1][1]) * 1e4]);
    const recent = moves.filter(([t]) => t > nowSec - recentSec).map((x) => x[1]);
    const byMin = new Map();
    for (const [t, v] of moves) if (t <= nowSec - recentSec) { const k = Math.floor(t / 60); (byMin.get(k) || byMin.set(k, []).get(k)).push(v); }
    const mins = [...byMin.values()].filter((a) => a.length >= 20).map((a) => sum(a) / a.length);
    if (recent.length < minRecent || mins.length < minBase) return null;
    const base = median(mins), now = sum(recent) / recent.length;
    return { ratio: base > 0 ? +(now / base).toFixed(2) : null, nowBp: +now.toFixed(3), baseBp: +base.toFixed(3) };
  }

  // The platform's clock against real time: samples [localSec, poSec − localSec] (the freshest offset every ~10 s).
  // A clock running fast shows as the offset growing: (last − first) / elapsed, e.g. 0.03 = 3 % fast.
  function clockDrift(samples, { minSpan = 300, edge = 6 } = {}) {
    if (samples.length < 2 * edge) return null;
    const span = samples.at(-1)[0] - samples[0][0];
    if (span < minSpan) return null;
    const head = samples.slice(0, edge), tail = samples.slice(-edge);
    const a = median(head.map((x) => x[1])), b = median(tail.map((x) => x[1])), ta = median(head.map((x) => x[0])), tb = median(tail.map((x) => x[0]));
    return +((b - a) / (tb - ta)).toFixed(4);
  }

  OTC.Integrity = { settlement, speed, clockDrift, binomTail };
})(typeof globalThis !== 'undefined' ? globalThis : this);
