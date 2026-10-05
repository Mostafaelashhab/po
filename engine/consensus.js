// Strategy Consensus Engine. Every strategy in the library answers the same question on the same
// candle: CALL, PUT, WAIT (a setup is there, but with a serious objection or too weak) or NO_SIGNAL.
// No strategy trades on its own; each one is evidence.
//
//   Families     strategies reading the same information are one family (four trend indicators are one
//                trend reading): inside a family the strongest signal counts fully, the rest add 30%.
//   Reliability  each strategy's weight comes from its own track record in this kind of situation
//                (pair, frame, market state): its next-candle outcomes, recent part. Wrong more often than
//                right there → less weight, down to no vote; an edge counts only as far as it held in both the
//                older and the recent part. No track record → neutral weight 1.
//   Consensus    AGREE only when at least `minFamilies` families give the direction and no family gives
//                the other. Whether that agreement is worth a trade is decided by history (calibration):
//                there is no fixed confidence number anywhere.
(function (G) {
  const OTC = G.OTC, U = OTC.U;

  // library family → consensus family (the spec's families)
  const GROUP = { trend: 'TREND', momentum: 'MOMENTUM', priceaction: 'PRICE_ACTION', structure: 'STRUCTURE', breakout: 'BREAKOUT',
    bollinger: 'VOLATILITY', fibonacci: 'LEVELS', range: 'LEVELS', reversal: 'MEAN_REVERSION', liquidity: 'LIQUIDITY', confluence: 'HYBRID' };
  const OVERRIDE = { mean_reversion: 'MEAN_REVERSION', bb_mean_reversion: 'MEAN_REVERSION', momentum_exhaustion: 'MEAN_REVERSION',
    support_reversal: 'LEVELS', resistance_reversal: 'LEVELS' };
  const groupOf = (id, family) => OVERRIDE[id] || GROUP[family] || 'OTHER';
  const FAMILIES = ['TREND', 'MOMENTUM', 'PRICE_ACTION', 'STRUCTURE', 'BREAKOUT', 'VOLATILITY', 'LEVELS', 'LIQUIDITY', 'MEAN_REVERSION', 'HYBRID'];

  // A strategy's clean signal: its required conditions met, no serious objection, strong enough.
  const isSignal = (x, cfg) => !!x && x.valid && x.confidence >= cfg.minStrategyScore;

  // fired: OTC.Strategies.runAll output → one signal per registered strategy.
  function signals(fired, cfg = OTC.DEFAULT_CONFIG) {
    const byId = new Map((fired || []).map((x) => [x.strategy, x]));
    return OTC.Strategies.list().map((st) => {
      const x = byId.get(st.id), group = groupOf(st.id, st.family);
      if (!x) return { id: st.id, name: st.name, group, signal: 'NO_SIGNAL', score: 0 };
      return { id: st.id, name: st.name, group, signal: isSignal(x, cfg) ? x.direction : 'WAIT', dir: x.direction, score: x.confidence };
    });
  }

  // ── reliability: each strategy's own track record ──────────────────────────
  // Most specific first; the first key with enough recent outcomes is used.
  const KEYS = (id, c) => [`${id}|${c.asset}|${c.frame}`, `${id}|${c.frame}|${c.regime}`, `${id}|${c.frame}`, `${id}|${c.regime}`, id];

  // From setup records (one per analysed close; live preferred over a backtest of the same candle): every
  // clean strategy signal and the next candle's close. keys[k] = [recent n, recent wins, older n, older wins].
  function buildReliability(records, cfg = OTC.DEFAULT_CONFIG) {
    const R = cfg.consensus, builtAt = Date.now(), seen = new Map();
    for (const r of records) {
      if (r.kind === 'opp' || !Array.isArray(r.strategies) || r.entryPrice == null || r.exits?.[1] == null || r.status === 'unresolved') continue;
      const k = `${r.asset}|${r.tf || 300}|${r.candleTime}`;
      if (!seen.has(k) || r.source === 'live') seen.set(k, r);
    }
    const recs = [...seen.values()].sort((a, b) => a.ts - b.ts);
    const cut = recs.length ? recs[Math.floor(recs.length * (1 - R.recentFraction))]?.ts ?? Infinity : Infinity;
    const t = {};
    for (const r of recs) {
      const d = r.exits[1] - r.entryPrice;
      if (!d) continue;
      const c = { asset: r.asset, frame: r.tf || 300, regime: r.regime }, o = r.ts >= cut ? 0 : 2;
      for (const [id, dir, conf] of r.strategies) {
        if (!(conf >= cfg.minStrategyScore) || (dir !== 'CALL' && dir !== 'PUT')) continue;
        const win = (d > 0) === (dir === 'CALL') ? 1 : 0;
        for (const k of KEYS(id, c)) { const x = (t[k] ||= [0, 0, 0, 0]); x[o]++; x[o + 1] += win; }
      }
    }
    const keys = {};
    for (const [k, x] of Object.entries(t)) if (x[0] >= R.minN) keys[k] = x;
    return { keys, builtAt, version: `rel-${builtAt}`, meta: { records: recs.length, measured: Object.keys(keys).length, from: recs[0]?.ts ?? null, to: recs.at(-1)?.ts ?? null, cut: Number.isFinite(cut) ? cut : null } };
  }

  // → { w (0..2, 1 = neutral), measured, key, n, wr (recent %), held }
  function reliability(id, c, tables, cfg = OTC.DEFAULT_CONFIG) {
    const R = cfg.consensus, post = (n, w) => (w + R.prior / 2) / (n + R.prior);
    for (const k of KEYS(id, c)) {
      const x = tables?.keys?.[k];
      if (!x) continue;
      const pNew = post(x[0], x[1]), pOld = x[2] >= R.minN ? post(x[2], x[3]) : null;
      // wrong more often than right recently → less weight (down to none); an edge counts only as far as it
      // held in BOTH periods (the weaker of the two)
      const edge = pNew > 0.5 ? (pOld != null ? Math.min(pNew, pOld) - 0.5 : 0) : pNew - 0.5;
      const w = U.clamp(1 + R.slope * (pNew > 0.5 ? Math.max(0, edge) : edge), 0, 2);
      return { w: +w.toFixed(2), measured: true, key: k, n: x[0], wr: +((100 * x[1]) / x[0]).toFixed(1), held: pNew > 0.5 && edge > 0 };
    }
    return { w: 1, measured: false, key: null };
  }

  // ── consensus ──────────────────────────────────────────────────────────────
  // ctx: { asset, frame, regime } (reliability context). tables: buildReliability output (null = all neutral).
  function evaluate(fired, ctx, { tables = null, cfg = OTC.DEFAULT_CONFIG } = {}) {
    const R = cfg.consensus, sigs = signals(fired, cfg);
    const counts = { CALL: 0, PUT: 0, WAIT: 0, NO_SIGNAL: 0 };
    const fam = {};
    let wAll = 0, wMeasured = 0;
    for (const s of sigs) {
      counts[s.signal]++;
      if (s.signal !== 'CALL' && s.signal !== 'PUT') continue;
      const rel = reliability(s.id, ctx, tables, cfg);
      s.w = rel.w; s.measured = rel.measured; s.wr = rel.wr ?? null;
      if (rel.w <= 0) { s.muted = true; continue; } // its own record here says it is wrong more often than right
      const v = (rel.w * s.score) / 100;
      (fam[s.group] ||= { CALL: [], PUT: [] })[s.signal].push(v);
      wAll += v; if (rel.measured) wMeasured += v;
    }
    const sup = (xs) => { const v = [...xs].sort((a, b) => b - a); return v.length ? v[0] + R.sameFamily * U.sum(v.slice(1)) : 0; };
    const support = { CALL: 0, PUT: 0 }, families = { CALL: [], PUT: [] };
    for (const [g, f] of Object.entries(fam)) {
      const c = sup(f.CALL), p = sup(f.PUT);
      support.CALL += c; support.PUT += p;
      if (c > p) families.CALL.push(g); else if (p > c) families.PUT.push(g);
    }
    const dir = support.CALL > support.PUT ? 'CALL' : support.PUT > support.CALL ? 'PUT' : null;
    const opp = U.opp(dir), ff = dir ? families[dir].length : 0, fa = dir ? families[opp].length : 0;
    const status = !dir ? 'NONE' : fa > 0 ? 'SPLIT' : ff < R.minFamilies ? 'WEAK' : 'AGREE';
    const pick = (d) => sigs.filter((s) => s.signal === d && !s.muted).sort((a, b) => b.w * b.score - a.w * a.score);
    return {
      dir, status, minFamilies: R.minFamilies,
      counts: { ...counts, total: sigs.length, participating: counts.CALL + counts.PUT + counts.WAIT },
      families, support: { CALL: +support.CALL.toFixed(2), PUT: +support.PUT.toFixed(2) },
      agree: dir ? pick(dir).map((s) => s.id) : [], against: dir ? pick(opp).map((s) => s.id) : [],
      muted: sigs.filter((s) => s.muted).map((s) => s.id),
      measuredShare: wAll ? +(wMeasured / wAll).toFixed(2) : 0,
      signals: sigs.filter((s) => s.signal !== 'NO_SIGNAL'),
    };
  }

  // Compact form kept in records and opportunities (what the UI and the calibration read).
  const summary = (c) => (c ? { dir: c.dir, s: c.status, c: c.counts.CALL, p: c.counts.PUT, w: c.counts.WAIT, n: c.counts.participating, t: c.counts.total,
    ff: c.dir ? c.families[c.dir].length : 0, fa: c.dir ? c.families[U.opp(c.dir)].length : 0, fam: c.dir ? c.families[c.dir] : [], agree: c.agree.slice(0, 8), against: c.against.slice(0, 5), m: c.measuredShare } : null);

  // The reliability tables a tab received from the worker (pipeline default; replays pass null: no hindsight).
  OTC.Consensus = { evaluate, signals, reliability, buildReliability, summary, groupOf, isSignal, FAMILIES, GROUP, tables: null };
})(typeof globalThis !== 'undefined' ? globalThis : this);
