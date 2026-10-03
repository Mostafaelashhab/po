// Strategy Discovery Engine — candidate generation. Everything here looks only at
// the rows it is given (the training period); nothing peeks at validation or OOS,
// except findNegatives' confirmation step, which is labelled as such.
(function (G) {
  const OTC = G.OTC, U = OTC.U, FL = OTC.FeatureLib, D = OTC.Discovery;

  function hashMask(m, from, to) {
    let h = 0x811c9dc5;
    for (let i = from; i < to; i++) if (m[i]) { h ^= i; h = Math.imul(h, 16777619) >>> 0; }
    return h;
  }
  const entry = (a, meta, m, support) => ({ a, key: FL.atomKey(a), feats: a.or ? a.or.map((x) => x.f) : [a.f], group: meta.group, concept: meta.concept || null,
    tf: meta.tf ?? 0, strategy: meta.strategy || null, mask: m, support });

  // Every condition worth testing, from coarse grids, with enough (but not universal)
  // support in the given rows. Conditions matching exactly the same rows are kept once.
  function buildAtoms(ds, [from, to], dc) {
    const nRows = to - from, minSup = Math.max(30, Math.ceil((nRows * dc.minSupportPct) / 100)), maxSup = nRows - minSup;
    const pool = [], seen = new Set();
    const consider = (a, meta) => {
      const m = D.atomMask(ds, a);
      let c = 0;
      for (let i = from; i < to; i++) c += m[i];
      if (c < minSup || c > maxSup) return null;
      const h = `${hashMask(m, from, to)}:${c}`;
      if (seen.has(h)) return null;
      seen.add(h);
      const e = entry(a, meta, m, c);
      pool.push(e);
      return e;
    };
    for (const f of FL.FEATURES) {
      const col = ds.cols[f.id];
      if (!col) continue;
      const meta = { group: f.group, concept: f.concept, tf: f.tf, strategy: f.strategy };
      if (f.type === 'bool') { consider({ f: f.id, op: '==', v: true }, meta); consider({ f: f.id, op: '==', v: false }, meta); }
      else if (f.type === 'cat') {
        const vals = col.dict.slice(0, f.maxValues || 40);
        for (const v of vals) if (!(f.group === 'strategy' && v === 'none')) consider({ f: f.id, op: '==', v }, meta);
        if (f.group !== 'strategy' && vals.length >= 3 && vals.length <= 6) for (const v of vals) consider({ f: f.id, op: '!=', v }, meta);
      } else {
        const g = f.grid;
        for (const v of g) { consider({ f: f.id, op: '<=', v }, meta); consider({ f: f.id, op: '>=', v }, meta); }
        for (let k = 0; k < g.length - 1; k++) {
          consider({ f: f.id, op: 'between', v: [g[k], g[k + 1]] }, meta);
          if (k < g.length - 2) consider({ f: f.id, op: 'between', v: [g[k], g[k + 2]] }, meta);
        }
      }
    }
    // OR of two conditions from the same OR-able group, e.g. "bullish rejection OR bullish engulfing".
    const orable = pool.filter((p) => !p.a.or && p.a.op === '==' && p.a.v === true && FL.get(p.a.f)?.orable);
    for (let i = 0; i < orable.length; i++) for (let j = i + 1; j < orable.length; j++) {
      if (orable[i].group !== orable[j].group) continue;
      consider({ or: [orable[i].a, orable[j].a] }, { group: orable[i].group, tf: Math.max(orable[i].tf, orable[j].tf) });
    }
    return { pool, minSup };
  }

  // Search score: lower confidence bound of the win rate minus break-even, minus a
  // penalty per extra condition. Counts are divided by the expiry (consecutive rows
  // overlap in time), so longer expiries need proportionally more evidence.
  function scorer(ds, idx, dir, N, dc) {
    let ps = 0;
    for (const i of idx) ps += ds.payout[i];
    const BE = U.breakEven(idx.length ? ps / idx.length : 85);
    return {
      BE, win: dir === 'CALL' ? ds.up[N] : ds.dn[N], dec: ds.dec[N],
      score: (c, w, k) => D.wlo(w / N, c / N, dc.zTrain) - BE - dc.complexityPenalty * Math.max(0, k - 1),
      enough: (c) => c / N >= dc.minTrainN,
    };
  }
  const filterIdx = (idx, m) => { const out = []; for (const i of idx) if (m[i]) out.push(i); return Int32Array.from(out); };

  // Beam search over conjunctions of atoms. Returns rules whose score is > 0 (they
  // clear break-even on these rows even after the complexity penalty).
  function beamSearch(ds, pool, idx, dir, N, dc, { seed = [], allowed = null, maxConds = dc.maxConditions, beamWidth = dc.beamWidth, keep = dc.keepPerScope, deadline = Infinity } = {}) {
    const S = scorer(ds, idx, dir, N, dc), cand = allowed ? pool.filter(allowed) : pool;
    let evals = 0;
    const count = (ix) => { let c = 0, w = 0; for (const i of ix) { c += S.dec[i]; w += S.win[i]; } return [c, w]; };
    const seedEntries = seed.map((a) => entry(a, { group: FL.get(a.f)?.group, concept: FL.get(a.f)?.concept, tf: FL.get(a.f)?.tf, strategy: FL.get(a.f)?.strategy }, D.atomMask(ds, a), 0));
    let rootIdx = idx;
    for (const e of seedEntries) rootIdx = filterIdx(rootIdx, e.mask);
    const [rc, rw] = count(rootIdx);
    const root = { atoms: seedEntries, idx: rootIdx, n: rc, w: rw, score: seed.length && S.enough(rc) ? S.score(rc, rw, seed.length) : -Infinity };
    let beam = [root];
    const finals = new Map();
    for (let depth = seed.length; depth < maxConds && beam.length; depth++) {
      const children = [];
      for (const parent of beam) {
        const used = new Set(parent.atoms.flatMap((p) => p.feats)), pidx = parent.idx;
        for (const at of cand) {
          if (at.feats.some((f) => used.has(f))) continue;
          const m = at.mask;
          let c = 0, w = 0;
          for (let j = 0; j < pidx.length; j++) { const i = pidx[j]; if (m[i]) { c += S.dec[i]; w += S.win[i]; } }
          evals++;
          if (!S.enough(c)) continue;
          const s = S.score(c, w, parent.atoms.length + 1);
          if (parent.atoms.length && s <= parent.score + dc.minGainPP) continue; // the new condition must earn its place
          children.push({ parent, at, c, w, s });
        }
        if (Date.now() > deadline) break;
      }
      children.sort((a, b) => b.s - a.s);
      const next = [], seenKey = new Set(), fam = new Map();
      for (const ch of children) {
        const atoms = [...ch.parent.atoms, ch.at];
        const key = atoms.map((x) => x.key).sort().join('&');
        if (seenKey.has(key)) continue;
        seenKey.add(key);
        const famKey = atoms.flatMap((x) => x.feats).sort().join('&'); // same features, other thresholds
        if ((fam.get(famKey) || 0) >= 2) continue;
        fam.set(famKey, (fam.get(famKey) || 0) + 1);
        next.push({ atoms, n: ch.c, w: ch.w, score: ch.s, idx: filterIdx(ch.parent.idx, ch.at.mask), key });
        if (next.length >= beamWidth) break;
      }
      for (const nd of next) if (nd.score > 0) finals.set(nd.key, nd);
      beam = next;
      if (Date.now() > deadline) break;
    }
    const rules = [...finals.values()].sort((a, b) => b.score - a.score).slice(0, keep)
      .map((nd) => ({ rule: { dir, expiry: N, all: nd.atoms.map((x) => x.a), none: [] }, trainScore: nd.score, rawN: nd.n }));
    return { rules, evals, BE: S.BE, root: { n: rc, w: rw, score: root.score } };
  }

  // Raw (overlapping) score of any rule on the given rows — used to compare variants quickly.
  function quickScore(ds, rule, [from, to], dc) {
    const m = D.ruleMask(ds, rule), N = rule.expiry, win = rule.dir === 'CALL' ? ds.up[N] : ds.dn[N], dec = ds.dec[N];
    let c = 0, w = 0, ps = 0, k = 0;
    for (let i = from; i < to; i++) if (m[i]) { c += dec[i]; w += win[i]; ps += ds.payout[i]; k++; }
    const BE = U.breakEven(k ? ps / k : 85), conds = (rule.all?.length || 0) + (rule.none?.length || 0);
    const score = c / N >= dc.minTrainN ? D.wlo(w / N, c / N, dc.zTrain) - BE - dc.complexityPenalty * Math.max(0, conds - 1) : -Infinity;
    return { c, w, score, BE };
  }

  // Controlled mutations of an existing rule: each result is a separate candidate.
  function mutations(rule, ds, dc) {
    const out = [], add = (r, mutation) => out.push({ rule: { ...r, none: r.none || [] }, mutation });
    const all = rule.all;
    all.forEach((a, i) => { if (all.length > 1) add({ ...rule, all: all.filter((_, j) => j !== i) }, `remove ${FL.label(a)}`); });
    all.forEach((a, i) => {
      const f = a.or ? null : FL.get(a.f);
      if (!f) return;
      const swap = (b, why) => add({ ...rule, all: all.map((x, j) => (j === i ? b : x)) }, why);
      if (f.type === 'num' && f.grid) {
        const g = f.grid;
        if (a.op === 'between') {
          const [lo, hi] = a.v, li = g.indexOf(lo), hj = g.indexOf(hi);
          for (const [x, y] of [[li - 1, hj - 1], [li + 1, hj + 1], [li - 1, hj], [li, hj + 1]]) if (x >= 0 && y < g.length && x < y) swap({ ...a, v: [g[x], g[y]] }, `range ${g[x]}…${g[y]}`);
        } else {
          const k = g.indexOf(a.v);
          for (const d of [-1, 1]) if (g[k + d] != null) swap({ ...a, v: g[k + d] }, `threshold ${a.v} → ${g[k + d]}`);
        }
      }
      for (const v of f.variants || []) swap({ ...a, f: v }, `${f.label} → ${FL.get(v)?.label}`);
      if (f.concept) {
        for (const g of FL.FEATURES) {
          if (g.concept !== f.concept || g.id === f.id || g.type !== f.type || g.tf === f.tf) continue;
          if (f.type === 'cat' && g.values && !g.values.includes(a.v)) continue;
          swap({ ...a, f: g.id }, `${f.label} → ${g.label}`);
        }
      }
      if (f.id === 'seq3') swap({ f: 'seq2', op: a.op, v: String(a.v).split(',').slice(1).join(',') }, 'shorter sequence');
      if (f.id === 'ctx.regime') {
        for (const r of OTC.REGIMES) if (r !== a.v) swap({ ...a, v: r }, `regime → ${r}`);
      }
    });
    if (!all.some((a) => a.f === 'ctx.regime')) for (const r of ['TRENDING_UP', 'TRENDING_DOWN', 'RANGING', 'BREAKOUT', 'REVERSAL']) add({ ...rule, all: [...all, { f: 'ctx.regime', op: '==', v: r }] }, `only in ${r}`);
    for (const N of ds.expiries) if (N !== rule.expiry) add({ ...rule, expiry: N }, `expiry ${rule.expiry} → ${N}`);
    (rule.none || []).forEach((a, i) => add({ ...rule, none: rule.none.filter((_, j) => j !== i) }, `drop filter ${FL.label(a)}`));
    return out;
  }

  // Backward elimination on training rows: drop the condition that costs least while the
  // lower bound stays within tolerance. SIMPLE + ROBUST beats COMPLEX + FRAGILE.
  function simplify(ds, rule, rows, dc) {
    let cur = rule, curS = quickScore(ds, cur, rows, dc).score;
    const ref = curS;
    while (cur.all.length > 1) {
      let best = null;
      cur.all.forEach((_, i) => {
        const r = { ...cur, all: cur.all.filter((__, j) => j !== i) };
        const s = quickScore(ds, r, rows, dc).score;
        if (!best || s > best.s) best = { r, s };
      });
      // the penalty for one fewer condition is already credited inside the score
      if (best.s >= ref - dc.simplifyTolPP - 0 && best.s > 0) { cur = best.r; curS = best.s; } else break;
    }
    return cur === rule ? null : { rule: cur, score: curS };
  }

  // Specialisations found on training rows: a regime or a single pair where the rule
  // clearly does better than overall.
  function specialisations(ds, rule, rows, dc) {
    const out = [], base = quickScore(ds, rule, rows, dc).score;
    if (!rule.all.some((a) => a.f === 'ctx.regime')) {
      for (const r of OTC.REGIMES) {
        const v = { ...rule, all: [...rule.all, { f: 'ctx.regime', op: '==', v: r }] };
        const s = quickScore(ds, v, rows, dc).score;
        if (s > 0 && s > base + 2) out.push({ rule: v, mutation: `regime specialisation: ${r}` });
      }
    }
    if (!rule.pairs?.length && ds.assets.length > 1 && !rule.all.some((a) => a.f === 'pair')) {
      for (const p of ds.assets) {
        const v = { ...rule, pairs: [p] };
        const s = quickScore(ds, v, rows, dc).score;
        if (s > 0 && s > base + 2) out.push({ rule: v, mutation: `pair specialisation: ${p}` });
      }
    }
    return out;
  }

  // Contradiction discovery: conditions under which a working rule does much worse.
  // Found on training rows, then confirmed on validation rows (so the refined rule's
  // validation is no longer independent — it must still pass out-of-sample and paper).
  function findNegatives(ds, pool, rule, sp, dc) {
    const m = D.ruleMask(ds, rule), N = rule.expiry, win = rule.dir === 'CALL' ? ds.up[N] : ds.dn[N], dec = ds.dec[N];
    const used = new Set(rule.all.flatMap((a) => (a.or ? a.or.map((x) => x.f) : [a.f])));
    const stat = (atM, [from, to]) => {
      let ca = 0, wa = 0, cb = 0, wb = 0;
      for (let i = from; i < to; i++) if (m[i] && dec[i]) { if (atM[i]) { ca++; wa += win[i]; } else { cb++; wb += win[i]; } }
      return { ca, wa, cb, wb, z: D.twoPropZ(wa, ca, wb, cb) };
    };
    let total = 0;
    for (let i = sp.train[0]; i < sp.train[1]; i++) total += m[i] && dec[i];
    const found = [];
    for (const at of pool) {
      // "avoid NOT x" is just "require x" — positive conditions are the search's job
      if (at.a.or || at.a.op === '!=' || at.a.v === false || at.feats.some((f) => used.has(f)) || at.group === 'strategy') continue;
      const s = stat(at.mask, sp.train);
      if (s.ca < Math.max(30, 0.08 * total) || s.cb < 30 || s.z > -dc.negZ) continue;
      found.push({ atom: at.a, train: s });
    }
    found.sort((a, b) => a.train.z - b.train.z);
    const accepted = [], feats = new Set();
    for (const f of found.slice(0, 8)) {
      if (accepted.length >= dc.maxNegatives || feats.has(f.atom.f)) continue;
      const v = stat(D.atomMask(ds, f.atom), sp.validation);
      if (v.ca >= 15 && v.z <= -1 && v.wa / v.ca < v.wb / Math.max(1, v.cb)) { accepted.push({ ...f, validation: v }); feats.add(f.atom.f); }
    }
    return accepted;
  }

  // "Do not trade" filters: conditions under which the engine's own CALL (or PUT)
  // decisions do significantly worse than its other decisions.
  function findFilters(ds, pool, rows, dir, N, dc, deadline = Infinity) {
    let basis = 'eng.decision', pop = D.atomMask(ds, { f: 'eng.decision', op: '==', v: dir });
    let popN = 0;
    for (let i = rows[0]; i < rows[1]; i++) popN += pop[i] && ds.dec[N][i];
    if (popN / N < 3 * dc.minTrainN) { basis = 'eng.lean'; pop = D.atomMask(ds, { f: 'eng.lean', op: '==', v: dir }); }
    const win = dir === 'CALL' ? ds.up[N] : ds.dn[N], dec = ds.dec[N];
    const idx = [];
    for (let i = rows[0]; i < rows[1]; i++) if (pop[i] && dec[i]) idx.push(i);
    let W = 0;
    for (const i of idx) W += win[i];
    const C = idx.length;
    const test = (m) => { let c = 0, w = 0; for (const i of idx) if (m[i]) { c++; w += win[i]; } return { c, w, z: D.twoPropZ(w, c, W - w, C - c) }; };
    const one = [];
    for (const at of pool) {
      if (at.group === 'strategy' || at.group === 'engine' || at.feats.includes('pair')) continue;
      const r = test(at.mask);
      if (r.c / N >= dc.minTrainN && C - r.c >= 30 && r.z <= -dc.filterZ) one.push({ atoms: [at], ...r });
      if (Date.now() > deadline) break;
    }
    one.sort((a, b) => a.z - b.z);
    const out = one.slice(0, 10);
    // pairs of the strongest single filters
    for (let i = 0; i < Math.min(6, one.length); i++) for (let j = i + 1; j < Math.min(6, one.length); j++) {
      if (one[i].atoms[0].feats.some((f) => one[j].atoms[0].feats.includes(f))) continue;
      const m = new Uint8Array(ds.n), a = one[i].atoms[0].mask, b = one[j].atoms[0].mask;
      for (const k of idx) m[k] = a[k] & b[k];
      const r = test(m);
      if (r.c / N >= dc.minTrainN && r.z < Math.min(one[i].z, one[j].z) - 0.5) out.push({ atoms: [one[i].atoms[0], one[j].atoms[0]], ...r });
    }
    return out.map((f) => ({ rule: { dir, expiry: N, all: f.atoms.map((x) => x.a), none: [] }, basis, trainZ: f.z }));
  }

  Object.assign(OTC.Discovery, { buildAtoms, beamSearch, quickScore, mutations, simplify, specialisations, findNegatives, findFilters, hashMask, scorer });
})(typeof globalThis !== 'undefined' ? globalThis : this);
