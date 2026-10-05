// Calibrated decision model. No fixed confidence number decides a trade. For each opportunity:
//
//   raw score          the engine's internal analysis score (kept separate, never used here)
//   estimated win prob posterior mean of the win rate of SIMILAR past setups, out-of-sample,
//                      with a sceptical prior centred on break-even (+ a 90% interval, sample size)
//   expected value     per stake, at the pair's CURRENT payout — the decision quantity
//   stability          walk-forward thirds of the cohort; any third below break-even → unstable
//   P(edge)            P(true win rate > break-even), reported
//
// "Similar" follows a hierarchy, most specific first; the first level with enough out-of-sample
// outcomes AND stable is used (if none is stable, the most specific measured one, flagged).
// The older part of a cohort chooses the duration (train), the newer part measures it (OOS).
// Without enough outcomes the status is INSUFFICIENT_DATA: no probability is guessed.
// Indicators agreeing can never raise anything here; only measured results can. A monitor
// compares estimated probabilities with what then happened (calibration error) and rejects the
// model if the entries it let through on measured evidence don't beat break-even.
(function (G) {
  const OTC = G.OTC, U = OTC.U;

  // ── regularized incomplete beta I_x(a, b) (Numerical Recipes) ──────────────
  function lgamma(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, t = x + 5.5;
    t -= (x + 0.5) * Math.log(t);
    let s = 1.000000000190015;
    for (const k of c) s += k / ++y;
    return -t + Math.log((2.5066282746310005 * s) / x);
  }
  function betacf(a, b, x) {
    const MAXIT = 300, EPS = 3e-12, FPMIN = 1e-300;
    let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - (qab * x) / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }
  function ibeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
  }

  // P(p > be) for w wins and l losses, prior Beta centred on break-even with `strength` pseudo-trades.
  function pEdge(w, l, bePct, strength = 20) {
    const be = bePct / 100, a = strength * be + w, b = strength * (1 - be) + l;
    return 1 - ibeta(be, a, b);
  }

  // ── cohorts ────────────────────────────────────────────────────────────────
  // Which past records count as "similar". Most specific first; the first level with enough
  // out-of-sample outcomes is used (the choice depends on sample size only, never on results).
  const LEVELS = [
    { id: 'pair', key: (c) => `${c.frame}|${c.setup}|${c.dir}|${c.regime}|${c.asset}` },     // pair + strategy + frame + direction + regime
    { id: 'pair_setup', key: (c) => `${c.frame}|${c.setup}|${c.dir}|*|${c.asset}` },         // pair + strategy + frame + direction
    { id: 'setup_regime', key: (c) => `${c.frame}|${c.setup}|${c.dir}|${c.regime}` },       // strategy + frame + direction + regime
    { id: 'setup', key: (c) => `${c.frame}|${c.setup}|${c.dir}` },                          // strategy + frame + direction
    // how many strategy families agreed (engine/consensus.js) + frame + direction: does this KIND of agreement pay?
    // (opportunities from v0.11 on; copy signals have their own cohorts)
    { id: 'consensus', key: (c) => (c.ff ? `${c.frame}|F${c.ff}|${c.dir}` : null) },
    { id: 'kind_regime', key: (c) => `${c.frame}|k:${c.kind}|${c.dir}|${c.regime}` },       // strategy family + frame + regime
    { id: 'kind', key: (c) => `${c.frame}|k:${c.kind}|${c.dir}` },                          // strategy family + frame
    { id: 'frame', key: (c) => `${c.frame}|*|${c.dir}` },                                   // broader population of the frame
  ];

  // A record as a cohort member: its descriptors and its outcome at each horizon (SECONDS after the
  // record's time). Opportunity records: exit keys × rec.tf seconds (tf 1 = keyed in seconds;
  // older ones tf 60 = minutes). Setup records: exit N = N candles of the frame.
  // source 'entries': live opportunities that reached an entry (entered, or gated below the bar),
  //   measured from the entry close — the population a new entry belongs to.
  // source 'setups': per-frame analyses where the setup strategy was active, measured from
  //   the setup close (live, and backtest at reduced weight: it assumes perfect entries).
  function member(r) {
    const dir = r.lean || (r.decision !== 'SKIP' ? r.decision : null);
    if (!dir || !r.setup || r.status === 'unresolved') return null;
    const ff = r.origin !== 'copy' && r.cons?.dir === dir && r.cons.ff ? Math.min(r.cons.ff, 5) : null; // families that agreed
    if (r.kind === 'opp') {
      if (!r.path?.some((s) => s === 'ENTERED' || s === 'GATED')) return null;
      const h = {}, unit = r.tf || 60;
      for (const [k, px] of Object.entries(r.exits || {})) if (px != null) h[k * unit] = px;
      return { source: 'entries', w: 1, ts: r.ts, frame: r.frame, setup: r.setup, kind: r.setupKind || r.facts?.kind || 'trend', dir, regime: r.regime, asset: r.asset, entry: r.entryPrice, h, payout: r.payout, ff };
    }
    const tf = r.tf || 300;
    if (!(r.strategies || []).some((s) => s[0] === r.setup && s[1] === dir && s[3])) return null;
    const h = {};
    for (const [N, px] of Object.entries(r.exits || {})) if (px != null) h[N * tf] = px;
    return { source: 'setups', w: r.source === 'backtest' ? 0.5 : 1, ts: r.ts, frame: tf, setup: r.setup, kind: r.facts?.kind || OTC.Facts?.setupKind?.(r.setup) || 'trend',
      dir, regime: r.regime, asset: r.asset, entry: r.entryPrice, h, payout: r.payout, ff };
  }
  const outcomeOf = (m, sec) => {
    const px = m.h[sec];
    if (px == null || m.entry == null) return null;
    const d = px - m.entry;
    return Math.abs(d) < 1e-12 ? 'T' : (d > 0) === (m.dir === 'CALL') ? 'W' : 'L';
  };

  // tables[source][key][seconds] = { sel: [w, l], oos: [w, l], folds: [[w, l] ×k], n }
  // Built by the service worker from all records; sent to the tabs.
  function buildTables(records, cfg = OTC.DEFAULT_CONFIG) {
    const builtAt = Date.now();
    const g = cfg.gate, out = { entries: {}, setups: {}, builtAt, version: `cal-${builtAt}` };
    let first = Infinity, last = -Infinity, members = 0;
    const groups = { entries: new Map(), setups: new Map() };
    for (const r of records) {
      const m = member(r);
      if (!m) continue;
      members++; first = Math.min(first, m.ts); last = Math.max(last, m.ts);
      for (const L of LEVELS) {
        const k = L.key(m);
        if (k == null) continue;
        const map = groups[m.source];
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(m);
      }
    }
    for (const src of ['entries', 'setups']) {
      for (const [k, items] of groups[src]) {
        items.sort((a, b) => a.ts - b.ts);
        const byH = {};
        const horizons = new Set(items.flatMap((m) => Object.keys(m.h).map(Number)));
        for (const H of horizons) {
          // one trade at a time per cohort: overlapping outcomes are not independent
          const seq = [];
          let busy = -Infinity;
          for (const m of items) {
            if (m.ts < busy) continue;
            const o = outcomeOf(m, H);
            if (!o || o === 'T') continue;
            seq.push([o === 'W' ? m.w : 0, o === 'L' ? m.w : 0]);
            busy = m.ts + H;
          }
          const n = seq.reduce((s, x) => s + x[0] + x[1], 0);
          if (n < g.minTableN) continue;
          const cut = Math.floor(seq.length * g.selFraction);
          const sum = (xs) => xs.reduce((s, x) => [s[0] + x[0], s[1] + x[1]], [0, 0]).map((v) => +v.toFixed(2));
          const folds = [];
          for (let f = 0; f < g.folds; f++) folds.push(sum(seq.slice(Math.floor((f * seq.length) / g.folds), Math.floor(((f + 1) * seq.length) / g.folds))));
          byH[H] = { sel: sum(seq.slice(0, cut)), oos: sum(seq.slice(cut)), folds, n: +n.toFixed(2) };
        }
        if (Object.keys(byH).length) out[src][k] = byH;
      }
    }
    // Track record of each frame as a whole (all setups on it, one candle ahead), for frame selection.
    out.frames = {};
    const byFrame = {};
    for (const r of records) {
      const m = member(r);
      if (!m || m.source !== 'setups') continue;
      const o = outcomeOf(m, m.frame);
      if (!o || o === 'T') continue;
      const b = (byFrame[m.frame] ||= { w: 0, l: 0, pay: [] });
      b[o === 'W' ? 'w' : 'l'] += m.w;
      if (b.pay.length < 500) b.pay.push(m.payout ?? 85);
    }
    for (const [tf, b] of Object.entries(byFrame)) if (b.w + b.l >= g.minOOS) out.frames[tf] = +(100 * pEdge(b.w, b.l, U.breakEven(U.mean(b.pay)), g.priorStrength)).toFixed(1);
    // reproducibility: what this version was built from
    out.meta = { records: records.length, members, from: Number.isFinite(first) ? first : null, to: Number.isFinite(last) ? last : null,
      cohorts: { entries: Object.keys(out.entries).length, setups: Object.keys(out.setups).length }, selFraction: g.selFraction, minOOS: g.minOOS, priorStrength: g.priorStrength };
    return out;
  }

  // c: { frame, setup, kind, dir, regime, asset, payout, ff (families that agreed, if any) }
  // Returns { status: 'MEASURED' | 'INSUFFICIENT_DATA', measured, reason, winProb, interval, ev, evLo, p, n, oos,
  //           stable, folds, level, source, key, expirySec, expiry, be, version }.
  // sources / levels: restrict which cohorts may be used (copy signals use only their own).
  // learnDirection: the older part of each cohort also decides whether this kind of opportunity is traded WITH its
  // setup or AGAINST it (the same outcomes read the other way) — OTC prices were seen to reverse after strong
  // agreement for hours at a time. The newer part then measures the chosen direction: no selection on it.
  // Result: reversed true = trade the opposite of c.dir; winProb, ev … are for the direction to trade.
  function assess(c, tables, { cfg = OTC.DEFAULT_CONFIG, available = null, expiryOpts = {}, sources = ['entries', 'setups'], levels = null, learnDirection = false } = {}) {
    const g = cfg.gate, pay = c.payout ?? 85, be = U.breakEven(pay);
    const choose = (history) => OTC.Expiry.choose({ tf: c.frame, kind: c.kind, available, history, cfg, ...expiryOpts });
    // cohorts with enough out-of-sample outcomes, most specific first (live entries before research setups)
    const cands = [];
    for (const src of sources) for (const L of LEVELS) {
      if (levels && !levels.includes(L.id)) continue;
      const key = L.key(c);
      const t = key == null ? null : tables?.[src]?.[key];
      if (t && Math.max(...Object.values(t).map((x) => x.oos[0] + x.oos[1])) >= g.minOOS) cands.push({ src, L, t });
    }
    const pick = (t) => choose((sec) => { const x = t[sec]; if (!x) return null; const n = x.sel[0] + x.sel[1]; if (!n) return null;
      return { n, wr: (100 * x.sel[0]) / n, lo: OTC.Stats.wilson(x.sel[0], n).lo, be }; });
    const mirror = (t) => Object.fromEntries(Object.entries(t).map(([sec, x]) => [sec, { sel: [x.sel[1], x.sel[0]], oos: [x.oos[1], x.oos[0]], folds: x.folds.map(([w, l]) => [l, w]), n: x.n }]));
    const selWr = (t, sec) => { const x = t[sec], n = x ? x.sel[0] + x.sel[1] : 0; return n ? x.sel[0] / n : null; };
    const evaluate = ({ src, L, t: t0 }) => {
      // the duration (and, learning direction, the direction) is chosen on the older part only (train), then locked
      let t = t0, ex = pick(t0), reversed = false;
      if (learnDirection) {
        const r = mirror(t0), exR = pick(r), wf = selWr(t0, ex.sec), wr = selWr(r, exR.sec);
        if (wr != null && wr > 0.5 && (wf == null || wr > wf)) { t = r; ex = exR; reversed = true; }
      }
      const x = t[ex.sec], base = { expirySec: ex.sec, expiry: { source: ex.source, reason: ex.reason }, source: src, level: L.id, key: L.key(c), reversed };
      if (!x || x.oos[0] + x.oos[1] < g.minOOS) return { ...base, measured: false };
      // …and measured on the newer part (out-of-sample)
      const [w, l] = x.oos, n = w + l, a = g.priorStrength * (be / 100) + w, b = g.priorStrength * (1 - be / 100) + l;
      const winProb = (100 * a) / (a + b), ci = OTC.Stats.wilson(w, n);
      const evOf = (q) => +((q / 100) * (pay / 100) - (1 - q / 100)).toFixed(4);
      const folds = x.folds.map(([fw, fl]) => ({ n: fw + fl, wr: fw + fl ? (100 * fw) / (fw + fl) : null }));
      const stable = folds.every((f) => f.n < g.foldMinN || f.wr >= be);
      return { ...base, measured: true, winProb: +winProb.toFixed(1), interval: [+ci.lo.toFixed(1), +ci.hi.toFixed(1)], ev: evOf(winProb), evLo: evOf(ci.lo),
        p: +(100 * pEdge(w, l, be, g.priorStrength)).toFixed(1), n: +n.toFixed(1), oos: { w, l, n: +n.toFixed(1), wr: +((100 * w) / n).toFixed(1) }, stable, folds };
    };
    let firstMeasured = null, chosen = null;
    for (const cd of cands) {
      const r = evaluate(cd);
      if (!r.measured) continue;
      firstMeasured ||= r;
      if (r.stable) { chosen = r; break; }
    }
    const r = chosen || firstMeasured;
    if (!r) {
      const ex = choose(null);
      // how far the most advanced similar cohort is, at this duration: outcomes so far / outcomes needed
      // (minOOS in the newer part = minOOS / (1 − selFraction) in all)
      let have = 0;
      for (const src of sources) for (const L of LEVELS) {
        if (levels && !levels.includes(L.id)) continue;
        const key = L.key(c), x = key == null ? null : tables?.[src]?.[key]?.[ex.sec];
        if (x) have = Math.max(have, Math.round(x.n));
      }
      return { status: 'INSUFFICIENT_DATA', measured: false, reason: cands.length ? 'no_history_at_duration' : 'no_history', winProb: null, interval: null, ev: null, evLo: null,
        p: 0, n: 0, oos: null, stable: null, folds: null, level: null, source: null, key: null, expirySec: ex.sec, expiry: { source: ex.source, reason: ex.reason }, be, version: tables?.version ?? null,
        have, need: Math.ceil(g.minOOS / (1 - g.selFraction)) };
    }
    return { ...r, status: 'MEASURED', reason: r.stable ? 'measured' : 'unstable', be, version: tables?.version ?? null };
  }

  // ── is the model honest? ───────────────────────────────────────────────────
  // Entries (traded or gated) resolved at their own duration. Measured ones are bucketed by the win
  // probability estimated at entry and compared with what happened (calibration error). The entries
  // the model let through ON MEASURED EVIDENCE decide its status: once monitorMinN have resolved,
  // win rate upper bound below break-even → REJECTED, lower bound above → CONFIRMED.
  function monitor(records, cfg = OTC.DEFAULT_CONFIG) {
    const g = cfg.gate;
    // judged on the recent window only: a model rejected on old entries is re-judged once they age out
    const newest = records.reduce((m, r) => Math.max(m, r.ts || 0), 0), since = newest - (g.monitorWindowH ?? 48) * 3600;
    records = records.filter((r) => (r.ts || 0) >= since);
    const rows = [[null, null], [0, 50], [50, 55], [55, 60], [60, 65], [65, 101]].map(([lo, hi]) => ({ lo, hi, w: 0, l: 0, t: 0, pay: [], pred: [] }));
    const top = { w: 0, l: 0, t: 0, pay: [], pred: [] };
    const add = (b, o, pay, pred) => { b[{ W: 'w', L: 'l', T: 't' }[o]]++; b.pay.push(pay ?? 85); if (pred != null && o !== 'T') b.pred.push(pred); };
    for (const r of records) {
      if (r.kind !== 'opp' || !r.cal || !r.expirySec || !r.path?.some((s) => s === 'ENTERED' || s === 'GATED')) continue;
      const o = OTC.Stats.outcome(r, r.fade ? U.opp(r.lean) : r.lean, r.expirySec / (r.tf || 60)); // a reversed entry traded the other way
      if (!o) continue;
      const measured = r.cal.measured ?? (r.cal.reason === 'measured' || r.cal.reason === 'unstable');
      const pred = r.cal.winProb ?? null;
      add(measured && pred != null ? rows.find((b) => b.lo != null && pred >= b.lo && pred < b.hi) : rows[0], o, r.payout, pred);
      if (measured && r.cal.qualified) add(top, o, r.payout, pred);
    }
    const fin = (b) => {
      const n = b.w + b.l, ci = OTC.Stats.wilson(b.w, n);
      b.n = n; b.wr = n ? (100 * b.w) / n : null; b.ci = [ci.lo, ci.hi]; b.be = U.breakEven(b.pay.length ? U.mean(b.pay) : 85);
      b.predicted = b.pred.length ? U.mean(b.pred) : null;
      delete b.pay; delete b.pred;
      return b;
    };
    rows.forEach(fin); fin(top);
    // expected calibration error over the measured buckets (percentage points)
    const measuredRows = rows.filter((b) => b.lo != null && b.n && b.predicted != null), N = measuredRows.reduce((s, b) => s + b.n, 0);
    const calibrationError = N ? +(measuredRows.reduce((s, b) => s + (b.n / N) * Math.abs(b.predicted - b.wr), 0)).toFixed(1) : null;
    let status = 'COLLECTING';
    if (top.n >= g.monitorMinN) status = top.ci[1] < top.be ? 'REJECTED' : top.ci[0] >= top.be ? 'CONFIRMED' : 'OK';
    return { status, rows, top, calibrationError, measuredN: N };
  }

  OTC.Calibration = { pEdge, ibeta, LEVELS, member, buildTables, assess, monitor };
})(typeof globalThis !== 'undefined' ? globalThis : this);
