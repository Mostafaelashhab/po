// Multi-pair orchestration used by the service worker: ranks the CALL/PUT
// candidates that arrive from different pairs on the same 5M close, applies the
// Risk Engine, and resolves logged records once later 5M closes are known.
(function (G) {
  const OTC = G.OTC, U = OTC.U, TF = OTC.TF;

  // Ranks simultaneous candidates on several things, not one number. Opportunity candidates
  // carry a calibrated confidence (P(edge) from out-of-sample outcomes); that leads, and sample
  // size, stability, how readable the market is, contradictions, freshness and copy trades
  // adjust it. Older setup candidates fall back on the deep score plus measured history.
  // perf(cand) → { n, lo, be } for the candidate's setup/regime from past data, or null.
  function rank(cands, cfg, nowSec, perf = () => null) {
    return cands.map((c) => {
      const cal = c.cal;
      // measured evidence first: expected value (per stake ×100) when measured, else the engine's raw score
      const comp = { confidence: cal?.measured ? Math.round(50 + 100 * (cal.ev ?? 0)) : c.deep, measured: cal?.measured ? 10 : 0, payout: c.payout != null ? Math.round((c.payout - 92) / 2) : 0 };
      if (cal) {
        comp.sample = cal.oos ? Math.round(Math.min(10, Math.log2(cal.oos.n / 30 + 1) * 4)) : 0;
        comp.stability = cal.stable === false ? -15 : 0;
        comp.market = c.frameQuality != null ? Math.round((c.frameQuality - 50) / 10) : 0;
        comp.copy = c.copy?.dir ? (c.copy.agree && !c.copy.late ? 2 : -3) : 0;
        comp.historyNote = cal.oos ? `${cal.oos.n} similar out-of-sample trades, ${cal.oos.wr}% (${cal.level})` : 'no history';
      } else {
        const p = perf(c);
        comp.history = p && p.n >= cfg.validation.minTrain ? Math.round(U.clamp((p.lo - p.be) * 2, -20, 20)) : 0;
        comp.historyNote = p ? `${p.n} past trades, lower bound ${p.lo?.toFixed(1)}% vs break-even ${p.be?.toFixed(1)}%` : 'no history for this setup';
      }
      const elapsed = Math.max(0, nowSec - (c.entryTime ?? c.candleTime + (c.tf || 300)));
      comp.freshness = -Math.round(Math.min(1, elapsed / Math.max(10, c.validFor || cfg.entryWindowSec)) * 10);
      comp.contradictions = -Math.min(20, 3 * (c.evidenceAgainst?.length || 0));
      comp.timing = c.timing?.quality != null ? Math.round((c.timing.quality - 100) / 10) : 0;
      const priority = Object.entries(comp).filter(([k, v]) => k !== 'historyNote' && typeof v === 'number').reduce((s, [, v]) => s + v, 0);
      return { ...c, priority, priorityParts: comp };
    }).sort((a, b) => b.priority - a.priority);
  }

  // Walks the ranked list and keeps what the Risk Engine allows, highest first.
  function selectBatch(ranked, riskState, cfg, nowSec) {
    const selected = [], rejected = [];
    for (const c of ranked) {
      const r = OTC.Risk.check(c, riskState, cfg, nowSec, selected);
      if (r.ok) selected.push(c);
      else rejected.push({ cand: c, flags: r.flags });
    }
    return { selected, rejected };
  }

  // Fills exits from known closes. closes: Map(candle END time → close) for the record's asset,
  // fed by 1M candles (every minute boundary) and, for pairs on a chart, 5s candles.
  // Exit N is the close at rec.ts + N × rec.tf: setup records count candles of their frame;
  // opportunity records have tf 1, so N is seconds after entry. Returns true if it changed.
  function resolve(rec, closes, horizons, nowSec) {
    if (rec.status !== 'pending') return false;
    let changed = false;
    const tf = rec.tf || 300;
    for (const N of horizons) {
      if (rec.exits[N] != null) continue;
      const v = closes.get(rec.ts + N * tf);
      if (v != null) { rec.exits[N] = v; changed = true; }
    }
    // Horizons under 5s are resolved only by 1-second closes, sent while the pair stays on a chart; no history
    // brings them back. Once a later horizon has resolved and two minutes have passed, they never will.
    const lost = (N) => N < 5 && rec.exits[N] == null && nowSec - rec.ts > 120 && horizons.some((M) => M >= 5 && rec.exits[M] != null);
    if (horizons.every((N) => rec.exits[N] != null || lost(N))) { rec.status = 'resolved'; changed = true; }
    else if (nowSec - rec.ts > 24 * 3600) { rec.status = 'unresolved'; changed = true; } // the candles never arrived
    return changed;
  }

  // Result of a paper trade at the configured expiry, in stakes.
  function paperResult(rec, dir, expiry) {
    const out = OTC.Stats.outcome(rec, dir, expiry);
    if (!out) return null;
    return { result: out, units: out === 'W' ? (rec.payout ?? 85) / 100 : out === 'L' ? -1 : 0 };
  }

  OTC.Orchestrator = { rank, selectBatch, resolve, paperResult };
})(typeof globalThis !== 'undefined' ? globalThis : this);
