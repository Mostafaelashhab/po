// YouTube strategies (2026-10-04): the rules from the videos the user sent, coded as explained and backtested on
// the user's data (all landed between 44% and 53%; break-even at 92% payout is 52.08%). They are hidden from the
// normal engine (they never vote in its consensus) and run only in the panel mode "استراتيجيات يوتيوب", each on
// the candle frame and with the trade duration its video gives (durations snapped to PO's presets). As every
// entry, a real account trades one only once its own measured record is positive and stable.
(function (G) {
  const OTC = G.OTC, { define, H } = OTC.Strategies, { R } = H;

  // ── indicators on the candle window (arrays aligned with the candles) ──────
  const closes = (cs) => cs.map((c) => c.close);
  const sma = (x, n) => { const out = new Array(x.length).fill(null); let s = 0, k = 0; for (let i = 0; i < x.length; i++) { if (x[i] == null) { s = 0; k = 0; continue; } s += x[i]; k++; if (k > n) { s -= x[i - n]; k = n; } if (k === n) out[i] = s / n; } return out; };
  const ema = (x, n) => { const a = 2 / (n + 1), out = []; let e = null; const seed = []; for (const v of x) { if (v == null) { out.push(null); continue; } if (e == null) { seed.push(v); if (seed.length === n) e = seed.reduce((p, q) => p + q, 0) / n; out.push(e); continue; } e = a * v + (1 - a) * e; out.push(e); } return out; };
  const wma = (x, n) => x.map((_, i) => { if (i < n - 1) return null; let s = 0, w = 0; for (let k = 0; k < n; k++) { const v = x[i - n + 1 + k]; if (v == null) return null; s += v * (k + 1); w += k + 1; } return s / w; });
  const smma = (x, n) => { const out = []; let s = null; const seed = []; for (const v of x) { if (v == null) { out.push(null); continue; } if (s == null) { seed.push(v); if (seed.length === n) s = seed.reduce((p, q) => p + q, 0) / n; out.push(s); continue; } s = (s * (n - 1) + v) / n; out.push(s); } return out; };
  const dema = (x, n) => { const e1 = ema(x, n), e2 = ema(e1, n); return e1.map((v, i) => (v == null || e2[i] == null ? null : 2 * v - e2[i])); };
  const rsi = (cs, n) => { const out = [null]; let ag = 0, al = 0; for (let i = 1; i < cs.length; i++) { const d = cs[i].close - cs[i - 1].close, g = Math.max(d, 0), l = Math.max(-d, 0); if (i <= n) { ag += g / n; al += l / n; out.push(i === n ? (al ? 100 - 100 / (1 + ag / al) : 100) : null); continue; } ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n; out.push(al ? 100 - 100 / (1 + ag / al) : 100); } return out; };
  const atr = (cs, n) => smma(cs.map((c, i) => (i ? Math.max(c.high - c.low, Math.abs(c.high - cs[i - 1].close), Math.abs(c.low - cs[i - 1].close)) : c.high - c.low)), n);
  const stdev = (x, n) => x.map((_, i) => { if (i < n - 1) return null; let s = 0, s2 = 0; for (let k = i - n + 1; k <= i; k++) { s += x[k]; s2 += x[k] * x[k]; } const m = s / n; return Math.sqrt(Math.max(0, s2 / n - m * m)); });
  const macd = (cs, f, sl, g) => { const c = closes(cs), a = ema(c, f), b = ema(c, sl), m = a.map((v, i) => (v == null || b[i] == null ? null : v - b[i])); return { m, sig: ema(m, g) }; };
  const range = (cs, i, n) => { let hi = -Infinity, lo = Infinity; for (let k = i - n + 1; k <= i; k++) { hi = Math.max(hi, cs[k].high); lo = Math.min(lo, cs[k].low); } return [hi, lo]; };
  const stochRaw = (cs, n) => cs.map((_, i) => { if (i < n - 1) return null; const [hi, lo] = range(cs, i, n); return hi === lo ? 50 : (100 * (cs[i].close - lo)) / (hi - lo); });
  const williams = (cs, n) => cs.map((_, i) => { if (i < n - 1) return null; const [hi, lo] = range(cs, i, n); return hi === lo ? -50 : (-100 * (hi - cs[i].close)) / (hi - lo); });
  const cci = (cs, n) => { const tp = cs.map((c) => (c.high + c.low + c.close) / 3), m = sma(tp, n); return tp.map((v, i) => { if (m[i] == null) return null; let md = 0; for (let k = i - n + 1; k <= i; k++) md += Math.abs(tp[k] - m[i]); md /= n; return md ? (v - m[i]) / (0.015 * md) : 0; }); };
  const aroon = (cs, n) => { const up = [], dn = []; for (let i = 0; i < cs.length; i++) { if (i < n) { up.push(null); dn.push(null); continue; } let hi = -Infinity, lo = Infinity, ha = i, la = i; for (let k = i - n; k <= i; k++) { if (cs[k].high >= hi) { hi = cs[k].high; ha = k; } if (cs[k].low <= lo) { lo = cs[k].low; la = k; } } up.push((100 * (n - (i - ha))) / n); dn.push((100 * (n - (i - la))) / n); } return { up, dn }; };
  const supertrend = (cs, n, mult) => { const at = atr(cs, n), dir = [], line = []; let up = null, dn = null, d = 1; for (let i = 0; i < cs.length; i++) { if (at[i] == null) { dir.push(null); line.push(null); continue; } const hl = (cs[i].high + cs[i].low) / 2; let bu = hl - mult * at[i], bd = hl + mult * at[i]; if (up != null && cs[i - 1].close > up) bu = Math.max(bu, up); if (dn != null && cs[i - 1].close < dn) bd = Math.min(bd, dn); if (dn != null && cs[i].close > dn) d = 1; else if (up != null && cs[i].close < up) d = -1; up = bu; dn = bd; dir.push(d); line.push(d > 0 ? up : dn); } return { dir, line }; };
  const psar = (cs) => { const out = [null]; let up = true, sar = cs[0].low, ep = cs[0].high, af = 0.02; for (let i = 1; i < cs.length; i++) { sar += af * (ep - sar); if (up) { sar = Math.min(sar, cs[i - 1].low, cs[Math.max(0, i - 2)].low); if (cs[i].low < sar) { up = false; sar = ep; ep = cs[i].low; af = 0.02; } else if (cs[i].high > ep) { ep = cs[i].high; af = Math.min(0.2, af + 0.02); } } else { sar = Math.max(sar, cs[i - 1].high, cs[Math.max(0, i - 2)].high); if (cs[i].high > sar) { up = true; sar = ep; ep = cs[i].high; af = 0.02; } else if (cs[i].low < ep) { ep = cs[i].low; af = Math.min(0.2, af + 0.02); } } out.push({ up }); } return out; };
  const col = (c) => Math.sign(c.close - c.open);
  const xUp = (a, b, i) => a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i] > b[i] && a[i - 1] <= b[i - 1];
  const xDn = (a, b, i) => a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i] < b[i] && a[i - 1] >= b[i - 1];

  // ── the rules: each returns +1 (CALL), −1 (PUT) or 0 at the last closed candle i ──
  const RULES = [
    { id: 'yt_alligator_rsi', name: 'التمساح + RSI', frame: 30, expirySec: 60, src: 'علاء أيمن', rule: (cs, i) => {
      const hl = cs.map((c) => (c.high + c.low) / 2), j = smma(hl, 10), l = smma(hl, 3), jaw = (k) => j[k - 5], lips = (k) => l[k - 1], r = rsi(cs, 10);
      if (i < 20 || jaw(i - 2) == null || r[i] == null) return 0;
      const s = (k) => Math.sign(lips(k) - jaw(k)), d = s(i);
      const crossed = d && s(i - 1) === d && s(i - 2) === -d, separating = Math.abs(lips(i) - jaw(i)) > Math.abs(lips(i - 1) - jaw(i - 1));
      return crossed && separating && (d > 0 ? r[i] > 50 : r[i] < 50) ? d : 0; } },
    { id: 'yt_ema_21_50_200', name: 'المتوسطات 21/50/200 "85%"', frame: 60, expirySec: 180, src: 'علاء أيمن', rule: (cs, i) => {
      const c = closes(cs), a = ema(c, 21), b = ema(c, 50), z = ema(c, 200);
      if (z[i] == null) return 0; const d = xUp(a, b, i) ? 1 : xDn(a, b, i) ? -1 : 0;
      return d && Math.sign(cs[i].close - z[i]) === d ? d : 0; } },
    { id: 'yt_wma_stoch_macd', name: 'WMA 52 + ستوكاستك + ماكد (شراء)', frame: 15, expirySec: 60, src: 'علاء أيمن', rule: (cs, i) => {
      const c = closes(cs), w = wma(c, 52), k = wma(stochRaw(cs, 11), 4), d = wma(k, 4), m = macd(cs, 11, 23, 10);
      if (w[i - 3] == null || d[i] == null || m.sig[i] == null) return 0;
      const green = [0, 1, 2, 3].filter((q) => col(cs[i - q]) > 0).length >= 3;
      return w[i] < Math.min(cs[i].low, cs[i].close) && w[i] > w[i - 3] && k[i] > d[i] && d[i] > 20 && k[i] > k[i - 1] && m.m[i] > m.sig[i] && green ? 1 : 0; } },
    { id: 'yt_bollinger_supertrend', name: 'بولينجر + سوبرترند', frame: 15, expirySec: 60, src: 'علاء أيمن', rule: (cs, i) => {
      const c = closes(cs), m = sma(c, 11), s = stdev(c, 11), st = supertrend(cs, 2, 2);
      if (m[i] == null || st.dir[i] == null) return 0; const t = col(cs[i]);
      if (!t || col(cs[i - 1]) !== t || col(cs[i - 2]) !== t || st.dir[i] !== t) return 0;
      const up = m[i] + 3 * s[i], lo = m[i] - 3 * s[i], w = up - lo || 1e-12, dist = t > 0 ? (up - cs[i].close) / w : (cs[i].close - lo) / w;
      return (t > 0 ? cs[i].close > st.line[i] : cs[i].close < st.line[i]) && dist <= 0.2 ? t : 0; } },
    { id: 'yt_macd_zero', name: 'سر الماكد (تقاطع عكس خط الصفر)', frame: 15, expirySec: 60, src: 'Joker Trading', rule: (cs, i) => {
      const { m, sig } = macd(cs, 12, 26, 9);
      return xUp(m, sig, i) && m[i] < 0 && sig[i] < 0 ? 1 : xDn(m, sig, i) && m[i] > 0 && sig[i] > 0 ? -1 : 0; } },
    { id: 'yt_cci_psar', name: 'CCI + بارابوليك', frame: 60, expirySec: 180, src: 'Joker Trading', rule: (cs, i) => {
      const c = cci(cs, 20), p = psar(cs); if (c[i - 1] == null || !p[i]) return 0;
      return c[i] > 100 && c[i - 1] <= 100 && p[i].up ? 1 : c[i] < -100 && c[i - 1] >= -100 && !p[i].up ? -1 : 0; } },
    { id: 'yt_sma_stoch', name: 'متوسط 20/100 + ستوكاستك 5', frame: 30, expirySec: 180, src: 'Joker Trading', rule: (cs, i) => {
      const c = closes(cs), a = sma(c, 20), b = sma(c, 100), k = sma(stochRaw(cs, 5), 3);
      if (b[i] == null || k[i - 1] == null) return 0; const tr = Math.sign(a[i] - b[i]);
      return tr < 0 && k[i - 1] >= 80 && k[i] < 80 ? -1 : tr > 0 && k[i - 1] <= 20 && k[i] > 20 ? 1 : 0; } },
    { id: 'yt_supertrend_5s', name: 'سوبرترند على 5 ثوانٍ', frame: 5, expirySec: 15, src: 'مختبر التداول', rule: (cs, i) => {
      const st = supertrend(cs, 10, 3); return st.dir[i - 1] != null && st.dir[i] !== st.dir[i - 1] ? st.dir[i] : 0; } },
    { id: 'yt_fractal_ema', name: 'فراكتل + EMA 25/50', frame: 30, expirySec: 60, src: 'مختبر التداول', rule: (cs, i) => {
      const c = closes(cs), a = ema(c, 25), b = ema(c, 50); if (b[i - 5] == null || i < 6) return 0;
      const tr = Math.sign(a[i] - b[i]), touched = [0, 1, 2, 3, 4].some((q) => (tr > 0 ? cs[i - q].low <= a[i - q] : cs[i - q].high >= a[i - q])), m = i - 2;
      const fr = tr > 0 ? [m - 2, m - 1, m + 1, m + 2].every((k) => cs[m].low < cs[k].low) : [m - 2, m - 1, m + 1, m + 2].every((k) => cs[m].high > cs[k].high);
      return tr && touched && fr ? tr : 0; } },
    { id: 'yt_aroon_keltner', name: 'آرون + كيلتنر', frame: 30, expirySec: 60, src: 'مختبر التداول', rule: (cs, i) => {
      const mid = ema(closes(cs), 20), at = atr(cs, 10), a = aroon(cs, 5); if (mid[i - 6] == null || at[i - 6] == null || a.up[i - 1] == null) return 0;
      const up = (k) => mid[k] + 2 * at[k], lo = (k) => mid[k] - 2 * at[k];
      const d = a.up[i] > a.dn[i] && a.up[i - 1] <= a.dn[i - 1] ? 1 : a.dn[i] > a.up[i] && a.dn[i - 1] <= a.up[i - 1] ? -1 : 0; if (!d) return 0;
      for (let j = i; j >= i - 5; j--) { const touch = d > 0 ? cs[j].low <= lo(j) && cs[j].close > lo(j) : cs[j].high >= up(j) && cs[j].close < up(j);
        if (touch) { for (let q = j; q <= i; q++) if (cs[q].close > up(q) || cs[q].close < lo(q)) return 0; return d; } }
      return 0; } },
    { id: 'yt_stoch_cross', name: 'ستوكاستك عند 20/80', frame: 15, expirySec: 15, src: 'Трейдинг легко', rule: (cs, i) => {
      const k = sma(stochRaw(cs, 14), 3), d = sma(k, 3); if (d[i - 1] == null) return 0;
      return xUp(k, d, i) && Math.min(k[i - 1], d[i - 1]) <= 20 ? 1 : xDn(k, d, i) && Math.max(k[i - 1], d[i - 1]) >= 80 ? -1 : 0; } },
    { id: 'yt_supertrend_rsi', name: 'سوبرترند + RSI', frame: 60, expirySec: 300, src: 'Crypto Club', rule: (cs, i) => {
      const st = supertrend(cs, 10, 3), r = rsi(cs, 14); if (st.dir[i - 1] == null || r[i - 1] == null) return 0;
      const f = st.dir[i] !== st.dir[i - 1] ? st.dir[i] : 0;
      return f > 0 && r[i] > 50 && r[i] > r[i - 1] && r[i] < 70 ? 1 : f < 0 && r[i] <= 50 && r[i] < r[i - 1] && r[i] > 30 ? -1 : 0; } },
    { id: 'yt_green_line', name: 'الخط الأخضر', frame: 60, expirySec: 60, src: 'Mr Candlestick', rule: (cs, i) => {
      const c = closes(cs), g = ema(c, 20), r = ema(c, 50), m = sma(c, 20), s = stdev(c, 20), md = macd(cs, 12, 26, 9);
      if (r[i - 6] == null || m[i - 3] == null || md.sig[i - 1] == null) return 0; const d = Math.sign(g[i] - r[i]); if (!d) return 0;
      const side = [1, 2, 3, 4, 5].every((q) => (d > 0 ? cs[i - q].close > g[i - q] : cs[i - q].close < g[i - q]));
      const touch = d > 0 ? cs[i].low <= g[i] && cs[i].close > g[i] : cs[i].high >= g[i] && cs[i].close < g[i];
      const wide = s[i] > s[i - 3], hist = md.m[i] - md.sig[i], mac = d > 0 ? md.m[i] > md.m[i - 1] && hist > 0 : md.m[i] < md.m[i - 1] && hist < 0;
      return side && touch && wide && mac ? d : 0; } },
    { id: 'yt_katie_dema', name: 'DEMA 20/51 + ستوكاستك', frame: 15, expirySec: 60, src: 'Katie Tutorials', rule: (cs, i) => {
      const c = closes(cs), a = dema(c, 20), b = dema(c, 51), k = dema(stochRaw(cs, 14), 3), d = dema(k, 3); if (b[i - 4] == null || d[i] == null) return 0;
      const x = [0, 1, 2].map((q) => (xUp(a, b, i - q) ? 1 : xDn(a, b, i - q) ? -1 : 0)).find((v) => v) || 0; if (!x) return 0;
      const slope = Math.sign(a[i] - a[i - 1]) === x && Math.sign(b[i] - b[i - 1]) === x, ext = x > 0 ? k[i] > 80 && d[i] > 80 : k[i] < 20 && d[i] < 20;
      const steady = [0, 1, 2, 3, 4, 5, 6, 7].filter((q) => col(cs[i - q]) === x).length >= 6;
      return slope && ext && steady ? x : 0; } },
    { id: 'yt_three_candles', name: 'ثلاث شموع ← عكسها', frame: 60, expirySec: 60, src: 'مختبر التداول', rule: (cs, i) => {
      const c = col(cs[i]); return i > 3 && c && col(cs[i - 1]) === c && col(cs[i - 2]) === c && col(cs[i - 3]) === -c ? -c : 0; } },
    { id: 'yt_ichimoku_williams', name: 'إيشيموكو + وليامز (بيع)', frame: 60, expirySec: 60, src: 'علاء أيمن', rule: (cs, i) => {
      const mid = (k, n) => { const [hi, lo] = range(cs, k, n); return (hi + lo) / 2; }, D = 26;
      if (i < 20 + D + 3) return 0; const A = (k) => (mid(k, 5) + mid(k, 10)) / 2, B = (k) => mid(k, 20), w = williams(cs, 9);
      const bot = Math.min(A(i - D), B(i - D)), below = cs[i].close < bot, wr = w[i - 1] >= -80 && w[i] < -80;
      const twist = [0, 1, 2].some((k) => A(i - k) < B(i - k) && A(i - k - 1) >= B(i - k - 1));
      return (below ? 1 : 0) + (wr ? 1 : 0) + (twist ? 1 : 0) >= 2 ? -1 : 0; } },
    { id: 'yt_williams_macd', name: 'وليامز + ماكد', frame: 60, expirySec: 60, src: 'مختبر التداول', rule: (cs, i) => {
      const md = macd(cs, 12, 26, 9), w = williams(cs, 14); if (md.sig[i - 1] == null || w[i - 1] == null) return 0; const dw = w[i] - w[i - 1];
      return xUp(md.m, md.sig, i) && col(cs[i]) > 0 && dw >= 10 && w[i] < -10 ? 1 : xDn(md.m, md.sig, i) && col(cs[i]) < 0 && dw <= -10 && w[i] > -90 ? -1 : 0; } },
    // Alaa Ayman, "ماتوقعت النتيجة" (xZKfTBi-gWc): 1-minute candles, 2-minute trades. Accelerator Oscillator (5, 10, 5):
    // a green bar = buying pressure, red = selling; CCI 10 at +100 / −100 = strong buying / selling; Envelopes (12,
    // 0.05 %, WMA): the lower line is the support for a buy, the upper the resistance for a sell — the candle well
    // clear of it and the line climbing / falling, never flat ("لما يكون أفقي لا تفتح صفقة"). Signals when all three
    // line up (the first candle they do).
    { id: 'yt_ac_cci_envelopes', name: 'AC + CCI + الأظرف', frame: 60, expirySec: 120, src: 'علاء أيمن', rule: (cs, i) => {
      const hl = cs.map((c) => (c.high + c.low) / 2), f = sma(hl, 5), sl = sma(hl, 10), ao = f.map((v, k) => (v == null || sl[k] == null ? null : v - sl[k]));
      const s5 = sma(ao, 5), ac = ao.map((v, k) => (v == null || s5[k] == null ? null : v - s5[k])), cc = cci(cs, 10), w = wma(closes(cs), 12), at = atr(cs, 10);
      const at3 = (k) => { if (ac[k - 1] == null || cc[k] == null || w[k - 3] == null || !at[k]) return 0; const slope = (w[k] - w[k - 3]) / at[k], lo = w[k] * (1 - 0.0005), hi = w[k] * (1 + 0.0005);
        if (ac[k] > ac[k - 1] && cc[k] >= 100 && slope >= 0.3 && cs[k].low > lo) return 1;
        if (ac[k] < ac[k - 1] && cc[k] <= -100 && slope <= -0.3 && cs[k].high < hi) return -1;
        return 0; };
      const d = at3(i); return d && at3(i - 1) !== d ? d : 0; } },
    // Two tuned versions (2026-10-04: 921 variants of the best strategies, chosen on the older 60 % of the stored candles
    // and checked on the newer 40 %): the only two that held up on both parts. Live under a guard (cfg.soloGuard):
    // switched off after 4 losses in a row, or below break-even after 20 real trades.
    { id: 'yt_5candles_rev30', name: '5 شموع ← عكسها (30ث)', frame: 30, expirySec: 120, src: 'تطوير من «ثلاث شموع» (قديم 52.4% / جديد 53.2%)', rule: (cs, i) => {
      const c = col(cs[i]); if (!c || i < 6) return 0;
      for (let q = 1; q < 5; q++) if (col(cs[i - q]) !== c) return 0;
      return col(cs[i - 5]) === -c ? -c : 0; } },
    { id: 'yt_ichimoku_williams_5m', name: 'إيشيموكو + وليامز 5د (بيع)', frame: 300, expirySec: 600, src: 'تطوير من «إيشيموكو + وليامز» (قديم 53.4% / جديد 54.1%)', rule: (cs, i) => RULES.find((r) => r.id === 'yt_ichimoku_williams').rule(cs, i) },
    // Zahir, «أكاديمية الأسواق المالية» (09z53UBZyzs, 2026-10-05): trade only the way the market's local trend goes; on
    // 5-second candles sell when RSI 14 comes back under 70 or MACD 12/26/9 crosses under its signal line (buy: RSI back
    // over 30 / MACD crossing over). His trades closed seconds after entry → 15 s. The trend here = the direction of
    // the last 12 minutes. Backtest on the stored 5 s candles (2026-10-03..04, 106 pairs, no overlapping trades):
    // 15 s 50.0 % (19,872) older / 50.3 % (2,380) newer; 1 min 50.1 / 50.5; 5 min 50.5 / 52.3. On trial (cfg.soloGuard).
    { id: 'yt_rsi_macd_trend', name: 'RSI + MACD مع الاتجاه', frame: 5, expirySec: 15, src: 'زاهر — أكاديمية الأسواق المالية', rule: (cs, i) => {
      if (i < 160) return 0;
      const c = closes(cs), r = rsi(cs, 14), { m, sig } = macd(cs, 12, 26, 9), trend = Math.sign(c[i] - c[i - 144]);
      if (!trend || r[i] == null || r[i - 1] == null) return 0;
      const sell = (r[i - 1] >= 70 && r[i] < 70) || xDn(m, sig, i), buy = (r[i - 1] <= 30 && r[i] > 30) || xUp(m, sig, i);
      const d = sell && !buy ? -1 : buy && !sell ? 1 : 0;
      return d === trend ? d : 0; } },
    // Zahir, «Stochastic مع التحليل الفني» (HynsKcn9nr4): only the local trend's way, never in a sideways market; on 5 s
    // candles, Stochastic 14/3/3: sell when the blue line (%K) crosses under the orange (%D) above 80, buy when it crosses
    // over below 20; 1-minute trades. Trend = the last 12 minutes' direction, "not sideways" = that move is at least 15 %
    // of the path the price travelled. Backtest (same data): 1 min 49.5 % (1,469) older / 58.8 % (165) newer; 5 min
    // 51.1 / 60.7 — the newer part too small to trust; without the sideways filter 49.6 / 49.6. On trial.
    { id: 'yt_stoch_trend', name: 'ستوكاستك مع الاتجاه', frame: 5, expirySec: 60, src: 'زاهر — أكاديمية الأسواق المالية', rule: (cs, i) => {
      if (i < 150) return 0;
      const c = closes(cs), K = sma(stochRaw(cs, 14), 3), D = sma(K, 3), trend = Math.sign(c[i] - c[i - 144]);
      if (!trend || K[i] == null || D[i] == null || K[i - 1] == null || D[i - 1] == null) return 0;
      let path = 0; for (let k = i - 143; k <= i; k++) path += Math.abs(c[k] - c[k - 1]);
      if (!path || Math.abs(c[i] - c[i - 144]) / path < 0.15) return 0; // back and forth: no trade
      const d = K[i - 1] >= D[i - 1] && K[i] < D[i] && K[i - 1] > 80 ? -1 : K[i - 1] <= D[i - 1] && K[i] > D[i] && K[i - 1] < 20 ? 1 : 0;
      return d === trend ? d : 0; } },
    // Zahir, «التحليل الفني» (2_gR3uXFseE): when the trend goes the same way near and far, buy (sell) on the pullback —
    // "at the lowest price" — 1-minute trades. Here: the last 12 minutes and the last ~17 agree, and the third 5 s candle
    // in a row goes against them. Backtest: 1 min 50.0 % (14,351) older / 50.5 % (1,574) newer. On trial.
    { id: 'yt_pullback_trend', name: 'الدخول في التراجع مع الاتجاه', frame: 5, expirySec: 60, src: 'زاهر — أكاديمية الأسواق المالية', rule: (cs, i) => {
      if (i < 199) return 0;
      const L = Math.sign(cs[i].close - cs[i - 144].close), G = Math.sign(cs[i].close - cs[i - 199].close);
      if (!L || L !== G) return 0;
      return col(cs[i]) === -L && col(cs[i - 1]) === -L && col(cs[i - 2]) === -L && col(cs[i - 3]) !== -L ? L : 0; } },
  ];

  // ── Pocket Option's own channel ("Day Trading Strategies" playlist, 35 videos): the indicator settings and signals
  // as each video gives them. The videos say "quick trades starting at 5 seconds" without a candle size or a
  // duration: they run on 15-second candles with 1-minute trades.
  const PO = { frame: 15, expirySec: 60, src: 'Pocket Option' };
  const dmi = (cs, n) => { const pdm = [0], ndm = [0], tr = [0]; for (let i = 1; i < cs.length; i++) { const u = cs[i].high - cs[i - 1].high, d = cs[i - 1].low - cs[i].low; pdm.push(u > d && u > 0 ? u : 0); ndm.push(d > u && d > 0 ? d : 0); tr.push(Math.max(cs[i].high - cs[i].low, Math.abs(cs[i].high - cs[i - 1].close), Math.abs(cs[i].low - cs[i - 1].close))); }
    const P = smma(pdm, n), N = smma(ndm, n), T = smma(tr, n), pdi = P.map((v, i) => (v == null || !T[i] ? null : (100 * v) / T[i])), ndi = N.map((v, i) => (v == null || !T[i] ? null : (100 * v) / T[i]));
    const dx = pdi.map((v, i) => (v == null || ndi[i] == null || v + ndi[i] === 0 ? null : (100 * Math.abs(v - ndi[i])) / (v + ndi[i]))); return { pdi, ndi, adx: smma(dx, n) }; };
  const fractalAt = (cs, m, k, hi) => { if (m - k < 0 || m + k >= cs.length) return false; for (let j = 1; j <= k; j++) { if (hi ? !(cs[m].high > cs[m - j].high && cs[m].high > cs[m + j].high) : !(cs[m].low < cs[m - j].low && cs[m].low < cs[m + j].low)) return false; } return true; };
  const ao = (cs) => { const hl = cs.map((c) => (c.high + c.low) / 2), a = sma(hl, 5), b = sma(hl, 34); return a.map((v, i) => (v == null || b[i] == null ? null : v - b[i])); };
  const cross = (x, lvl, i) => (x[i] != null && x[i - 1] != null ? (x[i] > lvl && x[i - 1] <= lvl ? 1 : x[i] < lvl && x[i - 1] >= lvl ? -1 : 0) : 0);
  const swing = (cs, i, n) => range(cs, i - 1, n); // the high / low of the n candles before i
  const PO_RULES = [
    { id: 'po_sma_3_5', name: 'متوسطين 3 و5', rule: (cs, i) => { const c = closes(cs), a = sma(c, 3), b = sma(c, 5); return xUp(a, b, i) ? 1 : xDn(a, b, i) ? -1 : 0; } },
    { id: 'po_rsi_7', name: 'RSI 7 (70/30)', rule: (cs, i) => { const r = rsi(cs, 7); return r[i - 1] != null && r[i] > 70 && r[i - 1] <= 70 ? 1 : r[i - 1] != null && r[i] < 30 && r[i - 1] >= 30 ? -1 : 0; } },
    { id: 'po_macd_5_13_4', name: 'ماكد 5/13/4', rule: (cs, i) => { const { m, sig } = macd(cs, 5, 13, 4); return xUp(m, sig, i) ? 1 : xDn(m, sig, i) ? -1 : 0; } },
    { id: 'po_stoch_5_3_3', name: 'ستوكاستك 5/3/3', rule: (cs, i) => { const k = sma(stochRaw(cs, 5), 3), d = sma(k, 3); return xUp(k, d, i) ? 1 : xDn(k, d, i) ? -1 : 0; } },
    { id: 'po_psar', name: 'بارابوليك SAR', rule: (cs, i) => { const p = psar(cs); return p[i] && p[i - 1] && p[i].up !== p[i - 1].up ? (p[i].up ? 1 : -1) : 0; } },
    { id: 'po_bollinger', name: 'بولينجر 20/2 (ارتداد)', rule: (cs, i) => { const c = closes(cs), m = sma(c, 20), s = stdev(c, 20); if (m[i - 1] == null) return 0; const lo = (k) => m[k] - 2 * s[k], up = (k) => m[k] + 2 * s[k];
      return cs[i - 1].low <= lo(i - 1) && cs[i].close > cs[i - 1].close && cs[i].close > lo(i) ? 1 : cs[i - 1].high >= up(i - 1) && cs[i].close < cs[i - 1].close && cs[i].close < up(i) ? -1 : 0; } },
    { id: 'po_adx', name: 'ADX (DI 5)', rule: (cs, i) => { const { pdi, ndi, adx } = dmi(cs, 5); if (adx[i] == null || adx[i] < 25) return 0; return xUp(pdi, ndi, i) ? 1 : xDn(pdi, ndi, i) ? -1 : 0; } },
    { id: 'po_alligator', name: 'التمساح 13/8/5', rule: (cs, i) => { const hl = cs.map((c) => (c.high + c.low) / 2), J = smma(hl, 13), T = smma(hl, 8), L = smma(hl, 5), j = (k) => J[k - 8], t = (k) => T[k - 5], l = (k) => L[k - 3];
      if (i < 25 || j(i - 1) == null) return 0; const above = (k) => l(k) > j(k) && l(k) > t(k), below = (k) => l(k) < j(k) && l(k) < t(k);
      return above(i) && !above(i - 1) ? 1 : below(i) && !below(i - 1) ? -1 : 0; } },
    { id: 'po_zigzag', name: 'زيج زاج', rule: (cs, i) => (i < 3 ? 0 : cs[i - 1].low < cs[i - 2].low && cs[i].low > cs[i - 1].low && cs[i].close > cs[i - 1].high ? 1 : cs[i - 1].high > cs[i - 2].high && cs[i].high < cs[i - 1].high && cs[i].close < cs[i - 1].low ? -1 : 0) },
    { id: 'po_osma', name: 'OsMA 12/26/9', rule: (cs, i) => { const { m, sig } = macd(cs, 12, 26, 9), h = m.map((v, k) => (v == null || sig[k] == null ? null : v - sig[k])); return cross(h, 0, i); } },
    { id: 'po_cci_14', name: 'CCI 14 (±100)', rule: (cs, i) => { const c = cci(cs, 14); return c[i - 1] != null && c[i] < -100 && c[i - 1] >= -100 ? 1 : c[i - 1] != null && c[i] > 100 && c[i - 1] <= 100 ? -1 : 0; } },
    { id: 'po_momentum', name: 'الزخم 10 (مستوى 100)', rule: (cs, i) => { const mo = cs.map((c, k) => (k >= 10 ? (100 * c.close) / cs[k - 10].close : null)); return cross(mo, 100, i); } },
    { id: 'po_vortex', name: 'فورتكس 14', rule: (cs, i) => { const n = 14; if (i < n + 2) return 0; const vi = (k) => { let p = 0, m = 0, t = 0; for (let q = k - n + 1; q <= k; q++) { p += Math.abs(cs[q].high - cs[q - 1].low); m += Math.abs(cs[q].low - cs[q - 1].high); t += Math.max(cs[q].high - cs[q].low, Math.abs(cs[q].high - cs[q - 1].close), Math.abs(cs[q].low - cs[q - 1].close)); } return [p / t, m / t]; };
      const [a1, b1] = vi(i), [a0, b0] = vi(i - 1); return a1 > b1 && a0 <= b0 ? 1 : a1 < b1 && a0 >= b0 ? -1 : 0; } },
    { id: 'po_envelopes', name: 'الأظرف 14', rule: (cs, i) => { const m = sma(closes(cs), 14); if (m[i - 1] == null) return 0; return cs[i].close > m[i] && cs[i - 1].close <= m[i - 1] ? 1 : cs[i].close < m[i] && cs[i - 1].close >= m[i - 1] ? -1 : 0; } },
    { id: 'po_roc', name: 'ROC 7', rule: (cs, i) => cross(cs.map((c, k) => (k >= 7 ? (100 * (c.close - cs[k - 7].close)) / cs[k - 7].close : null)), 0, i) },
    { id: 'po_accelerator', name: 'Accelerator (AC)', rule: (cs, i) => { const a = ao(cs), s5 = sma(a, 5), ac = a.map((v, k) => (v == null || s5[k] == null ? null : v - s5[k])); if (ac[i - 2] == null) return 0;
      const g = (k) => ac[k] > ac[k - 1]; return g(i) && !g(i - 1) ? 1 : !g(i) && g(i - 1) ? -1 : 0; } },
    { id: 'po_supertrend', name: 'سوبرترند 10/3', rule: (cs, i) => { const st = supertrend(cs, 10, 3); return st.dir[i - 1] != null && st.dir[i] !== st.dir[i - 1] ? st.dir[i] : 0; } },
    { id: 'po_fractal', name: 'فراكتل (كسر المستوى)', rule: (cs, i) => { for (let m = i - 3; m >= i - 8; m--) { if (fractalAt(cs, m, 2, true) && cs[i].close > cs[m].high && cs[i - 1].close <= cs[m].high) return 1; if (fractalAt(cs, m, 2, false) && cs[i].close < cs[m].low && cs[i - 1].close >= cs[m].low) return -1; } return 0; } },
    { id: 'po_awesome', name: 'Awesome Oscillator', rule: (cs, i) => cross(ao(cs), 0, i) },
    { id: 'po_aroon_14', name: 'آرون 14', rule: (cs, i) => { const a = aroon(cs, 14); if (a.up[i - 1] == null) return 0; return a.up[i] > a.dn[i] && a.up[i - 1] <= a.dn[i - 1] ? 1 : a.dn[i] > a.up[i] && a.dn[i - 1] <= a.up[i - 1] ? -1 : 0; } },
    { id: 'po_keltner', name: 'قناة كيلتنر (ارتداد)', rule: (cs, i) => { const mid = ema(closes(cs), 20), at = atr(cs, 10); if (mid[i - 1] == null || at[i - 1] == null) return 0; const lo = (k) => mid[k] - 2 * at[k], up = (k) => mid[k] + 2 * at[k];
      return cs[i - 1].low <= lo(i - 1) && cs[i].close > cs[i - 1].close ? 1 : cs[i - 1].high >= up(i - 1) && cs[i].close < cs[i - 1].close ? -1 : 0; } },
    { id: 'po_bulls_power', name: 'Bulls Power 13', rule: (cs, i) => { const e = ema(closes(cs), 13); return cross(cs.map((c, k) => (e[k] == null ? null : c.high - e[k])), 0, i); } },
    { id: 'po_bears_power', name: 'Bears Power 13', rule: (cs, i) => { const e = ema(closes(cs), 13); return cross(cs.map((c, k) => (e[k] == null ? null : c.low - e[k])), 0, i); } },
    { id: 'po_demarker', name: 'DeMarker 14 (30/70)', rule: (cs, i) => { const n = 14, up = cs.map((c, k) => (k ? Math.max(c.high - cs[k - 1].high, 0) : 0)), dn = cs.map((c, k) => (k ? Math.max(cs[k - 1].low - c.low, 0) : 0)), a = sma(up, n), b = sma(dn, n);
      const dm = a.map((v, k) => (v == null || v + b[k] === 0 ? null : (100 * v) / (v + b[k]))); return dm[i - 1] != null && dm[i] > 30 && dm[i - 1] <= 30 ? 1 : dm[i - 1] != null && dm[i] < 70 && dm[i - 1] >= 70 ? -1 : 0; } },
    { id: 'po_chaos_bands', name: 'Fractal Chaos Bands', rule: (cs, i) => { let hi = null, lo = null; for (let m = i - 3; m >= Math.max(2, i - 40) && (hi == null || lo == null); m--) { if (hi == null && fractalAt(cs, m, 2, true)) hi = cs[m].high; if (lo == null && fractalAt(cs, m, 2, false)) lo = cs[m].low; }
      return hi != null && cs[i].close > hi && cs[i - 1].close <= hi ? 1 : lo != null && cs[i].close < lo && cs[i - 1].close >= lo ? -1 : 0; } },
    { id: 'po_williams_14', name: 'وليامز 14 (−80/−20)', rule: (cs, i) => { const w = williams(cs, 14); return w[i - 1] != null && w[i] > -80 && w[i - 1] <= -80 ? 1 : w[i - 1] != null && w[i] < -20 && w[i - 1] >= -20 ? -1 : 0; } },
    { id: 'po_ichimoku', name: 'إيشيموكو 9/26/52 (السحابة)', rule: (cs, i) => { const mid = (k, n) => { const [hi, lo] = range(cs, k, n); return (hi + lo) / 2; }, D = 26; if (i < 52 + D + 1) return 0;
      const top = (k) => Math.max((mid(k - D, 9) + mid(k - D, 26)) / 2, mid(k - D, 52)), bot = (k) => Math.min((mid(k - D, 9) + mid(k - D, 26)) / 2, mid(k - D, 52));
      return cs[i].close > top(i) && cs[i - 1].close <= top(i - 1) ? 1 : cs[i].close < bot(i) && cs[i - 1].close >= bot(i - 1) ? -1 : 0; } },
    { id: 'po_stc', name: 'Schaff Trend Cycle', rule: (cs, i) => { const c = closes(cs), a = ema(c, 23), b = ema(c, 50), m = a.map((v, k) => (v == null || b[k] == null ? null : v - b[k])), n = 10;
      const st = (x) => x.map((v, k) => { if (v == null || k < n - 1) return null; const w = x.slice(k - n + 1, k + 1); if (w.some((q) => q == null)) return null; const hi = Math.max(...w), lo = Math.min(...w); return hi === lo ? 50 : (100 * (v - lo)) / (hi - lo); });
      const s1 = ema(st(m).map((v) => v), 3), stc = ema(st(s1), 3); return stc[i - 1] != null && stc[i] > 25 && stc[i - 1] <= 25 ? 1 : stc[i - 1] != null && stc[i] < 75 && stc[i - 1] >= 75 ? -1 : 0; } },
    { id: 'po_bb_width', name: 'عرض بولينجر (انضغاط ثم خروج)', rule: (cs, i) => { const c = closes(cs), m = sma(c, 20), s = stdev(c, 20); if (m[i - 21] == null) return 0; const w = (k) => (4 * s[k]) / m[k];
      const squeezed = w(i - 1) <= Math.min(...[...Array(20).keys()].map((q) => w(i - 1 - q))) * 1.1; if (!squeezed) return 0; return cs[i].close > m[i] + 2 * s[i] ? 1 : cs[i].close < m[i] - 2 * s[i] ? -1 : 0; } },
    { id: 'po_donchian', name: 'قنوات دونشيان 20', rule: (cs, i) => { if (i < 21) return 0; const [hi, lo] = swing(cs, i, 20); return cs[i].close > hi ? 1 : cs[i].close < lo ? -1 : 0; } },
    { id: 'po_reversal', name: 'ارتداد من دعم/مقاومة', rule: (cs, i) => { if (i < 25) return 0; const [hi, lo] = swing(cs, i - 1, 20), t = cs[i - 1], a = atr(cs, 14)[i] || 0;
      return t.low <= lo + 0.1 * a && t.close > lo && col(cs[i]) > 0 ? 1 : t.high >= hi - 0.1 * a && t.close < hi && col(cs[i]) < 0 ? -1 : 0; } },
    { id: 'po_squat', name: 'شمعة السبينينج عند مستوى', rule: (cs, i) => { if (i < 25) return 0; const [hi, lo] = swing(cs, i - 1, 20), t = cs[i - 1], r = t.high - t.low || 1e-12, a = atr(cs, 14)[i] || 0; if (Math.abs(t.close - t.open) / r > 0.3) return 0;
      return t.low <= lo + 0.1 * a && t.close > lo && col(cs[i]) > 0 ? 1 : t.high >= hi - 0.1 * a && t.close < hi && col(cs[i]) < 0 ? -1 : 0; } },
    { id: 'po_tweezer', name: 'الملقاط (Tweezer)', rule: (cs, i) => { const a = atr(cs, 14)[i]; if (!a || i < 6) return 0; const p = cs[i - 1], c = cs[i], drift = cs[i - 1].close - cs[i - 5].close;
      return col(p) < 0 && col(c) > 0 && Math.abs(p.low - c.low) <= 0.1 * a && drift < 0 ? 1 : col(p) > 0 && col(c) < 0 && Math.abs(p.high - c.high) <= 0.1 * a && drift > 0 ? -1 : 0; } },
    { id: 'po_three_methods', name: 'الطرق الثلاث', rule: (cs, i) => { const a = atr(cs, 14)[i]; if (!a || i < 6) return 0; const L = cs[i - 4], last = cs[i], d = col(L), big = (x) => Math.abs(x.close - x.open) >= 0.8 * a;
      const inside = [cs[i - 3], cs[i - 2], cs[i - 1]].every((x) => Math.abs(x.close - x.open) < 0.6 * a && x.high <= L.high && x.low >= L.low);
      return d && big(L) && inside && col(last) === d && big(last) && (d > 0 ? last.close > L.high : last.close < L.low) ? d : 0; } },
    { id: 'po_breakout', name: 'الاختراق (بتأكيد)', rule: (cs, i) => { if (i < 25) return 0; const [hi, lo] = swing(cs, i - 1, 20), b = cs[i - 1], c = cs[i];
      return b.close > hi && col(c) > 0 && c.close > b.close ? 1 : b.close < lo && col(c) < 0 && c.close < b.close ? -1 : 0; } },
  ].map((r) => ({ ...PO, ...r }));
  RULES.push(...PO_RULES);

  // one evaluation per strategy per analysis (both sides ask)
  const memo = new WeakMap();
  const signalOf = (X, r) => {
    const cs = X.f5?.candles; if (!cs || cs.length < 30) return 0;
    let m = memo.get(cs); if (!m) memo.set(cs, (m = new Map()));
    if (!m.has(r.id)) { let v = 0; try { v = r.rule(cs, cs.length - 1) || 0; } catch (_) { v = 0; } m.set(r.id, v); }
    return m.get(r.id);
  };
  for (const r of RULES) define({ id: r.id, name: r.name, family: 'youtube', hidden: true, frame: r.frame, expirySec: r.expirySec, source: r.src, regimes: [],
    against: () => [],
    conditions: (s, X) => [R(`its own frame (${OTC.TF_LABEL[r.frame]})`, OTC.TF.PRIMARY === r.frame), R(`${r.name}: rule met`, signalOf(X, r) === s.sg)] });

  // the panel mode's set: these, plus the Keltner trend pullback (the one rule that held up on 10-minute candles)
  // the mode's set: the creators' strategies and Keltner. Pocket Option's own (po_*) stay defined — their past trades
  // keep their names — but are out of the mode (the user, 2026-10-04): live 13 W / 13 L (−72) in their first hour, and
  // 49.99 % on 405k backtested trades
  // and six of the creators' ones the user took out after the day's real trades (2026-10-04: −1,177 EGP together)
  const DROPPED = new Set(['yt_cci_psar', 'yt_sma_stoch', 'yt_fractal_ema', 'yt_alligator_rsi', 'yt_supertrend_5s', 'yt_aroon_keltner']);
  const MODE_OUT = (id) => id.startsWith('po_') || DROPPED.has(id);
  OTC.YouTube = { RULES, ids: () => [...RULES.filter((r) => !MODE_OUT(r.id)).map((r) => r.id), 'keltner_trend_pullback'], all: () => [...RULES.map((r) => r.id), 'keltner_trend_pullback'], frames: () => [...new Set([...RULES.filter((r) => !MODE_OUT(r.id)).map((r) => r.frame), 600])].sort((a, b) => a - b) };
})(typeof globalThis !== 'undefined' ? globalThis : this);
