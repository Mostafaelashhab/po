// Calibrated confidence. The confidence that gates a trade is NOT a score built from how
// many indicators agree, and NOT a promised win rate. It is:
//
//     P( true win rate of this kind of setup > break-even  |  outcomes of similar past setups )
//
// computed from resolved outcomes only, with a sceptical prior centred on break-even, on
// data that was not used to choose the duration (chronological split: the older part picks
// the horizon, the newer part is out-of-sample and gives the probability). Indicators
// agreeing can never raise it; only measured results can. Unstable cohorts (a walk-forward
// fold below break-even) are capped below any gate. A monitor checks afterwards whether
// decisions above the gate really beat break-even; if they don't, the model is rejected.
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
    { id: 'pair', key: (c) => `${c.frame}|${c.setup}|${c.dir}|${c.regime}|${c.asset}` },
    { id: 'setup_regime', key: (c) => `${c.frame}|${c.setup}|${c.dir}|${c.regime}` },
    { id: 'setup', key: (c) => `${c.frame}|${c.setup}|${c.dir}` },
    { id: 'kind_regime', key: (c) => `${c.frame}|k:${c.kind}|${c.dir}|${c.regime}` },
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
    if (r.kind === 'opp') {
      if (!r.path?.some((s) => s === 'ENTERED' || s === 'GATED')) return null;
      const h = {}, unit = r.tf || 60;
      for (const [k, px] of Object.entries(r.exits || {})) if (px != null) h[k * unit] = px;
      return { source: 'entries', w: 1, ts: r.ts, frame: r.frame, setup: r.setup, kind: r.setupKind || r.facts?.kind || 'trend', dir, regime: r.regime, asset: r.asset, entry: r.entryPrice, h, payout: r.payout };
    }
    const tf = r.tf || 300;
    if (!(r.strategies || []).some((s) => s[0] === r.setup && s[1] === dir && s[3])) return null;
    const h = {};
    for (const [N, px] of Object.entries(r.exits || {})) if (px != null) h[N * tf] = px;
    return { source: 'setups', w: r.source === 'backtest' ? 0.5 : 1, ts: r.ts, frame: tf, setup: r.setup, kind: r.facts?.kind || OTC.Facts?.setupKind?.(r.setup) || 'trend',
      dir, regime: r.regime, asset: r.asset, entry: r.entryPrice, h, payout: r.payout };
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
    const g = cfg.gate, out = { entries: {}, setups: {}, builtAt: Date.now() };
    const groups = { entries: new Map(), setups: new Map() };
    for (const r of records) {
      const m = member(r);
      if (!m) continue;
      for (const L of LEVELS) {
        const k = L.key(m);
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
    return out;
  }

  // c: { frame, setup, kind, dir, regime, asset, payout }
  // Picks the cohort, lets the expiry engine choose the duration on the SELECTION part, and
  // computes P(edge) on the OUT-OF-SAMPLE part at that duration.
  // Returns { p (0–100), expirySec, expiry, source, level, key, oos: {w, l, n, wr}, stable, folds, be, reason }.
  function assess(c, tables, { cfg = OTC.DEFAULT_CONFIG, available = null, expiryOpts = {} } = {}) {
    const g = cfg.gate, be = U.breakEven(c.payout ?? 85);
    let pick = null;
    for (const src of ['entries', 'setups']) {
      for (const L of LEVELS) {
        const t = tables?.[src]?.[L.key(c)];
        if (!t) continue;
        const best = Math.max(...Object.values(t).map((x) => x.oos[0] + x.oos[1]));
        if (best >= g.minOOS) { pick = { src, L, t }; break; }
      }
      if (pick) break;
    }
    const sel = pick ? (sec) => { const x = pick.t[sec]; if (!x) return null; const n = x.sel[0] + x.sel[1]; if (!n) return null;
      const wr = (100 * x.sel[0]) / n; return { n, wr, lo: OTC.Stats.wilson(x.sel[0], n).lo, be }; } : null;
    const ex = OTC.Expiry.choose({ tf: c.frame, kind: c.kind, available, history: sel, cfg, ...expiryOpts });
    const base = { expirySec: ex.sec, expiry: { source: ex.source, reason: ex.reason }, be };
    if (!pick) return { ...base, p: 0, source: null, level: null, key: null, oos: null, stable: null, folds: null, reason: 'no_history' };
    const x = pick.t[ex.sec];
    if (!x || x.oos[0] + x.oos[1] < g.minOOS) {
      return { ...base, p: 0, source: pick.src, level: pick.L.id, key: pick.L.key(c), oos: null, stable: null, folds: null, reason: 'no_history_at_duration' };
    }
    const [w, l] = x.oos, n = w + l;
    let p = 100 * pEdge(w, l, be, g.priorStrength);
    const folds = x.folds.map(([fw, fl]) => ({ n: fw + fl, wr: fw + fl ? (100 * fw) / (fw + fl) : null }));
    const stable = folds.every((f) => f.n < g.foldMinN || f.wr >= be);
    let reason = 'measured';
    if (!stable) { p = Math.min(p, g.unstableCap); reason = 'unstable'; }
    return { ...base, p: +p.toFixed(1), source: pick.src, level: pick.L.id, key: pick.L.key(c), oos: { w, l, n: +n.toFixed(1), wr: +((100 * w) / n).toFixed(1) },
      stable, folds, reason };
  }

  // ── is the confidence honest? ──────────────────────────────────────────────
  // Entries (traded or gated) resolved at their own duration, by the confidence claimed at entry.
  // Entries whose MEASURED confidence was at or above minConfidence are the ones the model let
  // through on evidence; once monitorMinN have resolved, if their win rate's upper bound is below
  // break-even the model is rejected, and if the lower bound is above it, confirmed.
  function monitor(records, cfg = OTC.DEFAULT_CONFIG) {
    const g = cfg.gate;
    const rows = [[null, null], [0, 50], [50, 70], [70, 90], [90, 101]].map(([lo, hi]) => ({ lo, hi, w: 0, l: 0, t: 0, pay: [] }));
    const top = { w: 0, l: 0, t: 0, pay: [] };
    const add = (b, o, pay) => { b[{ W: 'w', L: 'l', T: 't' }[o]]++; b.pay.push(pay ?? 85); };
    for (const r of records) {
      if (r.kind !== 'opp' || !r.cal || !r.expirySec || !r.path?.some((s) => s === 'ENTERED' || s === 'GATED')) continue;
      const o = OTC.Stats.outcome(r, r.lean, r.expirySec / (r.tf || 60));
      if (!o) continue;
      const measured = r.cal.reason === 'measured' || r.cal.reason === 'unstable';
      add(measured ? rows.find((b) => b.lo != null && r.cal.p >= b.lo && r.cal.p < b.hi) : rows[0], o, r.payout);
      if (measured && r.cal.p >= g.minConfidence) add(top, o, r.payout);
    }
    const fin = (b) => {
      const n = b.w + b.l, ci = OTC.Stats.wilson(b.w, n);
      b.n = n; b.wr = n ? (100 * b.w) / n : null; b.ci = [ci.lo, ci.hi]; b.be = U.breakEven(b.pay.length ? U.mean(b.pay) : 85);
      delete b.pay;
      return b;
    };
    rows.forEach(fin); fin(top);
    let status = 'COLLECTING';
    if (top.n >= g.monitorMinN) status = top.ci[1] < top.be ? 'REJECTED' : top.ci[0] >= top.be ? 'CONFIRMED' : 'OK';
    return { status, rows, top, gate: g.minConfidence };
  }

  OTC.Calibration = { pEdge, ibeta, LEVELS, member, buildTables, assess, monitor };
})(typeof globalThis !== 'undefined' ? globalThis : this);
