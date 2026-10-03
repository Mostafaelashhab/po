// Signal rules. Every strategy looks only at CLOSED candles and returns four
// checks [{ label, call, put }] so the panel can show what lined up.
//
// Strategies come in two families, and the market-regime filter treats them
// differently:
//   reversal — bet on a bounce; dangerous in a strong trend (ADX high)
//   trend    — bet on continuation; useless in a flat market (ADX low)
const MIN_CANDLES = 40; // Awesome/Accelerator needs SMA34 + SMA5

const green = (x) => x.close > x.open;
const red = (x) => x.close < x.open;

const Strategies = {
  reversal: {
    title: 'BB + RSI reversal',
    family: 'reversal',
    checks(c, ind) {
      const { bb, rsi } = ind, n = c.length - 1, p = n - 1;
      const last = c[n], prev = c[p];
      return [
        { label: 'Touched band', call: prev.low <= bb.lower[p] || last.low <= bb.lower[n],
                                 put: prev.high >= bb.upper[p] || last.high >= bb.upper[n] },
        { label: 'RSI stretched', call: Math.min(rsi[p], rsi[n]) < 30, put: Math.max(rsi[p], rsi[n]) > 70 },
        { label: 'RSI turning', call: rsi[n] > rsi[p], put: rsi[n] < rsi[p] },
        { label: 'Confirm candle', call: green(last), put: red(last) },
      ];
    },
  },

  stoch: {
    title: 'Stochastic reversal',
    family: 'reversal',
    checks(c, ind) {
      const { stoch: { k, d }, rsi, bb } = ind, n = c.length - 1;
      const crossUp = [n, n - 1].some(i => k[i - 1] <= d[i - 1] && k[i] > d[i]);
      const crossDn = [n, n - 1].some(i => k[i - 1] >= d[i - 1] && k[i] < d[i]);
      const last = c[n];
      return [
        { label: '%K/%D cross', call: crossUp, put: crossDn },
        { label: 'In OB/OS zone', call: Math.min(k[n - 1], d[n - 1]) < 20, put: Math.max(k[n - 1], d[n - 1]) > 80 },
        { label: 'Price vs BB mid', call: last.close < bb.mid[n], put: last.close > bb.mid[n] },
        { label: 'Confirm candle', call: green(last), put: red(last) },
      ];
    },
  },

  sr: {
    title: 'Support / resistance bounce',
    family: 'reversal',
    checks(c, ind) {
      const { atr, rsi } = ind, n = c.length - 1, last = c[n];
      const zone = c.slice(n - 21, n - 1); // levels from before the last two candles
      const support = Math.min(...zone.map(x => x.low));
      const resist = Math.max(...zone.map(x => x.high));
      const a = atr[n - 1], range = last.high - last.low || 1e-12;
      const lowerWick = Math.min(last.open, last.close) - last.low;
      const upperWick = last.high - Math.max(last.open, last.close);
      return [
        { label: 'At level', call: Math.abs(last.low - support) <= 0.3 * a, put: Math.abs(last.high - resist) <= 0.3 * a },
        { label: 'Closed back inside', call: last.close > support, put: last.close < resist },
        { label: 'Rejection wick', call: lowerWick >= 0.4 * range, put: upperWick >= 0.4 * range },
        { label: 'RSI not extended', call: rsi[n] < 50, put: rsi[n] > 50 },
      ];
    },
  },

  trend: {
    title: 'EMA 9/21 cross',
    family: 'trend',
    checks(c, ind) {
      const { ema9: fast, ema21: slow, rsi } = ind, n = c.length - 1, last = c[n];
      const crossedUp = [n, n - 1].some(i => fast[i - 1] <= slow[i - 1] && fast[i] > slow[i]);
      const crossedDown = [n, n - 1].some(i => fast[i - 1] >= slow[i - 1] && fast[i] < slow[i]);
      return [
        { label: 'EMA cross', call: crossedUp, put: crossedDown },
        { label: 'RSI momentum', call: rsi[n] > 50 && rsi[n] < 70, put: rsi[n] < 50 && rsi[n] > 30 },
        { label: 'Price vs EMA9', call: last.close > fast[n], put: last.close < fast[n] },
        { label: 'Confirm candle', call: green(last), put: red(last) },
      ];
    },
  },

  macd: {
    title: 'MACD momentum flip',
    family: 'trend',
    checks(c, ind) {
      const { macd: { hist }, ema21, rsi } = ind, n = c.length - 1, last = c[n];
      const flipUp = [n, n - 1].some(i => hist[i - 1] <= 0 && hist[i] > 0);
      const flipDn = [n, n - 1].some(i => hist[i - 1] >= 0 && hist[i] < 0);
      return [
        { label: 'Histogram flip', call: flipUp, put: flipDn },
        { label: 'Price vs EMA21', call: last.close > ema21[n], put: last.close < ema21[n] },
        { label: 'RSI side', call: rsi[n] > 50 && rsi[n] < 70, put: rsi[n] < 50 && rsi[n] > 30 },
        { label: 'Confirm candle', call: green(last), put: red(last) },
      ];
    },
  },

  pullback: {
    title: 'Trend pullback',
    family: 'trend',
    checks(c, ind) {
      const { ema9, ema21, rsi } = ind, n = c.length - 1, p = n - 1, last = c[n], prev = c[p];
      return [
        { label: 'EMAs stacked + rising', call: ema9[n] > ema21[n] && ema21[n] > ema21[n - 5],
                                          put: ema9[n] < ema21[n] && ema21[n] < ema21[n - 5] },
        { label: 'Dipped to EMA9', call: prev.low <= ema9[p] && prev.close > ema21[p],
                                   put: prev.high >= ema9[p] && prev.close < ema21[p] },
        { label: 'Resumed past EMA9', call: green(last) && last.close > ema9[n], put: red(last) && last.close < ema9[n] },
        { label: 'RSI healthy', call: rsi[n] > 45 && rsi[n] < 65, put: rsi[n] < 55 && rsi[n] > 35 },
      ];
    },
  },
};

// ── Indicators from PO's chart (CCI, AC, Envelopes, ROC) plus Williams %R,
// Parabolic SAR and a candle-streak fade.
Object.assign(Strategies, {
  cci: {
    title: 'CCI reversal',
    family: 'reversal',
    checks(c, ind) {
      const { cci, bb, rsi } = ind, n = c.length - 1, last = c[n];
      const backUp = [n, n - 1].some(i => cci[i - 1] < -100 && cci[i] >= -100);
      const backDn = [n, n - 1].some(i => cci[i - 1] > 100 && cci[i] <= 100);
      return [
        { label: 'CCI back from ±100', call: backUp, put: backDn },
        { label: 'Price vs BB mid', call: last.close < bb.mid[n], put: last.close > bb.mid[n] },
        { label: 'RSI side', call: rsi[n] < 45, put: rsi[n] > 55 },
        { label: 'Confirm candle', call: green(last), put: red(last) },
      ];
    },
  },

  ac: {
    title: 'Accelerator (AC) cross',
    family: 'trend',
    checks(c, ind) {
      const { awesome: { ao, ac } } = ind, n = c.length - 1, last = c[n];
      const crossUp = [n, n - 1].some(i => ac[i - 1] <= 0 && ac[i] > 0);
      const crossDn = [n, n - 1].some(i => ac[i - 1] >= 0 && ac[i] < 0);
      return [
        { label: 'AC crosses 0', call: crossUp, put: crossDn },
        { label: 'AC accelerating', call: ac[n] > ac[n - 1], put: ac[n] < ac[n - 1] },
        { label: 'AO side', call: ao[n] > 0, put: ao[n] < 0 },
        { label: 'Confirm candle', call: green(last), put: red(last) },
      ];
    },
  },

  envelope: {
    title: 'Envelope bounce',
    family: 'reversal',
    checks(c, ind) {
      // Envelope = SMA20 ± 1.5×ATR, so it scales to each pair's volatility
      const { sma20, atr, rsi } = ind, n = c.length - 1, last = c[n];
      const lower = sma20[n] - 1.5 * atr[n], upper = sma20[n] + 1.5 * atr[n];
      const range = last.high - last.low || 1e-12;
      return [
        { label: 'Pierced envelope', call: last.low <= lower, put: last.high >= upper },
        { label: 'Closed back inside', call: last.close > lower, put: last.close < upper },
        { label: 'Rejection wick', call: (Math.min(last.open, last.close) - last.low) >= 0.4 * range,
                                   put: (last.high - Math.max(last.open, last.close)) >= 0.4 * range },
        { label: 'RSI stretched', call: rsi[n] < 40, put: rsi[n] > 60 },
      ];
    },
  },

  roc: {
    title: 'ROC momentum',
    family: 'trend',
    checks(c, ind) {
      const { roc, ema21 } = ind, n = c.length - 1, last = c[n];
      const crossUp = [n, n - 1].some(i => roc[i - 1] <= 0 && roc[i] > 0);
      const crossDn = [n, n - 1].some(i => roc[i - 1] >= 0 && roc[i] < 0);
      return [
        { label: 'ROC crosses 0', call: crossUp, put: crossDn },
        { label: 'EMA21 sloping', call: ema21[n] > ema21[n - 3], put: ema21[n] < ema21[n - 3] },
        { label: 'Price vs EMA21', call: last.close > ema21[n], put: last.close < ema21[n] },
        { label: 'Confirm candle', call: green(last), put: red(last) },
      ];
    },
  },

  willr: {
    title: 'Williams %R reversal',
    family: 'reversal',
    checks(c, ind) {
      const { willr, bb } = ind, n = c.length - 1, last = c[n];
      return [
        { label: 'Left OB/OS zone', call: willr[n - 1] < -80 && willr[n] >= -80, put: willr[n - 1] > -20 && willr[n] <= -20 },
        { label: 'Was extreme', call: Math.min(willr[n - 2], willr[n - 1]) < -90, put: Math.max(willr[n - 2], willr[n - 1]) > -10 },
        { label: 'Price vs BB mid', call: last.close < bb.mid[n], put: last.close > bb.mid[n] },
        { label: 'Confirm candle', call: green(last), put: red(last) },
      ];
    },
  },

  psar: {
    title: 'Parabolic SAR flip',
    family: 'trend',
    checks(c, ind) {
      const { psar: { up }, ema21, rsi } = ind, n = c.length - 1, last = c[n];
      const flipUp = [n, n - 1].some(i => up[i - 1] === false && up[i] === true);
      const flipDn = [n, n - 1].some(i => up[i - 1] === true && up[i] === false);
      return [
        { label: 'SAR flipped', call: flipUp, put: flipDn },
        { label: 'Price vs EMA21', call: last.close > ema21[n], put: last.close < ema21[n] },
        { label: 'RSI side', call: rsi[n] > 50, put: rsi[n] < 50 },
        { label: 'Confirm candle', call: green(last), put: red(last) },
      ];
    },
  },

  streak: {
    title: 'Candle streak fade',
    family: 'reversal',
    checks(c, ind) {
      // After 4+ candles of one colour, bet on the next move going the other way.
      const n = c.length - 1, { rsi, bb } = ind;
      const run = (pred) => { let k = 0; for (let i = n; i >= 0 && pred(c[i]); i--) k++; return k; };
      const reds = run(red), greens = run(green);
      const body = (x) => Math.abs(x.close - x.open);
      return [
        { label: '4+ same-colour candles', call: reds >= 4, put: greens >= 4 },
        { label: 'Last body shrinking', call: reds >= 2 && body(c[n]) < body(c[n - 1]), put: greens >= 2 && body(c[n]) < body(c[n - 1]) },
        { label: 'RSI stretched', call: rsi[n] < 35, put: rsi[n] > 65 },
        { label: 'Outside BB mid', call: c[n].close < bb.mid[n], put: c[n].close > bb.mid[n] },
      ];
    },
  },
});

// ── Chart analyst: the 10-point read (trend, S/R, structure, price action,
// momentum, EMA 20/50, RSI 14, entry zone, reasons for, reasons against).
// Trades only when 5 of its 6 confirmations agree AND nothing on the
// "against" list is a hard veto. Otherwise: NO TRADE. Never martingale.
function swings(c, k = 2, lookback = 80) {
  const from = Math.max(k, c.length - lookback), highs = [], lows = [];
  for (let i = from; i < c.length - k; i++) {
    const win = c.slice(i - k, i + k + 1);
    if (c[i].high === Math.max(...win.map(x => x.high))) highs.push({ i, price: c[i].high });
    if (c[i].low === Math.min(...win.map(x => x.low))) lows.push({ i, price: c[i].low });
  }
  return { highs, lows };
}

function candlePattern(c) {
  const n = c.length - 1, a = c[n], b = c[n - 1];
  const body = Math.abs(a.close - a.open), range = a.high - a.low || 1e-12;
  const lowerWick = Math.min(a.open, a.close) - a.low, upperWick = a.high - Math.max(a.open, a.close);
  if (green(a) && red(b) && a.close >= b.open && a.open <= b.close) return { dir: 'call', name: 'ابتلاع شرائي (Bullish engulfing)' };
  if (red(a) && green(b) && a.close <= b.open && a.open >= b.close) return { dir: 'put', name: 'ابتلاع بيعي (Bearish engulfing)' };
  if (lowerWick >= 2 * body && lowerWick >= 0.55 * range) return { dir: 'call', name: 'مطرقة / رفض للهبوط (Pin bar)' };
  if (upperWick >= 2 * body && upperWick >= 0.55 * range) return { dir: 'put', name: 'نجمة ساقطة / رفض للصعود (Pin bar)' };
  if (body <= 0.1 * range) return { dir: null, name: 'دوجي — تردد' };
  return { dir: green(a) ? 'call' : 'put', name: green(a) ? 'شمعة صاعدة عادية' : 'شمعة هابطة عادية', weak: true };
}

function analyzeChart(c, ind) {
  const n = c.length - 1, last = c[n], price = last.close;
  const { ema20, ema50, rsi, atr, macd: { hist } } = ind;
  if (ema50[n] == null || ema50[n - 5] == null || rsi[n] == null || atr[n] == null) {
    return { verdict: 'NO TRADE', why: 'بيانات غير كافية (محتاج 55 شمعة على الأقل)', items: [], pros: [], cons: [], call: [], put: [] };
  }
  const a = atr[n];
  const fmtP = (x) => x.toFixed(price < 10 ? 5 : 3);

  // 1 + 6. trend from EMA 20/50 stack and EMA50 slope
  const slope = (ema50[n] - ema50[n - 5]) / a;
  const trend = ema20[n] > ema50[n] && slope > 0.05 ? 'up' : ema20[n] < ema50[n] && slope < -0.05 ? 'down' : 'flat';

  // 2. support / resistance from swing points
  const sw = swings(c);
  const supports = sw.lows.map(x => x.price).filter(p => p < price).sort((x, y) => y - x);
  const resists = sw.highs.map(x => x.price).filter(p => p > price).sort((x, y) => x - y);
  const sup = supports[0], res = resists[0];
  const dSup = sup != null ? (price - sup) / a : Infinity, dRes = res != null ? (res - price) / a : Infinity;

  // 3. market structure from the last two swing highs/lows
  const [h1, h2] = sw.highs.slice(-2), [l1, l2] = sw.lows.slice(-2);
  const structure = h1 && h2 && l1 && l2
    ? (h2.price > h1.price && l2.price > l1.price ? 'bull' : h2.price < h1.price && l2.price < l1.price ? 'bear' : 'range')
    : 'range';

  // 4. price action
  const pa = candlePattern(c);

  // 5. momentum: MACD histogram side and direction
  const momUp = hist[n] > 0 && hist[n] > hist[n - 1], momDn = hist[n] < 0 && hist[n] < hist[n - 1];

  // 7. RSI
  const r = rsi[n], rUp = r > rsi[n - 1];

  // 8. entry zones: pullback to EMA20 in a trend, or reaction at S/R
  const nearEma20 = Math.abs(last.low - ema20[n]) <= 0.5 * a || Math.abs(last.high - ema20[n]) <= 0.5 * a;
  const zoneCall = (trend === 'up' && nearEma20) || dSup <= 0.6;
  const zonePut = (trend === 'down' && nearEma20) || dRes <= 0.6;

  const confirm = {
    call: [
      ['الاتجاه صاعد (EMA20 فوق EMA50 وEMA50 طالع)', trend === 'up'],
      ['الهيكل صاعد (قمم وقيعان أعلى)', structure === 'bull'],
      ['السعر في منطقة دخول (ارتداد لـ EMA20 أو عند دعم)', zoneCall],
      ['Price action شرائي', pa.dir === 'call' && !pa.weak],
      ['الزخم صاعد (MACD موجب ويزيد)', momUp],
      ['RSI بين 40 و65 وطالع', r >= 40 && r <= 65 && rUp],
    ],
    put: [
      ['الاتجاه هابط (EMA20 تحت EMA50 وEMA50 نازل)', trend === 'down'],
      ['الهيكل هابط (قمم وقيعان أقل)', structure === 'bear'],
      ['السعر في منطقة دخول (ارتداد لـ EMA20 أو عند مقاومة)', zonePut],
      ['Price action بيعي', pa.dir === 'put' && !pa.weak],
      ['الزخم هابط (MACD سالب ويقل)', momDn],
      ['RSI بين 35 و60 ونازل', r >= 35 && r <= 60 && !rUp],
    ],
  };
  const vetoes = {
    call: [
      dRes <= 0.5 && 'مقاومة قريبة جداً فوق السعر',
      r > 70 && 'RSI تشبع شراء (> 70)',
      ind.lastRangeAtr > 2.5 && 'شمعة مفاجئة كبيرة',
    ].filter(Boolean),
    put: [
      dSup <= 0.5 && 'دعم قريب جداً تحت السعر',
      r < 30 && 'RSI تشبع بيع (< 30)',
      ind.lastRangeAtr > 2.5 && 'شمعة مفاجئة كبيرة',
    ].filter(Boolean),
  };

  const score = (d) => confirm[d].filter(x => x[1]).length;
  const side = score('call') > score('put') ? 'call' : score('put') > score('call') ? 'put' : null;
  const ok = side && score(side) >= 5 && !vetoes[side].length;

  const trendTxt = { up: 'صاعد', down: 'هابط', flat: 'عرضي / غير واضح' }[trend];
  const items = [
    ['1. الاتجاه العام', trendTxt],
    ['2. الدعم / المقاومة', `دعم ${sup != null ? fmtP(sup) : '—'} · مقاومة ${res != null ? fmtP(res) : '—'}`],
    ['3. هيكل السوق', { bull: 'صاعد (HH/HL)', bear: 'هابط (LH/LL)', range: 'تذبذب / رينج' }[structure]],
    ['4. Price action', pa.name],
    ['5. الزخم', momUp ? 'صاعد' : momDn ? 'هابط' : 'ضعيف / بيتغيّر'],
    ['6. EMA 20/50', `السعر ${price > ema20[n] ? 'فوق' : 'تحت'} EMA20 و${price > ema50[n] ? 'فوق' : 'تحت'} EMA50`],
    ['7. RSI 14', `${r.toFixed(0)} ${rUp ? '↑' : '↓'}`],
    ['8. منطقة الدخول', zoneCall ? 'منطقة شراء' : zonePut ? 'منطقة بيع' : 'السعر مش في منطقة دخول'],
  ];
  const lean = side || 'call';
  return {
    verdict: ok ? side.toUpperCase() : 'NO TRADE',
    why: ok ? `${score(side)}/6 تأكيدات بدون موانع`
      : side ? (vetoes[side].length ? `مانع: ${vetoes[side][0]}` : `${score(side)}/6 تأكيدات بس — إشارة ضعيفة`) : 'مفيش اتجاه غالب',
    items,
    pros: confirm[lean].filter(x => x[1]).map(x => x[0]),
    cons: [...confirm[lean].filter(x => !x[1]).map(x => `مش متحقق: ${x[0]}`), ...vetoes[lean]],
    call: confirm.call, put: confirm.put, vetoes, action: ok ? side : null,
  };
}

Strategies.analyst = {
  title: 'Chart analyst (10-point)',
  family: 'confluence',
  required: 5,
  checks(c, ind) {
    const rep = analyzeChart(c, ind);
    if (!rep.call.length) return [{ label: 'Data', call: false, put: false }];
    return rep.call.map(([label, v], i) => ({ label, call: v && !rep.vetoes.call.length, put: rep.put[i][1] && !rep.vetoes.put.length }));
  },
};

// ── SMC engine. Looks for the highest-quality setup present, as a sequence:
//   LOCATION → LIQUIDITY EVENT → REACTION → STRUCTURE CONFIRMATION → ENTRY
// Two setup types:
//   A) Sweep reversal: discount/key level → sell-side sweep → close back inside with
//      follow-through → MSS (close above the last minor high) → entry not chased.
//   B) Continuation: trend structure → BOS with acceptance (2 closes beyond) →
//      retest that holds → confirmation candle → entry not in the extreme.
// Every concept reports NOT CONFIRMED when the candles don't clearly show it.
// CALL/PUT only when a full sequence completes, the counter-scenario is weak and
// no risk rule objects. Default: NO TRADE. Never martingale, never a win-rate.
function smcEngine(c, ind) {
  const n = c.length - 1;
  const { ema20, ema50, atr, adx } = ind;
  const NC = 'NOT CONFIRMED';
  if (n < 80 || ema50[n - 20] == null || atr[n] == null) {
    return { verdict: 'NO TRADE', why: 'بيانات غير كافية (محتاج 80 شمعة)', sections: [], seq: { call: [], put: [] }, vetoes: { call: [], put: [] } };
  }
  const a = atr[n], last = c[n], price = last.close;
  const P = (x) => (x == null ? '—' : x.toFixed(price < 10 ? 5 : 3));
  const body = (x) => Math.abs(x.close - x.open), rng = (x) => x.high - x.low;
  const dirAr = { call: 'صاعد', put: 'هابط' };

  // ── MARKET STRUCTURE
  const sw = swings(c, 2, 120);
  const seq = [...sw.highs.map(x => ({ ...x, t: 'H' })), ...sw.lows.map(x => ({ ...x, t: 'L' }))].sort((x, y) => x.i - y.i);
  const labels = []; let pH = null, pL = null;
  for (const x of seq) {
    if (x.t === 'H') { if (pH) labels.push({ i: x.i, lab: x.price > pH.price ? 'HH' : 'LH' }); pH = x; }
    else { if (pL) labels.push({ i: x.i, lab: x.price > pL.price ? 'HL' : 'LL' }); pL = x; }
  }
  const recent = labels.slice(-4).map(x => x.lab);
  const bulls = recent.filter(l => l === 'HH' || l === 'HL').length;
  const structure = recent.length < 3 ? 'unclear' : bulls >= 3 ? 'bull' : bulls <= 1 ? 'bear' : 'mixed';
  const slope50 = (ema50[n] - ema50[n - 20]) / a;
  const mainTrend = slope50 > 0.3 && price > ema50[n] ? 'up' : slope50 < -0.3 && price < ema50[n] ? 'down' : 'flat';
  const shortTrend = (ema20[n] - ema20[n - 5]) / a > 0.15 ? 'up' : (ema20[n] - ema20[n - 5]) / a < -0.15 ? 'down' : 'flat';
  let path = 0; for (let i = n - 19; i <= n; i++) path += Math.abs(c[i].close - c[i - 1].close);
  const er = path ? Math.abs(price - c[n - 20].close) / path : 0, adxN = adx.adx[n] ?? 0;
  const condition = adxN >= 25 && er >= 0.3 ? 'Trend' : er < 0.1 && adxN < 20 ? 'Chop' : 'Range';

  // ── LIQUIDITY
  const hi60 = Math.max(...c.slice(-60).map(x => x.high)), lo60 = Math.min(...c.slice(-60).map(x => x.low));
  const eq = (arr) => { for (let i = arr.length - 1; i > 0; i--) for (let j = i - 1; j >= Math.max(0, i - 6); j--) if (Math.abs(arr[i].price - arr[j].price) <= 0.15 * a) return { price: Math.max(arr[i].price, arr[j].price), lo: Math.min(arr[i].price, arr[j].price), i: arr[i].i }; return null; };
  const eqH = eq(sw.highs.slice(-8)), eqL = eq(sw.lows.slice(-8));
  const prevH = sw.highs.filter(x => x.i < n - 2).slice(-1)[0], prevL = sw.lows.filter(x => x.i < n - 2).slice(-1)[0];
  const buySide = eqH?.price ?? prevH?.price ?? hi60;   // stops above
  const sellSide = eqL?.lo ?? prevL?.price ?? lo60;     // stops below
  const pos = hi60 > lo60 ? (price - lo60) / (hi60 - lo60) : 0.5;
  const location = pos < 0.4 ? 'Discount' : pos > 0.6 ? 'Premium' : 'Mid-range';

  // ── KEY LEVELS (ranked by touches, then recency)
  const lv = [];
  for (const p of [...sw.highs, ...sw.lows]) {
    const L = lv.find(l => Math.abs(l.price - p.price) <= 0.3 * a);
    if (L) { L.price = (L.price * L.touches + p.price) / (L.touches + 1); L.touches++; L.last = Math.max(L.last, p.i); }
    else lv.push({ price: p.price, touches: 1, last: p.i });
  }
  const rank = (arr) => arr.sort((x, y) => (y.touches - x.touches) || (y.last - x.last));
  const sup = rank(lv.filter(l => l.price < price - 0.1 * a))[0], res = rank(lv.filter(l => l.price > price + 0.1 * a))[0];

  // ── SMART MONEY: displacement, OB, breaker, FVG, mitigation
  let disp = null, demand = null, supply = null;
  for (let i = n - 60; i <= n; i++) {
    const x = c[i];
    if (!(body(x) >= 1.5 * a && body(x) >= 0.6 * rng(x))) continue;
    disp = { dir: green(x) ? 'call' : 'put', i };
    for (let j = i - 1; j >= i - 3; j--) {
      if (green(x) && red(c[j])) { demand = { lo: c[j].low, hi: c[j].high, i: j, d: i }; break; }
      if (red(x) && green(c[j])) { supply = { lo: c[j].low, hi: c[j].high, i: j, d: i }; break; }
    }
  }
  const after = (z) => c.slice(z.d + 1);
  if (demand) { demand.mitigated = after(demand).some(x => x.low <= demand.hi); demand.broken = after(demand).some(x => x.close < demand.lo); }
  if (supply) { supply.mitigated = after(supply).some(x => x.high >= supply.lo); supply.broken = after(supply).some(x => x.close > supply.hi); }
  // breaker: a broken OB retested from the other side
  const breakerUp = supply?.broken && Math.abs(last.low - supply.hi) <= 0.4 * a && last.close > supply.hi;
  const breakerDn = demand?.broken && Math.abs(last.high - demand.lo) <= 0.4 * a && last.close < demand.lo;
  let fvgUp = null, fvgDn = null;
  for (let i = n - 40; i <= n; i++) {
    if (c[i].low > c[i - 2].high && !c.slice(i + 1).some(x => x.low <= c[i - 2].high)) fvgUp = { lo: c[i - 2].high, hi: c[i].low };
    if (c[i].high < c[i - 2].low && !c.slice(i + 1).some(x => x.high >= c[i - 2].low)) fvgDn = { lo: c[i].high, hi: c[i - 2].low };
  }

  // BOS / CHOCH / MSS relative to the last confirmed swings
  const lastH = sw.highs.filter(x => x.i < n - 1).slice(-1)[0], lastL = sw.lows.filter(x => x.i < n - 1).slice(-1)[0];
  const brk = (sp, up) => { if (!sp) return null; const k = c.slice(sp.i + 1).findIndex(x => (up ? x.close > sp.price : x.close < sp.price)); return k < 0 ? null : { at: sp.i + 1 + k, level: sp.price, ago: n - (sp.i + 1 + k) }; };
  const upBreak = brk(lastH, true), dnBreak = brk(lastL, false);
  const priorBull = structure === 'bull', priorBear = structure === 'bear';
  const bos = upBreak && priorBull ? { dir: 'call', ...upBreak } : dnBreak && priorBear ? { dir: 'put', ...dnBreak } : null;
  const choch = upBreak && !priorBull ? { dir: 'call', ...upBreak } : dnBreak && !priorBear ? { dir: 'put', ...dnBreak } : null;

  // ── MOMENTUM & CANDLE BEHAVIOR
  const win = (k0, k1) => c.slice(n - k1 + 1, n - k0 + 1);
  const press = (arr) => arr.reduce((s2, x) => s2 + (x.close - x.open), 0) / a;
  const pNow = press(win(0, 4)), pPrev = press(win(4, 8));
  const control = pNow > 0.3 ? 'Buyers' : pNow < -0.3 ? 'Sellers' : 'متوازن';
  const strength = Math.abs(pNow) > Math.abs(pPrev) ? 'بتزيد' : 'بتضعف';
  const r5 = win(0, 5).reduce((s2, x) => s2 + rng(x), 0) / 5 / a;
  const phase = r5 > 1.3 ? 'Expansion' : r5 < 0.7 ? 'Compression' : 'عادي';
  const pa = candlePattern(c);

  // ── SEQUENCE per side
  const setup = (d) => {
    const up = d === 'call';
    const steps = [];
    // A) sweep reversal
    const lvl = up ? sellSide : buySide;
    let sweepAt = -1;
    for (let i = n - 7; i <= n - 1; i++) if (up ? c[i].low < lvl && c[i].close > lvl - 0.1 * a : c[i].high > lvl && c[i].close < lvl + 0.1 * a) sweepAt = i;
    const reacted = sweepAt >= 0 && c.slice(sweepAt + 1).filter(x => (up ? x.close > lvl : x.close < lvl)).length >= 2;
    const minor = sweepAt >= 0 ? (up ? Math.max(...c.slice(Math.max(0, sweepAt - 5), sweepAt + 1).map(x => x.high)) : Math.min(...c.slice(Math.max(0, sweepAt - 5), sweepAt + 1).map(x => x.low))) : null;
    const mss = minor != null && (up ? price > minor : price < minor);
    const extreme = sweepAt >= 0 ? (up ? Math.min(...c.slice(sweepAt).map(x => x.low)) : Math.max(...c.slice(sweepAt).map(x => x.high))) : null;
    const notChased = extreme != null && Math.abs(price - extreme) <= 2.5 * a;
    const locA = (up ? location !== 'Premium' : location !== 'Discount') && (up ? (pos < 0.45 || (sup && price - sup.price < a)) : (pos > 0.55 || (res && res.price - price < a)));
    const A = [
      ['LOCATION', locA, up ? `${location}${sup ? `، دعم ${P(sup.price)}` : ''}` : `${location}${res ? `، مقاومة ${P(res.price)}` : ''}`],
      ['LIQUIDITY EVENT', sweepAt >= 0, sweepAt >= 0 ? `Sweep ${up ? 'Sell-side' : 'Buy-side'} ${P(lvl)} من ${n - sweepAt} شمعة` : NC],
      ['REACTION', reacted, reacted ? 'رجع جوه المستوى وكمّل شمعتين' : NC],
      ['STRUCTURE CONFIRMATION', mss, mss ? `MSS: قفل ${up ? 'فوق' : 'تحت'} ${P(minor)}` : NC],
      ['ENTRY', notChased && (up ? green(last) : red(last)), notChased ? 'مش مطاردة، والشمعة في الاتجاه' : 'السعر بعد عن نقطة الـ sweep'],
    ];
    // B) continuation: BOS with acceptance → retest → confirmation
    const br = up ? upBreak : dnBreak;
    const accepted = br && c.slice(br.at, br.at + 3).filter(x => (up ? x.close > br.level : x.close < br.level)).length >= 2;
    const retest = br && br.ago >= 2 && br.ago <= 20 && c.slice(n - 2).some(x => (up ? x.low <= br.level + 0.3 * a && x.close > br.level : x.high >= br.level - 0.3 * a && x.close < br.level));
    const confB = up ? last.close > c[n - 1].high : last.close < c[n - 1].low;
    const B = [
      ['LOCATION', (up ? structure === 'bull' : structure === 'bear') && (up ? pos < 0.85 : pos > 0.15), `Structure ${structure === 'bull' ? 'صاعد' : structure === 'bear' ? 'هابط' : 'مش واضح'}، ${location}`],
      ['LIQUIDITY EVENT', !!br, br ? `BOS ${dirAr[d]} عند ${P(br.level)} من ${br.ago} شمعة` : NC],
      ['REACTION', !!accepted, accepted ? 'Acceptance: شمعتين قفلوا برّه المستوى' : NC],
      ['STRUCTURE CONFIRMATION', !!retest, retest ? 'Retest للمستوى ومسك' : NC],
      ['ENTRY', confB, confB ? 'شمعة تأكيد كسرت الشمعة اللي قبلها' : NC],
    ];
    const ok = (S) => S.filter(x => x[1]).length;
    return ok(A) >= ok(B) ? { type: 'Sweep reversal', steps: A } : { type: 'Continuation (BOS → Retest)', steps: B };
  };
  const S = { call: setup('call'), put: setup('put') };
  const done = (d) => S[d].steps.filter(x => x[1]).length;

  // ── FALSE BREAKOUT FILTER + risk rules
  const fakeUp = res && c.slice(n - 3).some(x => x.high > res.price && x.close < res.price);
  const fakeDn = sup && c.slice(n - 3).some(x => x.low < sup.price && x.close > sup.price);
  const lateAbn = c.slice(-2).some(x => rng(x) > 2.5 * a);
  const vetoes = {
    call: [
      condition === 'Chop' && 'السوق Chop',
      location === 'Mid-range' && S.call.type.startsWith('Sweep') && 'السعر في نص الـ Range',
      fakeUp && S.call.type.startsWith('Continuation') && 'Fakeout محتمل فوق المقاومة',
      lateAbn && 'شمعة ممتدة من غير تأكيد',
      done('put') >= 3 && `السيناريو المعاكس قوي (${done('put')}/5)`,
    ].filter(Boolean),
    put: [
      condition === 'Chop' && 'السوق Chop',
      location === 'Mid-range' && S.put.type.startsWith('Sweep') && 'السعر في نص الـ Range',
      fakeDn && S.put.type.startsWith('Continuation') && 'Fakeout محتمل تحت الدعم',
      lateAbn && 'شمعة ممتدة من غير تأكيد',
      done('call') >= 3 && `السيناريو المعاكس قوي (${done('call')}/5)`,
    ].filter(Boolean),
  };
  const prim = done('call') >= done('put') ? 'call' : 'put', alt = prim === 'call' ? 'put' : 'call';
  const invalid = (d) => d === 'call' ? `إغلاق تحت ${P(Math.min(sellSide, last.low))}` : `إغلاق فوق ${P(Math.max(buySide, last.high))}`;
  const z = (zz) => zz ? `${P(zz.lo)}–${P(zz.hi)}${zz.mitigated ? ' (Mitigated)' : ''}${zz.broken ? ' (Broken)' : ''}` : NC;

  // ── PHASE 3: traps
  const run = (pred) => { let k = 0; for (let i = n; i >= 0 && pred(c[i]); i--) k++; return k; };
  const brokeAbove = res && c.slice(n - 6, n).some(x => x.close > res.price);
  const brokeBelow = sup && c.slice(n - 6, n).some(x => x.close < sup.price);
  const bullTrap = brokeAbove && price < res.price;      // broke out up, now back below → longs trapped
  const bearTrap = brokeBelow && price > sup.price;      // broke down, now back above → shorts trapped
  const failedRetestUp = upBreak && upBreak.ago <= 15 && price < upBreak.level - 0.2 * a;   // BOS up lost again
  const failedRetestDn = dnBreak && dnBreak.ago <= 15 && price > dnBreak.level + 0.2 * a;
  const wicky = c.slice(-3).filter(x => rng(x) > 0 && (rng(x) - body(x)) / rng(x) >= 0.6).length;
  const absorption = wicky >= 2 && Math.abs(price - c[n - 3].close) < 0.5 * a && (nearLevel(sup) || nearLevel(res));
  function nearLevel(l) { return l && Math.abs(price - l.price) <= 0.6 * a; }
  const overUp = run(green) >= 5 || (price - ema20[n]) > 2.5 * a, overDn = run(red) >= 5 || (ema20[n] - price) > 2.5 * a;
  const traps = [
    bullTrap && 'Bull trap: كسر المقاومة ورجع تحتها',
    bearTrap && 'Bear trap: كسر الدعم ورجع فوقه',
    failedRetestUp && 'Failed retest: BOS الصاعد اتلغى',
    failedRetestDn && 'Failed retest: BOS الهابط اتلغى',
    absorption && 'Absorption: ذيول كتير عند مستوى من غير حركة',
    overUp && 'Overextended صعود',
    overDn && 'Overextended هبوط',
  ].filter(Boolean);
  const trapAgainst = { call: bullTrap || failedRetestUp || overUp, put: bearTrap || failedRetestDn || overDn };

  // ── PHASE 6: three hypotheses
  const tDir = structure === 'bull' ? 'call' : structure === 'bear' ? 'put' : (shortTrend === 'up' ? 'call' : shortTrend === 'down' ? 'put' : null);
  const rDir = tDir ? (tDir === 'call' ? 'put' : 'call') : null;
  const ctrl = (d) => (d === 'call' ? pNow > 0.3 : pNow < -0.3);
  const hyp = (name, d, forList, againstList, confirm, inval) => {
    const f = forList.filter(x => x[1]).map(x => x[0]), ag = againstList.filter(x => x[1]).map(x => x[0]);
    return { name, dir: d, for: f, against: ag, score: f.length - ag.length, confirm, inval };
  };
  const H = [
    tDir ? hyp('A — Continuation', tDir, [
      ['الهيكل في الاتجاه', true], ['BOS حديث في الاتجاه', bos?.dir === tDir && bos.ago <= 20],
      ['المسيطرين في الاتجاه', ctrl(tDir)], ['Acceptance بعد الكسر', S[tDir].type.startsWith('Continuation') && S[tDir].steps[2][1]],
    ], [
      ['فخ ضد الاتجاه', trapAgainst[tDir]], ['السيطرة بتضعف', ctrl(tDir) && strength === 'بتضعف'],
      ['Sweep عكسي', S[rDir].type.startsWith('Sweep') && S[rDir].steps[1][1]], ['Fakeout', tDir === 'call' ? fakeUp : fakeDn],
    ], S[tDir].steps.filter(x => !x[1]).map(x => x[0]).join(' · ') || 'متحقق', invalid(tDir)) : null,
    rDir ? hyp('B — Reversal', rDir, [
      ['Sweep للسيولة + Reaction', S[rDir].type.startsWith('Sweep') && S[rDir].steps[2][1]],
      ['MSS/CHOCH', choch?.dir === rDir || (S[rDir].type.startsWith('Sweep') && S[rDir].steps[3][1])],
      ['فخ للي ماشيين مع الاتجاه', trapAgainst[tDir]], ['Exhaustion', tDir === 'call' ? overUp : overDn],
    ], [
      ['الهيكل لسه قوي', bulls >= 4 || bulls === 0], ['مفيش MSS', !(S[rDir].steps[3][1])],
      ['المسيطرين لسه مع الاتجاه', ctrl(tDir) && strength === 'بتزيد'],
    ], S[rDir].steps.filter(x => !x[1]).map(x => x[0]).join(' · ') || 'متحقق', invalid(rDir)) : null,
    hyp('C — Range / No Trade', null, [
      ['السوق Range أو Chop', condition !== 'Trend'], ['السعر في نص الـ Range', location === 'Mid-range'],
      ['Compression', phase === 'Compression'], ['السيطرة متوازنة', control === 'متوازن'],
    ], [['Trend واضح', condition === 'Trend'], ['Expansion', phase === 'Expansion']],
      'كسر واضح لحدود الـ Range مع Acceptance', `كسر ${P(hi60)} أو ${P(lo60)}`),
  ].filter(Boolean);
  // A directional thesis must have completed its full entry sequence and carry at least
  // as much net evidence as the Range thesis; otherwise the strongest thesis (often C) stands.
  const rangeH = H.find(h => !h.dir);
  const ready = H.filter(h => h.dir && done(h.dir) === 5 && h.score >= 1 && h.score >= rangeH.score).sort((x, y) => y.score - x.score);
  const best = ready[0] || H.reduce((x, y) => (y.score > x.score ? y : x));

  // ── PHASE 7/8: cross-validation and grade
  const d0 = best.dir;
  const full = d0 && done(d0) === 5;
  const hard = d0 ? vetoes[d0].filter(v => !/السيناريو المعاكس/.test(v)) : [];
  const counterStrong = d0 && done(d0 === 'call' ? 'put' : 'call') >= 3;
  const grade = !d0 || !full || hard.length || trapAgainst[d0] ? 'C' : !counterStrong && best.against.length === 0 ? 'A' : 'B';
  const go = grade !== 'C' && !(grade === 'B' && counterStrong);
  const finalDir = go ? d0 : null;

  // ── PHASE 1: "what is price doing now, and why?"
  const story = [
    `السوق ${condition === 'Trend' ? 'في Trend' : condition === 'Chop' ? 'Choppy' : 'في Range'}`,
    `${control === 'متوازن' ? 'والسيطرة متوازنة' : `و${control === 'Buyers' ? 'المشترين' : 'البايعين'} مسيطرين والسيطرة ${strength}`}`,
    S.call.steps[1][1] && S.call.type.startsWith('Sweep') ? 'بعد ما أخد سيولة تحت' : S.put.steps[1][1] && S.put.type.startsWith('Sweep') ? 'بعد ما أخد سيولة فوق' :
      bos ? `بعد BOS ${dirAr[bos.dir]}` : choch ? `بعد CHOCH ${dirAr[choch.dir]}` : '',
    `والسعر دلوقتي في ${location === 'Premium' ? 'منطقة غالية (Premium)' : location === 'Discount' ? 'منطقة رخيصة (Discount)' : 'نص الـ Range'}`,
  ].filter(Boolean).join(' ');

  const zoneRow = (label, zz) => [label, zz ? `${P(zz.lo)}–${P(zz.hi)} · ${zz.mitigated ? 'اتختبرت' : 'Fresh'}${zz.broken ? ' · اتكسرت' : ''}` : NC];
  const hypRows = H.flatMap(h => [
    [h.name + (h.dir ? ` (${dirAr[h.dir]})` : ''), `مع: ${h.for.join('، ') || '—'} | ضد: ${h.against.join('، ') || '—'}`],
    ['   تأكيد مطلوب / إلغاء', `${h.confirm} | ${h.inval}`],
  ]);

  const sections = [
    ['PHASE 1 — MARKET RECONSTRUCTION', [
      ['Trend', `الرئيسي ${{ up: 'صاعد', down: 'هابط', flat: 'عرضي' }[mainTrend]} · الحالي ${{ up: 'صاعد', down: 'هابط', flat: 'عرضي' }[shortTrend]}`],
      ['Structure', recent.length ? `${recent.join(' · ')} → ${{ bull: 'صاعد', bear: 'هابط', mixed: 'متلخبط', unclear: NC }[structure]}` : NC],
      ['BOS / CHOCH', `${bos ? `BOS ${dirAr[bos.dir]} (${bos.ago} شمعة)` : 'BOS ' + NC} · ${choch ? `CHOCH ${dirAr[choch.dir]} (${choch.ago} شمعة)` : 'CHOCH ' + NC}`],
      ['Range', `${P(lo60)} – ${P(hi60)} · ${phase}`],
      ['السعر بيعمل إيه؟', story],
    ]],
    ['PHASE 2 — LIQUIDITY HUNT', [
      ['Buy-side', `${P(buySide)}${eqH ? ' (Equal highs)' : ''}`],
      ['Sell-side', `${P(sellSide)}${eqL ? ' (Equal lows)' : ''}`],
      ['الأقرب', Math.abs(buySide - price) < Math.abs(price - sellSide) ? `فوق عند ${P(buySide)}` : `تحت عند ${P(sellSide)}`],
      ['اتاخدت؟', S[prim].type.startsWith('Sweep') && S[prim].steps[1][1] ? `${S[prim].steps[1][2]} → ${S[prim].steps[2][1] ? 'Rejection' : 'لسه مفيش رد فعل'}` : NC],
    ]],
    ['PHASE 3 — TRAP DETECTION', traps.length ? traps.map(t => ['⚠', t]) : [['Traps', 'مفيش فخ واضح']]],
    ['PHASE 4 — SMART MONEY MAP', [
      zoneRow('Demand / Bullish OB', demand), zoneRow('Supply / Bearish OB', supply),
      zoneRow('FVG صاعد', fvgUp), zoneRow('FVG هابط', fvgDn),
      ['Breaker', breakerUp ? 'صاعد بيتعمله Retest' : breakerDn ? 'هابط بيتعمله Retest' : NC],
      ['Displacement', disp ? `${dirAr[disp.dir]} من ${n - disp.i} شمعة` : NC],
      ['Premium / Discount', location],
    ]],
    ['PHASE 5 — CANDLE PSYCHOLOGY', [
      ['Control', control === 'متوازن' ? 'Balanced' : `${control} ${strength === 'بتزيد' ? 'Gaining control' : 'Losing control'}`],
      ['Behavior', `${phase}${wicky >= 2 ? ' · Wick rejection' : ''}${absorption ? ' · Absorption' : ''}${overUp || overDn ? ' · Exhaustion risk' : ''}`],
    ]],
    ['PHASE 6 — THREE-HYPOTHESIS TEST', hypRows],
    ['PHASE 7/8 — VALIDATION & GRADE', [
      ['Cross-validation', d0 ? S[d0].steps.map(([k, ok]) => `${ok ? '✓' : '✗'} ${k}`).join(' · ') : 'مفيش اتجاه مرشّح'],
      ['Grade', `${grade}${grade === 'A' ? ' — Strong confluence' : grade === 'B' ? ' — Moderate confluence' : ' — Weak / No trade'}`],
    ]],
    ['PHASE 9 — FINAL DECISION', [
      ['PRIMARY THESIS', `${best.name}${best.dir ? ` (${dirAr[best.dir]})` : ''}`],
      ['COUNTER THESIS', H.filter(h => h !== best).sort((x, y) => y.score - x.score)[0]?.name || '—'],
      ['TRIGGER', d0 ? (S[d0].steps.find(x => !x[1])?.[0] || 'متحقق') : 'كسر حدود الـ Range'],
      ['INVALIDATION', best.inval],
      ['MAIN RISK', hard[0] || traps[0] || (counterStrong ? 'السيناريو المعاكس قوي' : 'أقرب مستوى سيولة ضد الصفقة')],
      ['FINAL', finalDir ? finalDir.toUpperCase() : 'NO TRADE'],
    ]],
  ];
  return {
    verdict: finalDir ? finalDir.toUpperCase() : 'NO TRADE',
    why: finalDir ? `Grade ${grade} · ${best.name}` : `Grade ${grade}${hard[0] ? ` · ${hard[0]}` : d0 ? ` · ${done(d0)}/5 خطوات` : ' · مفيش أفضلية'}`,
    sections, seq: { call: S.call.steps, put: S.put.steps }, vetoes, finalDir,
  };
}

Strategies.engine = {
  title: 'OTC 9-phase engine',
  family: 'confluence',
  required: 5,
  checks(c, ind) {
    const r = smcEngine(c, ind);
    if (!r.seq.call.length) return [{ label: 'Data', call: false, put: false }];
    // All five sequence steps are reported; the trade itself needs grade A/B (finalDir).
    return r.seq.call.map(([label], i) => ({ label, call: r.finalDir === 'call', put: r.finalDir === 'put' }));
  },
};

// ── Short-term scalping mode. Reads the micro-structure (last ~30 candles,
// 1-bar fractals) for two setups and keeps only the strongest:
//   S1 Sweep → Rejection: a micro swing is swept and closed back inside, with
//      a rejection wick or follow-through, then a confirmation close.
//   S2 Breakout → Retest: a micro swing broken with a strong close that holds
//      (no close back through = no fakeout), retested, then confirmation.
// The larger structure is only a filter. Choppy → NO TRADE. Extended → NO TRADE.
// Both directions valid at once → NO TRADE. Quality C → NO TRADE.
// Hunter = scalping with more setup types and grade B allowed ("clear and confirmed
// enough"), and a SIGNAL/Reason/Trigger/Confirmation/Invalidation/Risk report.
const HUNTER_OPTS = { accept: ['A', 'B'], extra: true, format: 'hunter' };

function scalpEngine(c, ind, opts = { accept: ['A'], extra: false, format: 'scalp' }) {
  const n = c.length - 1, NC = 'NOT CONFIRMED';
  const { ema20, ema50, ema9, atr, adx } = ind;
  const none = (why) => ({ verdict: 'NO TRADE', why, fields: [], finalDir: null });
  if (n < 60 || ema50[n - 10] == null || atr[n] == null) return none('بيانات غير كافية');
  const a = atr[n], last = c[n], price = last.close;
  const P = (x) => (x == null ? '—' : x.toFixed(price < 10 ? 5 : 3));
  const body = (x) => Math.abs(x.close - x.open), rng = (x) => x.high - x.low || 1e-12;

  // micro swings (1 bar each side) over the last 30 candles, confirmed (not the live bar)
  const micro = swings(c, 1, 30);
  const mH = micro.highs.filter(x => x.i <= n - 2), mL = micro.lows.filter(x => x.i <= n - 2);
  const [h1, h2] = mH.slice(-2), [l1, l2] = mL.slice(-2);
  const microTrend = h1 && h2 && l1 && l2
    ? (h2.price > h1.price && l2.price > l1.price ? 'up' : h2.price < h1.price && l2.price < l1.price ? 'down' : 'flat') : 'flat';

  // larger context as a filter only
  const slope50 = (ema50[n] - ema50[n - 10]) / a, adxN = adx.adx[n] ?? 0;
  const big = slope50 > 0.3 && price > ema50[n] ? 'up' : slope50 < -0.3 && price < ema50[n] ? 'down' : 'flat';
  const bigStrong = big !== 'flat' && adxN >= 25 && Math.abs(slope50) > 0.6;
  let path = 0; for (let i = n - 11; i <= n; i++) path += Math.abs(c[i].close - c[i - 1].close);
  const er = path ? Math.abs(price - c[n - 12].close) / path : 0;
  const choppy = er < 0.12 && microTrend === 'flat';
  const runLen = (pred) => { let k = 0; for (let i = n; i >= 0 && pred(c[i]); i--) k++; return k; };
  const extended = (d) => (d === 'call'
    ? price - ema20[n] > 2 * a || (runLen(green) >= 4 && price - c[n - runLen(green)].close > 3 * a)
    : ema20[n] - price > 2 * a || (runLen(red) >= 4 && c[n - runLen(red)].close - price > 3 * a));

  const setups = [];
  for (const d of ['call', 'put']) {
    const up = d === 'call', swingArr = up ? mL : mH, brkArr = up ? mH : mL;
    // S1: sweep → rejection → confirmation
    const lvl = swingArr.filter(x => x.i <= n - 3).slice(-1)[0];
    if (lvl) {
      for (const k of [n - 1, n]) {
        const x = c[k];
        const swept = up ? x.low < lvl.price && x.close > lvl.price : x.high > lvl.price && x.close < lvl.price;
        if (!swept) continue;
        const wick = up ? (Math.min(x.open, x.close) - x.low) / rng(x) : (x.high - Math.max(x.open, x.close)) / rng(x);
        const confirm = up ? green(last) && last.close > c[n - 1].high : red(last) && last.close < c[n - 1].low;
        const follow = k < n && (up ? last.close > x.high : last.close < x.low);
        if (!(confirm && (wick >= 0.5 || follow))) continue;
        setups.push({ d, type: 'Sweep → Rejection', level: lvl.price, strength: wick + body(last) / a,
          liquidity: `${up ? 'Sell-side' : 'Buy-side'} ${P(lvl.price)} اتاخدت ورجع جوه`,
          trigger: `Sweep ${up ? 'تحت' : 'فوق'} ${P(lvl.price)} وذيل رفض ${(wick * 100).toFixed(0)}%`,
          confirmation: up ? 'شمعة خضرا قفلت فوق قمة اللي قبلها' : 'شمعة حمرا قفلت تحت قاع اللي قبلها',
          invalid: up ? Math.min(x.low, last.low) : Math.max(x.high, last.high), reversal: true });
        break;
      }
    }
    // S2: breakout → retest → confirmation
    const br = brkArr.filter(x => x.i <= n - 3).slice(-1)[0];
    if (br) {
      const k = c.findIndex((x, i) => i > br.i && i >= n - 8 && i <= n - 2 && (up ? x.close > br.price : x.close < br.price));
      if (k > 0) {
        const bc = c[k];
        const strongBreak = body(bc) >= 0.5 * a;
        const fakeout = c.slice(k + 1).some(x => (up ? x.close < br.price : x.close > br.price));
        const retest = [c[n - 1], last].some(x => (up ? x.low <= br.price + 0.25 * a && x.close > br.price : x.high >= br.price - 0.25 * a && x.close < br.price));
        const confirm = up ? green(last) && last.close > c[n - 1].high : red(last) && last.close < c[n - 1].low;
        if (strongBreak && !fakeout && retest && confirm) {
          setups.push({ d, type: 'Breakout → Retest', level: br.price, strength: body(bc) / a + body(last) / a,
            liquidity: `${up ? 'Buy-side فوق' : 'Sell-side تحت'} ${P(br.price)} اتكسرت ومسكت`,
            trigger: `كسر ${P(br.price)} بشمعة قوية من ${n - k} شمعة، ورجع عليه`,
            confirmation: up ? 'Retest مسك وشمعة خضرا كسرت قمة اللي قبلها' : 'Retest مسك وشمعة حمرا كسرت قاع اللي قبلها',
            invalid: up ? br.price - 0.3 * a : br.price + 0.3 * a, reversal: false });
        }
      }
    }
  }

  if (opts.extra) {
    const box = c.slice(n - 6, n), boxHi = Math.max(...box.map(x => x.high)), boxLo = Math.min(...box.map(x => x.low));
    for (const d of ['call', 'put']) {
      const up = d === 'call';
      const conf = up ? green(last) && last.close > c[n - 1].high : red(last) && last.close < c[n - 1].low;
      // S3 pullback in the micro trend to EMA9, then resumption
      if (microTrend === (up ? 'up' : 'down') && conf
          && (up ? c[n - 1].low <= ema9[n - 1] + 0.1 * a && red(c[n - 1]) : c[n - 1].high >= ema9[n - 1] - 0.1 * a && green(c[n - 1]))) {
        setups.push({ d, type: 'Pullback → Continuation', level: ema9[n - 1], strength: 0.8 + body(last) / a,
          liquidity: `Pullback لـ EMA9 عند ${P(ema9[n - 1])}`, trigger: 'شمعة عكسية لمست EMA9 في اتجاه الـ micro trend',
          confirmation: up ? 'شمعة خضرا كمّلت فوق قمة الـ pullback' : 'شمعة حمرا كمّلت تحت قاع الـ pullback',
          invalid: up ? c[n - 1].low - 0.1 * a : c[n - 1].high + 0.1 * a, reversal: false });
      }
      // S4 failed breakout (trap): broke a micro swing, now closes back through it decisively
      const sw = (up ? mL : mH).filter(x => x.i <= n - 3).slice(-1)[0];
      if (sw && c.slice(n - 3, n).some(x => (up ? x.close < sw.price : x.close > sw.price))
          && (up ? last.close > sw.price + 0.2 * a : last.close < sw.price - 0.2 * a) && body(last) >= 0.5 * a && conf) {
        setups.push({ d, type: 'Failed breakout (trap)', level: sw.price, strength: 1 + body(last) / a,
          liquidity: `${up ? 'Bear trap تحت' : 'Bull trap فوق'} ${P(sw.price)}`, trigger: `كسر ${P(sw.price)} وفشل ورجع بقوة`,
          confirmation: 'شمعة قوية قفلت راجعة جوه المستوى', invalid: up ? Math.min(...c.slice(n - 3).map(x => x.low)) : Math.max(...c.slice(n - 3).map(x => x.high)), reversal: true });
      }
      // S5 compression → expansion out of a tight 6-candle box
      if (boxHi - boxLo < 1.2 * a && (up ? last.close > boxHi : last.close < boxLo) && body(last) >= a && body(last) >= 0.7 * rng(last)) {
        setups.push({ d, type: 'Compression → Expansion', level: up ? boxHi : boxLo, strength: body(last) / a,
          liquidity: `${up ? 'كسر قمة' : 'كسر قاع'} صندوق الانضغاط ${P(up ? boxHi : boxLo)}`, trigger: `6 شموع ضيقة (${((boxHi - boxLo) / a).toFixed(1)}×ATR) وبعدين Displacement`,
          confirmation: 'شمعة زخم قفلت برّه الصندوق قريب من طرفها', invalid: up ? boxLo : boxHi, reversal: false });
      }
      // S6 engulfing at a micro level
      const pa = candlePattern(c), lvl = (up ? mL : mH).slice(-1)[0];
      if (lvl && /engulfing/i.test(pa.name) && pa.dir === d && Math.abs((up ? last.low : last.high) - lvl.price) <= 0.3 * a) {
        setups.push({ d, type: 'Engulfing at level', level: lvl.price, strength: 0.6 + body(last) / a,
          liquidity: `عند ${up ? 'قاع' : 'قمة'} ${P(lvl.price)}`, trigger: pa.name, confirmation: 'الشمعة ابتلعت اللي قبلها عند المستوى',
          invalid: up ? last.low - 0.1 * a : last.high + 0.1 * a, reversal: true });
      }
    }
  }

  // filters → quality
  const judged = setups.map((st) => {
    const against = (st.d === 'call' && big === 'down') || (st.d === 'put' && big === 'up');
    const why = [];
    if (choppy) why.push('الحركة Choppy');
    if (extended(st.d)) why.push('الحركة ممتدة — مطاردة');
    if (bigStrong && against && !st.reversal) why.push('ضد Structure كبير قوي');
    if (bigStrong && against && st.reversal && !(st.d === 'call' ? price > (h2?.price ?? Infinity) : price < (l2?.price ?? -Infinity))) why.push('عكس Structure قوي من غير MSS');
    const quality = why.length ? 'C' : st.strength >= 1.6 && !against ? 'A' : 'B';
    return { ...st, why, quality, against };
  });
  // Scalping: only grade A trades (B reported, not taken). Hunter: A or B.
  const valid = judged.filter(x => opts.accept.includes(x.quality));
  const dirs = new Set(valid.map(x => x.d));
  const pick = dirs.size === 1 ? valid.sort((x, y) => y.strength - x.strength)[0] : null;
  const shown = pick || judged.sort((x, y) => y.strength - x.strength)[0] || null;
  const ar = { call: 'صاعد', put: 'هابط', up: 'صاعد', down: 'هابط', flat: 'عرضي' };
  const diag = { choppy, big, bigStrong, a, price, microHigh: h2?.price ?? null, microLow: l2?.price ?? null,
    extended: { call: extended('call'), put: extended('put') }, validDirs: [...dirs] };

  const fields = [
    ['MICRO TREND', `${ar[microTrend]} · السياق الأكبر ${ar[big]}${bigStrong ? ' (قوي)' : ''}${choppy ? ' · Choppy' : ''}`],
    ['KEY LEVEL', shown ? P(shown.level) : `آخر قمة ${P(h2?.price)} · آخر قاع ${P(l2?.price)}`],
    ['LIQUIDITY', shown ? shown.liquidity : `فوق ${P(h2?.price)} · تحت ${P(l2?.price)} — ${NC}`],
    ['TRIGGER', shown ? `${shown.type}: ${shown.trigger}` : NC],
    ['CONFIRMATION', shown ? shown.confirmation : NC],
    ['INVALIDATION', shown ? `إغلاق ${shown.d === 'call' ? 'تحت' : 'فوق'} ${P(shown.invalid)}` : '—'],
    ['SETUP QUALITY', pick ? 'A' : dirs.size > 1 ? 'C — Setups متعارضة في نفس المنطقة'
      : shown?.quality === 'B' ? 'B — مقبول بس مش كفاية للدخول' : shown ? `C — ${shown.why.join('، ')}` : 'C — مفيش Setup'],
    ['SIGNAL', pick ? pick.d.toUpperCase() : 'NO TRADE'],
  ];
  if (opts.format === 'hunter') {
    const risk = pick ? (pick.against ? 'ضد السياق الأكبر' : pick.quality === 'B' ? 'تأكيد متوسط (B)' : 'أقرب سيولة عكسية') : null;
    return {
      verdict: pick ? pick.d.toUpperCase() : 'NO TRADE',
      why: pick ? `${pick.type} · ${pick.quality}` : dirs.size > 1 ? 'Setups متعارضة' : shown ? shown.why[0] || 'مفيش Trigger واضح' : 'مفيش Setup — بيعيد التقييم مع كل شمعة',
      fields: pick ? [
        ['SIGNAL', pick.d.toUpperCase()], ['Reason', `${pick.type} · ${pick.liquidity}`], ['Trigger', pick.trigger],
        ['Confirmation', pick.confirmation], ['Invalidation', `إغلاق ${pick.d === 'call' ? 'تحت' : 'فوق'} ${P(pick.invalid)}`], ['Risk', risk],
      ] : [['SIGNAL', 'NO TRADE'], ['Reason', shown ? (shown.why[0] || `${shown.type} مش مؤكد كفاية`) : choppy ? 'الحركة Choppy' : 'مفيش Trigger واضح دلوقتي']],
      finalDir: pick ? pick.d : null, diag,
    };
  }
  return {
    verdict: pick ? pick.d.toUpperCase() : 'NO TRADE',
    why: pick ? `${pick.type} · Quality A` : dirs.size > 1 ? 'Setups متعارضة'
      : shown?.quality === 'B' ? `${shown.type} · Quality B — مش كفاية` : shown ? shown.why[0] || 'Quality C' : choppy ? 'الحركة Choppy' : 'مفيش أفضلية واضحة — مستني',
    fields, finalDir: pick ? pick.d : null, diag,
  };
}

// "Copy + verify": follow a PO copy signal only when the chart doesn't argue against it.
// Returns the list of objections (empty = take it).
function copyPlusObjections(diag, dir) {
  if (!diag) return ['بيانات غير كافية'];
  const up = dir === 'call', why = [];
  if (diag.choppy) why.push('الحركة Choppy');
  if (diag.extended[dir]) why.push('الحركة ممتدة — هيبقى مطاردة');
  if (diag.validDirs.includes(up ? 'put' : 'call')) why.push('فيه Setup واضح في الاتجاه العكسي');
  if (diag.bigStrong && diag.big === (up ? 'down' : 'up')) why.push('ضد Structure كبير قوي');
  const wall = up ? diag.microHigh : diag.microLow;
  if (wall != null && (up ? wall - diag.price : diag.price - wall) >= 0 && Math.abs(wall - diag.price) <= 0.3 * diag.a) {
    why.push(up ? 'مقاومة قريبة جداً فوق السعر' : 'دعم قريب جداً تحت السعر');
  }
  return why;
}

Strategies.hunter = {
  title: 'Opportunity hunter',
  family: 'scalp',
  required: 1,
  checks(c, ind) {
    const r = scalpEngine(c, ind, HUNTER_OPTS);
    return [{ label: r.why, call: r.finalDir === 'call', put: r.finalDir === 'put' }];
  },
};

Strategies.scalp = {
  title: 'Scalping mode',
  family: 'scalp',
  required: 1,
  checks(c, ind) {
    const r = scalpEngine(c, ind);
    return [{ label: r.why, call: r.finalDir === 'call', put: r.finalDir === 'put' }];
  },
};

// Fade variants: take the exact opposite side whenever a trend strategy fires
// (same moment, same filters). On OTC pairs the trend strategies' paper record
// sits around 42–46%, i.e. price tends to snap back; these test that on fresh data.
for (const base of ['trend', 'macd', 'pullback']) {
  Strategies[`${base}Fade`] = { title: `${Strategies[base].title} — fade`, family: 'fade', fadeOf: base, checks: () => [] };
}

// Pocket Option's own Signals feed. Not computed from candles — bot.js injects its
// result each candle from the live feed — but listed here so it is paper-tested,
// ranked and gated exactly like the others.
Strategies.posignal = { title: 'PO Signals', family: 'external', external: true, checks: () => [] };
Strategies.copysig = { title: 'PO Copy signals', family: 'external', external: true, checks: () => [] };
Strategies.copyplus = { title: 'PO Copy + verify', family: 'external', external: true, checks: () => [] };

const STRATEGY_NAMES = Object.keys(Strategies);

function computeIndicators(c) {
  const closes = c.map(x => x.close);
  return {
    closes,
    bb: Ind.bollinger(closes, 20, 2),
    rsi: Ind.rsi(closes, 14),
    ema9: Ind.ema(closes, 9),
    ema21: Ind.ema(closes, 21),
    ema20: Ind.ema(closes, 20),
    ema9: Ind.ema(closes, 9),
    ema50: Ind.ema(closes, 50),
    stoch: Ind.stochastic(c, 14, 3, 3),
    macd: Ind.macd(closes, 12, 26, 9),
    atr: Ind.atr(c, 14),
    adx: Ind.adx(c, 14),
    sma20: Ind.sma(closes, 20),
    cci: Ind.cci(c, 20),
    awesome: Ind.awesome(c),
    roc: Ind.roc(closes, 9),
    willr: Ind.williamsR(c, 14),
    psar: Ind.psar(c),
    lastRangeAtr: (() => { const a = Ind.atr(c, 14)[c.length - 2]; const x = c[c.length - 1]; return a ? (x.high - x.low) / a : 0; })(),
  };
}

// Market-wide filters. `skip` vetoes every strategy; the ADX regime gates by family.
function marketFilters(c, ind) {
  const n = c.length - 1, last = c[n];
  const atrPrev = ind.atr[n - 1];
  const adx = ind.adx.adx[n], pdi = ind.adx.plusDI[n], mdi = ind.adx.minusDI[n];
  const flatBars = c.slice(-10).filter(x => x.high === x.low).length;
  const spike = atrPrev > 0 && last.high - last.low > 2.5 * atrPrev;
  const flat = !(atrPrev > 0) || flatBars >= 5;
  return {
    adx, pdi, mdi, spike, flat,
    skip: spike ? 'Spike candle' : flat ? 'Market too flat' : null,
    bias: pdi > mdi ? 'call' : mdi > pdi ? 'put' : null,
  };
}

function regimeBlock(family, dir, f) {
  if (f.adx == null || family === 'confluence' || family === 'scalp') return null;
  if (family === 'reversal' && f.adx >= 30 && f.bias && f.bias !== dir) return 'Against strong trend';
  if (family === 'trend' && f.adx < 20) return 'No trend (ADX<20)';
  if (family === 'trend' && f.bias && f.bias !== dir) return 'Against DI direction';
  return null;
}

// Runs every strategy. Per strategy:
//   raw     — direction its own checks point to (null if not enough agree)
//   action  — raw after the market filters (what it would actually trade)
function evaluateAll(candles, required) {
  if (candles.length < MIN_CANDLES) return { ready: false, results: {}, filters: null };
  const ind = computeIndicators(candles);
  const filters = marketFilters(candles, ind);
  const results = {};
  for (const name of STRATEGY_NAMES) {
    const st = Strategies[name];
    if (st.external) continue;
    if (st.fadeOf) {
      const b = results[st.fadeOf], flip = { call: 'put', put: 'call' };
      results[name] = { checks: b.checks.map(x => ({ label: x.label, call: x.put, put: x.call })),
        calls: b.puts, puts: b.calls, raw: flip[b.raw] || null, blocked: b.blocked, action: flip[b.action] || null };
      continue;
    }
    const checks = st.checks(candles, ind);
    const calls = checks.filter(x => x.call).length, puts = checks.filter(x => x.put).length;
    const need = st.required ?? required;
    const raw = calls >= need && calls > puts ? 'call' : puts >= need && puts > calls ? 'put' : null;
    // Scalp/confluence engines run their own chop/extension/fakeout filters (and a breakout
    // candle is often what they trade), so the generic spike/flat veto would contradict them.
    const ownFilters = st.family === 'scalp' || st.family === 'confluence';
    const blocked = raw ? ((!ownFilters && filters.skip) || regimeBlock(st.family, raw, filters)) : null;
    results[name] = { checks, calls, puts, raw, blocked, action: raw && !blocked ? raw : null };
  }
  return { ready: true, results, filters, ind };
}

// Turns per-strategy results into one decision.
//   mode = a strategy name → that strategy alone
//   mode = 'consensus'     → at least `minVotes` strategies agree, none disagree
//   mode = 'auto'          → only strategies in `eligible` (proven by shadow stats)
//                            may trigger, and no strategy at all may disagree
//   `benched` — strategies whose paper record is already below break-even; they
//               keep paper-testing but never vote
function decide(ev, mode, { minVotes = 2, eligible = new Set(), benched = new Set() } = {}) {
  if (!ev.ready) return { action: null, reason: 'warming_up', voters: [] };
  const r = ev.results;
  if (Strategies[mode]) {
    const x = r[mode] || { action: null, blocked: null };
    if (benched.has(mode) && x.action) return { action: null, reason: 'benched', voters: [] };
    return { action: x.action, reason: x.action ? null : x.blocked || 'no_setup', voters: x.action ? [mode] : [] };
  }
  const voters = (dir, pool) => pool.filter(n => !benched.has(n) && r[n]?.action === dir);
  for (const dir of ['call', 'put']) {
    const other = dir === 'call' ? 'put' : 'call';
    const opposed = voters(other, STRATEGY_NAMES).length > 0;
    if (mode === 'auto') {
      const v = voters(dir, STRATEGY_NAMES.filter(n => eligible.has(n)));
      if (v.length && !opposed) return { action: dir, reason: null, voters: v };
    } else {
      const v = voters(dir, STRATEGY_NAMES);
      if (v.length >= minVotes && !opposed) return { action: dir, reason: null, voters: v };
    }
  }
  if (mode === 'auto' && eligible.size === 0) return { action: null, reason: 'learning', voters: [] };
  return { action: null, reason: ev.filters.skip || 'no_setup', voters: [] };
}
