// Statistical Engine. Everything here is computed from logged records only —
// no number is assumed or invented. Small samples are reported as such.
//
// Outcome of a record for direction d at expiry N (in 5M candles):
//   W if the close N candles later is beyond the entry close in direction d,
//   L if it is on the other side, T if equal (PO refunds ties).
//
// Overlap: two records 5 minutes apart with a 3-candle expiry share most of their
// price path, so they are not independent. By default each group counts a record
// only if it starts after the previous counted one has expired.
(function (G) {
  const OTC = G.OTC, U = OTC.U, TF = OTC.TF;

  const outcome = (rec, dir, N) => {
    const x = rec.exits?.[N];
    if (x == null || rec.entryPrice == null || !dir || dir === 'NEUTRAL') return null;
    return x === rec.entryPrice ? 'T' : (x > rec.entryPrice) === (dir === 'CALL') ? 'W' : 'L';
  };

  // Wilson score interval for a win rate, in %. z = 1.645 → 90% two-sided / 95% one-sided lower bound.
  function wilson(w, n, z = 1.645) {
    if (!n) return { lo: null, hi: null };
    const p = w / n, z2 = z * z, d = 1 + z2 / n, c = p + z2 / (2 * n), r = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
    return { lo: (100 * (c - r)) / d, hi: (100 * (c + r)) / d };
  }

  function summarize(items, z = 1.645) {
    let w = 0, l = 0, t = 0, pay = 0;
    for (const it of items) { if (it.out === 'W') { w++; pay += (it.payout ?? 85) / 100; } else if (it.out === 'L') l++; else t++; }
    const n = w + l, ci = wilson(w, n, z);
    const avgPayout = items.length ? U.mean(items.map((i) => i.payout ?? 85)) : null;
    return { n, w, l, t, wr: n ? (100 * w) / n : null, lo: ci.lo, hi: ci.hi,
      ev: items.length ? (pay - l) / items.length : null, // average result per trade, in stakes
      be: avgPayout != null ? U.breakEven(avgPayout) : null };
  }

  // Groups records. pick(rec) → [{ key, dir }] (one record may count in several groups).
  function group(records, { expiry = 1, pick, nonOverlap = true, z = 1.645 } = {}) {
    const items = new Map();
    const sorted = [...records].sort((a, b) => a.ts - b.ts);
    const busy = new Map();
    for (const rec of sorted) {
      for (const { key, dir } of pick(rec) || []) {
        if (key == null) continue;
        const out = outcome(rec, dir, expiry);
        if (!out) continue;
        if (nonOverlap) {
          const until = busy.get(key);
          if (until != null && rec.ts < until) continue;
          busy.set(key, rec.ts + expiry * (rec.tf || 300));
        }
        if (!items.has(key)) items.set(key, []);
        items.get(key).push({ out, payout: rec.payout, ts: rec.ts, rec, dir });
      }
    }
    const rows = [];
    for (const [key, its] of items) rows.push({ key, ...summarize(its, z), items: its });
    return rows.sort((a, b) => b.n - a.n);
  }

  // ── standard pickers ───────────────────────────────────────────────────────
  const taken = (r) => r.decision === 'CALL' || r.decision === 'PUT';
  const SESSIONS = [[0, 7, 'Asia'], [7, 12, 'London'], [12, 16, 'London/NY'], [16, 21, 'New York'], [21, 24, 'Late']];
  const session = (ts) => { const h = new Date(ts * 1000).getUTCHours(); return SESSIONS.find(([a, b]) => h >= a && h < b)[2]; };
  const bucket = (v, size) => (v == null ? null : `${Math.floor(v / size) * size}–${Math.floor(v / size) * size + size}`);

  const PICKERS = {
    all: (basis) => (r) => [{ key: 'all', dir: dirOf(r, basis) }],
    pair: (basis) => (r) => [{ key: r.asset, dir: dirOf(r, basis) }],
    regime: (basis) => (r) => [{ key: r.regime, dir: dirOf(r, basis) }],
    setup: (basis) => (r) => [{ key: r.setup, dir: dirOf(r, basis) }],
    combination: (basis) => (r) => [{ key: r.combo, dir: dirOf(r, basis) }],
    hour: (basis) => (r) => [{ key: String(new Date(r.ts * 1000).getUTCHours()).padStart(2, '0') + 'h UTC', dir: dirOf(r, basis) }],
    session: (basis) => (r) => [{ key: session(r.ts), dir: dirOf(r, basis) }],
    score: (basis) => (r) => [{ key: bucket(r.deep, 5), dir: dirOf(r, basis) }],
    scanner: (basis) => (r) => [{ key: bucket(r.scanner?.score, 10), dir: dirOf(r, basis) }],
    decision: () => (r) => [{ key: taken(r) ? 'taken' : 'skipped', dir: r.lean }],
    strategy: (basis) => (r) => (r.strategies || []).filter((s) => basis !== 'active' || s[3]).map((s) => ({ key: s[0], dir: s[1] })),
    module: () => (r) => Object.entries(r.modules || {}).filter(([, m]) => m[0] !== 'NEUTRAL').map(([k, m]) => ({ key: k, dir: m[0] })),
  };
  // basis: 'taken' → only executed/paper decisions; 'lean' → every record with a lean (includes SKIPs, counterfactual)
  function dirOf(r, basis) { return basis === 'lean' ? r.lean : taken(r) ? r.decision : null; }

  function by(records, dim, { basis = 'taken', expiry = 1, nonOverlap = true } = {}) {
    const mk = PICKERS[dim];
    if (!mk) throw new Error(`unknown dimension ${dim}`);
    return group(records, { expiry, pick: mk(basis), nonOverlap });
  }

  // Equity curve, drawdown and streaks of the taken trades, in stakes.
  function equity(records, { expiry = 1 } = {}) {
    const rows = by(records, 'all', { basis: 'taken', expiry })[0];
    if (!rows) return { trades: 0, net: 0, maxDrawdown: 0, maxLossStreak: 0, maxWinStreak: 0, curve: [] };
    let eq = 0, peak = 0, dd = 0, ls = 0, ws = 0, maxLs = 0, maxWs = 0;
    const curve = [];
    for (const it of rows.items) {
      eq += it.out === 'W' ? (it.payout ?? 85) / 100 : it.out === 'L' ? -1 : 0;
      peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
      if (it.out === 'L') { ls++; ws = 0; } else if (it.out === 'W') { ws++; ls = 0; }
      maxLs = Math.max(maxLs, ls); maxWs = Math.max(maxWs, ws);
      curve.push([it.ts, +eq.toFixed(3)]);
    }
    return { trades: rows.items.length, net: +eq.toFixed(3), maxDrawdown: +dd.toFixed(3), maxLossStreak: maxLs, maxWinStreak: maxWs, curve };
  }

  // Score → observed win rate. A deep score of 80 is NOT an 80% probability until this says so.
  function calibration(records, { expiry = 1, size = 5, basis = 'lean' } = {}) {
    return by(records, 'score', { basis, expiry }).filter((r) => r.key != null)
      .sort((a, b) => parseFloat(a.key) - parseFloat(b.key))
      .map(({ items, ...r }) => r);
  }

  // Chronological split — never random, so later data stays unseen.
  function split(records, fractions = [0.6, 0.2, 0.2]) {
    const s = [...records].sort((a, b) => a.ts - b.ts);
    const a = Math.floor(s.length * fractions[0]), b = Math.floor(s.length * (fractions[0] + fractions[1]));
    return { train: s.slice(0, a), validation: s.slice(a, b), oos: s.slice(b),
      bounds: { trainEnd: s[a - 1]?.ts ?? null, validationEnd: s[b - 1]?.ts ?? null } };
  }

  function folds(records, k) {
    const s = [...records].sort((a, b) => a.ts - b.ts), out = [];
    for (let i = 0; i < k; i++) out.push(s.slice(Math.floor((i * s.length) / k), Math.floor(((i + 1) * s.length) / k)));
    return out;
  }

  // ── setup-profile discovery and validation ─────────────────────────────────
  // A profile = strategy (or a pair of strategies firing together) + regime + expiry.
  // Status ladder: INSUFFICIENT → REJECTED | CANDIDATE → FAILED_VALIDATION | UNSTABLE | VALIDATED.
  // VALIDATED means "eligible for a human to promote" — nothing is promoted automatically.
  function profilePicker(rec) {
    const out = [];
    const fired = (rec.strategies || []).slice(0, 10);
    for (const s of fired) out.push({ key: `${s[0]}|${rec.regime}`, dir: s[1] });
    for (let i = 0; i < fired.length; i++) for (let j = i + 1; j < fired.length; j++) {
      if (fired[i][1] !== fired[j][1]) continue;
      const [a, b] = [fired[i][0], fired[j][0]].sort();
      out.push({ key: `${a}+${b}|${rec.regime}`, dir: fired[i][1] });
    }
    return out;
  }

  function discoverProfiles(records, cfg = OTC.DEFAULT_CONFIG, { expiries = cfg.expiries } = {}) {
    const v = cfg.validation;
    const parts = split(records, v.split);
    const results = [];
    let tested = 0;
    for (const N of expiries) {
      const tr = new Map(group(parts.train, { expiry: N, pick: profilePicker }).map((r) => [r.key, r]));
      const va = new Map(group(parts.validation, { expiry: N, pick: profilePicker }).map((r) => [r.key, r]));
      const oo = new Map(group(parts.oos, { expiry: N, pick: profilePicker }).map((r) => [r.key, r]));
      for (const [key, t] of tr) {
        if (t.n < v.minTrain) continue;
        tested++;
        const be = t.be ?? U.breakEven(85);
        const lo = wilson(t.w, t.n, v.zTrain).lo;
        const row = { key, expiry: N, profile: `${key}|E${N}`, train: strip(t), validation: strip(va.get(key)), oos: strip(oo.get(key)), be };
        if (lo < be) { row.status = 'REJECTED'; row.why = `train lower bound ${lo.toFixed(1)}% < break-even ${be.toFixed(1)}%`; results.push(row); continue; }
        const pass = (x) => x && x.n >= v.minHoldout && x.wr >= be && wilson(x.w, x.n, v.zHoldout).lo >= be;
        const vx = va.get(key), ox = oo.get(key);
        if (!vx || vx.n < v.minHoldout) { row.status = 'CANDIDATE'; row.why = `passed training; validation has ${vx?.n || 0}/${v.minHoldout} trades`; }
        else if (!pass(vx)) { row.status = 'FAILED_VALIDATION'; row.why = `validation ${vx.wr.toFixed(1)}% of ${vx.n}`; }
        else if (!ox || ox.n < v.minHoldout) { row.status = 'CANDIDATE'; row.why = `passed validation; out-of-sample has ${ox?.n || 0}/${v.minHoldout} trades`; }
        else if (!pass(ox)) { row.status = 'FAILED_VALIDATION'; row.why = `out-of-sample ${ox.wr.toFixed(1)}% of ${ox.n}`; }
        else {
          const fs = folds(t.items, v.folds).map((f) => summarize(f));
          const above = fs.filter((f) => f.n && f.wr >= be).length;
          row.folds = fs.map((f) => (f.n ? +f.wr.toFixed(1) : null));
          if (above / v.folds < 0.75) { row.status = 'UNSTABLE'; row.why = `only ${above}/${v.folds} training periods above break-even`; }
          else { row.status = 'VALIDATED'; row.why = 'passed training, validation, out-of-sample and stability'; }
        }
        results.push(row);
      }
    }
    const order = { VALIDATED: 0, UNSTABLE: 1, CANDIDATE: 2, FAILED_VALIDATION: 3, REJECTED: 4 };
    results.sort((a, b) => order[a.status] - order[b.status] || (b.train.lo ?? 0) - (a.train.lo ?? 0));
    return {
      results, tested, bounds: parts.bounds, sizes: { train: parts.train.length, validation: parts.validation.length, oos: parts.oos.length },
      // If nothing had an edge, ~5% of tested profiles would still pass training by luck (one-sided z=1.645).
      expectedFalseCandidates: +(tested * 0.05).toFixed(1),
    };
  }
  const strip = (x) => (x ? { n: x.n, w: x.w, l: x.l, t: x.t, wr: x.wr, lo: x.lo, hi: x.hi, ev: x.ev } : null);

  // Does a live decision match a promoted profile? (used to gate AUTO execution)
  // Profile "a+b|REGIME|E1"; REGIME may be "*" (any). Discovered strategies (DISC-…) match via rec.disc.
  // expiry = null accepts any expiry (the caller then trades the profile's own expiry).
  function matchProfile(rec, profiles, expiry) {
    if (!rec.decision || rec.decision === 'SKIP') return null;
    const active = new Set([...(rec.strategies || []), ...(rec.disc || [])].filter((s) => s[1] === rec.decision).map((s) => s[0]));
    for (const p of profiles || []) {
      const [strats, regime, e] = p.split('|');
      if ((regime !== '*' && regime !== rec.regime) || (expiry != null && e !== `E${expiry}`)) continue;
      if (strats.split('+').every((s) => active.has(s))) return p;
    }
    return null;
  }

  // ── strategy performance matrix ────────────────────────────────────────────
  function strategyMatrix(records, cfg = OTC.DEFAULT_CONFIG, { expiry = 1, basis = 'fired', minN = 30 } = {}) {
    const b = basis === 'active' ? 'active' : 'fired';
    const overall = by(records, 'strategy', { basis: b, expiry });
    const bestOf = (dimKey) => {
      const m = new Map();
      for (const r of group(records, { expiry, pick: (rec) => (rec.strategies || []).filter((s) => b !== 'active' || s[3]).map((s) => ({ key: `${s[0]}§${dimKey(rec)}`, dir: s[1] })) })) {
        if (r.n < minN) continue;
        const [id, dim] = r.key.split('§');
        if (!m.has(id) || r.lo > m.get(id).lo) m.set(id, { key: dim, wr: r.wr, n: r.n, lo: r.lo });
      }
      return m;
    };
    const bestRegime = bestOf((r) => r.regime), bestPair = bestOf((r) => r.asset);
    const perExpiry = new Map();
    for (const N of cfg.expiries) for (const r of by(records, 'strategy', { basis: b, expiry: N })) {
      if (r.n < minN) continue;
      if (!perExpiry.has(r.key) || r.lo > perExpiry.get(r.key).lo) perExpiry.set(r.key, { expiry: N, wr: r.wr, n: r.n, lo: r.lo });
    }
    return overall.map((r) => {
      const fs = folds(r.items.map((i) => i), cfg.validation.folds).map((f) => summarize(f));
      const wrs = fs.filter((f) => f.n >= 10).map((f) => f.wr);
      const sd = wrs.length >= 2 ? Math.sqrt(U.mean(wrs.map((x) => (x - U.mean(wrs)) ** 2))) : null;
      const st = OTC.Strategies.get(r.key);
      return { strategy: r.key, name: st?.name || r.key, family: st?.family || '?', n: r.n, w: r.w, l: r.l, t: r.t, wr: r.wr, lo: r.lo, hi: r.hi, ev: r.ev, be: r.be,
        bestRegime: bestRegime.get(r.key) || null, bestPair: bestPair.get(r.key) || null, bestExpiry: perExpiry.get(r.key) || null,
        foldWr: fs.map((f) => (f.n ? +f.wr.toFixed(1) : null)), stabilitySd: sd, enough: r.n >= minN };
    });
  }

  // Pearson correlation between module votes (+1 CALL, −1 PUT, 0 NEUTRAL) across records.
  function moduleCorrelation(records) {
    const mods = Object.keys(OTC.Confluence?.MODULES || {}).filter((m) => m !== 'volatility');
    const vec = (m) => records.map((r) => { const x = r.modules?.[m]?.[0]; return x === 'CALL' ? 1 : x === 'PUT' ? -1 : 0; });
    const V = Object.fromEntries(mods.map((m) => [m, vec(m)]));
    const corr = (a, b) => {
      const n = a.length; if (n < 3) return null;
      const ma = U.mean(a), mb = U.mean(b);
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
      return da && db ? num / Math.sqrt(da * db) : null;
    };
    return { modules: mods, matrix: mods.map((a) => mods.map((b) => corr(V[a], V[b]))), n: records.length };
  }

  // ── OTC candle research: measured behaviour, no explanations ──────────────
  function candleResearch(c) {
    if (!c || c.length < 50) return null;
    const ret = c.slice(1).map((x, i) => x.close - c[i].close);
    const lag1 = (xs) => {
      const m = U.mean(xs); let num = 0, den = 0;
      for (let i = 0; i < xs.length; i++) { den += (xs[i] - m) ** 2; if (i) num += (xs[i] - m) * (xs[i - 1] - m); }
      return den ? num / den : null;
    };
    const colors = c.map((x) => (x.close > x.open ? 1 : x.close < x.open ? -1 : 0));
    const runs = {};
    let run = 0;
    for (let i = 0; i < colors.length - 1; i++) {
      run = i && colors[i] !== 0 && colors[i] === colors[i - 1] ? run + 1 : colors[i] !== 0 ? 1 : 0;
      if (!run || colors[i + 1] === 0) continue;
      const k = Math.min(run, 6), r = (runs[k] ||= { same: 0, n: 0 });
      r.n++; if (colors[i + 1] === colors[i]) r.same++;
    }
    const atr = Ind.atr(c, 14);
    let big = 0, bigCont = 0;
    for (let i = 15; i < c.length - 1; i++) {
      const a = atr[i - 1]; if (!a) continue;
      if (c[i].high - c[i].low > 2 * a && colors[i]) { big++; if (colors[i + 1] === colors[i]) bigCont++; }
    }
    const byHour = {};
    for (const x of c) { const h = new Date(x.time * 1000).getUTCHours(); (byHour[h] ||= []).push(x.high - x.low); }
    const rngs = c.map((x) => x.high - x.low || 1e-12);
    return {
      candles: c.length, from: c[0].time, to: c[c.length - 1].time,
      returnAutocorr: lag1(ret), colorAutocorr: lag1(colors),
      sameColorAfterRun: Object.entries(runs).map(([k, r]) => ({ run: +k, n: r.n, pSame: (100 * r.same) / r.n, ...wilson(r.same, r.n, 1.96) })),
      bigCandle: { n: big, continued: big ? (100 * bigCont) / big : null, ...wilson(bigCont, big, 1.96) },
      bodyRatio: U.mean(c.map((x, i) => U.body(x) / rngs[i])),
      upperWick: U.mean(c.map((x, i) => U.upperWick(x) / rngs[i])), lowerWick: U.mean(c.map((x, i) => U.lowerWick(x) / rngs[i])),
      rangeByHour: Object.fromEntries(Object.entries(byHour).map(([h, v]) => [h, U.mean(v)])),
    };
  }

  OTC.Stats = { outcome, wilson, summarize, group, by, equity, calibration, split, folds, discoverProfiles, matchProfile,
    strategyMatrix, moduleCorrelation, candleResearch, session, PICKERS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
