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
    return { f5, f15, f60, f1, regime, levels: mergedLevels(f5, f15, f60), signal, cfg };
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
  //       meta ({ asset, time, candleTime }; live only — lets discovered strategies run on top)
  function deepAnalyze(X, opts = {}) {
    const result = deepCore(X, opts);
    if (opts.meta) OTC.Lifecycle?.apply(X, result, opts);
    return result;
  }

  function deepCore(X, { dq = null, scan = null, timing = null } = {}) {
    const cfg = X.cfg, skip = [], flags = [];
    const result = { decision: 'SKIP', lean: null, confidence: 0, regime: X.regime, skipReasons: skip, riskFlags: flags,
      fired: [], active: [], confluence: null, contradiction: null, evidenceFor: [], evidenceAgainst: [], setup: null, combo: null };

    if (dq) for (const i of dq.issues) (i.severity === 'fatal' ? skip : flags).push(`${i.tf ? OTC.TF_LABEL[i.tf] + ' ' : ''}${i.detail}`);
    if (!X.f5?.ready) { skip.push('5M features unavailable'); return result; }

    const rg = X.regime.regime;
    const allowed = cfg.regimeFamilies[rg] || [];
    const fired = OTC.Strategies.runAll(X, { allowedFamilies: allowed });
    result.fired = fired;
    if (fired.errors?.length) flags.push(...fired.errors.map((e) => `strategy error ${e}`));
    if (!allowed.length) skip.push(`regime ${rg}: no strategies allowed`);

    const active = fired.filter((x) => x.active && x.confidence >= cfg.minStrategyScore);
    result.active = active;
    const byDir = { CALL: active.filter((x) => x.direction === 'CALL'), PUT: active.filter((x) => x.direction === 'PUT') };
    const top = (d) => byDir[d][0]?.confidence ?? 0;
    // Lean = the side with the strongest evidence even if we end up skipping (kept for research).
    let dir = null;
    if (byDir.CALL.length || byDir.PUT.length) dir = top('CALL') > top('PUT') || (top('CALL') === top('PUT') && byDir.CALL.length >= byDir.PUT.length) ? 'CALL' : 'PUT';
    else {
      const any = fired.filter((x) => x.valid)[0];
      if (any) dir = any.direction;
    }
    const conf = OTC.Confluence.evaluate(X, cfg);
    result.confluence = conf;
    if (!dir && conf.direction !== 'NEUTRAL') dir = conf.direction;
    result.lean = dir;
    if (!dir) { skip.push('no setup and no directional evidence'); return result; }

    if (!active.length) skip.push(allowed.length ? 'no active setup for this regime' : 'no tradable setup');
    if (byDir.CALL.length && byDir.PUT.length && Math.abs(top('CALL') - top('PUT')) < 15) skip.push('active strategies disagree on direction');

    const contra = OTC.Contradiction.evaluate(X, dir, conf, fired, cfg);
    result.contradiction = contra;
    const mine = byDir[dir];
    const best = mine[0] || fired.find((x) => x.direction === dir) || null;
    result.setup = best ? best.strategy : null;
    result.setupName = best ? best.name : null;
    result.combo = mine.length ? mine.map((x) => x.strategy).sort().join('+') : null;

    const b = cfg.blend;
    const confidence = Math.round(U.clamp(b.strategy * (best?.confidence ?? 0) + b.confluence * conf.scores[dir] + b.htf * htfScore(X, dir) - contra.penalty));
    result.confidence = confidence;
    result.components = { strategy: best?.confidence ?? 0, confluence: conf.scores[dir], htf: htfScore(X, dir), penalty: contra.penalty };

    // Evidence lists for the explanation
    const fmt = (x) => x.replace(/_/g, ' ');
    result.evidenceFor = [
      ...mine.slice(0, 4).map((x) => `${x.name} (${x.confidence})`),
      ...Object.entries(conf.modules).filter(([, m]) => m.dir === dir).map(([k, m]) => `${fmt(k)}: ${m.reason}`),
      ...(htfScore(X, dir) >= 75 ? ['higher timeframes aligned'] : []),
    ];
    result.evidenceAgainst = contra.against.map((x) => `${x.label}${x.hard ? ' [HARD]' : ''}`);

    if (contra.hard.length) skip.push(...contra.hard);
    if (confidence < cfg.minDeepConfidence) skip.push(`confidence ${confidence} < ${cfg.minDeepConfidence}`);
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
