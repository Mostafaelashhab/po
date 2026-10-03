// Offline replay of every candle strategy over historical candles, scored the
// same way as live paper trades: enter at a candle's close, win if price is on
// the right side `expiry` seconds later, one open trade per strategy+expiry.
const BT_WINDOW = 120; // candles fed to the indicators per step (EMA50 needs 50; the analyst wants ~80 for swings)

// Merges base candles (e.g. PO's 5s chart candles) into `period`-second candles.
function aggregateCandles(base, period) {
  const out = [];
  for (const c of base) {
    const t = Math.floor(c.time / period) * period;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
    } else out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
  }
  return out;
}

// Smallest gap between consecutive candle times = the feed's resolution.
function candleResolution(base) {
  let best = Infinity;
  for (let i = 1; i < base.length; i++) {
    const d = base[i].time - base[i - 1].time;
    if (d > 0 && d < best) best = d;
  }
  return Number.isFinite(best) ? best : null;
}

// Returns { stats: { name: { expiry: { w, l, t, byHour: { hour: { w, l, t } } } } }, bars, from, to }
// byHour (keyed by the entry's hour) lets separate runs be merged without double counting.
// `countFrom` (optional): only trades entered at/after this time are scored —
// earlier candles still warm up the indicators. Used for out-of-sample checks.
function runBacktest(baseCandles, { period, required, expiries, countFrom = -Infinity }) {
  const candles = aggregateCandles(baseCandles, period);
  const stats = {};
  const busyUntil = {};      // "name|expiry" → time the open paper trade closes
  const closeAt = new Map(candles.map((c, i) => [c.time + period, i])); // candle close time → index
  const names = STRATEGY_NAMES.filter(n => !Strategies[n].external);

  for (let i = MIN_CANDLES; i < candles.length; i++) {
    const entryTime = candles[i].time + period, entry = candles[i].close;
    if (entryTime < countFrom) continue;
    const ev = evaluateAll(candles.slice(Math.max(0, i + 1 - BT_WINDOW), i + 1), required);
    if (!ev.ready) continue;
    for (const name of names) {
      const dir = ev.results[name]?.action;
      if (!dir) continue;
      for (const expiry of expiries) {
        const key = `${name}|${expiry}`;
        if ((busyUntil[key] ?? -Infinity) > entryTime) continue;
        // Exit at the candle that closes exactly at entry + expiry; skip if a gap in data hides it.
        const j = closeAt.get(entryTime + expiry);
        if (j == null) continue;
        busyUntil[key] = entryTime + expiry;
        const moved = candles[j].close - entry;
        const res = moved === 0 ? 't' : (moved > 0) === (dir === 'call') ? 'w' : 'l';
        const s = ((stats[name] ||= {})[expiry] ||= { w: 0, l: 0, t: 0, byHour: {} });
        s[res]++;
        const h = (s.byHour[Math.floor(entryTime / 3600)] ||= { w: 0, l: 0, t: 0 });
        h[res]++;
      }
    }
  }
  return { stats, bars: candles.length, from: candles[0]?.time, to: candles[candles.length - 1]?.time };
}
