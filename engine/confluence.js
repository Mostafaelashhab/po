// Confluence Engine. Ten evidence modules each vote CALL / PUT / NEUTRAL with a
// confidence. Modules that read the same underlying information are grouped into
// clusters (e.g. EMA trend and MACD momentum are both functions of recent closes),
// and inside a cluster only the strongest vote counts fully — the rest add 30%.
// So two correlated indicators never count as two independent confirmations.
// The stats engine measures the real correlation between module votes.
(function (G) {
  const OTC = G.OTC, U = OTC.U, H = OTC.Strategies.H;

  OTC.CLUSTERS = {
    trendMomentum: ['trend', 'momentum'],
    location: ['sr', 'fibonacci', 'bollinger'],
    structure: ['structure', 'breakout'],
    candle: ['priceAction'],
    external: ['signal'],
  };
  const clusterOf = {};
  for (const [c, mods] of Object.entries(OTC.CLUSTERS)) for (const m of mods) clusterOf[m] = c;

  const vote = (dir, confidence, reason) => ({ dir: dir || 'NEUTRAL', confidence: Math.round(U.clamp(confidence)), reason });
  const N = (reason) => vote('NEUTRAL', 50, reason);
  const tDir = (d) => (d === 'UP' ? 'CALL' : d === 'DOWN' ? 'PUT' : null);

  const MODULES = {
    trend(X) {
      const f = X.f5, d = tDir(f.trend.dir);
      if (!d) return N('5M trend flat');
      let c = 40 + 0.5 * f.trend.strength;
      const d15 = X.f15?.ready ? tDir(X.f15.trend.dir) : null;
      if (d15 === d) c += 10; else if (d15 && d15 !== d) c -= 15;
      return vote(d, c, `5M ${f.trend.dir}${d15 ? `, 15M ${X.f15.trend.dir}` : ''}`);
    },
    structure(X) {
      const s = X.f5.structure;
      if (s.bos && s.bos.ago <= 3) return vote(s.bos.dir, 75, `BOS ${s.bos.dir} ${s.bos.ago} bar(s) ago`);
      if (s.choch && s.choch.ago <= 3) return vote(s.choch.dir, 65, `CHOCH ${s.choch.dir}`);
      if (s.trend === 'BULL') return vote('CALL', s.quality, 'HH/HL structure');
      if (s.trend === 'BEAR') return vote('PUT', s.quality, 'LH/LL structure');
      return N(`structure ${s.trend.toLowerCase()}`);
    },
    priceAction(X) {
      const p = X.f5.pa.patterns.filter((x) => x.dir).sort((a, b) => b.strength - a.strength)[0];
      return p ? vote(p.dir, p.strength, p.name.replace(/_/g, ' ')) : N('no directional pattern');
    },
    sr(X) {
      const sup = H.touchedLevel(X, U.side('CALL'), 0.4), res = H.touchedLevel(X, U.side('PUT'), 0.4);
      if (sup && !res) return vote('CALL', 55 + Math.min(30, sup.strength / 3), `held ${OTC.TF_LABEL[sup.tf]} support (${sup.touches} touches)`);
      if (res && !sup) return vote('PUT', 55 + Math.min(30, res.strength / 3), `held ${OTC.TF_LABEL[res.tf]} resistance (${res.touches} touches)`);
      return N(sup && res ? 'between support and resistance' : 'not at a level');
    },
    momentum(X) {
      const m = X.f5.momentum;
      return m.dir === 'NEUTRAL' ? N('momentum neutral') : vote(m.dir, 50 + m.strength / 2, `RSI ${Math.round(m.rsi)}, MACD hist ${m.macd.hist > 0 ? '+' : '−'}`);
    },
    volatility(X) {
      // Not directional: reports how tradable volatility is (used as a multiplier).
      const v = X.f5.volatility;
      const q = v.abnormal ? 0.3 : v.state === 'HIGH' ? 0.6 : v.state === 'LOW' ? 0.7 : v.state === 'UNKNOWN' ? 0.8 : 1;
      return { ...N(`ATR percentile ${v.atrPct == null ? '?' : Math.round(v.atrPct)}`), quality: q };
    },
    breakout(X) {
      const b = X.f5.breakout, sw = X.f5.liquidity.sweep;
      if (sw?.confirmed && sw.ago <= 1) return vote(sw.dir, 70, `liquidity sweep ${sw.dir}`);
      if (b.status === 'BREAKOUT_RETEST') return vote(b.dir, 80, 'breakout retest held');
      if (b.status === 'REAL_BREAKOUT' && b.ago <= 2) return vote(b.dir, b.exhausted ? 50 : 70, `real breakout${b.exhausted ? ' (exhausted)' : ''}`);
      if (b.status === 'FALSE_BREAKOUT') return vote(U.opp(b.dir), 65, `failed ${b.dir} breakout`);
      return N(b.status ? b.status.toLowerCase().replace('_', ' ') : 'no breakout');
    },
    fibonacci(X) {
      const f = X.f5.fib;
      if (!f.valid || f.barsSinceEnd < 2) return N('no measurable leg');
      if (f.depth >= 0.382 && f.depth <= 0.786 && H.candleWith(X.f5, U.side(f.dir))) return vote(f.dir, 65, `${Math.round(f.depth * 100)}% retracement, resuming`);
      return N(`retracement ${Math.round(f.depth * 100)}%`);
    },
    bollinger(X) {
      const b = X.f5.bb;
      if (b.breakUpper && b.expansion) return vote('CALL', 65, 'upper-band breakout, expanding');
      if (b.breakLower && b.expansion) return vote('PUT', 65, 'lower-band breakout, expanding');
      if (b.rejectLower && !b.expansion) return vote('CALL', 62, 'lower-band rejection');
      if (b.rejectUpper && !b.expansion) return vote('PUT', 62, 'upper-band rejection');
      return N(`%B ${b.pctB.toFixed(2)}`);
    },
    signal(X) {
      const s = X.signal;
      return s?.dir ? vote(s.dir, s.confidence ?? 55, `${s.source}${s.note ? ` — ${s.note}` : ''}`) : N('no platform signal');
    },
  };

  function evaluate(X, cfg = OTC.DEFAULT_CONFIG) {
    const modules = {};
    for (const [k, fn] of Object.entries(MODULES)) {
      try { modules[k] = fn(X); } catch (e) { modules[k] = { ...N(`error: ${e.message}`), error: true }; }
    }
    const w = cfg.weights;
    const volQ = modules.volatility.quality ?? 1;
    const totalW = U.sum(Object.keys(clusterOf).map((m) => w[m] || 0));
    const side = (dir) => {
      let pro = 0, con = 0;
      const agree = [], oppose = [];
      for (const [cl, mods] of Object.entries(OTC.CLUSTERS)) {
        const part = (want) => {
          const xs = mods.filter((m) => modules[m].dir === want).map((m) => (w[m] || 0) * (modules[m].confidence / 100)).sort((a, b) => b - a);
          return xs.length ? xs[0] + 0.3 * U.sum(xs.slice(1)) : 0;
        };
        const p = part(dir), q = part(U.opp(dir));
        pro += p; con += q;
        if (p > q) agree.push(cl); else if (q > p) oppose.push(cl);
      }
      const raw = 50 + (50 * (pro - con)) / (totalW || 1);
      return { score: Math.round(U.clamp(50 + (raw - 50) * volQ)), pro, con, agree, oppose };
    };
    const call = side('CALL'), put = side('PUT');
    const best = call.score >= put.score ? 'CALL' : 'PUT';
    const top = best === 'CALL' ? call : put;
    return {
      direction: top.score > 55 ? best : 'NEUTRAL',
      scores: { CALL: call.score, PUT: put.score },
      clusters: { CALL: { agree: call.agree, oppose: call.oppose }, PUT: { agree: put.agree, oppose: put.oppose } },
      modules, volatilityQuality: volQ,
    };
  }

  OTC.Confluence = { evaluate, MODULES, clusterOf };
})(typeof globalThis !== 'undefined' ? globalThis : this);
