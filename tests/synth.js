// Synthetic 5M candles for discovery tests. `edge`: after a candle whose lower wick is
// at least half its range, the next candle is green with probability `edge`.
const { rng } = require('./load.js');
function planted({ n = 4000, start = 1_700_000_000 - (1_700_000_000 % 3600), price = 1.08, vol = 0.0005, edge = 0.72, seed = 11 } = {}) {
  const r = rng(seed), out = [];
  let p = price, longWick = false;
  for (let i = 0; i < n; i++) {
    const up = r() < (longWick ? edge : 0.5);
    const body = vol * (0.2 + r() * 0.8), o = p, c = o + (up ? body : -body);
    const lw = r() < 0.15 ? body * 2 + vol * r() : vol * r() * 0.4, uw = vol * r() * 0.5;
    const hi = Math.max(o, c) + uw, lo = Math.min(o, c) - lw;
    out.push({ time: start + i * 300, open: +o.toFixed(6), high: +hi.toFixed(6), low: +lo.toFixed(6), close: +c.toFixed(6) });
    longWick = lw / (hi - lo) >= 0.5;
    p = c;
  }
  return out;
}
module.exports = { planted };
