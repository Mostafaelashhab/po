// Strategy Factory. A strategy is declared once with OTC.Strategies.define({...})
// and gets the common interface: detect / validate / score / explain / invalidate.
//
//   define({
//     id, name, family, regimes,            // regimes: where it is allowed to trade
//     conditions(s, X) → [R(label, ok), O(label, ok, weight)],   // R = required, O = optional
//     against?(s, X)   → [A(label, active, 'medium'|'high')],     // strategy-specific risks
//     invalidation?(s, X) → [string],
//   })
//
// `s` is the side being tested ({ dir, up, sg, opp }); `X` is the analysis context
// (5M/15M/1H/1M features, regime, merged levels, signal). Both directions are
// tested; a strategy that qualifies both ways is ambiguous and reports nothing.
// A strategy needs at least two required conditions, so no single fact — e.g. one
// candlestick pattern — can ever fire it alone.
(function (G) {
  const OTC = G.OTC, U = OTC.U;
  const registry = new Map();

  const R = (label, ok) => ({ label, ok: !!ok, req: true, w: 1 });
  const O = (label, ok, w = 1) => ({ label, ok: !!ok, req: false, w });
  const A = (label, active, severity = 'medium') => ({ label, active: !!active, severity });

  function evaluateSide(def, X, dir) {
    const s = U.side(dir);
    const conds = def.conditions(s, X);
    const req = conds.filter((c) => c.req);
    if (req.length < 2) throw new Error(`strategy ${def.id}: needs at least 2 required conditions`);
    const passed = req.every((c) => c.ok);
    const opt = conds.filter((c) => !c.req);
    const wAll = U.sum(opt.map((c) => c.w)), wOk = U.sum(opt.filter((c) => c.ok).map((c) => c.w));
    const against = (def.against ? def.against(s, X) : []).filter((x) => x.active);
    return { dir, s, conds, passed, optFrac: wAll ? wOk / wAll : null, against };
  }

  function scoreOf(r) {
    if (!r?.passed) return 0;
    let sc = r.optFrac == null ? 75 : 50 + 50 * r.optFrac;
    for (const a of r.against) sc -= a.severity === 'high' ? 15 : 8;
    return Math.round(U.clamp(sc));
  }

  function wrap(def) {
    const st = {
      id: def.id, name: def.name, family: def.family, regimes: def.regimes || [], tags: def.tags || [],
      // hidden: runs only when a mode names it (cfg.solo); frame / expirySec: where and how long it was tested
      hidden: !!def.hidden, frame: def.frame ?? null, expirySec: def.expirySec ?? null, source: def.source || null,
      // Both sides; returns the qualifying side's raw evaluation, or null.
      detect(X) {
        const sides = ['CALL', 'PUT'].map((d) => evaluateSide(def, X, d)).filter((r) => r.passed);
        if (sides.length !== 1) return sides.length ? { ambiguous: true } : null;
        return sides[0];
      },
      validate(r) { return !!r && r.passed && !r.against.some((a) => a.severity === 'high'); },
      score(r) { return scoreOf(r); },
      explain(r) {
        if (!r) return `${def.name}: no setup`;
        const met = r.conds.filter((c) => c.ok).map((c) => c.label);
        return `${def.name} ${r.dir}: ${met.join(', ')}${r.against.length ? ` | against: ${r.against.map((a) => a.label).join(', ')}` : ''}`;
      },
      invalidate(r, X) { return r && def.invalidation ? def.invalidation(r.s, X) : []; },
      // Standard output used by the rest of the engine.
      evaluate(X) {
        const r = st.detect(X);
        if (!r || r.ambiguous) return null;
        const regime = X.regime?.regime || 'UNCLEAR';
        return {
          strategy: def.id, name: def.name, family: def.family, direction: r.dir,
          confidence: scoreOf(r), valid: st.validate(r), regime,
          regimeFit: st.regimes.includes(regime),
          conditions_met: r.conds.filter((c) => c.ok).map((c) => c.label),
          conditions_failed: r.conds.filter((c) => !c.ok).map((c) => c.label),
          supporting_evidence: r.conds.filter((c) => c.ok && !c.req).map((c) => c.label),
          contradicting_evidence: r.against.map((a) => `${a.label} (${a.severity})`),
          invalidation_conditions: st.invalidate(r, X),
        };
      },
    };
    return st;
  }

  function define(def) {
    for (const k of ['id', 'name', 'family', 'conditions']) if (!def[k]) throw new Error(`strategy definition missing ${k}`);
    if (registry.has(def.id)) throw new Error(`duplicate strategy id ${def.id}`);
    const st = wrap(def);
    registry.set(def.id, st);
    return st;
  }

  // Runs every registered strategy. Returns all fired strategies; `active` marks a clean signal (required
  // conditions met, no serious objection, score ≥ minStrategyScore) — in any market state: which strategies
  // work in which state is learned from their record (engine/consensus.js), not fixed by hand.
  // `regimeFit` still says whether the strategy's author meant it for this state.
  function runAll(X, { minScore = X?.cfg?.minStrategyScore ?? 60 } = {}) {
    const fired = [], errors = [], solo = [].concat(X?.cfg?.solo || []).filter((id) => !Array.isArray(X?.cfg?.solo) || !(X.cfg.soloOff || []).includes(id));
    for (const st of registry.values()) {
      if (st.hidden && !solo.includes(st.id)) continue;
      let out = null;
      // One broken strategy must not take the engine down; its error is reported instead.
      try { out = st.evaluate(X); } catch (e) { if (/required conditions/.test(e.message)) throw e; errors.push(`${st.id}: ${e.message}`); }
      if (!out) continue;
      out.active = out.valid && out.confidence >= minScore;
      fired.push(out);
    }
    fired.sort((a, b) => b.confidence - a.confidence);
    fired.errors = errors;
    return fired;
  }

  // ── condition helpers shared by the library ────────────────────────────────
  const recent = (f, k) => (f?.recent ? f.recent.slice(-k).map(([time, open, high, low, close]) => ({ time, open, high, low, close })) : []);
  const H = {
    R, O, A, recent,
    ok: (f) => !!f?.ready,
    trendWith: (f, s) => !!f?.ready && f.trend.dir === (s.up ? 'UP' : 'DOWN'),
    trendAgainst: (f, s) => !!f?.ready && f.trend.dir === (s.up ? 'DOWN' : 'UP'),
    strongTrendAgainst: (f, s) => H.trendAgainst(f, s) && (f.trend.adx ?? 0) >= 30,
    orderWith: (f, s) => !!f?.ready && f.trend.order === (s.up ? 'BULL' : 'BEAR'),
    structWith: (f, s) => !!f?.ready && f.structure.trend === (s.up ? 'BULL' : 'BEAR'),
    candleWith: (f, s) => !!f?.ready && f.pa.candle.color === (s.up ? 'G' : 'R'),
    closedBeyondPrev: (f, s) => { const [p, x] = recent(f, 2); return !!x && (s.up ? x.close > p.high : x.close < p.low); },
    pattern: (f, s, names) => !!f?.ready && f.pa.patterns.some((p) => p.dir === s.dir && [].concat(names).includes(p.name)),
    anyPattern: (f, s) => !!f?.ready && f.pa.patterns.some((p) => p.dir === s.dir && p.strength >= 55),
    momWith: (f, s) => !!f?.ready && f.momentum.dir === s.dir,
    macdWith: (f, s) => { const m = f?.momentum?.macd; return !!m && m.hist != null && Math.sign(m.hist) === s.sg && (m.histPrev == null || (m.hist - m.histPrev) * s.sg > 0); },
    rsiIn: (f, lo, hi) => f?.momentum?.rsi != null && f.momentum.rsi >= lo && f.momentum.rsi <= hi,
    rsiRising: (f, s) => f?.momentum?.rsiSlope != null && f.momentum.rsiSlope * s.sg > 0,
    exhausted: (f, s) => !!f?.ready && f.momentum.exhaustion[s.up ? 'up' : 'down'],
    exhaustedAgainst: (f, s) => !!f?.ready && f.momentum.exhaustion[s.up ? 'down' : 'up'],
    roomAhead: (X, s, k = 1) => H.opposingDist(X, s) >= k,
    // Distance (5M ATR) to the nearest opposing level on any timeframe.
    opposingDist: (X, s) => {
      const f = X.f5, p = f.price;
      const ahead = (X.levels || []).filter((l) => (s.up ? l.price > p : l.price < p) && (l.touches >= 2 || l.tf !== OTC.TF.PRIMARY));
      return ahead.length ? Math.min(...ahead.map((l) => Math.abs(l.price - p) / f.atr)) : Infinity;
    },
    // A level (any TF) touched by the last 2 candles' extreme, with the close back on our side.
    touchedLevel: (X, s, k = 0.3, minTouches = 1) => {
      const f = X.f5, c = recent(f, 2);
      if (!c.length) return null;
      const ext = s.up ? Math.min(...c.map((x) => x.low)) : Math.max(...c.map((x) => x.high));
      const close = c[c.length - 1].close;
      return (X.levels || []).find((l) => l.touches >= minTouches && Math.abs(l.price - ext) <= k * f.atr
        && (s.up ? close > l.price : close < l.price)) || null;
    },
    // A level with 2+ touches that the last candle closed through (from the other side).
    brokeLevel: (X, s) => {
      const f = X.f5, [p, x] = recent(f, 2);
      if (!x) return null;
      return (X.levels || []).find((l) => l.touches >= 2 && l.tf === OTC.TF.PRIMARY
        && (s.up ? p.close <= l.price && x.close > l.price + 0.1 * f.atr : p.close >= l.price && x.close < l.price - 0.1 * f.atr)) || null;
    },
    pulledBackTo: (f, s, key = 'e21', k = 0.3, bars = 3) => {
      const e = f?.trend?.ema?.[key];
      if (e == null) return false;
      const c = recent(f, bars), last = c[c.length - 1];
      const ext = s.up ? Math.min(...c.map((x) => x.low)) : Math.max(...c.map((x) => x.high));
      return (s.up ? ext <= e + k * f.atr : ext >= e - k * f.atr) && (s.up ? last.close > e : last.close < e);
    },
    fibZone: (f, s, lo, hi) => !!f?.fib?.valid && f.fib.dir === s.dir && f.fib.barsSinceEnd >= 2 && f.fib.depth >= lo && f.fib.depth <= hi,
    fibNear: (f, s, ratio, k = 0.35) => !!f?.fib?.valid && f.fib.dir === s.dir && f.fib.barsSinceEnd >= 2
      && Math.abs((s.up ? Math.min(...recent(f, Math.min(f.fib.barsSinceEnd, 6)).map((x) => x.low)) : Math.max(...recent(f, Math.min(f.fib.barsSinceEnd, 6)).map((x) => x.high))) - f.fib.levels[ratio]) <= k * f.atr,
    fibAtLevel: (X, s) => {
      const f = X.f5;
      if (!f.fib?.valid || f.fib.dir !== s.dir) return null;
      return Object.entries(f.fib.levels).find(([r, p]) => r >= 0.382 && (X.levels || []).some((l) => l.touches >= 2 && Math.abs(l.price - p) <= 0.3 * f.atr)) || null;
    },
    htfWith: (X, s) => !H.trendAgainst(X.f15, s) && !H.trendAgainst(X.f60, s) && (H.trendWith(X.f15, s) || H.trendWith(X.f60, s)),
    htfAgainst: (X, s) => H.trendAgainst(X.f15, s) && H.trendAgainst(X.f60, s),
    adxBelow: (f, v) => (f?.trend?.adx ?? 99) < v,
    insideBreak: (f, s) => {
      const [q, p, x] = recent(f, 3);
      return !!x && p.high < q.high && p.low > q.low && (s.up ? x.close > p.high : x.close < p.low);
    },
  };

  OTC.Strategies = { define, runAll, registry, get: (id) => registry.get(id), list: () => [...registry.values()].filter((s) => !s.hidden), listAll: () => [...registry.values()], H };
})(typeof globalThis !== 'undefined' ? globalThis : this);
