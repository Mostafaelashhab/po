// Discovered strategies after the historical gates:
//   PAPER_TEST → (live paper confirmation) → WATCHLIST → (human) PROMOTED
//   PROMOTED → (live performance slips) → WATCHLIST → (keeps slipping) → DECAYING
// This file runs in the tabs (live layer), the service worker (lifecycle updates)
// and the dashboard. The live layer only ever sees strategies the worker sent it.
(function (G) {
  const OTC = G.OTC, U = OTC.U, FL = OTC.FeatureLib;
  const TRACKED = ['PAPER_TEST', 'WATCHLIST', 'PROMOTED'];
  let live = [];

  // Forward evidence decides how much a strategy's vote weighs: points above break-even
  // of the lower bound of its paper record (once big enough), else of its out-of-sample record.
  function reliability(row, dc = OTC.DEFAULT_CONFIG.discovery) {
    const p = row.paper_results, o = row.out_of_sample_results;
    const src = p && p.n >= dc.paperMinN ? p : o;
    let r = src && src.lo != null && src.be != null ? src.lo - src.be : 0;
    if (row.status === 'WATCHLIST' && /below break-even|re-evaluation/.test(row.status_reason || '')) r /= 2; // demoted: reduced confidence
    return Math.max(0, +r.toFixed(2));
  }

  function defFromRow(row, dc) {
    return { id: row.strategy_id, version: row.version, type: row.type, basis: row.basis, status: row.status, dir: row.direction, expiry: row.expiry, tf: row.tf || 300,
      rule: row.rule, name: row.name, cluster: row.cluster, reliability: reliability(row, dc) };
  }
  const trackedDefs = (latestRows, dc) => latestRows.filter((r) => TRACKED.includes(r.status) && r.rule).map((r) => defFromRow(r, dc));

  function setLive(defs) {
    live = (defs || []).map((d) => ({ ...d, rule: FL.normalize(d.rule) }));
  }

  // Votes of promoted discovered strategies. Strategies in the same correlation cluster
  // count once (the strongest fully, the rest 30%); opposite directions cancel.
  function ensemble(defs) {
    const side = (dir) => {
      const byCl = new Map();
      for (const d of defs.filter((x) => x.dir === dir)) {
        const k = d.cluster || d.id;
        if (!byCl.has(k)) byCl.set(k, []);
        byCl.get(k).push(Math.max(0.5, d.reliability || 0));
      }
      let s = 0;
      for (const ws of byCl.values()) { ws.sort((a, b) => b - a); s += ws[0] + 0.3 * U.sum(ws.slice(1)); }
      return { score: s, clusters: byCl.size };
    };
    const C = side('CALL'), P = side('PUT');
    let dir = null;
    if (C.score && !P.score) dir = 'CALL';
    else if (P.score && !C.score) dir = 'PUT';
    else if (C.score >= 2 * P.score) dir = 'CALL';
    else if (P.score >= 2 * C.score) dir = 'PUT';
    const top = dir ? (dir === 'CALL' ? C.score - P.score : P.score - C.score) : 0;
    return { dir, score: dir ? Math.round(U.clamp(60 + 3 * top, 0, 95)) : 0, CALL: C, PUT: P,
      votes: defs.map((d) => ({ id: d.id, dir: d.dir, reliability: d.reliability, cluster: d.cluster })) };
  }

  // Called at the end of the pipeline's deepAnalyze (live only; needs meta.asset).
  function apply(X, result, { dq, scan, meta }) {
    if (!live.length || !meta?.asset || !X.f5?.ready) return;
    const vec = FL.vector(FL.context(X, { scan, analysis: result, time: meta.time, candleTime: meta.candleTime, asset: meta.asset }));
    // a strategy discovered on one setup frame only runs on that frame
    const fired = live.filter((d) => (d.tf || 300) === OTC.TF.PRIMARY).filter((d) => {
      if (!FL.matches(d.rule, vec, meta.asset)) return false;
      return d.type !== 'FILTER' || vec[d.basis] === d.dir; // a filter flags the engine's own trades in its direction
    });
    if (!fired.length) return;
    result.disc = fired.map((d) => [d.id, d.dir, d.version]);
    const blocking = fired.filter((d) => d.type === 'FILTER' && d.status === 'PROMOTED' && d.dir === result.decision);
    if (blocking.length) {
      result.skipReasons.push(...blocking.map((d) => `learned filter ${d.id}: ${d.name}`));
      result.decision = 'SKIP';
    }
    const promoted = fired.filter((d) => d.type === 'STRATEGY' && d.status === 'PROMOTED');
    if (!promoted.length) return;
    const ens = ensemble(promoted);
    result.ensemble = ens;
    const names = promoted.filter((d) => d.dir === ens.dir).map((d) => d.id).join(', ');
    if (!ens.dir) { result.evidenceAgainst.push('promoted discovered strategies disagree with each other'); return; }
    if (result.decision !== 'SKIP' && result.decision !== ens.dir) {
      result.skipReasons.push(`promoted discovered strategies (${names}) point ${ens.dir}`);
      result.decision = 'SKIP';
      return;
    }
    if (result.decision === ens.dir) { result.evidenceFor.push(`promoted discovered strategies agree: ${names}`); return; }
    // Engine says SKIP: a promoted strategy may trade on its own, but never through a hard veto.
    if (!dq?.ok || X.regime.regime === 'HIGH_VOLATILITY') return;
    if (live.some((d) => d.type === 'FILTER' && d.status === 'PROMOTED' && d.dir === ens.dir && FL.matches(d.rule, vec, meta.asset) && vec[d.basis] === ens.dir)) return;
    const contra = OTC.Contradiction.evaluate(X, ens.dir, result.confluence, result.fired, X.cfg);
    if (contra.hard.length) { result.evidenceAgainst.push(`discovered ${ens.dir} blocked: ${contra.hard[0]}`); return; }
    const top = promoted.filter((d) => d.dir === ens.dir).sort((a, b) => b.reliability - a.reliability)[0];
    result.softSkipped = result.skipReasons.slice();
    result.skipReasons = [];
    result.decision = ens.dir;
    result.lean = ens.dir;
    result.setup = top.id;
    result.setupName = `${top.id} ${top.name}`;
    result.confidence = ens.score;
    result.contradiction = contra;
    result.evidenceFor = [`promoted discovered strategies: ${names}`, ...result.evidenceFor.filter((x) => !/^(trend|structure|momentum)/.test(x)).slice(0, 4)];
    result.evidenceAgainst = contra.against.map((x) => `${x.label}${x.hard ? ' [HARD]' : ''}`);
    result.risk = contra.against.some((x) => x.severity === 'high') ? 'HIGH' : contra.against.filter((x) => x.severity === 'medium').length >= 2 ? 'MEDIUM' : 'LOW';
  }

  // Paper record of one tracked strategy from live records, non-overlapping per pair.
  function paperStats(row, records, nowSec = null) {
    const since = (row.live_since || 0) / 1000, dir = row.direction, N = row.expiry;
    const rs = records.filter((r) => r.source === 'live' && (r.tf || 300) === (row.tf || 300) && r.ts >= since && (r.disc || []).some((d) => d[0] === row.strategy_id)).sort((a, b) => a.ts - b.ts);
    const busy = {}, items = [];
    for (const r of rs) {
      const out = OTC.Stats.outcome(r, dir, N);
      if (!out) continue;
      if (busy[r.asset] != null && r.ts < busy[r.asset]) continue;
      busy[r.asset] = r.ts + N * (row.tf || 300);
      items.push({ out, payout: r.payout, ts: r.ts });
    }
    return { all: OTC.Stats.summarize(items), items };
  }

  // Next lifecycle state from live paper data, or null if nothing changes.
  function liveLifecycle(row, records, dc = OTC.DEFAULT_CONFIG.discovery) {
    if (!TRACKED.includes(row.status) && row.status !== 'DECAYING') return null;
    const { all, items } = paperStats(row, records);
    const recent = OTC.Stats.summarize(items.slice(-dc.decayWindow));
    const paper = { n: all.n, w: all.w, l: all.l, t: all.t, wr: all.wr, lo: all.lo, hi: all.hi, ev: all.ev, be: all.be,
      recent: { n: recent.n, wr: recent.wr, be: recent.be } };
    const res = (status, reason) => ({ status, reason, paper });
    const be = all.be ?? U.breakEven(85);
    const filter = row.type === 'FILTER';
    if (row.status === 'PAPER_TEST') {
      if (all.n < dc.paperMinN * (filter ? 0.5 : 1)) return { status: row.status, reason: row.status_reason, paper, unchanged: true };
      if (filter) {
        if (all.wr < be) return res('WATCHLIST', `paper: flagged trades won ${all.wr.toFixed(1)}% of ${all.n} (< break-even) — eligible for promotion`);
        if (all.wr >= be + 2) return res('REJECTED', `paper: flagged trades won ${all.wr.toFixed(1)}% of ${all.n} — the filter would have blocked winners`);
      } else {
        const lo = OTC.Stats.wilson(all.w, all.n, dc.paperZ).lo;
        if (lo >= be) return res('WATCHLIST', `paper ${all.wr.toFixed(1)}% of ${all.n} confirms the backtest — eligible for promotion`);
        if (all.wr < be) return res('REJECTED', `failed paper test: ${all.wr.toFixed(1)}% of ${all.n} < break-even ${be.toFixed(1)}%`);
      }
      if (all.n >= 3 * dc.paperMinN) return res('REJECTED', `paper test inconclusive after ${all.n} trades`);
      return { status: row.status, reason: row.status_reason, paper, unchanged: true };
    }
    if (filter) return { status: row.status, reason: row.status_reason, paper, unchanged: true };
    // PROMOTED / WATCHLIST: watch the most recent window for decay.
    if (recent.n >= dc.decayWindow / 2) {
      if (recent.wr < recent.be - 2 * dc.decayPP && row.status !== 'DECAYING') return res('DECAYING', `suspended: last ${recent.n} live signals won ${recent.wr.toFixed(1)}%`);
      if (row.status === 'PROMOTED' && recent.wr < recent.be) return res('WATCHLIST', `live performance below break-even over the last ${recent.n} signals (${recent.wr.toFixed(1)}%) — confidence reduced`);
    }
    return { status: row.status, reason: row.status_reason, paper, unchanged: true };
  }

  // New version row for a status change (history preserved; older rows are never touched).
  function nextVersion(row, status, reason, nowMs, extra = {}) {
    const version = row.version + 1;
    return { ...row, ...extra, key: `${row.strategy_id}#${String(version).padStart(4, '0')}#live-${nowMs}`, version, status, status_reason: reason, updated_at: nowMs,
      live_since: status === 'PAPER_TEST' ? nowMs : row.live_since,
      history: [...(row.history || []), { stage: status, reason, at: nowMs, run: 'live' }] };
  }

  // Latest version per strategy id.
  function latest(rows) {
    const m = new Map();
    for (const r of rows) { const p = m.get(r.strategy_id); if (!p || r.version > p.version || (r.version === p.version && r.updated_at > p.updated_at)) m.set(r.strategy_id, r); }
    return [...m.values()];
  }

  OTC.Lifecycle = { TRACKED, reliability, defFromRow, trackedDefs, setLive, get live() { return live; }, ensemble, apply, paperStats, liveLifecycle, nextVersion, latest };
})(typeof globalThis !== 'undefined' ? globalThis : this);
