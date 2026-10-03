// Strategy Discovery Engine — assessment, lifecycle gates, ranking, explanation,
// storage rows and the full discovery cycle.
(function (G) {
  const OTC = G.OTC, U = OTC.U, FL = OTC.FeatureLib, D = OTC.Discovery, TF = OTC.TF;
  const LIVE = ['PAPER_TEST', 'WATCHLIST', 'PROMOTED'];
  const FAIL = ['REJECTED', 'OVERFIT', 'UNSTABLE', 'DECAYING', 'INSUFFICIENT_DATA', 'SUSPENDED'];
  const AWAIT = ['VALIDATING', 'OUT_OF_SAMPLE'];

  // Nudged versions of every threshold (and EMA period) in the rule.
  function paramNeighbors(rule) {
    const out = [];
    rule.all.forEach((a, i) => {
      const f = a.or ? null : FL.get(a.f);
      if (!f) return;
      const swap = (b, why) => out.push({ rule: { ...rule, all: rule.all.map((x, j) => (j === i ? b : x)) }, why, atom: b });
      if (f.type === 'num' && f.grid) {
        const g = f.grid;
        if (a.op === 'between') {
          const li = g.indexOf(a.v[0]), hj = g.indexOf(a.v[1]);
          for (const [x, y] of [[li - 1, hj - 1], [li + 1, hj + 1], [li - 1, hj], [li, hj + 1], [li + 1, hj]]) {
            if (x >= 0 && y < g.length && x < y && li >= 0 && hj >= 0) swap({ f: a.f, op: 'between', v: [g[x], g[y]] }, `${f.label} ${g[x]}…${g[y]}`);
          }
        } else if (a.op === '<=' || a.op === '>=') {
          const k = g.indexOf(a.v);
          for (const d of [-2, -1, 1, 2]) if (k >= 0 && g[k + d] != null) swap({ ...a, v: g[k + d] }, `${f.label} ${a.op} ${g[k + d]}`);
        }
      }
      for (const v of f.variants || []) swap({ ...a, f: v }, FL.get(v)?.label || v);
    });
    return out;
  }

  function robustness(ds, rule, sp, dc, base) {
    const nb = paramNeighbors(rule);
    if (!nb.length) return { label: 'N/A', score: null, neighbors: [], note: 'no numeric thresholds to perturb' };
    const neighbors = nb.map(({ rule: r, why, atom }) => {
      const s = D.evalRule(ds, r, ...sp.train, dc.zTrain);
      const pass = s.n >= dc.minTrainN / 2 && s.wr != null && s.wr >= s.be && s.wr >= base.wr - dc.robustTolPP;
      return { why, atom, n: s.n, wr: s.wr, lo: s.lo, pass };
    });
    const score = neighbors.filter((x) => x.pass).length / neighbors.length;
    return { label: score >= 0.75 ? 'HIGH' : score >= dc.robustMin ? 'MEDIUM' : 'LOW', score, neighbors };
  }

  // How much each condition contributes: the drop in training lower bound without it.
  function importance(ds, rule, sp, dc, base) {
    const parts = [];
    rule.all.forEach((a, i) => {
      if (rule.all.length < 2) return;
      const s = D.evalRule(ds, { ...rule, all: rule.all.filter((_, j) => j !== i) }, ...sp.train, dc.zTrain);
      parts.push({ condition: FL.label(a), atom: a, kind: 'condition', drop: (base.lo ?? 0) - (s.lo ?? 0), wrWithout: s.wr, nWithout: s.n });
    });
    (rule.none || []).forEach((a, i) => {
      const s = D.evalRule(ds, { ...rule, none: rule.none.filter((_, j) => j !== i) }, ...sp.train, dc.zTrain);
      parts.push({ condition: `NOT ${FL.label(a)}`, atom: a, kind: 'negative', drop: (base.lo ?? 0) - (s.lo ?? 0), wrWithout: s.wr, nWithout: s.n });
    });
    return parts.sort((a, b) => b.drop - a.drop).map((p) => ({ ...p, drop: +p.drop.toFixed(2), low: p.drop < 0.5 }));
  }

  function phiOf(a, b, from, to) {
    let n11 = 0, n10 = 0, n01 = 0, n00 = 0;
    for (let i = from; i < to; i++) { if (a[i]) { if (b[i]) n11++; else n10++; } else if (b[i]) n01++; else n00++; }
    const d = Math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00));
    return d ? (n11 * n00 - n10 * n01) / d : 0;
  }

  // ── assess one candidate (no gate decisions yet) ───────────────────────────
  function assess(ds, cand, sp, dc, ctx) {
    const rule = cand.rule, N = rule.expiry, dir = rule.dir, isFilter = cand.type === 'FILTER';
    const mask = D.ruleMask(ds, rule);
    let evalM = mask, compl = null;
    if (isFilter) { // filter: the engine's trades that match vs. those that don't
      const pop = D.atomMask(ds, { f: cand.basis, op: '==', v: dir });
      evalM = new Uint8Array(ds.n); compl = new Uint8Array(ds.n);
      for (let i = 0; i < ds.n; i++) { evalM[i] = pop[i] & mask[i]; compl[i] = pop[i] & (mask[i] ^ 1); }
    }
    const ev = (from, to, z = dc.zTrain) => D.evalMask(ds, evalM, dir, N, from, to, z);
    const train = ev(...sp.train), val = ev(...sp.validation), oos = ev(...sp.oos, dc.zOos), dev = ev(0, sp.cut2);
    const c = { ...cand, name: FL.name(rule), dir, expiry: N, complexity: FL.complexity(rule), train, val, oos, flags: [], history: [] };
    c.sampleClass = D.sampleClass(train.n, dc);
    c.timeframes = [...new Set(rule.all.map(FL.tfOfAtom).filter(Boolean))].sort((a, b) => b - a).map((t) => ({ 1: '1M', 5: '5M', 15: '15M', 60: '1H' }[t]));
    c.regimes = rule.all.filter((a) => a.f === 'ctx.regime' && a.op === '==').map((a) => a.v);
    c.baseline = ctx.baseline[`${dir}|${N}`];
    if (isFilter) {
      const cev = (from, to) => D.evalMask(ds, compl, dir, N, from, to);
      c.complement = { train: D.strip(cev(...sp.train)), val: D.strip(cev(...sp.validation)), oos: D.strip(cev(...sp.oos)) };
      const z = (s, o) => D.twoPropZ(s.w, s.n, o.w, o.n);
      c.z = { train: z(train, c.complement.train), val: z(val, c.complement.val), oos: z(oos, c.complement.oos) };
      return c;
    }
    if (train.n < dc.minTrainN) return c;
    c.robustness = robustness(ds, rule, sp, dc, train);
    c.importance = importance(ds, rule, sp, dc, train);
    // periods and fixed-rule walk-forward over train + validation
    const folds = D.foldBounds(0, sp.cut2, dc.wfFolds);
    c.periods = folds.map(([a, b]) => ({ from: ds.time[a], to: ds.time[Math.max(a, b - 1)], ...D.strip(ev(a, b)) }));
    const usable = c.periods.filter((p) => p.n >= 20);
    c.passRatio = usable.length ? usable.filter((p) => p.wr >= p.be).length / usable.length : 0;
    const wfIdx = [];
    let selections = 0;
    for (let k = 1; k < folds.length; k++) {
      const hist = ev(0, folds[k][0], 1.0);
      if (hist.n >= dc.minTrainN / 2 && hist.lo >= hist.be) { selections++; wfIdx.push(...ev(...folds[k]).idx); }
    }
    c.walkForward = { selections, folds: folds.length - 1, ...D.summarize(ds, wfIdx, dir, N) };
    // time stability: older two thirds vs most recent third of train + validation
    const cut = Math.floor((sp.cut2 * 2) / 3), older = ev(0, cut), recent = ev(cut, sp.cut2);
    const sd = usable.length >= 3 ? Math.sqrt(U.mean(usable.map((p) => (p.wr - U.mean(usable.map((q) => q.wr))) ** 2))) : null;
    c.stability = recent.n < 30 || older.n < 30 ? 'UNKNOWN'
      : older.wr >= older.be && recent.wr < recent.be - dc.decayPP ? 'DECAYING'
      : older.wr < older.be && recent.wr >= recent.be ? 'IMPROVING'
      : sd != null && sd > 12 ? 'UNSTABLE' : older.wr >= older.be && recent.wr >= recent.be - 2 ? 'STABLE' : 'WEAK';
    c.stabilityDetail = { older: D.strip(older), recent: D.strip(recent), periodSd: sd };
    // regimes, pairs, sessions, engine score, other expiries — all on train + validation
    c.regimeBreakdown = D.breakdown(ds, dev.idx, dir, N, D.catAt(ds, 'ctx.regime'), 10);
    c.pairBreakdown = D.breakdown(ds, dev.idx, dir, N, (i) => ds.assets[ds.asset[i]], 10);
    c.sessionBreakdown = D.breakdown(ds, dev.idx, dir, N, D.catAt(ds, 'time.session'), 10);
    const deep = ds.cols['eng.deep'];
    c.scoreBreakdown = deep ? D.breakdown(ds, dev.idx, dir, N, (i) => (deep.data[i] === deep.data[i] ? `${Math.floor(deep.data[i] / 20) * 20}–${Math.floor(deep.data[i] / 20) * 20 + 20}` : null), 10) : [];
    c.expiryBreakdown = ds.expiries.map((M) => ({ key: `E${M}`, ...D.strip(D.evalMask(ds, mask, dir, M, 0, sp.cut2)) }));
    const eligible = c.pairBreakdown.filter((p) => p.n >= 30), passing = eligible.filter((p) => p.wr >= p.be);
    c.crossPair = rule.pairs?.length || rule.all.some((a) => a.f === 'pair') ? 'PAIR_SPECIFIC'
      : eligible.length <= 1 ? 'SINGLE_PAIR_DATA'
      : passing.length === 1 ? 'PAIR_SPECIFIC'
      : passing.length / eligible.length >= 0.7 && eligible.length >= 3 ? 'MULTI_PAIR_STABLE'
      : passing.length >= 2 ? 'CROSS_PAIR' : 'NO_PAIR_WORKS';
    c.regimesCovered = c.regimeBreakdown.filter((r) => r.n >= 30 && r.wr >= r.be).map((r) => r.key);
    const mr = FL.mirrorRule(rule);
    c.mirror = mr ? { name: FL.name(mr), ...D.strip(D.evalRule(ds, mr, 0, sp.cut2)) } : null;
    // similarity with existing library strategies (same direction)
    c.similarLibrary = [];
    for (const f of FL.FEATURES) {
      if (f.group !== 'strategy' || !ds.cols[f.id]) continue;
      const p = phiOf(mask, D.atomMask(ds, { f: f.id, op: '==', v: dir }), 0, sp.cut2);
      if (p >= 0.5) c.similarLibrary.push({ strategy: f.strategy, phi: +p.toFixed(2) });
    }
    c.similarLibrary.sort((a, b) => b.phi - a.phi);
    return c;
  }

  // ── gates → lifecycle status ───────────────────────────────────────────────
  function finalize(c, dc) {
    const H = (stage, reason) => c.history.push({ stage, reason });
    const done = (status, reason) => { c.status = status; c.statusReason = reason; H(status, reason); return c; };
    H('DISCOVERED', c.mutation ? `${c.origin}: ${c.mutation}` : c.origin);
    H('BACKTESTING', `${c.train.n} training trades (${c.sampleClass})`);
    if (c.type === 'FILTER') {
      if (c.train.n < dc.minTrainN) return done('INSUFFICIENT_DATA', `${c.train.n} flagged trades in training, need ${dc.minTrainN}`);
      if (!(c.z.train <= -dc.filterZ && c.train.wr < c.train.be)) return done('REJECTED', 'not significantly worse than the other trades in training');
      H('VALIDATING');
      if (c.val.n < dc.minValN) return done('VALIDATING', `waiting for data: ${c.val.n}/${dc.minValN} flagged trades in validation`);
      if (!(c.val.wr < c.val.be && c.q <= dc.fdrQ)) return done('REJECTED', `validation: flagged trades won ${c.val.wr?.toFixed(1)}% (false-discovery q=${c.q?.toFixed(3)})`);
      H('OUT_OF_SAMPLE');
      if (c.oos.n < dc.minOosN) return done('OUT_OF_SAMPLE', `waiting for data: ${c.oos.n}/${dc.minOosN} flagged trades out-of-sample`);
      if (!(c.z.oos <= -dc.zOos && c.oos.wr < c.oos.be)) return done('OVERFIT', `out-of-sample: flagged trades won ${c.oos.wr?.toFixed(1)}% (z ${c.z.oos.toFixed(1)})`);
      return done('PAPER_TEST', 'flagged trades did worse in training, validation and out-of-sample');
    }
    const t = c.train;
    if (t.n < dc.minTrainN) return done('INSUFFICIENT_DATA', `${t.n} training trades, need ${dc.minTrainN}`);
    if (t.lo < t.be) return done('REJECTED', `training lower bound ${t.lo.toFixed(1)}% < break-even ${t.be.toFixed(1)}%`);
    if (c.complexity > dc.maxComplexity) { c.flags.push('EXCESSIVE_CONDITIONS'); return done('OVERFIT', `complexity ${c.complexity} > ${dc.maxComplexity}`); }
    if (c.robustness?.label === 'LOW') { c.flags.push('FRAGILE_PARAMS'); return done('OVERFIT', `only ${Math.round(c.robustness.score * 100)}% of nudged parameters still work`); }
    H('VALIDATING');
    if (c.val.n < dc.minValN) return done('VALIDATING', `waiting for data: ${c.val.n}/${dc.minValN} validation trades`);
    if (c.val.wr < c.val.be || c.q > dc.fdrQ) return done('REJECTED', `validation ${c.val.wr.toFixed(1)}% of ${c.val.n}, false-discovery q=${c.q?.toFixed(3)}`);
    if (c.passRatio < dc.wfMinPass) { c.flags.push('NARROW_PERIOD'); return done('UNSTABLE', `above break-even in only ${Math.round(c.passRatio * 100)}% of periods`); }
    if (c.stability === 'DECAYING') return done('DECAYING', `older ${c.stabilityDetail.older.wr.toFixed(1)}% → recent ${c.stabilityDetail.recent.wr.toFixed(1)}%`);
    if (c.stability === 'UNSTABLE') return done('UNSTABLE', `win rate swings ±${c.stabilityDetail.periodSd.toFixed(0)} points between periods`);
    H('OUT_OF_SAMPLE');
    const o = c.oos;
    if (o.n < dc.minOosN) return done('OUT_OF_SAMPLE', `waiting for data: ${o.n}/${dc.minOosN} out-of-sample trades`);
    if (o.wr < o.be - dc.oosCollapsePP) { c.flags.push('OOS_COLLAPSE'); return done('OVERFIT', `collapsed out-of-sample: ${o.wr.toFixed(1)}% of ${o.n}`); }
    if (o.lo < o.be) return done('REJECTED', `out-of-sample ${o.wr.toFixed(1)}% of ${o.n}: lower bound ${o.lo.toFixed(1)}% < break-even`);
    return done('PAPER_TEST', 'passed training, validation (FDR), stability and out-of-sample; now needs live paper confirmation');
  }

  function flagsFor(c, dc) {
    if (c.type === 'FILTER') return;
    if (c.train.n < dc.sampleClasses[1]) c.flags.push('SMALL_SAMPLE');
    if (c.crossPair === 'PAIR_SPECIFIC') c.flags.push('SINGLE_PAIR');
    if (c.crossPair === 'SINGLE_PAIR_DATA') c.flags.push('UNTESTED_ACROSS_PAIRS');
    if (c.similarLibrary?.[0]?.phi >= 0.8) c.flags.push('SAME_AS_LIBRARY');
    if (c.origin === 'negative-refinement') c.flags.push('NEGATIVE_CONFIRMED_ON_VALIDATION');
    if (c.mirror && c.mirror.n >= 30 && c.train.wr != null && Math.abs(c.mirror.wr - c.train.wr) > 8) c.flags.push('ASYMMETRIC');
  }

  // Not just win rate: evidence quality, robustness, stability, simplicity, drawdown, coverage.
  function rankOf(c, dc) {
    const best = c.oos?.n >= dc.minOosN ? c.oos : c.val?.n >= dc.minValN ? c.val : c.train;
    const parts = {
      edge: 2 * U.clamp((best.lo ?? 0) - (best.be ?? 54), -20, 20),
      sample: 3 * Math.log10(Math.max(1, c.train.n)),
      robustness: 10 * (c.robustness?.score ?? 0.5),
      stability: 8 * (c.passRatio ?? 0) + (c.stability === 'STABLE' ? 5 : 0),
      complexity: -3 * c.complexity,
      drawdown: -Math.min(10, (100 * (c.train.maxDrawdown || 0)) / Math.max(20, c.train.n) / 2),
      coverage: 2 * Math.min(3, c.regimesCovered?.length || 0),
    };
    for (const k of Object.keys(parts)) parts[k] = +parts[k].toFixed(2);
    return { rank: +U.sum(Object.values(parts)).toFixed(2), parts };
  }

  const pct = (x) => (x == null ? '–' : `${x.toFixed(1)}%`);
  const day = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : '?');
  function explain(c, ds, ctx) {
    const r = c.rule, conds = r.all.map(FL.label), neg = (r.none || []).map(FL.label);
    const base = c.baseline;
    const lines = [
      `${c.type === 'FILTER' ? 'Filter' : 'Setup'} found by ${c.origin}${c.mutation ? ` (${c.mutation})` : ''} on ${ds.n} 5M closes of ${ds.assets.map(U.pairLabel).join(', ')}, ${day(ds.time[0])} → ${day(ds.time[ds.n - 1])}.`,
      c.type === 'FILTER'
        ? `When the engine wanted to ${c.dir} and ${conds.join(' and ')}, those trades won ${pct(c.train.wr)} of ${c.train.n} in training vs ${pct(c.complement.train.wr)} for its other ${c.dir} trades (z = ${c.z.train.toFixed(1)}).`
        : `When ${conds.join(' AND ')}${neg.length ? `, and NOT ${neg.join(' / ')}` : ''}, a ${c.dir} with a ${c.expiry * 5}-minute expiry won ${pct(c.train.wr)} of ${c.train.n} non-overlapping training trades (90% interval ${pct(c.train.lo)}–${pct(c.train.hi)}), against a break-even of ${pct(c.train.be)}${base ? ` and a ${pct(base)} base rate for any ${c.dir} in the same period` : ''}.`,
      `This is a statistically unusual relationship with what happened next — a correlation in past data, not a known cause.`,
      `Validation: ${c.val.n ? `${pct(c.val.wr)} of ${c.val.n}` : 'no data'}${c.q != null ? ` (false-discovery q = ${c.q.toFixed(3)})` : ''}. Out-of-sample: ${c.oos.n ? `${pct(c.oos.wr)} of ${c.oos.n}` : 'no data'}.`,
    ];
    if (c.regimeBreakdown?.length) lines.push(`By regime: ${c.regimeBreakdown.slice(0, 5).map((x) => `${x.key} ${pct(x.wr)} of ${x.n}`).join(' · ')}.`);
    if (c.pairBreakdown?.length) lines.push(`By pair: ${c.pairBreakdown.slice(0, 6).map((x) => `${U.pairLabel(x.key)} ${pct(x.wr)} of ${x.n}`).join(' · ')} → ${c.crossPair}.`);
    if (c.periods?.length) lines.push(`Across ${c.periods.length} periods: ${c.periods.map((p) => (p.n ? `${Math.round(p.wr)}%` : '·')).join(' / ')} → ${c.stability}.`);
    return lines.join('\n');
  }
  function limitations(c, ds, ctx) {
    const out = ['Past co-occurrence only; nothing here guarantees future results.',
      'Backtest entry = the 5M close; live entry is a few seconds later, and entry timing / spreads are not simulated.'];
    if (!ds.cols['m1.rsi'] || !ds.cols['m1.rsi'].data.some((v) => v === v)) out.push('No 1M data was available, so 1M conditions could not be tested.');
    if (ds.assets.length === 1) out.push(`Only one pair (${U.pairLabel(ds.assets[0])}) in the data.`);
    out.push(`${ctx.evaluations.toLocaleString()} candidate conditions were scored during the search; some rules always look good by chance, which is why validation, out-of-sample and paper testing exist.`);
    if (ctx.oosReuse > 0) out.push(`This out-of-sample period overlaps ${ctx.oosReuse} earlier run(s), so it is no longer fully unseen — paper results matter more.`);
    if (c.sampleClass === 'PRELIMINARY' || c.sampleClass === 'INSUFFICIENT') out.push(`Sample is ${c.sampleClass.toLowerCase()} (${c.train.n} training trades).`);
    for (const f of c.flags) out.push({ SMALL_SAMPLE: 'Small sample.', SINGLE_PAIR: 'Works on one pair only.', UNTESTED_ACROSS_PAIRS: 'Not tested across pairs.',
      SAME_AS_LIBRARY: `Fires almost exactly when ${c.similarLibrary?.[0]?.strategy} does — probably not new.`, NEGATIVE_CONFIRMED_ON_VALIDATION: 'Its negative condition was confirmed on the validation period, so validation is not independent for this version.',
      ASYMMETRIC: `The mirrored ${U.opp(c.dir)} version behaves differently (${pct(c.mirror?.wr)} of ${c.mirror?.n}).`, FRAGILE_PARAMS: 'Breaks when thresholds are nudged.',
      OOS_COLLAPSE: 'Collapsed out-of-sample.', NARROW_PERIOD: 'Worked only in a narrow period.', EXCESSIVE_CONDITIONS: 'Too many conditions.' }[f] || f);
    return out;
  }

  // ── storage rows (versioned; ids stable across runs via the normalised rule key) ──
  function toRows(cands, existingLatest, runId, nowMs) {
    const byKey = new Map(existingLatest.map((r) => [r.ruleKey, r]));
    let next = 1 + Math.max(0, ...existingLatest.map((r) => Number(String(r.strategy_id).split('-')[1]) || 0));
    const idOfKey = new Map();
    for (const c of cands) {
      const prev = byKey.get(c.key);
      idOfKey.set(c.key, prev ? prev.strategy_id : `${c.type === 'FILTER' ? 'FILT' : 'DISC'}-${String(next++).padStart(5, '0')}`);
    }
    const rows = cands.map((c) => {
      const prev = byKey.get(c.key), id = idOfKey.get(c.key);
      let status = c.status, reason = c.statusReason;
      if (prev && LIVE.includes(prev.status)) {
        // A strategy already in paper/live keeps its stage unless re-evaluation on new data fails.
        if (FAIL.includes(status)) { status = prev.status === 'PROMOTED' ? 'WATCHLIST' : status; reason = `re-evaluation on new data failed: ${c.statusReason}`; }
        else { status = prev.status; reason = prev.status_reason; }
      }
      if (prev && prev.status === 'SUSPENDED') { status = 'SUSPENDED'; reason = prev.status_reason; }
      const version = prev ? prev.version + 1 : 1;
      const parent = c.parentKey ? idOfKey.get(c.parentKey) || c.parentKey : c.parent || null;
      return {
        key: `${id}#${String(version).padStart(4, '0')}#${runId}`, strategy_id: id, version, ruleKey: c.key, run_id: runId, type: c.type, basis: c.basis || null, tf: c.tf || 300,
        name: c.name, direction: c.dir, expiry: c.expiry, rule: c.rule,
        conditions: c.rule.all.map(FL.label), negative_conditions: (c.rule.none || []).map(FL.label),
        regime: c.regimes?.length ? c.regimes : null, regimes_covered: c.regimesCovered || null, pairs: c.rule.pairs || null, timeframes: c.timeframes,
        sample_size: c.train.n, sample_class: c.sampleClass,
        training_results: D.strip(c.train), validation_results: c.val ? { ...D.strip(c.val), q: c.q ?? null } : null, out_of_sample_results: D.strip(c.oos),
        complement: c.complement || null, z: c.z || null,
        walk_forward: c.walkForward ? { ...c.walkForward } : null, periods: c.periods || null, pass_ratio: c.passRatio ?? null,
        robustness_score: c.robustness?.score ?? null, robustness: c.robustness || null, importance: c.importance || null,
        complexity: c.complexity, stability: c.stability || null, stability_detail: c.stabilityDetail || null, cross_pair: c.crossPair || null,
        regime_breakdown: c.regimeBreakdown || null, pair_breakdown: c.pairBreakdown || null, session_breakdown: c.sessionBreakdown || null,
        score_breakdown: c.scoreBreakdown || null, expiry_breakdown: c.expiryBreakdown || null, mirror: c.mirror || null, similar_library: c.similarLibrary || null,
        baseline: c.baseline ?? null, cluster: c.cluster || null, flags: c.flags, status, status_reason: reason,
        history: [...(prev?.history || []), ...c.history.map((h) => ({ ...h, at: nowMs, run: runId }))],
        origin: c.origin, parent, mutation: c.mutation || null, rank: c.rank ?? null, rank_parts: c.rankParts || null,
        explanation: c.explanation || null, limitations: c.limitations || null,
        paper_results: prev?.paper_results || null, live_since: prev?.live_since || (status === 'PAPER_TEST' ? nowMs : null),
        created_at: prev?.created_at || nowMs, updated_at: nowMs,
      };
    });
    return { rows, idOfKey };
  }

  // ── the full cycle ─────────────────────────────────────────────────────────
  // input: a dataset (from buildDataset) or sources for buildDataset.
  async function runCycle(input, { cfg = OTC.DEFAULT_CONFIG, tf = 300, payoutByAsset = {}, defaultPayout = 85, existing = [], previousRuns = [],
    onProgress = null, shouldStop = null, nowMs = Date.now(), runId = `RUN-${nowMs}` } = {}) {
    const dc = cfg.discovery, t0 = Date.now(), deadline = t0 + dc.timeBudgetSec * 1000;
    const progress = (stage, extra = {}) => onProgress?.({ stage, ...extra });
    const ds = input && input.n != null ? input : await D.buildDataset(input, { cfg, tf, payoutByAsset, defaultPayout, onProgress, shouldStop });
    ds.tf ||= tf;
    // only earlier finds on the same setup frame are re-evaluated and mutated
    existing = existing.filter((r) => (r.tf || 300) === ds.tf);
    const run = { id: runId, at: nowMs, config: dc, dataset: ds.meta?.fingerprint || null, datasetMeta: { skipped: ds.meta?.skipped, dqSkipped: ds.meta?.dqSkipped, sources: ds.meta?.sources } };
    if (ds.n < 3 * dc.minTrainN) {
      const report = { runId, at: nowMs, rows: ds.n, nothingFound: true, message: `Not enough data: ${ds.n} usable 5M closes (need at least ${3 * dc.minTrainN}). Fetch more history first.`, counts: {}, top: [] };
      return { ds, rows: [], report, run: { ...run, report } };
    }
    const sp = D.splits(ds, dc.split);
    run.split = { trainEnd: ds.time[sp.cut1 - 1], validationEnd: ds.time[sp.cut2 - 1], oosStart: ds.time[sp.cut2], oosEnd: ds.time[ds.n - 1] };
    const oosReuse = previousRuns.filter((r) => r.split && r.split.oosEnd >= run.split.oosStart && r.split.oosStart <= run.split.oosEnd && r.dataset?.assets?.some((a) => ds.assets.includes(a))).length;
    progress('atoms');
    const { pool } = D.buildAtoms(ds, sp.train, dc);
    const trainIdx = D.range(...sp.train);
    const ctx = { evaluations: 0, oosReuse, baseline: {} };
    for (const dir of dc.directions) for (const N of dc.expiries) {
      let c = 0, w = 0;
      for (let i = sp.train[0]; i < sp.train[1]; i++) { c += ds.dec[N][i]; w += dir === 'CALL' ? ds.up[N][i] : ds.dn[N][i]; }
      ctx.baseline[`${dir}|${N}`] = c ? (100 * w) / c : null;
    }

    const cands = new Map();
    const addC = (rule, origin, extra = {}) => {
      const r = FL.normalize(rule), key = FL.ruleKey(r);
      if (!cands.has(key)) cands.set(key, { rule: r, key, origin, type: extra.type || 'STRATEGY', ...extra });
      return key;
    };
    // 1. open search
    for (const dir of dc.directions) for (const N of dc.expiries) {
      progress('search', { dir, N });
      const res = D.beamSearch(ds, pool, trainIdx, dir, N, dc, { deadline });
      ctx.evaluations += res.evals;
      res.rules.forEach((x) => addC(x.rule, 'discovery'));
      if (shouldStop?.()) break;
    }
    // 2. combinations of library strategies (+ regime)
    for (const dir of dc.directions) for (const N of dc.expiries) {
      progress('combinations', { dir, N });
      const allowed = (p) => (p.group === 'strategy' && p.a.op === '==' && p.a.v === dir) || (p.feats[0] === 'ctx.regime' && p.a.op === '==');
      const res = D.beamSearch(ds, pool, trainIdx, dir, N, dc, { allowed, maxConds: 3, keep: 10, deadline });
      ctx.evaluations += res.evals;
      res.rules.filter((x) => x.rule.all.filter((a) => a.f.startsWith('strat.')).length >= 2).forEach((x) => addC(x.rule, 'combination'));
    }
    // 3. variations of library strategies: strategy + one more condition
    progress('variations');
    for (const f of FL.FEATURES) {
      if (f.group !== 'strategy' || !ds.cols[f.id] || Date.now() > deadline) continue;
      for (const dir of dc.directions) for (const N of dc.expiries) {
        const seedAtom = { f: f.id, op: '==', v: dir };
        const m = D.atomMask(ds, seedAtom);
        let c = 0;
        for (let i = sp.train[0]; i < sp.train[1]; i++) c += m[i] & ds.dec[N][i];
        if (c / N < dc.minTrainN) continue;
        const res = D.beamSearch(ds, pool, trainIdx, dir, N, dc, { seed: [seedAtom], maxConds: 2, beamWidth: 10, keep: dc.variationsPerStrategy, deadline });
        ctx.evaluations += res.evals;
        res.rules.forEach((x) => addC(x.rule, 'variation', { parent: `library:${f.strategy}` }));
      }
    }
    // 4. re-evaluate earlier discoveries and mutate the most promising ones
    progress('mutations');
    const seeds = existing.filter((r) => r.type === 'STRATEGY' && r.rule && (LIVE.includes(r.status) || AWAIT.includes(r.status)))
      .concat(existing.filter((r) => r.type === 'STRATEGY' && r.rule && !LIVE.includes(r.status) && !AWAIT.includes(r.status) && r.status !== 'INSUFFICIENT_DATA').sort((a, b) => (b.rank ?? -1e9) - (a.rank ?? -1e9)))
      .slice(0, dc.mutationSeeds);
    for (const r of existing) if (r.rule && (LIVE.includes(r.status) || AWAIT.includes(r.status) || r.status === 'SUSPENDED')) addC(r.rule, 'reevaluation', { type: r.type, basis: r.basis, parent: r.strategy_id });
    for (const s of seeds) {
      if (Date.now() > deadline) break; // every stage respects the time budget (re-evaluations above always run)
      for (const m of D.mutations(FL.normalize(s.rule), ds, dc)) {
        const q = D.quickScore(ds, m.rule, sp.train, dc);
        ctx.evaluations++;
        if (q.score > 0) addC(m.rule, 'mutation', { parent: s.strategy_id, mutation: m.mutation });
      }
    }
    // 5. specialisation and simplification of the fresh candidates (training rows only)
    progress('simplify');
    for (const c of [...cands.values()]) {
      if (Date.now() > deadline) break;
      if (c.type !== 'STRATEGY' || c.origin === 'reevaluation') continue;
      for (const s of D.specialisations(ds, c.rule, sp.train, dc)) addC(s.rule, 'specialisation', { parentKey: c.key, mutation: s.mutation });
      const simp = D.simplify(ds, c.rule, sp.train, { ...dc, simplifyTolPP: dc.simplifyTolPP ?? 1 });
      if (simp) addC(simp.rule, 'simplification', { parentKey: c.key, mutation: `simplified from ${c.rule.all.length} to ${simp.rule.all.length} conditions` });
    }
    // 6. behavioural duplicates: same direction, expiry and the same training trades → keep the simplest
    const byBehaviour = new Map();
    let duplicates = 0;
    const prio = (c) => (c.origin === 'reevaluation' ? 0 : 1);
    for (const c of [...cands.values()]) {
      if (c.type !== 'STRATEGY') continue;
      const h = `${c.rule.dir}|${c.rule.expiry}|${D.hashMask(D.ruleMask(ds, c.rule), ...sp.train)}`;
      const other = byBehaviour.get(h);
      if (!other) { byBehaviour.set(h, c); continue; }
      const keepOther = prio(other) < prio(c) || (prio(other) === prio(c) && FL.complexity(other.rule) <= FL.complexity(c.rule));
      const drop = keepOther ? c : other;
      if (!keepOther) byBehaviour.set(h, c);
      if (drop.origin !== 'reevaluation') { cands.delete(drop.key); duplicates++; }
    }
    // 7. "do not trade" filters on the engine's own decisions
    progress('filters');
    for (const dir of dc.directions) for (const N of dc.expiries) {
      for (const f of D.findFilters(ds, pool, sp.train, dir, N, dc, deadline)) addC(f.rule, 'filter-discovery', { type: 'FILTER', basis: f.basis });
    }
    // 8. assess everything
    progress('assess', { candidates: cands.size });
    let assessed = [];
    let k = 0, unassessed = 0;
    // earlier finds are always re-assessed; fresh candidates only while the budget lasts
    const order = [...cands.values()].sort((a, b) => (a.origin === 'reevaluation' ? 0 : 1) - (b.origin === 'reevaluation' ? 0 : 1));
    for (const c of order) {
      if (c.origin !== 'reevaluation' && Date.now() > deadline + 30000) { unassessed++; continue; }
      assessed.push(assess(ds, c, sp, dc, ctx));
      if (++k % 25 === 0) { progress('assess', { done: k, candidates: cands.size }); await new Promise((r) => setTimeout(r, 0)); }
      if (shouldStop?.()) break;
    }
    // 9. negative conditions for rules that reached validation with enough data
    progress('negatives');
    for (const c of assessed.filter((x) => x.type === 'STRATEGY' && x.train.n >= dc.minTrainN && x.train.lo >= x.train.be && x.val.n >= dc.minValN)) {
      if (Date.now() > deadline || (c.rule.none || []).length) continue;
      const negs = D.findNegatives(ds, pool, c.rule, sp, dc);
      if (!negs.length) continue;
      const r = { ...c.rule, none: negs.map((n) => n.atom) };
      const key = FL.ruleKey(FL.normalize(r));
      if (cands.has(key)) continue;
      const nc = { rule: FL.normalize(r), key, origin: 'negative-refinement', type: 'STRATEGY', parentKey: c.key, mutation: `avoid ${negs.map((n) => FL.label(n.atom)).join(', ')}` };
      cands.set(key, nc);
      assessed.push(assess(ds, nc, sp, dc, ctx));
    }
    // 10. false-discovery control on validation, then gates
    const testable = assessed.filter((c) => c.type === 'STRATEGY' && c.train.n >= dc.minTrainN && c.train.lo >= c.train.be && c.val.n >= dc.minValN);
    const qs = D.bhQ(testable.map((c) => D.pAbove(c.val.w, c.val.n, c.val.be / 100)));
    testable.forEach((c, i) => (c.q = qs[i]));
    // filters get the same treatment: one-sided p that flagged trades do worse than the rest
    const ftest = assessed.filter((c) => c.type === 'FILTER' && c.train.n >= dc.minTrainN && c.val.n >= dc.minValN);
    const fq = D.bhQ(ftest.map((c) => D.Phi(c.z.val)));
    ftest.forEach((c, i) => (c.q = fq[i]));
    for (const c of assessed) { flagsFor(c, dc); finalize(c, dc); }
    // 11. correlation clusters among the candidates still alive
    const alive = assessed.filter((c) => c.type === 'STRATEGY' && !['INSUFFICIENT_DATA', 'REJECTED'].includes(c.status));
    const masks = alive.map((c) => D.ruleMask(ds, c.rule));
    const parentOf = alive.map((_, i) => i);
    const find = (i) => (parentOf[i] === i ? i : (parentOf[i] = find(parentOf[i])));
    for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
      if (alive[i].dir !== alive[j].dir) continue;
      if (phiOf(masks[i], masks[j], 0, sp.cut2) >= 0.5) parentOf[find(i)] = find(j);
    }
    const clusterIds = new Map();
    alive.forEach((c, i) => { const r = find(i); if (!clusterIds.has(r)) clusterIds.set(r, `C${clusterIds.size + 1}`); c.cluster = clusterIds.get(r); });
    // 12. ranking, explanations
    for (const c of assessed) {
      if (c.type === 'STRATEGY' && c.train.n >= dc.minTrainN) { const r = rankOf(c, dc); c.rank = r.rank; c.rankParts = r.parts; }
      c.explanation = explain(c, ds, ctx);
      c.limitations = limitations(c, ds, ctx);
    }
    // 13. does the SEARCH ITSELF work? Re-run it on past data only and test what it finds on the next period.
    let processWF = null;
    if (dc.processWalkForward && Date.now() < deadline) {
      progress('process walk-forward');
      const folds = D.foldBounds(0, ds.n, dc.wfFolds), perFold = [];
      let W = 0, L = 0, T = 0, pay = 0, cnt = 0;
      for (let f = 2; f < folds.length && Date.now() < deadline; f++) {
        const hist = [0, folds[f][0]], test = folds[f];
        const { pool: p2 } = D.buildAtoms(ds, hist, dc);
        const idx2 = D.range(...hist);
        let rules = 0, fw = 0, fl = 0;
        for (const dir of dc.directions) for (const N of dc.expiries) {
          const res = D.beamSearch(ds, p2, idx2, dir, N, dc, { keep: 5, deadline });
          for (const x of res.rules) {
            rules++;
            const s = D.evalRule(ds, x.rule, ...test);
            fw += s.w; fl += s.l; T += s.t; W += s.w; L += s.l;
            for (const i of s.idx) { pay += ds.payout[i]; cnt++; }
          }
        }
        perFold.push({ from: ds.time[test[0]], to: ds.time[test[1] - 1], rules, n: fw + fl, wr: fw + fl ? (100 * fw) / (fw + fl) : null });
      }
      const n = W + L, be = U.breakEven(cnt ? pay / cnt : 85);
      processWF = { perFold, n, w: W, wr: n ? (100 * W) / n : null, lo: n ? OTC.Stats.wilson(W, n, 1.645).lo : null, be,
        verdict: !n ? 'The search found nothing to test on the following periods.'
          : (100 * W) / n >= be ? `Rules found on past data won ${((100 * W) / n).toFixed(1)}% of ${n} trades in the following period (break-even ${be.toFixed(1)}%).`
          : `Rules found on past data won only ${((100 * W) / n).toFixed(1)}% of ${n} trades in the following period (break-even ${be.toFixed(1)}%) — what the search finds has not been holding up.` };
    }

    for (const c of assessed) c.tf = ds.tf;
    const { rows, idOfKey } = toRows(assessed, existing, runId, nowMs);
    const byStatus = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const interesting = rows.filter((r) => r.type === 'STRATEGY' && !['INSUFFICIENT_DATA', 'REJECTED'].includes(r.status) && r.rank != null).sort((a, b) => b.rank - a.rank).slice(0, 10);
    const reasonFor = (r) => {
      const best = r.out_of_sample_results?.n >= dc.minOosN ? ['out-of-sample', r.out_of_sample_results] : r.validation_results?.n >= dc.minValN ? ['validation', r.validation_results] : ['training', r.training_results];
      return `${best[0]} ${best[1].wr?.toFixed(1)}% of ${best[1].n} (lower bound ${best[1].lo?.toFixed(1)}% vs break-even ${best[1].be?.toFixed(1)}%), robustness ${r.robustness?.label || '–'}, stable in ${Math.round((r.pass_ratio || 0) * 100)}% of periods, complexity ${r.complexity}`;
    };
    const validated = rows.filter((r) => r.status === 'PAPER_TEST' && r.type === 'STRATEGY').length;
    const validatedFilters = rows.filter((r) => r.status === 'PAPER_TEST' && r.type === 'FILTER').length;
    const report = {
      runId, at: nowMs, ms: Date.now() - t0, budgetHit: Date.now() > deadline, unassessed, rows: ds.n, assets: ds.assets, split: run.split, atoms: pool.length,
      evaluations: ctx.evaluations, oosReuse,
      counts: { candidates: rows.length, duplicatesDropped: duplicates, rejected: byStatus.REJECTED || 0, overfit: byStatus.OVERFIT || 0,
        unstable: (byStatus.UNSTABLE || 0) + (byStatus.DECAYING || 0), needMoreData: (byStatus.INSUFFICIENT_DATA || 0) + (byStatus.VALIDATING || 0) + (byStatus.OUT_OF_SAMPLE || 0),
        validated, validatedFilters, promoted: 0, filters: rows.filter((r) => r.type === 'FILTER').length, byStatus,
        // survivors that fire on mostly the same trades are one idea, not many
        validatedClusters: new Set(assessed.filter((c) => c.status === 'PAPER_TEST' && c.type === 'STRATEGY').map((c) => c.cluster)).size },
      fdr: { tested: testable.length, q: dc.fdrQ, expectedFalseAmongPassing: +(testable.filter((c) => c.q <= dc.fdrQ).length * dc.fdrQ).toFixed(1) },
      processWalkForward: processWF,
      top: interesting.map((r) => ({ id: r.strategy_id, name: r.name, status: r.status, sample: r.sample_size, sampleClass: r.sample_class, regime: r.regime || r.regimes_covered,
        oos: r.out_of_sample_results, robustness: r.robustness?.label, rank: r.rank, reason: reasonFor(r) })),
      nothingFound: validated === 0,
      message: validated === 0
        ? `No strategy passed every gate in this cycle${validatedFilters ? ` (${validatedFilters} do-not-trade filter(s) did)` : ''}. That is a valid result: the standards were not lowered to produce one.`
        : `${validated} candidate(s) in ${new Set(rows.filter((r) => r.status === 'PAPER_TEST' && r.type === 'STRATEGY').map((r) => r.cluster)).size} independent cluster(s) passed every historical gate and now need live paper confirmation. None is promoted automatically.`,
    };
    return { ds, rows, report, run: { ...run, report }, idOfKey };
  }

  Object.assign(OTC.Discovery, { LIVE, FAIL, AWAIT, paramNeighbors, robustness, importance, assess, finalize, rankOf, explain, limitations, toRows, runCycle, phiOf });
})(typeof globalThis !== 'undefined' ? globalThis : this);
