// Loads the browser scripts into one Node vm context, the way Chrome loads
// content scripts (shared global scope, top-level const visible across files).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ENGINE_FILES = [
  'indicators.js',
  'engine/core.js', 'engine/dataquality.js', 'engine/features.js', 'engine/regime.js',
  'engine/factory.js', 'engine/library.js', 'engine/confluence.js', 'engine/contradiction.js',
  'engine/risk.js', 'engine/pipeline.js', 'engine/stats.js', 'engine/replay.js',
  'engine/feed.js', 'engine/orchestrator.js',
  'engine/featurelib.js', 'engine/discovery.js', 'engine/discovery-search.js', 'engine/discovery-assess.js', 'engine/lifecycle.js', 'engine/facts.js',
  'engine/expiry.js', 'engine/copytrade.js', 'engine/opportunity.js', 'engine/calibration.js', 'engine/frameselect.js', 'ui/ar.js',
];

function load(files = ENGINE_FILES) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Date, Math, JSON, Map, Set, Promise });
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f });
  }
  // top-level const declarations aren't properties of the global object
  ctx.Ind = vm.runInContext('typeof Ind !== "undefined" ? Ind : undefined', ctx);
  return ctx;
}

// Deterministic PRNG so every test run sees the same candles.
function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random-walk candles. drift: per-candle mean move (in units of `vol`).
// segments: [{ n, drift, vol }] for regime changes.
function makeCandles({ start = 1_700_000_100 - (1_700_000_100 % 300), tf = 300, price = 1.08, segments = [{ n: 300, drift: 0, vol: 0.0004 }], seed = 7 } = {}) {
  const r = rng(seed), out = [];
  let t = start, p = price;
  for (const seg of segments) {
    for (let i = 0; i < seg.n; i++) {
      const o = p;
      const move = (seg.drift + (r() - 0.5) * 2) * seg.vol;
      const c = o + move;
      const hi = Math.max(o, c) + r() * seg.vol * 0.6;
      const lo = Math.min(o, c) - r() * seg.vol * 0.6;
      out.push({ time: t, open: +o.toFixed(6), high: +hi.toFixed(6), low: +lo.toFixed(6), close: +c.toFixed(6) });
      p = c; t += tf;
    }
  }
  return out;
}

module.exports = { load, rng, makeCandles, ROOT };
