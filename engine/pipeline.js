// Decision pipeline: fast scanner → deep analysis → CALL / PUT / SKIP.
// Identical code runs live (in each Pocket Option tab) and in historical replay,
// so live and backtest records are directly comparable.
(function (G) {
  const OTC = G.OTC, U = OTC.U, H = OTC.Strategies.H, TF = OTC.TF;

  // Higher-timeframe series as of the latest closed 5M candle: the closed HTF
  // candles plus the current, still-forming HTF candle built from 5M candles.
  // Built the same way live and in replay so both see identical context.
  function htfWithPartial(closedHtf, c5, tf) {
    if (!c5.length) return closedHtf || [];
    const last5 = c5[c5.length - 1], endT = last5.time + TF.PRIMARY;
    const bucket = Math.floor(last5.time / tf) * tf;
    const closed = (closedHtf || []).filter((c) => c.time + tf <= endT && c.time < bucket);
    if (endT === bucket + tf) {
      // the 5M close also closed this HTF candle
      const full = U.aggregate(c5.filter((c) => c.time >= bucket), TF.PRIMARY, tf);
      if (full.length && full[0].time === bucket && !closed.some((c) => c.time === bucket)) closed.push(full[0]);
      return closed;
    }
    const part = U.aggregate(c5.filter((c) => c.time >= bucket), TF.PRIMARY, tf, { allowPartialLast: true });
    return part.length ? [...closed, { ...part[part.length - 1], partial: true }] : closed;
  }

  function mergedLevels(...fs) {
    const out = [];
    for (const f of fs) if (f?.ready) for (const l of f.levels.all) out.push(l);
    return out;
  }

  // series: { 300: closed 5M, 900: 15M (may end partial), 3600: 1H (may end partial), 60: closed 1M }
  function buildContext(series, { signal = null, cfg = OTC.DEFAULT_CONFIG } = {}) {
    const opt = { abnormalRangeAtr: cfg.abnormalRangeAtr };
    const f5 = OTC.Features.compute(series[TF.PRIMARY] || [], TF.PRIMARY, opt);
    const f15 = series[TF.MID] ? OTC.Features.compute(series[TF.MID], TF.MID, opt) : null;
    const f60 = series[TF.MACRO] ? OTC.Features.compute(series[TF.MACRO], TF.MACRO, opt) : null;
    const f1 = series[TF.TIMING] ? OTC.Features.compute(series[TF.TIMING], TF.TIMING, opt) : null;
    const regime = OTC.Regime.classify(f5, f15, f60);
    // the market state of the setup frame (engine/research.js) — the same one research and discovery are built on
    let state = null;
    const R = OTC.Research, cs = (series[TF.PRIMARY] || []).filter((c) => !c.partial);
    if (R && cs.length > R.DEFAULTS.W) {
      let i = cs.length - 1;
      while (i > 0 && cs[i].time - cs[i - 1].time === TF.PRIMARY) i--;
      const seg = cs.slice(i);
      if (seg.length > R.DEFAULTS.W) state = R.stateAt(seg, seg.length - 1, TF.PRIMARY);
    }
    return { f5, f15, f60, f1, regime, levels: mergedLevels(f5, f15, f60), signal, cfg, state };
  }

  // ── FAST SCANNER ───────────────────────────────────────────────────────────
  // Cheap "is this pair worth a closer look" score from 5M alone.
  function fastScan(X) {
    const cfg = X.cfg, f = X.f5;
    if (!f?.ready) return { score: 0, direction: 'NEUTRAL', status: 'IGNORE', setup_type: 'none', regime: 'UNCLEAR', components: {} };
    const comp = {};
    comp.trend = Math.round(f.trend.strength * 0.25);
    comp.momentum = f.momentum.dir !== 'NEUTRAL' ? Math.round(f.momentum.strength * 0.2) : 0;
    comp.structure = f.structure.trend !== 'UNCLEAR' ? Math.round((f.structure.quality / 100) * 15) : 0;
    const atLvl = H.touchedLevel(X, U.side('CALL'), 0.5) || H.touchedLevel(X, U.side('PUT'), 0.5);
    const atBand = f.bb.pctB <= 0.1 || f.bb.pctB >= 0.9;
    const inFib = f.fib.valid && f.fib.depth >= 0.382 && f.fib.depth <= 0.786;
    comp.location = atLvl ? 15 : atBand || inFib ? 8 : 0;
    const p = f.volatility.atrPct;
    comp.volatility = p == null ? 5 : p >= 20 && p <= 85 ? 15 : (p >= 10 && p < 20) || (p > 85 && p < 90) ? 7 : 0;
    comp.signal = X.signal?.dir ? 10 : 0;
    const events = [f.breakout.status && f.breakout.ago <= 2 ? (f.breakout.status === 'FALSE_BREAKOUT' ? U.opp(f.breakout.dir) : f.breakout.dir) : null,
      f.liquidity.sweep?.dir, f.structure.choch?.ago <= 3 ? f.structure.choch.dir : null, f.divergence.rsi?.dir].filter(Boolean);
    comp.event = events.length ? 10 : 0;
    const score = Math.min(100, U.sum(Object.values(comp)));
    const votes = [f.trend.dir === 'UP' ? 'CALL' : f.trend.dir === 'DOWN' ? 'PUT' : null,
      f.momentum.dir !== 'NEUTRAL' ? f.momentum.dir : null,
      f.structure.trend === 'BULL' ? 'CALL' : f.structure.trend === 'BEAR' ? 'PUT' : null, ...events, X.signal?.dir].filter(Boolean);
    const calls = votes.filter((v) => v === 'CALL').length, puts = votes.length - calls;
    const direction = calls > puts ? 'CALL' : puts > calls ? 'PUT' : 'NEUTRAL';
    const rg = X.regime.regime;
    const setup_type = rg.startsWith('TRENDING') ? 'trend' : rg === 'RANGING' ? 'range' : rg === 'BREAKOUT' ? 'breakout' : rg === 'REVERSAL' ? 'reversal' : 'none';
    const status = score >= cfg.deepThreshold ? 'DEEP' : score >= cfg.watchThreshold ? 'WATCH' : 'IGNORE';
    return { score, direction, status, setup_type, regime: rg, components: comp };
  }

  const htfScore = (X, dir) => {
    const s = U.side(dir);
    const v = (f) => (!f?.ready ? 0 : H.trendWith(f, s) ? 1 : H.trendAgainst(f, s) ? -1 : 0);
    return Math.round(50 + 25 * (v(X.f15) + v(X.f60)));
  };

  // ── DEEP ANALYZER + FINAL DECISION ─────────────────────────────────────────
  // opts: dq (DataQuality.checkSnapshot result), scan (fastScan result), timing (Risk.entryTiming result or null),
  //       meta ({ asset, time, candleTime }; live only — lets discovered strategies run on top),
  //       reliability (strategy track records, engine/consensus.js; default: the tables the tab received;
  //       replays pass null — no hindsight)
  function deepAnalyze(X, opts = {}) {
    const result = deepCore(X, opts);
    if (opts.meta) OTC.Lifecycle?.apply(X, result, opts);
    return result;
  }

  // Analysis → decision. Every strategy gives its signal; the Consensus Engine groups them by family and
  // weighs them by their own record here; the direction is the consensus. A setup needs the consensus to
  // AGREE (enough families, none against), no hard contradiction, readable data and market. No confidence
  // threshold: whether an agreement is worth a trade is decided later from measured outcomes (calibration).
  function deepCore(X, { dq = null, scan = null, timing = null, meta = null, ...opts } = {}) {
    const cfg = X.cfg, skip = [], flags = [];
    const result = { decision: 'SKIP', lean: null, confidence: 0, regime: X.regime, skipReasons: skip, riskFlags: flags,
      fired: [], active: [], confluence: null, contradiction: null, consensus: null, evidenceFor: [], evidenceAgainst: [], setup: null, combo: null };

    // a strategy mode reads only its own frame: holes in the context frames are noted, not blocking
    if (dq) for (const i of dq.issues) (i.severity === 'fatal' && cfg.soloMode !== 'youtube' && !(cfg.solo && i.tf && i.tf !== TF.PRIMARY) ? skip : flags).push(`${i.tf ? OTC.TF_LABEL[i.tf] + ' ' : ''}${i.detail}`);
    if (!X.f5?.ready) { skip.push('5M features unavailable'); return result; }

    const rg = X.regime.regime;
    const fired = OTC.Strategies.runAll(X);
    result.fired = fired;
    if (fired.errors?.length) flags.push(...fired.errors.map((e) => `strategy error ${e}`));
    const tables = 'reliability' in opts ? opts.reliability : OTC.Consensus.tables;
    const cons = OTC.Consensus.evaluate(fired, { asset: meta?.asset ?? null, frame: TF.PRIMARY, regime: rg }, { tables, cfg });
    result.consensus = cons;
    const active = fired.filter((x) => x.active && !cons.muted.includes(x.strategy));
    result.active = active;

    // a mode's own strategies (one, or a set): their signals decide, exactly as they were tested — each on its own
    // frame and with its own duration; if they point both ways, nothing
    if (cfg.solo) {
      // a set's switched-off strategies are left out; one strategy chosen alone (Keltner mode) always runs
      const set = Array.isArray(cfg.solo) ? cfg.solo.filter((id) => !(cfg.soloOff || []).includes(id)) : [cfg.solo], meta = (id) => OTC.Strategies.get(id) || {};
      const mine = fired.filter((x) => set.includes(x.strategy) && x.active && (meta(x.strategy).frame == null || set.length === 1 || meta(x.strategy).frame === TF.PRIMARY));
      if (!mine.length) { skip.push(set.length === 1 ? `no ${set[0]} signal` : 'no mode strategy signal'); return result; }
      if (new Set(mine.map((x) => x.direction)).size > 1) { skip.push(`mode strategies disagree (${mine.map((x) => x.strategy).join(', ')})`); return result; }
      const k = mine[0];
      const conf = OTC.Confluence.evaluate(X, cfg), contra = OTC.Contradiction.evaluate(X, k.direction, conf, fired, cfg, cons);
      Object.assign(result, { lean: k.direction, confluence: conf, contradiction: contra, setup: k.strategy, setupName: k.name, combo: mine.map((x) => x.strategy).sort().join('+'), solo: true,
        // its own duration, or the one «حسّن» confirmed on its record
        soloExpiry: cfg.soloExpiryOf?.[k.strategy] ?? (set.length > 1 ? meta(k.strategy).expirySec ?? null : null),
        confidence: Math.max(k.confidence, cfg.opportunity?.enterNowConfidence ?? 80), components: { strategy: k.confidence },
        evidenceFor: mine.map((x) => `${x.name}: ${x.conditions_met.join(', ')}`), evidenceAgainst: contra.against.map((x) => `${x.label}${x.hard ? ' [HARD]' : ''} (not used in this mode)`),
        risk: 'LOW' });
      if (!skip.length) result.decision = k.direction;
      return result;
    }

    // Lean = the consensus direction, else the strongest evidence (kept for research even when skipping).
    let dir = cons.dir;
    if (!dir) dir = fired.find((x) => x.valid)?.direction || null;
    const conf = OTC.Confluence.evaluate(X, cfg);
    result.confluence = conf;
    if (!dir && conf.direction !== 'NEUTRAL') dir = conf.direction;
    result.lean = dir;
    if (!dir) { skip.push('no setup and no directional evidence'); return result; }

    const ff = cons.dir ? cons.families[cons.dir].length : 0, fa = cons.dir ? cons.families[U.opp(cons.dir)].length : 0;
    if (cons.status === 'NONE') skip.push('no strategy signal');
    else if (cons.status === 'SPLIT') skip.push(`strategy families disagree (${ff} for, ${fa} against)`);
    else if (cons.status === 'WEAK') skip.push(`only ${ff} strategy famil${ff === 1 ? 'y agrees' : 'ies agree'} (${cons.minFamilies} needed)`);
    if (rg === 'UNCLEAR' || rg === 'HIGH_VOLATILITY') skip.push(rg === 'UNCLEAR' ? 'market unclear' : 'market too volatile');

    const contra = OTC.Contradiction.evaluate(X, dir, conf, fired, cfg, cons);
    result.contradiction = contra;
    // the setup = the strongest agreeing strategy, by its weight here × its own score
    const weight = (id) => cons.signals.find((s) => s.id === id)?.w ?? 1;
    const mine = active.filter((x) => x.direction === dir).sort((a, b) => weight(b.strategy) * b.confidence - weight(a.strategy) * a.confidence);
    const best = mine[0] || fired.find((x) => x.direction === dir) || null;
    result.setup = best ? best.strategy : null;
    result.setupName = best ? best.name : null;
    result.combo = mine.length ? mine.map((x) => x.strategy).sort().join('+') : null;

    // raw score (research and ranking only — it gates nothing)
    const b = cfg.blend;
    const confidence = Math.round(U.clamp(b.strategy * (best?.confidence ?? 0) + b.confluence * conf.scores[dir] + b.htf * htfScore(X, dir) - contra.penalty));
    result.confidence = confidence;
    result.components = { strategy: best?.confidence ?? 0, confluence: conf.scores[dir], htf: htfScore(X, dir), penalty: contra.penalty };

    // Evidence lists for the explanation
    const fmt = (x) => x.replace(/_/g, ' ');
    result.evidenceFor = [
      ...(cons.dir === dir && ff ? [`${cons.agree.length} strategies in ${ff} families agree (${cons.families[dir].join(', ')})`] : []),
      ...mine.slice(0, 4).map((x) => `${x.name} (${x.confidence})`),
      ...Object.entries(conf.modules).filter(([, m]) => m.dir === dir).map(([k, m]) => `${fmt(k)}: ${m.reason}`),
      ...(htfScore(X, dir) >= 75 ? ['higher timeframes aligned'] : []),
    ];
    result.evidenceAgainst = contra.against.map((x) => `${x.label}${x.hard ? ' [HARD]' : ''}`);

    if (contra.hard.length) skip.push(...contra.hard);
    if (scan && scan.score < cfg.deepThreshold) skip.push(`scanner ${scan.score} < ${cfg.deepThreshold} (research record)`);
    if (timing && !timing.ok) skip.push(...timing.flags);

    if (!skip.length) result.decision = dir;
    result.risk = contra.against.some((x) => x.severity === 'high') ? 'HIGH' : contra.against.filter((x) => x.severity === 'medium').length >= 2 ? 'MEDIUM' : 'LOW';
    return result;
  }

  // Short explanation, like "CALL — Setup: Bullish Pullback …" or "SKIP — Reasons: …"
  function explain(a) {
    if (a.decision === 'SKIP') return `SKIP\nReasons:\n${a.skipReasons.map((r) => `• ${r}`).join('\n')}${a.lean ? `\n(lean ${a.lean}, confidence ${a.confidence})` : ''}`;
    return `${a.decision}\nSetup: ${a.setupName}\nRegime: ${a.regime.regime}\nSupporting:\n${a.evidenceFor.map((r) => `• ${r}`).join('\n')}`
      + `\nContradicting:\n${a.evidenceAgainst.map((r) => `• ${r}`).join('\n') || '• none found'}\nRisk: ${a.risk}\nConfidence: ${a.confidence} (uncalibrated score, not a probability)`;
  }

  // Compact record for the log. Outcomes are filled in later from 5M closes:
  // exits[N] = close of the Nth 5M candle after the decision candle.
  function toRecord(X, a, scan, meta) {
    const f = X.f5, num = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
    const mods = {};
    if (a.confluence) for (const [k, m] of Object.entries(a.confluence.modules)) mods[k] = [m.dir, m.confidence];
    return {
      id: `${meta.source}|${meta.asset}|${TF.PRIMARY}|${f.time}`,
      v: OTC.VERSION, kind: 'setup', tf: TF.PRIMARY, source: meta.source, asset: meta.asset, candleTime: f.time, ts: f.time + TF.PRIMARY,
      payout: meta.payout ?? null, decision: a.decision, lean: a.lean,
      scanner: scan ? { score: scan.score, dir: scan.direction, status: scan.status, type: scan.setup_type } : null,
      deep: a.confidence, components: a.components || null,
      regime: X.regime.regime, regimeConf: X.regime.confidence,
      setup: a.setup, combo: a.combo,
      strategies: a.fired.map((x) => [x.strategy, x.direction, x.confidence, x.active ? 1 : 0]),
      cons: OTC.Consensus.summary(a.consensus) || undefined,
      modules: mods,
      ind: f.ready ? {
        rsi: num(f.momentum.rsi, 1), macdHist: num(f.momentum.macd.hist, 7), adx: num(f.trend.adx, 1), pctB: num(f.bb.pctB, 2),
        bbWidthPct: num(f.bb.widthPct, 0), atr: num(f.atr, 7), atrPct: num(f.volatility.atrPct, 0), fibDepth: f.fib.valid ? num(f.fib.depth, 3) : null,
        distSup: num(f.levels.distSup, 2), distRes: num(f.levels.distRes, 2), structure: f.structure.trend, breakout: f.breakout.status,
        t5: f.trend.dir, t15: X.f15?.ready ? X.f15.trend.dir : null, t60: X.f60?.ready ? X.f60.trend.dir : null, signal: X.signal?.dir || null,
      } : null,
      evidenceFor: a.evidenceFor, evidenceAgainst: a.evidenceAgainst, riskFlags: a.riskFlags, skipReasons: a.skipReasons, risk: a.risk || null,
      entryPrice: f.ready ? f.price : null,
      entryTick: meta.entryTick ?? null,
      exits: {}, status: 'pending',
      timing: meta.timing ? { elapsed: num(meta.timing.elapsed, 1), move: num(meta.timing.move, 2), quality: meta.timing.quality } : null,
      exec: null,
      disc: a.disc || undefined,           // discovered strategies/filters that fired: [id, dir, version]
      ensemble: a.ensemble ? { dir: a.ensemble.dir, score: a.ensemble.score } : undefined,
      snapshot: meta.snapshot ? f.recent : undefined,
    };
  }

  OTC.Pipeline = { buildContext, fastScan, deepAnalyze, explain, toRecord, htfWithPartial, htfScore };
})(typeof globalThis !== 'undefined' ? globalThis : this);
