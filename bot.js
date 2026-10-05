// PO Bot — the page side of the extension. It reads Pocket Option's price stream, asset list, history,
// platform signals and copy-trading list, and places trades through PO's own controls. It has no strategy
// of its own: every decision comes from the intelligence engine (intel-tab.js + engine/): the strategy
// consensus, or verified copy signals ("Copy + verify").

const DEFAULTS = {
  strategy: 'both',       // what this tab places: 'intel' (the engine's opportunities), 'copyplus' (verified copy signals) or 'both'
  currency: 'EGP',        // label only — PO trades in the account's own currency
  amount: 50,             // stake per trade
  demoOnly: true,         // this tab never trades on a real account while on
  minPayout: 80,          // "استراتيجيات يوتيوب": no entry below this payout (%)
  stopLoss: 0,            // stop for the day once the day's money falls this far below its highest point today (0 = off)
  stopLossFrom: 0,        // when the stop loss was set (ms): it counts the trades from then on (and from today's start)
  target: 0,              // the day's profit target: once the money since it was set reaches it, the bot closes the day (0 = off)
  targetFrom: 0,          // when the target was set (ms)
  stopFloor: 0,           // the balance the user wants kept (the stop loss = balance then − this); 0 = given as an amount
  maxOpen: 0,             // at most this many of the bot's trades open at the same time (0 = no limit)
};
const ENGINES = ['intel', 'copyplus', 'both', 'keltner', 'youtube'];
const SETTINGS_VERSION = 8; // v8: the panel's payout floor and stop loss (an older minPayout is not carried over)
const RESULT_TIMEOUT_MS = 15 * 60 * 1000;

const state = {
  settings: { ...DEFAULTS },
  running: false,
  asset: null,            // the pair on this tab's chart (PO's changeSymbol / first live ticks)
  lastTickAt: 0,
  lastTick: null,         // { ts, price } of the chart pair, in PO's clock
  hookFailed: false,
  trades: [],             // trades this tab placed and is waiting on
  late: [],               // placed trades past their end with no result yet: not open any more, still matched when PO reports them
  placing: false,         // a trade is being placed right now (amount/expiry/click in progress)
  poOpen: new Map(),      // every deal PO reports open (the bot's, manual, or from before a reload) → closeTimestamp
  session: null,
  hist: {},               // asset → Map(time → 5s candle) from PO's history (scoring PO's signals)
  assets: [],             // PO's asset list: { symbol, name, type, payout, active, expiries }
  status: 'Idle',
  log: [],
};

let root; // panel shadow root, set by mountPanel()

const newSession = () => ({ pl: 0, trades: 0, wins: 0, losses: 0, ties: 0, streak: 0, startedAt: Date.now() });
state.session = newSession();

// ─── Storage ────────────────────────────────────────────────────────────────
// v7: the old one-pair bot (its strategies, paper tests, scanner, backtest, martingale) is gone; a tab set
// to one of its modes now runs the intelligence engine. Only the stake, currency and demo-only carry over.
chrome.storage.local.get(['settings', 'log'], (r) => {
  const s = r.settings || {};
  state.settings = { ...DEFAULTS, currency: s.currency || DEFAULTS.currency, amount: Number(s.amount) > 0 ? Number(s.amount) : DEFAULTS.amount,
    demoOnly: s.demoOnly !== false, strategy: ENGINES.includes(s.strategy) ? s.strategy : DEFAULTS.strategy, version: SETTINGS_VERSION,
    minPayout: s.version >= 8 && Number(s.minPayout) > 0 ? Number(s.minPayout) : DEFAULTS.minPayout, stopLoss: s.version >= 8 && Number(s.stopLoss) >= 0 ? Number(s.stopLoss) : DEFAULTS.stopLoss,
    maxOpen: Number(s.maxOpen) >= 0 ? Math.floor(Number(s.maxOpen)) : DEFAULTS.maxOpen, stopLossFrom: Number(s.stopLossFrom) || 0, stopFloor: Number(s.stopFloor) || 0,
    target: Number(s.target) > 0 ? Number(s.target) : 0, targetFrom: Number(s.targetFrom) || 0 };
  if (globalThis.PO_EDITION?.locked) state.settings.strategy = 'youtube'; // locked edition: one mode
  saveSettings();
  if (Array.isArray(r.log)) state.log = r.log;
  restoreDeals(); // before PO's lists of open/closed deals come in, so their results are matched
  render();
  setTimeout(resumeAfterReload, 1500);
});
const money = (v) => `${v} ${state.settings.currency}`;
function saveSettings() { chrome.storage.local.set({ settings: state.settings }); }
const saveLog = () => chrome.storage.local.set({ log: state.log.slice(-5000) });
// The money of the bot's trades on this account since the stop loss was set (and since today's start; PO's own
// results): the result, its highest point, and how far below it the result is now. The stop loss counts from that
// highest point, so good trades do not hide the losses after them (2026-10-04: +865 by 13:32, then −812, and a
// stop loss of 250 measured against the whole day never fired).
function dayMoney(since = state.settings.stopLossFrom) {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const from = Math.max(d0.getTime(), since || 0), demo = isDemoAccount();
  let net = 0, peak = 0, n = 0;
  for (const l of state.log) {
    if (new Date(l.time).getTime() < from || !!l.demo !== demo) continue;
    net += l.result === 'unknown' ? -(Number(l.stake) || 0) : Number(l.profit) || 0; n++; if (net > peak) peak = net; // unknown = lost (the safe side)
  }
  return { net: +net.toFixed(2), peak: +peak.toFixed(2), down: +(peak - net).toFixed(2), n };
}
// hit once not even one more trade fits: what is left before the max loss is less than the stake
const stopLossHit = () => state.settings.stopLoss > 0 && state.settings.stopLoss - dayMoney().down < (state.settings.amount || 0) - 1e-9;
// what the trades open now can still lose (their stakes)
const openRisk = () => state.trades.reduce((a, t) => a + (Number(t.stake) || 0), 0);
// how much more can be lost before the stop loss: a new trade is placed only if its stake fits (Infinity = no limit)
const stopLossRoom = () => (state.settings.stopLoss > 0 ? +(state.settings.stopLoss - dayMoney().down - openRisk()).toFixed(2) : Infinity);
// a stop loss set (or changed) counts from now
function setStopLoss(v) { state.settings.stopLoss = v; state.settings.stopLossFrom = Date.now(); saveSettings(); }
// the day's profit target: reached once the money since it was set (today) is that much up — the bot closes the day
const targetMoney = () => dayMoney(state.settings.targetFrom);
const targetHit = () => state.settings.target > 0 && targetMoney().net >= state.settings.target;
function setTarget(v) { state.settings.target = v; state.settings.targetFrom = Date.now(); saveSettings(); }

// ─── After every trade PO opens: is it the trade the bot meant? ───────────────
// The amount, the pair, the direction, the duration and the account of PO's deal against what the bot clicked for.
// Any difference stops the bot at once (a fast entry must never become a wrong one) and the panel says what.
const ARDIR = { call: 'شراء', put: 'بيع' };
function dealMismatch(t, d) {
  const out = [];
  if (Number(d.amount) > 0 && Math.abs(Number(d.amount) - Number(t.stake)) > 0.01) out.push(`المبلغ ${d.amount} بدل ${t.stake}`);
  if (d.asset && t.asset && d.asset !== t.asset) out.push(`الزوج ${d.asset} بدل ${t.asset}`);
  if (d.command === 0 || d.command === 1) { const dir = d.command === 0 ? 'call' : 'put'; if (dir !== t.dir) out.push(`${ARDIR[dir]} بدل ${ARDIR[t.dir]}`); }
  const dur = Number(d.closeTimestamp) - Number(d.openTimestamp);
  if (dur > 0 && t.expiry && Math.abs(dur - t.expiry) > 2) out.push(`المدة ${dur} ثانية بدل ${t.expiry}`);
  if ((d.isDemo === 0 || d.isDemo === 1) && t.demo != null && !!d.isDemo !== !!t.demo) out.push(d.isDemo ? 'على الحساب التجريبي بدل الحقيقي' : 'على الحساب الحقيقي بدل التجريبي');
  return out;
}
function onBadDeal(t, reasons) {
  state.badDeal = { at: Date.now(), asset: t.asset, reasons };
  stop('Trade mismatch');
}
const expiryLabel = (sec) => (sec < 60 ? `S${sec}` : sec < 3600 ? `M${sec / 60}` : `H${sec / 3600}`);

function setAsset(asset) {
  if (!asset || asset === state.asset) return;
  state.asset = asset;
  state.lastTick = null;
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
  // PO's list of closed deals also brings the result of a bot trade whose own close message was missed
  if (event === 'updateClosedDeals' && Array.isArray(data)) { data.forEach(d => state.poOpen.delete(d?.id)); return onOrderClosed(data); }
  if (event && /successopenOrder/i.test(event)) {
    if (data?.id) state.poOpen.set(data.id, Number(data.closeTimestamp) || null);
    return onOrderOpened(data);
  }
  if (event && /successcloseOrder/i.test(event)) {
    (Array.isArray(data?.deals) ? data.deals : [data]).forEach(d => state.poOpen.delete(d?.id));
    return onOrderClosed(data);
  }
  // PO's chart history on page load ({ asset, history: [[ts, price], …] }): tells which pair is on the chart
  if (data && !Array.isArray(data) && Array.isArray(data.history) && data.asset) { setAsset(data.asset); return render(); }

  // Ticks: [[asset, ts, price], ...] — every pair this tab receives prices for goes to the engine
  if (Array.isArray(data)) {
    for (const tick of data) {
      if (!Array.isArray(tick) || tick.length < 3 || typeof tick[0] !== 'string') continue;
      const [asset, ts, price] = tick;
      globalThis.IntelTab?.onTick(asset, Number(ts), Number(price));
      if (!state.asset) setAsset(asset);
      if (asset !== state.asset) continue;
      state.lastTickAt = Date.now();
      state.lastTick = { ts: Number(ts), price: Number(price) };
      resolveSignals();
    }
  }
}

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.src !== 'POBOT') return;
  const m = e.data;
  if (m.kind === 'frame') handleFrame(m.event, m.text);
  else if (m.kind === 'symbol' && m.asset && m.asset !== state.asset) { setAsset(m.asset); render(); }
  else if (m.kind === 'text_event') noteEvent(m.event, m.text);
  else if (m.kind === 'sent_event') noteEvent(`→ ${m.event}`, m.text);
  else if (m.kind === 'hook_failed') { state.hookFailed = true; render(); }
  else if (m.kind === 'history_failed') { state.status = 'PO socket not ready — history request failed'; render(); }
});

// Durations PO's own picker offered (read whenever the picker opens): asset → [seconds]; '*' = any pair.
const pickerSeen = {};
chrome.storage.local.get(['pickerSeen'], (r) => { if (r?.pickerSeen) Object.assign(pickerSeen, r.pickerSeen, pickerSeen); });

// ─── History (one request at a time) ────────────────────────────────────────
const HISTORY_OFFSET = 1000;   // seconds per request, as PO's chart asks
const HISTORY_PERIOD = 5;      // 5s candles
const MAX_HIST = 30000;

function candleResolution(base) {
  let best = Infinity;
  for (let i = 1; i < base.length; i++) {
    const d = base[i].time - base[i - 1].time;
    if (d > 0 && d < best) best = d;
  }
  return Number.isFinite(best) ? best : null;
}

// A reply to our own request (matched by asset and candle spacing), or PO's chart loading on its own.
function collectHistory(data) {
  const rows = Array.isArray(data?.data) ? data.data : null;
  if (!rows || !data.asset) return;
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
    if (w.period !== HISTORY_PERIOD) return; // other frames: for the engine only
  } else {
    globalThis.IntelTab?.onUnsolicitedHistory(data.asset, res, clean);
  }
  // 5s candles are kept to score PO's signals on pairs without live ticks here
  const m = state.hist[data.asset] || (state.hist[data.asset] = new Map());
  for (const c of clean) m.set(c.time, c);
  if (m.size > MAX_HIST) [...m.keys()].sort((a, b) => a - b).slice(0, m.size - MAX_HIST).forEach(k => m.delete(k));
}

// PO's reply to loadHistoryPeriod doesn't echo the request, so one request is in
// flight at a time and the reply is matched by asset and candle spacing (see
// collectHistory). Shared by the scanner, signal scoring and the intel engine.
const historyQueue = [];
let historyWaiter = null;
const historyBusy = () => !!historyWaiter || historyQueue.length > 0;

// priority: 0 urgent (refilling a gap before an analysis, verifying a copy signal), 1 normal,
// 2 background (the scanner, deep history). The queue is served one request at a time, most urgent first.
function historyRequest(asset, period, time, offset, priority = 1) {
  return new Promise((resolve) => { historyQueue.push({ asset, period, time, offset, resolve, priority, seq: historySeq++ }); pumpHistory(); });
}
let historySeq = 0;

function pumpHistory() {
  if (historyWaiter || !historyQueue.length) return;
  historyQueue.sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1) || a.seq - b.seq);
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

// ─── PO "Copy signal" list (other traders' trades, .signals-list) ───────────
// Read from the page every 2s. Each new signal (pair, direction, time left, how long it has run, copies,
// winning/losing now) goes to the engine, which verifies it (Copy + verify) on any pair.
const copy = { seen: new Map(), sample: null, primed: {}, hist: {} }; // hist: asset → recent signals (copy-trade evidence)

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

// PO's signals list (Signals → Updates / All): one signal = pair · direction arrows · progress + time left
// in its first row; the trader's amount, "Copied: N times", +$/−$ (is the copied trade winning or losing
// right now) and "N min ago" in the next rows of the same item.
const COPY_FOLLOW_MAX_AGE = 180; // a signal already running longer than this is measured, not followed
const countdownRe = /(\d{1,2}):(\d{2})(?::(\d{2}))?/;
// "EUR/GBP OTC" → EURGBP_otc; other assets by the name PO gives them ("Chainlink OTC" → LINK_otc)
function itemAsset(text) {
  const fx = displayToAsset(text);
  if (fx) return fx;
  const t = (text || '').replace(/\s+/g, ' ');
  const hit = (state.assets || []).filter((a) => a.name && t.includes(a.name)).sort((x, y) => y.name.length - x.name.length)[0];
  return hit ? hit.symbol : null;
}
// From the row with the countdown up to the whole item: the largest ancestor that still holds one countdown.
function copyItemRoot(row, list) {
  let el = row;
  while (el.parentElement && el.parentElement !== list && ((el.parentElement.textContent || '').match(/\d{1,2}:\d{2}/g) || []).length <= 1) el = el.parentElement;
  return el;
}
function scanCopySignals() {
  const list = document.querySelector('.signals-list');
  if (!list || !state.lastTick) return;
  // A signal's first row = the smallest element holding both a pair name and a countdown.
  const has = (el) => { const t = el.textContent || ''; return countdownRe.test(t) && !!itemAsset(t); };
  const rows = [...list.querySelectorAll('*')].filter(el => has(el) && ![...el.children].some(has));
  if (!copy.sample && rows.length) {
    // Saved locally (once per page load), so the reader can be checked against PO's real markup.
    copy.sample = `items=${rows.length}\n` + copyItemRoot(rows[0], list).outerHTML.slice(0, 6000);
    chrome.storage.local.set({ copySample: copy.sample });
  }
  const now = state.lastTick.ts;
  for (const el of rows) {
    const item = copyItemRoot(el, list);
    const rowTxt = el.textContent.replace(/\s+/g, ' '), txt = item.textContent.replace(/\s+/g, ' ');
    const asset = itemAsset(rowTxt), dir = itemDirection(el);
    const tm = countdownRe.exec(rowTxt);
    if (!asset || !dir || !tm) continue;
    const left = tm[3] != null ? +tm[1] * 3600 + +tm[2] * 60 + +tm[3] : +tm[1] * 60 + +tm[2];
    // How long the signal has already been running: PO's progress bar is the elapsed share; else "N min ago".
    const bar = el.querySelector('.progress-bar');
    const frac = bar ? parseFloat(bar.style.width) / 100 : NaN;
    const ago = /(\d+)\s*(sec|second|min|minute|hour|h)\w*\.?\s+ago/i.exec(txt);
    const agoSec = ago ? +ago[1] * (/^h/i.test(ago[2]) ? 3600 : /^m/i.test(ago[2]) ? 60 : 1) : null;
    const elapsed = Number.isFinite(frac) && frac > 0 && frac < 1 ? (left * frac) / (1 - frac) : agoSec;
    const copies = +((/Copied:\s*([\d,]+)/i.exec(txt)?.[1] || '0').replace(/,/g, ''));
    // +$ / −$: the copied trade is winning / losing right now (price moved with / against it since its entry)
    // (read from its own element: joined text glues it to the amount, "$80-$")
    const pnlText = [...item.querySelectorAll('*')].filter((x) => !x.childElementCount).map((x) => (x.textContent || '').trim()).find((t) => /^[+\-−]\s?\$/.test(t));
    const pnl = pnlText ? (pnlText[0] === '+' ? '+' : '-') : null;
    // Same signal ≈ same end time; allow ±10s of jitter between reads.
    const bucket = Math.round((now + left) / 10), key = `${asset}|${dir}|${bucket}`;
    if ([-1, 0, 1].some(k => copy.seen.has(`${asset}|${dir}|${bucket + k}`)) || left < 5 || left > 3600) continue;
    copy.seen.set(key, now);
    const followable = elapsed != null ? elapsed <= COPY_FOLLOW_MAX_AGE : copy.primed[asset] === true;
    if (followable) { try { globalThis.IntelTab?.onCopySignal({ asset, dir: dir.toUpperCase(), at: now, left, elapsed, copies, pnl }); } catch (_) {} }
    if (followable || elapsed != null) {
      const h = (copy.hist[asset] ||= []);
      h.push({ dir: dir.toUpperCase(), at: now, left, elapsed, copies, pnl, price: globalThis.IntelTab?.feeds.get(asset)?.feed.lastTick?.price ?? null });
      copy.hist[asset] = h.filter(x => now - x.at <= 900).slice(-20);
    }
  }
  for (const a of new Set(rows.map(el => itemAsset(el.textContent)))) copy.primed[a] = true; // first look = baseline
  for (const [k, t] of copy.seen) if (now - t > 1800) copy.seen.delete(k);
}
setInterval(() => { try { scanCopySignals(); } catch (_) {} }, 2000);

// ─── PO Signals feed ────────────────────────────────────────────────────────
// Feed format: signals: [[asset, [[minutes, code], ...], price], ...]
// minutes ∈ 1,2,3,5,10,15,30,45,60,120,180,240; code 0 = no signal (closed
// markets are all 0). PO doesn't document codes 1–4, so instead of guessing the
// bot measures them: every code change is followed for its own horizon and scored
// up / down (sigStats). The engine uses a code only where that record proves a lean.
const SIGNAL_MINUTES = [1, 2, 3, 5];       // horizons short enough to matter here
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
  if (!now || historyBusy() || !poSig.others.length) return;
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
// Chrome runs a background tab's timers at most about once a second, so on the way to a click a 25 ms poll or an
// 80 ms pause there took ~1 s (real entries 2026-10-04: 1-minute-frame trades waited 0.8–1.0 s more between the
// worker and PO's open than 15 s ones). Message-channel turns aren't throttled: waits before a click use them.
const quickPort = new MessageChannel(), quickQ = [];
quickPort.port1.onmessage = () => quickQ.shift()?.();
const turn = () => new Promise(r => { quickQ.push(r); quickPort.port2.postMessage(0); });
async function quickSleep(ms) { const t0 = performance.now(); do await turn(); while (performance.now() - t0 < ms); }

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
// Waits only as long as PO takes: checks every 25 ms, at most `ms` (fixed 350 ms waits cost ~0.7 s per entry
// whose duration changed — part of the 2 s from the signal to PO's open, 2026-10-04)
async function waitFor(test, ms = 400) { const t0 = performance.now(); let v = test(); while (!v && performance.now() - t0 < ms) { await quickSleep(5); v = test(); } return v; }

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
    items = (await waitFor(() => { const v = visibleItems(); return v.length ? v : null; })) || [];
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
  // wait for PO's display to read the new duration only — its list doesn't always close by itself, and waiting for that
  // ran the full 400 ms on every change (real trades 2026-10-05: setExpiry 412–468 ms each time the duration changed)
  await waitFor(() => readExpiry() === sec);
  if (visibleItems().length) close();
  const now = readExpiry();
  return now === sec ? null : `PO shows ${now == null ? 'unreadable' : expiryLabel(now)} after selecting ${itemText(item)}`;
}

// true = set (or already that); 'same' when it was already that amount (nothing for PO to take in)
function setAmount(amount) {
  const input = $(['.block--bet-amount .value__val input', '.value__val input', 'input[name="amount"]']);
  if (!input) return false;
  if (Math.abs(parseFloat(String(input.value).replace(/[^0-9.]/g, '')) - amount) < 0.01) return 'same';
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
function clearInput(input) {
  if (!input || !input.value) return;
  input.focus();
  input.select?.();
  if (!document.execCommand('delete')) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input.blur();
}
// PO's list ignores Escape and can stay open after a pick: clear what we typed, then close it with the
// pair button (a toggle) if Escape didn't.
let typedInto = null;
async function closeAssetList() {
  clearInput(typedInto);
  typedInto = null;
  for (let i = 0; i < 3 && assetList(); i++) {
    if (i === 0) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else assetMenuOpener()?.click();
    await sleep(200);
  }
}
async function switchAsset(asset) {
  if (state.asset === asset) return null;
  const label = assetName(asset);
  const close = () => closeAssetList();
  const fail = async (err, opener = null) => {
    try {
      chrome.storage.local.set({ assetMenuSample: { at: Date.now(), asset, err, opener: opener?.outerHTML?.slice(0, 1500) || null,
        list: (assetList() || document.querySelector(ASSET_LIST))?.outerHTML?.slice(0, 12000) || null } });
    } catch (_) {}
    await close();
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
      typedInto = input;
      typeInto(input, label.replace(/ OTC$/, ''));
      for (let i = 0; i < 8 && !item; i++) { await sleep(150); item = assetItem(assetList() || list, asset); }
    }
  }
  if (!item) return fail(`${label} not found in the asset list`, opener);
  item.click();
  for (let i = 0; i < 20 && state.asset !== asset; i++) await sleep(150); // PO confirms with changeSymbol
  if (state.asset !== asset) return fail(`chart did not switch to ${label} (PO shows ${state.asset})`, opener);
  await close();
  return null;
}

function clickDirection(dir) {
  const btn = dir === 'call'
    ? $(['a.btn.btn-call', 'button.btn-call', '[class*="btn-call"]'])
    : $(['a.btn.btn-put', 'button.btn-put', '[class*="btn-put"]']);
  if (!btn) return false;
  btn.click();
  return true;
}

// ─── Trades ─────────────────────────────────────────────────────────────────
// Which engine places trades in this tab. Both are the intelligence engine (intel-tab.js): its own
// opportunities, or verified copy signals on any pair. Placement, protection and records are shared.
const isIntel = () => state.settings.strategy === 'intel' || state.settings.strategy === 'both' || state.settings.strategy === 'keltner' || state.settings.strategy === 'youtube';
const isCopyMode = () => state.settings.strategy === 'copyplus' || state.settings.strategy === 'both';
const isManaged = () => isIntel() || isCopyMode();

// PO's clock (deal timestamps) minus this computer's, from the last tick
const poOffsetSec = () => (state.lastTick && state.lastTickAt ? state.lastTick.ts - state.lastTickAt / 1000 : null);
// Is this PO deal (opened or closed) one of the bot's trades still waiting? Same pair and amount, opened within a few
// seconds of the click — never a deal of another pair (a manual trade, or one from before a reload).
function sameDeal(t, d) {
  if (d.asset && t.asset && d.asset !== t.asset) return false;
  if (Number(d.amount) > 0 && Number(t.stake) > 0 && Number(d.amount) !== Number(t.stake)) return false;
  const off = poOffsetSec(), at = Number(d.openTimestamp);
  return !(off != null && at > 0) || Math.abs(at - off - t.openedAt / 1000) < 15;
}
function onOrderOpened(data) {
  if (!data?.id || [...state.trades, ...state.late].some((x) => x.id === data.id)) return;
  // the oldest bot trade still waiting for an id that this deal can be — or, if none fits, the bot's click of the
  // last few seconds (then the deal is not what the bot meant: checked just below)
  const t = state.trades.find((x) => !x.id && sameDeal(x, data)) || state.trades.find((x) => !x.id && Date.now() - x.openedAt < 6000);
  if (!t) return;
  t.id = data.id;
  saveDeals();
  const bad = dealMismatch(t, data);
  if (bad.length) onBadDeal(t, bad);
}

function onOrderClosed(data) {
  const deals = Array.isArray(data?.deals) ? data.deals : Array.isArray(data) ? data : [data];
  for (const deal of deals) {
    if (!deal || !Number.isFinite(deal.profit)) continue;
    const mine = [...state.trades, ...state.late];
    const t = mine.find((x) => x.id && x.id === deal.id) || mine.find((x) => !x.id && sameDeal(x, deal));
    if (t) finishTrade(t, deal.profit, deal.profit > 0 ? 'win' : deal.profit < 0 ? 'loss' : 'tie', deal);
  }
}
// A trade 45 s past its end with no result is not open any more (it no longer holds a place among the trades at
// once, nor the panel's "in a trade"); PO's result is still taken when it comes, and after 15 minutes it is logged as
// unknown (the stop loss counts it as lost).
function sweepTrades() {
  const now = Date.now();
  for (const t of [...state.trades]) if (now > t.openedAt + t.expiry * 1000 + 45000) { state.trades = state.trades.filter((x) => x !== t); state.late.push(t); }
  for (const t of [...state.late]) if (now > t.openedAt + t.expiry * 1000 + RESULT_TIMEOUT_MS) finishTrade(t, null, 'unknown');
}
setInterval(sweepTrades, 5000);

// The bot's deals PO confirmed, kept per tab across a reload (sessionStorage): reloading while a trade is open used to
// lose it — its result never logged, its bubble waiting forever (2026-10-05, UAH/USD: PO closed it +46, the bot never knew).
function saveDeals() {
  try { sessionStorage.setItem('pobotDeals', JSON.stringify([...state.trades, ...state.late].filter(t => t.id))); } catch (_) {}
}
function restoreDeals() {
  let kept = [];
  try { kept = JSON.parse(sessionStorage.getItem('pobotDeals') || '[]'); } catch (_) {}
  const now = Date.now();
  for (const t of kept) {
    if (!t?.id || [...state.trades, ...state.late].some(x => x.id === t.id) || state.log.some(l => l.dealId === t.id)) continue;
    // still running → open again (counts among the trades at once); past its end → waiting for PO's result only
    (now < t.openedAt + t.expiry * 1000 + 45000 ? state.trades : state.late).push(t);
  }
}

function finishTrade(t, profit, result, deal = null) {
  if (!t || !(state.trades.includes(t) || state.late.includes(t))) return;
  state.trades = state.trades.filter(x => x !== t);
  state.late = state.late.filter(x => x !== t);
  saveDeals();
  const ss = state.session, s = state.settings;
  const pl = Number.isFinite(profit) ? profit : 0;
  ss.trades++;
  ss.pl = +(ss.pl + pl).toFixed(2);
  if (result === 'win') { ss.wins++; ss.streak = Math.max(1, ss.streak + 1); }
  else if (result === 'loss') { ss.losses++; ss.streak = Math.min(-1, ss.streak - 1); }
  else ss.ties++;
  state.log.push({
    time: new Date(t.openedAt).toISOString(), asset: t.asset, dir: t.dir, stake: t.stake,
    result, profit: pl, currency: s.currency, demo: t.demo, mode: s.strategy,
    strategies: (t.voters || []).join(' + '), payout: t.payout ?? '', expiry: t.expiry, ...(t.id ? { dealId: t.id } : {}),
  });
  saveLog();
  if (t.intelId) globalThis.IntelTab?.onTradeClosed(t, result, pl, deal);
  state.status = `${result.toUpperCase()} ${pl >= 0 ? '+' : ''}${pl} — session ${ss.pl >= 0 ? '+' : ''}${ss.pl}`;
  render();
}

// Start = this tab may place what its engine decides (the worker's protection engine still has the last word).
function start() {
  if (state.settings.demoOnly && !isDemoAccount()) { state.status = 'Switch to the DEMO account first'; return render(); }
  if (stopLossHit()) { state.status = 'Daily stop loss reached'; return render(); }
  if (targetHit()) { state.status = 'Daily target reached'; return render(); }
  state.badDeal = null;
  state.running = true;
  state.session = newSession();
  state.status = 'Running';
  try { sessionStorage.setItem('pobotRunning', '1'); } catch (_) {}
  render();
}

function stop(reason = 'Stopped') {
  state.running = false;
  state.status = reason;
  try { sessionStorage.removeItem('pobotRunning'); } catch (_) {}
  render();
}

// Start survives a reload of this tab (sessionStorage is per tab and cleared when the tab closes): a reload
// after an update must not silently leave the tab unable to place anything. Demo-only still applies.
function resumeAfterReload(tries = 0) {
  let was = false;
  try { was = sessionStorage.getItem('pobotRunning') === '1'; } catch (_) {}
  if (!was || state.running) return;
  if (state.settings.demoOnly && !isDemoAccount()) { if (tries < 10) setTimeout(() => resumeAfterReload(tries + 1), 2000); return; } // account label not shown yet
  start();
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
// One card: what the engine says for this tab's pair (or the open trade), the stake, the mode, start/stop.
// Everything technical is behind the gear and in the advanced dashboard.
const STATUS_AR = [
  [/^Running$/, 'يعمل'], [/^Stopped$/, 'متوقف'], [/^Daily stop loss reached/, 'وقف الخسارة اتضرب النهارده'], [/^Daily target reached/, 'وصلت لهدف الربح النهارده 🎯'], [/^Trade mismatch/, 'وقفت: صفقة اتفتحت مختلفة عن المطلوب'], [/^Idle$/, ''], [/^Switch to the DEMO account/, 'انتقل إلى الحساب التجريبي أولًا'],
  [/^PO socket not ready/, 'اتصال المنصة غير جاهز — تعذر تحميل التاريخ'],
  [/^(WIN|LOSS|TIE|UNKNOWN) ([+-]?[\d.]+)/, (m) => `${{ WIN: 'نجاح', LOSS: 'خسارة', TIE: 'تعادل', UNKNOWN: 'نتيجة غير معروفة' }[m[1]]} ${m[2]}`],
  [/^Intel/, () => globalThis.IntelTab?.statusLine() || 'المحرك الذكي يعمل'],
];
function statusAr(text) {
  for (const [re, ar] of STATUS_AR) { const m = re.exec(text || ''); if (m) return typeof ar === 'function' ? ar(m, text) : ar; }
  return text || '';
}
const GEAR_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/></svg>';
// The decision for this tab's pair: identical wording to the popup (ui/ar.js).
// The card as pictures: a direction arrow, a countdown ring, chips for duration / frame / strategy, and in a strategy
// mode one tile per frame that lights up when its strategies give a signal.
const SHORT_TF = { 5: '5ث', 10: '10ث', 15: '15ث', 30: '30ث', 60: '1د', 300: '5د', 600: '10د', 900: '15د' };
const ICON = {
  arrow: (dir, size = 56, op = 1) => `<svg width="${size}" height="${size}" viewBox="0 0 48 48" style="opacity:${op}"><circle cx="24" cy="24" r="22" fill="${dir === 'CALL' ? '#14532d' : '#4c1414'}"/><path d="${dir === 'CALL' ? 'M24 12 L35 26 H28 V36 H20 V26 H13 Z' : 'M24 36 L35 22 H28 V12 H20 V22 H13 Z'}" fill="${dir === 'CALL' ? '#34d399' : '#f87171'}"/></svg>`,
  ring: (frac, label, color = '#fbbf24', size = 46) => { const r = 19, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, frac)); return `<svg width="${size}" height="${size}" viewBox="0 0 46 46"><circle cx="23" cy="23" r="${r}" fill="none" stroke="#2a3040" stroke-width="4"/><circle cx="23" cy="23" r="${r}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 23 23)"/><text x="23" y="27" text-anchor="middle" font-size="${String(label).length > 4 ? 9.5 : 11}" font-weight="700" fill="#e8eaf0" font-family="system-ui">${label}</text></svg>`; },
  wait: '<svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="20" fill="#1f2430"/><circle cx="14" cy="22" r="3" fill="#596173"><animate attributeName="opacity" values="1;.2;1" dur="1.2s" repeatCount="indefinite"/></circle><circle cx="22" cy="22" r="3" fill="#596173"><animate attributeName="opacity" values="1;.2;1" dur="1.2s" begin=".2s" repeatCount="indefinite"/></circle><circle cx="30" cy="22" r="3" fill="#596173"><animate attributeName="opacity" values="1;.2;1" dur="1.2s" begin=".4s" repeatCount="indefinite"/></circle></svg>',
  no: '<svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="17" fill="none" stroke="#8b93a3" stroke-width="3"/><path d="M10 34 L34 10" stroke="#8b93a3" stroke-width="3"/></svg>',
  clock: '<svg width="13" height="13" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.5V8l2.5 1.6" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>',
  candle: '<svg width="13" height="13" viewBox="0 0 16 16"><path d="M5 2v12M11 4v10" stroke="currentColor" stroke-width="1.2"/><rect x="3" y="5" width="4" height="6" rx="1" fill="currentColor"/><rect x="9" y="7" width="4" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  spark: '<svg width="13" height="13" viewBox="0 0 16 16"><path d="M8 1l1.8 4.6L14.5 7 9.8 8.6 8 15 6.2 8.6 1.5 7l4.7-1.4z" fill="currentColor"/></svg>',
};
const chip = (icon, text, color = '#c9cedb') => `<span style="display:inline-flex;align-items:center;gap:4px;background:#232836;color:${color};border-radius:999px;padding:3px 9px;font-size:11px;white-space:nowrap">${icon}${text}</span>`;
function intelCard(pv) {
  const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const center = (inner) => `<div style="display:flex;flex-direction:column;align-items:center;gap:6px">${inner}</div>`;
  if (!pv) return center(`${ICON.wait}<div class="sub">افتح زوج OTC على الشارت</div>`);
  if (!pv.last?.facts && !pv.opp) return center(`${ICON.wait}<div class="sub">جاري التحليل</div>`);
  const cfg = globalThis.IntelTab?.cfg?.() || OTC.DEFAULT_CONFIG;
  const d = AR.decision(pv, pv.nowTs, cfg), o = pv.opp;
  const go = d.verdict === 'ENTER' && d.key === 'enter';
  const nameOf = (id) => (id === 'keltner_trend_pullback' ? 'كيلتنر' : OTC.Strategies.get(id)?.name || id);
  const chips = (x) => {
    if (!x) return '';
    const list = [];
    if (x.expiry?.sec) list.push(chip(ICON.clock, AR.duration(x.expiry.sec)));
    if (x.tf) list.push(chip(ICON.candle, `شمعة ${SHORT_TF[x.tf] || AR.frame(x.tf)}`));
    const strat = (x.combo || x.setup || '').split('+').filter(Boolean).map(nameOf).join(' + ') || x.setupName;
    if (strat) list.push(chip(ICON.spark, esc(strat), '#fbbf24'));
    return `<div style="display:flex;flex-wrap:wrap;gap:5px;justify-content:center">${list.join('')}</div>`;
  };
  const ring = () => { if (!(d.timer?.sec > 0)) return ''; const total = o?.tf ? globalThis.IntelTab?.entryWindow?.(o.timingTf || o.tf) || 60 : 60; return ICON.ring(d.timer.sec / Math.max(total, d.timer.sec), AR.clock(d.timer.sec), go ? (d.dir === 'CALL' ? '#34d399' : '#f87171') : '#fbbf24'); };
  if (go) return center(`<div style="display:flex;align-items:center;gap:14px">${ICON.arrow(d.dir)}<div><div class="big" style="font-size:24px;color:${d.dir === 'CALL' ? '#46b07f' : '#df6a62'}">${AR.dir(d.dir)}</div><div class="sub">ادخل الآن</div></div>${ring()}</div>${chips(o)}`);
  if (d.verdict === 'WAIT') return center(`<div style="display:flex;align-items:center;gap:14px">${d.dir ? ICON.arrow(d.dir, 48, 0.55) : ICON.wait}<div class="big" style="font-size:16px;color:#d4a64a">${esc(d.title)}</div>${ring()}</div>${chips(o)}`);
  // a strategy mode waiting: one tile per frame; a tile lights up with an arrow when its strategies signalled
  if (d.solo || Array.isArray(cfg.solo)) {
    const set = OTC.Strategies.listAll().filter((st) => [].concat(cfg.solo || []).includes(st.id) && !(cfg.soloOff || []).includes(st.id) && st.frame);
    const tiles = [...new Set(set.map((st) => st.frame))].sort((a, b) => a - b).map((tf) => {
      const fr = pv.frames?.[tf], sig = fr?.decision && fr.decision !== 'SKIP' ? fr.decision : null, n = set.filter((st) => st.frame === tf).length;
      return `<div style="background:${sig ? (sig === 'CALL' ? '#14532d' : '#4c1414') : '#232836'};border-radius:10px;padding:6px 2px;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0">
        <b style="font-size:12px;color:#e8eaf0">${SHORT_TF[tf] || tf}</b>${sig ? ICON.arrow(sig, 20) : '<span style="width:8px;height:8px;border-radius:50%;background:#596173;display:inline-block;margin:6px 0"></span>'}
        <span style="font-size:9.5px;color:#8b93a3">${n} ${n === 1 ? 'استراتيجية' : 'استراتيجيات'}</span></div>`;
    }).join('');
    return center(`<div style="display:flex;align-items:center;gap:8px">${ICON.wait}<div class="big" style="font-size:15px">مستني إشارة</div></div>
      <div style="display:grid;grid-template-columns:repeat(${Math.max(1, new Set(set.map((st) => st.frame)).size)},1fr);gap:5px;width:100%">${tiles}</div>`);
  }
  const why = d.rows.find(([k]) => /السبب|لماذا/.test(k))?.[1];
  return center(`<div style="display:flex;align-items:center;gap:10px">${ICON.no}<div class="big" style="font-size:15px">${esc(d.title)}</div></div>${why ? `<div class="sub">${esc(why)}</div>` : ''}${chips(o)}`);
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
  root.innerHTML = `
  <style>
    :host{all:initial}
    .p{width:340px;color:#e8eaf0;font:12.5px/1.55 'PoBotCairo',system-ui,sans-serif;border:1px solid #ffffff14;border-radius:18px;box-shadow:0 18px 50px #000c;overflow:hidden;
       background:radial-gradient(120% 60% at 100% 0%,#231a52 0%,transparent 55%),radial-gradient(90% 50% at 0% 100%,#0f3340 0%,transparent 60%),#0a0d19}
    .h .t{background:linear-gradient(90deg,#c4b5fd,#67e8f9);-webkit-background-clip:text;background-clip:text;color:transparent}
    /* the bot: orb, counters, conversation, quick replies */
    .hero2{display:flex;align-items:center;gap:10px}
    .who{display:flex;flex-direction:column;line-height:1.25}.who b{font-size:15px}.who span{color:#9aa3b8;font-size:11px}
    .orb{--c1:#8b5cf6;--c2:#22d3ee;position:relative;width:50px;height:50px;flex:none}
    .orb .core{position:absolute;inset:6px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff8 0 8%,var(--c1) 30%,color-mix(in srgb,var(--c1) 40%,#000) 80%);box-shadow:0 0 20px color-mix(in srgb,var(--c1) 70%,transparent),inset 0 -6px 14px #0006;animation:breathe 3.2s ease-in-out infinite}
    .orb .ring{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,var(--c2),transparent 35%,var(--c1) 60%,transparent 80%,var(--c2));animation:spin 4s linear infinite;-webkit-mask:radial-gradient(circle,transparent 56%,#000 58%);mask:radial-gradient(circle,transparent 56%,#000 58%)}
    /* the bot's face: eyes + mouth; props (🔍 ▲ ▼ 🔔 z 💧 ✨) show by mood (scan/up/down/sleep/stop) and by a short
       reaction (r-win / r-loss / r-alert / r-talk) set by the chat */
    .orb .face{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding-bottom:2px;transition:transform .3s}
    .orb .eyes{display:flex;gap:8px}
    .orb .eyes i{width:5px;height:8px;border-radius:3px;background:#fff;box-shadow:0 0 6px #fff;animation:blink 4.5s infinite;transition:height .25s,border-radius .25s,transform .25s}
    .orb .m{width:9px;height:4px;border:2px solid #fff;border-top:0;border-radius:0 0 8px 8px;opacity:.9;transition:all .25s}
    .orb .pr{position:absolute;pointer-events:none;opacity:0;line-height:1;transition:opacity .3s}
    .orb .glass{font-size:15px;left:50%;top:50%;margin:-8px 0 0 -8px}
    .orb .arr{left:50%;transform:translateX(-50%);font-size:12px;font-weight:900;text-shadow:0 0 8px currentColor}.orb .arr.up{top:-13px;color:#6ee7b7}.orb .arr.dn{bottom:-13px;color:#fca5a5}
    .orb .bell{top:-8px;left:-6px;font-size:15px}.orb .drop{top:6px;right:-3px;font-size:11px}
    .orb .zz{top:-6px;right:-4px;font:800 10px system-ui;color:#c4b5fd}.orb .zz i{position:absolute;font-style:normal;opacity:0;animation:zz 3s infinite}.orb .zz i:nth-child(2){animation-delay:1s}.orb .zz i:nth-child(3){animation-delay:2s}
    .orb .stars{inset:0}.orb .stars i{position:absolute;left:50%;top:50%;font-style:normal;font-size:11px;opacity:0}
    .orb.up{--c1:#10b981;--c2:#6ee7b7}.orb.down{--c1:#ef4444;--c2:#fca5a5}.orb.up .core,.orb.down .core{animation-duration:1.2s}
    .orb.stop{--c1:#64748b;--c2:#94a3b8}.orb.sleep{--c1:#475569;--c2:#64748b}.orb.stop .ring,.orb.sleep .ring{animation:none;opacity:.35}
    /* analysing: the ring scans fast, a magnifier circles the bot, the eyes follow it */
    .orb.scan .ring{animation-duration:1.4s}.orb.scan .glass{opacity:1;animation:orbit 2.8s linear infinite}.orb.scan .eyes{animation:look 2.8s ease-in-out infinite}.orb.scan .m{width:6px;border-radius:0 0 4px 4px}
    /* buying: happy eyes, an arrow rising out of the bot; selling: focused eyes, an arrow falling under it */
    .orb.up .eyes i{height:4px;border-radius:5px 5px 0 0;animation:none}.orb.up .m{width:11px;height:5px}.orb.up .arr.up{opacity:1;animation:rise 1.1s ease-out infinite}
    .orb.down .eyes i{height:3px;border-radius:2px;animation:none}.orb.down .m{width:9px;height:0;border-radius:0}.orb.down .arr.dn{opacity:1;animation:fall 1.1s ease-in infinite}
    .orb.sleep .eyes i{height:2px;margin-top:4px;animation:none}.orb.sleep .m{width:5px;height:2px;opacity:.5}.orb.sleep .zz{opacity:1}
    .orb.stop .eyes i{height:2px;width:7px;animation:none}.orb.stop .eyes i:first-child{transform:rotate(35deg)}.orb.stop .eyes i:last-child{transform:rotate(-35deg)}.orb.stop .m{border-top:2px solid #fff;border-bottom:0;border-radius:8px 8px 0 0;height:3px}
    /* reactions, a few seconds each */
    .orb.r-win{animation:hop .6s ease-out 3}.orb.r-win .stars{opacity:1}.orb.r-win .stars i{animation:burst 1s ease-out infinite}.orb.r-win .stars i:nth-child(2){--a:120deg;animation-delay:.15s}.orb.r-win .stars i:nth-child(3){--a:240deg;animation-delay:.3s}.orb.r-win .m{width:13px;height:7px}.orb.r-win .eyes i{height:4px;border-radius:5px 5px 0 0;animation:none}
    .orb.r-loss{animation:shake .45s ease-in-out 2}.orb.r-loss .drop{opacity:1;animation:sweat 1.6s ease-in infinite}.orb.r-loss .eyes i{height:4px;transform:translateY(2px);animation:none}.orb.r-loss .m{border-top:2px solid #fff;border-bottom:0;border-radius:8px 8px 0 0;height:3px}
    .orb.r-alert{animation:hop .5s ease-out 2}.orb.r-alert .bell{opacity:1;animation:ring .5s ease-in-out infinite}.orb.r-alert .eyes i{height:10px;width:6px}.orb.r-alert .m{width:6px;height:6px;border:2px solid #fff;border-radius:50%}
    .orb.r-talk .m{animation:talk .22s ease-in-out infinite alternate}
    .orb.r-win .glass,.orb.r-loss .glass,.orb.r-alert .glass{opacity:0}
    @keyframes orbit{from{transform:rotate(0) translateX(24px) rotate(0)}to{transform:rotate(360deg) translateX(24px) rotate(-360deg)}}
    @keyframes look{0%,100%{transform:translateX(3px)}25%{transform:translate(0,3px)}50%{transform:translateX(-3px)}75%{transform:translate(0,-3px)}}
    @keyframes rise{from{transform:translate(-50%,6px);opacity:1}to{transform:translate(-50%,-10px);opacity:0}}@keyframes fall{from{transform:translate(-50%,-6px);opacity:1}to{transform:translate(-50%,10px);opacity:0}}
    @keyframes zz{0%{transform:translate(0,4px) scale(.6);opacity:0}30%{opacity:1}100%{transform:translate(8px,-14px) scale(1.2);opacity:0}}
    @keyframes hop{0%,100%{transform:translateY(0)}40%{transform:translateY(-7px)}70%{transform:translateY(1px)}}@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}
    @keyframes burst{from{transform:rotate(var(--a,0deg)) translateY(0) scale(.4);opacity:1}to{transform:rotate(var(--a,0deg)) translateY(-30px) scale(1.1);opacity:0}}
    @keyframes sweat{from{transform:translateY(-2px);opacity:1}to{transform:translateY(12px);opacity:0}}@keyframes ring{0%,100%{transform:rotate(0)}25%{transform:rotate(-22deg)}75%{transform:rotate(22deg)}}@keyframes talk{from{height:2px}to{height:7px}}
    .who span.busy::after{content:'';display:inline-block;width:1.2em;text-align:start;animation:dots3 1.2s steps(4) infinite}@keyframes dots3{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}
    @media (prefers-reduced-motion:reduce){.orb *,.orb,.tip,.tip *{animation:none!important}}
    @keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}
    .tally{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
    .tally div{background:#ffffff0b;border:1px solid #ffffff12;border-radius:12px;padding:5px 4px;text-align:center}
    .tally b{display:block;font-size:16px;font-weight:800;font-variant-numeric:tabular-nums;color:#e8eaf0}.tally span{font-size:10px;color:#9aa3b8}
    .tally b.g,.g{color:#34d399}.tally b.r,.r{color:#f87171}
    .stream{height:210px;overflow-y:auto;display:flex;flex-direction:column;gap:7px;padding:2px 2px 4px;scrollbar-width:thin;scrollbar-color:#ffffff22 transparent;-webkit-mask:linear-gradient(180deg,transparent 0,#000 14px);mask:linear-gradient(180deg,transparent 0,#000 14px)}
    .msg{display:flex;flex-direction:column;max-width:88%;position:relative}.msg.bot{align-self:flex-start}.msg.me{align-self:flex-end}
    .msg .bubble{padding:7px 11px;border-radius:15px;line-height:1.55;font-size:12px}
    .msg.bot .bubble{background:#ffffff10;border:1px solid #ffffff14;border-start-start-radius:4px}
    .msg.me .bubble{background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;border-start-end-radius:4px}
    .msg.warn .bubble{background:linear-gradient(135deg,#f59e0b2e,#f59e0b10);border-color:#fbbf2466}.msg.win .bubble{background:linear-gradient(135deg,#10b98138,#10b98114);border-color:#34d39955}.msg.loss .bubble{background:linear-gradient(135deg,#ef444433,#ef444410);border-color:#f8717150}
    .msg .at{font-size:9.5px;color:#5d6470;margin:1px 6px 0}.msg .why{display:inline-block;margin-top:2px;color:#9aa3b8;font-size:11px}.msg .clock{font-variant-numeric:tabular-nums}
    .msg.pop{animation:pop .38s cubic-bezier(.2,1.4,.4,1) both}@keyframes pop{from{opacity:0;transform:translateY(10px) scale(.92)}to{opacity:1;transform:none}}
    .typing .dots{display:inline-flex;gap:4px;padding:10px 13px;background:#ffffff10;border:1px solid #ffffff14;border-radius:15px;border-start-start-radius:4px}
    .typing .dots i{width:6px;height:6px;border-radius:50%;background:#9aa3b8;animation:dot 1s infinite}.typing .dots i:nth-child(2){animation-delay:.15s}.typing .dots i:nth-child(3){animation-delay:.3s}
    @keyframes dot{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-5px);opacity:1}}
    .wr{height:5px;border-radius:3px;background:#f8717170;overflow:hidden;margin:5px 0 2px}.wr i{display:block;height:100%;background:linear-gradient(90deg,#10b981,#34d399);border-radius:3px}
    .burst{position:absolute;inset-inline-start:28px;top:50%;pointer-events:none}.burst i{position:absolute;width:6px;height:6px;border-radius:2px;background:var(--c);animation:fly 1s ease-out forwards;transform:rotate(var(--a))}
    @keyframes fly{to{transform:rotate(var(--a)) translateX(44px);opacity:0}}
    .stream:empty::before{content:'لسه مفيش صفقات النهارده — أول ما أدخل صفقة هتظهر هنا';margin:auto;color:#ffffff66;font-size:12px;text-align:center}.tip{position:relative;display:flex;gap:7px;align-items:flex-start;padding:7px 10px 9px;border-radius:12px;background:linear-gradient(90deg,#a78bfa22,#60a5fa14);border:1px solid #a78bfa44;font-size:11.5px;line-height:1.55;color:#dfe3ee;min-height:34px;transition:opacity .3s,transform .3s;overflow:visible}
    .tip::before{content:'';position:absolute;top:-6px;right:20px;width:10px;height:10px;background:#2a2550;border-left:1px solid #a78bfa44;border-top:1px solid #a78bfa44;transform:rotate(45deg)}
    .tip .bar{position:absolute;left:10px;right:10px;bottom:3px;height:2px;border-radius:2px;background:#ffffff10;overflow:hidden}.tip .bar::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,#a78bfa,#67e8f9);transform-origin:right;animation:tipbar var(--tipms,12s) linear forwards}
    .tip.fade{opacity:0;transform:translateY(5px) scale(.98)}.tip.in{animation:tipIn .45s cubic-bezier(.2,1.4,.4,1)}.tip.in #tipI{animation:iconPop .6s ease-out}
    .tip i{font-style:normal;font-size:15px;display:inline-block}.tip b{color:#fff}.tip .w{opacity:0;animation:wIn .28s ease-out forwards;animation-delay:calc(var(--d) * 32ms)}
    @keyframes tipIn{from{transform:translateY(8px) scale(.96);opacity:0}to{transform:none;opacity:1}}@keyframes iconPop{0%{transform:scale(0) rotate(-40deg)}60%{transform:scale(1.35) rotate(10deg)}100%{transform:scale(1) rotate(0)}}
    @keyframes wIn{from{opacity:0;filter:blur(2px);transform:translateY(3px)}to{opacity:1;filter:none;transform:none}}@keyframes tipbar{from{transform:scaleX(1)}to{transform:scaleX(0)}}.chips{display:flex;gap:5px;overflow-x:auto;scrollbar-width:none}.chips button{flex:1}#qImp.pulse{border-color:#fbbf24;color:#fde68a;animation:imp 1.4s ease-in-out infinite}@keyframes imp{50%{box-shadow:0 0 0 4px #fbbf2433}}.quick{align-items:stretch;overflow:visible}.quick .q{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;padding:4px 9px;border-radius:12px;background:#ffffff0b;border:1px solid #ffffff14}.quick .q span{color:#9aa3b8;font-size:10px;white-space:nowrap}.quick .q small{color:#c4b5fd}.quick .q input{width:100%;background:transparent;border:0;color:#fff;font:700 14px 'PoBotCairo',system-ui;padding:0;outline:0}.quick .btns{display:flex;flex-direction:column;gap:4px;justify-content:center}.quick .btns button{padding:4px 10px}
    .opts{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0 4px}.opt{display:inline-flex;flex-direction:column;align-items:center;padding:5px 11px;border-radius:12px;background:#ffffff12;border:1px solid #a78bfa55;color:#fff;font:700 12px 'PoBotCairo',system-ui;cursor:pointer;transition:transform .15s,background .15s}
    .opt:hover:not(:disabled){transform:translateY(-1px);background:#a78bfa33}.opt small{font:500 9.5px 'PoBotCairo',system-ui;color:#c4b5fd}.opt:disabled{opacity:.45;cursor:default}
.opt.ap{display:inline-flex;flex-direction:row;padding:2px 9px;margin-inline-start:6px;font-size:11px;border-color:#fbbf2477;vertical-align:middle}.opt.on{opacity:1;background:linear-gradient(135deg,#7c3aed,#2563eb);border-color:transparent}
    .own{display:inline-flex;gap:4px;align-items:center}.own input{width:76px;padding:5px 8px;border-radius:10px;border:1px solid #ffffff22;background:#0007;color:#fff;font:700 12px 'PoBotCairo',system-ui}
    .chips button{flex:none;padding:5px 10px;border-radius:999px;background:#ffffff0b;border:1px solid #ffffff14;color:#e8eaf0;font:600 11px 'PoBotCairo',system-ui;cursor:pointer;transition:transform .15s}
    .chips button:hover{transform:translateY(-1px);background:#ffffff16}#qPower{color:#fca5a5;border-color:#f8717155}
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
    .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;text-align:center}
    .stats div{background:#1a1e27;border-radius:10px;padding:7px 2px;color:#8b93a3;font-size:10.5px}
    .stats b{display:block;font-size:15px;color:#e8eaf0;font-variant-numeric:tabular-nums}
    .stake{display:flex;align-items:center;gap:8px;background:#1a1e27;border-radius:10px;padding:6px 10px}
    .stake span{color:#8b93a3;flex:1}
    .stake input{width:90px;text-align:right;font-size:14px;font-weight:700;background:transparent;border:0;color:#fff;padding:2px}
    .seg{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;background:#1a1e27;border-radius:10px;padding:3px}
    .seg button{border:0;border-radius:8px;padding:6px 4px;background:transparent;color:#8b93a3;font:600 12px 'PoBotCairo',system-ui;cursor:pointer}
    .seg button.on{background:#2a3040;color:#fff}
    #mode button[data-mode="keltner"],#mode button[data-mode="youtube"]{grid-column:span 3}
    #mode button[data-mode="youtube"]{color:#f87171}
    #mode button[data-mode="youtube"].on{background:#5a1f24;color:#fff}
    #mode .risk{font:700 10px system-ui;color:#fff;background:#dc2626;border-radius:4px;padding:1px 5px;margin-inline-start:6px;vertical-align:1px}
    .acts{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .acts button{height:38px;border:0;border-radius:10px;font:700 13px 'PoBotCairo',system-ui;cursor:pointer}
    .go{background:#10b981;color:#04130d}.go:disabled{background:#1a1e27;color:#4a5060;cursor:default}
    .st{background:#ef4444;color:#fff}.st:disabled{background:#1a1e27;color:#4a5060;cursor:default}
    .status{color:#8b93a3;font-size:11px;text-align:center;min-height:15px}
    .adv{border-top:1px solid #222733;padding:10px 12px;display:grid;gap:8px;max-height:52vh;overflow-y:auto}
    .hidden{display:none}
    label{display:grid;gap:2px;color:#8b93a3;font-size:11px}
    select{background:#0c0e13;color:#e8eaf0;border:1px solid #262b36;border-radius:7px;padding:4px 6px;font:inherit;min-width:0}
    .chk{display:flex;align-items:center;gap:6px;color:#cfd4de}
    .sec{border:0;border-radius:7px;padding:7px;font:600 12px 'PoBotCairo',system-ui;cursor:pointer;background:#1e222c;color:#cfd4de}
    .filters{background:#0c0e13;border-radius:7px;padding:6px;color:#8b93a3;font-size:11px}
    .ok{color:#34d399}.neg{color:#f87171}.no{color:#596173}.warn{color:#fbbf24}
    .min .main,.min .adv{display:none}
    .ctrl{display:grid;gap:8px;padding-top:8px;border-top:1px solid #ffffff12;animation:pop .3s ease-out both}
    .ctrl.hidden{display:none}
  </style>
  <div class="p" dir="rtl">
    <div class="h"><span class="dot" id="dot"></span><span class="t">مراقب OTC</span>
      <button class="ib" id="gear" title="الإعدادات والتفاصيل" aria-label="الإعدادات">${GEAR_SVG}</button><button class="ib" id="min" title="تصغير" aria-label="تصغير">–</button></div>
    <div class="main" dir="rtl">
      <div class="badges"><span class="badge" id="acct"></span><span class="badge" id="pair"></span><span class="badge" id="pay"></span></div>
      <div class="hero2"><div class="orb" id="orb"><div class="ring"></div><div class="core"></div><div class="face"><div class="eyes"><i></i><i></i></div><b class="m"></b></div><span class="pr glass">🔍</span><span class="pr arr up">▲</span><span class="pr arr dn">▼</span><span class="pr bell">🔔</span><span class="pr zz"><i>z</i><i>z</i><i>z</i></span><span class="pr drop">💧</span><span class="pr stars"><i>✨</i><i>⭐</i><i>✨</i></span></div><div class="who"><b>البوت</b><span id="mood">بيصحى…</span></div></div>
      <div class="tally"><div><b id="tW" data-v="0">0</b><span>كسب</span></div><div><b id="tL" data-v="0">0</b><span>خسارة</span></div><div><b id="tN" data-v="0">0</b><span>صافي اليوم</span></div></div>
      <div class="tip" id="tip"><i id="tipI">💡</i><span id="tipT"></span><span class="bar" id="tipBar"></span></div>
      <div class="stream" id="stream"></div>
      <div class="chips" id="chips"><button data-q="power" id="qPower">وقّف ✋</button><button data-q="improve" id="qImp">🔧 حسّن</button><button data-q="analyze" id="qAn">📊 حلّل</button></div>
      <div class="hero" id="hero" style="display:none"></div>
      <div class="stats" style="display:none"><div><b id="sTr">0</b>صفقات</div><div><b id="sWr">–</b>نسبة الكسب</div><div><b id="sPl">0</b>الربح</div></div>
      <div class="ctrl hidden" id="ctrl">
      <div class="stake"><span>مبلغ الصفقة <span class="cur"></span></span><input id="amount" type="number" min="1" step="1"></div>
      <div class="stake"><span>صفقات مع بعض (أقصى) <small id="trN"></small></span><input id="maxOpen" type="number" min="0" step="1" placeholder="∞"></div>
      <div class="stake"><span>هدف الربح 🎯 <span class="cur"></span> <small id="tgN"></small></span><input id="target" type="number" min="0" step="1" placeholder="0 = بدون"></div>
      <div class="stake yt"><span>أقل نسبة ربح %</span><input id="minPay" type="number" min="1" max="100" step="1"></div>
      <div class="stake"><span>أقصى خسارة (من أعلى نقطة) <span class="cur"></span> <small id="dayPl" style="color:#8b93a3"></small></span><input id="stopLoss" type="number" min="0" step="1" placeholder="0 = بدون"></div>
      <div class="seg" id="mode"><button data-mode="intel">المحرك الذكي</button><button data-mode="copyplus">نسخ + تحقق</button><button data-mode="both">الاتنين</button><button data-mode="keltner">كيلتنر 10د</button><button data-mode="youtube">استراتيجيات <bdi>mostafa elashhab</bdi> <b class="risk">RISK</b></button></div>
      <div class="acts"><button class="go" id="start">تشغيل</button><button class="st" id="stop">إيقاف</button></div>
      <div class="status" id="engine"></div>
      <div class="status" id="status"></div>
      </div>
    </div>
    <div class="adv hidden" id="adv">
      <label class="chk"><input type="checkbox" id="demoOnly"> الحساب التجريبي فقط</label>
      <label>عملة الحساب<select id="currency"><option>EGP</option><option>USD</option><option>EUR</option><option>SAR</option><option>AED</option></select></label>
      <button class="sec" id="openDash">فتح لوحة الوضع المتقدم</button>
      <div class="filters" id="intelBox"></div>
      <button class="sec" id="csv">تصدير سجل الصفقات (CSV)</button>
      <div id="feed" style="color:#596173;font-size:11px"></div>
    </div>
  </div>`;

  const q = (id) => root.getElementById(id);
  // locked edition: only the stake, Start / Stop and the demo-only choice; no modes, settings or advanced views
  if (globalThis.PO_EDITION?.locked) {
    q('mode').style.display = 'none';
    q('mode').insertAdjacentHTML('afterend', '<div class="status" style="color:#f87171">استراتيجيات <bdi>mostafa elashhab</bdi> <b class="risk" style="font:700 10px system-ui;color:#fff;background:#dc2626;border-radius:4px;padding:1px 5px">RISK</b></div>');
    q('stop').closest('.acts').insertAdjacentElement('beforebegin', q('demoOnly').closest('label'));
  }
  q('amount').addEventListener('change', (e) => { const v = Number(e.target.value); if (v > 0) { state.settings.amount = v; saveSettings(); } render(); });
  q('target').addEventListener('change', (e) => { const v = Math.max(0, Number(e.target.value) || 0); setTarget(v); render(); });
  q('maxOpen').addEventListener('change', (e) => { const v = Math.floor(Number(e.target.value) || 0); if (v >= 0) { state.settings.maxOpen = v; saveSettings(); } render(); });
  q('minPay').addEventListener('change', (e) => { const v = Number(e.target.value); if (v > 0 && v <= 100) { state.settings.minPayout = v; saveSettings(); } render(); });
  q('stopLoss').addEventListener('change', (e) => { const v = Number(e.target.value); if (v >= 0) setStopLoss(v); render(); });
  q('currency').addEventListener('change', (e) => { state.settings.currency = e.target.value; saveSettings(); render(); });
  root.querySelectorAll('#mode button').forEach((b) => (b.onclick = () => {
    if (state.settings.strategy === b.dataset.mode) return;
    if (b.dataset.mode === 'youtube' && !confirm('وضع استراتيجيات mostafa elashhab: كل إشارة من استراتيجياته بتدخل صفقة على طول.\nفي اختبارات بياناتك كسبت هذه الاستراتيجيات بين 44% و53% — والتعادل عند ربح 92% هو 52%.\nمتأكد؟')) return;
    state.settings.strategy = b.dataset.mode; saveSettings(); render();
  }));
  q('demoOnly').addEventListener('change', (e) => {
    if (!e.target.checked && !confirm('السماح بالتداول على حساب حقيقي؟ قد تخسر أموالًا حقيقية.')) { e.target.checked = true; return; }
    state.settings.demoOnly = e.target.checked; saveSettings(); render();
  });
  q('openDash').onclick = () => globalThis.IntelTab?.openDashboard();
  q('start').onclick = () => (globalThis.PanelChat?.wizard ? (q('ctrl')?.classList.add('hidden'), PanelChat.wizard()) : start());
  q('stop').onclick = () => stop();
  q('csv').onclick = exportCsv;
  q('min').onclick = () => root.querySelector('.p').classList.toggle('min');
  // the gear opens the settings drawer under the chat (and, in the owner's copy, the advanced section)
  q('gear').onclick = () => { const open = q('ctrl').classList.toggle('hidden') === false; if (!globalThis.PO_EDITION?.locked) q('adv').classList.toggle('hidden', !open); render(); };

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

function render() {
  if (!root) return;
  const s = state.settings, ss = state.session;
  const q = (id) => root.getElementById(id);
  if (root.activeElement !== q('amount')) q('amount').value = s.amount;
  if (root.activeElement !== q('maxOpen')) q('maxOpen').value = s.maxOpen || '';
  if (root.activeElement !== q('target')) q('target').value = s.target || '';
  q('tgN').textContent = s.target > 0 ? `${targetMoney().net}/${s.target}` : '';
  // open now / the most at once
  const open = state.trades.length;
  q('trN').textContent = s.maxOpen > 0 ? `${open}/${s.maxOpen}` : open ? `(${open} مفتوحة)` : '';
  q('trN').style.color = s.maxOpen > 0 && open >= s.maxOpen ? '#fbbf24' : '';
  // payout floor and daily stop loss: the YouTube mode's only limits
  root.querySelectorAll('.yt').forEach((el) => (el.style.display = s.strategy === 'youtube' ? '' : 'none'));
  if (root.activeElement !== q('minPay')) q('minPay').value = s.minPayout;
  if (root.activeElement !== q('stopLoss')) q('stopLoss').value = s.stopLoss || '';
  const dm = dayMoney(), day = { net: dm.net, stopped: stopLossHit() };
  // the day's fall from its highest point as a bar that fills towards the stop loss
  const lossFrac = s.stopLoss > 0 ? Math.min(1, Math.max(0, dm.down / s.stopLoss)) : 0;
  q('dayPl').innerHTML = day ? `<span style="display:inline-block;width:56px;height:6px;border-radius:3px;background:#2a3040;vertical-align:middle;overflow:hidden"><i style="display:block;height:100%;width:${(lossFrac * 100).toFixed(0)}%;background:${day.stopped ? '#dc2626' : lossFrac > 0.6 ? '#f59e0b' : '#34d399'}"></i></span> ${day.net >= 0 ? '+' : ''}${day.net}${day.stopped ? ' ⛔' : ''}` : '';
  q('dayPl').style.color = day?.stopped ? '#f87171' : '#8b93a3';
  if (root.activeElement !== q('currency')) q('currency').value = s.currency;
  root.querySelectorAll('.cur').forEach(el => { el.textContent = `(${s.currency})`; });
  root.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === s.strategy));
  q('demoOnly').checked = s.demoOnly;
  q('start').disabled = state.running;
  q('stop').disabled = !state.running;
  q('dot').className = `dot${state.running ? ' on' : ''}`;
  q('status').innerHTML = state.hookFailed
    ? '<span class="warn">في إضافة تانية قافلة الأسعار. اقفل البوتات التانية واعمل reload.</span>'
    : state.running ? '' : statusAr(state.status);
  const demo = isDemoAccount();
  q('acct').className = `badge ${demo ? 'demo' : 'real'}`;
  q('acct').textContent = demo ? 'ديمو' : 'حساب حقيقي';
  q('pair').textContent = (state.asset || '—').replace('_otc', ' OTC');
  const payNow = readPayout();
  q('pay').textContent = payNow != null ? `ربح ${payNow}%` : 'ربح ?';

  // hero: an open trade, otherwise the engine's decision for this pair (same wording as the popup)
  const hero = q('hero');
  const t = [...state.trades].sort((x, y) => (x.openedAt + x.expiry * 1000) - (y.openedAt + y.expiry * 1000))[0];
  if (t) {
    const total = (t.expiry || 60) * 1000, left = Math.max(0, t.openedAt + total - Date.now());
    const mm = String(Math.floor(left / 60000)).padStart(2, '0'), ss2 = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
    hero.className = `hero ${t.dir}`;
    const D = t.dir === 'call' ? 'CALL' : 'PUT';
    hero.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;gap:14px">${ICON.arrow(D)}
      <div><div class="big">${t.dir === 'call' ? 'شراء' : 'بيع'}</div><div class="sub" style="color:#ffffffcc">${money(t.stake)}${state.trades.length > 1 ? ` · +${state.trades.length - 1}` : ''}</div></div>
      ${ICON.ring(left / total, `${mm}:${ss2}`, '#ffffff')}</div>`;
  } else {
    hero.className = 'hero';
    hero.innerHTML = intelCard(globalThis.IntelTab?.pairView(state.asset));
  }
  const what = s.strategy === 'youtube' ? `استراتيجيات mostafa elashhab — ${(OTC.YouTube?.ids() || []).filter((id) => !((globalThis.IntelTab?.cfg?.() || {}).soloOff || []).includes(id)).length} استراتيجية، كل واحدة على فريمها ومدتها`
    : s.strategy === 'keltner' ? 'كيلتنر 10 دقائق فقط — شموع 10 دقائق، صفقة 30 دقيقة (الحساب الحقيقي بعد ما تثبت النتائج)'
    : s.strategy === 'both' ? 'فرص المحرك الذكي وإشارات النسخ بعد التحقق' : isCopyMode() ? 'إشارات النسخ بعد التحقق — على كل الأزواج' : 'فرص المحرك الذكي';
  q('engine').innerHTML = state.running ? `<span class="ok"${s.strategy === 'youtube' ? ' style="color:#f87171"' : ''}>ينفّذ هنا: ${what}</span>`
    : '<span class="warn">التبويب متوقف — لن يُنفّذ شيئًا هنا. اضغط «تشغيل»</span>';
  globalThis.PanelChat?.update();
  q('sTr').textContent = ss.trades;
  const decided = ss.wins + ss.losses;
  q('sWr').textContent = decided ? `${Math.round((ss.wins / decided) * 100)}%` : '–';
  q('sPl').textContent = (ss.pl >= 0 ? '+' : '') + ss.pl;
  q('sPl').title = s.currency;
  q('sPl').className = ss.pl > 0 ? 'ok' : ss.pl < 0 ? 'neg' : '';
  if (q('adv').classList.contains('hidden')) return; // nothing below is visible

  q('intelBox').innerHTML = globalThis.IntelTab?.panelHtml() || 'المحرك الذكي غير محمّل';
  const age = state.lastTickAt ? Math.round((Date.now() - state.lastTickAt) / 1000) : null;
  q('feed').textContent = `${(state.asset || 'لا يوجد زوج').replace('_otc', ' OTC')} · ` +
    (age === null ? 'لم تصل أسعار بعد' : age < 5 ? 'الأسعار تصل' : `آخر سعر منذ ${age} ث`) + ` · السجل ${state.log.length}`;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountPanel);
else mountPanel();
setInterval(render, 1000);
