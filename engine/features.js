// Feature engines. compute(candles, tf) reads one timeframe and returns plain
// facts (no decisions): trend, momentum, Bollinger, structure, levels, Fibonacci,
// price action, breakout, liquidity, divergence, volatility.
// Distances are in ATR units of that timeframe so pairs with different prices compare.
// Depends on `Ind` (indicators.js).
(function (G) {
  const OTC = G.OTC, U = OTC.U;
  const { body, range, green, red, upperWick, lowerWick, clamp } = U;
  const WINDOW = 200;

  // Fractal swings: bar i is a swing high if its high is the max of i-k..i+k.
  // Only confirmed swings (k bars to the right exist) are returned.
  function swings(c, k = 2, lookback = 120) {
    const n = c.length - 1, from = Math.max(k, c.length - lookback), highs = [], lows = [];
    for (let i = from; i <= n - k; i++) {
      let isH = true, isL = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (c[j].high > c[i].high || (j < i && c[j].high === c[i].high)) isH = false;
        if (c[j].low < c[i].low || (j < i && c[j].low === c[i].low)) isL = false;
      }
      if (isH) highs.push({ i, price: c[i].high });
      if (isL) lows.push({ i, price: c[i].low });
    }
    return { highs, lows };
  }

  function runLength(c, pred) { let k = 0; for (let i = c.length - 1; i >= 0 && pred(c[i]); i--) k++; return k; }

  // ── trend ──────────────────────────────────────────────────────────────────
  function trendFeatures(c, I, a) {
    const n = c.length - 1, price = c[n].close;
    const e = { e9: I.ema9[n], e18: I.ema18[n], e21: I.ema21[n], e24: I.ema24[n], e50: I.ema50[n], e200: I.ema200[n] };
    let order = 'MIXED';
    if (e.e50 != null) {
      if (e.e9 > e.e21 && e.e21 > e.e50) order = 'BULL';
      else if (e.e9 < e.e21 && e.e21 < e.e50) order = 'BEAR';
    } else if (e.e9 != null && e.e21 != null) order = e.e9 > e.e21 ? 'BULL' : e.e9 < e.e21 ? 'BEAR' : 'MIXED';
    const slope = (s, k) => (s[n] != null && s[n - k] != null ? (s[n] - s[n - k]) / (k * a) : 0);
    const slope21 = slope(I.ema21, 5), slope50 = slope(I.ema50, 10);
    let path = 0;
    for (let i = Math.max(1, n - 19); i <= n; i++) path += Math.abs(c[i].close - c[i - 1].close);
    const er = path ? Math.abs(price - c[Math.max(0, n - 20)].close) / path : 0;
    const adx = I.adx.adx[n], pdi = I.adx.plusDI[n], mdi = I.adx.minusDI[n];
    let dir = 'FLAT';
    if ((order === 'BULL' && slope21 > 0.02) || (adx >= 20 && pdi > mdi && price > e.e21 && slope21 > 0.05)) dir = 'UP';
    if ((order === 'BEAR' && slope21 < -0.02) || (adx >= 20 && mdi > pdi && price < e.e21 && slope21 < -0.05)) dir = 'DOWN';
    const strength = clamp(0.4 * clamp((adx ?? 0) * 1.6) + 0.3 * clamp(er * 150) + 0.3 * clamp(Math.abs(slope21) * 500));
    let cross = null;
    for (let i = n; i >= Math.max(1, n - 2); i--) {
      const f = I.ema9, s = I.ema21;
      if (f[i - 1] == null || s[i - 1] == null) break;
      if (f[i - 1] <= s[i - 1] && f[i] > s[i]) { cross = { dir: 'CALL', ago: n - i }; break; }
      if (f[i - 1] >= s[i - 1] && f[i] < s[i]) { cross = { dir: 'PUT', ago: n - i }; break; }
    }
    return {
      dir, strength, order, slope21, slope50, er, adx, pdi, mdi, cross, ema: e,
      separation: e.e50 != null ? (e.e9 - e.e50) / a : null,
      // separation 5 bars ago, for EMA expansion / compression
      sepPrev: I.ema50[n - 5] != null ? (I.ema9[n - 5] - I.ema50[n - 5]) / a : null,
      dist: { e9: (price - e.e9) / a, e18: (price - e.e18) / a, e21: (price - e.e21) / a, e24: (price - e.e24) / a, e50: e.e50 != null ? (price - e.e50) / a : null,
        e200: e.e200 != null ? (price - e.e200) / a : null },
    };
  }

  // ── momentum ───────────────────────────────────────────────────────────────
  function momentumFeatures(c, I, a, trend) {
    const n = c.length - 1;
    const rsi = I.rsi[n], rsiPrev = I.rsi[n - 1], hist = I.macd.hist[n], histPrev = I.macd.hist[n - 1], histPrev2 = I.macd.hist[n - 2];
    const k = I.stoch.k[n], d = I.stoch.d[n];
    const stochCross = [n, n - 1].map((i) => (I.stoch.k[i - 1] <= I.stoch.d[i - 1] && I.stoch.k[i] > I.stoch.d[i] ? 'CALL'
      : I.stoch.k[i - 1] >= I.stoch.d[i - 1] && I.stoch.k[i] < I.stoch.d[i] ? 'PUT' : null)).find(Boolean) || null;
    const press = (from, to) => U.sum(c.slice(from, to).map((x) => x.close - x.open)) / a;
    const candleMom = press(n - 2, n + 1), prevMom = press(n - 5, n - 2);
    const accel = Math.sign(candleMom) === Math.sign(prevMom) && Math.abs(candleMom) > Math.abs(prevMom) * 1.2;
    const decel = Math.sign(candleMom) === Math.sign(prevMom) && Math.abs(candleMom) < Math.abs(prevMom) * 0.6;
    let score = 0;
    if (rsi != null) score += clamp((rsi - 50) / 10, -2, 2);
    if (hist != null) score += Math.sign(hist) * (histPrev != null && Math.abs(hist) > Math.abs(histPrev) ? 1 : 0.5);
    score += clamp(candleMom, -2, 2);
    if (I.roc[n] != null) score += 0.5 * Math.sign(I.roc[n]);
    const dir = score > 1 ? 'CALL' : score < -1 ? 'PUT' : 'NEUTRAL';
    const greens = runLength(c, green), reds = runLength(c, red);
    const shrinking = body(c[n]) < body(c[n - 1]) && body(c[n - 1]) < body(c[n - 2]);
    const exhaustion = {
      up: (rsi > 70 && (shrinking || upperWick(c[n]) > body(c[n]))) || greens >= 5 || trend.dist.e21 > 2.5,
      down: (rsi < 30 && (shrinking || lowerWick(c[n]) > body(c[n]))) || reds >= 5 || trend.dist.e21 < -2.5,
    };
    const weakening = {
      up: hist > 0 && histPrev != null && histPrev2 != null && hist < histPrev && histPrev < histPrev2,
      down: hist < 0 && histPrev != null && histPrev2 != null && hist > histPrev && histPrev > histPrev2,
    };
    return {
      dir, strength: clamp(Math.abs(score) * 20), score, rsi, rsiPrev, rsiSlope: rsi != null && I.rsi[n - 2] != null ? rsi - I.rsi[n - 2] : 0,
      macd: { line: I.macd.line[n], signal: I.macd.signal[n], hist, histPrev,
        flip: hist != null && histPrev != null ? (histPrev <= 0 && hist > 0 ? 'CALL' : histPrev >= 0 && hist < 0 ? 'PUT' : null) : null },
      stoch: { k, d, cross: stochCross }, roc: I.roc[n], rocPrev: I.roc[n - 1], candleMom, prevMom, accel, decel, exhaustion, weakening,
      recovering: { up: rsi > rsiPrev && rsiPrev < 50 && hist > histPrev, down: rsi < rsiPrev && rsiPrev > 50 && hist < histPrev },
      run: { green: greens, red: reds },
    };
  }

  // ── Bollinger ──────────────────────────────────────────────────────────────
  function bollingerFeatures(c, I) {
    const n = c.length - 1, bb = I.bb, last = c[n];
    const width = bb.upper.map((u, i) => (u == null ? null : (u - bb.lower[i]) / bb.mid[i]));
    const widthPct = U.pctRank(width, 100);
    // squeeze in any of the 6 bars before this one (a breakout usually ends the squeeze)
    let squeezeRecent = false;
    for (let k = 1; k <= 6 && !squeezeRecent; k++) { const r = U.pctRank(width.slice(0, n + 1 - k), 100); if (r != null && r <= 15) squeezeRecent = true; }
    const u = bb.upper[n], l = bb.lower[n], m = bb.mid[n];
    const touched = (i, up) => (up ? c[i].high >= bb.upper[i] : c[i].low <= bb.lower[i]);
    const rng = range(last) || 1e-12;
    return {
      upper: u, mid: m, lower: l, width: width[n], widthPrev3: width[n - 3], widthPct,
      squeeze: widthPct != null && widthPct <= 15, squeezeRecent,
      expansion: width[n] != null && width[n - 3] != null && width[n] > width[n - 3] * 1.2 && (widthPct ?? 0) >= 50,
      pctB: u !== l ? (last.close - l) / (u - l) : 0.5,
      touchUpper: touched(n, true) || touched(n - 1, true),
      touchLower: touched(n, false) || touched(n - 1, false),
      rejectUpper: (touched(n, true) && last.close < u && upperWick(last) >= 0.3 * rng)
        || (touched(n - 1, true) && red(last) && last.close < bb.upper[n - 1]),
      rejectLower: (touched(n, false) && last.close > l && lowerWick(last) >= 0.3 * rng)
        || (touched(n - 1, false) && green(last) && last.close > bb.lower[n - 1]),
      breakUpper: last.close > u && body(last) >= 0.5 * rng,
      breakLower: last.close < l && body(last) >= 0.5 * rng,
      crossedMid: c[n - 1].close <= bb.mid[n - 1] && last.close > m ? 'CALL' : c[n - 1].close >= bb.mid[n - 1] && last.close < m ? 'PUT' : null,
    };
  }

  // ── structure ──────────────────────────────────────────────────────────────
  function structureFeatures(c, a) {
    const n = c.length - 1, sw = swings(c, 2, 120);
    const seq = [...sw.highs.map((x) => ({ ...x, t: 'H' })), ...sw.lows.map((x) => ({ ...x, t: 'L' }))].sort((x, y) => x.i - y.i);
    const labels = [];
    let pH = null, pL = null;
    for (const x of seq) {
      if (x.t === 'H') { if (pH) labels.push({ i: x.i, lab: x.price > pH.price ? 'HH' : 'LH', price: x.price }); pH = x; }
      else { if (pL) labels.push({ i: x.i, lab: x.price > pL.price ? 'HL' : 'LL', price: x.price }); pL = x; }
    }
    const recent = labels.slice(-4).map((x) => x.lab);
    const bull = recent.filter((l) => l === 'HH' || l === 'HL').length;
    const trend = recent.length < 3 ? 'UNCLEAR' : bull >= 3 ? 'BULL' : bull <= 1 ? 'BEAR' : 'RANGE';
    const quality = recent.length < 3 ? 0 : Math.round((Math.max(bull, recent.length - bull) / recent.length) * 100);
    const lastHigh = sw.highs[sw.highs.length - 1] || null, lastLow = sw.lows[sw.lows.length - 1] || null;

    // Break of the latest swing within the last 8 bars, by close.
    const brk = (sp, up) => {
      if (!sp) return null;
      for (let i = sp.i + 1; i <= n; i++) {
        if (up ? c[i].close > sp.price : c[i].close < sp.price) return n - i <= 8 ? { level: sp.price, ago: n - i, at: i } : null;
      }
      return null;
    };
    const upB = brk(lastHigh, true), dnB = brk(lastLow, false);
    const prior = trend; // labels are from swings that precede the break
    const pick = (b, dir) => (b ? { dir, ...b } : null);
    let bos = null, choch = null;
    if (upB && (!dnB || upB.ago <= dnB.ago)) { if (prior === 'BULL') bos = pick(upB, 'CALL'); else choch = pick(upB, 'CALL'); }
    else if (dnB) { if (prior === 'BEAR') bos = pick(dnB, 'PUT'); else choch = pick(dnB, 'PUT'); }

    // Swing failure: wick through the latest swing, close back inside (last 2 bars).
    let sfp = null;
    for (const i of [n, n - 1]) {
      if (lastHigh && i > lastHigh.i && c[i].high > lastHigh.price && c[i].close < lastHigh.price) { sfp = { dir: 'PUT', level: lastHigh.price, ago: n - i }; break; }
      if (lastLow && i > lastLow.i && c[i].low < lastLow.price && c[i].close > lastLow.price) { sfp = { dir: 'CALL', level: lastLow.price, ago: n - i }; break; }
    }
    const lastTwo = labels.slice(-2).map((x) => x.lab).sort().join('+');
    return {
      trend, quality, labels: labels.slice(-6), swings: sw, lastHigh, lastLow, bos, choch, sfp,
      hhhl: lastTwo === 'HH+HL', lhll: lastTwo === 'LH+LL',
      lastLabel: labels.length ? labels[labels.length - 1].lab : null,
    };
  }

  // ── support / resistance ───────────────────────────────────────────────────
  function psychStep(price) { return 0.5 * 10 ** (Math.floor(Math.log10(Math.abs(price) || 1)) - 2); }

  function levelFeatures(c, a, sw, tf) {
    const n = c.length - 1, price = c[n].close, tol = 0.25 * a, lv = [];
    for (const p of [...sw.highs.map((x) => ({ ...x, side: 'H' })), ...sw.lows.map((x) => ({ ...x, side: 'L' }))]) {
      const wick = p.side === 'H' ? upperWick(c[p.i]) : lowerWick(c[p.i]);
      const L = lv.find((l) => Math.abs(l.price - p.price) <= tol);
      if (L) { L.price = (L.price * L.touches + p.price) / (L.touches + 1); L.touches++; L.last = Math.max(L.last, p.i); L.wick += wick; }
      else lv.push({ price: p.price, touches: 1, last: p.i, wick });
    }
    for (const L of lv) {
      const age = n - L.last;
      L.rejection = L.wick / L.touches / a;
      L.strength = clamp(L.touches * 22 + clamp(30 - age, 0, 30) + clamp(L.rejection * 15, 0, 20));
      L.dist = (L.price - price) / a; // + above price, − below
      L.tf = tf;
      delete L.wick;
    }
    const supports = lv.filter((l) => l.price < price - 0.05 * a).sort((x, y) => y.price - x.price);
    const resistances = lv.filter((l) => l.price > price + 0.05 * a).sort((x, y) => x.price - y.price);
    const step = psychStep(price);
    const psychBelow = Math.floor(price / step) * step, psychAbove = Math.ceil(price / step) * step;
    return {
      all: lv, supports, resistances,
      nearestSup: supports[0] || null, nearestRes: resistances[0] || null,
      distSup: supports[0] ? (price - supports[0].price) / a : Infinity,
      distRes: resistances[0] ? (resistances[0].price - price) / a : Infinity,
      psych: { step, below: psychBelow, above: psychAbove, distBelow: (price - psychBelow) / a, distAbove: (psychAbove - price) / a },
    };
  }

  // ── Fibonacci: the largest move in the last 40 bars, and how far price has retraced it.
  const FIB = [0.236, 0.382, 0.5, 0.618, 0.786];
  function fibFeatures(c, a) {
    const n = c.length - 1, from = Math.max(0, n - 40);
    let hi = from, lo = from;
    for (let i = from; i <= n; i++) { if (c[i].high > c[hi].high) hi = i; if (c[i].low < c[lo].low) lo = i; }
    const H = c[hi].high, L = c[lo].low, size = H - L;
    if (size < 3 * a || hi === lo) return { valid: false };
    const up = lo < hi; // impulse went up (low first)
    const end = up ? hi : lo;
    let ext = up ? Infinity : -Infinity;
    for (let i = end + 1; i <= n; i++) ext = up ? Math.min(ext, c[i].low) : Math.max(ext, c[i].high);
    const bars = n - end;
    const depth = bars ? (up ? (H - ext) / size : (ext - L) / size) : 0;
    const current = up ? (H - c[n].close) / size : (c[n].close - L) / size;
    const levels = {};
    for (const r of FIB) levels[r] = up ? H - r * size : L + r * size;
    const nearest = FIB.map((r) => ({ ratio: r, price: levels[r], dist: bars ? Math.abs((up ? ext : ext) - levels[r]) / a : Infinity }))
      .sort((x, y) => x.dist - y.dist)[0];
    return { valid: true, dir: up ? 'CALL' : 'PUT', high: H, low: L, sizeAtr: size / a, barsSinceEnd: bars, depth, current, levels, nearest };
  }

  // ── price action ───────────────────────────────────────────────────────────
  function priceAction(c, a) {
    const n = c.length - 1, x = c[n], p = c[n - 1], q = c[n - 2];
    const rng = range(x) || 1e-12, b = body(x), uw = upperWick(x), lw = lowerWick(x);
    const priorDown = c[n - 1].close < c[Math.max(0, n - 4)].close, priorUp = c[n - 1].close > c[Math.max(0, n - 4)].close;
    const out = [];
    const add = (name, dir, strength) => out.push({ name, dir, strength: Math.round(clamp(strength)) });
    if (green(x) && red(p) && x.close >= p.open && x.open <= p.close && b > body(p)) add('bullish_engulfing', 'CALL', 50 + 25 * (b / (body(p) || b)));
    if (red(x) && green(p) && x.close <= p.open && x.open >= p.close && b > body(p)) add('bearish_engulfing', 'PUT', 50 + 25 * (b / (body(p) || b)));
    const pinBull = lw >= 2 * b && lw >= 0.6 * rng && uw <= 0.25 * rng && rng >= 0.5 * a;
    const pinBear = uw >= 2 * b && uw >= 0.6 * rng && lw <= 0.25 * rng && rng >= 0.5 * a;
    if (pinBull) add('pin_bar', 'CALL', 50 + 40 * (lw / rng));
    if (pinBear) add('pin_bar', 'PUT', 50 + 40 * (uw / rng));
    if (pinBull && priorDown) add('hammer', 'CALL', 60 + 30 * (lw / rng));
    if (pinBear && priorUp) add('shooting_star', 'PUT', 60 + 30 * (uw / rng));
    if (b <= 0.1 * rng && rng > 0) {
      add('doji', null, 40);
      if (lw >= 0.6 * rng) add('doji_rejection', 'CALL', 55);
      if (uw >= 0.6 * rng) add('doji_rejection', 'PUT', 55);
    }
    if (x.high < p.high && x.low > p.low) add('inside_bar', null, 50);
    if (x.high > p.high && x.low < p.low && b >= 0.5 * rng) add('outside_bar', green(x) ? 'CALL' : 'PUT', 60);
    const smallMid = body(p) <= 0.3 * body(q);
    if (red(q) && body(q) >= 0.6 * a && smallMid && green(x) && x.close > (q.open + q.close) / 2) add('morning_star', 'CALL', 70);
    if (green(q) && body(q) >= 0.6 * a && smallMid && red(x) && x.close < (q.open + q.close) / 2) add('evening_star', 'PUT', 70);
    if (Math.abs(x.low - p.low) <= 0.1 * a && red(p) && green(x) && priorDown) add('tweezer_bottom', 'CALL', 60);
    if (Math.abs(x.high - p.high) <= 0.1 * a && green(p) && red(x) && priorUp) add('tweezer_top', 'PUT', 60);
    if (lw >= 0.5 * rng && lw >= 0.8 * a) add('long_wick_rejection', 'CALL', 50 + 30 * (lw / rng));
    if (uw >= 0.5 * rng && uw >= 0.8 * a) add('long_wick_rejection', 'PUT', 50 + 30 * (uw / rng));
    if (green(x) && b >= 0.7 * rng && b >= a && uw <= 0.15 * rng) add('strong_body', 'CALL', 50 + 20 * (b / a));
    if (red(x) && b >= 0.7 * rng && b >= a && lw <= 0.15 * rng) add('strong_body', 'PUT', 50 + 20 * (b / a));
    return {
      patterns: out,
      candle: { color: green(x) ? 'G' : red(x) ? 'R' : 'D', bodyAtr: b / a, rangeAtr: rng / a, bodyRatio: b / rng,
        upperWick: uw / rng, lowerWick: lw / rng, closePos: (x.close - x.low) / rng },
      prevRelation: x.high > p.high && x.low < p.low ? 'outside' : x.high < p.high && x.low > p.low ? 'inside'
        : x.close > p.high ? 'closed_above' : x.close < p.low ? 'closed_below' : 'overlap',
    };
  }

  // ── breakout / compression / trendline ─────────────────────────────────────
  function breakoutFeatures(c, a, mom, sw) {
    const n = c.length - 1, box = c.slice(Math.max(0, n - 25), n - 3);
    if (box.length < 10) return { status: null };
    const hi = Math.max(...box.map((x) => x.high)), lo = Math.min(...box.map((x) => x.low));
    const find = (up) => {
      for (let k = n - 3; k <= n; k++) if (up ? c[k].close > hi : c[k].close < lo) return k;
      return -1;
    };
    const ku = find(true), kd = find(false);
    const k = ku >= 0 && (kd < 0 || ku >= kd) ? ku : kd;
    let res = { status: null, rangeHi: hi, rangeLo: lo, rangeAtr: (hi - lo) / a };
    if (k >= 0) {
      const up = k === ku, lvl = up ? hi : lo, bc = c[k], r = range(bc) || 1e-12;
      const after = c.slice(k + 1);
      const backInside = after.some((x) => (up ? x.close < lvl : x.close > lvl));
      const strong = body(bc) >= 0.6 * a && body(bc) / r >= 0.55 && (up ? upperWick(bc) : lowerWick(bc)) <= 0.3 * r;
      const follow = after.length ? after.some((x) => (up ? x.close > bc.close : x.close < bc.close)) : null;
      const retest = after.some((x) => (up ? x.low <= lvl + 0.3 * a && x.close > lvl : x.high >= lvl - 0.3 * a && x.close < lvl));
      const extension = up ? (c[n].close - lvl) / a : (lvl - c[n].close) / a;
      const exhausted = extension > 2.5 || (up ? mom.run.green : mom.run.red) >= 5;
      let status;
      if (backInside) status = 'FALSE_BREAKOUT';
      else if (strong && retest) status = 'BREAKOUT_RETEST';
      else if (strong && follow !== false) status = 'REAL_BREAKOUT';
      else status = 'WEAK_BREAKOUT';
      res = { ...res, status, dir: up ? 'CALL' : 'PUT', level: lvl, ago: n - k, strong, followThrough: follow, retest, exhausted, extension };
    }
    const tail = c.slice(-8), hTail = Math.max(...tail.map((x) => x.high)) - Math.min(...tail.map((x) => x.low));
    res.compression = { is: hTail / a <= 2.5, heightAtr: hTail / a };
    // Trendline through the last two swing highs (falling) or lows (rising).
    res.trendline = null;
    const [h1, h2] = sw.highs.slice(-2), [l1, l2] = sw.lows.slice(-2);
    const lineAt = (p1, p2, i) => p1.price + ((p2.price - p1.price) / (p2.i - p1.i)) * (i - p1.i);
    if (h1 && h2 && h2.price < h1.price) {
      for (const i of [n, n - 1]) if (i > h2.i && c[i].close > lineAt(h1, h2, i) && c[i - 1].close <= lineAt(h1, h2, i - 1)) { res.trendline = { dir: 'CALL', ago: n - i, level: lineAt(h1, h2, n) }; break; }
    }
    if (!res.trendline && l1 && l2 && l2.price > l1.price) {
      for (const i of [n, n - 1]) if (i > l2.i && c[i].close < lineAt(l1, l2, i) && c[i - 1].close >= lineAt(l1, l2, i - 1)) { res.trendline = { dir: 'PUT', ago: n - i, level: lineAt(l1, l2, n) }; break; }
    }
    return res;
  }

  // ── liquidity sweeps ───────────────────────────────────────────────────────
  function liquidityFeatures(c, a, sw) {
    const n = c.length - 1, pool = c.slice(Math.max(0, n - 30), n - 2);
    if (pool.length < 10) return { sweep: null };
    const above = Math.max(...pool.map((x) => x.high)), below = Math.min(...pool.map((x) => x.low));
    const eq = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (Math.abs(arr[i].price - arr[j].price) <= 0.15 * a) return Math.max(arr[i].price, arr[j].price);
      }
      return null;
    };
    const eqHigh = eq(sw.highs.slice(-8)), eqLowRaw = eq(sw.lows.slice(-8).map((x) => ({ ...x, price: -x.price })));
    const eqLow = eqLowRaw == null ? null : -eqLowRaw;
    let sweep = null;
    for (const i of [n, n - 1]) {
      const x = c[i], r = range(x) || 1e-12;
      if (x.low < below && x.close > below) {
        const conf = i === n ? (x.close - x.low) / r >= 0.6 : green(c[n]) && c[n].close > x.close;
        sweep = { dir: 'CALL', level: below, ago: n - i, wick: lowerWick(x) / r, confirmed: conf, equal: eqLow != null && Math.abs(eqLow - below) <= 0.3 * a };
        break;
      }
      if (x.high > above && x.close < above) {
        const conf = i === n ? (x.high - x.close) / r >= 0.6 : red(c[n]) && c[n].close < x.close;
        sweep = { dir: 'PUT', level: above, ago: n - i, wick: upperWick(x) / r, confirmed: conf, equal: eqHigh != null && Math.abs(eqHigh - above) <= 0.3 * a };
        break;
      }
    }
    return { poolAbove: above, poolBelow: below, eqHigh, eqLow, sweep };
  }

  // ── divergence (regular) on the last two confirmed swings, second one recent ──
  function divergenceFeatures(c, I, sw) {
    const n = c.length - 1, out = { rsi: null, macd: null };
    const check = (pts, isLow) => {
      const [p1, p2] = pts.slice(-2);
      if (!p1 || !p2 || n - p2.i > 8 || p2.i - p1.i < 3) return;
      const priceExt = isLow ? p2.price < p1.price : p2.price > p1.price;
      if (!priceExt) return;
      const dir = isLow ? 'CALL' : 'PUT';
      const r1 = I.rsi[p1.i], r2 = I.rsi[p2.i], m1 = I.macd.hist[p1.i], m2 = I.macd.hist[p2.i];
      if (r1 != null && r2 != null && (isLow ? r2 > r1 + 2 : r2 < r1 - 2)) out.rsi = { dir, ago: n - p2.i, from: r1, to: r2 };
      if (m1 != null && m2 != null && (isLow ? m2 > m1 : m2 < m1)) out.macd = { dir, ago: n - p2.i };
    };
    check(sw.lows, true);
    check(sw.highs, false);
    return out;
  }

  // Current ATR relative to its median over the last 100 bars.
  function atrRatio(series, a) {
    const v = series.slice(-100).filter((x) => x != null).sort((x, y) => x - y);
    return v.length >= 20 ? a / v[Math.floor(v.length / 2)] : null;
  }

  function compute(candles, tf, { abnormalRangeAtr = 3 } = {}) {
    const c = candles.slice(-WINDOW);
    const n = c.length - 1;
    if (n < 30) return { ready: false, tf, n: c.length };
    const closes = c.map((x) => x.close);
    const I = {
      ema9: Ind.ema(closes, 9), ema18: Ind.ema(closes, 18), ema21: Ind.ema(closes, 21), ema24: Ind.ema(closes, 24), ema50: Ind.ema(closes, 50), ema200: Ind.ema(closes, 200),
      rsi: Ind.rsi(closes, 14), macd: Ind.macd(closes, 12, 26, 9), stoch: Ind.stochastic(c, 14, 3, 3),
      roc: Ind.roc(closes, 9), atr: Ind.atr(c, 14), adx: Ind.adx(c, 14), bb: Ind.bollinger(closes, 20, 2),
      ema20: Ind.ema(closes, 20), atr10: Ind.atr(c, 10),
    };
    const a = I.atr[n - 1] || I.atr[n];
    if (!a) return { ready: false, tf, n: c.length };
    const trend = trendFeatures(c, I, a);
    const momentum = momentumFeatures(c, I, a, trend);
    const structure = structureFeatures(c, a);
    const atrPct = U.pctRank(I.atr, 100);
    const lastRange = range(c[n]) / a;
    const out = {
      ready: true, tf, n: c.length, time: c[n].time, price: c[n].close, atr: a, last: c[n], partialLast: !!c[n].partial,
      trend, momentum, structure,
      bb: bollingerFeatures(c, I),
      levels: levelFeatures(c, a, structure.swings, tf),
      fib: fibFeatures(c, a),
      pa: priceAction(c, a),
      breakout: breakoutFeatures(c, a, momentum, structure.swings),
      liquidity: liquidityFeatures(c, a, structure.swings),
      divergence: divergenceFeatures(c, I, structure.swings),
      volatility: { atrPct, lastRange, abnormal: lastRange > abnormalRangeAtr, atrRatio: atrRatio(I.atr, a),
        state: atrPct == null ? 'UNKNOWN' : atrPct >= 90 ? 'HIGH' : atrPct <= 10 ? 'LOW' : 'NORMAL' },
      recent: c.slice(-30).map((x) => [x.time, x.open, x.high, x.low, x.close]),
      // Keltner channel (EMA 20 ± 2 × ATR 10), the last 6 candles, oldest first
      keltner: keltnerTail(I, n, 6),
    };
    Object.defineProperty(out, 'candles', { value: c, enumerable: false });
    return out;
  }

  function keltnerTail(I, n, k) {
    const out = { mid: [], up: [], lo: [] };
    for (let j = n - k + 1; j <= n; j++) { const m = I.ema20[j], at = I.atr10[j]; if (m == null || at == null) return null; out.mid.push(m); out.up.push(m + 2 * at); out.lo.push(m - 2 * at); }
    return out;
  }

  OTC.Features = { compute, swings, psychStep, FIB };
})(typeof globalThis !== 'undefined' ? globalThis : this);
