// OTC Randomness & Edge Audit. One question: does the OTC data contain a statistically significant, repeatable,
// exploitable edge? It never assumes one and tries to break every apparent one:
//   - each directional hypothesis picks its side on the OLDER 60% of the time range and is measured on the
//     NEWER 40% (and in each half of it), outcomes counted without overlap;
//   - multiple testing: Benjamini–Hochberg within each family (the decision rule) and over everything (reported);
//   - effect sizes and money: hit rate vs break-even 1/(1+payout) at PO's payouts;
//   - the null test: the same audit, and the two engines that search for patterns (similarity, strategy
//     discovery), run on synthetic data with the same pairs, sizes, volatility and candle shapes but NO predictive
//     structure. If they find as much in noise as in OTC, what they find in OTC is noise.
// Verdict: EDGE_FOUND / WEAK_EVIDENCE / NO_EDGE_FOUND / INSUFFICIENT_DATA. "No edge" is a valid, valuable result.
(function (G) {
  const OTC = G.OTC, R = OTC.Research;
  const VERSION = 'audit-1';
  const PAYOUTS = [70, 75, 80, 85, 90, 92];

  // ── statistics ─────────────────────────────────────────────────────────────
  function Phi(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }
  const p2 = (z) => (Number.isFinite(z) ? Math.min(1, 2 * (1 - Phi(Math.abs(z)))) : 1);
  const p1 = (z) => (Number.isFinite(z) ? 1 - Phi(z) : 1);
  function lgamma(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const k of c) s += k / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
  // upper tail of the chi-square distribution: Q(k/2, x/2)
  function chi2p(x, k) {
    if (!(x > 0)) return 1;
    const a = k / 2, xx = x / 2, lg = lgamma(a);
    if (xx < a + 1) { let s = 1 / a, t = s; for (let n = 1; n < 1000; n++) { t *= xx / (a + n); s += t; if (t < s * 1e-12) break; } return Math.min(1, Math.max(0, 1 - s * Math.exp(-xx + a * Math.log(xx) - lg))); }
    let b = xx + 1 - a, c = 1e300, d = 1 / b, h = d;
    for (let i = 1; i < 1000; i++) { const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300; c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-12) break; }
    return Math.min(1, Math.exp(-xx + a * Math.log(xx) - lg) * h);
  }
  function wilson(k, n, z = 1.96) { if (!n) return [null, null]; const p = k / n, z2 = z * z, d = 1 + z2 / n, c = p + z2 / (2 * n), r = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)); return [+(100 * (c - r) / d).toFixed(2), +(100 * (c + r) / d).toFixed(2)]; }
  // Benjamini–Hochberg adjusted p-values
  function bhq(ps) {
    const m = ps.length, o = ps.map((p, i) => [p ?? 1, i]).sort((a, b) => a[0] - b[0]), q = new Array(m);
    let min = 1;
    for (let r = m - 1; r >= 0; r--) { min = Math.min(min, (o[r][0] * m) / (r + 1)); q[o[r][1]] = min; }
    return q;
  }
  const breakEven = (payout) => 100 / (1 + payout / 100);
  const ev = (winPct, payout) => +((winPct / 100) * (payout / 100) - (1 - winPct / 100)).toFixed(4);
  const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const mean = (a) => { if (!a.length) return 0; let s = 0; for (const x of a) s += x; return s / a.length; };
  const sd = (a) => { if (!a.length) return 0; const m = mean(a); let v = 0; for (const x of a) v += (x - m) ** 2; return Math.sqrt(v / a.length); };
  const pct = (k, n) => (n ? +((100 * k) / n).toFixed(2) : null);
  function corr(xs, ys) {
    const n = xs.length; let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) { const x = xs[i], y = ys[i]; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
    const d = Math.sqrt((sxx - (sx * sx) / n) * (syy - (sy * sy) / n));
    return d ? (sxy - (sx * sy) / n) / d : 0;
  }
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

  // Counts of "did it happen" in three time parts: the older 60% (choose), then the two halves of the newer 40%.
  function tally(cutA, cutB) {
    const m = new Map();
    return { m, bump(key, t, hit) { let c = m.get(key); if (!c) m.set(key, (c = [0, 0, 0, 0, 0, 0])); const p = t < cutA ? 0 : t < cutB ? 2 : 4; c[p]++; if (hit) c[p + 1]++; } };
  }
  // the side is fixed on the older part; the rate is measured on the newer part (one-sided: > 50%)
  function judge(c, minT = 100, minO = 50) {
    const [nT, kT, n1, k1, n2, k2] = c, nO = n1 + n2;
    if (nT < minT || nO < minO) return null;
    const yes = kT * 2 >= nT, w = (n, k) => (yes ? k : n - k), wO = w(n1, k1) + w(n2, k2), [lo, hi] = wilson(wO, nO), [tLo] = wilson(w(nT, kT), nT);
    return { yes, n: nO, stat: pct(wO, nO), effect: +((100 * wO) / nO - 50).toFixed(2), lo, hi, p: p1((wO - nO / 2 - 0.5) / Math.sqrt(nO / 4)),
      train: { n: nT, rate: pct(w(nT, kT), nT), lo: tLo }, oos: { n: nO, rate: pct(wO, nO) }, halves: [pct(w(n1, k1), n1), pct(w(n2, k2), n2)] };
  }

  // ── data: integrity report, then contiguous returns ─────────────────────────
  function quality(per, tf) {
    const pairs = {};
    let all = 0, gaps = 0, missing = 0, flat = 0, invalid = 0, jumps = 0, misaligned = 0, dups = 0, from = Infinity, to = -Infinity, step = Infinity;
    for (const [a, cs0] of Object.entries(per)) {
      const cs = [...cs0].sort((x, y) => x.time - y.time);
      if (!cs.length) continue;
      let g = 0, miss = 0, fl = 0, inv = 0, mis = 0, dup = 0, run = 0;
      const abs = [];
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        if (!(c.open > 0 && c.close > 0 && c.high >= Math.max(c.open, c.close) - 1e-12 && c.low <= Math.min(c.open, c.close) + 1e-12)) inv++;
        if (c.time % tf) mis++;
        if (!i) continue;
        const d = c.time - cs[i - 1].time;
        if (d === 0) { dup++; continue; }
        if (d > tf) { g++; miss += Math.round(d / tf) - 1; }
        const mv = Math.abs(c.close - cs[i - 1].close);
        if (d === tf) abs.push(mv);
        if (mv > 0 && mv < step) step = mv;
        run = mv === 0 ? run + 1 : 0;
        if (run === 10) fl++;
      }
      abs.sort((x, y) => x - y);
      const mad = (abs[Math.floor(abs.length / 2)] || 0) * 1.4826;
      let jp = 0;
      if (mad) for (let i = 1; i < cs.length; i++) if (cs[i].time - cs[i - 1].time === tf && Math.abs(cs[i].close - cs[i - 1].close) > 10 * mad) jp++;
      const span = cs[cs.length - 1].time - cs[0].time;
      pairs[a] = { candles: cs.length - dup, from: cs[0].time, to: cs[cs.length - 1].time, hours: +(span / 3600).toFixed(1), coverage: span ? +Math.min(100, (100 * (cs.length - dup) * tf) / (span + tf)).toFixed(1) : 100,
        gaps: g, missing: miss, duplicates: dup, flatRuns: fl, invalid: inv, jumps10: jp, misaligned: mis };
      all += cs.length - dup; gaps += g; missing += miss; flat += fl; invalid += inv; jumps += jp; misaligned += mis; dups += dup;
      from = Math.min(from, cs[0].time); to = Math.max(to, cs[cs.length - 1].time);
    }
    return { tf, pairs: Object.keys(pairs).length, candles: all, from: Number.isFinite(from) ? from : null, to: Number.isFinite(to) ? to : null, hours: Number.isFinite(from) ? +((to - from) / 3600).toFixed(1) : 0,
      duplicates: dups, gaps, missing, flatRuns: flat, invalid, jumps10: jumps, misaligned, minStep: Number.isFinite(step) ? step : null,
      completeness: all + missing ? +((100 * all) / (all + missing)).toFixed(1) : null, clock: 'UTC seconds (PO shows ≈ UTC+2h)', perPair: pairs };
  }

  // the time that splits the older 60% from the newer 40% (and the newer part in halves), over all candles of a frame
  function cutsOf(per) {
    const ts = [];
    for (const cs of Object.values(per)) for (const c of cs) ts.push(c.time);
    if (!ts.length) return [Infinity, Infinity, Infinity];
    ts.sort((a, b) => a - b);
    return [ts[Math.floor(ts.length * 0.6)], ts[Math.floor(ts.length * 0.8)], ts[Math.floor(ts.length * 0.5)]];
  }

  // Contiguous segments of returns per pair in units of the pair's own std (measured on the older part only).
  // g.c[k + 1] is the candle whose move is g.r[k]; g.c1 / g.c2 are running sums of moves and squared moves.
  function prepare(per, tf, cut = Infinity) {
    const out = [];
    for (const [a, cs0] of Object.entries(per)) {
      const cs = [...cs0].sort((x, y) => x.time - y.time);
      const raw = [], rawAll = [];
      for (let i = 1; i < cs.length; i++) if (cs[i].time - cs[i - 1].time === tf) { const d = cs[i].close - cs[i - 1].close; rawAll.push(d); if (cs[i].time < cut) raw.push(d); }
      const s = sd(raw.length >= 100 ? raw : rawAll) || 1;
      let seg = null;
      for (let i = 1; i < cs.length; i++) {
        if (cs[i].time - cs[i - 1].time !== tf) { seg = null; continue; }
        if (!seg) { seg = { a, t: [], r: [], c: [cs[i - 1]] }; out.push(seg); }
        seg.t.push(cs[i].time); seg.r.push((cs[i].close - cs[i - 1].close) / s); seg.c.push(cs[i]);
      }
    }
    for (const g of out) { g.c1 = [0]; g.c2 = [0]; for (const x of g.r) { g.c1.push(g.c1[g.c1.length - 1] + x); g.c2.push(g.c2[g.c2.length - 1] + x * x); } }
    return out.filter((g) => g.r.length >= 30);
  }

  // ── the audit ──────────────────────────────────────────────────────────────
  // Every hypothesis is a row: { id, family, label, tf, h (candles ahead), directional, n, stat, effect, lo, hi, p,
  // train?, oos?, halves? }. Directional rows are about the NEXT direction (could make money); the others
  // (volatility, shape) cannot be traded with up/down options on their own.
  function audit(input, o = {}) {
    const { payouts = PAYOUTS, hs = { 5: [1, 2, 3, 6, 12, 24, 60], 60: [1, 2, 5] }, nulls = true, selfNull = true, cross = true, evidence = true, shouldStop = null, onProgress = null } = o;
    const say = (t) => onProgress?.(t);
    const rows = [], t0 = Date.now();
    const add = (row) => { rows.push(row); return row; };
    const dataset = {}, keep = {};
    for (const tf of [5, 60]) {
      const per = (tf === 5 ? input.per5 : input.per1) || {};
      dataset[tf] = quality(per, tf);
      if (shouldStop?.()) return null;
      const [cutA, cutB, mid] = cutsOf(per), segs = prepare(per, tf, cutA), name = tf === 5 ? '5s' : '1M';
      dataset[tf].split = { trainUntil: Number.isFinite(cutA) ? cutA : null, halfAt: Number.isFinite(cutB) ? cutB : null };
      const n0 = segs.reduce((s, x) => s + x.r.length, 0);
      dataset[tf].returns = n0;
      keep[tf] = segs;
      if (n0 < 2000) continue;
      const ctx = { tf, segs, cutA, cutB, mid, H: hs[tf], add };
      say(`${name}: memory…`); memory(ctx);
      say(`${name}: conditional behaviour…`); conditional(ctx);
      say(`${name}: volatility & distribution…`); volatility(ctx, dataset[tf]);
      say(`${name}: time & candle position…`); timing(ctx);
      say(`${name}: stability over time…`); breaks(ctx, dataset[tf]);
      say(`${name}: market-state features…`); features(ctx);
      if (shouldStop?.()) return null;
    }
    if (cross && keep[5]?.length) { say('cross-pair…'); crossPair(keep[5], cutsOf(input.per5 || {}), add); }
    if (evidence) { say('copy trading, platform signals, entries, expiries…'); evidenceTests(input, keep[5] || [], add); }

    // multiple testing: within each family (the decision rule) and over everything (reported)
    for (const f of new Set(rows.map((r) => r.family))) { const rs = rows.filter((r) => r.family === f), q = bhq(rs.map((r) => r.p)); rs.forEach((r, i) => { r.q = q[i]; }); }
    const qAll = bhq(rows.map((r) => r.p));
    rows.forEach((r, i) => { r.qAll = qAll[i]; r.significant = r.q < 0.05; r.nominal = (r.p ?? 1) < 0.05; });
    const be = breakEven(Math.max(...payouts));
    for (const r of rows) classify(r, be);
    const count = (f) => rows.filter(f).length;
    const tests = { total: rows.length, directional: count((r) => r.directional), nominal: count((r) => r.nominal), nominalDirectional: count((r) => r.nominal && r.directional),
      expectedByChance: Math.round(rows.length * 0.05), significant: count((r) => r.significant), significantDirectional: count((r) => r.significant && r.directional),
      significantGlobal: count((r) => r.qAll < 0.05), byStatus: {}, byFamily: {} };
    for (const r of rows) {
      tests.byStatus[r.status] = (tests.byStatus[r.status] || 0) + 1;
      const f = (tests.byFamily[r.family] ||= { tests: 0, nominal: 0, significant: 0, best: null });
      f.tests++; if (r.nominal) f.nominal++; if (r.significant) f.significant++;
      if (r.directional && r.oos && r.n >= 200 && (!f.best || r.oos.rate > f.best.oos.rate)) f.best = slim(r);
    }

    // the null tests
    let noise = null, engines = null;
    if (selfNull && !shouldStop?.()) {
      noise = {};
      const real = rows.filter((r) => r.directional && !EVIDENCE.has(r.family) && r.family !== 'cross-pair');
      for (const [m, seed] of [['permutation', 11], ['gauss', 12]]) {
        say(`null test: the same audit on ${m} noise…`);
        const sub = audit({ per5: synth(input.per5 || {}, 5, m, seed), per1: synth(input.per1 || {}, 60, m, seed + 50) }, { ...o, nulls: false, selfNull: false, cross: false, evidence: false, onProgress: null });
        if (!sub) break;
        const best = (rs) => Math.max(0, ...rs.filter((r) => r.oos && r.n >= 200).map((r) => r.oos.rate));
        noise[m] = { tests: sub.tests.directional, nominal: sub.tests.nominalDirectional, significant: sub.tests.significantDirectional, bestOos: best(sub.rows),
          otc: { tests: real.length, nominal: real.filter((r) => r.nominal).length, significant: real.filter((r) => r.significant).length, bestOos: best(real) } };
      }
    }
    if (nulls && !shouldStop?.()) { say('null test: similarity & discovery on synthetic noise…'); engines = runNulls(input, { shouldStop, say }); }

    // economics: break-even per payout, and the best out-of-sample result per horizon priced
    const economics = payouts.map((P) => ({ payout: P, breakEven: +breakEven(P).toFixed(3) }));
    const best = {};
    // one per trade duration (seconds), whatever produced it
    for (const r of rows.filter((x) => x.directional && x.oos && x.h && x.n >= 200)) { const k = r.tf === 1 ? r.h : r.h * r.tf; if (!best[k] || r.oos.rate > best[k].oos.rate) best[k] = r; }
    const bestByHorizon = Object.entries(best).map(([k, r]) => ({ ...slim(r), sec: +k, ev: Object.fromEntries(payouts.map((P) => [P, ev(r.oos.rate, P)])) })).sort((a, b) => a.sec - b.sec);

    const verdict = decide(rows, dataset, noise, engines, payouts);
    return { version: VERSION, builtAt: Date.now(), secs: +((Date.now() - t0) / 1000).toFixed(1), dataset, tests, rows, noise, engines, economics, bestByHorizon, verdict };
  }
  const EVIDENCE = new Set(['copy', 'platform-signal', 'entry-timing', 'expiry', 'after-entry']);
  const slim = (r) => ({ id: r.id, family: r.family, label: r.label, tf: r.tf, h: r.h, n: r.n, oos: r.oos, halves: r.halves, train: r.train, lo: r.lo, p: r.p, q: r.q, status: r.status });

  // T1–T4: memory in the direction of moves
  function memory({ tf, segs, cutA, cutB, mid, H, add }) {
    // autocorrelation of moves, move sizes, squared moves at lags 1…60; also in each half of the time range
    for (const kind of ['raw', 'abs', 'sq']) {
      const tr = kind === 'raw' ? (x) => x : kind === 'abs' ? Math.abs : (x) => x * x;
      let s = 0, n = 0; for (const g of segs) for (const x of g.r) { s += tr(x); n++; }
      const mu = s / n; let v = 0; for (const g of segs) for (const x of g.r) v += (tr(x) - mu) ** 2; v /= n;
      for (const lag of [1, 2, 3, 5, 10, 20, 30, 60]) {
        const acc = [[0, 0], [0, 0]];
        for (const g of segs) for (let i = lag; i < g.r.length; i++) { const a = acc[g.t[i] < mid ? 0 : 1]; a[0] += (tr(g.r[i]) - mu) * (tr(g.r[i - lag]) - mu); a[1]++; }
        const N = acc[0][1] + acc[1][1];
        if (N < 500) continue;
        const rho = (acc[0][0] + acc[1][0]) / N / v, se = 1 / Math.sqrt(N), half = acc.map(([x, k]) => (k ? +(x / k / v).toFixed(4) : null));
        add({ id: `acf.${kind}.${tf}.${lag}`, family: kind === 'raw' ? 'memory' : 'volatility', label: `autocorrelation of ${kind === 'raw' ? 'moves' : kind === 'abs' ? 'move sizes' : 'squared moves'}, lag ${lag}`,
          tf, h: lag, directional: kind === 'raw', n: N, stat: +rho.toFixed(4), ci: [+(rho - 1.96 * se).toFixed(4), +(rho + 1.96 * se).toFixed(4)],
          // for normal moves a correlation ρ means a sign hit rate of 50 + 100·asin(ρ)/π %
          effect: kind === 'raw' ? +((100 * Math.asin(Math.max(-1, Math.min(1, rho)))) / Math.PI).toFixed(3) : +rho.toFixed(4), p: p2(rho / se), halvesRho: half,
          sameSign: kind === 'raw' ? half.every((x) => x != null && Math.sign(x) === Math.sign(rho)) : undefined });
      }
    }
    // per pair: lag-1 autocorrelation and the runs test; runs by volatility regime
    const byA = new Map(); for (const g of segs) (byA.get(g.a) || byA.set(g.a, []).get(g.a)).push(g);
    const g0 = runs(segs.map((g) => g.r));
    if (g0) add({ id: `runs.${tf}`, family: 'memory', label: 'runs test, all pairs (more runs = more reversals)', tf, h: 1, directional: true, n: g0.n, stat: g0.R, effect: +((100 * (g0.R - g0.E)) / g0.E).toFixed(3), p: p2(g0.z) });
    for (const [a, gs] of byA) {
      let s = 0, n = 0; for (const x of gs) for (let i = 1; i < x.r.length; i++) { s += x.r[i] * x.r[i - 1]; n++; }
      if (n < 500) continue;
      const rho = s / n;
      add({ id: `acf.pair.${tf}.${a}`, family: 'memory', label: `${a}: lag-1 autocorrelation`, tf, h: 1, directional: true, n, stat: +rho.toFixed(4), effect: +((100 * Math.asin(Math.max(-1, Math.min(1, rho)))) / Math.PI).toFixed(3), p: p2(rho * Math.sqrt(n)), asset: a });
      const r = runs(gs.map((x) => x.r));
      if (r) add({ id: `runs.pair.${tf}.${a}`, family: 'memory', label: `${a}: runs test`, tf, h: 1, directional: true, n: r.n, stat: r.R, effect: +((100 * (r.R - r.E)) / r.E).toFixed(3), p: p2(r.z), asset: a });
    }
    for (const reg of ['low', 'mid', 'high']) {
      const sub = [];
      for (const x of segs) { let cur = null; for (let i = 59; i < x.r.length; i++) { if (volRegime(x, i) === reg) { if (!cur) sub.push((cur = [])); cur.push(x.r[i]); } else cur = null; } }
      const r = runs(sub);
      if (r && r.n >= 500) add({ id: `runs.vol.${tf}.${reg}`, family: 'regime', label: `runs test in ${reg} volatility`, tf, h: 1, directional: true, n: r.n, stat: r.R, effect: +((100 * (r.R - r.E)) / r.E).toFixed(3), p: p2(r.z) });
    }
    // transition matrices: the next direction (over h candles, without overlap) given the last k directions
    for (const h of H) {
      for (const k of h === 1 ? [1, 2, 3, 4, 5] : [1, 2, 3]) {
        const T = tally(cutA, cutB);
        samples(segs, h, (g, i, d) => {
          if (i < k - 1) return;
          let key = '';
          for (let j = i - k + 1; j <= i; j++) { const v = sgn(g.r[j]); if (!v) return; key += v > 0 ? 'U' : 'D'; }
          T.bump(key, g.t[i], d > 0);
        });
        homogeneity(T, `trans.${tf}.k${k}.h${h}`, 'memory', `the next ${h > 1 ? `${h} candles depend` : 'candle depends'} on the last ${k} directions (chi-square over all patterns)`, tf, h, add);
        for (const [key, c] of T.m) { const j = judge(c); if (j) add({ id: `pat.${tf}.${key}.h${h}`, family: 'memory', label: `after ${key} → ${j.yes ? 'UP' : 'DOWN'}`, tf, h, directional: true, ...j }); }
      }
      // how many of the last 10 moves were up
      const B = tally(cutA, cutB);
      samples(segs, h, (g, i, d) => { if (i < 9) return; let u = 0; for (let j = i - 9; j <= i; j++) if (g.r[j] > 0) u++; B.bump(u, g.t[i], d > 0); });
      for (const [u, c] of B.m) { const j = judge(c); if (j) add({ id: `ups10.${tf}.${u}.h${h}`, family: 'memory', label: `${u} of the last 10 moves up → ${j.yes ? 'UP' : 'DOWN'}`, tf, h, directional: true, ...j }); }
    }
  }
  // Wald–Wolfowitz runs test summed over independent series
  function runs(series) {
    let R0 = 0, E = 0, V = 0, n = 0;
    for (const r of series) {
      const x = r.map(sgn).filter(Boolean); if (x.length < 20) continue;
      let np = 0; for (const v of x) if (v > 0) np++;
      const nn = x.length - np, m = x.length; let k = 1; for (let i = 1; i < m; i++) if (x[i] !== x[i - 1]) k++;
      R0 += k; E += 1 + (2 * np * nn) / m; V += (2 * np * nn * (2 * np * nn - m)) / (m * m * (m - 1)); n += m;
    }
    return V > 0 ? { R: R0, E, z: (R0 - E) / Math.sqrt(V), n } : null;
  }

  // chi-square: does the up-rate differ between keys (all parts)
  function homogeneity(T, id, family, label, tf, h, add) {
    let N = 0, U = 0;
    for (const [, c] of T.m) { N += c[0] + c[2] + c[4]; U += c[1] + c[3] + c[5]; }
    if (N < 500) return;
    const pu = U / N; let chi = 0, used = 0;
    for (const [, c] of T.m) { const n = c[0] + c[2] + c[4], u = c[1] + c[3] + c[5]; if (n < 20) continue; used++; chi += ((u - n * pu) ** 2) / (n * pu * (1 - pu) || 1); }
    if (used > 1) add({ id, family, label, tf, h, directional: true, n: N, stat: +chi.toFixed(2), effect: null, p: chi2p(chi, used - 1), df: used - 1 });
  }

  // samples every h candles per segment (outcomes never overlap); d = direction of the next h candles
  function samples(segs, h, fn) {
    for (const g of segs) for (let i = 0; i + h < g.r.length; i += h) { const d = sgn(g.c1[i + h + 1] - g.c1[i + 1]); if (d) fn(g, i, d); }
  }
  // regime at i from information up to i only (σ of the last 12 vs the last 60 moves; 12-candle drift)
  function volRegime(g, i) {
    if (i < 59) return null;
    const v12 = (g.c2[i + 1] - g.c2[i - 11]) / 12, v60 = (g.c2[i + 1] - g.c2[i - 59]) / 60, r = Math.sqrt(v12 / (v60 || 1e-12));
    return r < 0.8 ? 'low' : r < 1.2 ? 'mid' : 'high';
  }
  function regimeAt(g, i) {
    if (i < 59) return null;
    const v12 = (g.c2[i + 1] - g.c2[i - 11]) / 12, v60 = (g.c2[i + 1] - g.c2[i - 59]) / 60, r = Math.sqrt(v12 / (v60 || 1e-12)), m12 = g.c1[i + 1] - g.c1[i - 11];
    return { vol: r < 0.8 ? 'low' : r < 1.2 ? 'mid' : 'high', shape: Math.abs(m12) / Math.sqrt(12) > 1 ? 'trending' : 'ranging', speed: Math.abs(g.r[i]) > 1 ? 'fast' : 'slow',
      width: r < 0.7 ? 'compression' : r > 1.3 ? 'expansion' : 'normal width', level: Math.sqrt(v60) < 0.8 ? 'quiet hour' : Math.sqrt(v60) > 1.2 ? 'busy hour' : 'normal hour', m12: sgn(m12) };
  }
  const SIZE = (a) => (a < 0.25 ? 'very small' : a < 0.6 ? 'small' : a < 1.1 ? 'medium' : a < 2 ? 'large' : a < 3 ? 'very large' : 'extreme (≥3σ)');

  // T6, T8, T14: after a move of each size; inside each regime
  function conditional({ tf, segs, cutA, cutB, H, add }) {
    for (const h of H) {
      const S = tally(cutA, cutB), RG = tally(cutA, cutB);
      samples(segs, h, (g, i, d) => {
        const v = sgn(g.r[i]);
        if (v) S.bump(SIZE(Math.abs(g.r[i])), g.t[i], d === v);
        const x = regimeAt(g, i); if (!x) return;
        for (const key of [`volatility ${x.vol}`, x.shape, `${x.speed} last move`, x.width, x.level]) {
          if (v) RG.bump(`${key}|last`, g.t[i], d === v);
          if (x.m12) RG.bump(`${key}|12`, g.t[i], d === x.m12);
        }
      });
      for (const [b, c] of S.m) { const j = judge(c); if (j) add({ id: `size.${tf}.${b}.h${h}`, family: b.startsWith('extreme') ? 'extremes' : 'conditional', label: `after a ${b} move → ${j.yes ? 'continues' : 'reverses'}`, tf, h, directional: true, ...j }); }
      for (const [key, c] of RG.m) { const j = judge(c); const [reg, what] = key.split('|'); if (j) add({ id: `regime.${tf}.${key}.h${h}`, family: 'regime', label: `${reg}: ${what === 'last' ? 'the last move' : 'the last 12 candles'} ${j.yes ? 'continue' : 'reverse'}`, tf, h, directional: true, ...j }); }
    }
    // extremes: what comes before (was it building up?) and how far it carries
    const ex = [];
    for (const g of segs) for (let i = 12; i + 12 < g.r.length; i++) if (Math.abs(g.r[i]) >= 3) ex.push({ g, i });
    if (ex.length >= 30) {
      const before = ex.map(({ g, i }) => Math.sqrt((g.c2[i] - g.c2[i - 12]) / 12)), after = ex.map(({ g, i }) => Math.sign(g.r[i]) * (g.c1[i + 13] - g.c1[i + 1]));
      add({ id: `extreme.before.${tf}`, family: 'extremes', label: 'volatility in the 12 candles before a ≥3σ move (1.0 = normal)', tf, h: 12, directional: false, n: ex.length, stat: +mean(before).toFixed(3), effect: +(mean(before) - 1).toFixed(3), p: p2((mean(before) - 1) / (sd(before) / Math.sqrt(ex.length) || 1)) });
      add({ id: `extreme.after.${tf}`, family: 'extremes', label: 'the 12 candles after a ≥3σ move carry it on (σ; + = continue)', tf, h: 12, directional: true, n: ex.length, stat: +mean(after).toFixed(3), effect: +mean(after).toFixed(3), p: p2(mean(after) / (sd(after) / Math.sqrt(ex.length) || 1)) });
    }
  }

  // T5–T8: volatility clustering, the distribution, conditional size
  function volatility({ tf, segs, mid, add }, ds) {
    const bins = new Map();
    for (const g of segs) for (let i = 0; i + 1 < g.r.length; i++) { const b = SIZE(Math.abs(g.r[i])); (bins.get(b) || bins.set(b, []).get(b)).push(Math.abs(g.r[i + 1])); }
    const all = [...bins.values()].flat(), m = mean(all), v = sd(all);
    for (const [b, xs] of bins) if (xs.length >= 200) add({ id: `volafter.${tf}.${b}`, family: 'volatility', label: `size of the next move after a ${b} move (vs average)`, tf, h: 1, directional: false, n: xs.length, stat: +mean(xs).toFixed(3), effect: +((mean(xs) / m - 1) * 100).toFixed(2), p: p2((mean(xs) - m) / (v / Math.sqrt(xs.length))) });
    const a = [], b = [];
    for (const g of segs) for (let i = 0; i + 24 <= g.r.length; i += 12) { a.push(Math.sqrt((g.c2[i + 12] - g.c2[i]) / 12)); b.push(Math.sqrt((g.c2[i + 24] - g.c2[i + 12]) / 12)); }
    if (a.length >= 200) { const c = corr(a, b); add({ id: `volpersist.${tf}`, family: 'volatility', label: 'volatility of one 12-candle window carries into the next', tf, h: 12, directional: false, n: a.length, stat: +c.toFixed(4), effect: +c.toFixed(4), p: p2(c * Math.sqrt(a.length)) }); }
    let n = 0, s1 = 0, s2 = 0; for (const g of segs) for (const x of g.r) { n++; s1 += x; s2 += x * x; }
    const mu = s1 / n, s = Math.sqrt(s2 / n - mu * mu);
    let sk = 0, ku = 0, up = 0, dn = 0, b4 = 0, upS = 0, dnS = 0, upS2 = 0, dnS2 = 0;
    const sorted = new Float64Array(n); let k = 0;
    for (const g of segs) for (const x of g.r) { sorted[k++] = x; const z = (x - mu) / s; sk += z ** 3; ku += z ** 4; if (x > 0) { up++; upS += x; upS2 += x * x; } else if (x < 0) { dn++; dnS -= x; dnS2 += x * x; } if (Math.abs(z) > 4) b4++; }
    sk /= n; ku /= n; sorted.sort();
    const q = (p) => +sorted[Math.min(n - 1, Math.floor(p * n))].toFixed(3), jb = (n / 6) * (sk * sk + ((ku - 3) ** 2) / 4);
    ds.distribution = { n, mean: +mu.toFixed(5), median: q(0.5), std: +s.toFixed(4), skew: +sk.toFixed(3), kurtosis: +ku.toFixed(2), zeroShare: +((n - up - dn) / n).toFixed(4),
      p1: q(0.01), p5: q(0.05), p25: q(0.25), p75: q(0.75), p95: q(0.95), p99: q(0.99), beyond4sd: b4, normalBeyond4sd: +(n * 6.3e-5).toFixed(1), jarqueBera: +jb.toFixed(1) };
    add({ id: `dist.up.${tf}`, family: 'distribution', label: 'more moves up than down', tf, h: 1, directional: true, n: up + dn, stat: pct(up, up + dn), effect: +(pct(up, up + dn) - 50).toFixed(2), p: p2((up - (up + dn) / 2) / Math.sqrt((up + dn) / 4)) });
    add({ id: `dist.mean.${tf}`, family: 'distribution', label: 'average move differs from zero (drift)', tf, h: 1, directional: true, n, stat: +mu.toFixed(5), effect: +mu.toFixed(5), p: p2(mu / (s / Math.sqrt(n))) });
    if (up > 100 && dn > 100) {
      const mu1 = upS / up, mu2 = dnS / dn, v1 = upS2 / up - mu1 * mu1, v2 = dnS2 / dn - mu2 * mu2;
      add({ id: `dist.asym.${tf}`, family: 'distribution', label: 'up moves bigger or smaller than down moves', tf, h: 1, directional: false, n, stat: +(mu1 - mu2).toFixed(4), effect: +(mu1 - mu2).toFixed(4), p: p2((mu1 - mu2) / Math.sqrt(v1 / up + v2 / dn)) });
    }
    const hv = [[0, 0], [0, 0]]; for (const g of segs) g.r.forEach((x, i) => { if (!x) return; const p = hv[g.t[i] < mid ? 0 : 1]; p[0]++; if (x > 0) p[1]++; });
    ds.distribution.upByHalf = hv.map(([nn, kk]) => pct(kk, nn));
  }

  // T9–T10: time of day / minute / second, and the 5s slots inside the minute
  function timing({ tf, segs, cutA, cutB, add }) {
    const parts = tf === 5 ? [['second of the minute', (t) => (t % 60) / 5, 12], ['minute of the hour', (t) => Math.floor((t % 3600) / 60), 60], ['hour (UTC)', (t) => Math.floor((t % 86400) / 3600), 24], ['weekday', (t) => new Date(t * 1000).getUTCDay(), 7]]
      : [['minute of the hour', (t) => Math.floor((t % 3600) / 60), 60], ['hour (UTC)', (t) => Math.floor((t % 86400) / 3600), 24], ['weekday', (t) => new Date(t * 1000).getUTCDay(), 7]];
    for (const [pname, f, nb] of parts) {
      const b = Array.from({ length: nb }, () => ({ n: 0, u: 0, a: 0, a2: 0 })), T = tally(cutA, cutB);
      for (const g of segs) for (let i = 0; i < g.r.length; i++) { const v = sgn(g.r[i]); if (!v) continue; const k = f(g.t[i]), x = b[k]; x.n++; if (v > 0) x.u++; const A = Math.abs(g.r[i]); x.a += A; x.a2 += A * A; T.bump(k, g.t[i], v > 0); }
      const N = b.reduce((x, y) => x + y.n, 0); if (!N) continue;
      const U = b.reduce((x, y) => x + y.u, 0), pu = U / N, A = b.reduce((x, y) => x + y.a, 0) / N, sA = Math.sqrt(b.reduce((x, y) => x + y.a2, 0) / N - A * A);
      const name = (k) => `${pname} ${tf === 5 && pname.startsWith('second') ? k * 5 : k}`;
      let chi = 0, used = 0;
      b.forEach((x, k) => {
        if (x.n < 100) return;
        used++; chi += ((x.u - x.n * pu) ** 2) / (x.n * pu * (1 - pu));
        const j = judge(T.m.get(k) || [0, 0, 0, 0, 0, 0], 50, 50);
        add({ id: `time.${tf}.${pname}.${k}`, family: 'time', label: `${name(k)}: ${j ? (j.yes ? 'UP' : 'DOWN') : 'direction'}`, tf, h: 1, directional: true,
          ...(j || { n: x.n, stat: pct(x.u, x.n), effect: +(pct(x.u, x.n) - 50).toFixed(2), p: p2((x.u - x.n / 2) / Math.sqrt(x.n / 4)) }), all: { n: x.n, up: pct(x.u, x.n) } });
        add({ id: `timevol.${tf}.${pname}.${k}`, family: 'volatility', label: `${name(k)}: size of moves (vs average, %)`, tf, h: 1, directional: false, n: x.n, stat: +(x.a / x.n).toFixed(3), effect: +((x.a / x.n / A - 1) * 100).toFixed(2), p: p2((x.a / x.n - A) / (sA / Math.sqrt(x.n))) });
      });
      if (used > 1) add({ id: `time.${tf}.${pname}`, family: 'time', label: `${pname}: up-rate differs between buckets (chi-square)`, tf, h: 1, directional: true, n: N, stat: +chi.toFixed(2), effect: null, p: chi2p(chi, used - 1), df: used - 1 });
    }
    if (tf === 5) {
      // inside the minute: does the 5s move continue the minute so far? the first 5 s of a minute vs the last minute
      const P = tally(cutA, cutB);
      for (const g of segs) for (let i = 12; i < g.r.length; i++) {
        const k = (g.t[i] % 60) / 5, v = sgn(g.r[i]); if (!v) continue;
        const ref = k === 0 ? sgn(g.c1[i] - g.c1[i - 12]) : sgn(g.c1[i] - g.c1[i - k]);
        if (!ref) continue;
        P.bump(k === 0 ? 'first 5 s of a new minute vs the last minute' : k <= 3 ? 'early in the minute vs the minute so far' : k <= 8 ? 'middle of the minute vs the minute so far' : 'late in the minute vs the minute so far', g.t[i], v === ref);
      }
      for (const [zone, c] of P.m) { const j = judge(c); if (j) add({ id: `candle.${zone}`, family: 'candle', label: `${zone}: ${j.yes ? 'continues' : 'reverses'}`, tf, h: 1, directional: true, ...j }); }
    } else {
      // the previous 1M candle's shape (body share, wicks) → the next minute
      const S = tally(cutA, cutB);
      for (const g of segs) for (let i = 0; i + 1 < g.r.length; i++) {
        const c = g.c[i + 1], rg = c.high - c.low, v = sgn(g.r[i + 1]); if (!(rg > 0) || !v) continue;
        const body = (c.close - c.open) / rg, upw = (c.high - Math.max(c.open, c.close)) / rg, low = (Math.min(c.open, c.close) - c.low) / rg;
        if (sgn(body)) S.bump(`${Math.abs(body) >= 0.6 ? 'strong' : Math.abs(body) >= 0.2 ? 'medium' : 'doji'} body: the next minute goes its way`, g.t[i], v === sgn(body));
        S.bump(`${upw >= 0.5 ? 'long' : 'short'} upper wick: the next minute goes down`, g.t[i], v < 0);
        S.bump(`${low >= 0.5 ? 'long' : 'short'} lower wick: the next minute goes up`, g.t[i], v > 0);
      }
      for (const [key, c] of S.m) { const j = judge(c); if (j) add({ id: `shape.${key}`, family: 'candle', label: `1M candle, ${key} → ${j.yes ? 'yes' : 'the opposite'}`, tf, h: 1, directional: true, ...j }); }
    }
  }

  // T32: four chronological periods (A–D)
  function breaks({ tf, segs, add }, ds) {
    const ts = segs.flatMap((g) => g.t).sort((a, b) => a - b), q = [0.25, 0.5, 0.75].map((x) => ts[Math.floor(x * ts.length)]);
    const per = Array.from({ length: 4 }, () => ({ n: 0, u: 0, same: 0, pairs: 0, a: 0, from: null, to: null }));
    for (const g of segs) for (let i = 0; i < g.r.length; i++) {
      const k = g.t[i] < q[0] ? 0 : g.t[i] < q[1] ? 1 : g.t[i] < q[2] ? 2 : 3, v = sgn(g.r[i]); if (!v) continue;
      const x = per[k]; x.n++; if (v > 0) x.u++; x.a += Math.abs(g.r[i]);
      if (x.from == null || g.t[i] < x.from) x.from = g.t[i];
      if (x.to == null || g.t[i] > x.to) x.to = g.t[i];
      if (i && sgn(g.r[i - 1])) { x.pairs++; if (sgn(g.r[i - 1]) === v) x.same++; }
    }
    ds.periods = per.map((x, k) => ({ period: 'ABCD'[k], from: x.from, to: x.to, n: x.n, up: pct(x.u, x.n), continuation: pct(x.same, x.pairs), size: +(x.a / Math.max(1, x.n)).toFixed(3) }));
    for (const [key, k, n] of [['up-rate', 'u', 'n'], ['continuation rate', 'same', 'pairs']]) {
      const tot = per.reduce((s, x) => s + x[n], 0); if (tot < 1000) continue;
      const P = per.reduce((s, x) => s + x[k], 0) / tot, chi = per.reduce((s, x) => s + ((x[k] - x[n] * P) ** 2) / (x[n] * P * (1 - P) || 1), 0);
      add({ id: `break.${tf}.${key}`, family: 'stability', label: `${key} changes between periods A–D`, tf, h: 1, directional: true, n: tot, stat: +chi.toFixed(2), effect: null, p: chi2p(chi, 3), df: 3 });
    }
  }

  // T15–T16: MarketState features (engine/research.js): bins fixed on the older part, each bin's side chosen there,
  // the combined rule measured on the newer part; mutual information (bits) on the older part
  function features({ tf, segs, cutA, cutB, H, add }) {
    const st = [], total = segs.reduce((s, x) => s + x.r.length, 0), step = Math.max(1, Math.floor(total / 60000));
    for (const g of segs) for (let i = R.DEFAULTS.W; i < g.c.length; i += step) {
      const x = R.stateAt(g.c, i, tf);
      if (!x) continue;
      st.push({ t: g.c[i].time, f: x.f, fut: H.map((h) => (i + h < g.c.length ? sgn(g.c[i + h].close - g.c[i].close) : 0)), a: g.a });
    }
    if (st.length < 2000) return;
    for (const key of Object.keys(st[0].f)) {
      const sample = st.find((x) => x.f[key] != null)?.f[key];
      let binOf;
      if (typeof sample === 'number') {
        const tr = st.filter((x) => x.t < cutA && Number.isFinite(x.f[key])).map((x) => x.f[key]).sort((a, b) => a - b);
        if (tr.length < 500) continue;
        const qs = [...new Set([0.2, 0.4, 0.6, 0.8].map((q) => tr[Math.floor(q * tr.length)]))];
        binOf = (v) => (Number.isFinite(v) ? qs.filter((q) => v > q).length : null);
      } else binOf = (v) => (v == null ? null : String(v));
      H.forEach((h, hi) => {
        const T = tally(cutA, cutB), busy = new Map();
        for (const x of st) {
          const b = binOf(x.f[key]), d = x.fut[hi]; if (b == null || !d) continue;
          if (x.t < (busy.get(x.a) ?? -Infinity)) continue; // outcomes of one pair must not overlap
          busy.set(x.a, x.t + h * tf);
          T.bump(b, x.t, d > 0);
        }
        let N = 0, U = 0; for (const [, c] of T.m) { N += c[0]; U += c[1]; }
        if (N < 500) return;
        const pu = U / N; let mi = 0;
        for (const [, c] of T.m) { const n = c[0], u = c[1]; if (!n) continue; for (const [k2, pk] of [[u, pu], [n - u, 1 - pu]]) if (k2 > 0 && pk > 0) mi += (k2 / N) * Math.log2(k2 / n / pk); }
        // the combined rule: every bin with ≥ 50 older samples trades the side it showed there
        const agg = [0, 0, 0, 0, 0, 0];
        for (const [, c] of T.m) { if (c[0] < 50) continue; const yes = c[1] * 2 >= c[0]; for (const p of [0, 2, 4]) { agg[p] += c[p]; agg[p + 1] += yes ? c[p + 1] : c[p] - c[p + 1]; } }
        const j = judge(agg, 200, 200);
        if (j) add({ id: `feat.${tf}.${key}.h${h}`, family: 'features', label: `market-state feature "${key}" (each bin its own side) → next ${h} candle${h > 1 ? 's' : ''}`, tf, h, directional: true, ...j, yes: undefined, mi: +mi.toFixed(6) });
      });
    }
  }

  // T11–T13: cross-pair — Pearson, Spearman, |moves| at lags 0…10 both ways; an out-of-sample lead-lag rule
  function crossPair(segs, [cutA, cutB], add) {
    const byA = {};
    for (const g of segs) { const m = (byA[g.a] ||= new Map()); g.t.forEach((t, i) => m.set(t, g.r[i])); }
    const A = Object.keys(byA).filter((a) => byA[a].size >= 1500);
    // Spearman = Pearson on ranks; each pair's moves ranked once
    const rk = {};
    for (const a of A) { const e = [...byA[a].entries()].sort((x, y) => x[1] - y[1]); const m = new Map(); e.forEach(([t], k) => m.set(t, (k + 0.5) / e.length)); rk[a] = m; }
    for (let i = 0; i < A.length; i++) for (let j = 0; j < A.length; j++) {
      if (i === j) continue;
      const ra = byA[A[i]], rb = byA[A[j]], qa = rk[A[i]], qb = rk[A[j]];
      for (const lag of [0, 1, 2, 3, 5, 10]) {
        if (lag === 0 && i > j) continue; // the same moment: once per couple
        const xs = [], ys = [], us = [], vs = [], ax = [], ay = [], ts = [];
        for (const [t, x] of ra) { const y = rb.get(t + 5 * lag); if (y == null) continue; xs.push(x); ys.push(y); us.push(qa.get(t)); vs.push(qb.get(t + 5 * lag)); ax.push(Math.abs(x)); ay.push(Math.abs(y)); ts.push(t); }
        const n = xs.length;
        if (n < 500) continue;
        const c = corr(xs, ys), sp = corr(us, vs), ca = corr(ax, ay);
        const label = lag ? `${A[i]} now → ${A[j]} ${lag * 5}s later` : `${A[i]} ~ ${A[j]} at the same moment`;
        add({ id: `xp.${A[i]}.${A[j]}.${lag}`, family: 'cross-pair', label: `${label} (Pearson; Spearman ${sp.toFixed(3)})`, tf: 5, h: lag, directional: lag > 0, n, stat: +c.toFixed(4), effect: +c.toFixed(4), spearman: +sp.toFixed(4), p: p2(c * Math.sqrt(n)) });
        if (lag <= 1) add({ id: `xpvol.${A[i]}.${A[j]}.${lag}`, family: 'volatility', label: `${label}: move sizes correlate`, tf: 5, h: lag, directional: false, n, stat: +ca.toFixed(4), effect: +ca.toFixed(4), p: p2(ca * Math.sqrt(n)) });
        if (lag === 1) {
          // a tradable lead-lag rule: B's next move follows (or opposes) A's move — side from the older part
          const T = tally(cutA, cutB);
          for (let k = 0; k < n; k++) if (sgn(xs[k]) && sgn(ys[k])) T.bump('x', ts[k], sgn(xs[k]) === sgn(ys[k]));
          const jd = T.m.get('x') && judge(T.m.get('x'), 300, 200);
          if (jd) add({ id: `lead.${A[i]}.${A[j]}`, family: 'cross-pair', label: `${A[j]}'s next 5 s ${jd.yes ? 'follow' : 'oppose'} ${A[i]}'s last 5 s`, tf: 5, h: 1, directional: true, ...jd });
        }
      }
    }
  }

  // T27–T31: copy trading, PO's signals, entry timing, expiry, after-entry excursion — from the bot's own records
  const HSEC = new Set([3, 5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800]);
  function evidenceTests(input, segs5, add) {
    const opps = (input.opps || []).filter((r) => r.kind === 'opp' && r.tf === 1 && r.entryPrice != null && r.exits).sort((a, b) => a.ts - b.ts);
    const cut = (xs) => { const ts = xs.map((r) => r.ts).sort((a, b) => a - b); return [ts[Math.floor(ts.length * 0.6)] ?? Infinity, ts[Math.floor(ts.length * 0.8)] ?? Infinity]; };
    const won = (r, dir, a, b) => { const p0 = a == null ? r.entryPrice : r.exits[a], px = r.exits[b]; if (p0 == null || px == null || px === p0) return null; return (px > p0) === (dir === 'CALL'); };
    // one outcome at a time per pair (overlapping trades on one pair are one bet)
    const thin = (xs, secOf) => { const busy = new Map(), out = []; for (const r of xs) { if (r.ts < (busy.get(r.asset) ?? -Infinity)) continue; busy.set(r.asset, r.ts + secOf(r)); out.push(r); } return out; };
    // copy trading: following the signal (its side, its duration), by kind of signal. Nothing is chosen on the
    // data, so the whole sample is a test; the halves show whether it held over time
    const copies = thin(opps.filter((r) => r.origin === 'copy' && r.copy && r.expirySec && r.lean), (r) => r.expirySec);
    const [ca, cb] = cut(copies);
    const groups = [['every copy signal', () => true], ['copied by fewer than 10', (r) => (r.copy.copies || 0) < 10], ['copied 10–49 times', (r) => r.copy.copies >= 10 && r.copy.copies < 50], ['copied 50+ times', (r) => r.copy.copies >= 50],
      ['the trader is winning now', (r) => r.copy.pnl === '+'], ['the trader is losing now', (r) => r.copy.pnl === '-'], ['fresh (≤15 s old)', (r) => (r.copy.elapsed ?? 99) <= 15], ['older than 60 s', (r) => (r.copy.elapsed ?? 0) > 60],
      ['the list agrees ≥70%', (r) => r.copy.total >= 2 && (r.lean === 'CALL' ? r.copy.calls : r.copy.puts) / r.copy.total >= 0.7], ['the strategies agree too', (r) => r.cons?.s === 'AGREE' && r.cons?.dir === r.lean],
      ['the strategies are against it', (r) => r.cons?.dir && r.cons.dir !== r.lean], ['no objection from the engine', (r) => !(r.objections?.length)], ['duration ≤ 1 min', (r) => r.expirySec <= 60], ['duration 2–5 min', (r) => r.expirySec >= 120 && r.expirySec <= 300], ['duration > 5 min', (r) => r.expirySec > 300]];
    for (const [lab, f] of groups) fixedSide(`follow copy signals: ${lab}`, copies.filter(f), (r) => won(r, r.lean, null, r.expirySec), ca, cb, `copy.${lab}`, 'copy', null, add, 20);
    // PO's own signals: price direction after each code (sigStats: up/down counts per "*|minutes|code")
    for (const [k, v] of Object.entries(input.sigStats || {})) {
      if (!k.startsWith('*|')) continue;
      const n = v.up + v.down; if (n < 50) continue;
      const [, min, code] = k.split('|');
      add({ id: `posig.${k}`, family: 'platform-signal', label: `PO signal code ${code}, ${min} min: price went up ${pct(v.up, n)}%`, tf: 60, h: +min, directional: true, n, stat: pct(v.up, n), effect: +Math.abs(pct(v.up, n) - 50).toFixed(2), p: p2((v.up - n / 2) / Math.sqrt(n / 4)) });
    }
    // the engine's entries (taken or gated): expiry audit and entry timing, at the side the engine chose
    const ent = opps.filter((r) => r.origin !== 'copy' && (r.state === 'ENTERED' || r.state === 'GATED'));
    const side = (r) => r.exec?.dir || (r.fade ? (r.lean === 'CALL' ? 'PUT' : 'CALL') : r.lean);
    const [ea, eb] = cut(ent);
    const dur = (s) => (s < 60 ? `${s} s` : `${s / 60} min`);
    for (const H of [5, 10, 15, 30, 60, 120, 180, 300, 600, 900]) {
      fixedSide(`engine entries held ${dur(H)}`, thin(ent.filter((r) => r.exits[H] != null), () => H), (r) => won(r, side(r), null, H), ea, eb, `expiry.${H}`, 'expiry', H, add, 30);
      if (H > 300) continue;
      for (const d of [5, 10, 15, 30, 60]) {
        if (!HSEC.has(d + H)) continue;
        const ys = thin(ent.filter((r) => r.exits[d] != null && r.exits[d + H] != null), () => H + d);
        const now = ys.map((r) => won(r, side(r), null, H)).filter((x) => x != null), lat = ys.map((r) => [r.ts, won(r, side(r), d, d + H)]).filter((x) => x[1] != null);
        if (now.length < 30 || lat.length < 30) continue;
        const a = mean(now.map(Number)), b = mean(lat.map((x) => +x[1]));
        // the tradable version: the engine's side if waiting helps it, the other side if the window goes against it
        const flip = b < 0.5, mid = [...lat].sort((x, y) => x[0] - y[0])[Math.floor(lat.length / 2)][0];
        const half = (f) => { const xs = lat.filter(f); const w = xs.filter((x) => x[1] !== flip).length; return pct(w, xs.length); };
        const w = lat.filter((x) => x[1] !== flip).length, [lo, hi] = wilson(w, lat.length);
        add({ id: `timing.${H}.${d}`, family: 'entry-timing', label: `${dur(H)} window starting ${d} s after the engine's entry, traded ${flip ? 'AGAINST' : 'WITH'} the engine (vs entering at once: ${(100 * a).toFixed(1)}%)`, tf: 1, h: H, directional: true, n: lat.length,
          stat: pct(w, lat.length), effect: +(100 * (b - a)).toFixed(2), lo, hi, p: p2((b - a) / Math.sqrt(0.25 / lat.length + 0.25 / now.length)), now: { n: now.length, rate: +(100 * a).toFixed(2) },
          oos: { n: lat.length, rate: pct(w, lat.length) }, halves: [half((x) => x[0] < mid), half((x) => x[0] >= mid)], fixedSide: true, notOffered: !HSEC.has(H) });
      }
    }
    // after an entry: worst minus best excursion during the trade (5s candles, bp) vs random moments on the same pairs
    const byA = {}; for (const g of segs5) { const m = (byA[g.a] ||= new Map()); g.t.forEach((t, i) => m.set(t, g.c[i + 1])); }
    const keys = {}; for (const a in byA) keys[a] = [...byA[a].keys()];
    const exc = (a, t0, sec, up) => {
      const m = byA[a]; if (!m) return null;
      const t = Math.ceil(t0 / 5) * 5, prev = m.get(t - 5); if (!prev) return null;
      const p0 = prev.close; let best = 0, worst = 0, ok = 0;
      for (let k = t; k < t + sec; k += 5) { const c = m.get(k); if (!c) continue; ok++; best = Math.max(best, up ? c.high - p0 : p0 - c.low); worst = Math.max(worst, up ? p0 - c.low : c.high - p0); }
      return ok >= Math.max(1, sec / 10) ? (worst - best) / (p0 * 1e-4) : null;
    };
    const ex = [], rnd = [], rand = rng(7);
    for (const r of thin(ent.filter((x) => x.expirySec && x.expirySec <= 300 && x.state === 'ENTERED'), (x) => x.expirySec)) {
      const e1 = exc(r.asset, r.ts, r.expirySec, side(r) === 'CALL'); if (e1 == null) continue;
      ex.push(e1);
      const ks = keys[r.asset]; if (!ks?.length) continue;
      for (let k = 0; k < 3; k++) { const e2 = exc(r.asset, ks[Math.floor(rand() * ks.length)], r.expirySec, rand() < 0.5); if (e2 != null) rnd.push(e2); }
    }
    if (ex.length >= 20 && rnd.length >= 20) add({ id: 'postentry', family: 'after-entry', label: 'price runs against a placed trade more than against a random entry (worst − best excursion, bp)', tf: 5, h: null, directional: false,
      n: ex.length, stat: +mean(ex).toFixed(3), effect: +(mean(ex) - mean(rnd)).toFixed(3), p: p2((mean(ex) - mean(rnd)) / (Math.sqrt(sd(ex) ** 2 / ex.length + sd(rnd) ** 2 / rnd.length) || 1)), random: { n: rnd.length, mean: +mean(rnd).toFixed(3) } });
  }
  function fixedSide(label, xs, outcome, ca, cb, id, family, h, add, minN) {
    const T = tally(ca, cb); let n = 0, w = 0;
    for (const r of xs) { const x = outcome(r); if (x == null) continue; T.bump('x', r.ts, x); n++; if (x) w++; }
    if (n < minN) return;
    const c = T.m.get('x'), [lo, hi] = wilson(w, n);
    add({ id, family, label, tf: 1, h, directional: true, n, stat: pct(w, n), effect: +(pct(w, n) - 50).toFixed(2), lo, hi, p: p1((w - n / 2 - 0.5) / Math.sqrt(n / 4)),
      oos: { n, rate: pct(w, n) }, halves: [pct(c[1], c[0]), pct(c[3] + c[5], c[2] + c[4])], fixedSide: true });
  }

  // ── null data ──────────────────────────────────────────────────────────────
  // Same pairs, same timestamps, same move sizes and candle wicks — no predictive structure:
  //   permutation (moves shuffled), bootstrap (drawn with replacement), sign (each move's sign a coin flip),
  //   block (blocks of 60 move sizes in random order, each sign a coin flip: keeps volatility clustering, removes
  //   direction — a block of raw moves would also keep any short-term direction memory, which is what is tested),
  //   gauss (normal moves of the pair's σ).
  function synth(per, tf, model, seed) {
    const rnd = rng(seed), gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const out = {};
    for (const [a, cs0] of Object.entries(per)) {
      const cs = [...cs0].sort((x, y) => x.time - y.time);
      if (cs.length < 50) continue;
      const mv = [];
      for (let i = 1; i < cs.length; i++) { const c = cs[i]; mv.push({ d: c.close - cs[i - 1].close, up: c.high - Math.max(c.open, c.close), lo: Math.min(c.open, c.close) - c.low }); }
      const s = sd(mv.map((m) => m.d)) || 1e-9, n = mv.length;
      let order;
      if (model === 'permutation') { order = mv.map((_, i) => i); for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; } }
      else if (model === 'block') { order = []; while (order.length < n) { const st = Math.floor(rnd() * Math.max(1, n - 60)); for (let k = 0; k < 60 && order.length < n; k++) order.push(Math.min(n - 1, st + k)); } }
      else if (model === 'bootstrap') order = mv.map(() => Math.floor(rnd() * n));
      else order = mv.map((_, i) => i);
      let p = cs[0].close;
      const rows = [{ time: cs[0].time, open: cs[0].open, high: cs[0].high, low: cs[0].low, close: cs[0].close }];
      for (let i = 0; i < n; i++) {
        const m = mv[order[i]];
        const d = model === 'sign' ? Math.abs(mv[i].d) * (rnd() < 0.5 ? 1 : -1) : model === 'block' ? Math.abs(m.d) * (rnd() < 0.5 ? 1 : -1) : model === 'gauss' ? gauss() * s : m.d;
        const o = p, c = Math.max(p * 0.5, p + d);
        rows.push({ time: cs[i + 1].time, open: o, high: Math.max(o, c) + Math.abs(m.up), low: Math.min(o, c) - Math.abs(m.lo), close: c });
        p = c;
      }
      out[a] = rows;
    }
    return out;
  }

  // The two pattern-searching engines on a dataset: similarity walk-forward and pattern discovery
  // (engine/research.js). Real and null data use the same recent window so the comparison is like for like.
  const NULL_MODELS = ['permutation', 'bootstrap', 'sign', 'block', 'gauss'];
  function trim(per, keep, pairs) {
    const out = {};
    for (const [a, cs] of Object.entries(per).sort((x, y) => y[1].length - x[1].length).slice(0, pairs)) out[a] = [...cs].sort((x, y) => x.time - y.time).slice(-keep);
    return out;
  }
  function engines(per5, per1, { shouldStop } = {}) {
    const res = {};
    for (const [tf, per] of [[5, per5], [60, per1]]) {
      if (shouldStop?.()) return res;
      const st = Object.entries(per).flatMap(([a, cs]) => R.build(cs, tf, { asset: a }));
      if (st.length < R.DEFAULTS.warm + 1000) { res[tf] = { states: st.length, tooFew: true }; continue; }
      const wf = R.walkForward(st, { step: Math.max(1, Math.floor(st.length / 12000)), shouldStop });
      const pd = R.discover(st, { payout: 92 });
      const hz = wf.horizons.map((h) => ({ sec: h.sec, rate: h.analog.rate, n: h.analog.n, lift: h.lift ?? null, cells: h.buckets.filter((b) => b.significant).length }));
      const res1 = { states: st.length, similarity: hz, bestHit: Math.max(...hz.map((h) => h.rate ?? 0)), bestLift: Math.max(...hz.map((h) => h.lift ?? -99)), significantCells: hz.reduce((s, h) => s + h.cells, 0),
        discovered: { tested: pd.tested, reachedOos: pd.reachedOos, holding: pd.patterns.length, validated: pd.patterns.filter((p) => p.status === 'VALIDATED').length } };
      Object.defineProperty(res1, 'states_', { value: st, enumerable: false, configurable: true }); // kept for discoveryNulls, never saved
      res[tf] = res1;
    }
    return res;
  }
  function runNulls(input, { shouldStop, say, keep5 = 3000, keep1 = 1500, pairs = 16 } = {}) {
    const per5 = trim(input.per5 || {}, keep5, pairs), per1 = trim(input.per1 || {}, keep1, pairs);
    const real = engines(per5, per1, { shouldStop });
    const nulls = {};
    NULL_MODELS.forEach((m, k) => {
      if (shouldStop?.()) return;
      say?.(`null test: similarity & patterns on ${m} noise…`);
      nulls[m] = engines(synth(per5, 5, m, 101 + k), synth(per1, 60, m, 201 + k), { shouldStop });
    });
    const compare = {};
    for (const tf of [5, 60]) {
      if (!real[tf] || real[tf].tooFew) continue;
      const ns = NULL_MODELS.map((m) => nulls[m]?.[tf]).filter((x) => x && !x.tooFew);
      if (!ns.length) continue;
      // with k noise sets, real data tops them all by luck 1 time in k + 1
      const span = (f) => { const v = ns.map(f); return { real: f(real[tf]), nullMin: Math.min(...v), nullMax: Math.max(...v), nullMean: +mean(v).toFixed(2), beatsAll: f(real[tf]) > Math.max(...v), byLuck: +(1 / (ns.length + 1)).toFixed(2) }; };
      compare[tf] = { bestHit: span((x) => x.bestHit), bestLift: span((x) => x.bestLift), significantCells: span((x) => x.significantCells), patternsHolding: span((x) => x.discovered.holding), patternsValidated: span((x) => x.discovered.validated) };
    }
    return { window: { pairs5: Object.keys(per5).length, keep5, pairs1: Object.keys(per1).length, keep1 }, real, nulls, models: NULL_MODELS, compare };
  }
  // The strategy discovery engine (async: multi-condition rules, FDR, walk-forward, robustness) on the same states,
  // real vs three kinds of noise.
  async function discoveryNulls(nt, { cfg = OTC.DEFAULT_CONFIG, budgetSec = 25, shouldStop = null, say = null } = {}) {
    if (!nt || !OTC.Discovery?.runCycle) return;
    const run = async (e, tf, label) => {
      const st = e?.[tf]?.states_;
      if (!st || st.length < 3000) return;
      say?.(`null test: strategy discovery on ${label} ${tf === 5 ? '5s' : '1M'}…`);
      const H = R.DEFAULTS.discoverHorizons[tf], ds = OTC.Discovery.datasetFromStates(st, { tf, horizons: H, defaultPayout: 92, maxRows: 12000 });
      const c = OTC.config({ ...cfg, discovery: { ...(cfg.discovery || {}), expiries: H, timeBudgetSec: budgetSec } });
      const res = await OTC.Discovery.runCycle(ds, { cfg: c, tf, defaultPayout: 92, shouldStop });
      const by = {}; for (const r of res.rows) by[r.status] = (by[r.status] || 0) + 1;
      e[tf].strategies = { rows: ds.n, candidates: res.rows.length, passed: by.PAPER_TEST || 0, byStatus: by };
    };
    const NM = ['permutation', 'block', 'gauss'];
    for (const tf of [5, 60]) {
      if (shouldStop?.()) break;
      await run(nt.real, tf, 'OTC');
      for (const m of NM) { if (shouldStop?.()) break; await run(nt.nulls[m], tf, m); }
      const real = nt.real[tf]?.strategies, ns = NM.map((m) => nt.nulls[m]?.[tf]?.strategies).filter(Boolean);
      if (real && ns.length && nt.compare[tf]) nt.compare[tf].strategiesPassed = { real: real.passed, nullMin: Math.min(...ns.map((x) => x.passed)), nullMax: Math.max(...ns.map((x) => x.passed)), beatsAll: real.passed > Math.max(...ns.map((x) => x.passed)) };
    }
  }

  // ── classification & verdict ───────────────────────────────────────────────
  // STRONG_EDGE: significant after correction, held in both halves of the newer part, the lower 95% bound of the
  //   out-of-sample hit rate above break-even at the best payout (and both halves above it).
  // WEAK_EDGE: significant and stable, below break-even. OVERFIT: clear on the older part, gone on the newer.
  // UNSTABLE: significant but one half of the newer part ≤ 50% (or the sign flips between halves).
  // NOISY_RESULT: p < 0.05 only before correction. REGIME_SPECIFIC / PERIOD_SPECIFIC: only inside a regime / period.
  function classify(r, be) {
    r.breakEven = +be.toFixed(2);
    if (!r.directional) { r.status = r.significant ? 'STRUCTURE_NOT_DIRECTIONAL' : r.nominal ? 'NOISY_RESULT' : 'NO_EDGE'; return; }
    if ((r.n || 0) < 200) { r.status = 'INSUFFICIENT_DATA'; return; }
    if (!r.significant) { r.status = r.train && r.train.lo > 50 && r.train.n >= 200 ? 'OVERFIT' : r.nominal ? 'NOISY_RESULT' : 'NO_EDGE'; return; }
    if (r.family === 'stability') { r.status = 'PERIOD_SPECIFIC'; return; }
    if (r.halves && r.halves.some((h) => h == null || h <= 50)) { r.status = 'UNSTABLE'; return; }
    if (r.halvesRho && r.sameSign === false) { r.status = 'UNSTABLE'; return; }
    r.exploitable = !!(r.oos && r.lo != null && r.lo > be && r.halves && r.halves.every((h) => h > be));
    r.status = r.family === 'regime' ? 'REGIME_SPECIFIC' : r.exploitable ? 'STRONG_EDGE' : 'WEAK_EDGE';
  }
  // The verdict uses the strictest correction — Benjamini–Hochberg over EVERY hypothesis of the run — so it depends on
  // the data alone (not on the random draws of the null tests, which are reported next to it as a sanity check).
  function decide(rows, dataset, noise, engines, payouts) {
    const n5 = dataset[5]?.returns || 0, n1 = dataset[60]?.returns || 0, P = Math.max(...payouts), be = breakEven(P).toFixed(2);
    if (n5 < 20000 && n1 < 5000) return { status: 'INSUFFICIENT_DATA', reasons: [`only ${n5} 5s moves and ${n1} 1M moves — about 20 000 / 5 000 are needed`] };
    const dir = rows.filter((r) => r.directional);
    const global = (r) => r.qAll < 0.05;
    const edges = dir.filter((r) => r.exploitable && global(r)), weak = dir.filter((r) => ['WEAK_EDGE', 'REGIME_SPECIFIC', 'STRONG_EDGE'].includes(r.status) && global(r));
    const familyOnly = dir.filter((r) => ['WEAK_EDGE', 'REGIME_SPECIFIC', 'STRONG_EDGE'].includes(r.status) && !global(r));
    const reasons = [`${rows.length} hypotheses tested (${dir.length} about direction); ${rows.filter((r) => r.nominal).length} had p < 0.05 before correction — about ${Math.round(rows.length * 0.05)} would by chance alone; ${rows.filter((r) => r.significant).length} survived Benjamini–Hochberg within their family (${rows.filter((r) => r.significant && r.directional).length} about direction), ${rows.filter(global).length} over all hypotheses (${dir.filter(global).length} about direction)`];
    const nz = noise && (noise.permutation || Object.values(noise)[0]);
    if (nz) reasons.push(`the same audit on shuffled data: ${nz.significant} direction results survived (OTC: ${nz.otc.significant}); best out-of-sample hit ${nz.bestOos}% on noise vs ${nz.otc.bestOos}% on OTC`);
    for (const tf of [5, 60]) {
      const c = engines?.compare?.[tf]; if (!c) continue;
      reasons.push(`${tf === 5 ? '5s' : '1M'} similarity engine: best hit ${c.bestHit.real}% on OTC vs ${c.bestHit.nullMin}–${c.bestHit.nullMax}% on noise; patterns holding ${c.patternsHolding.real} vs ${c.patternsHolding.nullMin}–${c.patternsHolding.nullMax}${c.strategiesPassed ? `; strategy discovery passed ${c.strategiesPassed.real} vs ${c.strategiesPassed.nullMin}–${c.strategiesPassed.nullMax}` : ''}`);
    }
    if (familyOnly.length) reasons.push(`${familyOnly.length} direction result(s) survived only within their own family, not over all hypotheses: ${familyOnly.map((r) => `${r.label} (${r.oos ? r.oos.rate + '%' : r.stat}, n ${r.n})`).join('; ')}`);
    const out = (status, more) => ({ status, reasons: [...reasons, ...more], edges: (status === 'EDGE_FOUND' ? edges : weak).map(slim), familyOnly: familyOnly.map(slim) });
    if (edges.length) return out('EDGE_FOUND', [`${edges.length} result(s) beat break-even ${be}% (payout ${P}%) out of sample, in both halves, after correcting for every hypothesis`]);
    if (weak.length) return out('WEAK_EVIDENCE', [`${weak.length} direction result(s) survived every correction and held in both halves, but none clears break-even ${be}% at ${P}% payout — not tradable`]);
    return out('NO_EDGE_FOUND', []);
  }

  // What is saved: every hypothesis except the thousands of plain "nothing" rows about pairs and move sizes (their
  // counts and best results stay in tests.byFamily).
  function compact(rep) {
    const drop = (r) => (r.family === 'cross-pair' || r.family === 'volatility') && r.status === 'NO_EDGE';
    return { ...rep, rows: rep.rows.filter((r) => !drop(r)), droppedRows: rep.rows.filter(drop).length };
  }

  // after the (async) strategy-discovery null test has added its comparison
  const redecide = (rep) => (rep.verdict = decide(rep.rows, rep.dataset, rep.noise, rep.engines, rep.economics.map((e) => e.payout)));

  OTC.Audit = { VERSION, PAYOUTS, NULL_MODELS, audit, redecide, compact, quality, prepare, synth, trim, engines, runNulls, discoveryNulls, bhq, chi2p, wilson, breakEven, ev, judge, tally };
})(typeof globalThis !== 'undefined' ? globalThis : this);
