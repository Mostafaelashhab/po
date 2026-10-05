// Historical Intelligence Engine: replay, market states, similar past situations, pair fingerprints
// ("OTC DNA") and discovered patterns — all measured on what happened AFTER, never assumed.
//
//   MarketState  the market at candle i from candles ≤ i only: the last L returns in units of the pair's own
//                recent volatility (σ of the last W returns — price level and scale don't matter), where price
//                sits in its recent range, how volatile it is now vs before, the current run, the last candle's
//                shape. No strategy, no indicator opinion.
//   Outcomes     for each horizon (candles): direction, move, best and worst excursion, in σ — known only after
//                the horizon; a state is used as history only once its last outcome is known.
//   Similarity   states are indexed by a coarse signature (last 3 directions, range third, volatility state);
//                the nearest K in the same bucket by a weighted distance (recent returns weigh more).
//   Walk-forward the honest test: at time T the library holds only states whose outcomes were known before T;
//                hit rates by strength, over time folds, against trivial baselines (previous candle, its
//                reverse, 3-candle momentum, always up). If it is no better, it says so.
//   DNA          per pair: what usually follows a run of k, a big candle, the top/bottom of the range, each
//                volatility state — each with its sample, interval, and a multiple-testing-corrected verdict.
//   Discovery    every signature × horizon is a candidate: direction picked on the oldest 60%, checked on the
//                next 20% (validation) and the newest 20% (out-of-sample), stable over time folds, and kept
//                only if it survives a Benjamini–Hochberg correction for the number of candidates tested.
(function (G) {
  const OTC = G.OTC, U = OTC.U;

  const DEFAULTS = {
    L: 12, W: 60, K: 50, minCandidates: 100, warm: 2000, folds: 4,
    // outcome horizons in candles: the next candle, then PO's own durations (5s candles: 5s, S15 S30 M1 M3 M5;
    // 1M candles: M1 M3 M5 M30). Only PO's durations can become trades.
    horizons: { 5: [1, 3, 6, 12, 36, 60], 60: [1, 3, 5, 30] },
    split: [0.6, 0.2, 0.2], minTrainN: 100, fdr: 0.05,
    // strategy discovery on market states: 5s rules at 15 s / 30 s / 1 min, 1M rules at 1 / 3 / 5 min
    discoverHorizons: { 5: [3, 6, 12], 60: [1, 3, 5] },
  };
  const BUCKETS = [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 1.01]];
  const bucketOf = (p) => BUCKETS.findIndex(([lo, hi]) => p >= lo && p < hi);
  const bucketLabel = (b) => `${Math.round(BUCKETS[b][0] * 100)}–${Math.min(100, Math.round(BUCKETS[b][1] * 100))}%`;
  const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const sd = (a) => { if (!a.length) return 0; let m = 0; for (const x of a) m += x; m /= a.length; let v = 0; for (const x of a) v += (x - m) ** 2; return Math.sqrt(v / a.length); };

  // Contiguous runs of candles: a missing candle breaks a run, so no state ever straddles a hole.
  function segments(candles, tf) {
    const cs = [...candles].sort((a, b) => a.time - b.time), out = [];
    let seg = [];
    for (const c of cs) {
      if (seg.length && c.time === seg[seg.length - 1].time) continue;
      if (seg.length && c.time - seg[seg.length - 1].time !== tf) { if (seg.length) out.push(seg); seg = []; }
      seg.push(c);
    }
    if (seg.length) out.push(seg);
    return out;
  }

  // The market at candle i of a segment (needs W candles before it).
  function stateAt(seg, i, tf, o = DEFAULTS) {
    const { L, W } = o;
    if (i < W) return null;
    const d = new Array(W);
    for (let j = 0; j < W; j++) d[j] = seg[i - W + 1 + j].close - seg[i - W + j].close;
    const sigma = sd(d);
    if (!(sigma > 0)) return null;
    const z = d.slice(-L).map((x) => U.clamp(x / sigma, -4, 4));
    let hi = -Infinity, lo = Infinity;
    for (let j = i - W + 1; j <= i; j++) { if (seg[j].high > hi) hi = seg[j].high; if (seg[j].low < lo) lo = seg[j].low; }
    const c = seg[i], pos = hi > lo ? (c.close - lo) / (hi - lo) : 0.5;
    const volr = sd(d.slice(-12)) / sigma;
    let run = 0;
    for (let j = W - 1; j >= 0 && d[j] !== 0 && sgn(d[j]) === sgn(d[W - 1]); j--) run += sgn(d[j]);
    const range = c.high - c.low;
    const body = range > 0 ? (c.close - c.open) / range : 0;
    const upWick = range > 0 ? (c.high - Math.max(c.open, c.close)) / range : 0, loWick = range > 0 ? (Math.min(c.open, c.close) - c.low) / range : 0;
    const s = { t: c.time, tf, price: c.close, sigma, z, pos, volr, run, body, upWick, loWick, last: sgn(d[W - 1]),
      mom3: sgn(d[W - 1] + d[W - 2] + d[W - 3]), big: Math.abs(z[L - 1]) >= 2 };
    s.key = signature(s);
    // features for the strategy discovery engine (normalized: σ units, ratios, counts — never a price level)
    let iHi = i, iLo = i, prevHi = -Infinity, prevLo = Infinity;
    for (let j = i - W + 1; j <= i; j++) { if (seg[j].high >= seg[iHi].high) iHi = j; if (seg[j].low <= seg[iLo].low) iLo = j; }
    for (let j = i - W + 1; j < i; j++) { if (seg[j].high > prevHi) prevHi = seg[j].high; if (seg[j].low < prevLo) prevLo = seg[j].low; }
    let hi3 = -Infinity, lo3 = Infinity;
    for (let j = Math.max(i - W + 1, i - 2); j <= i; j++) { if (seg[j].high > hi3) hi3 = seg[j].high; if (seg[j].low < lo3) lo3 = seg[j].low; }
    const sum = (a, b) => { let x = 0; for (let j = a; j < b; j++) x += z[j]; return x; };
    const sd6 = sd(d.slice(-6)), sdp6 = sd(d.slice(-12, -6));
    const dirCh = (x) => (x > 0 ? 'U' : x < 0 ? 'D' : 'N');
    s.f = {
      z1: z[L - 1], z2: z[L - 2], z3: z[L - 3], mom3: sum(L - 3, L), mom6: sum(L - 6, L), mom12: sum(0, L),
      accel: Math.abs(z[L - 1]) - Math.abs(z[L - 2]),                    // > 0: the move speeds up
      decel: Math.abs(z[L - 1]) < Math.abs(z[L - 2]) && Math.abs(z[L - 2]) < Math.abs(z[L - 3]), // shrinking steps
      run, pos, distHi: (hi - c.close) / sigma, distLo: (c.close - lo) / sigma,
      sinceHi: i - iHi, sinceLo: i - iLo,
      brkHi: c.close > prevHi, brkLo: c.close < prevLo,                    // closed beyond the previous range just now
      failHi: hi3 > prevHi && c.close < prevHi, failLo: lo3 < prevLo && c.close > prevLo, // poked out and came back
      volr, volChange: sdp6 > 0 ? sd6 / sdp6 : 1, range1: range / sigma, body, upWick, loWick,
      seq3: `${dirCh(d[W - 3])}${dirCh(d[W - 2])}${dirCh(d[W - 1])}`, hour4: Math.floor(((c.time % 86400) / 3600) / 4),
    };
    return s;
  }
  const posBucket = (p) => (p < 1 / 3 ? 0 : p < 2 / 3 ? 1 : 2);
  const volBucket = (v) => (v < 0.8 ? 0 : v < 1.2 ? 1 : 2);
  function signature(s) {
    const L = s.z.length;
    return `${sgn(s.z[L - 1])}${sgn(s.z[L - 2])}${sgn(s.z[L - 3])}|${posBucket(s.pos)}|${volBucket(s.volr)}`;
  }

  // What happened after candle i: per horizon h (candles), direction, move, best/worst excursion in σ.
  function outcomesAt(seg, i, hs, sigma) {
    const p0 = seg[i].close, out = { dir: [], move: [], mfe: [], mae: [] };
    for (const h of hs) {
      if (i + h >= seg.length) return null;
      let up = -Infinity, dn = Infinity;
      for (let j = i + 1; j <= i + h; j++) { if (seg[j].high > up) up = seg[j].high; if (seg[j].low < dn) dn = seg[j].low; }
      const mv = seg[i + h].close - p0;
      out.dir.push(sgn(mv)); out.move.push(+(mv / sigma).toFixed(3));
      out.mfe.push(+((up - p0) / sigma).toFixed(3)); out.mae.push(+((p0 - dn) / sigma).toFixed(3));
    }
    return out;
  }

  // Every state (with outcomes) of one pair's candles. withoutOutcome: also the latest states (for live queries).
  function build(candles, tf, { asset = null, o = DEFAULTS, withoutOutcome = false } = {}) {
    const hs = o.horizons[tf] || o.horizons[5], out = [];
    for (const seg of segments(candles, tf)) {
      for (let i = o.W; i < seg.length; i++) {
        const s = stateAt(seg, i, tf, o);
        if (!s) continue;
        const oc = outcomesAt(seg, i, hs, s.sigma);
        if (!oc && !withoutOutcome) continue;
        s.asset = asset; s.out = oc; s.hs = hs;
        out.push(s);
      }
    }
    return out;
  }

  // ── similarity ─────────────────────────────────────────────────────────────
  const WEIGHTS = (L) => Array.from({ length: L }, (_, j) => 0.5 + j / L);
  function distance(a, b, w) {
    let d = 0;
    for (let j = 0; j < a.z.length; j++) d += w[j] * (a.z[j] - b.z[j]) ** 2;
    return d + 4 * (a.pos - b.pos) ** 2 + (a.volr - b.volr) ** 2 + 0.5 * (a.body - b.body) ** 2;
  }
  // Library of past states, bucketed by signature (optionally per pair).
  function library({ samePair = false, o = DEFAULTS } = {}) {
    const buckets = new Map(), w = WEIGHTS(o.L);
    const keyOf = (s) => (samePair ? `${s.asset}|${s.key}` : s.key);
    return {
      size: 0,
      add(s) { const k = keyOf(s); (buckets.get(k) || buckets.set(k, []).get(k)).push(s); this.size++; },
      // nearest K past states; null when the bucket is too thin to say anything
      query(s, k = o.K) {
        const cand = buckets.get(keyOf(s)) || [];
        if (cand.length < Math.max(k, o.minCandidates)) return null;
        const sc = cand.map((m) => [distance(s, m, w), m]);
        sc.sort((x, y) => x[0] - y[0]);
        return sc.slice(0, k).map((x) => x[1]);
      },
    };
  }
  const meanDistance = (s, nb, w) => nb.reduce((a, m) => a + distance(s, m, w), 0) / nb.length;
  // What followed the neighbours, per horizon.
  function distribution(nb, hs) {
    return hs.map((h, hi) => {
      let up = 0, dn = 0, mv = 0;
      for (const m of nb) { const d = m.out.dir[hi]; if (d > 0) up++; else if (d < 0) dn++; mv += m.out.move[hi]; }
      const n = up + dn, p = n ? Math.max(up, dn) / n : 0.5;
      return { h, up, down: dn, n, dir: up > dn ? 'CALL' : dn > up ? 'PUT' : null, p, bucket: n ? bucketOf(p) : -1, meanMove: nb.length ? +(mv / nb.length).toFixed(3) : 0 };
    });
  }

  // ── walk-forward (the honest test) ──────────────────────────────────────────
  // states: every pair pooled, sorted by time. At each tested state the library holds only states whose last
  // outcome was known before it (t + longest horizon ≤ T). Hit = the neighbours' majority direction came true.
  function walkForward(states, { o = DEFAULTS, samePair = false, step = 1, maxTests = Infinity, shouldStop = null, onProgress = null } = {}) {
    if (!states.length) return null;
    const tf = states[0].tf, hs = states[0].hs, maxH = hs[hs.length - 1] * tf;
    const sorted = [...states].sort((a, b) => a.t - b.t);
    const lib = library({ samePair, o });
    const t0 = sorted[0].t, t1 = sorted[sorted.length - 1].t, foldOf = (t) => Math.min(o.folds - 1, Math.floor(((t - t0) / Math.max(1, t1 - t0)) * o.folds));
    const R = hs.map(() => ({ all: [0, 0], buckets: BUCKETS.map(() => [0, 0]), folds: BUCKETS.map(() => Array.from({ length: o.folds }, () => [0, 0])),
      base: { prevSame: [0, 0], prevReverse: [0, 0], momentum3: [0, 0], alwaysUp: [0, 0] } }));
    // outcomes that overlap in time (the same pair, within one horizon) are not independent: only the first of
    // them is counted, or a random walk would look predictable with a tiny interval
    const dists = [], w = WEIGHTS(o.L);
    const busy = new Map();
    const free = (s, hi) => { const k = `${s.asset}|${hi}`, b = busy.get(k) ?? -Infinity; if (s.t < b) return false; busy.set(k, s.t + hs[hi] * tf); return true; };
    let ptr = 0, tested = 0, thin = 0;
    for (let i = 0; i < sorted.length && tested < maxTests; i++) {
      const s = sorted[i];
      while (ptr < sorted.length && sorted[ptr].t + maxH <= s.t) lib.add(sorted[ptr++]);
      if (lib.size < o.warm || i % step) continue;
      if (shouldStop?.()) break;
      const nb = lib.query(s);
      if (!nb) { thin++; continue; }
      tested++;
      if (dists.length < 20000) dists.push(meanDistance(s, nb, w));
      if (onProgress && tested % 2000 === 0) onProgress({ tested, of: sorted.length });
      const dist = distribution(nb, hs);
      hs.forEach((h, hi) => {
        const act = s.out.dir[hi], D = dist[hi], r = R[hi];
        if (!act || !free(s, hi)) return;
        if (D.dir) {
          const hit = (D.dir === 'CALL' ? 1 : -1) === act ? 1 : 0;
          r.all[0]++; r.all[1] += hit;
          r.buckets[D.bucket][0]++; r.buckets[D.bucket][1] += hit;
          const f = r.folds[D.bucket][foldOf(s.t)]; f[0]++; f[1] += hit;
        }
        if (s.last) { r.base.prevSame[0]++; r.base.prevSame[1] += s.last === act ? 1 : 0; r.base.prevReverse[0]++; r.base.prevReverse[1] += s.last === -act ? 1 : 0; }
        if (s.mom3) { r.base.momentum3[0]++; r.base.momentum3[1] += s.mom3 === act ? 1 : 0; }
        r.base.alwaysUp[0]++; r.base.alwaysUp[1] += act > 0 ? 1 : 0;
      });
    }
    const rate = ([n, k]) => { const ci = OTC.Stats.wilson(k, n); return { n, hits: k, rate: n ? +((100 * k) / n).toFixed(1) : null, lo: n ? +ci.lo.toFixed(1) : null, hi: n ? +ci.hi.toFixed(1) : null }; };
    const horizons = hs.map((h, hi) => {
      const r = R[hi], base = Object.fromEntries(Object.entries(r.base).map(([k, v]) => [k, rate(v)]));
      const bestBase = Math.max(...Object.values(base).map((b) => b.rate ?? 0));
      const buckets = r.buckets.map((b, bi) => ({ bucket: bucketLabel(bi), ...rate(b), folds: r.folds[bi].map(rate) }));
      const all = rate(r.all);
      return { sec: h * tf, candles: h, analog: all, buckets, baselines: base, bestBaseline: bestBase, lift: all.rate != null ? +(all.rate - bestBase).toFixed(1) : null };
    });
    // multiple testing: every horizon × strength cell is a hypothesis; only cells surviving Benjamini–Hochberg
    // (rate > 50%) are marked significant — with 6 horizons × 4 strengths some cells look good by chance alone
    const cells = horizons.flatMap((H) => H.buckets.map((b) => ({ b, p: pOne(b.hits, b.n) })));
    const pass = bh(cells.map((c) => c.p), o.fdr);
    cells.forEach((c, i) => { c.b.significant = pass[i]; c.b.p = +c.p.toPrecision(3); });
    const hp = horizons.map((H) => pOne(H.analog.hits, H.analog.n)), hpass = bh(hp, o.fdr);
    horizons.forEach((H, i) => { H.analog.significant = hpass[i]; H.analog.p = +hp[i].toPrecision(3); });
    // how far the nearest past states usually are: beyond the 95th percentile, the present is unlike the past
    dists.sort((a, b) => a - b);
    const anomalyP95 = dists.length ? +dists[Math.floor(dists.length * 0.95)].toFixed(3) : null;
    return { tf, samePair, states: sorted.length, tested, thin, from: t0, to: t1, horizons, cellsTested: cells.length, anomalyP95 };
  }

  // Reliability for live use: per horizon × strength, the walk-forward hit rate and its folds.
  function reliability(wf) {
    const out = {};
    for (const H of wf?.horizons || []) out[H.sec] = H.buckets.map((b) => ({ n: b.n, hits: b.hits, rate: b.rate, lo: b.lo, significant: !!b.significant, folds: b.folds.map((f) => [f.n, f.hits]) }));
    return out;
  }

  // ── statistics helpers ─────────────────────────────────────────────────────
  // two-sided p-value of k successes in n vs 50% (normal approximation with continuity correction)
  function pTwo(k, n) {
    if (!n) return 1;
    const z = (Math.abs(k - n / 2) - 0.5) / Math.sqrt(n / 4);
    return Math.min(1, 2 * (1 - normCdf(Math.max(0, z))));
  }
  function pOne(k, n) { // one-sided: rate > 50%
    if (!n) return 1;
    const z = (k - n / 2 - 0.5) / Math.sqrt(n / 4);
    return 1 - normCdf(z);
  }
  function normCdf(x) { // Abramowitz–Stegun
    const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }
  // Benjamini–Hochberg: which of these p-values survive a false-discovery rate q.
  function bh(ps, q = 0.05) {
    const idx = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]), m = ps.length, pass = new Array(m).fill(false);
    let kmax = -1;
    idx.forEach(([p], r) => { if (p <= ((r + 1) / m) * q) kmax = r; });
    for (let r = 0; r <= kmax; r++) pass[idx[r][1]] = true;
    return pass;
  }

  // ── OTC DNA: a pair's measured behaviour ───────────────────────────────────
  // Next-candle questions (and the 3-candle horizon), each against 50%: continuation after a run of k, after a big
  // candle, at the top / bottom of the range, in each volatility state; flagged only if it survives BH.
  function dna(states, { o = DEFAULTS, fdr = o.fdr } = {}) {
    if (!states.length) return null;
    const tf = states[0].tf, rows = [], h0 = states[0].hs[0] * tf;
    const sorted = [...states].sort((a, b) => a.t - b.t);
    const add = (id, label, sel, want) => {
      let n = 0, k = 0;
      const busy = new Map(); // one outcome at a time per pair (overlapping ones are not independent)
      for (const s of sorted) {
        if (!sel(s)) continue; const a = s.out.dir[0]; if (!a) continue;
        if (s.t < (busy.get(s.asset) ?? -Infinity)) continue; busy.set(s.asset, s.t + h0);
        n++; if (a === want(s)) k++;
      }
      if (n >= 30) { const ci = OTC.Stats.wilson(k, n); rows.push({ id, label, n, k, rate: +((100 * k) / n).toFixed(1), lo: +ci.lo.toFixed(1), hi: +ci.hi.toFixed(1), p: pTwo(k, n) }); }
    };
    add('up', 'next candle up', () => true, () => 1);
    for (let r = 1; r <= 5; r++) add(`run${r}`, `continues after ${r} in a row`, (s) => Math.abs(s.run) === r, (s) => sgn(s.run));
    add('run6', 'continues after 6+ in a row', (s) => Math.abs(s.run) >= 6, (s) => sgn(s.run));
    add('big', 'continues after a big candle (≥ 2σ)', (s) => s.big, (s) => s.last);
    add('top', 'falls back from the top of its range', (s) => s.pos >= 0.9, () => -1);
    add('bottom', 'bounces from the bottom of its range', (s) => s.pos <= 0.1, () => 1);
    add('quiet', 'continues when quiet (low volatility)', (s) => s.volr < 0.8 && s.last, (s) => s.last);
    add('wild', 'continues when volatile', (s) => s.volr >= 1.2 && s.last, (s) => s.last);
    add('upwick', 'falls after a long upper wick', (s) => s.upWick >= 0.5, () => -1);
    add('lowick', 'rises after a long lower wick', (s) => s.loWick >= 0.5, () => 1);
    const pass = bh(rows.map((r) => r.p), fdr);
    rows.forEach((r, i) => { r.significant = pass[i]; r.p = +r.p.toPrecision(3); });
    return { tf, horizonSec: h0, states: states.length, from: sorted[0].t, to: sorted[sorted.length - 1].t, rows, significant: rows.filter((r) => r.significant).length };
  }

  // ── pattern discovery ──────────────────────────────────────────────────────
  // Candidates: signature (optionally per pair) × horizon. Direction chosen on train only; validation and
  // out-of-sample measure it; time folds check stability; BH over every candidate that reached out-of-sample.
  function discover(states, { o = DEFAULTS, payout = 85, perPair = false } = {}) {
    if (!states.length) return { tested: 0, patterns: [] };
    const sorted = [...states].sort((a, b) => a.t - b.t), N = sorted.length, hs = sorted[0].hs, tf = sorted[0].tf;
    const c1 = sorted[Math.floor(N * o.split[0])].t, c2 = sorted[Math.min(N - 1, Math.floor(N * (o.split[0] + o.split[1])))].t;
    const t0 = sorted[0].t, t1 = sorted[N - 1].t, be = U.breakEven(payout);
    const groups = new Map();
    for (const s of sorted) {
      const k = perPair ? `${s.asset}|${s.key}` : s.key;
      (groups.get(k) || groups.set(k, []).get(k)).push(s);
    }
    const cands = [];
    for (const [key, ss] of groups) {
      hs.forEach((h, hi) => {
        // one outcome at a time per pair: overlapping outcomes would count one move many times
        const use = [], busy = new Map();
        for (const s of ss) { const d = s.out.dir[hi]; if (!d || s.t < (busy.get(s.asset) ?? -Infinity)) continue; busy.set(s.asset, s.t + h * tf); use.push(s); }
        const part = (from, to) => { let n = 0, up = 0; for (const s of use) { if (s.t < from || s.t >= to) continue; n++; if (s.out.dir[hi] > 0) up++; } return [n, up]; };
        const [nT, upT] = part(-Infinity, c1);
        if (nT < o.minTrainN) return;
        const dir = upT * 2 >= nT ? 1 : -1, winsT = dir > 0 ? upT : nT - upT;
        const ciT = OTC.Stats.wilson(winsT, nT);
        const c = { key, sec: h * tf, candles: h, dir: dir > 0 ? 'CALL' : 'PUT', train: { n: nT, rate: +((100 * winsT) / nT).toFixed(1), lo: +ciT.lo.toFixed(1) }, status: 'DISCOVERED' };
        cands.push(c);
        if (ciT.lo < 50) { c.status = 'REJECTED'; c.why = 'train: not clearly one-sided'; return; }
        const [nV, upV] = part(c1, c2), winsV = dir > 0 ? upV : nV - upV;
        c.validation = { n: nV, rate: nV ? +((100 * winsV) / nV).toFixed(1) : null };
        if (!nV || winsV * 2 <= nV) { c.status = 'REJECTED'; c.why = 'validation: did not hold'; return; }
        const [nO, upO] = part(c2, Infinity), winsO = dir > 0 ? upO : nO - upO;
        c.oos = { n: nO, rate: nO ? +((100 * winsO) / nO).toFixed(1) : null, p: pOne(winsO, nO) };
        c.status = 'OUT_OF_SAMPLE';
        const folds = Array.from({ length: o.folds }, () => [0, 0]);
        for (const s of use) {
          const d = s.out.dir[hi];
          const f = folds[Math.min(o.folds - 1, Math.floor(((s.t - t0) / Math.max(1, t1 - t0)) * o.folds))];
          f[0]++; if (d === dir) f[1]++;
        }
        c.folds = folds.map(([n, k]) => ({ n, rate: n ? +((100 * k) / n).toFixed(1) : null }));
      });
    }
    // multiple testing: BH over every candidate that reached the out-of-sample test
    const atOos = cands.filter((c) => c.status === 'OUT_OF_SAMPLE');
    const pass = bh(atOos.map((c) => c.oos.p), o.fdr);
    atOos.forEach((c, i) => {
      if (!pass[i]) { c.status = 'REJECTED'; c.why = `out-of-sample ${c.oos.rate}% of ${c.oos.n}: not significant after testing ${cands.length} candidates`; return; }
      const stable = c.folds.filter((f) => f.n >= 20).every((f) => f.rate > 50);
      if (!stable) { c.status = 'REJECTED'; c.why = 'not stable over time'; return; }
      c.status = c.oos.rate >= be ? 'VALIDATED' : 'WALK_FORWARD';
      if (c.status === 'WALK_FORWARD') c.why = `holds (${c.oos.rate}%) but below break-even ${be.toFixed(1)}% at ${payout}%`;
    });
    return { tf, tested: cands.length, reachedOos: atOos.length, expectedFalse: +(atOos.length * o.fdr).toFixed(1), payout,
      patterns: cands.filter((c) => c.status === 'VALIDATED' || c.status === 'WALK_FORWARD'), rejected: cands.length - cands.filter((c) => c.status === 'VALIDATED' || c.status === 'WALK_FORWARD').length };
  }

  // ── live ───────────────────────────────────────────────────────────────────
  // Prediction for the current state: what followed similar past states, and how reliable that has been in
  // the walk-forward test at this strength (the evidence the entry gate prices: n, hit rate, folds).
  function predict(lib, rel, s, { o = DEFAULTS, anomalyP95 = null } = {}) {
    const nb = lib.query(s);
    if (!nb) return { status: 'INSUFFICIENT_DATA', horizons: [] };
    const dist = distribution(nb, s.hs);
    // unlike anything in the record: statistically unusual (not "manipulation") — no entry, keep collecting
    const md = meanDistance(s, nb, WEIGHTS(o.L)), anomalous = anomalyP95 != null && md > anomalyP95;
    const horizons = dist.map((D) => {
      const r = D.bucket >= 0 ? rel?.[D.h * s.tf]?.[D.bucket] : null;
      return { sec: D.h * s.tf, dir: D.dir, up: D.up, down: D.down, n: D.n, p: +(100 * D.p).toFixed(1), bucket: D.bucket >= 0 ? bucketLabel(D.bucket) : null, meanMove: D.meanMove,
        tested: r ? { n: r.n, hits: r.hits, rate: r.rate, lo: r.lo, significant: !!r.significant, folds: r.folds } : null };
    });
    return { status: anomalous ? 'ANOMALOUS' : 'OK', neighbours: nb.length, distance: +md.toFixed(3), anomalyP95, horizons };
  }

  // ── one research cycle ─────────────────────────────────────────────────────
  // per5 / per1: { asset → 5s / 1M candles }. Replays both, tests similarity walk-forward, discovers patterns,
  // fingerprints every pair (corrected across all of them), and returns a versioned model (nothing trades here).
  function runCycle(per5, per1, { payout = 85, shouldStop = null, onProgress = null, onStates = null } = {}) {
    const say = (t) => onProgress?.(t);
    const s5 = [], m1 = [];
    for (const [a, cs] of Object.entries(per5)) s5.push(...build(cs, 5, { asset: a }));
    for (const [a, cs] of Object.entries(per1)) m1.push(...build(cs, 60, { asset: a }));
    onStates?.({ 5: s5, 60: m1 }); // the same canonical states feed the strategy discovery engine
    say(`states: ${s5.length} (5s, ${Object.keys(per5).length} pairs) · ${m1.length} (1M, ${Object.keys(per1).length} pairs)`);
    const out = { 5: null, 60: null };
    for (const [tf, st] of [[5, s5], [60, m1]]) {
      if (shouldStop?.()) return null;
      if (st.length < DEFAULTS.warm + 500) { out[tf] = { states: st.length, tooFew: true }; continue; }
      say(`${tf}s: walk-forward…`);
      const wf = walkForward(st, { shouldStop, onProgress: (p) => say(`${tf}s: ${p.tested} tested…`) });
      say(`${tf}s: discovery…`);
      const disc = discover(st, { payout });
      const pairs = {};
      for (const a of new Set(st.map((x) => x.asset))) { const d = dna(st.filter((x) => x.asset === a)); if (d) pairs[a] = d; }
      const rows = Object.values(pairs).flatMap((d) => d.rows);
      const pass = bh(rows.map((r) => r.p), DEFAULTS.fdr);
      rows.forEach((r, i) => { r.significant = pass[i]; });
      for (const d of Object.values(pairs)) d.significant = d.rows.filter((r) => r.significant).length;
      let from = Infinity, to = -Infinity;
      for (const x of st) { if (x.t < from) from = x.t; if (x.t > to) to = x.t; }
      out[tf] = { states: st.length, pairs: Object.keys(pairs).length, from, to, wf, reliability: reliability(wf), anomalyP95: wf.anomalyP95,
        discovery: { tested: disc.tested, reachedOos: disc.reachedOos, expectedFalse: disc.expectedFalse, payout, patterns: disc.patterns }, dna: { pooled: dna(st), pairs } };
    }
    const sig = (tf) => (out[tf]?.wf?.horizons || []).flatMap((h) => h.buckets.filter((b) => b.significant).map((b) => ({ sec: h.sec, bucket: b.bucket, rate: b.rate, n: b.n })));
    const validated = (tf) => (out[tf]?.discovery?.patterns || []).filter((p) => p.status === 'VALIDATED');
    const now = Date.now();
    return {
      id: `rm-${now}`, builtAt: now, payout,
      data: Object.fromEntries([5, 60].map((tf) => [tf, out[tf] && { states: out[tf].states, pairs: out[tf].pairs, from: out[tf].from, to: out[tf].to }])),
      results: out, reliability: { 5: out[5]?.reliability || null, 60: out[60]?.reliability || null },
      anomalyP95: { 5: out[5]?.anomalyP95 ?? null, 60: out[60]?.anomalyP95 ?? null }, patterns: { 5: validated(5), 60: validated(60) },
      summary: { significantCells: { 5: sig(5), 60: sig(60) }, validated: { 5: validated(5).length, 60: validated(60).length },
        bestLift: Object.fromEntries([5, 60].map((tf) => [tf, Math.max(...(out[tf]?.wf?.horizons || []).map((h) => h.lift ?? -99), -99)])) },
    };
  }

  OTC.Research = { DEFAULTS, BUCKETS, segments, stateAt, signature, outcomesAt, build, library, distribution, distance, walkForward, reliability, dna, discover, predict, runCycle, bh, pTwo, pOne, bucketOf, bucketLabel };
})(typeof globalThis !== 'undefined' ? globalThis : this);
