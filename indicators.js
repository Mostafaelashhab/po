// Pure indicator math. Each returns a full-length series (null where there is
// not enough data yet) so callers can look back N bars.
const Ind = {
  sma(values, period) {
    return values.map((_, i) => i < period - 1 ? null
      : values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  },

  // EMA that tolerates leading nulls (needed for EMA-of-MACD)
  ema(values, period) {
    const out = new Array(values.length).fill(null);
    const start = values.findIndex(v => v != null);
    if (start < 0 || values.length - start < period) return out;
    const k = 2 / (period + 1);
    let prev = values.slice(start, start + period).reduce((a, b) => a + b, 0) / period;
    out[start + period - 1] = prev;
    for (let i = start + period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  },

  // Wilder's RSI
  rsi(values, period = 14) {
    const out = new Array(values.length).fill(null);
    if (values.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = values[i] - values[i - 1];
      if (d > 0) gain += d; else loss -= d;
    }
    gain /= period; loss /= period;
    const calc = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
    out[period] = calc();
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      gain = (gain * (period - 1) + Math.max(d, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = calc();
    }
    return out;
  },

  bollinger(values, period = 20, mult = 2) {
    const mid = [], upper = [], lower = [];
    for (let i = 0; i < values.length; i++) {
      if (i < period - 1) { mid.push(null); upper.push(null); lower.push(null); continue; }
      const win = values.slice(i - period + 1, i + 1);
      const mean = win.reduce((a, b) => a + b, 0) / period;
      const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
      mid.push(mean); upper.push(mean + mult * sd); lower.push(mean - mult * sd);
    }
    return { mid, upper, lower };
  },

  // Stochastic oscillator on candles: %K (smoothed by `smooth`) and %D
  stochastic(c, period = 14, smooth = 3, dPeriod = 3) {
    const raw = c.map((_, i) => {
      if (i < period - 1) return null;
      const win = c.slice(i - period + 1, i + 1);
      const hi = Math.max(...win.map(x => x.high)), lo = Math.min(...win.map(x => x.low));
      return hi === lo ? 50 : ((c[i].close - lo) / (hi - lo)) * 100;
    });
    const avg = (arr, p) => arr.map((_, i) => {
      const win = arr.slice(Math.max(0, i - p + 1), i + 1);
      return win.length < p || win.some(v => v == null) ? null : win.reduce((a, b) => a + b, 0) / p;
    });
    const k = avg(raw, smooth);
    return { k, d: avg(k, dPeriod) };
  },

  macd(values, fast = 12, slow = 26, signal = 9) {
    const f = Ind.ema(values, fast), s = Ind.ema(values, slow);
    const line = values.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] - s[i]));
    const sig = Ind.ema(line, signal);
    const hist = line.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i]));
    return { line, signal: sig, hist };
  },

  trueRange(c) {
    return c.map((x, i) => i === 0 ? x.high - x.low
      : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)));
  },

  // Wilder's ATR
  atr(c, period = 14) {
    const tr = Ind.trueRange(c);
    const out = new Array(c.length).fill(null);
    if (c.length <= period) return out;
    let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
    out[period] = prev;
    for (let i = period + 1; i < c.length; i++) { prev = (prev * (period - 1) + tr[i]) / period; out[i] = prev; }
    return out;
  },

  // Commodity Channel Index on typical price
  cci(c, period = 20) {
    const tp = c.map(x => (x.high + x.low + x.close) / 3);
    return tp.map((_, i) => {
      if (i < period - 1) return null;
      const win = tp.slice(i - period + 1, i + 1);
      const mean = win.reduce((a, b) => a + b, 0) / period;
      const md = win.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
      return md === 0 ? 0 : (tp[i] - mean) / (0.015 * md);
    });
  },

  // Bill Williams: Awesome Oscillator and Accelerator (AC = AO − SMA5(AO))
  awesome(c) {
    const med = c.map(x => (x.high + x.low) / 2);
    const f = Ind.sma(med, 5), s = Ind.sma(med, 34);
    const ao = med.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] - s[i]));
    const aoSma = ao.map((_, i) => {
      const win = ao.slice(Math.max(0, i - 4), i + 1);
      return win.length < 5 || win.some(v => v == null) ? null : win.reduce((a, b) => a + b, 0) / 5;
    });
    return { ao, ac: ao.map((v, i) => (v == null || aoSma[i] == null ? null : v - aoSma[i])) };
  },

  // Rate of change, %
  roc(values, period = 9) {
    return values.map((v, i) => (i < period ? null : ((v - values[i - period]) / values[i - period]) * 100));
  },

  // Williams %R: 0 (top of range) … −100 (bottom)
  williamsR(c, period = 14) {
    return c.map((x, i) => {
      if (i < period - 1) return null;
      const win = c.slice(i - period + 1, i + 1);
      const hi = Math.max(...win.map(y => y.high)), lo = Math.min(...win.map(y => y.low));
      return hi === lo ? -50 : ((hi - x.close) / (hi - lo)) * -100;
    });
  },

  // Parabolic SAR → { sar, up } where up[i] is true while SAR sits below price
  psar(c, step = 0.02, max = 0.2) {
    const n = c.length, sar = new Array(n).fill(null), up = new Array(n).fill(null);
    if (n < 2) return { sar, up };
    let isUp = c[1].close >= c[0].close, af = step;
    let ep = isUp ? Math.max(c[0].high, c[1].high) : Math.min(c[0].low, c[1].low);
    let s = isUp ? Math.min(c[0].low, c[1].low) : Math.max(c[0].high, c[1].high);
    for (let i = 2; i < n; i++) {
      s = s + af * (ep - s);
      if (isUp) {
        s = Math.min(s, c[i - 1].low, c[i - 2].low);
        if (c[i].low < s) { isUp = false; s = ep; ep = c[i].low; af = step; }
        else if (c[i].high > ep) { ep = c[i].high; af = Math.min(max, af + step); }
      } else {
        s = Math.max(s, c[i - 1].high, c[i - 2].high);
        if (c[i].high > s) { isUp = true; s = ep; ep = c[i].high; af = step; }
        else if (c[i].low < ep) { ep = c[i].low; af = Math.min(max, af + step); }
      }
      sar[i] = s; up[i] = isUp;
    }
    return { sar, up };
  },

  // Wilder's ADX with +DI / -DI. ADX is valid from index 2*period - 1.
  adx(c, period = 14) {
    const n = c.length;
    const adx = new Array(n).fill(null), plusDI = new Array(n).fill(null), minusDI = new Array(n).fill(null);
    if (n < 2 * period) return { adx, plusDI, minusDI };
    const tr = Ind.trueRange(c);
    const pdm = c.map((x, i) => {
      if (!i) return 0;
      const up = x.high - c[i - 1].high, dn = c[i - 1].low - x.low;
      return up > dn && up > 0 ? up : 0;
    });
    const mdm = c.map((x, i) => {
      if (!i) return 0;
      const up = x.high - c[i - 1].high, dn = c[i - 1].low - x.low;
      return dn > up && dn > 0 ? dn : 0;
    });
    let sTr = 0, sP = 0, sM = 0;
    for (let i = 1; i <= period; i++) { sTr += tr[i]; sP += pdm[i]; sM += mdm[i]; }
    const dx = [];
    for (let i = period; i < n; i++) {
      if (i > period) { sTr = sTr - sTr / period + tr[i]; sP = sP - sP / period + pdm[i]; sM = sM - sM / period + mdm[i]; }
      const p = sTr ? (100 * sP) / sTr : 0, m = sTr ? (100 * sM) / sTr : 0;
      plusDI[i] = p; minusDI[i] = m;
      dx.push(p + m ? (100 * Math.abs(p - m)) / (p + m) : 0);
      const j = dx.length;
      if (j === period) adx[i] = dx.reduce((a, b) => a + b, 0) / period;
      else if (j > period) adx[i] = (adx[i - 1] * (period - 1) + dx[j - 1]) / period;
    }
    return { adx, plusDI, minusDI };
  },
};
