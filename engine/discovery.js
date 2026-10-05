// Strategy Discovery Engine — offline research. Deterministic statistics only:
// no LLM, no randomness. Everything it finds is a HYPOTHESIS until it survives
// validation, out-of-sample testing and live paper trading.
//
//   candles → dataset (the live pipeline replayed; one feature vector per 5M close)
//   → atoms (conditions from the feature library, coarse thresholds only)
//   → search (beam search on TRAINING data only, per direction and expiry)
//     + combinations of library strategies + variations + mutations of earlier finds
//     + simplification + negative conditions + "do not trade" filters
//   → assessment (validation with false-discovery control, out-of-sample,
//     walk-forward, robustness, cross-pair, time stability, regime breakdown)
//   → lifecycle status + ranking + report
// Selection (search, simplification, robustness, mutations) only ever looks at the
// training period. Validation and out-of-sample periods are used as pass/fail gates.
(function (G) {
  const OTC = G.OTC, U = OTC.U, TF = OTC.TF, FL = OTC.FeatureLib;
  const NA = -2; // outcome not available

  // ── statistics ─────────────────────────────────────────────────────────────
  const wlo = (w, n, z) => (n > 0 ? OTC.Stats.wilson(w, n, z).lo : -Infinity);
  function Phi(x) { // standard normal CDF (Abramowitz–Stegun 7.1.26)
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }
  // One-sided p-value that the win rate exceeds p0 (normal approximation, continuity-corrected).
  const pAbove = (w, n, p0) => (n ? 1 - Phi((w - n * p0 - 0.5) / Math.sqrt(n * p0 * (1 - p0))) : 1);
  function bhQ(ps) { // Benjamini–Hochberg q-values
    const m = ps.length, order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]), q = new Array(m);
    let min = 1;
    for (let r = m - 1; r >= 0; r--) { min = Math.min(min, (order[r][0] * m) / (r + 1)); q[order[r][1]] = min; }
    return q;
  }
  const twoPropZ = (w1, n1, w2, n2) => {
    if (!n1 || !n2) return 0;
    const p = (w1 + w2) / (n1 + n2), se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    return se ? (w1 / n1 - w2 / n2) / se : 0;
  };
  const sampleClass = (n, dc) => (n < dc.sampleClasses[0] ? 'INSUFFICIENT' : n < dc.sampleClasses[1] ? 'PRELIMINARY' : n < dc.sampleClasses[2] ? 'RESEARCH' : 'STRONGER');

  // ── dataset ────────────────────────────────────────────────────────────────
  // sources: [{ asset, candles: [...setup-frame candles] (or c5), c1?: [...1M candles, used as the
  // confirmation frame when the setup frame is 5M] }]. tf = the setup frame in seconds.
  async function buildDataset(sources, { cfg = OTC.DEFAULT_CONFIG, tf = 300, payoutByAsset = {}, defaultPayout = 85, engine = true,
    onProgress = null, shouldStop = null, yieldEvery = 60 } = {}) {
    FL.ensureStrategyFeatures();
    const P = OTC.PROFILES[tf] || OTC.PROFILES[300];
    const dc = cfg.discovery, rows = [], skipped = [];
    let dqSkipped = 0, done = 0;
    const src5 = (s) => s.candles || s.c5 || [];
    const total = sources.reduce((s, x) => s + src5(x).length, 0);
    const WIN = { primary: 200, mid: 120, macro: 120 };
    for (const src of sources) {
      const c5 = U.cleanRows(src5(src)).filter((c, i, a) => !i || c.time !== a[i - 1].time);
      if (c5.length < 500) { skipped.push(`${src.asset}: only ${c5.length} candles`); done += c5.length; continue; }
      const c15 = U.aggregate(c5, tf, P.MID), c60 = U.aggregate(c5, tf, P.MACRO);
      const c1 = P.TIMING === 60 && src.c1?.length ? U.cleanRows(src.c1) : null;
      const payout = payoutByAsset[src.asset] ?? defaultPayout;
      let j15 = 0, j60 = 0, j1 = 0;
      const start = Math.max(cfg.minCandles.primary, Math.ceil(P.MACRO / tf) * (cfg.minCandles.macro + 1));
      for (let i = start; i < c5.length; i++) {
        if (shouldStop?.()) break;
        const T = c5[i].time, endT = T + tf;
        const out = dc.expiries.map((N) => (c5[i + N] && c5[i + N].time === T + N * tf ? Math.sign(c5[i + N].close - c5[i].close) : NA));
        if (out.every((o) => o === NA)) continue;
        while (j15 < c15.length && c15[j15].time + P.MID <= endT) j15++;
        while (j60 < c60.length && c60[j60].time + P.MACRO <= endT) j60++;
        if (c1) while (j1 < c1.length && c1[j1].time + 60 <= endT) j1++;
        const row = OTC.withProfile(tf, () => {
          const w5 = c5.slice(Math.max(0, i + 1 - WIN.primary), i + 1);
          const series = {
            [tf]: w5,
            [P.MID]: OTC.Pipeline.htfWithPartial(c15.slice(Math.max(0, j15 - WIN.mid), j15), w5, P.MID),
            [P.MACRO]: OTC.Pipeline.htfWithPartial(c60.slice(Math.max(0, j60 - WIN.macro), j60), w5, P.MACRO),
          };
          if (c1 && j1 > 0 && c1[j1 - 1].time === endT - 60) series[60] = c1.slice(Math.max(0, j1 - 60), j1);
          const dq = OTC.DataQuality.checkSnapshot(series, { cfg });
          if (!dq.ok) return null;
          const X = OTC.Pipeline.buildContext(series, { cfg });
          const scan = OTC.Pipeline.fastScan(X);
          const analysis = engine ? OTC.Pipeline.deepAnalyze(X, { dq, scan, reliability: null }) : null;
          return { time: endT, asset: src.asset, payout, entry: c5[i].close, out, vec: FL.vector(FL.context(X, { scan, analysis, time: endT, candleTime: T, asset: src.asset })) };
        });
        if (!row) { dqSkipped++; continue; }
        rows.push(row);
        if (yieldEvery && ++done % yieldEvery === 0) {
          onProgress?.({ stage: 'dataset', done, total, rows: rows.length });
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }
    rows.sort((a, b) => a.time - b.time || (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0));
    const ds = columnar(rows, dc, { skipped, dqSkipped, sources: sources.map((s) => ({ asset: s.asset, candles: src5(s).length, c1: s.c1?.length || 0 })) });
    ds.tf = tf;
    return ds;
  }

  // Market states (engine/research.js) → a discovery dataset: only the normalized state features (and the pair),
  // outcomes at the research horizons (candles of tf). Discovery then runs on it exactly as on the pipeline's
  // dataset, so a rule found here means the same thing live (the pipeline builds the same state, X.state).
  function datasetFromStates(states, { tf, horizons, payoutByAsset = {}, defaultPayout = 85, maxRows = 25000 } = {}) {
    const feats = FL.FEATURES.filter((f) => f.group === 'state' || f.id === 'pair');
    const sorted = [...states].sort((a, b) => a.t - b.t);
    const step = Math.max(1, Math.ceil(sorted.length / maxRows)), rows = [];
    for (let i = 0; i < sorted.length; i += step) {
      const s = sorted[i];
      if (!s.out || !s.f) continue;
      const out = horizons.map((N) => { const k = s.hs.indexOf(N); return k < 0 ? NA : s.out.dir[k]; });
      if (out.every((o) => o === NA)) continue;
      rows.push({ time: s.t + tf, asset: s.asset, payout: payoutByAsset[s.asset] ?? defaultPayout, entry: s.price, out,
        vec: FL.vectorOf({ state: s, asset: s.asset, time: s.t + tf }, feats) });
    }
    rows.sort((a, b) => a.time - b.time || (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0));
    const ds = columnar(rows, { expiries: horizons }, { source: 'market-states', step, sources: [...new Set(rows.map((r) => r.asset))].map((asset) => ({ asset })) }, feats);
    ds.tf = tf;
    return ds;
  }

  // Rows → typed columns. Categorical values are dictionary-encoded.
  function columnar(rows, dc, meta = {}, features = FL.FEATURES) {
    const n = rows.length, assets = [...new Set(rows.map((r) => r.asset))].sort();
    const ds = {
      n, assets, expiries: dc.expiries.slice(), time: new Float64Array(n), asset: new Int16Array(n), payout: new Float32Array(n),
      entry: new Float64Array(n), out: {}, cols: {}, meta,
    };
    dc.expiries.forEach((N) => (ds.out[N] = new Int8Array(n)));
    for (const f of features) {
      ds.cols[f.id] = f.type === 'num' ? { type: 'num', data: new Float64Array(n).fill(NaN) }
        : f.type === 'bool' ? { type: 'bool', data: new Int8Array(n).fill(-1) } : { type: 'cat', data: new Int16Array(n).fill(-1), dict: [] };
    }
    const dictIdx = {};
    rows.forEach((r, i) => {
      ds.time[i] = r.time; ds.asset[i] = assets.indexOf(r.asset); ds.payout[i] = r.payout; ds.entry[i] = r.entry;
      dc.expiries.forEach((N, k) => (ds.out[N][i] = r.out[k]));
      for (const f of features) {
        const v = r.vec[f.id], col = ds.cols[f.id];
        if (v == null) continue;
        if (col.type === 'num') col.data[i] = v;
        else if (col.type === 'bool') col.data[i] = v ? 1 : 0;
        else {
          const m = (dictIdx[f.id] ||= new Map());
          let code = m.get(v);
          if (code == null) { code = col.dict.length; col.dict.push(v); m.set(v, code); }
          col.data[i] = code;
        }
      }
    });
    prepareOutcomes(ds);
    ds.meta.fingerprint = fingerprint(ds);
    return ds;
  }

  function prepareOutcomes(ds) {
    ds.up = {}; ds.dn = {}; ds.dec = {};
    for (const N of ds.expiries) {
      const o = ds.out[N], up = new Uint8Array(ds.n), dn = new Uint8Array(ds.n), dec = new Uint8Array(ds.n);
      for (let i = 0; i < ds.n; i++) { up[i] = o[i] === 1 ? 1 : 0; dn[i] = o[i] === -1 ? 1 : 0; dec[i] = up[i] | dn[i]; }
      ds.up[N] = up; ds.dn[N] = dn; ds.dec[N] = dec;
    }
    ds.maskCache = new Map();
  }

  // FNV-1a over times, assets and entry prices: identifies the exact data a run used.
  function fingerprint(ds) {
    let h = 0x811c9dc5;
    const mix = (x) => { const s = String(x); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } };
    for (let i = 0; i < ds.n; i += Math.max(1, Math.floor(ds.n / 2000))) { mix(ds.time[i]); mix(ds.asset[i]); mix(ds.entry[i]); }
    mix(ds.n);
    return { hash: h.toString(16), n: ds.n, from: ds.n ? ds.time[0] : null, to: ds.n ? ds.time[ds.n - 1] : null, assets: ds.assets.slice() };
  }

  // ── masks ──────────────────────────────────────────────────────────────────
  function atomMask(ds, a) {
    const key = FL.atomKey(a);
    const hit = ds.maskCache.get(key);
    if (hit) return hit;
    const m = new Uint8Array(ds.n);
    if (a.or) {
      for (const x of a.or) { const mx = atomMask(ds, x); for (let i = 0; i < ds.n; i++) m[i] |= mx[i]; }
    } else {
      const col = ds.cols[a.f];
      if (col) {
        const d = col.data;
        if (col.type === 'num') {
          const [lo, hi] = a.op === 'between' ? a.v : [a.v, a.v];
          for (let i = 0; i < ds.n; i++) {
            const v = d[i];
            if (v !== v) continue; // NaN
            m[i] = a.op === '<=' ? v <= a.v : a.op === '>=' ? v >= a.v : a.op === 'between' ? v >= lo && (a.closedHi ? v <= hi : v < hi) : 0;
          }
        } else if (col.type === 'bool') {
          const want = a.op === '!=' ? (a.v ? 0 : 1) : a.v ? 1 : 0;
          for (let i = 0; i < ds.n; i++) m[i] = d[i] === want ? 1 : 0;
        } else {
          const code = col.dict.indexOf(a.v);
          for (let i = 0; i < ds.n; i++) m[i] = a.op === '==' ? (d[i] === code && code >= 0 ? 1 : 0) : d[i] >= 0 && d[i] !== code ? 1 : 0;
        }
      }
    }
    ds.maskCache.set(key, m);
    return m;
  }

  function ruleMask(ds, rule) {
    const m = new Uint8Array(ds.n).fill(1);
    for (const a of rule.all || []) { const x = atomMask(ds, a); for (let i = 0; i < ds.n; i++) m[i] &= x[i]; }
    for (const a of rule.none || []) { const x = atomMask(ds, a); for (let i = 0; i < ds.n; i++) if (x[i]) m[i] = 0; }
    if (rule.pairs?.length) {
      const ok = new Set(rule.pairs.map((p) => ds.assets.indexOf(p)));
      for (let i = 0; i < ds.n; i++) if (!ok.has(ds.asset[i])) m[i] = 0;
    }
    return m;
  }

  // ── evaluation ─────────────────────────────────────────────────────────────
  // Non-overlapping, chronological evaluation of a mask over rows [from, to): a row
  // counts only if the previous counted trade on the same pair has expired.
  function evalMask(ds, mask, dir, N, from = 0, to = ds.n, z = 1.645) {
    const o = ds.out[N], busy = new Float64Array(ds.assets.length).fill(-Infinity), idx = [];
    let matched = 0, noOutcome = 0, overlap = 0;
    for (let i = from; i < to; i++) {
      if (!mask[i]) continue;
      matched++;
      if (o[i] === NA) { noOutcome++; continue; }
      const a = ds.asset[i];
      if (ds.time[i] < busy[a]) { overlap++; continue; }
      busy[a] = ds.time[i] + N * (ds.tf || 300);
      idx.push(i);
    }
    return { ...summarize(ds, idx, dir, N, z), matched, skipped: noOutcome + overlap, skippedOverlap: overlap, skippedNoOutcome: noOutcome, idx };
  }
  const evalRule = (ds, rule, from, to, z) => evalMask(ds, ruleMask(ds, rule), rule.dir, rule.expiry, from, to, z);

  function summarize(ds, idx, dir, N, z = 1.645) {
    const o = ds.out[N], sg = dir === 'CALL' ? 1 : -1;
    let w = 0, l = 0, t = 0, pay = 0, paySum = 0, eq = 0, peak = 0, dd = 0, run = 0, maxRun = 0;
    for (const i of idx) {
      const r = o[i] * sg, p = ds.payout[i] / 100;
      paySum += ds.payout[i];
      if (r > 0) { w++; pay += p; eq += p; run = 0; } else if (r < 0) { l++; eq -= 1; run++; maxRun = Math.max(maxRun, run); } else t++;
      peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    }
    const n = w + l, ci = n ? OTC.Stats.wilson(w, n, z) : { lo: null, hi: null };
    const be = U.breakEven(idx.length ? paySum / idx.length : 85);
    return { n, w, l, t, wr: n ? (100 * w) / n : null, lo: ci.lo, hi: ci.hi, ev: idx.length ? (pay - l) / idx.length : null, be,
      maxConsecLoss: maxRun, maxDrawdown: +dd.toFixed(3), net: +eq.toFixed(3) };
  }
  const strip = (s) => (s ? (({ idx, ...r }) => r)(s) : null);

  function breakdown(ds, idx, dir, N, keyFn, minN = 1) {
    const g = new Map();
    for (const i of idx) { const k = keyFn(i); if (k == null) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(i); }
    return [...g.entries()].map(([key, xs]) => ({ key, ...summarize(ds, xs, dir, N) })).filter((r) => r.n >= minN).sort((a, b) => b.n - a.n);
  }
  const catAt = (ds, f) => { const c = ds.cols[f]; return (i) => (c && c.data[i] >= 0 ? c.dict[c.data[i]] : null); };

  // Chronological split on row index, moved to a time boundary so a timestamp never straddles two sets.
  function splits(ds, fr) {
    const at = (x) => { let i = Math.min(ds.n, Math.floor(ds.n * x)); while (i > 0 && i < ds.n && ds.time[i] === ds.time[i - 1]) i++; return i; };
    const cut1 = at(fr[0]), cut2 = at(fr[0] + fr[1]);
    return { cut1, cut2, train: [0, cut1], validation: [cut1, cut2], oos: [cut2, ds.n] };
  }
  const range = (a, b) => { const r = new Int32Array(Math.max(0, b - a)); for (let i = 0; i < r.length; i++) r[i] = a + i; return r; };
  const foldBounds = (from, to, k) => Array.from({ length: k }, (_, j) => [from + Math.floor(((to - from) * j) / k), from + Math.floor(((to - from) * (j + 1)) / k)]);

  OTC.Discovery = Object.assign(OTC.Discovery || {}, {
    NA, Phi, pAbove, bhQ, twoPropZ, sampleClass, wlo,
    buildDataset, datasetFromStates, columnar, prepareOutcomes, atomMask, ruleMask, evalMask, evalRule, summarize, strip, breakdown, catAt, splits, range, foldBounds,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
