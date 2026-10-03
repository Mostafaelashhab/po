// My PO Bot — builds candles from the live price stream, evaluates every
// strategy on each candle close, paper-tests all of them in the background
// ("shadow" trades), and places real trades through Pocket Option's own buttons
// within the session risk limits.

const DEFAULTS = {
  strategy: 'consensus',  // a strategy name, 'consensus' or 'auto'
  required: 3,            // how many of a strategy's 4 checks must agree
  minVotes: 2,            // consensus: strategies that must agree
  period: 15,             // analysis candle size in seconds (independent of the PO expiry)
  autoExpiry: true,       // bot picks the best-proven expiry per strategy and sets it in PO
  expiry: 60,             // fixed expiry when autoExpiry is off (you set it in PO yourself)
  maxExpiry: 300,         // longest expiry the bot may trade with (paper still tests all)
  currency: 'EGP',        // label only — PO trades in the account's own currency
  amount: 50,
  demoOnly: true,
  realNeedsProof: true,   // on a real account, only trade strategies marked ★★ (user may turn this off)
  stopLoss: 500,          // stop when session P/L <= -stopLoss
  takeProfit: 500,        // stop when session P/L >= takeProfit
  maxTrades: 20,
  maxLossStreak: 4,
  lossCooldown: 3,        // candles to sit out after a loss
  minPayout: 80,          // skip trading when PO's payout % is below this
  autoMinSamples: 30,     // shadow trades a strategy+expiry needs before it can be "proven"
  autoMargin: 0,          // extra % the confidence-adjusted win rate must clear above break-even
  martingale: false,
  mgMultiplier: 2.2,
  mgMaxSteps: 2,          // hard cap; never unbounded
  scanPairs: 10,          // scanner: how many OTC pairs (highest payout first)
  scanHours: 8,           // scanner: hours of history per pair
};

// Settings for a long unattended demo run: trade on demo with limits wide enough
// that the session doesn't stop early, so both demo results and paper stats pile up.
const PRESETS = {
  demoTest: {
    title: '2h demo test',
    values: {
      demoOnly: true, strategy: 'consensus', required: 3, minVotes: 2,
      period: 15, autoExpiry: true, amount: 50,
      stopLoss: 2000, takeProfit: 5000, maxTrades: 150, maxLossStreak: 8,
      lossCooldown: 2, minPayout: 80, autoMinSamples: 30, autoMargin: 0, martingale: false,
    },
  },
};
// Bump to push a preset onto existing installs once.
const SETTINGS_VERSION = 6;

const NUMERIC = ['required', 'minVotes', 'period', 'expiry', 'maxExpiry', 'amount', 'stopLoss', 'takeProfit', 'maxTrades',
  'maxLossStreak', 'lossCooldown', 'minPayout', 'autoMinSamples', 'autoMargin', 'mgMultiplier', 'mgMaxSteps', 'scanPairs', 'scanHours'];
const FIELDS = ['strategy', 'currency', ...NUMERIC];

const MAX_CANDLES = 300;
const RESULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_PAYOUT = 85; // assumed when PO's payout can't be read

const state = {
  settings: { ...DEFAULTS },
  running: false,
  asset: null,
  candles: [],
  forming: null,
  lastTickAt: 0,
  lastTick: null,         // { ts, price } in PO's clock
  hookFailed: false,
  trades: [],             // the bot's open trades (several only in Opportunity hunter mode)
  placing: false,         // a trade is being placed right now (amount/expiry/click in progress)
  poOpen: new Map(),      // every deal PO reports open (bot's, manual, or from before a reload) → closeTimestamp
  mgStep: 0,
  cooldown: 0,
  session: null,
  ev: null,               // evaluateAll() result for the last closed candle
  decision: null,
  shadowOpen: [],         // pending paper trades
  shadow: {},             // "asset|setup|strategy" and "*|setup|strategy" → { w, l, t }
  bt: {},                 // backtest results, "asset|setup|strategy" → { w, l, t }
  btGlobal: {},           // the same summed over assets, "*|setup|strategy"
  proofs: {},             // "asset|setup|strategy" → live paper record at the moment it was first proven
  liveFrom: {},           // asset → PO time live paper-testing began; backtests stop before it
  hist: {},               // asset → Map(time → candle) collected from PO's chart history
  assets: [],             // PO's asset list: { symbol, name, type, payout, active }
  scan: { running: false, cancel: false, progress: '', results: [] },
  status: 'Idle',
  log: [],
};

let root; // panel shadow root, set by mountPanel()

const newSession = () => ({ pl: 0, trades: 0, wins: 0, losses: 0, ties: 0, streak: 0, startedAt: Date.now() });
state.session = newSession();

// ─── Storage ────────────────────────────────────────────────────────────────
chrome.storage.local.get(['settings', 'log', 'shadow', 'bt', 'liveFrom', 'scan', 'proofs'], (r) => {
  if (r.proofs && typeof r.proofs === 'object') state.proofs = r.proofs;
  if (Array.isArray(r.scan)) state.scan.results = r.scan;
  if (r.settings) {
    // Settings saved before the currency option still carry the old dollar-sized defaults.
    if (!r.settings.currency) {
      if (r.settings.amount === 1) r.settings.amount = DEFAULTS.amount;
      if (r.settings.stopLoss === 10) r.settings.stopLoss = DEFAULTS.stopLoss;
      if (r.settings.takeProfit === 10) r.settings.takeProfit = DEFAULTS.takeProfit;
    }
    // v0.4: proof switched from raw win rate + 3% to a confidence bound, which needs more samples.
    if ('autoEdge' in r.settings) {
      delete r.settings.autoEdge;
      if (r.settings.autoMinSamples === 20) r.settings.autoMinSamples = DEFAULTS.autoMinSamples;
    }
    state.settings = { ...DEFAULTS, ...r.settings };
    if ((r.settings.version || 0) < 6 && r.shadow) {
      // The engine's rules changed (v6: 9-phase grading) — its old paper record no longer describes it.
      for (const k of Object.keys(r.shadow)) if (k.endsWith('|engine')) delete r.shadow[k];
      if (r.bt) for (const k of Object.keys(r.bt)) if (k.endsWith('|engine')) delete r.bt[k];
    }
    if ((r.settings.version || 0) < 5) {
      Object.assign(state.settings, PRESETS.demoTest.values);
      state.status = `Applied "${PRESETS.demoTest.title}" settings`;
    }
  }
  state.settings.version = SETTINGS_VERSION;
  saveSettings();
  if (Array.isArray(r.log)) state.log = r.log;
  if (r.shadow && typeof r.shadow === 'object') state.shadow = r.shadow;
  if (r.bt && typeof r.bt === 'object') { state.bt = r.bt; rebuildBtGlobal(); }
  if (r.liveFrom && typeof r.liveFrom === 'object') state.liveFrom = r.liveFrom;
  render();
});
const money = (v) => `${v} ${state.settings.currency}`;
function saveSettings() { chrome.storage.local.set({ settings: state.settings }); }
const saveLog = () => chrome.storage.local.set({ log: state.log.slice(-5000) });
let shadowSaveTimer = null;
const saveShadow = () => {
  clearTimeout(shadowSaveTimer);
  shadowSaveTimer = setTimeout(() => chrome.storage.local.set({ shadow: state.shadow }), 2000);
};

// ─── Candle building ────────────────────────────────────────────────────────
function resetCandles(asset) {
  state.asset = asset;
  state.candles = [];
  state.forming = null;
  state.ev = null;
  state.decision = null;
}

function ingestTick(ts, price, silent = false) {
  if (!Number.isFinite(ts) || !Number.isFinite(price)) return;
  const p = state.settings.period;
  const t = Math.floor(ts / p) * p;
  const f = state.forming;
  if (!f || t > f.time) {
    if (f) {
      state.candles.push(f);
      if (state.candles.length > MAX_CANDLES) state.candles.shift();
      if (!silent) onCandleClose();
    }
    state.forming = { time: t, open: price, high: price, low: price, close: price };
  } else if (t === f.time) {
    f.high = Math.max(f.high, price);
    f.low = Math.min(f.low, price);
    f.close = price;
  }
}

// ─── Socket event catalogue ─────────────────────────────────────────────────
// Records which named events PO sends (count + one recent sample), stored only
// on this machine. Used to discover the format of features like PO's Signals.
const wsEvents = {};
let wsEventsTimer = null;
function noteEvent(name, text) {
  if (!name) return;
  const e = wsEvents[name] || (Object.keys(wsEvents).length < 200 ? (wsEvents[name] = { n: 0 }) : null);
  if (!e) return;
  e.n++;
  e.last = new Date().toISOString();
  e.sample = String(text).slice(0, 600);
  if (!wsEventsTimer) wsEventsTimer = setTimeout(() => { wsEventsTimer = null; chrome.storage.local.set({ wsEvents }); }, 5000);
}

function handleFrame(event, text) {
  noteEvent(event, text);
  let data;
  try { data = JSON.parse(text); } catch (_) { return; }

  if (event && /^signals\/(load|update)$/.test(event)) return onSignals(data?.signals);
  if (event && /^loadHistoryPeriod/.test(event)) return collectHistory(data);
  if (event === 'updateAssets' && Array.isArray(data)) return onAssets(data);
  if (event === 'updateOpenedDeals' && Array.isArray(data)) {
    state.poOpen = new Map(data.filter(d => d?.id).map(d => [d.id, Number(d.closeTimestamp) || null]));
    return render();
  }
  if (event === 'updateClosedDeals' && Array.isArray(data)) { data.forEach(d => state.poOpen.delete(d?.id)); return; }
  if (event && /successopenOrder/i.test(event)) {
    if (data?.id) state.poOpen.set(data.id, Number(data.closeTimestamp) || null);
    return onOrderOpened(data);
  }
  if (event && /successcloseOrder/i.test(event)) {
    (Array.isArray(data?.deals) ? data.deals : [data]).forEach(d => state.poOpen.delete(d?.id));
    return onOrderClosed(data);
  }

  // History seed: { asset, period, history: [[ts, price], ...] }
  if (data && !Array.isArray(data) && Array.isArray(data.history) && data.asset) {
    resetCandles(data.asset);
    for (const [ts, price] of data.history) ingestTick(Number(ts), Number(price), true);
    if (state.candles.length >= MIN_CANDLES) evaluate();
    render();
    return;
  }

  // Ticks: [[asset, ts, price], ...]
  if (Array.isArray(data)) {
    for (const tick of data) {
      if (!Array.isArray(tick) || tick.length < 3 || typeof tick[0] !== 'string') continue;
      const [asset, ts, price] = tick;
      // Intel engine observes every asset this tab receives ticks for (multi-chart layouts included).
      globalThis.IntelTab?.onTick(asset, Number(ts), Number(price));
      if (!state.asset) { resetCandles(asset); requestHistory(); }
      if (asset !== state.asset) continue;
      state.lastTickAt = Date.now();
      state.lastTick = { ts: Number(ts), price: Number(price) };
      if (state.liveFrom[asset] == null) {
        // Pairs paper-tested before this field existed: assume live data reaches back 3h,
        // so a backtest can't re-count those same minutes.
        const legacy = Object.keys(state.shadow).some(k => k.startsWith(`${asset}|`));
        state.liveFrom[asset] = Number(ts) - (legacy ? 3 * 3600 : 0);
        chrome.storage.local.set({ liveFrom: state.liveFrom });
      }
      resolveShadow();
      resolveSignals();
      ingestTick(Number(ts), Number(price));
    }
  }
}

function requestHistory() {
  if (!state.asset) return;
  window.postMessage({ src: 'POBOT_CMD', kind: 'history', asset: state.asset, period: state.settings.period }, '*');
}

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.src !== 'POBOT') return;
  const m = e.data;
  if (m.kind === 'frame') handleFrame(m.event, m.text);
  else if (m.kind === 'symbol' && m.asset && m.asset !== state.asset) { resetCandles(m.asset); render(); }
  else if (m.kind === 'text_event') noteEvent(m.event, m.text);
  else if (m.kind === 'sent_event') noteEvent(`→ ${m.event}`, m.text);
  else if (m.kind === 'hook_failed') { state.hookFailed = true; render(); }
  else if (m.kind === 'history_failed') { state.status = 'PO socket not ready — history request failed'; render(); }
});

// ─── Shadow (paper) trading ─────────────────────────────────────────────────
// Every strategy that fires gets a virtual trade at the current price for EACH
// candidate expiry at once (paper trades cost nothing), so the bot learns which
// expiry suits which strategy. One open paper trade per strategy+expiry.
// Stats are kept per candle/expiry combination — a strategy that works on 15s
// candles with a 60s expiry says nothing about 5s candles with a 15s expiry.
const EXPIRY_CHOICES = [15, 30, 60, 180, 300]; // PO quick-trade presets S15, S30, M1, M3, M5
const EXPIRY_LABEL = { 15: 'S15', 30: 'S30', 60: 'M1', 120: 'M2', 180: 'M3', 300: 'M5' };
const expiryLabel = (sec) => EXPIRY_LABEL[sec] || `${sec}s`;
const setupKey = (expiry = state.settings.expiry) => `${state.settings.period}s/${expiry}s`;
const shadowExpiries = () => [...new Set([...EXPIRY_CHOICES, state.settings.expiry])];

function openShadows() {
  const tick = state.lastTick;
  if (!tick || !state.ev?.ready) return;
  for (const [name, r] of Object.entries(state.ev.results)) {
    if (!r.action) continue;
    for (const expiry of shadowExpiries()) {
      if (state.shadowOpen.some(x => x.asset === state.asset && x.name === name && x.expiry === expiry)) continue;
      state.shadowOpen.push({ asset: state.asset, name, expiry, setup: setupKey(expiry), dir: r.action, entry: tick.price, expires: tick.ts + expiry });
    }
  }
}

function resolveShadow() {
  const tick = state.lastTick;
  if (!tick || !state.shadowOpen.length) return;
  state.shadowOpen = state.shadowOpen.filter((x) => {
    if (tick.ts < x.expires) return true;
    // Expired while we weren't watching this pair (user switched away): the
    // closing price is unknown, so drop it rather than score it with a late price.
    if (x.asset !== state.asset || tick.ts > x.expires + 5) return false;
    const moved = tick.price - x.entry;
    const res = moved === 0 ? 't' : (moved > 0) === (x.dir === 'call') ? 'w' : 'l';
    for (const key of [`${x.asset}|${x.setup}|${x.name}`, `*|${x.setup}|${x.name}`]) {
      const s = state.shadow[key] || (state.shadow[key] = { w: 0, l: 0, t: 0 });
      s[res]++;
    }
    saveShadow();
    return false;
  });
}

// Lower end of the 90% Wilson interval: "with this many samples, the true win
// rate is very likely at least this". 7 of 10 → ~50%; 70 of 100 → ~64%.
function wilsonLow(w, n, z = 1.645) {
  if (!n) return null;
  const p = w / n, z2 = z * z;
  return (100 * (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n)))) / (1 + z2 / n);
}

// Stats for this asset when there are enough samples, otherwise all assets.
// Live paper trades and backtest trades count together (they never overlap in time).
function combined(key) {
  const a = state.shadow[key], b = key.startsWith('*|') ? state.btGlobal[key] : state.bt[key];
  if (!a && !b) return null;
  return { w: (a?.w || 0) + (b?.w || 0), l: (a?.l || 0) + (b?.l || 0), t: (a?.t || 0) + (b?.t || 0), bt: (b?.w || 0) + (b?.l || 0) };
}

function shadowStats(name, expiry = state.settings.expiry) {
  const local = combined(`${state.asset}|${setupKey(expiry)}|${name}`);
  const n = (s) => (s ? s.w + s.l : 0);
  const isLocal = n(local) >= state.settings.autoMinSamples;
  const pick = isLocal ? local : combined(`*|${setupKey(expiry)}|${name}`);
  const total = n(pick);
  return { n: total, bt: pick?.bt || 0, winRate: total ? (pick.w / total) * 100 : null, low: total ? wilsonLow(pick.w, total) : null,
    scope: isLocal ? 'pair' : 'all' };
}

const breakEven = (payout) => 100 / (1 + (payout ?? DEFAULT_PAYOUT) / 100);

// Before there is data: reversals play out fast (~4 candles), trends need room (~10).
// Expiries PO offers for the open pair: from the last picker list we saw (most direct),
// else from PO's asset list. Pairs differ — some have no seconds presets at all.
// PO's duration presets, as last read from its picker: per asset, and '*' for the latest list seen on
// any pair (presets are normally the same everywhere). Kept across reloads.
const pickerSeen = {}; // asset → [seconds]
chrome.storage.local.get(['pickerSeen'], (r) => { if (r?.pickerSeen) Object.assign(pickerSeen, r.pickerSeen, pickerSeen); });
function allowedExpiries() {
  return pickerSeen[state.asset] || state.assets.find(x => x.symbol === state.asset)?.expiries || null;
}
const tradableExpiries = () => {
  const allowed = allowedExpiries();
  const offered = EXPIRY_CHOICES.filter(e => !allowed || allowed.includes(e));
  const ok = offered.filter(e => e <= state.settings.maxExpiry);
  if (ok.length) return ok;
  // nothing short enough on this pair: take the shortest it does offer
  return [offered[0] ?? (allowed ? Math.min(...allowed) : EXPIRY_CHOICES[0])];
};

function defaultExpiry(name) {
  const target = state.settings.period * ({ reversal: 4, fade: 2, scalp: 2, trend: 10 }[Strategies[name].family] ?? 8);
  return tradableExpiries().reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
}

// The expiry this strategy should trade with, and whether its shadow record
// there beats break-even by the required edge.
function bestExpiry(name) {
  const s = state.settings, need = breakEven(readPayout()) + s.autoMargin;
  const pool = (s.autoExpiry ? tradableExpiries() : [s.expiry])
    .map(expiry => ({ expiry, stats: shadowStats(name, expiry) }))
    .filter(x => x.stats.n >= s.autoMinSamples);
  if (!pool.length) {
    const expiry = s.autoExpiry ? defaultExpiry(name) : s.expiry;
    return { expiry, stats: shadowStats(name, expiry), proven: false, fallback: true };
  }
  const best = pool.reduce((a, b) => (b.stats.low > a.stats.low ? b : a));
  return { ...best, proven: best.stats.low >= need, fallback: false };
}

function eligibleStrategies() {
  return new Set(STRATEGY_NAMES.filter(name => bestExpiry(name).proven));
}

// Paper record already says "loses": every expiry with enough samples is under
// break-even. Such a strategy keeps paper-testing (it can recover) but can't vote.
const BENCH_MIN_SAMPLES = 20;
function isBenched(name) {
  const be = breakEven(readPayout());
  const tested = shadowExpiries().map(e => shadowStats(name, e)).filter(x => x.n >= BENCH_MIN_SAMPLES);
  return tested.length > 0 && tested.every(x => x.winRate < be);
}

// Real money needs proof on THIS pair, not an average over other pairs.
// Being "proven" means: best of ~5 expiries × 10 strategies on past data. Some
// combo always looks good by luck that way (EMA M3 on AUDNZD: 65% on the older
// part of the backtest, 53% on the newer part). So ★★ also needs a FORWARD test:
// enough NEW live paper trades after the moment it was first proven, still above
// break-even. Those trades played no part in choosing it.
const FORWARD_MIN = 20;
const proofKey = (name, expiry) => `${state.asset}|${setupKey(expiry)}|${name}`;

function updateProofs() {
  let changed = false;
  for (const name of STRATEGY_NAMES) {
    const b = bestExpiry(name), key = proofKey(name, b.expiry);
    const live = state.shadow[key] || { w: 0, l: 0 };
    const isProven = b.proven && b.stats.scope === 'pair';
    if (isProven && !state.proofs[key]) { state.proofs[key] = { w: live.w, l: live.l, at: state.lastTick?.ts ?? null }; changed = true; }
    // Lost its proof → must earn it (and a new forward test) again.
    for (const k of Object.keys(state.proofs)) {
      if (k.startsWith(`${state.asset}|`) && k.endsWith(`|${name}`) && (k !== key || !isProven)) { delete state.proofs[k]; changed = true; }
    }
  }
  if (changed) chrome.storage.local.set({ proofs: state.proofs });
}

function forwardStats(name) {
  const b = bestExpiry(name), key = proofKey(name, b.expiry), p = state.proofs[key];
  if (!p) return null;
  const live = state.shadow[key] || { w: 0, l: 0 };
  const w = live.w - p.w, n = w + (live.l - p.l);
  return { w, n, winRate: n ? (w / n) * 100 : null };
}

function provenForReal(name) {
  const f = forwardStats(name);
  return !!f && f.n >= FORWARD_MIN && f.winRate >= breakEven(readPayout());
}

// Several strategies may vote together; trade the expiry of the best-proven one.
function pickExpiry(voters) {
  if (voters.some(v => v === 'copysig' || v === 'copyplus')) { const e = copySignalExpiry(); if (e) return e; }
  if (!state.settings.autoExpiry) return state.settings.expiry;
  const ranked = voters.map(bestExpiry).sort((a, b) =>
    (b.proven - a.proven) || ((b.stats.low ?? 0) - (a.stats.low ?? 0)));
  return ranked[0]?.expiry ?? state.settings.expiry;
}

// ─── Backtest ───────────────────────────────────────────────────────────────
// PO's chart loads past candles ({ asset, data: [{ time, open, close, high, low }] })
// on page load and whenever the chart is dragged back in time. They are kept
// in memory per asset and replayed by runBacktest().
const MAX_HIST = 30000;

function collectHistory(data) {
  const rows = Array.isArray(data?.data) ? data.data : null;
  if (!rows || !data.asset) return;
  // A reply to our own request (matched by asset and candle spacing), or PO's chart loading on its own.
  const clean = rows.map(c => ({ time: Number(c.time), open: +c.open, high: +c.high, low: +c.low, close: +c.close }))
    .filter(c => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite)).sort((a, b) => a.time - b.time);
  const res = Number(data.period) || candleResolution(clean);
  const w = historyWaiter;
  // An empty reply for the requested asset is an answer too ("no data"), not something to wait 6s for.
  const mine = !!w && w.asset === data.asset
    && (!clean.length || (res ? res === w.period : clean.every(c => c.time % w.period === 0)));
  if (mine) {
    clearTimeout(w.timer);
    historyWaiter = null;
    w.resolve(clean);
    pumpHistory();
    if (w.period !== HISTORY_PERIOD) return render(); // multi-timeframe data for the intel engine only
  } else {
    globalThis.IntelTab?.onUnsolicitedHistory(data.asset, res, clean);
  }
  const m = state.hist[data.asset] || (state.hist[data.asset] = new Map());
  for (const c of rows) {
    const t = Number(c.time), o = +c.open, h = +c.high, l = +c.low, cl = +c.close;
    if ([t, o, h, l, cl].every(Number.isFinite)) m.set(t, { time: t, open: o, high: h, low: l, close: cl });
  }
  if (m.size > MAX_HIST) [...m.keys()].sort((a, b) => a - b).slice(0, m.size - MAX_HIST).forEach(k => m.delete(k));
  if (data.asset === state.asset) seedFromHistory();
  render();
}

// Prepend chart-history candles (aggregated to the analysis period) to the live
// buffer, so analysts that need 80+ candles can work right after a page load.
function seedFromHistory() {
  const m = state.hist[state.asset];
  if (!m || state.candles.length >= MAX_CANDLES) return;
  const p = state.settings.period;
  const firstLive = state.candles[0]?.time ?? state.forming?.time ?? Infinity;
  const base = [...m.values()].filter(c => c.time < firstLive).sort((x, y) => x.time - y.time);
  const older = aggregateCandles(base, p).filter(c => c.time + p <= firstLive);
  if (!older.length) return;
  // only a contiguous run that ends right where the live buffer starts
  const joined = [...older, ...state.candles];
  let start = joined.length - 1;
  while (start > 0 && joined[start].time - joined[start - 1].time === p) start--;
  const merged = joined.slice(start).slice(-MAX_CANDLES);
  if (merged.length > state.candles.length) { state.candles = merged; evaluate(); }
}

function rebuildBtGlobal() {
  state.btGlobal = {};
  for (const [key, v] of Object.entries(state.bt)) {
    const g = key.replace(/^[^|]+\|/, '*|');
    const t = state.btGlobal[g] || (state.btGlobal[g] = { w: 0, l: 0, t: 0 });
    t.w += v.w; t.l += v.l; t.t += v.t;
  }
}

function backtestCurrent() {
  const s = state.settings, asset = state.asset;
  const m = asset && state.hist[asset];
  if (!m || m.size < 100) return `Backtest: only ${m?.size || 0} history candles — drag the PO chart left to load more`;
  const cutoff = state.liveFrom[asset] ?? Infinity;
  const base = [...m.values()].filter(c => c.time < cutoff).sort((a, b) => a.time - b.time);
  const res = candleResolution(base);
  if (!res || s.period % res !== 0) return `Backtest: chart candles are ${res}s — set the PO chart to 5s or 15s`;
  const r = runBacktest(base, { period: s.period, required: s.required, expiries: EXPIRY_CHOICES });
  // Merge hour by hour: for each hour keep whichever run saw more of it. The data is
  // the same, so more trades in an hour means that run covered more of it — never adding
  // the same hour twice, and never losing hours this run's loaded history doesn't reach.
  const hoursBefore = new Set();
  for (const [key, v] of Object.entries(state.bt)) {
    if (!key.startsWith(`${asset}|${s.period}s/`)) continue;
    if (!v.byHour) { delete state.bt[key]; continue; } // pre-v0.6 rows can't be merged
    Object.keys(v.byHour).forEach(h => hoursBefore.add(h));
  }
  for (const [name, byExp] of Object.entries(r.stats)) {
    for (const [expiry, v] of Object.entries(byExp)) {
      const key = `${asset}|${setupKey(+expiry)}|${name}`;
      const row = state.bt[key] || (state.bt[key] = { w: 0, l: 0, t: 0, byHour: {} });
      for (const [h, hv] of Object.entries(v.byHour)) {
        const old = row.byHour[h];
        if (!old || hv.w + hv.l + hv.t > old.w + old.l + old.t) row.byHour[h] = hv;
      }
    }
  }
  let trades = 0;
  const hoursAfter = new Set();
  for (const [key, row] of Object.entries(state.bt)) {
    if (!key.startsWith(`${asset}|${s.period}s/`)) continue;
    row.w = row.l = row.t = 0;
    for (const [h, hv] of Object.entries(row.byHour)) { row.w += hv.w; row.l += hv.l; row.t += hv.t; hoursAfter.add(h); }
    trades += row.w + row.l;
  }
  rebuildBtGlobal();
  chrome.storage.local.set({ bt: state.bt });
  evaluate();
  const hours = ((r.to - r.from) / 3600).toFixed(1);
  const added = [...hoursAfter].filter(h => !hoursBefore.has(h)).length;
  return `Backtest: this run ${hours}h of ${asset} · ${added} new hour(s) · total ${hoursAfter.size}h, ${trades} paper trades`;
}

// ─── Pair scanner ───────────────────────────────────────────────────────────
// Pulls hours of history for many OTC pairs (the same request PO's chart sends
// when dragged back), then for each pair:
//   1. TRAIN on the older 2/3: keep strategy+expiry combos whose confidence
//      bound clears that pair's break-even.
//   2. CHECK those combos on the newest 1/3, which played no part in picking them.
// Only combos that pass both count. Testing ~50 combos per pair guarantees a few
// look good by luck in step 1; step 2 is what filters luck out.
// Report-only: it never enables trading by itself.
const HISTORY_OFFSET = 1000;   // seconds per request, as PO's chart asks
const HISTORY_PERIOD = 5;      // 5s candles

// PO's reply to loadHistoryPeriod doesn't echo the request, so one request is in
// flight at a time and the reply is matched by asset and candle spacing (see
// collectHistory). Shared by the scanner, signal scoring and the intel engine.
const historyQueue = [];
let historyWaiter = null;
const historyBusy = () => !!historyWaiter || historyQueue.length > 0;

function historyRequest(asset, period, time, offset) {
  return new Promise((resolve) => { historyQueue.push({ asset, period, time, offset, resolve }); pumpHistory(); });
}

function pumpHistory() {
  if (historyWaiter || !historyQueue.length) return;
  const w = (historyWaiter = historyQueue.shift());
  window.postMessage({ src: 'POBOT_CMD', kind: 'loadHistory', asset: w.asset, time: w.time, offset: w.offset, period: w.period }, '*');
  w.timer = setTimeout(() => {
    if (historyWaiter !== w) return;
    historyWaiter = null;
    w.resolve(null);
    pumpHistory();
  }, 6000);
}

function onAssets(rows) {
  // row: [id, symbol, name, type, ?, payout, …, (14) isActive, (15) [{ time: seconds }, …] allowed expiries, …]
  const list = rows.filter(r => Array.isArray(r) && typeof r[1] === 'string')
    .map(r => ({ symbol: r[1], name: r[2], type: r[3], payout: Number(r[5]), active: r[14] === true,
      expiries: Array.isArray(r[15]) ? r[15].map(x => Number(x?.time)).filter(Boolean) : null }));
  if (list.length) state.assets = list;
}

// Resolves with the oldest candle time received, or null.
function requestHistoryBatch(asset, time) {
  return historyRequest(asset, HISTORY_PERIOD, time, HISTORY_OFFSET)
    .then(rows => (rows?.length ? Math.min(...rows.map(c => c.time)) : null));
}

async function loadHistoryFor(asset, hours) {
  const now = Math.floor(state.lastTick?.ts ?? Date.now() / 1000);
  const target = now - hours * 3600;
  let cursor = now, fails = 0;
  for (let i = 0; i < Math.ceil((hours * 3600) / HISTORY_OFFSET) + 5 && cursor > target; i++) {
    if (state.scan.cancel) return;
    const oldest = await requestHistoryBatch(asset, cursor);
    if (oldest == null) { if (++fails >= 2) return; continue; }
    if (oldest >= cursor) return; // no older data
    cursor = oldest;
    await sleep(400);
  }
}

function scanPair(a) {
  const s = state.settings, be = breakEven(a.payout);
  const now = Math.floor(state.lastTick?.ts ?? Date.now() / 1000);
  const base = [...(state.hist[a.symbol]?.values() || [])]
    .filter(c => c.time >= now - s.scanHours * 3600).sort((x, y) => x.time - y.time);
  const res = candleResolution(base);
  if (base.length < 500 || !res || s.period % res !== 0) {
    return { asset: a.symbol, payout: a.payout, hours: 0, note: `only ${base.length} candles` };
  }
  const first = base[0].time, last = base[base.length - 1].time;
  const split = first + ((last - first) * 2) / 3;
  const opts = { period: s.period, required: s.required, expiries: EXPIRY_CHOICES };
  const train = runBacktest(base.filter(c => c.time < split), opts).stats;
  const check = runBacktest(base, { ...opts, countFrom: split }).stats;

  const combos = [];
  for (const [name, byExp] of Object.entries(train)) {
    for (const [expiry, t] of Object.entries(byExp)) {
      const n = t.w + t.l;
      if (n < 30 || +expiry > s.maxExpiry) continue;
      const v = check[name]?.[expiry] || { w: 0, l: 0 }, vn = v.w + v.l;
      const low = wilsonLow(t.w, n);
      combos.push({ name, expiry: +expiry, trainW: t.w, trainN: n, trainLow: low, checkW: v.w, checkN: vn,
        // Check half: 30+ trades and still above break-even at ~80% confidence (z = 0.84).
        candidate: low >= be, pass: low >= be && vn >= 30 && wilsonLow(v.w, vn, 0.84) >= be });
    }
  }
  combos.sort((x, y) => (y.pass - x.pass) || (y.candidate - x.candidate) || (y.trainLow - x.trainLow));
  return { asset: a.symbol, payout: a.payout, breakEven: be, hours: (last - first) / 3600, bars: base.length,
    candidates: combos.filter(c => c.candidate).length, passes: combos.filter(c => c.pass), best: combos[0] || null };
}

async function runScanner() {
  const s = state.settings, sc = state.scan;
  if (sc.running) { sc.cancel = true; return; }
  if (!state.lastTick) { state.status = 'Scanner: waiting for the live price feed first'; return render(); }
  let pool = state.assets.filter(a => a.active && /_otc$/i.test(a.symbol) && a.payout >= s.minPayout);
  const fx = pool.filter(a => a.type === 'currency');
  if (fx.length) pool = fx;
  pool = pool.sort((x, y) => y.payout - x.payout).slice(0, s.scanPairs);
  if (!pool.length) { state.status = 'Scanner: PO asset list not received yet — reload the page'; return render(); }

  sc.running = true; sc.cancel = false; sc.results = [];
  render();
  for (const [i, a] of pool.entries()) {
    if (sc.cancel) break;
    sc.progress = `Scanning ${i + 1}/${pool.length}: ${a.symbol} — loading ${s.scanHours}h…`;
    render();
    await loadHistoryFor(a.symbol, s.scanHours);
    if (sc.cancel) break;
    sc.progress = `Scanning ${i + 1}/${pool.length}: ${a.symbol} — testing…`;
    render();
    await sleep(50);
    sc.results.push(scanPair(a));
    chrome.storage.local.set({ scan: sc.results });
    render();
  }
  const passed = sc.results.filter(r => r.passes?.length).length;
  sc.progress = `${sc.cancel ? 'Scan stopped' : 'Scan done'} — ${sc.results.length} pairs, ${passed} with a combo that passed both halves`;
  sc.running = false; sc.cancel = false;
  render();
}

// ─── PO "Copy signal" list (other traders' trades, .signals-list) ───────────
// Read from the page itself every 2s. Each new item (pair, direction, countdown)
// becomes a paper trade from the moment it appears until its countdown ends, scored
// close-to-close from 5s history — on any pair, not only the open one.
const copy = { seen: new Map(), queue: [], stats: {}, sample: null, last: {}, primed: {}, hist: {} }; // hist: asset → recent trades (copy-trade intelligence)
chrome.storage.local.get(['copyStats'], (r) => { if (r.copyStats) copy.stats = r.copyStats; });

function displayToAsset(t) {
  // "CAD/JPY OTC" → "CADJPY_otc", "EUR/USD" → "EURUSD"
  const m = /([A-Z]{3})\s*\/\s*([A-Z]{3})(\s*OTC)?/i.exec(t || '');
  return m ? `${m[1].toUpperCase()}${m[2].toUpperCase()}${m[3] ? '_otc' : ''}` : null;
}

function itemDirection(el) {
  const html = el.innerHTML.toLowerCase(), cls = [...el.querySelectorAll('*')].map(x => String(x.className?.baseVal ?? x.className ?? '')).join(' ').toLowerCase();
  const txt = el.textContent || '';
  const up = /\b(up|call|buy|higher|green|arrow-up|icon-up)\b/.test(cls) || /[↑▲⬆]/.test(txt);
  const dn = /\b(down|put|sell|lower|red|arrow-down|icon-down)\b/.test(cls) || /[↓▼⬇]/.test(txt);
  if (up !== dn) return up ? 'call' : 'put';
  // colour of the arrow icon as a last resort
  for (const x of el.querySelectorAll('svg, i, [class*="arrow"], [class*="icon"]')) {
    const col = getComputedStyle(x).color || '';
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)/.exec(col);
    if (m) { const [r, g] = [+m[1], +m[2]]; if (g > r + 40) return 'call'; if (r > g + 40) return 'put'; }
  }
  return html.includes('up') && !html.includes('down') ? 'call' : html.includes('down') && !html.includes('up') ? 'put' : null;
}

function scanCopySignals() {
  const list = document.querySelector('.signals-list');
  if (!list || !state.lastTick) return;
  // An item = the smallest element holding both a pair name and a countdown.
  const has = (el) => { const t = el.textContent || ''; return /\d{1,2}:\d{2}/.test(t) && !!displayToAsset(t); };
  const items = [...list.querySelectorAll('*')].filter(el => has(el) && ![...el.children].some(has));
  if (!copy.sample) {
    // Saved once, locally, so the reader can be checked against PO's real markup.
    copy.sample = `items=${items.length}\n` + (items[0]?.outerHTML || list.innerHTML).slice(0, 5000);
    chrome.storage.local.set({ copySample: copy.sample });
  }
  const now = state.lastTick.ts;
  for (const el of items) {
    const txt = el.textContent.replace(/\s+/g, ' ');
    const asset = displayToAsset(txt), dir = itemDirection(el);
    const tm = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(txt);
    if (!asset || !dir || !tm) continue;
    const left = tm[3] != null ? +tm[1] * 3600 + +tm[2] * 60 + +tm[3] : +tm[1] * 60 + +tm[2];
    // How long the signal has already been running: PO's progress bar is the elapsed share.
    const bar = el.querySelector('.progress-bar');
    const frac = bar ? parseFloat(bar.style.width) / 100 : NaN;
    const elapsed = Number.isFinite(frac) && frac > 0 && frac < 1 ? (left * frac) / (1 - frac) : null;
    const copies = +(/Copied:\s*(\d+)/i.exec(txt)?.[1] || 0);
    // Same signal ≈ same end time; allow ±10s of jitter between reads.
    const bucket = Math.round((now + left) / 10), key = `${asset}|${dir}|${bucket}`;
    if ([-1, 0, 1].some(k => copy.seen.has(`${asset}|${dir}|${bucket + k}`)) || left < 5 || left > 900) continue;
    copy.seen.set(key, now);
    // Only a signal that JUST started may trigger a live trade: anything already
    // running (e.g. the whole list after a reload or a pair switch) is paper-tested only.
    const fresh = elapsed != null ? elapsed <= 15 : copy.primed[asset] === true;
    if (fresh) copy.last[asset] = { dir, at: now, left };
    if (fresh || elapsed != null) {
      const h = (copy.hist[asset] ||= []);
      h.push({ dir: dir.toUpperCase(), at: now, left, elapsed, copies, price: globalThis.IntelTab?.feeds.get(asset)?.feed.lastTick?.price ?? null });
      copy.hist[asset] = h.filter(x => now - x.at <= 900).slice(-20);
    }
    copy.queue.push({ asset, dir, t: now, exp: left, copies });
  }
  for (const a of new Set(items.map(el => displayToAsset(el.textContent)))) copy.primed[a] = true; // first look = baseline
  for (const [k, t] of copy.seen) if (now - t > 1800) copy.seen.delete(k);
}
setInterval(() => { try { scanCopySignals(); } catch (_) {} }, 2000);

async function resolveCopySignals() {
  const now = state.lastTick?.ts;
  if (!now || historyBusy() || state.scan.running || !copy.queue.length) return;
  copy.queue = copy.queue.filter(x => x.t + x.exp > now - (HISTORY_OFFSET - 100)); // still coverable by one fetch
  const due = copy.queue.filter(x => x.t + x.exp + 15 <= now);
  const p = state.settings.period, NEED = 120 * p; // seconds of candles before a signal for the verify check
  for (const asset of [...new Set(due.map(x => x.asset))].slice(0, 3)) {
    const oldest = await requestHistoryBatch(asset, Math.floor(now));
    if (oldest == null) continue;
    // one more (older) batch if the earliest due signal lacks enough lead-in candles
    const earliest = Math.min(...due.filter(d => d.asset === asset).map(d => d.t));
    if (oldest > earliest - NEED) { await sleep(400); await requestHistoryBatch(asset, Math.floor(oldest)); }
    const m = state.hist[asset], at = (ts) => m?.get(Math.floor(ts / HISTORY_PERIOD) * HISTORY_PERIOD);
    const sorted = [...(m?.values() || [])].sort((x, y) => x.time - y.time);
    for (const x of due.filter(d => d.asset === asset)) {
      const a = at(x.t), b = at(x.t + x.exp);
      if (a && b) {
        const res = b.close === a.close ? 't' : (b.close > a.close) === (x.dir === 'call') ? 'w' : 'l';
        const keys = ['*', asset, x.copies >= 100 ? 'copied100+' : 'copied<100'];
        // what "Copy + verify" would have said at that moment
        const pre = aggregateCandles(sorted.filter(c => c.time < Math.floor(x.t / p) * p), p).slice(-120);
        if (pre.length >= 61) {
          const ind = computeIndicators(pre);
          const obj = copyPlusObjections(scalpEngine(pre, ind, HUNTER_OPTS).diag, x.dir);
          keys.push(obj.length ? 'plus:rejected' : 'plus:taken');
        }
        for (const k of keys) {
          const st = copy.stats[k] || (copy.stats[k] = { w: 0, l: 0, t: 0 }); st[res]++;
        }
      }
      copy.queue.splice(copy.queue.indexOf(x), 1);
    }
    chrome.storage.local.set({ copyStats: copy.stats });
    await sleep(400);
  }
}
setInterval(() => { resolveCopySignals().catch(() => {}); }, 20000);

// Direction of a copy signal on the open pair that appeared within the last 30s.
function currentCopySignal() {
  const x = copy.last[state.asset], now = state.lastTick?.ts;
  return x && now && now - x.at <= 30 ? x.dir : null;
}

// Expiry that matches what is left of the copied signal (nearest one PO offers).
function copySignalExpiry() {
  const x = copy.last[state.asset], now = state.lastTick?.ts;
  if (!x || !now || x.left == null) return null;
  const want = x.left - (now - x.at);
  const opts = tradableExpiries();
  return opts.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
}

// ─── PO Signals feed ────────────────────────────────────────────────────────
// Feed format: signals: [[asset, [[minutes, code], ...], price], ...]
// minutes ∈ 1,2,3,5,10,15,30,45,60,120,180,240; code 0 = no signal (closed
// markets are all 0). PO doesn't document codes 1–4, so instead of guessing the
// bot measures them: every code change on the open pair is followed for its
// own horizon and scored up / down. CODE_DIR is the starting hypothesis only —
// the "PO code meaning" table shows whether the data agrees.
const CODE_DIR = { 1: 'put', 2: 'put', 3: 'call', 4: 'call' };
const SIGNAL_MINUTES = [1, 2, 3, 5];       // horizons short enough to matter here
const SIGNAL_FRESH_SEC = 30;               // act only on a change this recent
const poSig = { byAsset: {}, open: [], others: [] }; // byAsset[asset][minutes] = { code, at (PO ts) }
// `open`   — signals on the open pair, scored from live ticks
// `others` — signals on every other pair, scored from a history fetch once they expire
let sigStats = {};                         // "asset|min|code" and "*|min|code" → { up, down, flat }

chrome.storage.local.get(['sigStats'], (r) => { if (r.sigStats) sigStats = r.sigStats; });
let sigSaveTimer = null;
const saveSigStats = () => {
  clearTimeout(sigSaveTimer);
  sigSaveTimer = setTimeout(() => chrome.storage.local.set({ sigStats }), 2000);
};

function onSignals(list) {
  if (!Array.isArray(list)) return;
  const tick = state.lastTick;
  for (const row of list) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !Array.isArray(row[1])) continue;
    const [asset, frames] = row;
    const slot = poSig.byAsset[asset] || (poSig.byAsset[asset] = {});
    for (const [min, code] of frames) {
      const prev = slot[min];
      const changed = !prev || prev.code !== code;
      slot[min] = { code, at: tick?.ts ?? null, changedAt: changed ? (tick?.ts ?? null) : prev.changedAt };
      // Follow each new non-zero code on the pair we have live ticks for.
      if (!changed || code <= 0 || !tick || !SIGNAL_MINUTES.includes(min)) continue;
      if (asset === state.asset) {
        if (!poSig.open.some(x => x.asset === asset && x.min === min)) {
          poSig.open.push({ asset, min, code, entry: tick.price, expires: tick.ts + min * 60 });
        }
      } else if (/_otc$/i.test(asset) && poSig.others.length < 3000) {
        poSig.others.push({ asset, min, code, t: tick.ts });
      }
    }
  }
  render();
}

// Every 30s: for up to 3 pairs with expired signals, fetch the last ~16 min of
// 5s candles (one request each) and score each signal close-to-close.
const OTHER_SIGNAL_WINDOW = HISTORY_OFFSET - 100; // older than this can't be covered by one request
async function resolveOtherSignals() {
  const now = state.lastTick?.ts;
  if (!now || historyBusy() || state.scan.running || !poSig.others.length) return;
  poSig.others = poSig.others.filter(x => x.t > now - OTHER_SIGNAL_WINDOW);
  const due = poSig.others.filter(x => x.t + x.min * 60 + 15 <= now);
  const assets = [...new Set(due.map(x => x.asset))].slice(0, 3);
  for (const asset of assets) {
    if (await requestHistoryBatch(asset, Math.floor(now)) == null) continue;
    const m = state.hist[asset];
    const at = (ts) => m?.get(Math.floor(ts / HISTORY_PERIOD) * HISTORY_PERIOD);
    for (const x of due.filter(d => d.asset === asset)) {
      const a = at(x.t), b = at(x.t + x.min * 60);
      if (a && b) {
        const res = b.close > a.close ? 'up' : b.close < a.close ? 'down' : 'flat';
        for (const key of [`${asset}|${x.min}|${x.code}`, `*|${x.min}|${x.code}`]) {
          const st = sigStats[key] || (sigStats[key] = { up: 0, down: 0, flat: 0 });
          st[res]++;
        }
      }
      poSig.others.splice(poSig.others.indexOf(x), 1);
    }
    saveSigStats();
    await sleep(400);
  }
  render();
}
setInterval(() => { resolveOtherSignals().catch(() => {}); }, 30000);

function resolveSignals() {
  const tick = state.lastTick;
  if (!tick || !poSig.open.length) return;
  poSig.open = poSig.open.filter((x) => {
    if (tick.ts < x.expires) return true;
    if (x.asset !== state.asset || tick.ts > x.expires + 5) return false; // missed the close
    const res = tick.price > x.entry ? 'up' : tick.price < x.entry ? 'down' : 'flat';
    for (const key of [`${x.asset}|${x.min}|${x.code}`, `*|${x.min}|${x.code}`]) {
      const st = sigStats[key] || (sigStats[key] = { up: 0, down: 0, flat: 0 });
      st[res]++;
    }
    saveSigStats();
    return false;
  });
}

// Direction the feed points to right now for the open pair, if it changed recently.
// Several horizons must not disagree.
function currentSignal() {
  const slot = poSig.byAsset[state.asset], tick = state.lastTick;
  if (!slot || !tick) return null;
  const dirs = SIGNAL_MINUTES
    .map(min => slot[min])
    .filter(x => x && x.code > 0 && x.changedAt != null && tick.ts - x.changedAt <= SIGNAL_FRESH_SEC)
    .map(x => CODE_DIR[x.code]);
  if (!dirs.length) return null;
  return dirs.every(d => d === dirs[0]) ? dirs[0] : null;
}

// ─── Pocket Option page helpers ─────────────────────────────────────────────
const $ = (sels) => {
  for (const s of [].concat(sels)) { const el = document.querySelector(s); if (el) return el; }
  return null;
};

function isDemoAccount() {
  if (/demo/i.test(location.pathname)) return true;
  for (const el of document.querySelectorAll('[class*="balance-info-block"] [class*="label"], [class*="balance__label"]')) {
    const t = el.textContent || '';
    if (/demo/i.test(t)) return true;
    if (/real/i.test(t)) return false;
  }
  return false; // unknown → treat as real, the safe assumption
}

function readPayout() {
  const el = $(['.current-symbol__profit', '.asset-select .asset__profit', '.block--payout .value__val', '[class*="payout"] .value__val']);
  const m = /(\d{1,3})\s*%/.exec(el?.textContent || '');
  const v = m ? Number(m[1]) : null;
  return v > 0 && v <= 100 ? v : null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Understands every way PO has been seen to write a duration: "00:01:00",
// "01:00", "M1", "S30", "1m", "30s", "1 min", "30 sec", "5 minutes".
function parseExpiry(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  let m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(t);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m) return +m[1] * 60 + +m[2];
  m = /^([SMH])\s?(\d+)$/i.exec(t);
  if (m) return +m[2] * { S: 1, M: 60, H: 3600 }[m[1].toUpperCase()];
  m = /^(\d+)\s?(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)$/i.exec(t);
  if (m) return +m[1] * (/^s/i.test(m[2]) ? 1 : /^m/i.test(m[2]) ? 60 : 3600);
  return null;
}

const readExpiry = () => parseExpiry($('.block--expiration-inputs .value__val')?.textContent);
const PICKER_ITEMS = '.dops__timeframes-item, .block--expiration-inputs [class*="list"] [class*="item"], [class*="expiration"] [class*="dropdown"] [class*="item"]';
const visibleItems = () => [...document.querySelectorAll(PICKER_ITEMS)].filter(el => el.offsetParent !== null);
const itemText = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

// Returns null on success, or a reason (with what PO actually showed, for debugging).
// Never reports success unless PO's own expiry display reads back the requested value.
async function setExpiry(sec) {
  if (readExpiry() === sec) return null;
  const close = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  // '.value' opens the preset list; the '<a>' in this block flips PO into absolute-time mode — never click it.
  const triggers = ['.block--expiration-inputs .value', '.block--expiration-inputs .control__value', '.block--expiration-inputs .value__val']
    .map(sel => document.querySelector(sel)).filter(Boolean);
  if (!triggers.length) return 'expiry control not found';

  let items = [];
  for (const t of triggers) {
    t.click();
    await sleep(350);
    items = visibleItems();
    if (items.length) break;
  }
  const seen = items.map(itemText).slice(0, 14).join(', ');
  const parsed = items.map(el => parseExpiry(itemText(el))).filter(Boolean);
  if (parsed.length) {
    pickerSeen[state.asset] = parsed;
    pickerSeen['*'] = parsed;
    try { chrome.storage.local.set({ pickerSeen }); } catch (_) {}
  }
  state.expiryDiag = `PO display "${itemText($('.block--expiration-inputs .value__val') || document.createElement('i'))}" · list [${seen}]`;
  console.log('[PO Bot] expiry picker:', state.expiryDiag);
  if (!items.length) { close(); return 'expiry list did not open'; }
  if (items.some(el => itemText(el).startsWith('+'))) { close(); return 'PO is in clock-time mode — switch expiry to timer mode'; }

  const item = items.find(el => parseExpiry(itemText(el)) === sec);
  if (!item) { close(); return `${expiryLabel(sec)} not in list [${seen}]`; }
  item.click();
  await sleep(350);
  if (visibleItems().length) close();
  const now = readExpiry();
  return now === sec ? null : `PO shows ${now == null ? 'unreadable' : expiryLabel(now)} after selecting ${itemText(item)}`;
}

function setAmount(amount) {
  const input = $(['.block--bet-amount .value__val input', '.value__val input', 'input[name="amount"]']);
  if (!input) return false;
  const v = amount.toFixed(2);
  input.focus();
  input.select();
  if (!document.execCommand('insertText', false, v)) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.blur();
  return Math.abs(parseFloat(input.value.replace(/[^0-9.]/g, '')) - amount) < 0.01;
}

// ─── Switching the chart to another pair (PO's asset list: .assets-block__body-wrap) ─────────
// Returns null once PO itself reports the new symbol (changeSymbol → state.asset), else the reason.
// Never trades: the caller re-checks the chart pair before any click. On failure a sample of the
// menu's markup is saved (chrome.storage 'assetMenuSample') so the selectors can be corrected.
const ASSET_LIST = '.assets-block__body-wrap';
const isShown = (el) => !!el && el.offsetParent !== null && el.getBoundingClientRect().height > 0;
const assetList = () => [...document.querySelectorAll(ASSET_LIST)].find(isShown) || null;
function assetMenuOpener() {
  for (const sel of ['.currencies-block .pair-number-wrap', '.currencies-block__in', '.current-symbol', '[class*="current-symbol"]', '.pair-number-wrap']) {
    const el = [...document.querySelectorAll(sel)].find(isShown);
    if (el) return el;
  }
  // fallback: the element near the top of the chart that shows the current pair's name
  if (!state.asset) return null;
  const label = assetName(state.asset);
  const hits = [...document.querySelectorAll('a, button, div, span')]
    .filter((el) => isShown(el) && itemText(el) === label && el.getBoundingClientRect().top < window.innerHeight * 0.3)
    .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
  return hits[0] ? hits[0].closest('a, button, [class*="block"]') || hits[0] : null;
}
// How PO names the pair in its list: the name from PO's own asset list ("Chainlink OTC"), else
// the currency-pair label ("NZD/USD OTC").
const assetName = (asset) => (state.assets.find((a) => a.symbol === asset)?.name || OTC.U.pairLabel(asset)).replace(/\s+/g, ' ').trim();
// The visible list entry for this pair (PO: li.alist__item > a > span.alist__label), clicked through its row.
function assetItem(root, asset) {
  const name = assetName(asset);
  const named = (el) => itemText(el) === name || displayToAsset(el.textContent) === asset;
  const labels = [...root.querySelectorAll('.alist__label')].filter((x) => isShown(x) && named(x));
  const el = labels[0] || [...root.querySelectorAll('*')].find((x) => isShown(x) && named(x) && ![...x.children].some(named));
  return el ? el.closest('li, a, [class*="item"]') || el : null;
}
function typeInto(input, text) {
  input.focus();
  input.select?.();
  if (!document.execCommand('insertText', false, text)) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
async function switchAsset(asset) {
  if (state.asset === asset) return null;
  const label = assetName(asset);
  const close = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const fail = (err, opener = null) => {
    try {
      chrome.storage.local.set({ assetMenuSample: { at: Date.now(), asset, err, opener: opener?.outerHTML?.slice(0, 1500) || null,
        list: (assetList() || document.querySelector(ASSET_LIST))?.outerHTML?.slice(0, 12000) || null } });
    } catch (_) {}
    close();
    return err;
  };
  let list = assetList(), opener = null;
  if (!list) {
    opener = assetMenuOpener();
    if (!opener) return fail('asset menu button not found');
    opener.click();
    for (let i = 0; i < 8 && !list; i++) { await sleep(150); list = assetList(); }
    if (!list) return fail('asset list did not open', opener);
  }
  let item = assetItem(list, asset);
  if (!item) { // not in the visible category: use the list's search box
    const root = list.closest('[class*="assets-block"]')?.parentElement || list.parentElement || document;
    const input = [...root.querySelectorAll('input')].find(isShown);
    if (input) {
      typeInto(input, label.replace(/ OTC$/, ''));
      for (let i = 0; i < 8 && !item; i++) { await sleep(150); item = assetItem(assetList() || list, asset); }
    }
  }
  if (!item) return fail(`${label} not found in the asset list`, opener);
  item.click();
  for (let i = 0; i < 20 && state.asset !== asset; i++) await sleep(150); // PO confirms with changeSymbol
  if (assetList()) close();
  return state.asset === asset ? null : fail(`chart did not switch to ${label} (PO shows ${state.asset})`, opener);
}

function clickDirection(dir) {
  const btn = dir === 'call'
    ? $(['a.btn.btn-call', 'button.btn-call', '[class*="btn-call"]'])
    : $(['a.btn.btn-put', 'button.btn-put', '[class*="btn-put"]']);
  if (!btn) return false;
  btn.click();
  return true;
}

// ─── Risk & trading ─────────────────────────────────────────────────────────
function currentStake() {
  const s = state.settings;
  return +(s.amount * (s.martingale ? s.mgMultiplier ** state.mgStep : 1)).toFixed(2);
}

function limitHit() {
  const s = state.settings, ss = state.session;
  if (ss.pl <= -Math.abs(s.stopLoss)) return 'Stop loss reached';
  if (ss.pl >= Math.abs(s.takeProfit)) return 'Take profit reached';
  if (isHunter()) return null; // hunter: no trade-count or streak caps, by design
  if (ss.trades >= s.maxTrades) return 'Max trades reached';
  if (ss.streak <= -Math.abs(s.maxLossStreak)) return 'Loss streak limit reached';
  return null;
}
const openExposure = () => state.trades.reduce((a, t) => a + t.stake, 0);

const REASONS = {
  warming_up: () => `Warming up (${state.candles.length}/${MIN_CANDLES} candles)`,
  learning: () => `Auto: learning — no strategy is proven yet (needs ${state.settings.autoMinSamples}+ paper trades above break-even)`,
  no_setup: () => 'Watching — no setup',
  benched: () => `${Strategies[state.settings.strategy].title} is benched — its paper win rate is below break-even`,
  intel: () => globalThis.IntelTab?.statusLine() || 'Intel engine: waiting for 5M data',
};

function evaluate() {
  const s = state.settings;
  state.ev = evaluateAll(state.candles, s.required);
  state.report = !state.ev.ready ? null
    : s.strategy === 'engine' ? smcEngine(state.candles, state.ev.ind)
    : s.strategy === 'analyst' ? analyzeChart(state.candles, state.ev.ind)
    : s.strategy === 'scalp' ? scalpEngine(state.candles, state.ev.ind)
    : s.strategy === 'hunter' ? scalpEngine(state.candles, state.ev.ind, HUNTER_OPTS) : null;
  if (state.ev.ready) {
    const dir = currentSignal();
    const cdir = currentCopySignal();
    state.ev.results.copysig = { checks: [], calls: cdir === 'call' ? 1 : 0, puts: cdir === 'put' ? 1 : 0, raw: cdir, blocked: null, action: cdir };
    const obj = cdir ? copyPlusObjections(scalpEngine(state.candles, state.ev.ind, HUNTER_OPTS).diag, cdir) : [];
    state.copyPlus = cdir ? { dir: cdir, objections: obj } : null;
    state.ev.results.copyplus = { checks: [], calls: cdir === 'call' ? 1 : 0, puts: cdir === 'put' ? 1 : 0, raw: cdir,
      blocked: obj[0] || null, action: cdir && !obj.length ? cdir : null };
    state.ev.results.posignal = { checks: [], calls: dir === 'call' ? 1 : 0, puts: dir === 'put' ? 1 : 0,
      raw: dir, blocked: dir && state.ev.filters.skip, action: dir && !state.ev.filters.skip ? dir : null };
  }
  updateProofs();
  state.benched = new Set(STRATEGY_NAMES.filter(isBenched));
  state.decision = isIntel() ? { action: null, reason: 'intel', voters: [] }
    : decide(state.ev, s.strategy, { minVotes: s.minVotes, eligible: eligibleStrategies(), benched: state.benched });
}

// Intel mode: trading decisions come from the OTC Intelligence Engine (5M, multi-pair,
// coordinated by the service worker). The legacy 15s strategies keep paper-testing only.
const isIntel = () => state.settings.strategy === 'intel';

// Deals PO still shows as open, ignoring any whose close time is well past (missed close event).
function poOpenCount() {
  const now = state.lastTick?.ts;
  for (const [id, closeTs] of state.poOpen) if (now && closeTs && now > closeTs + 30) state.poOpen.delete(id);
  return state.poOpen.size;
}

// Opportunity hunter: every valid setup is judged on its own — no cooldown after a
// loss, no cap on trade count, and new trades may open while others run (up to a
// technical limit). Stop loss / take profit still protect the session.
const HUNTER_MAX_OPEN = 3;
const isHunter = () => state.settings.strategy === 'hunter';
const foreignOpen = () => { poOpenCount(); return [...state.poOpen.keys()].filter(id => !state.trades.some(t => t.id === id)).length; };

function onCandleClose() {
  evaluate();
  openShadows();
  if (state.cooldown > 0) state.cooldown--;
  if (!state.running) return render();
  if (isIntel()) { state.status = REASONS.intel(); return render(); }

  const d = state.decision, hunter = isHunter();
  state.skip = null;
  const skip = (ar, en) => { if (d.action) state.skip = { dir: d.action, why: ar }; state.status = en; };
  if (state.placing) skip('البوت لسه بيفتح صفقة قبلها', 'Placing a trade…');
  else if (!hunter && state.trades.length) skip('فيه صفقة مفتوحة، والـ Mode ده بيدخل صفقة واحدة بس في المرة', 'Waiting for trade result…');
  else if (hunter && state.trades.length >= HUNTER_MAX_OPEN) skip(`فيه ${state.trades.length} صفقات مفتوحة، وده الحد`, `${state.trades.length} trades open — waiting for one to close`);
  else if (foreignOpen() > 0) skip('فيه صفقة انت فاتحها بإيدك لسه مفتوحة في PO', 'Waiting — a trade opened outside the bot is still running in PO');
  else if (d.action && !hunter && state.cooldown > 0) skip(`استراحة بعد خسارة (${state.cooldown} شمعة)`, `Signal skipped — cooling down after loss (${state.cooldown})`);
  else if (d.action && !isDemoAccount() && state.settings.realNeedsProof && d.voters.some(v => !provenForReal(v))) {
    const unproven = d.voters.filter(v => !provenForReal(v)).map(v => Strategies[v].title);
    state.status = `Real account: skipped — not proven on ${state.asset} yet: ${unproven.join(', ')}`;
    state.skip = { dir: d.action, why: 'حساب حقيقي، والاستراتيجية لسه مااتأكدتش (محتاجة ★★)' };
  }
  else if (d.action) placeTrade(d.action, d.voters);
  else state.status = (REASONS[d.reason] || (() => `Watching — ${d.reason}`))();
  render();
}

async function placeTrade(dir, voters) {
  const s = state.settings;
  if (s.demoOnly && !isDemoAccount()) return stop('Blocked: not a demo account (Demo-only is ON)');
  const why = limitHit();
  if (why) return stop(why);
  const payout = readPayout();
  if (payout != null && payout < s.minPayout) {
    state.skip = { dir, why: `نسبة الربح ${payout}% أقل من الحد (${s.minPayout}%)` };
    state.status = `Signal skipped — payout ${payout}% < ${s.minPayout}%`; return render();
  }

  const stake = isHunter() ? s.amount : currentStake(); // no martingale in hunter
  // Open trades could all lose: count them against the stop loss too.
  if (stake + openExposure() > s.stopLoss + state.session.pl) {
    if (state.trades.length) {
      state.skip = { dir, why: `الصفقات المفتوحة + الصفقة دي (${money(stake + openExposure())}) أكبر من الـ Stop loss المتبقي (${money(+(s.stopLoss + state.session.pl).toFixed(2))})` };
      state.status = `Signal skipped — open trades already use the stop-loss room`; return render();
    }
    return stop(`Next stake ${money(stake)} would exceed stop loss`);
  }
  // Lock before the first await so a second signal can't start placing at the same time.
  const expiry = pickExpiry(voters);
  const trade = { id: null, dir, stake, expiry, asset: state.asset, openedAt: Date.now(), voters, payout, demo: isDemoAccount() };
  state.placing = true;
  const abort = (msg) => { state.placing = false; stop(msg); };
  if (s.autoExpiry) {
    const err = await setExpiry(expiry);
    if (!state.running) return abort('Stopped');
    if (err) {
      // On demo, keep the run going with whatever expiry PO already has (and record that one).
      // On real money, never trade an expiry the strategy wasn't proven on.
      const current = readExpiry();
      if (!trade.demo || current == null) {
        return abort(`Could not set expiry (${err}). Turn off "Bot picks expiry" and set it in PO yourself.`);
      }
      trade.expiry = current;
      state.expiryWarn = `Couldn't pick ${expiryLabel(expiry)} (${err}) — traded PO's ${expiryLabel(current)}`;
    } else state.expiryWarn = null;
  }
  if (!setAmount(stake)) return abort('Could not set trade amount — below PO minimum or layout changed?');
  await new Promise(r => setTimeout(r, 350));
  if (!state.running) return abort('Stopped');
  if (!clickDirection(dir)) return abort('Could not find CALL/PUT button');
  trade.openedAt = Date.now();
  state.trades.push(trade);
  state.placing = false;
  state.status = `Opened ${dir.toUpperCase()} ${money(stake)} ${expiryLabel(trade.expiry)} on ${state.asset} (${voters.join(', ')})`;
  setTimeout(() => {
    if (state.trades.includes(trade)) finishTrade(trade, null, 'unknown');
  }, RESULT_TIMEOUT_MS + 1000);
  render();
}

function onOrderOpened(data) {
  // PO confirms in order: give the id to the oldest bot trade still waiting for one.
  const t = state.trades.find(x => !x.id);
  if (t && data?.id) t.id = data.id;
}

function onOrderClosed(data) {
  const deals = Array.isArray(data?.deals) ? data.deals : Array.isArray(data) ? data : [data];
  for (const deal of deals) {
    if (!deal || !Number.isFinite(deal.profit)) continue;
    const t = state.trades.find(x => x.id && x.id === deal.id)
      || (state.trades.length === 1 && !state.trades[0].id ? state.trades[0] : null);
    if (t) finishTrade(t, deal.profit, deal.profit > 0 ? 'win' : deal.profit < 0 ? 'loss' : 'tie');
  }
}

function finishTrade(t, profit, result) {
  if (!t || !state.trades.includes(t)) return;
  state.trades = state.trades.filter(x => x !== t);
  const ss = state.session, s = state.settings;
  const pl = Number.isFinite(profit) ? profit : 0;
  ss.trades++;
  ss.pl = +(ss.pl + pl).toFixed(2);
  if (result === 'win') { ss.wins++; ss.streak = Math.max(1, ss.streak + 1); state.mgStep = 0; }
  else if (result === 'loss') {
    ss.losses++; ss.streak = Math.min(-1, ss.streak - 1);
    state.mgStep = s.martingale && state.mgStep < s.mgMaxSteps ? state.mgStep + 1 : 0;
    // Martingale's whole point is the next trade, so cooldown only applies without it.
    if (!s.martingale) state.cooldown = s.lossCooldown;
  } else ss.ties++;

  state.log.push({
    time: new Date(t.openedAt).toISOString(), asset: t.asset, dir: t.dir, stake: t.stake,
    result, profit: pl, currency: s.currency, demo: t.demo, mode: s.strategy,
    strategies: t.voters.join(' + '), payout: t.payout ?? '', period: s.period, expiry: t.expiry,
  });
  saveLog();
  if (t.intelId) globalThis.IntelTab?.onTradeClosed(t, result, pl);
  state.status = `${result.toUpperCase()} ${pl >= 0 ? '+' : ''}${pl} — session ${ss.pl >= 0 ? '+' : ''}${ss.pl}`;
  const why = limitHit();
  if (why) stop(why); else render();
}

function start() {
  if (state.settings.demoOnly && !isDemoAccount()) { state.status = 'Switch to the DEMO account first'; return render(); }
  state.running = true;
  state.session = newSession();
  state.mgStep = 0;
  state.cooldown = 0;
  state.status = state.candles.length >= MIN_CANDLES ? 'Running' : 'Loading price history…';
  if (state.candles.length < MIN_CANDLES) requestHistory();
  render();
}

function stop(reason = 'Stopped') {
  state.running = false;
  state.status = reason;
  render();
}

function exportCsv() {
  const cols = ['time', 'asset', 'dir', 'stake', 'result', 'profit', 'currency', 'demo', 'mode', 'strategies', 'payout', 'period', 'expiry'];
  const rows = [cols.join(',')].concat(state.log.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  a.download = `po-bot-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ─── Panel UI ───────────────────────────────────────────────────────────────

// ─── Arabic wording for the panel ───────────────────────────────────────────
const LEGACY_AR = { reversal: 'ارتداد بولينجر + RSI', stoch: 'ارتداد الاستوكاستك', sr: 'ارتداد دعم/مقاومة', trend: 'تقاطع EMA 9/21', macd: 'انقلاب زخم MACD',
  pullback: 'ارتداد مع الاتجاه', cci: 'ارتداد CCI', ac: 'تقاطع مؤشر التسارع', envelope: 'ارتداد من الغلاف', roc: 'زخم ROC', willr: 'ارتداد ويليامز',
  psar: 'انقلاب Parabolic SAR', streak: 'عكس سلسلة الشموع', analyst: 'محلل الشارت', engine: 'محرك المراحل التسع', hunter: 'صائد الفرص', scalp: 'السكالبينج',
  trendFade: 'عكس تقاطع EMA', macdFade: 'عكس انقلاب MACD', pullbackFade: 'عكس الارتداد', posignal: 'إشارات المنصة', copysig: 'إشارات النسخ', copyplus: 'نسخ مع تحقق' };
const legacyTitle = (n) => LEGACY_AR[n] || Strategies[n]?.title || n;
// Status messages are produced in English by the bot's logic; they are translated only for display.
const STATUS_AR = [
  [/^Running$/, 'يعمل'], [/^Loading price history/, 'تحميل تاريخ الأسعار…'], [/^Stopped$/, 'متوقف'], [/^Idle$/, ''],
  [/^Stop loss reached/, 'تم الوصول لحد الخسارة'], [/^Take profit reached/, 'تم الوصول لهدف الربح'], [/^Max trades reached/, 'تم الوصول لأقصى عدد صفقات'],
  [/^Loss streak limit reached/, 'خسائر متتالية كثيرة — توقف'], [/^Switch to the DEMO account/, 'انتقل إلى الحساب التجريبي أولًا'],
  [/^Blocked: not a demo account/, 'متوقف: الحساب ليس تجريبيًا'], [/^Applied "/, 'تم تطبيق إعدادات التجربة'], [/^PO socket not ready/, 'اتصال المنصة غير جاهز — تعذر تحميل التاريخ'],
  [/^Scanner: waiting for the live price/, 'الماسح: بانتظار وصول الأسعار'], [/^Scanner: PO asset list/, 'الماسح: قائمة الأزواج لم تصل — أعد تحميل الصفحة'],
  [/^Warming up \((\d+)\/(\d+)/, (m) => `تجميع الشموع (${m[1]}/${m[2]})`], [/^Watching — no setup/, 'يراقب — لا توجد فرصة'], [/^Watching — /, 'يراقب'],
  [/^Auto: learning/, 'يتعلّم — لا توجد استراتيجية مثبتة بعد'], [/is benched/, 'الاستراتيجية المختارة نتائجها أقل من نقطة التعادل'],
  [/^Real account: skipped/, 'حساب حقيقي: تم التجاوز — الاستراتيجية غير مثبتة على هذا الزوج'], [/^Signal skipped — payout/, 'تم تجاوز الإشارة — نسبة الربح أقل من الحد'],
  [/^Signal skipped — open trades/, 'تم تجاوز الإشارة — الصفقات المفتوحة تستهلك حد الخسارة'], [/^Signal skipped — cooling down/, 'تم تجاوز الإشارة — استراحة بعد خسارة'],
  [/^Placing a trade/, 'جاري فتح صفقة…'], [/^Waiting for trade result/, 'بانتظار نتيجة الصفقة…'], [/trades open — waiting/, 'صفقات مفتوحة — بانتظار إغلاق إحداها'],
  [/^Waiting — a trade opened outside/, 'بانتظار — صفقة فتحتها يدويًا ما زالت مفتوحة'], [/^Opened (CALL|PUT)/, (m) => `تم فتح صفقة ${m[1] === 'CALL' ? 'شراء' : 'بيع'}`],
  [/^(WIN|LOSS|TIE|UNKNOWN) ([+-]?[\d.]+)/, (m) => `${{ WIN: 'نجاح', LOSS: 'خسارة', TIE: 'تعادل', UNKNOWN: 'نتيجة غير معروفة' }[m[1]]} ${m[2]}`],
  [/^Next stake .* would exceed stop loss/, 'الصفقة التالية ستتجاوز حد الخسارة'], [/^Could not set expiry/, 'تعذر ضبط مدة الصفقة — اضبطها يدويًا في المنصة'],
  [/^Could not set trade amount/, 'تعذر ضبط مبلغ الصفقة'], [/^Could not find CALL\/PUT button/, 'تعذر العثور على زر الشراء/البيع'],
  [/^Backtest: /, 'الاختبار التاريخي: انظر التفاصيل في الوضع المتقدم'], [/^Intel/, (m, s) => globalThis.IntelTab?.statusLine() || 'المحرك الذكي يعمل'],
];
function statusAr(text) {
  for (const [re, ar] of STATUS_AR) { const m = re.exec(text || ''); if (m) return typeof ar === 'function' ? ar(m, text) : ar; }
  return text || '';
}
const GEAR_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/></svg>';
// Cairo for the panel: @font-face must live in the page, not the shadow root.
// The analysis card for this tab's pair: identical wording to the popup (ui/ar.js).
function intelCard(pv) {
  const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  if (!pv) return '<div class="big" style="font-size:16px">بانتظار الأسعار</div><div class="sub">افتح زوج OTC على الشارت</div>';
  if (!pv.last?.facts && !pv.opp) return '<div class="big" style="font-size:16px">تحليل جارٍ</div><div class="sub">يجهّز بيانات الدقيقة و5 دقائق و15 دقيقة والساعة</div>';
  const d = AR.decision(pv, pv.nowTs, globalThis.IntelTab?.cfg?.() || OTC.DEFAULT_CONFIG), w = AR.why(d.facts);
  const go = d.verdict === 'ENTER' && d.key === 'enter';
  const head = go ? `${AR.dir(d.dir)} — ادخل الآن` : d.verdict === 'WAIT' ? `${d.title}${d.dir ? ` · ${AR.dir(d.dir)}` : ''}` : d.title;
  const color = go ? `color:${d.dir === 'CALL' ? '#46b07f' : '#df6a62'}` : d.verdict === 'WAIT' ? 'color:#d4a64a' : '';
  const timer = d.timer && d.timer.sec > 0 ? `<div class="sub">${esc(d.timer.label)} ${AR.clock(d.timer.sec)}</div>` : '';
  const rows = d.rows.slice(0, 4).map(([k, v]) => `<div><span style="color:#8a92a3">${esc(k)}:</span> ${esc(v)}</div>`).join('');
  const lines = [...w.good.slice(0, 2).map((x) => `<div class="ok">✓ ${esc(x)}</div>`), ...w.bad.slice(0, 2).map((x) => `<div class="warn">! ${esc(x)}</div>`)];
  return `<div class="big" style="font-size:${go ? 20 : 16}px;${color}">${esc(head)}</div>${timer}
    ${rows ? `<div style="margin-top:6px;font-size:11.5px;text-align:right;display:grid;gap:2px">${rows}</div>` : ''}
    ${lines.length ? `<div style="margin-top:6px;font-size:11.5px;text-align:right;display:grid;gap:2px">${lines.join('')}</div>` : ''}`;
}

function loadPanelFont() {
  if (document.getElementById('pobot-cairo')) return;
  const st = document.createElement('style');
  st.id = 'pobot-cairo';
  st.textContent = `@font-face{font-family:'PoBotCairo';src:url('${chrome.runtime.getURL('fonts/Cairo.ttf')}') format('truetype');font-weight:200 1000;font-display:swap}`;
  (document.head || document.documentElement).appendChild(st);
}

function mountPanel() {
  if (root || !document.body) return;
  try { loadPanelFont(); } catch (_) {}
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:80px;right:16px;z-index:2147483647';
  document.body.appendChild(host);
  root = host.attachShadow({ mode: 'open' });
  const options = STRATEGY_NAMES.map(n => `<option value="${n}">${legacyTitle(n)}</option>`).join('');
  root.innerHTML = `
  <style>
    :host{all:initial}
    .p{width:310px;background:#12151b;color:#e8eaf0;font:12.5px/1.55 'PoBotCairo',system-ui,sans-serif;
       border:1px solid #262b36;border-radius:14px;box-shadow:0 12px 40px #000a;overflow:hidden}
    .h{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:move;user-select:none}
    .h .t{font-weight:700;font-size:13px;flex:1}
    .dot{width:8px;height:8px;border-radius:50%;background:#4a5060}.dot.on{background:#34d399;box-shadow:0 0 0 4px #34d39922}
    .ib{background:#1e222c;color:#aab1bf;border:0;border-radius:8px;width:26px;height:26px;cursor:pointer;font-size:13px}
    .ib:hover{background:#2a3040;color:#fff}
    .main{padding:0 12px 12px;display:grid;gap:10px}
    .badges{display:flex;gap:6px;flex-wrap:wrap}
    .badge{font-size:10.5px;padding:2px 8px;border-radius:999px;background:#1e222c;color:#aab1bf}
    .badge.demo{background:#1f3b2c;color:#6ee7b7}.badge.real{background:#4a1d1d;color:#fca5a5}
    .hero{border-radius:12px;padding:12px;background:#1a1e27;text-align:center}
    .hero .big{font-size:20px;font-weight:800;letter-spacing:.3px}
    .hero .sub{color:#8b93a3;font-size:11px;margin-top:2px}
    .hero.call{background:linear-gradient(135deg,#0f3d2b,#14532d)}.hero.put{background:linear-gradient(135deg,#4c1414,#7f1d1d)}
    .bar{height:4px;background:#ffffff22;border-radius:4px;margin-top:8px;overflow:hidden}.bar i{display:block;height:100%;background:#fff;border-radius:4px}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;text-align:center}
    .stats div{background:#1a1e27;border-radius:10px;padding:7px 2px;color:#8b93a3;font-size:10.5px}
    .stats b{display:block;font-size:15px;color:#e8eaf0;font-variant-numeric:tabular-nums}
    .stake{display:flex;align-items:center;gap:8px;background:#1a1e27;border-radius:10px;padding:6px 10px}
    .stake span{color:#8b93a3;flex:1}
    .stake input{width:90px;text-align:right;font-size:14px;font-weight:700;background:transparent;border:0;color:#fff;padding:2px}
    .acts{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .acts button{height:38px;border:0;border-radius:10px;font:700 13px system-ui;cursor:pointer}
    .go{background:#10b981;color:#04130d}.go:disabled{background:#1a1e27;color:#4a5060;cursor:default}
    .st{background:#ef4444;color:#fff}.st:disabled{background:#1a1e27;color:#4a5060;cursor:default}
    .link{background:none;border:0;color:#6d93e8;cursor:pointer;font:inherit;padding:0;text-decoration:underline}
    .status{color:#8b93a3;font-size:11px;text-align:center;min-height:15px}
    .adv{border-top:1px solid #222733;padding:10px 12px;display:grid;gap:8px;max-height:58vh;overflow-y:auto}
    .hidden{display:none}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:6px}
    label{display:grid;gap:2px;color:#8b93a3;font-size:11px}
    input,select{background:#0c0e13;color:#e8eaf0;border:1px solid #262b36;border-radius:7px;padding:4px 6px;font:inherit;min-width:0}
    .chk{display:flex;align-items:center;gap:6px;color:#cfd4de}
    .adv button{border:0;border-radius:7px;padding:7px;font:600 12px system-ui;cursor:pointer}
    .sec{background:#1e222c;color:#cfd4de}
    .filters{background:#0c0e13;border-radius:7px;padding:6px;color:#8b93a3;font-size:11px}
    table{width:100%;border-collapse:collapse;font-size:11px}
    td,th{padding:3px 4px;text-align:left;border-bottom:1px solid #1d212b}
    th{color:#6b7280;font-weight:500}
    td.n{text-align:right;font-variant-numeric:tabular-nums}
    details summary{cursor:pointer;color:#aab1bf;font-size:11.5px;font-weight:600}
    .ok{color:#34d399}.neg{color:#f87171}.no{color:#596173}.warn{color:#fbbf24}
    .min .main,.min .adv{display:none}
  </style>
  <div class="p" dir="rtl">
    <div class="h"><span class="dot" id="dot"></span><span class="t">مراقب OTC</span>
      <button class="ib" id="gear" title="الإعدادات والتفاصيل" aria-label="الإعدادات">${GEAR_SVG}</button><button class="ib" id="min" title="تصغير" aria-label="تصغير">–</button></div>
    <div class="main" dir="rtl">
      <div class="badges"><span class="badge" id="acct"></span><span class="badge" id="pair"></span><span class="badge" id="pay"></span></div>
      <div class="hero" id="hero"></div>
      <div class="stats">
        <div><b id="sTr">0</b>صفقات</div><div><b id="sWr">–</b>نسبة الكسب</div>
        <div><b id="sPl">0</b>الربح</div><div><b id="sSk">0</b>متتالي</div>
      </div>
      <div class="stake"><span>مبلغ الصفقة <span class="cur"></span></span><input id="amount" type="number" min="1" step="1"></div>
      <div class="acts"><button class="go" id="start">تشغيل</button><button class="st" id="stop">إيقاف</button></div>
      <div class="status" id="engine"></div>
      <div class="status" id="status"></div>
    </div>
    <div class="adv hidden" id="adv">
      <label class="chk"><input type="checkbox" id="demoOnly"> الحساب التجريبي فقط</label>
      <label class="chk"><input type="checkbox" id="realNeedsProof"> على الحساب الحقيقي: ادخل بس بالاستراتيجيات اللي عليها ★★</label>
      <div id="reportBox" class="hidden"><div style="font-weight:700;margin-bottom:4px">تحليل الشارت — هذا ما يتصرف البوت على أساسه</div>
        <div id="report" dir="rtl" style="font-size:11px;line-height:1.6;background:#0c0e13;border-radius:8px;padding:8px"></div></div>
      <div class="filters" id="intelBox"></div>
      <button class="sec" id="openDash">فتح لوحة الوضع المتقدم</button>
      <div class="filters" id="filters"></div>
      <div class="filters" id="copyLine" dir="rtl"></div>
      <table><thead><tr><th>الاستراتيجية</th><th>الآن</th><th>المدة</th><th class="n">ورقي</th><th class="n">النجاح</th></tr></thead><tbody id="strats"></tbody></table>
      <div class="row">
        <label>الوضع<select id="strategy">
          <option value="intel">المحرك الذكي (5 دقائق، عدة أزواج)</option>
          <option value="consensus">إجماع الاستراتيجيات</option>
          <option value="auto">تلقائي (المثبت فقط)</option>
          <optgroup label="استراتيجية واحدة">${options}</optgroup>
        </select></label>
        <label>شروط كل استراتيجية<select id="required"><option>2</option><option>3</option><option>4</option></select></label>
      </div>
      <div class="row">
        <label>أقل عدد أصوات<select id="minVotes"><option>1</option><option>2</option><option>3</option></select></label>
        <label id="expiryLbl">مدة ثابتة (ث)<select id="expiry"><option>15</option><option>30</option><option>60</option><option>120</option><option>180</option><option>300</option></select></label>
      </div>
      <div class="row">
        <label>عملة الحساب<select id="currency"><option>EGP</option><option>USD</option><option>EUR</option><option>SAR</option><option>AED</option></select></label>
      </div>
      <div class="row">
        <label>حد الخسارة <span class="cur"></span><input id="stopLoss" type="number" min="1"></label>
        <label>هدف الربح <span class="cur"></span><input id="takeProfit" type="number" min="1"></label>
      </div>
      <label class="chk"><input type="checkbox" id="autoExpiry"> البوت يختار مدة الصفقة لكل استراتيجية</label>
      <button class="sec" id="backtest">اختبار تاريخي على شموع الشارت المحمّلة</button>
      <details id="scanBox">
        <summary>ماسح الأزواج</summary>
        <div class="b" style="padding:8px 0 0">
          <div class="row">
            <label>عدد الأزواج<input id="scanPairs" type="number" min="1" max="40"></label>
            <label>ساعات لكل زوج<input id="scanHours" type="number" min="2" max="24"></label>
          </div>
          <button class="sec" id="scan">مسح الأزواج</button>
          <div class="filters" id="scanProgress"></div>
          <table><thead><tr><th>الزوج</th><th class="n">الربح</th><th>أفضل تركيبة</th><th class="n">تدريب</th><th class="n">تحقق</th><th></th></tr></thead><tbody id="scanRows"></tbody></table>
        </div>
      </details>
      <details>
        <summary>الحماية والإعدادات المتقدمة</summary>
        <div class="b" style="padding:8px 0 0">
          <div class="row">
            <label>أقصى عدد صفقات<input id="maxTrades" type="number" min="1"></label>
            <label>أقصى خسائر متتالية<input id="maxLossStreak" type="number" min="1"></label>
          </div>
          <div class="row">
            <label>استراحة بعد الخسارة (شموع)<input id="lossCooldown" type="number" min="0"></label>
            <label>أقل نسبة ربح %<input id="minPayout" type="number" min="0" max="100"></label>
          </div>
          <div class="row">
            <label>صفقات ورقية للإثبات<input id="autoMinSamples" type="number" min="10"></label>
            <label>هامش فوق التعادل %<input id="autoMargin" type="number" min="0" step="0.5"></label>
          </div>
          <label>أطول مدة مسموحة<select id="maxExpiry"><option value="15">15 ثانية</option><option value="30">30 ثانية</option><option value="60">دقيقة</option><option value="180">3 دقائق</option><option value="300">5 دقائق</option></select></label>
          <label>شمعة التحليل (ث)<select id="period"><option>5</option><option>10</option><option>15</option><option>30</option><option>60</option></select></label>
          <label class="chk"><input type="checkbox" id="martingale"> مضاعفة بعد الخسارة (مارتينجال — غير موصى به)</label>
          <div class="row" id="mgRow">
            <label>المضاعف<input id="mgMultiplier" type="number" min="1.1" step="0.1"></label>
            <label>أقصى خطوات (≤4)<input id="mgMaxSteps" type="number" min="1" max="4"></label>
          </div>
          <div class="row"><button class="sec" id="csv">تصدير CSV</button><button class="sec" id="clear">مسح السجل</button></div>
          <button class="sec" id="resetShadow">تصفير النتائج الورقية</button>
          <div style="color:#9aa1ad;font-size:11px">إشارات المنصة — نسبة صعود السعر بعد كل رمز (كل الأزواج). تُلوَّن فقط إذا تجاوز الميل نقطة التعادل بثقة 90%.</div>
          <table><thead><tr><th>المدة</th><th class="n">1</th><th class="n">2</th><th class="n">3</th><th class="n">4</th></tr></thead><tbody id="codes"></tbody></table>
          <button class="sec" id="presetDemo">تطبيق إعدادات تجربة الساعتين</button>
        </div>
      </details>
      <div id="feed" style="color:#596173;font-size:11px"></div>
    </div>
  </div>`;

  for (const k of FIELDS) {
    root.getElementById(k).addEventListener('change', (e) => {
      const v = e.target.value;
      state.settings[k] = NUMERIC.includes(k) ? Number(v) : v;
      if (k === 'mgMaxSteps') state.settings[k] = Math.min(4, Math.max(1, state.settings[k]));
      if (k === 'period') { resetCandles(state.asset); requestHistory(); }
      if (k === 'expiry') state.shadowOpen = [];
      if (state.ev?.ready) evaluate();
      saveSettings(); render();
    });
  }
  root.getElementById('autoExpiry').addEventListener('change', (e) => { state.settings.autoExpiry = e.target.checked; saveSettings(); render(); });
  root.getElementById('martingale').addEventListener('change', (e) => { state.settings.martingale = e.target.checked; saveSettings(); render(); });
  root.getElementById('demoOnly').addEventListener('change', (e) => {
    if (!e.target.checked && !confirm('السماح بالتداول على حساب حقيقي؟ قد تخسر أموالًا حقيقية.')) { e.target.checked = true; return; }
    state.settings.demoOnly = e.target.checked; saveSettings(); render();
  });
  root.getElementById('realNeedsProof').addEventListener('change', (e) => {
    if (!e.target.checked) {
      const per = (state.settings.amount * 0.04).toFixed(1);
      const ok = confirm(`كده البوت هيدخل على الحساب الحقيقي باستراتيجيات لسه ماثبتتش إنها بتكسب.\n\n` +
        `كل اللي اتجرّب لحد دلوقتي نسبة كسبه حوالي 50%، ونقطة التعادل 52%. يعني متوقع تخسر حوالي ${per} ${state.settings.currency} في كل صفقة في المتوسط.\n\n` +
        `الـ Stop loss هيفضل شغال. متأكد؟`);
      if (!ok) { e.target.checked = true; return; }
    }
    state.settings.realNeedsProof = e.target.checked; saveSettings(); render();
  });
  root.getElementById('openDash').onclick = () => globalThis.IntelTab?.openDashboard();
  root.getElementById('start').onclick = start;
  root.getElementById('stop').onclick = () => stop();
  root.getElementById('csv').onclick = exportCsv;
  root.getElementById('scan').onclick = () => { runScanner(); render(); };
  root.getElementById('backtest').onclick = () => { state.status = backtestCurrent(); render(); };
  root.getElementById('clear').onclick = () => { if (confirm('حذف كل الصفقات المسجلة؟')) { state.log = []; saveLog(); render(); } };
  root.getElementById('resetShadow').onclick = () => {
    if (!confirm('تصفير كل النتائج الورقية؟')) return;
    state.shadow = {}; state.shadowOpen = []; chrome.storage.local.set({ shadow: {} }); render();
  };
  root.getElementById('presetDemo').onclick = () => {
    const before = state.settings.period;
    Object.assign(state.settings, PRESETS.demoTest.values);
    if (state.settings.period !== before) { resetCandles(state.asset); requestHistory(); }
    saveSettings(); state.status = `Applied "${PRESETS.demoTest.title}" settings`; render();
  };
  root.getElementById('min').onclick = () => root.querySelector('.p').classList.toggle('min');
  root.getElementById('gear').onclick = () => { root.getElementById('adv').classList.toggle('hidden'); render(); };

  // drag
  const head = root.querySelector('.h');
  head.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    const r = host.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => { host.style.left = `${ev.clientX - dx}px`; host.style.top = `${ev.clientY - dy}px`; host.style.right = 'auto'; };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
  render();
}

const fmt = (v, d = 0) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));

function render() {
  if (!root) return;
  const s = state.settings, ss = state.session;
  const q = (id) => root.getElementById(id);
  for (const k of FIELDS) {
    const el = q(k);
    if (root.activeElement !== el) el.value = s[k];
  }
  root.querySelectorAll('.cur').forEach(el => { el.textContent = `(${s.currency})`; });
  q('martingale').checked = s.martingale;
  q('mgRow').style.display = s.martingale ? '' : 'none';
  q('demoOnly').checked = s.demoOnly;
  q('realNeedsProof').checked = s.realNeedsProof !== false;
  q('autoExpiry').checked = s.autoExpiry;
  q('expiryLbl').style.opacity = s.autoExpiry ? 0.4 : 1;
  q('expiry').disabled = s.autoExpiry;
  q('start').disabled = state.running;

  q('status').innerHTML = state.hookFailed
    ? '<span class="warn">في إضافة تانية قافلة الأسعار. اقفل البوتات التانية واعمل reload.</span>'
    : (state.running ? '' : statusAr(state.status)) + (state.expiryWarn ? `<br><span class="warn">تعذر اختيار المدة المطلوبة، فاستُخدمت مدة المنصة الحالية</span>` : '');
  q('dot').className = `dot${state.running ? ' on' : ''}`;
  q('stop').disabled = !state.running;
  const demo = isDemoAccount();
  q('acct').className = `badge ${demo ? 'demo' : 'real'}`;
  q('acct').textContent = demo ? 'ديمو' : 'حساب حقيقي';
  q('pair').textContent = (state.asset || '—').replace('_otc', ' OTC');
  const payNow = readPayout();
  q('pay').textContent = payNow != null ? `ربح ${payNow}%` : 'ربح ?';

  // hero: an open trade, otherwise the same analysis the popup shows for this pair
  const hero = q('hero');
  const t = [...state.trades].sort((x, y) => (x.openedAt + x.expiry * 1000) - (y.openedAt + y.expiry * 1000))[0];
  if (t) {
    const total = (t.expiry || 60) * 1000, left = Math.max(0, t.openedAt + total - Date.now());
    const mm = String(Math.floor(left / 60000)).padStart(2, '0'), ss2 = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
    hero.className = `hero ${t.dir}`;
    hero.innerHTML = `<div class="big">${t.dir === 'call' ? 'شراء' : 'بيع'} · ${money(t.stake)}</div>
      <div class="sub" style="color:#ffffffcc">صفقة مفتوحة · باقٍ ${mm}:${ss2}${state.trades.length > 1 ? ` · و${state.trades.length - 1} صفقة أخرى` : ''}</div>
      <div class="sub" style="color:#ffffffaa">${t.intelId ? 'نفّذها المحرك الذكي' : 'نفّذها البوت القديم (شموع 15 ثانية)'}</div>
      <div class="bar"><i style="width:${100 - (left / total) * 100}%"></i></div>`;
  } else {
    hero.className = 'hero';
    hero.innerHTML = intelCard(globalThis.IntelTab?.pairView(state.asset));
  }
  // Which system executes trades in this tab — never ambiguous.
  q('engine').innerHTML = isIntel()
    ? (state.running ? '<span class="ok">التنفيذ في هذا التبويب: المحرك الذكي</span>' : '<span class="no">التنفيذ في هذا التبويب: متوقف — المراقبة مستمرة</span>')
    : `<span class="warn">التنفيذ هنا بالبوت القديم (شموع 15 ثانية)${state.running ? ' — يعمل الآن' : ''}، والتحليل أعلاه من المحرك الذكي.</span> <button class="link" id="useIntel">استخدام المحرك الذكي</button>`;
  const useIntel = q('useIntel');
  if (useIntel) useIntel.onclick = () => { state.settings.strategy = 'intel'; saveSettings(); evaluate(); render(); };
  q('start').textContent = isIntel() ? 'تفعيل التنفيذ' : 'تشغيل البوت القديم';
  q('stop').textContent = 'إيقاف';
  q('sTr').textContent = ss.trades;
  const decided = ss.wins + ss.losses;
  q('sWr').textContent = decided ? `${Math.round((ss.wins / decided) * 100)}` : '–';
  q('sPl').textContent = (ss.pl >= 0 ? '+' : '') + ss.pl;
  q('sPl').title = s.currency;
  q('sPl').className = ss.pl > 0 ? 'ok' : ss.pl < 0 ? 'neg' : '';
  q('sSk').textContent = ss.streak;
  if (q('adv').classList.contains('hidden')) return; // nothing below is visible

  const rep = state.report;
  q('reportBox').classList.toggle('hidden', !rep);
  if (rep) {
    const head = `<div style="font-size:13px;font-weight:700;margin-bottom:4px" class="${rep.verdict === 'NO TRADE' ? 'warn' : 'ok'}">
      ${rep.verdict === 'CALL' ? 'شراء' : rep.verdict === 'PUT' ? 'بيع' : 'لا صفقة'} <span class="no" style="font-weight:400">— ${rep.why}</span></div>`;
    const body = rep.fields
      ? rep.fields.map(([k, v]) => `<div><span class="no">${k}:</span> ${v}</div>`).join('')
      : rep.sections
      ? rep.sections.map(([title, rows]) => `<div style="margin-top:6px;font-weight:600">${title}</div>` +
          rows.map(([k, v]) => `<div><span class="no">${k}:</span> ${v}</div>`).join('')).join('')
      : (rep.items || []).map(([k, v]) => `<div><span class="no">${k}:</span> ${v}</div>`).join('') +
        (rep.pros?.length ? `<div style="margin-top:4px" class="ok">${rep.pros.map(x => '✓ ' + x).join('<br>')}</div>` : '') +
        (rep.cons?.length ? `<div style="margin-top:4px" class="neg">${rep.cons.map(x => '✗ ' + x).join('<br>')}</div>` : '');
    q('report').innerHTML = head + body + '<div class="no" style="margin-top:6px">لا مضاعفة، ولا نسبة نجاح مفترضة، ولا ضمانات.</div>';
  }

  q('intelBox').innerHTML = globalThis.IntelTab?.panelHtml() || 'المحرك الذكي غير محمّل';

  // Market filters + payout
  const payout = readPayout(), be = breakEven(payout);
  const f = state.ev?.filters;
  q('filters').innerHTML = [
    f ? `ADX ${fmt(f.adx)} ${f.adx >= 30 ? '(اتجاه قوي)' : f.adx < 20 ? '(سوق هادئ)' : ''}` : 'الفلاتر: بانتظار الشموع',
    f?.skip ? `<span class="warn">${f.skip === 'Spike candle' ? 'شمعة مفاجئة' : 'السوق هادئ جدًا'}</span>` : '',
    `الربح ${payout != null ? payout + '%' : '?'} ← نقطة التعادل ${fmt(be, 1)}%`,
  ].filter(Boolean).join(' · ');


  // Per-strategy table: live state + shadow win rate
  const eligible = eligibleStrategies();
  q('strats').innerHTML = STRATEGY_NAMES.map((name) => {
    const r = state.ev?.results?.[name];
    const now = state.benched?.has(name) ? '<span class="neg" title="نتائجها الورقية أقل من التعادل فلا تصوّت">موقوفة</span>'
      : !r ? '<span class="no">–</span>'
      : r.action ? `<span class="ok">${r.action === 'call' ? 'شراء' : 'بيع'}</span>`
      : r.raw ? `<span class="warn" title="${r.blocked}">${r.raw === 'call' ? 'شراء' : 'بيع'} ممنوع</span>`
      : `<span class="no">${Math.max(r.calls, r.puts)}/4</span>`;
    const best = bestExpiry(name), st = best.stats;
    const wrClass = st.winRate == null ? 'no' : best.proven ? 'ok' : st.winRate >= be ? 'warn' : 'neg';
    const fwd = forwardStats(name);
    const star = provenForReal(name) ? ' ★★'
      : eligible.has(name) ? ` <span title="Proven on past data — forward test: ${fwd ? `${fwd.w}/${fwd.n} new paper trades (needs ${FORWARD_MIN}+ above break-even)` : 'starts on this pair'}">★${fwd ? `<span class="no">${fwd.n}/${FORWARD_MIN}</span>` : ''}</span>` : '';
    const perExpiry = shadowExpiries().map((e) => {
      const x = shadowStats(name, e);
      return `${expiryLabel(e)}: ${x.n ? `${fmt(x.winRate)}% of ${x.n}${x.bt ? `, ${x.bt} from backtest` : ''} (≥${fmt(x.low)}%)` : '–'}`;
    }).join(' | ');
    const checks = (r?.checks || []).map(c => `${c.label}: ${c.call ? '▲' : ''}${c.put ? '▼' : ''}`).join(', ');
    return `<tr title="${Strategies[name].family} · ${checks}&#10;Paper by expiry — ${perExpiry}">
      <td>${legacyTitle(name)}${star}</td><td>${now}</td>
      <td>${expiryLabel(best.expiry)}${best.fallback ? '<span class="no">?</span>' : ''}</td>
      <td class="n">${st.n}${st.n ? ` <span class="no">${st.scope}</span>` : ''}</td>
      <td class="n ${wrClass}" title="90% confident the real win rate is at least ${fmt(st.low)}%">${fmt(st.winRate)}</td></tr>`;
  }).join('');

  const sc = state.scan;
  q('scan').textContent = sc.running ? 'إيقاف المسح'
    : `مسح الأزواج (~${Math.ceil((s.scanPairs * Math.ceil((s.scanHours * 3600) / HISTORY_OFFSET) * 0.6) / 60)} دقيقة)`;
  q('scanProgress').textContent = sc.running ? 'جاري المسح…' : sc.progress ? 'انتهى المسح — النتائج بالأسفل' : 'يحمّل تاريخ الأزواج الأعلى ربحًا ويختبر كل استراتيجية: الاختيار على أقدم ثلثين، والتأكيد على الثلث الأحدث.';
  const pct = (w, n) => (n ? `${fmt((w / n) * 100)}%<span class="no"> ${n}</span>` : '–');
  q('scanRows').innerHTML = sc.results.map((r) => {
    const b = r.passes?.[0] || r.best;
    if (!b) return `<tr><td>${r.asset}</td><td class="n">${r.payout}</td><td colspan="4" class="no">${r.note ? 'بيانات غير كافية' : 'لا توجد تركيبة بـ 30 صفقة'}</td></tr>`;
    const ok = r.passes?.length > 0;
    return `<tr title="${fmt(r.hours, 1)}h · ${r.candidates} combos cleared training · break-even ${fmt(r.breakEven, 1)}%">
      <td>${r.asset.replace('_otc', '')}</td><td class="n">${r.payout}</td>
      <td>${legacyTitle(b.name)} ${expiryLabel(b.expiry)}</td>
      <td class="n">${pct(b.trainW, b.trainN)}</td>
      <td class="n ${b.checkN && (b.checkW / b.checkN) * 100 >= r.breakEven ? 'ok' : 'neg'}">${pct(b.checkW, b.checkN)}</td>
      <td class="${ok ? 'ok' : 'neg'}">${ok ? '✓' : '✗'}</td></tr>`;
  }).join('');

  const cRow = (label, st) => {
    const nn = st ? st.w + st.l : 0;
    return `<div>${label}: ${nn ? `<b>${st.w}/${nn}</b> (${fmt((st.w / nn) * 100)}%) · أقل حاجة ${fmt(wilsonLow(st.w, nn))}%` : '—'}</div>`;
  };
  q('copyLine').innerHTML = copy.stats['*']
    ? `<div style="font-weight:600">إشارات النسخ على الورق (نقطة التعادل ${fmt(be, 1)}%)</div>` +
      cRow('كل الإشارات', copy.stats['*']) + cRow('اجتازت التحقق', copy.stats['plus:taken']) + cRow('رفضها التحقق', copy.stats['plus:rejected']) +
      `<div class="no">في الانتظار ${copy.queue.length}${state.copyPlus ? ` · الآن: ${state.copyPlus.dir === 'call' ? 'شراء' : 'بيع'} ${state.copyPlus.objections.length ? '— ' + state.copyPlus.objections[0] : '— مقبولة'}` : ''}</div>`
    : `إشارات النسخ: ${copy.queue.length ? `${copy.queue.length} إشارة بانتظار انتهاء وقتها` : 'افتح قائمة الإشارات في المنصة ليقرأها البوت'}`;

  q('codes').innerHTML = SIGNAL_MINUTES.map(min => `<tr><td>${min} د</td>${[1, 2, 3, 4].map((code) => {
    const st = sigStats[`*|${min}|${code}`];
    const n = st ? st.up + st.down : 0;
    if (!n) return '<td class="n no">–</td>';
    const up = (st.up / n) * 100;
    // Following the code wins whichever way it leans; is that lean beyond break-even with confidence?
    const lean = Math.max(st.up, st.down), lo = wilsonLow(lean, n);
    const edge = lo >= breakEven(readPayout());
    return `<td class="n ${edge ? (st.up >= st.down ? 'ok' : 'neg') : ''}" title="${st.up} up / ${st.down} down / ${st.flat} flat · following it: ${fmt((lean / n) * 100)}%, at least ${fmt(lo)}% (90%)${edge ? ' — EDGE' : ''}">${fmt(up)}<span class="no"> ${n}</span></td>`;
  }).join('')}</tr>`).join('');

  const age = state.lastTickAt ? Math.round((Date.now() - state.lastTickAt) / 1000) : null;
  q('feed').textContent = `${(state.asset || 'لا يوجد زوج').replace('_otc', ' OTC')} · ${state.candles.length} شمعة · ` +
    (age === null ? 'لم تصل أسعار بعد' : age < 5 ? 'الأسعار تصل' : `آخر سعر منذ ${age} ث`) + ` · الصفقة التالية ${money(currentStake())} · ` +
    `${state.shadowOpen.length} ورقية مفتوحة · السجل ${state.log.length}`;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountPanel);
else mountPanel();
setInterval(render, 1000);
