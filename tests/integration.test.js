// Integration tests for the Chrome glue: the real content scripts (bot.js +
// intel-tab.js) and the real service worker (background.js), each loaded into a
// vm context with mocked chrome / window / IndexedDB.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeCandles, ROOT } = require('./load.js');

const T0 = 1_700_000_000 - (1_700_000_000 % 3600) + 3600;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (x) => JSON.parse(JSON.stringify(x));
const time5 = (t) => `T0${t >= T0 ? '+' : ''}${(t - T0) / 300}`;

// ── in-memory stand-in for db.js ─────────────────────────────────────────────
function fakeDB() {
  const stores = { records: new Map(), candles: new Map(), candles_m1: new Map(), candles_s5: new Map(), hist5: new Map(), research: new Map(), strategies: new Map(), discovery_runs: new Map() };
  const key = (s, o) => (s.startsWith('candles') ? `${o.asset}|${o.time}` : s === 'hist5' ? `${o.asset}|${o.t0}` : s === 'strategies' ? o.key : o.id);
  const k2 = (k) => (Array.isArray(k) ? k.join('|') : k);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  return {
    stores,
    put: async (s, o) => { stores[s].set(key(s, o), clone(o)); },
    putMany: async (s, arr) => { for (const o of arr) stores[s].set(key(s, o), clone(o)); },
    get: async (s, k) => (stores[s].has(k2(k)) ? clone(stores[s].get(k2(k))) : undefined),
    keys: async (s) => [...stores[s].values()].map((o) => (s === 'hist5' ? [o.asset, o.t0] : s.startsWith('candles') ? [o.asset, o.time] : o.id)),
    all: async (s) => [...stores[s].values()].map(clone),
    byIndex: async (s, idx, v) => [...stores[s].values()].filter((o) => o[idx] === v).map(clone),
    range: async (s, idx, lo, hi) => [...stores[s].values()].filter((o) => o[idx] >= lo && o[idx] <= hi).map(clone),
    deleteWhere: async (s, idx, v, pred = () => true) => { let n = 0; for (const [k, o] of stores[s]) if (o[idx] === v && pred(o)) { stores[s].delete(k); n++; } return n; },
    candlesFor: async (a) => [...stores.candles.values()].filter((c) => c.asset === a).sort((x, y) => x.time - y.time),
    span: async (st, a, from, to) => [...stores[st].values()].filter((c) => c.asset === a && c.time >= from && c.time <= to).sort((x, y) => x.time - y.time).map(clone),
    dropBefore: async (st, a, t) => { for (const [k, c] of stores[st]) if (c.asset === a && (c.time ?? c.t0) < t) stores[st].delete(k); },
  };
}

const listeners = () => { const fns = []; return { fns, addListener: (f) => fns.push(f), fire: (...a) => fns.forEach((f) => f(...a)) }; };

// ── service worker harness ───────────────────────────────────────────────────
async function loadWorker(storage = {}) {
  const store = { ...storage };
  const onConnect = listeners(), notifications = [], tabsCreated = [];
  const DB = fakeDB();
  const chrome = {
    storage: { local: { get: async (keys) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, plain(store[k])])), set: async (o) => Object.assign(store, plain(o)) } },
    runtime: { onConnect, onMessage: listeners(), getURL: (p) => `chrome-extension://x/${p}` },
    action: { onClicked: listeners() },
    notifications: { create: (o) => notifications.push(o) },
    tabs: { create: (o) => tabsCreated.push(o) },
  };
  // unref'd timers so the worker's long confirmation timeouts don't keep the test process alive
  const st = (f, ms) => { const t = setTimeout(f, ms); t.unref?.(); return t; };
  const ctx = vm.createContext({ console, setTimeout: st, clearTimeout, setInterval: () => 0, Date, Math, JSON, Map, Set, Promise, chrome, DB });
  ctx.importScripts = (...files) => { for (const f of files) if (f !== 'db.js') vm.runInContext(read(f), ctx, { filename: f }); };
  vm.runInContext(read('background.js'), ctx, { filename: 'background.js' });
  await wait(5);
  const connectTab = (tabId) => {
    const onMessage = listeners(), onDisconnect = listeners(), sent = [];
    const port = { name: 'intel-tab', sender: { tab: { id: tabId } }, onMessage, onDisconnect, postMessage: (m) => sent.push(plain(m)) };
    onConnect.fire(port);
    return { port, sent, send: async (m) => { onMessage.fire(m); await wait(5); }, disconnect: () => onDisconnect.fire() };
  };
  const connectDash = () => {
    const onMessage = listeners(), onDisconnect = listeners(), sent = [];
    onConnect.fire({ name: 'intel-dash', onMessage, onDisconnect, postMessage: (m) => sent.push(plain(m)) });
    return { sent, send: async (m) => { onMessage.fire(m); await wait(10); } };
  };
  return { ctx, store, DB, notifications, tabsCreated, connectTab, connectDash };
}

function makeRecord(asset, candleTime, decision, extra = {}) {
  return { id: `live|${asset}|${candleTime}`, source: 'live', asset, candleTime, ts: candleTime + 300, payout: 92, decision, lean: decision === 'SKIP' ? 'CALL' : decision,
    deep: 80, regime: 'TRENDING_UP', setup: 'trend_following', combo: 'trend_following', strategies: [['trend_following', decision === 'PUT' ? 'PUT' : 'CALL', 85, 1]],
    modules: {}, entryPrice: 1.08, exits: {}, status: 'pending', skipReasons: [], riskFlags: [], evidenceFor: [], evidenceAgainst: [], exec: null, ...extra };
}
const candOf = (rec, deep = 80) => ({ id: rec.id, asset: rec.asset, dir: rec.decision, candleTime: rec.candleTime, deep, setup: rec.setup, setupName: 'Trend Following',
  regime: rec.regime, evidenceAgainst: [], timing: { quality: 100 }, closePrice: 1.08, atr: 0.001, strategies: rec.strategies, payout: 92 });

const FAST = { intelConfig: { risk: { batchWindowMs: 20 } } };

test('worker PAPER: candidate becomes a paper trade, outcome resolves it and updates risk', async () => {
  const W = await loadWorker(FAST);
  const tab = W.connectTab(1);
  const now = T0 + 5;
  const rec = makeRecord('EURUSD_otc', T0 - 300, 'CALL');
  await tab.send({ type: 'decision', record: rec, cand: candOf(rec), poNow: now });
  await wait(60);
  let saved = await W.DB.get('records', rec.id);
  assert.equal(saved.exec.action, 'paper');
  assert.equal(W.store.intelRisk.trades, 1);
  // the next 5M close arrives from the tab → paper trade resolves as a win
  await tab.send({ type: 'candles', asset: 'EURUSD_otc', rows: [{ time: T0, open: 1.08, high: 1.082, low: 1.079, close: 1.081 }] });
  saved = await W.DB.get('records', rec.id);
  assert.equal(saved.exits[1], 1.081);
  assert.equal(saved.exec.result, 'W');
  assert.equal(W.store.intelRisk.wins, 1);
  assert.ok(Math.abs(W.store.intelRisk.net - 0.92) < 1e-9);
  assert.equal(W.DB.stores.candles.size, 1);
});

// An opportunity entry: 15M setup confirmed by a 5M candle, entered at the 1M close T0, duration 3 minutes.
function makeOpp(asset, entryTime, dir, extra = {}) {
  // tf 1: exits keyed by seconds after entry
  return { id: `opp|${asset}|900|${entryTime - 300}`, kind: 'opp', tf: 1, horizons: [60, 120, 180, 300, 600, 900, 1800], frame: 900, timingTf: 300, source: 'live', asset, candleTime: entryTime - 60, ts: entryTime,
    payout: 92, decision: dir, lean: dir, deep: 78, regime: 'TRENDING_UP', setup: 'trend_following', setupKind: 'pullback', strategies: [['trend_following', dir, 85, 1]],
    state: 'ENTERED', path: ['DISCOVERED', 'CONFIRMED', 'WAIT_FOR_CONFIRMATION', 'ENTERED'], why: 'confirmed', expirySec: 180, entryPrice: 1.08,
    exits: {}, status: 'pending', skipReasons: [], riskFlags: [], evidenceFor: [], evidenceAgainst: [], exec: null, ...extra };
}
const oppCand = (rec) => ({ id: rec.id, kind: 'opp', asset: rec.asset, dir: rec.decision, candleTime: rec.candleTime, entryTime: rec.ts, entryPrice: 1.08, entryAtr: 0.0004,
  entryTf: 300, validFor: 30, expirySec: rec.expirySec, tf: 900, invalidation: 1.078, deep: rec.deep, setup: rec.setup, setupName: 'Trend Following', regime: rec.regime,
  evidenceAgainst: [], atr: 0.001, strategies: rec.strategies, payout: 92,
  cal: { status: 'MEASURED', measured: true, winProb: 64.2, interval: [57.6, 72.1], ev: 0.23, p: 99, n: 150, payout: 92, minPayout: 92, qualified: true, blocks: [],
    source: 'entries', level: 'setup_regime', oos: { w: 100, l: 50, n: 150, wr: 66.7 }, stable: true } });

test('worker PAPER: an opportunity entry is paper-traded at its own duration and resolved from 1M closes', async () => {
  const W = await loadWorker(FAST);
  const tab = W.connectTab(1);
  const rec = makeOpp('EURUSD_otc', T0, 'CALL');
  await tab.send({ type: 'decision', record: rec, cand: oppCand(rec), poNow: T0 + 2 });
  await wait(60);
  let saved = await W.DB.get('records', rec.id);
  assert.equal(saved.exec.action, 'paper');
  assert.equal(saved.exec.expiry, 180, 'expiry in seconds, as chosen by the opportunity');
  assert.equal(W.store.intelRisk.open[0].until, T0 + 180);
  // minutes 1 and 2 are not the trade's end; the 3rd minute close is
  const m1 = (k, close) => ({ time: T0 + (k - 1) * 60, open: 1.08, high: 1.081, low: 1.079, close });
  await tab.send({ type: 'candles', asset: 'EURUSD_otc', tf: 60, rows: [m1(1, 1.0795), m1(2, 1.0799)] });
  saved = await W.DB.get('records', rec.id);
  assert.ok(!saved.exec.result);
  await tab.send({ type: 'candles', asset: 'EURUSD_otc', tf: 60, rows: [m1(3, 1.0803)] });
  saved = await W.DB.get('records', rec.id);
  assert.equal(saved.exits[180], 1.0803);
  assert.equal(saved.exec.result, 'W');
  assert.equal(W.store.intelRisk.wins, 1);
});

test('worker AUTO demo: an opportunity is executed with its duration and the entry details for the safety re-check', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(31);
  await tab.send({ type: 'hello', isDemo: true, chartAsset: 'EURUSD_otc' });
  const rec = makeOpp('EURUSD_otc', T0, 'PUT', { expirySec: 600 });
  await tab.send({ type: 'decision', record: rec, cand: oppCand(rec), poNow: T0 + 2 });
  await wait(60);
  const ex = tab.sent.find((m) => m.type === 'execute');
  assert.ok(ex);
  assert.equal(ex.kind, 'opp');
  assert.equal(ex.expirySec, 600);
  assert.equal(ex.entryTime, T0);
  assert.equal(ex.validFor, 30);
  assert.equal(ex.invalidation, 1.078);
  await tab.send({ type: 'execResult', id: rec.id, status: 'placed', stake: 1, demo: true });
  const r = W.store.intelRisk;
  assert.ok(r.open.some((o) => o.until === T0 + 600), JSON.stringify(r.open));
});

test('worker: past outcomes become cohort tables for the tabs; entries failing the gate are never acted on', async () => {
  const W = await loadWorker(FAST);
  // 200 resolved 15M pullback entries that won 70% at 5 minutes
  for (let i = 0; i < 200; i++) {
    const t = T0 - 200 * 1800 + i * 1800, win = i % 10 < 7;
    const exits = { 60: 1.08, 120: 1.08, 180: 1.08, 300: win ? 1.081 : 1.079, 600: 1.08, 900: 1.08, 1800: 1.08 };
    await W.DB.put('records', makeOpp('EURUSD_otc', t, 'CALL', { id: `opp|EURUSD_otc|900|${t}`, decision: 'SKIP', state: 'GATED', path: ['DISCOVERED', 'CONFIRMED', 'GATED'], exits, status: 'resolved' }));
  }
  await W.connectDash().send({ type: 'refreshPerf' });
  const tab = W.connectTab(5);
  await wait(10);
  const cfgMsg = tab.sent.filter((m) => m.type === 'config').pop();
  const t = cfgMsg.calTables.entries['900|trend_following|CALL|TRENDING_UP'];
  assert.ok(t && t[300], Object.keys(cfgMsg.calTables.entries).join());
  assert.equal(t[300].sel[0] + t[300].sel[1], 120);
  assert.equal(t[300].oos[0] + t[300].oos[1], 80);
  assert.equal(cfgMsg.calStatus.status, 'COLLECTING');
  // a candidate that claims to be qualified but is below the gate is refused by the worker
  await tab.send({ type: 'hello', isDemo: true, chartAsset: 'EURUSD_otc' });
  const rec = makeOpp('EURUSD_otc', T0, 'CALL');
  const cand = { ...oppCand(rec), payout: 70 };
  await tab.send({ type: 'decision', record: rec, cand, poNow: T0 + 2 });
  await wait(60);
  let saved = await W.DB.get('records', rec.id);
  assert.equal(saved.exec.action, 'gated');
  assert.equal(saved.decision, 'SKIP');
  assert.ok(saved.skipReasons.some((r) => /payout 70% < 80%/.test(r)));
  // 92% payout but the measured expected value is negative
  const rec2 = makeOpp('EURUSD_otc', T0 + 600, 'CALL');
  await tab.send({ type: 'decision', record: rec2, cand: { ...oppCand(rec2), cal: { ...oppCand(rec2).cal, winProb: 49, ev: -0.06, measured: true } }, poNow: T0 + 602 });
  await wait(60);
  saved = await W.DB.get('records', rec2.id);
  assert.equal(saved.exec.action, 'gated');
  assert.ok(saved.skipReasons.some((r) => /expected value -0.06 ≤ 0/.test(r)), saved.skipReasons.join());
});

test('worker AUTO: a qualified entry on a pair no armed tab shows is paper-traded and the user is told where it is', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(41);
  await tab.send({ type: 'hello', isDemo: true, chartAsset: 'GBPUSD_otc' });
  const rec = makeOpp('AUDCAD_otc', T0, 'CALL', { scanned: true });
  await tab.send({ type: 'decision', record: rec, cand: oppCand(rec), poNow: T0 + 2 });
  await wait(60);
  assert.ok(!tab.sent.some((m) => m.type === 'execute'));
  assert.equal((await W.DB.get('records', rec.id)).exec.action, 'paper');
  assert.ok(W.notifications.some((n) => /غير مفتوح/.test(n.title)));
});

test('worker: every signal records whether its pair was on a tab\'s chart (off-chart signals never judge a strategy)', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(42);
  await tab.send({ type: 'hello', isDemo: true, chartAsset: 'GBPUSD_otc' });
  const offRec = makeOpp('AUDCAD_otc', T0, 'CALL'), onRec = makeOpp('GBPUSD_otc', T0, 'PUT');
  await tab.send({ type: 'decision', record: offRec, cand: oppCand(offRec), poNow: T0 + 2 });
  await tab.send({ type: 'decision', record: onRec, cand: oppCand(onRec), poNow: T0 + 2 });
  await wait(60);
  assert.equal((await W.DB.get('records', offRec.id)).chart, false);
  assert.equal((await W.DB.get('records', onRec.id)).chart, true);
  assert.ok('speed' in (await W.DB.get('records', onRec.id)), 'speed is recorded (null without 1-second closes)');
});

test('worker AUTO: each tab places only its own signals on its own chart pair — never another tab\'s, never by switching', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', ownOnly: true, risk: { batchWindowMs: 20 } } });
  const a = W.connectTab(71), b = W.connectTab(72);
  await a.send({ type: 'state', poNow: T0 + 1, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', isDemo: true, openTrades: [], assets: [] });
  await b.send({ type: 'state', poNow: T0 + 1, chartAsset: 'GBPUSD_otc', armed: true, running: true, engine: 'intel', isDemo: true, openTrades: [], assets: [] });
  // tab B found a signal on EURUSD (shown in tab A): not placed in A
  const other = makeOpp('EURUSD_otc', T0, 'CALL');
  await b.send({ type: 'decision', record: other, cand: oppCand(other), poNow: T0 + 2 });
  // tab B found one on a pair no tab shows: no tab switches to it
  const nowhere = makeOpp('AUDCAD_otc', T0, 'PUT');
  await b.send({ type: 'decision', record: nowhere, cand: { ...oppCand(nowhere), validFor: 120 }, poNow: T0 + 2 });
  await wait(80);
  assert.ok(![...a.sent, ...b.sent].some((m) => m.type === 'execute' || m.type === 'switchAsset'));
  assert.equal((await W.DB.get('records', other.id)).exec.action, 'paper');
  assert.equal((await W.DB.get('records', nowhere.id)).exec.action, 'paper');
  // its own signal on its own chart pair: placed, in that tab
  const own = makeOpp('GBPUSD_otc', T0 + 30, 'CALL');
  await b.send({ type: 'decision', record: own, cand: oppCand(own), poNow: T0 + 32 });
  await wait(80);
  assert.ok(b.sent.some((m) => m.type === 'execute' && m.id === own.id && !m.switch));
  assert.ok(!a.sent.some((m) => m.type === 'execute'));
});

test('worker AUTO: a qualified entry on a pair not on any chart is sent to a free armed tab to open it first', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', ownOnly: false, risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(51);
  await tab.send({ type: 'hello', isDemo: true, chartAsset: 'NZDUSD_otc' });
  await tab.send({ type: 'state', poNow: T0 + 1, chartAsset: 'NZDUSD_otc', armed: true, running: true, engine: 'intel', isDemo: true, openTrades: [], assets: [] });
  const rec = makeOpp('AUDCAD_otc', T0, 'CALL');
  await tab.send({ type: 'decision', record: rec, cand: oppCand(rec), poNow: T0 + 2 });
  await wait(60);
  const ex = tab.sent.find((m) => m.type === 'execute');
  assert.ok(ex, 'sent to the armed tab');
  assert.equal(ex.asset, 'AUDCAD_otc');
  assert.equal(ex.switch, true, 'the tab must open the pair first');
  // too late to switch (entry window almost over): paper, and the user is told
  const W2 = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const tab2 = W2.connectTab(52);
  await tab2.send({ type: 'state', poNow: T0 + 27, chartAsset: 'NZDUSD_otc', armed: true, running: true, engine: 'intel', isDemo: true, openTrades: [], assets: [] });
  const rec2 = makeOpp('AUDCAD_otc', T0, 'CALL');
  await tab2.send({ type: 'decision', record: rec2, cand: oppCand(rec2), poNow: T0 + 27 });
  await wait(60);
  assert.ok(!tab2.sent.some((m) => m.type === 'execute'));
  assert.equal((await W2.DB.get('records', rec2.id)).exec.action, 'paper');
});

test('worker AUTO: while a qualified opportunity waits on another pair, a free armed tab switches to it (once a minute at most)', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', ownOnly: false } });
  const tab = W.connectTab(61);
  const opp = (asset, state, p, qualified = true) => ({ asset, scanned: true, opp: { state, dir: 'CALL', tf: 900, confidence: 80, expiresAt: T0 + 900, cal: { qualified, measured: false, p } } });
  const st = (assets, chartAsset = 'NZDUSD_otc', openTrades = []) => ({ type: 'state', poNow: T0, chartAsset, armed: true, running: true, engine: 'intel', isDemo: true, openTrades, assets });
  await tab.send(st([opp('AUDCAD_otc', 'WAIT_FOR_CONFIRMATION', 0), opp('GBPUSD_otc', 'WAIT_FOR_RETEST', 0, false)]));
  let sw = tab.sent.filter((m) => m.type === 'switchAsset');
  assert.equal(sw.length, 1);
  assert.equal(sw[0].asset, 'AUDCAD_otc', 'only qualified opportunities');
  await wait(3100);
  await tab.send(st([opp('EURJPY_otc', 'WAIT_FOR_CONFIRMATION', 0)]));
  assert.equal(tab.sent.filter((m) => m.type === 'switchAsset').length, 1, 'not again within a minute');
  // also with a trade open: PO settles it whatever the chart shows, and trades may run together
  const W2 = await loadWorker({ intelConfig: { execMode: 'AUTO', ownOnly: false } });
  const t2 = W2.connectTab(62);
  await t2.send(st([opp('AUDCAD_otc', 'WAIT_FOR_CONFIRMATION', 0)], 'NZDUSD_otc', [{ asset: 'NZDUSD_otc' }]));
  assert.ok(t2.sent.some((m) => m.type === 'switchAsset'));
  // not in PAPER mode
  const W3 = await loadWorker({});
  const t3 = W3.connectTab(63);
  await t3.send(st([opp('AUDCAD_otc', 'WAIT_FOR_CONFIRMATION', 0)]));
  assert.ok(!t3.sent.some((m) => m.type === 'switchAsset'));
  // and never while each tab keeps to its own signals (cfg.ownOnly)
  const W4 = await loadWorker({ intelConfig: { execMode: 'AUTO', ownOnly: true } });
  const t4 = W4.connectTab(64);
  await t4.send(st([opp('AUDCAD_otc', 'WAIT_FOR_CONFIRMATION', 0)]));
  assert.ok(!t4.sent.some((m) => m.type === 'switchAsset'));
});

test('worker AUTO: entries on pairs no armed tab can place are shadow paper — never in the risk counters; the tab is told', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20, maxConcurrent: 1 } } });
  const tab = W.connectTab(71);
  await tab.send({ type: 'state', poNow: T0 + 1, chartAsset: 'GBPUSD_otc', armed: false, running: false, isDemo: true, openTrades: [], assets: [] });
  const rec = makeOpp('AUDCAD_otc', T0, 'CALL');
  await tab.send({ type: 'decision', record: rec, cand: oppCand(rec), poNow: T0 + 2 });
  await wait(60);
  const saved = await W.DB.get('records', rec.id);
  assert.equal(saved.exec.action, 'paper');
  assert.equal(saved.exec.shadow, true);
  assert.equal(W.store.intelRisk?.trades ?? 0, 0, 'not a trade for the Risk Engine');
  assert.equal((W.store.intelRisk?.open || []).length, 0, 'does not hold the open-trade slot');
  const told = tab.sent.filter((m) => m.type === 'oppAction').pop();
  assert.equal(told.id, rec.id);
  assert.equal(told.action, 'shadow');
  // it loses: still no cooldown or loss streak
  const m1 = (k, close) => ({ time: T0 + (k - 1) * 60, open: 1.08, high: 1.081, low: 1.079, close });
  await tab.send({ type: 'candles', asset: 'AUDCAD_otc', tf: 60, rows: [m1(1, 1.07), m1(2, 1.07), m1(3, 1.07)] });
  assert.equal((await W.DB.get('records', rec.id)).exec.result, 'L');
  assert.equal(W.store.intelRisk?.consecLosses ?? 0, 0);
  assert.equal(W.store.intelRisk?.lastLossAt ?? null, null);
});

test('worker AUTO: the engine\'s own entry on a pair shown in a "Copy + verify" tab is follow-only — not "pair not open"', async () => {
  // seen on real data: the user runs Copy + verify; the engine's opportunities on the very pair on the chart were
  // reported as "pair not open for execution" (26 in a day)
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(73);
  await tab.send({ type: 'state', poNow: T0 + 1, chartAsset: 'AUDCAD_otc', armed: true, running: true, engine: 'copy', isDemo: true, openTrades: [], assets: [] });
  const rec = makeOpp('AUDCAD_otc', T0, 'CALL');
  await tab.send({ type: 'decision', record: rec, cand: oppCand(rec), poNow: T0 + 2 });
  await wait(60);
  assert.ok(!tab.sent.some((m) => m.type === 'execute'), 'a copy tab places copy signals only');
  const told = tab.sent.filter((m) => m.type === 'oppAction' && m.id === rec.id);
  assert.equal(told.length, 1, 'one message, no "pair not open" first');
  assert.equal(told[0].action, 'othermode');
  assert.equal(told[0].detail, 'copy');
  const saved = await W.DB.get('records', rec.id);
  assert.equal(saved.execState, 'OTHER_MODE');
  assert.equal(saved.exec.shadow, true, 'outside the Risk Engine');
  assert.equal((W.store.intelRisk?.open || []).length, 0);
  assert.ok(!W.notifications.some((n) => /غير مفتوح/.test(n.title || '')), 'no "pair not open" notification');
  const { AR } = require('./load.js').load();
  assert.match(AR.actionText({ action: 'othermode', detail: 'copy' }).title, /وضع النسخ/);
});

test('worker: 3-second outcomes come from 1-second closes; when those never came, the record is not held back', async () => {
  const W = await loadWorker(FAST);
  const tab = W.connectTab(74);
  const rec = { ...makeOpp('EURUSD_otc', T0, 'CALL'), horizons: [3, 5, 10] };
  await tab.send({ type: 'decision', record: rec, cand: null, poNow: T0 + 1 });
  const s1 = (t, close) => ({ time: t, open: close, high: close, low: close, close });
  await tab.send({ type: 'candles', asset: 'EURUSD_otc', tf: 1, rows: [s1(T0, 1.0801), s1(T0 + 1, 1.0802), s1(T0 + 2, 1.0805)] });
  let saved = await W.DB.get('records', rec.id);
  assert.equal(saved.exits[3], 1.0805, 'the close at entry + 3s');
  const s5 = (t, close) => ({ time: t, open: 1.08, high: 1.081, low: 1.079, close });
  await tab.send({ type: 'candles', asset: 'EURUSD_otc', tf: 5, rows: [s5(T0, 1.0806), s5(T0 + 5, 1.0807)] });
  saved = await W.DB.get('records', rec.id);
  assert.equal(saved.status, 'resolved');
  assert.deepEqual([saved.exits[5], saved.exits[10]], [1.0806, 1.0807]);
  // the pair left the chart right after the entry: no 1s closes, ever — once later horizons are in, it is not kept pending
  const { OTC } = require('./load.js').load(['engine/core.js', 'engine/orchestrator.js']);
  const r2 = { ts: T0, tf: 1, status: 'pending', exits: {} };
  const closes = new Map([[T0 + 5, 1.1], [T0 + 10, 1.2]]);
  OTC.Orchestrator.resolve(r2, closes, [3, 5, 10], T0 + 30);
  assert.equal(r2.status, 'pending', 'the 1s batch may still be on its way');
  OTC.Orchestrator.resolve(r2, closes, [3, 5, 10], T0 + 200);
  assert.equal(r2.status, 'resolved');
  assert.equal(r2.exits[3], undefined);
});

test('worker: a tab set to "both" places the engine\'s entries and verified copy signals', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20, maxConcurrent: 5, pairCooldownMin: 0 } } });
  const tab = W.connectTab(75);
  await tab.send({ type: 'state', poNow: T0 + 1, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'both', isDemo: true, openTrades: [], assets: [] });
  const eng = makeOpp('EURUSD_otc', T0, 'CALL');
  await tab.send({ type: 'decision', record: eng, cand: oppCand(eng), poNow: T0 + 2 });
  await wait(60);
  assert.ok(tab.sent.some((m) => m.type === 'execute' && m.id === eng.id), 'engine entry placed');
  const cp = makeOpp('EURUSD_otc', T0 + 600, 'PUT', { id: `opp|EURUSD_otc|copy|${T0 + 600}`, setup: 'copy_signal', setupKind: 'copy', origin: 'copy' });
  await tab.send({ type: 'decision', record: cp, cand: { ...oppCand(cp), source: 'copy', validFor: 12, entryTime: T0 + 601 }, poNow: T0 + 602 });
  await wait(400);
  assert.ok(tab.sent.some((m) => m.type === 'execute' && m.id === cp.id && m.source === 'copy'), 'copy entry placed');
});

test('worker AUTO: an entry on a pair whose tab was never started says so (not "pair not open")', async () => {
  // seen on real data: hours of qualified entries, every one paper, because no tab had been started after reloads
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const scanner = W.connectTab(76), chart = W.connectTab(77);
  await scanner.send({ type: 'state', poNow: T0 + 1, chartAsset: 'GBPUSD_otc', armed: false, running: false, engine: 'both', isDemo: true, openTrades: [], assets: [] });
  await chart.send({ type: 'state', poNow: T0 + 1, chartAsset: 'EURUSD_otc', armed: false, running: false, engine: 'both', isDemo: true, openTrades: [], assets: [] });
  const rec = makeOpp('EURUSD_otc', T0, 'CALL');
  await scanner.send({ type: 'decision', record: rec, cand: oppCand(rec), poNow: T0 + 2 });
  await wait(60);
  const told = scanner.sent.filter((m) => m.type === 'oppAction' && m.id === rec.id).pop();
  assert.equal(told.action, 'notarmed');
  assert.equal((await W.DB.get('records', rec.id)).execState, 'NOT_ARMED');
});

test('worker: an entry blocked by the Risk Engine is reported to its tab with the reasons', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'PAPER', risk: { batchWindowMs: 20 } }, intelRisk: { ...require('./load.js').load(['engine/core.js', 'engine/risk.js']).OTC.Risk.newRiskState(T0), emergency: 'test' } });
  const tab = W.connectTab(72);
  const rec = makeOpp('EURUSD_otc', T0, 'PUT');
  await tab.send({ type: 'decision', record: rec, cand: oppCand(rec), poNow: T0 + 2 });
  await wait(60);
  const told = tab.sent.filter((m) => m.type === 'oppAction').pop();
  assert.equal(told.action, 'risk');
  assert.ok(told.detail.includes('EMERGENCY'));
});

test('worker AUTO real account: INSUFFICIENT_DATA is research only, even when the user allows all qualified entries', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', autoRealAll: true, risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(81);
  await tab.send({ type: 'hello', isDemo: false, chartAsset: 'EURUSD_otc' });
  const rec = makeOpp('EURUSD_otc', T0, 'CALL');
  const cand = { ...oppCand(rec), cal: { status: 'INSUFFICIENT_DATA', measured: false, winProb: null, ev: null, qualified: true, blocks: [], payout: 92 } };
  await tab.send({ type: 'decision', record: rec, cand, poNow: T0 + 2 });
  await wait(60);
  assert.ok(!tab.sent.some((m) => m.type === 'execute'), 'never executed on a real account');
  const saved = await W.DB.get('records', rec.id);
  assert.equal(saved.execState, 'RESEARCH_ONLY');
  assert.equal(saved.exec.shadow, true);
  // measured and positive: executed
  const rec2 = makeOpp('EURUSD_otc', T0 + 600, 'CALL');
  await tab.send({ type: 'decision', record: rec2, cand: oppCand(rec2), poNow: T0 + 602 });
  await wait(60);
  assert.ok(tab.sent.some((m) => m.type === 'execute' && m.id === rec2.id));
  assert.equal((await W.DB.get('records', rec2.id)).execState, 'SENT');
});

test('worker: copy entries go only to a tab in copy mode; engine entries only to a tab in engine mode', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', ownOnly: false, risk: { batchWindowMs: 20, maxConcurrent: 5, pairCooldownMin: 0 } } });
  const copyTab = W.connectTab(91);
  await copyTab.send({ type: 'state', poNow: T0 + 1, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'copy', isDemo: true, openTrades: [], assets: [] });
  const engineRec = makeOpp('EURUSD_otc', T0, 'CALL');
  await copyTab.send({ type: 'decision', record: engineRec, cand: oppCand(engineRec), poNow: T0 + 2 });
  await wait(60);
  assert.ok(!copyTab.sent.some((m) => m.type === 'execute' && m.id === engineRec.id), 'a copy-mode tab does not place the engine\'s own entries');
  assert.equal((await W.DB.get('records', engineRec.id)).execState, 'OTHER_MODE', 'the pair IS open: its tab is in the other mode');
  const copyRec = makeOpp('AUDCAD_otc', T0 + 30, 'PUT', { id: `opp|AUDCAD_otc|copy|${T0 + 30}`, setup: 'copy_signal', setupKind: 'copy', origin: 'copy' });
  await copyTab.send({ type: 'decision', record: copyRec, cand: { ...oppCand(copyRec), source: 'copy', validFor: 12, entryTime: T0 + 31 }, poNow: T0 + 32 });
  await wait(400); // copy entries use the fast ranking window
  const ex = copyTab.sent.find((m) => m.type === 'execute' && m.id === copyRec.id);
  assert.ok(ex, 'the copy entry is placed by the copy tab');
  assert.equal(ex.source, 'copy');
  assert.equal(ex.switch, true, 'its pair is opened first');
});

test('worker: each strategy\'s track record is built from the analyses and sent to every tab (no hindsight in replays)', async () => {
  const W = await loadWorker(FAST);
  const recs = [];
  for (let i = 0; i < 120; i++) recs.push({ id: `live|EURUSD_otc|60|${T0 + 60 * i}`, kind: 'setup', source: 'live', asset: 'EURUSD_otc', tf: 60, candleTime: T0 + 60 * i, ts: T0 + 60 * (i + 1),
    regime: 'RANGING', entryPrice: 1, exits: { 1: i % 3 ? 0.999 : 1.001 }, status: 'resolved', strategies: [['rsi_momentum', 'CALL', 80, 1]] });
  await W.DB.putMany('records', recs);
  const tab = W.connectTab(111), dash = W.connectDash();
  await dash.send({ type: 'refreshPerf' });
  const cfgMsg = tab.sent.filter((m) => m.type === 'config').pop();
  assert.ok(cfgMsg.relTables?.keys?.['rsi_momentum|60'], 'sent with the config');
  const { OTC } = require('./load.js').load();
  const r = OTC.Consensus.reliability('rsi_momentum', { asset: 'EURUSD_otc', frame: 60, regime: 'RANGING' }, cfgMsg.relTables, OTC.DEFAULT_CONFIG);
  assert.equal(r.w, 0, 'wrong two times in three on 1M: no vote');
  const snap = dash.sent.filter((m) => m.type === 'snapshot').pop();
  assert.equal(snap.relMeta.meta.records, 120);
});

test('worker: live similarity answers from the stored dataset and the latest research model', async () => {
  const W = await loadWorker(FAST);
  const { OTC } = require('./load.js').load();
  const R = OTC.Research;
  // 6 hours of 5s candles ending now, stored one row per hour, and a research model built from them
  const end = T0 - (T0 % 3600), cs = makeCandles({ start: end - 6 * 3600, tf: 5, segments: [{ n: 6 * 720, drift: 0, vol: 0.00005 }], seed: 41 });
  const byH = {};
  for (const c of cs) (byH[c.time - (c.time % 3600)] ||= []).push(c);
  await W.DB.putMany('hist5', Object.entries(byH).map(([t0, rows]) => ({ asset: 'EURUSD_otc', t0: +t0, t: rows.map((c) => c.time), o: rows.map((c) => c.open), h: rows.map((c) => c.high), l: rows.map((c) => c.low), c: rows.map((c) => c.close) })));
  const states = R.build(cs, 5, { asset: 'EURUSD_otc' });
  const wf = R.walkForward(states, { o: { ...R.DEFAULTS, warm: 500 } });
  await W.DB.put('research', { id: 'rm-1', builtAt: Date.now(), reliability: { 5: R.reliability(wf), 60: null }, patterns: { 5: [], 60: [] }, summary: {} });
  const tab = W.connectTab(140), dash = W.connectDash();
  await tab.send({ type: 'state', poNow: end, chartAsset: 'EURUSD_otc', armed: false, isDemo: true, openTrades: [], assets: [] });
  await dash.send({ type: 'researchUpdated' });
  const now = R.build(cs.slice(-200), 5, { asset: 'EURUSD_otc', withoutOutcome: true }).pop();
  await tab.send({ type: 'histPredict', reqId: 'h1', state: now });
  const ans = tab.sent.find((m) => m.type === 'histPredict' && m.reqId === 'h1');
  assert.ok(ans?.prediction, 'answered');
  assert.equal(ans.prediction.model.id, 'rm-1');
  if (ans.prediction.status === 'OK') {
    assert.equal(ans.prediction.horizons.length, 6);
    assert.ok(ans.prediction.horizons.every((h) => h.tested && typeof h.tested.significant === 'boolean'), 'each horizon with its walk-forward record');
  } else assert.equal(ans.prediction.status, 'INSUFFICIENT_DATA');
  const snap = dash.sent.filter((m) => m.type === 'snapshot').pop();
  assert.equal(snap.dataset.s5.EURUSD_otc.hours, 6, 'coverage: 6 hours of 5s');
  assert.equal(snap.research.id, 'rm-1');
});

test('worker: 5s analyses carry the durations discovered strategies are tested on, resolved from 5s closes (shadow tracking)', async () => {
  const W = await loadWorker(FAST);
  const tab = W.connectTab(150);
  const rec = { id: `live|EURUSD_otc|5|${T0}`, kind: 'setup', source: 'live', asset: 'EURUSD_otc', tf: 5, candleTime: T0, ts: T0 + 5, decision: 'SKIP', lean: 'PUT', entryPrice: 1.08,
    horizons: [1, 2, 3, 6, 12], exits: {}, status: 'pending', disc: [['DISC-S1', 'PUT', 1]], strategies: [], skipReasons: [] };
  await tab.send({ type: 'decision', record: rec, cand: null, poNow: T0 + 6 });
  const rows = Array.from({ length: 14 }, (_, k) => ({ time: T0 + 5 * (k + 1), open: 1.08, high: 1.081, low: 1.079, close: 1.08 - 0.0001 * (k + 1) }));
  await tab.send({ type: 'candles', asset: 'EURUSD_otc', tf: 5, rows });
  const saved = await W.DB.get('records', rec.id);
  assert.equal(saved.status, 'resolved');
  assert.ok(saved.exits[6] != null && saved.exits[12] != null, JSON.stringify(saved.exits));
});

test('execution forensics: PO\'s own deal record reaches the worker, which compares its close price with the market at that second', async () => {
  // the page: PO's close event carries the deal (open/close price and time)
  const T = loadTab();
  vm.runInContext(`state.trades = [{ id: 'd1', intelId: 'opp|X', dir: 'call', stake: 100, expiry: 30, asset: 'EURUSD_otc', openedAt: Date.now(), voters: [] }];`, T.ctx);
  T.deliver({ src: 'POBOT', kind: 'frame', event: 'successcloseOrder', text: JSON.stringify({ deals: [{ id: 'd1', profit: -100, openPrice: 1.08000, closePrice: 1.07995,
    openTimestamp: T0 + 2, openMs: 400, closeTimestamp: T0 + 32, closeMs: 100, command: 0, percentProfit: 92 }] }) });
  const tc = T.portSent.find((m) => m.type === 'tradeClosed');
  assert.ok(tc && tc.po, 'deal forwarded');
  assert.equal(tc.po.openPrice, 1.08);
  assert.ok(Math.abs(tc.po.closeTs - (T0 + 32.1)) < 1e-6);
  // the worker: the market showed 1.08003 at that second (a win), PO settled at 1.07995 (a loss)
  const W = await loadWorker(FAST);
  const tab = W.connectTab(160);
  const rec = { ...makeOpp('EURUSD_otc', T0, 'CALL'), id: 'opp|X', entryPrice: 1.08, exec: { dir: 'CALL', action: 'auto' } };
  await tab.send({ type: 'decision', record: rec, cand: null, poNow: T0 + 1 });
  const s1 = (t, close) => ({ time: t, open: close, high: close, low: close, close });
  await tab.send({ type: 'candles', asset: 'EURUSD_otc', tf: 1, rows: [s1(T0 + 32, 1.08003)] });
  await tab.send({ ...tc });
  const f = (await W.DB.get('records', 'opp|X')).exec.forensics;
  assert.ok(f, 'forensics recorded');
  assert.ok(Math.abs(f.delaySec - 2.4) < 0.01, `delay ${f.delaySec}`);
  assert.ok(f.closeDevBp > 0, `PO settled worse than the market: ${f.closeDevBp} bp`);
  assert.equal(f.poOutcome, 'L');
  assert.equal(f.marketOutcome, 'W');
});

test('worker: a tab running an older version of the extension is flagged for the popup', async () => {
  const W = await loadWorker(FAST);
  const dash = W.connectDash();
  const t1 = W.connectTab(101), t2 = W.connectTab(102);
  await t1.send({ type: 'state', poNow: T0, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'copy', isDemo: true, openTrades: [], assets: [], version: '0.9.5' });
  await t2.send({ type: 'state', poNow: T0, chartAsset: 'GBPUSD_otc', armed: true, running: true, engine: 'copy', isDemo: true, openTrades: [], assets: [], version: null });
  await wait(600);
  const snap = dash.sent.filter((m) => m.type === 'snapshot').pop();
  // the harness has no manifest version, so any reported version differs from it
  assert.equal(snap.tabsInfo.find((t) => t.tabId === 101).stale, true);
  assert.equal(snap.tabsInfo.find((t) => t.tabId === 102).stale, false, 'unknown version is not flagged');
});

test('worker: simultaneous candidates are ranked, the weaker one is skipped by the risk engine', async () => {
  const W = await loadWorker({ intelConfig: { risk: { batchWindowMs: 20, maxConcurrent: 1 } } });
  const a = W.connectTab(1), b = W.connectTab(2);
  const ra = makeRecord('EURUSD_otc', T0 - 300, 'CALL'), rb = makeRecord('GBPJPY_otc', T0 - 300, 'PUT');
  await a.send({ type: 'decision', record: ra, cand: candOf(ra, 72), poNow: T0 + 3 });
  await b.send({ type: 'decision', record: rb, cand: candOf(rb, 90), poNow: T0 + 3 });
  await wait(60);
  const sa = await W.DB.get('records', ra.id), sb = await W.DB.get('records', rb.id);
  assert.equal(sb.exec.action, 'paper');
  assert.equal(sa.decision, 'SKIP');
  assert.equal(sa.engineDecision, 'CALL');
  assert.ok(sa.skipReasons.some((r) => /risk: .*max/i.test(r)), sa.skipReasons.join());
});

test('worker MANUAL: asks, then sends execute to the tab only after confirmation', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'MANUAL', risk: { batchWindowMs: 20 }, entryWindowSec: 30 } });
  const tab = W.connectTab(7), dash = W.connectDash();
  await tab.send({ type: 'hello', isDemo: false, chartAsset: 'EURUSD_otc' }); // the pair is on this tab's chart
  const rec = makeRecord('EURUSD_otc', T0 - 300, 'CALL');
  await tab.send({ type: 'decision', record: rec, cand: candOf(rec), poNow: T0 + 5 }); // 5s into the entry candle
  await wait(60);
  assert.equal((await W.DB.get('records', rec.id)).exec.action, 'awaiting-confirmation');
  assert.ok(W.notifications.length >= 1);
  assert.ok(!tab.sent.some((m) => m.type === 'execute'), 'nothing executed before confirmation');
  await wait(550); // dashboard snapshots are throttled
  const snap = dash.sent.filter((m) => m.type === 'snapshot').pop();
  assert.equal(snap.manual.length, 1);
  await dash.send({ type: 'manualConfirm', id: rec.id });
  const ex = tab.sent.find((m) => m.type === 'execute');
  assert.ok(ex, 'execute sent after confirmation');
  assert.equal(ex.dir, 'CALL');
  assert.equal(ex.expirySec, 300);
  // a second confirmation of the same id does nothing
  await dash.send({ type: 'manualConfirm', id: rec.id });
  assert.equal(tab.sent.filter((m) => m.type === 'execute').length, 1);
});

test('worker AUTO: unpromoted setups stay paper; promoted ones are executed; unconfirmed orders trigger emergency stop', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(3);
  const r1 = makeRecord('EURUSD_otc', T0 - 300, 'CALL');
  await tab.send({ type: 'decision', record: r1, cand: candOf(r1), poNow: T0 + 2 });
  await wait(60);
  assert.equal((await W.DB.get('records', r1.id)).exec.action, 'paper');
  assert.ok(!tab.sent.some((m) => m.type === 'execute'));

  const W2 = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20 }, promotedProfiles: ['trend_following|TRENDING_UP|E1'] } });
  const tab2 = W2.connectTab(4);
  await tab2.send({ type: 'hello', isDemo: false, chartAsset: 'EURUSD_otc' }); // the pair is on this tab's chart
  const r2 = makeRecord('EURUSD_otc', T0 - 300, 'CALL');
  await tab2.send({ type: 'decision', record: r2, cand: candOf(r2), poNow: T0 + 2 });
  await wait(60);
  const ex = tab2.sent.find((m) => m.type === 'execute');
  assert.ok(ex);
  assert.equal(ex.asset, 'EURUSD_otc');
  await tab2.send({ type: 'execResult', id: r2.id, status: 'placed', stake: 50, demo: true });
  assert.equal(W2.store.intelRisk.trades, 1);
  await tab2.send({ type: 'execResult', id: r2.id, status: 'unconfirmed' });
  assert.match(W2.store.intelRisk.emergency, /did not confirm/);
  // with the emergency stop on, the next candidate is blocked
  const r3 = makeRecord('GBPUSD_otc', T0, 'CALL');
  await tab2.send({ type: 'decision', record: r3, cand: candOf(r3), poNow: T0 + 302 });
  await wait(60);
  const s3 = await W2.DB.get('records', r3.id);
  assert.equal(s3.decision, 'SKIP');
  assert.ok(s3.exec.flags.includes('EMERGENCY'));
});

test('worker AUTO on a demo account executes every engine decision; on a real account it stays paper', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const demo = W.connectTab(21);
  await demo.send({ type: 'hello', isDemo: true, chartAsset: 'EURUSD_otc' });
  const r1 = makeRecord('EURUSD_otc', T0 - 300, 'CALL');
  await demo.send({ type: 'decision', record: r1, cand: candOf(r1), poNow: T0 + 2 });
  await wait(60);
  assert.ok(demo.sent.some((m) => m.type === 'execute' && m.asset === 'EURUSD_otc'), 'demo executes');
  const W2 = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const real = W2.connectTab(22);
  await real.send({ type: 'hello', isDemo: false, chartAsset: 'EURUSD_otc' });
  const r2 = makeRecord('EURUSD_otc', T0 - 300, 'CALL');
  await real.send({ type: 'decision', record: r2, cand: candOf(r2), poNow: T0 + 2 });
  await wait(60);
  assert.ok(!real.sent.some((m) => m.type === 'execute'), 'real account: unpromoted stays paper');
  assert.equal((await W2.DB.get('records', r2.id)).exec.action, 'paper');
  // …unless the user chose "all decisions" for real accounts
  const W3 = await loadWorker({ intelConfig: { execMode: 'AUTO', autoRealAll: true, risk: { batchWindowMs: 20 } } });
  const real3 = W3.connectTab(23);
  await real3.send({ type: 'hello', isDemo: false, chartAsset: 'EURUSD_otc' });
  const r3 = makeRecord('EURUSD_otc', T0 - 300, 'CALL');
  await real3.send({ type: 'decision', record: r3, cand: candOf(r3), poNow: T0 + 2 });
  await wait(60);
  assert.ok(real3.sent.some((m) => m.type === 'execute'), 'real account executes when the user allows it');
});

test('worker: real trade results update risk and the profile forward test', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20 }, promotedProfiles: ['trend_following|TRENDING_UP|E1'] } });
  const tab = W.connectTab(5);
  await tab.send({ type: 'hello', isDemo: true, chartAsset: 'EURUSD_otc' });
  const r = makeRecord('EURUSD_otc', T0 - 300, 'CALL');
  await tab.send({ type: 'decision', record: r, cand: candOf(r), poNow: T0 + 2 });
  await wait(60);
  await tab.send({ type: 'execResult', id: r.id, status: 'placed', stake: 50, demo: true });
  await tab.send({ type: 'tradeClosed', id: r.id, result: 'loss', profit: -50, stake: 50 });
  assert.equal(W.store.intelRisk.losses, 1);
  assert.equal(W.store.intelRisk.consecLosses, 1);
  assert.deepEqual(W.store.intelForward['trend_following|TRENDING_UP|E1'], { w: 0, l: 1, t: 0 });
});

test('worker: config changes from the dashboard reach the tabs; history requests are routed to a tab', async () => {
  const W = await loadWorker(FAST);
  const tab = W.connectTab(9), dash = W.connectDash();
  await tab.send({ type: 'state', chartAsset: 'EURUSD_otc', armed: false, isDemo: true, assets: [{ asset: 'EURUSD_otc', scan: { score: 50 } }] });
  await dash.send({ type: 'setConfig', patch: { minDeepConfidence: 80 } });
  const cfgMsg = tab.sent.filter((m) => m.type === 'config').pop();
  assert.equal(cfgMsg.cfg.minDeepConfidence, 80);
  await dash.send({ type: 'fetchHistory', reqId: 'r1', asset: 'AUDCAD_otc', hours: 24 });
  assert.ok(tab.sent.some((m) => m.type === 'fetchHistory' && m.asset === 'AUDCAD_otc'));
  const snap = dash.sent.filter((m) => m.type === 'snapshot').pop();
  assert.equal(snap.pairs[0].asset, 'EURUSD_otc');
});

// ── content-script harness ───────────────────────────────────────────────────
function loadTab(store = {}) { // store: what chrome.storage.local holds when the scripts load
  const winListeners = [], posted = [], portSent = [];
  const portOnMessage = listeners();
  const window = {
    addEventListener: (t, f) => { if (t === 'message') winListeners.push(f); },
    postMessage: (data) => posted.push(data),
  };
  const document = { readyState: 'loading', addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [], dispatchEvent: () => {}, body: null };
  const chrome = {
    storage: { local: { get: (k, cb) => cb && cb(store), set: () => {} } },
    // the worker side of chart memory: store.__memory = { 'ASSET|tf': [candles] }
    runtime: { id: 'x', connect: () => ({ onMessage: portOnMessage, onDisconnect: listeners(), postMessage: (m) => {
      portSent.push(plain(m));
      if (m.type === 'memory') Promise.resolve().then(() => portOnMessage.fire({ type: 'memory', reqId: m.reqId,
        rows: (store.__memory?.[`${m.asset}|${m.tf}`] || []).filter((c) => c.time >= m.from && c.time <= m.to) }));
      // the worker side of live similarity: store.__predict(state) → prediction
      if (m.type === 'histPredict') Promise.resolve().then(() => portOnMessage.fire({ type: 'histPredict', reqId: m.reqId, prediction: store.__predict ? store.__predict(m.state) : null }));
    } }), sendMessage: () => {} },
  };
  // a timer longer than a minute in a test means something waits on real time — show where
  const st = (f, ms, ...rest) => { if (process.env.SHOW && ms > 60000) console.log('SHOW long timer', ms, new Error().stack.split('\n').slice(2, 4).join(' | ')); const t = setTimeout(f, ms, ...rest); t.unref?.(); return t; }; // the tab's own timers never keep a test alive
  const session = new Map(Object.entries(store.__session || {}));
  const sessionStorage = { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)), removeItem: (k) => session.delete(k) };
  const ctx = vm.createContext({ console, setTimeout: st, clearTimeout, setInterval: () => 0, Date, Math, JSON, Map, Set, Promise, window, document, chrome, sessionStorage,
    location: { pathname: '/en/cabinet/demo-quick-high-low/' }, getComputedStyle: () => ({}), HTMLInputElement: function () {}, KeyboardEvent: function () {}, Event: function () {},
    performance, MessageChannel: class { constructor() { const p1 = { onmessage: null }; this.port1 = p1; this.port2 = { postMessage: () => setImmediate(() => p1.onmessage?.()) }; } } });
  ctx.globalThis = ctx;
  const manifest = JSON.parse(read('manifest.json'));
  for (const f of manifest.content_scripts[1].js) vm.runInContext(read(f), ctx, { filename: f });
  const deliver = (data) => winListeners.forEach((f) => f({ source: window, data }));
  return { ctx, posted, portSent, deliver, toTab: (m) => portOnMessage.fire(m), session };
}

// Replays two pairs live (history from one 1M price path, ticks walking each 1M candle).
// Minute frames only: this path is 1M data (seconds frames have their own test with 5s history).
// lag: PO's 1M history ends this many seconds before "now" (seen live: a minute or two).
async function liveRun(T, N_LIVE = 26, { lag = 0, cfg = {} } = {}) {
  const { OTC } = require('./load.js').load(['engine/core.js']);
  T.toTab({ type: 'config', cfg: { setupFrames: [60, 300, 900], maxTradeSec: null, ...cfg } });
  // PO's asset list: EURUSD pays 92% (tradable), GBPUSD 70% (below the default 80% payout gate)
  vm.runInContext(`state.assets = [{ symbol: 'EURUSD_otc', payout: 92, active: true }, { symbol: 'GBPUSD_otc', payout: 70, active: true }];`, T.ctx);
  // One continuous 1M price path per pair: history serves its past (any frame is aggregated from it), ticks replay its future.
  const N_PAST = 400 * 5;
  const path1 = {
    EURUSD_otc: makeCandles({ start: T0 - 60 * N_PAST, tf: 60, segments: [{ n: N_PAST + N_LIVE, drift: 0.3, vol: 0.0002 }], seed: 1 }),
    GBPUSD_otc: makeCandles({ start: T0 - 60 * N_PAST, tf: 60, price: 1.27, segments: [{ n: N_PAST + N_LIVE, drift: -0.3, vol: 0.00025 }], seed: 2 }),
  };
  let now = T0;
  const answer = async () => {
    while (T.posted.length) {
      const m = T.posted.shift();
      if (m.src !== 'POBOT_CMD' || m.kind !== 'loadHistory') continue;
      const base = path1[m.asset] || [];
      const rows = m.period === 60 ? base : m.period === 5 ? [] : OTC.U.aggregate(base, 60, m.period);
      // like PO: only candles that have closed by "now", the newest `offset` seconds before `time`
      const data = rows.filter((c) => c.time + m.period <= now - (m.period === 60 ? lag : 0) && c.time < m.time && c.time >= m.time - m.offset);
      await tick();
      T.deliver({ src: 'POBOT', kind: 'frame', event: 'loadHistoryPeriodFast', text: JSON.stringify({ asset: m.asset, period: m.period, data }) });
    }
  };
  // Ticks every 2s walking open → high → low → close inside each live 1M candle.
  const priceAt = (c, f) => (f < 1 / 3 ? c.open + (c.high - c.open) * f * 3 : f < 2 / 3 ? c.high + (c.low - c.high) * (f - 1 / 3) * 3 : c.low + (c.close - c.low) * (f - 2 / 3) * 3);
  for (let ts = T0 + 10; ts < T0 + 60 * (N_LIVE - 1) + 20; ts += 2) {
    now = ts;
    const frame = Object.entries(path1).map(([a, cs]) => {
      const c = cs.find((x) => x.time === Math.floor(ts / 60) * 60);
      const f = (ts - c.time) / 60;
      return [a, ts, +(f >= 0.96 ? c.close : priceAt(c, f)).toFixed(6)];
    });
    T.deliver({ src: 'POBOT', kind: 'frame', event: 'updateStream', text: JSON.stringify(frame) });
    if (ts % 10 === 0) { await answer(); await tick(); }
  }
  for (let i = 0; i < 20; i++) { await answer(); await tick(); }

}

test('content scripts: multi-pair ticks → feeds, history by timeframe, every setup frame analysed, opportunities reported', async () => {
  const T = loadTab();
  const { OTC } = require('./load.js').load(['engine/core.js']);
  await liveRun(T);
  const IT = T.ctx.globalThis.IntelTab;
  assert.ok(IT.feeds.has('EURUSD_otc') && IT.feeds.has('GBPUSD_otc'), 'one feed per pair');
  const eur = IT.feeds.get('EURUSD_otc').feed;
  assert.ok(eur.series[60].closed().length >= 200, `1M candles: ${eur.series[60].closed().length}`);
  assert.ok(eur.series[300].closed().length >= 150, `5M candles: ${eur.series[300].closed().length}`);
  assert.ok(eur.series[900].map.size >= 100, `15M candles: ${eur.series[900].map.size}`);
  assert.ok(eur.series[3600].map.size >= 25, `1H candles: ${eur.series[3600].map.size}`);
  // the partial first candle was repaired from history: no gaps
  for (const tf of [60, 300]) {
    const c = eur.series[tf].closed();
    assert.ok(c.every((x, i) => !i || x.time - c[i - 1].time === tf), `no ${tf}s gaps`);
    assert.equal(eur.series[tf].mismatches, 0, `live ${tf}s candles agree with PO history`);
  }
  // frame replies must not land in the legacy 5-second history store
  const legacy = vm.runInContext('state.hist.EURUSD_otc', T.ctx);
  assert.ok(!legacy || legacy.size === 0);

  const decisions = T.portSent.filter((m) => m.type === 'decision');
  const setups = decisions.filter((d) => d.record.kind === 'setup'), opps = decisions.filter((d) => d.record.kind === 'opp');
  if (process.env.SHOW) for (const d of decisions) console.log('SHOW', d.record.kind, d.record.asset, d.record.tf, d.record.frame ?? '', time5(d.record.candleTime), d.record.decision, d.record.lean, d.record.state ?? '', d.record.skipReasons.join(' / '));
  assert.equal(new Set(setups.map((d) => d.record.asset)).size, 2, 'both pairs analysed');
  for (const tf of [60, 300, 900]) assert.ok(setups.some((d) => d.record.tf === tf), `setup frame ${tf} analysed`);
  assert.ok(setups.filter((d) => d.record.tf === 60).length >= 30, 'every 1M close of both pairs');
  for (const d of setups) {
    assert.ok(['CALL', 'PUT', 'SKIP'].includes(d.record.decision));
    assert.equal(d.record.source, 'live');
    assert.equal(d.cand, null, 'setup records are research only; trades come from opportunities');
    assert.equal(d.record.id, `live|${d.record.asset}|${d.record.tf}|${d.record.candleTime}`);
    // consistent data → no data-quality reason to skip
    assert.ok(!d.record.skipReasons.some((r) => /missing|far from chart|stale|timeframe|duplicat/i.test(r)), JSON.stringify(d.record.skipReasons));
    // every analysis: what each strategy said, and the consensus; a decision only when the families agree
    assert.ok(d.record.cons && d.record.cons.t >= 70, 'every strategy answered');
    if (d.record.decision !== 'SKIP') { assert.equal(d.record.cons.s, 'AGREE'); assert.equal(d.record.cons.dir, d.record.decision); assert.ok(d.record.cons.ff >= 3 && d.record.cons.fa === 0); }
    assert.ok(!d.record.skipReasons.some((r) => /^confidence \d+ </.test(r)), 'no fixed confidence threshold');
  }
  for (const d of opps) {
    const r = d.record;
    assert.equal(r.tf, 1, 'opportunity outcomes are keyed by seconds');
    assert.ok([60, 300, 900].includes(r.frame));
    assert.ok(r.horizons.every((h) => h >= 60), 'minute-frame entries: minute horizons');
    assert.equal(r.ts % 60, 0, 'entries and lean records sit on minute closes');
    assert.ok(['ENTERED', 'GATED', 'MISSED_ENTRY', 'INVALIDATED', 'EXPIRED'].includes(r.state), r.state);
    if (r.asset === 'GBPUSD_otc') {
      // pays 70% < 80%: never an entry, but measured like one
      assert.equal(r.decision, 'SKIP');
      assert.equal(d.cand, null);
      if (r.state === 'GATED') assert.ok(r.cal.blocks.includes('payout') && r.cal.payout === 70, JSON.stringify(r.cal));
    }
    assert.equal(r.cons?.dir, r.lean, 'the opportunity carries the consensus that made it');
    // pays 92% but nothing measured yet: INSUFFICIENT_DATA is NO TRADE (logged and measured, never placed)
    assert.notEqual(r.state, 'ENTERED');
    if (r.asset === 'EURUSD_otc' && r.state === 'GATED') assert.ok(r.cal.blocks.includes('insufficient_data'), JSON.stringify(r.cal.blocks));
    if (r.state === 'GATED' || r.state === 'ENTERED') assert.ok(OTC.DEFAULT_CONFIG.expiryChoices.includes(r.expirySec), 'every entry gets a duration, so its outcome is measured');
  }
  assert.ok(opps.some((d) => d.record.state === 'GATED' || d.record.state === 'ENTERED'), 'some opportunities reached their entry moment');
  const st = T.portSent.filter((m) => m.type === 'state' && m.assets.length === 2).pop();
  assert.ok(st, 'state for both pairs');
  for (const a of st.assets) assert.ok(a.frames && Object.keys(a.frames).length >= 2, 'per-frame view');
  assert.ok(T.portSent.some((m) => m.type === 'candles' && m.asset === 'GBPUSD_otc' && m.tf === 60));
});

test('content scripts: with "try unproven opportunities on demo" on, they are entered (never measured, so never on a real account)', async () => {
  const T = loadTab();
  await liveRun(T, 26, { cfg: { gate: { requireHistory: false } } });
  const opps = T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'opp');
  const entered = opps.filter((d) => d.record.state === 'ENTERED');
  assert.ok(entered.length, 'some entries');
  for (const d of entered) {
    const r = d.record;
    assert.equal(r.asset, 'EURUSD_otc', 'the 70% pair never');
    assert.ok(d.cand && d.cand.kind === 'opp' && d.cand.entryTime === r.ts && d.cand.payout === 92);
    assert.ok(d.cand.cal.qualified && !d.cand.cal.measured, JSON.stringify(d.cand.cal));
    assert.equal(r.expirySec, d.cand.expirySec);
    assert.equal(r.cons.s, 'AGREE');
  }
});

test('content scripts: when PO history lags behind live candles, the gap is refilled instead of blocking the frame for 30 candles', async () => {
  const T = loadTab();
  await liveRun(T, 26, { lag: 150 });
  const m1 = T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'setup' && m.record.tf === 60 && m.record.asset === 'EURUSD_otc')
    .sort((a, b) => a.record.ts - b.record.ts);
  const gap = (d) => d.record.skipReasons.some((r) => /missing candle/.test(r));
  if (process.env.SHOW) console.log('SHOW', m1.map((d) => (gap(d) ? 'G' : '.')).join(''));
  assert.ok(m1.length >= 20, `1M analyses: ${m1.length}`);
  // the first minutes may still see the hole (PO hasn't published those candles yet); after that, never
  assert.ok(m1.slice(5).every((d) => !gap(d)), m1.map((d) => (gap(d) ? 'G' : '.')).join(''));
});

test('content scripts: a pair whose chart comes and goes keeps gap-free candles once it is back', async () => {
  const T = loadTab();
  const { OTC } = require('./load.js').load(['engine/core.js']);
  T.toTab({ type: 'config', cfg: { setupFrames: [5, 60, 300] } });
  vm.runInContext(`state.assets = [{ symbol: 'EURUSD_otc', payout: 92, active: true }, { symbol: 'AUDCAD_otc', payout: 92, active: true }];`, T.ctx);
  const N_PAST = 2400, N_LIVE = 22 * 12; // 5s candles: 3h20 of history, 22 live minutes
  const paths = {
    EURUSD_otc: makeCandles({ start: T0 - 5 * N_PAST, tf: 5, segments: [{ n: N_PAST + N_LIVE, drift: 0.1, vol: 0.00005 }], seed: 31 }),
    AUDCAD_otc: makeCandles({ start: T0 - 5 * N_PAST, tf: 5, price: 0.91, segments: [{ n: N_PAST + N_LIVE, drift: -0.1, vol: 0.00005 }], seed: 32 }),
  };
  let now = T0;
  const LAG = 90; // PO's history ends this far behind live (as seen on real data)
  const answer = async () => {
    while (T.posted.length) {
      const m = T.posted.shift();
      if (m.src !== 'POBOT_CMD' || m.kind !== 'loadHistory') continue;
      const rows = m.period === 5 ? paths[m.asset] : OTC.U.aggregate(paths[m.asset], 5, m.period);
      const data = rows.filter((c) => c.time + m.period <= now - LAG && c.time < m.time && c.time >= m.time - m.offset);
      await tick();
      T.deliver({ src: 'POBOT', kind: 'frame', event: 'loadHistoryPeriodFast', text: JSON.stringify({ asset: m.asset, period: m.period, data }) });
    }
  };
  // AUDCAD is on a chart in minutes 0–4 and 9–21, gone in 5–8 (the chart showed another pair)
  const onChart = (asset, ts) => asset === 'EURUSD_otc' || !((ts - T0) >= 5 * 60 && (ts - T0) < 9 * 60);
  for (let ts = T0; ts < T0 + 5 * N_LIVE; ts++) {
    now = ts;
    const frame = Object.entries(paths).filter(([a]) => onChart(a, ts)).map(([a, cs]) => {
      const c = cs.find((x) => x.time === Math.floor(ts / 5) * 5), k = ts - c.time;
      return [a, ts, [c.open, c.high, c.low, c.close, c.close][k]];
    });
    T.deliver({ src: 'POBOT', kind: 'frame', event: 'updateStream', text: JSON.stringify(frame) });
    if (ts % 5 === 0) { await answer(); await tick(); }
  }
  for (let i = 0; i < 20; i++) { await answer(); await tick(); }
  const recs = T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'setup' && m.record.asset === 'AUDCAD_otc' && m.record.tf === 60);
  const gap = (d) => d.record.skipReasons.some((r) => /missing candle/.test(r));
  if (process.env.SHOW) console.log('SHOW', recs.map((d) => `${(d.record.ts - T0) / 60}${gap(d) ? 'G' : '.'}`).join(' '));
  if (process.env.SHOW) console.log('SHOW gaps', JSON.stringify(recs.filter(gap).map((d) => d.record.skipReasons.filter((r) => /missing/.test(r)))));
  const late = recs.filter((d) => d.record.ts >= T0 + 13 * 60);
  assert.ok(late.length >= 5);
  assert.ok(late.every((d) => !gap(d)), 'four minutes after the chart is back, no 1M gaps');
  // the first ticks after the pause close a minutes-old candle: not analysed as if it were fresh ("last candle closed long ago")
  const stale = T.portSent.filter((m) => m.type === 'decision' && m.record.asset === 'AUDCAD_otc' && m.record.skipReasons?.some((r) => /candle closed \d+s ago/.test(r)));
  assert.equal(stale.length, 0, stale.map((m) => `${m.record.tf}: ${m.record.skipReasons.join(' / ')}`).join(' | '));
});

// every frame / kind / direction / regime cohort with the same outcome counts, at every duration
const cohortTable = (OTC, cell) => {
  const kinds = ['pullback', 'retest', 'breakout', 'reversal', 'range', 'momentum', 'pattern', 'trend', 'discovered'], entries = {};
  for (const fr of [60, 300, 900]) for (const k of kinds) for (const dir of ['CALL', 'PUT']) for (const rg of OTC.REGIMES) {
    entries[`${fr}|k:${k}|${dir}|${rg}`] = Object.fromEntries(OTC.DEFAULT_CONFIG.expiryChoices.map((sec) => [sec, cell]));
  }
  return entries;
};

test('content scripts: the engine learns direction — a kind of opportunity that keeps losing (38%, older part and newer, every period) is traded the other way', async () => {
  // seen on real data: on 1M, agreement among the strategy families reversed for hours (it continued on other days)
  const T = loadTab();
  const { OTC } = require('./load.js').load(['engine/core.js']);
  const entries = cohortTable(OTC, { sel: [76, 124], oos: [53, 87], folds: [[60, 100], [60, 100], [60, 100]], n: 340 });
  T.toTab({ type: 'config', cfg: {}, calTables: { entries, setups: {}, frames: {} }, calStatus: { status: 'COLLECTING' } });
  await liveRun(T);
  const entered = T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'opp' && m.record.state === 'ENTERED');
  assert.ok(entered.length, 'entries taken');
  for (const d of entered) {
    const r = d.record;
    assert.equal(r.fade, true);
    assert.equal(r.decision, OTC.U.opp(r.lean), 'traded against the setup');
    assert.equal(d.cand.dir, r.decision);
    assert.equal(d.cand.fade, true);
    assert.ok(r.cal.reversed && r.cal.measured && r.cal.ev > 0 && r.cal.winProb > 55, JSON.stringify(r.cal));
    assert.equal(r.asset, 'EURUSD_otc', 'payout still decides (GBPUSD pays 70%)');
  }
  // the screen says it is a reversal, with the trade's direction
  const { AR } = require('./load.js').load();
  const st = T.portSent.filter((m) => m.type === 'state').pop();
  const fadeView = st.assets.map((a) => a.opp).find((o) => o?.fade);
  if (fadeView) assert.match(AR.decision({ opp: fadeView }, fadeView.entry?.time ?? 0).rows.map((r) => r.join(':')).join(' | '), /عكس/);
});

test('content scripts: measured evidence of no edge, or a rejected model, blocks entries even at 92% payout', async () => {
  const T = loadTab();
  const { OTC } = require('./load.js').load(['engine/core.js']);
  // a cohort table saying every frame/kind/direction/regime is a coin flip (50% out-of-sample): no edge either way
  const entries = cohortTable(OTC, { sel: [100, 100], oos: [70, 70], folds: [[80, 80], [80, 80], [80, 80]], n: 340 });
  T.toTab({ type: 'config', cfg: {}, calTables: { entries, setups: {}, frames: {} }, calStatus: { status: 'COLLECTING' } });
  await liveRun(T);
  const opps = T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'opp');
  assert.ok(opps.every((d) => d.record.decision === 'SKIP' && d.cand == null));
  const eur = opps.filter((d) => d.record.asset === 'EURUSD_otc' && d.record.state === 'GATED');
  assert.ok(eur.length, 'EURUSD reached entry moments');
  for (const d of eur) {
    assert.ok(d.record.cal.measured && d.record.cal.ev <= 0 && d.record.cal.winProb < 52 && d.record.cal.blocks.includes('no_edge'), JSON.stringify(d.record.cal));
    assert.equal(d.record.cal.status, 'MEASURED');
    assert.ok(!d.record.cal.blocks.includes('payout'));
  }
  // a rejected model stops every entry, whatever the tables say
  const T2 = loadTab();
  T2.toTab({ type: 'config', cfg: {}, calTables: null, calStatus: { status: 'REJECTED' } });
  await liveRun(T2);
  const opps2 = T2.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'opp');
  assert.ok(opps2.every((d) => d.record.decision === 'SKIP'));
  assert.ok(opps2.some((d) => d.record.cal?.blocks?.includes('model_rejected')));
});

// One pair live on a chart: 5s history behind it, a tick every second walking each 5s candle.
async function secondsRun(cfg, N_LIVE = +(process.env.N_LIVE || 96), { lag = 0, memory = 0, predict = null } = {}) { // lag: PO's history ends this far behind now; memory: seconds of 5s candles the worker remembers before T0
  const store = { __predict: predict };
  const T = loadTab(store);
  const { OTC } = require('./load.js').load(['engine/core.js']);
  const N_PAST = 2400; // 3h20m of 5s history (enough for 5M context); 96 live candles = 8 minutes
  const path = makeCandles({ start: T0 - 5 * N_PAST, tf: 5, segments: [{ n: N_PAST + N_LIVE, drift: 0.25, vol: 0.00006 }], seed: 11 });
  if (memory) store.__memory = { 'EURUSD_otc|5': path.filter((c) => c.time >= T0 - memory && c.time < T0) };
  vm.runInContext(`state.assets = [{ symbol: 'EURUSD_otc', payout: 92, active: true }];`, T.ctx);
  T.toTab({ type: 'config', cfg });
  let now = T0;
  const answer = async () => {
    while (T.posted.length) {
      const m = T.posted.shift();
      if (m.src !== 'POBOT_CMD' || m.kind !== 'loadHistory') continue;
      const rows = m.period === 5 ? path : OTC.U.aggregate(path, 5, m.period);
      const data = rows.filter((c) => c.time + m.period <= now - lag && c.time < m.time && c.time >= m.time - m.offset);
      await tick();
      T.deliver({ src: 'POBOT', kind: 'frame', event: 'loadHistoryPeriodFast', text: JSON.stringify({ asset: m.asset, period: m.period, data }) });
    }
  };
  // a tick every second walking open → high → low → close inside each 5s candle
  const reqs = {};
  const origPush = T.posted.push.bind(T.posted);
  T.posted.push = (m) => { if (m.kind === 'loadHistory') reqs[m.period] = (reqs[m.period] || 0) + 1; return origPush(m); };
  for (let ts = T0; ts < T0 + 5 * N_LIVE; ts++) {
    now = ts;
    const c = path.find((x) => x.time === Math.floor(ts / 5) * 5), k = ts - c.time;
    const price = [c.open, c.high, c.low, c.close, c.close][k];
    T.deliver({ src: 'POBOT', kind: 'frame', event: 'updateStream', text: JSON.stringify([['EURUSD_otc', ts, price]]) });
    if (ts % 5 === 0) { await answer(); await tick(); }
  }
  for (let i = 0; i < 20; i++) { await answer(); await tick(); }
  if (process.env.SHOW) console.log('SHOW requests', JSON.stringify(reqs), 'queued', vm.runInContext('historyQueue.length', T.ctx));
  return { T, path, N_LIVE, now };
}

test('content scripts: seconds frames (5s/10s/15s/30s) seeded from 5s history and driven by live ticks', async () => {
  const { T, N_LIVE } = await secondsRun({ setupFrames: [5, 10, 15, 30] });
  const IT = T.ctx.globalThis.IntelTab;
  const F = IT.feeds.get('EURUSD_otc');
  assert.ok(F.feed.series[5].closed().length >= 600, `5s candles: ${F.feed.series[5].closed().length}`);
  assert.ok(F.feed.series[30].closed().length >= 60, `30s candles: ${F.feed.series[30].closed().length}`);
  const c5 = F.feed.series[5].closed();
  assert.ok(c5.every((c, i) => !i || c.time - c5[i - 1].time === 5), 'no 5s gaps between history and live');
  for (const tf of [5, 10, 15, 30]) {
    const L = F.frames[tf]?.last;
    assert.ok(L, `frame ${tf}s analysed`);
    assert.ok(!L.skipReasons.some((r) => /missing|stale|candles|timeframe|duplicat|frozen/i.test(r)), `${tf}s: ${L.skipReasons.join(' / ')}`);
  }
  const st = T.portSent.filter((m) => m.type === 'state').pop();
  assert.deepEqual(Object.keys(st.assets[0].frames).map(Number).sort((a, b) => a - b), [5, 10, 15, 30]);
  assert.ok(T.portSent.filter((m) => m.type === 'candles' && m.tf === 5).length >= N_LIVE - 5, '5s closes go to the worker for outcomes');
  // seconds-frame records are only the decisions and strong scans, and slim
  const recs = T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'setup');
  assert.ok(recs.every((d) => d.record.tf < 60 && (d.record.decision !== 'SKIP' || d.record.scanner.status === 'DEEP') && !d.record.snapshot));
  const opps = T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'opp');
  if (process.env.SHOW) console.log('SHOW', recs.length, 'records', opps.map((d) => `${d.record.frame}s ${d.record.state} ${d.record.expirySec ?? ''}`).join(', '));
  for (const d of opps) {
    const r = d.record;
    assert.equal(r.tf, 1);
    assert.ok(r.frame < 60);
    assert.ok(r.horizons.includes(5) && r.horizons.includes(1800), 'seconds entries are measured from 5s on');
    assert.equal(r.ts % 5, 0);
    if (r.expirySec) assert.ok(r.expirySec < 60 || r.frame >= 30, `${r.frame}s frame → ${r.expirySec}s`);
  }
});

test('content scripts: 3-second trades are read from the 5s frame, and measured from 1-second closes', async () => {
  // the user: "read from 5 seconds even when the trade lasts 3 seconds"
  const { T, path } = await secondsRun({ setupFrames: [5, 10, 15, 30, 60], maxTradeSec: 3 }, 60);
  const st = T.portSent.filter((m) => m.type === 'state').pop();
  assert.deepEqual(Object.keys(st.assets[0].frames).map(Number), [5], 'the 5s frame stays (shorter than 5s there is none); longer ones are off');
  // 1-second closes: every second, at the last price of that second (the test ticks open → high → low → close → close)
  const rows = T.portSent.filter((m) => m.type === 'candles' && m.tf === 1).flatMap((m) => m.rows);
  assert.ok(rows.length >= 260, `1s closes: ${rows.length}`); // from the moment the flow counts as live (20s)
  assert.ok(rows.every((c, i) => !i || c.time - rows[i - 1].time === 1), 'one close per second, none missing, none twice');
  for (const c of rows.slice(-40)) {
    const k = path.find((x) => x.time === Math.floor(c.time / 5) * 5);
    assert.equal(c.close, [k.open, k.high, k.low, k.close, k.close][c.time - k.time]);
  }
  const opps = T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'opp').map((d) => d.record);
  if (process.env.SHOW) console.log('SHOW', opps.map((r) => `${r.frame}s ${r.state} ${r.expirySec ?? ''}`).join(', '));
  for (const r of opps) {
    assert.equal(r.frame, 5);
    assert.ok(r.horizons.includes(3), '3s outcome recorded');
    if (r.expirySec) assert.equal(r.expirySec, 3, 'never longer than the maximum');
  }
});

test('content scripts: PO\'s 5s history ending 3 minutes before live candles leaves a hole that is fetched, not a pair stuck as unreadable', async () => {
  // seen on real data (v0.11, maximum duration 3s → the 5s frame only): every pair "تعذر قراءة البيانات", with
  // "5S 35 missing candle(s)" and "30S 6 missing candle(s)" minutes after a reload
  const { T } = await secondsRun({ setupFrames: [5, 10, 15, 30, 60], maxTradeSec: 3 }, 72, { lag: 180 });
  const IT = T.ctx.globalThis.IntelTab, F = IT.feeds.get('EURUSD_otc');
  const holes = (tf, n) => { const c = F.feed.series[tf].closed(n); return c.filter((x, i) => i && x.time - c[i - 1].time > tf).length; };
  assert.equal(holes(5, 72), 0, 'the 3-minute hole in 5s candles was filled once PO had it');
  assert.equal(holes(30, 12), 0, 'and the 30s context');
  const pv = IT.pairView('EURUSD_otc');
  assert.equal(pv.feed.dqOk, true, JSON.stringify(pv.dq?.issues));
  // what the user saw while it was filling: a temporary state with its reason, not a bare error
  const { AR } = require('./load.js').load();
  const st = AR.pairStatus({ feed: { dqOk: false, dqCodes: ['MISSING_RECENT'] } }, 0);
  assert.equal(st.label, 'جاري استكمال البيانات');
  const d = AR.decision({ feed: { dqOk: false, dqCodes: ['MISSING_RECENT'] } }, 0);
  assert.match(d.rows.find((r) => r[0] === 'السبب')[1], /شموع ناقصة/);
});

test('content scripts: chart memory — after a reload the minutes PO\'s history lacks come from what the worker kept', async () => {
  const run = (memory) => secondsRun({ setupFrames: [5, 10, 15, 30, 60], maxTradeSec: 3 }, 12, { lag: 180, memory });
  const holes = (T) => { const F = T.ctx.globalThis.IntelTab.feeds.get('EURUSD_otc'), c = F.feed.series[5].closed(60); return c.filter((x, i) => i && x.time - c[i - 1].time > 5).length; };
  const withMem = await run(300), without = await run(0);
  assert.equal(holes(withMem.T), 0, 'one minute after the reload: no hole');
  assert.equal(withMem.T.ctx.globalThis.IntelTab.pairView('EURUSD_otc').feed.dqOk, true);
  assert.ok(holes(without.T) > 0, 'without memory PO\'s 3-minute lag leaves the hole (control)');
  assert.ok(withMem.T.portSent.some((m) => m.type === 'memory' && m.tf === 5), 'asked the worker first');
});

test('content scripts: the collector (scan leader) pulls PO\'s history in the background — best-paying pairs first, page by page back in time', async () => {
  const T = loadTab();
  const { OTC } = require('./load.js').load(['engine/core.js']);
  T.toTab({ type: 'config', cfg: { setupFrames: [60], maxTradeSec: null, collector: { on: true, maxPairs: 2, hours: 1, hours1m: 1, everyMs: 0 }, scanner: { enabled: false } } });
  T.toTab({ type: 'scanRole', leader: true, exclude: [] });
  vm.runInContext(`state.assets = [{ symbol: 'LOW_otc', payout: 60, active: true }, { symbol: 'TOP_otc', payout: 92, active: true }, { symbol: 'MID_otc', payout: 85, active: true }];`, T.ctx);
  const path = makeCandles({ start: T0 - 5 * 3000, tf: 5, segments: [{ n: 3200, drift: 0, vol: 0.00005 }], seed: 5 });
  const reqs = [];
  let now = T0;
  const answer = async () => {
    while (T.posted.length) {
      const m = T.posted.shift();
      if (m.src !== 'POBOT_CMD' || m.kind !== 'loadHistory') continue;
      reqs.push({ asset: m.asset, period: m.period, time: m.time, offset: m.offset });
      const rows = m.period === 5 ? path : OTC.U.aggregate(path, 5, m.period);
      const data = rows.filter((c) => c.time + m.period <= now && c.time < m.time && c.time >= m.time - m.offset);
      await tick();
      T.deliver({ src: 'POBOT', kind: 'frame', event: 'loadHistoryPeriodFast', text: JSON.stringify({ asset: m.asset, period: m.period, data }) });
    }
  };
  for (let ts = T0; ts < T0 + 240; ts++) {
    now = ts;
    T.deliver({ src: 'POBOT', kind: 'frame', event: 'updateStream', text: JSON.stringify([['EURUSD_otc', ts, 1.08 + (ts % 7) * 1e-5]]) });
    await answer(); await tick();
  }
  const coll = reqs.filter((r) => r.asset !== 'EURUSD_otc');
  assert.ok(coll.length >= 6, `pages pulled: ${coll.length}`);
  assert.deepEqual([...new Set(coll.map((r) => r.asset))].slice(0, 2), ['TOP_otc', 'MID_otc'], 'highest payout first; LOW_otc (3rd) is beyond maxPairs');
  assert.ok(!coll.some((r) => r.asset === 'LOW_otc'));
  const top5 = coll.filter((r) => r.asset === 'TOP_otc' && r.period === 5);
  assert.ok(top5.length >= 3 && top5.every((r, i) => !i || r.time < top5[i - 1].time), 'backwards in time, page by page');
  assert.ok(T.portSent.filter((m) => m.type === 'hist' && m.asset === 'TOP_otc').length >= 3, '5s pages go to the research dataset');
  assert.ok(T.portSent.some((m) => m.type === 'candles' && m.tf === 60 && m.asset === 'TOP_otc'), '1M pages too');
});

test('worker: the research dataset stores 5s candles one row per pair-hour, merging pages', async () => {
  const W = await loadWorker(FAST);
  const tab = W.connectTab(130);
  const c = (t, p) => ({ time: t, open: p, high: p, low: p, close: p });
  const h0 = T0 - (T0 % 3600);
  await tab.send({ type: 'hist', asset: 'TOP_otc', rows: [c(h0, 1), c(h0 + 5, 1.1), c(h0 + 3600, 2)] });
  await tab.send({ type: 'hist', asset: 'TOP_otc', rows: [c(h0 + 10, 1.2), c(h0 + 5, 1.15)] });
  const ch = await W.DB.get('hist5', ['TOP_otc', h0]);
  assert.deepEqual([...ch.t], [h0, h0 + 5, h0 + 10]);
  assert.equal(ch.c[1], 1.15, 'a later page overrides the same candle');
  assert.ok(await W.DB.get('hist5', ['TOP_otc', h0 + 3600]), 'next hour, its own row');
});

test('content scripts: live history — a strength the walk-forward test proved becomes an entry at its duration; one it did not prove never does', async () => {
  const cell = (significant) => ({ n: 800, hits: 520, rate: 65, lo: 62, significant, folds: [[200, 130], [200, 130], [200, 130], [200, 130]] });
  const prediction = (significant) => (st) => ({ status: 'OK', neighbours: 50, model: { id: 'rm-test' }, patterns: [],
    horizons: [{ sec: 30, dir: 'CALL', up: 36, down: 14, n: 50, p: 72, bucket: '65–100%', meanMove: 0.4, tested: cell(significant) },
      { sec: 15, dir: 'PUT', up: 24, down: 26, n: 50, p: 52, bucket: '50–55%', meanMove: 0, tested: { n: 900, hits: 450, rate: 50, lo: 47, significant: false, folds: [] } }] });
  const proven = await secondsRun({ setupFrames: [5, 10, 15, 30, 60], maxTradeSec: null }, 30, { predict: prediction(true) });
  const hist = proven.T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'opp' && m.record.origin === 'history');
  assert.ok(hist.length, 'entries from history');
  for (const d of hist) {
    assert.equal(d.record.state, 'ENTERED');
    assert.equal(d.record.expirySec, 30, 'the duration that was tested');
    assert.equal(d.cand.dir, 'CALL');
    assert.ok(d.record.cal.measured && d.record.cal.ev > 0 && d.record.cal.stable, JSON.stringify(d.record.cal));
    assert.equal(d.record.hist.tested.rate, 65);
  }
  const ids = hist.map((d) => d.record.id);
  assert.equal(new Set(ids).size, ids.length, 'one entry per candle');
  // the same neighbours (72% up) without a proven strength: nothing
  const unproven = await secondsRun({ setupFrames: [5, 10, 15, 30, 60], maxTradeSec: null }, 30, { predict: prediction(false) });
  assert.equal(unproven.T.portSent.filter((m) => m.type === 'decision' && m.record.origin === 'history').length, 0);
  // the screen shows it either way, with what the test said
  const st = unproven.T.portSent.filter((m) => m.type === 'state').pop();
  const { AR } = require('./load.js').load();
  assert.match(AR.histText(st.assets[0].hist.best), /لم يثبت في الاختبار/);
});

test('content scripts: occasional prices for a pair do not make it live; a steady flow does', async () => {
  const T = loadTab();
  const IT = T.ctx.globalThis.IntelTab;
  const send = (asset, ts, price) => T.deliver({ src: 'POBOT', kind: 'frame', event: 'updateStream', text: JSON.stringify([[asset, ts, price]]) });
  // a price every 30s, as PO sends for pairs nobody has on a chart
  for (let k = 0; k < 10; k++) send('AEDCNY_otc', T0 + 30 * k, 3.67);
  await tick();
  const F = IT.feeds.get('AEDCNY_otc');
  assert.ok(F.polled, 'still a scanner pair');
  assert.equal(F.feed.lastTick, null, 'occasional prices are not turned into candles');
  assert.ok(!T.posted.some((m) => m.kind === 'loadHistory' && m.asset === 'AEDCNY_otc'), 'no seeding for it in a tab that is not the scan leader');
  // a burst (10 prices in 3 seconds), as PO sends for pairs in its lists: still not a chart pair
  for (let k = 0; k < 10; k++) send('AEDCNY_otc', T0 + 400 + k * 0.3, 3.67);
  await tick();
  assert.ok(F.polled, 'a burst is not a chart');
  // a price every 2s for 22s: on a chart here
  for (let k = 0; k < 12; k++) send('AEDCNY_otc', T0 + 500 + 2 * k, 3.67 + k * 1e-4);
  await tick();
  assert.equal(F.polled, false);
  assert.ok(F.feed.lastTick && F.feed.lastTick.ts === T0 + 522);
});

test('content scripts: execution uses the closest duration PO offers (no M15 in its presets)', async () => {
  const T = loadTab();
  T.toTab({ type: 'config', cfg: { maxTradeSec: null, ownOnly: false } });
  vm.runInContext("state.running = true; state.settings.strategy = 'intel'; state.asset = 'KESUSD_otc'; state.settings.demoOnly = false; state.assets = [{ symbol: 'KESUSD_otc', payout: 92, active: true }];", T.ctx);
  const send = (ts, price) => T.deliver({ src: 'POBOT', kind: 'frame', event: 'updateStream', text: JSON.stringify([['KESUSD_otc', ts, price]]) });
  for (let k = 0; k < 14; k++) send(T0 + 2 * k, 0.0077);
  await tick();
  T.toTab({ type: 'execute', id: 'x9', kind: 'opp', asset: 'KESUSD_otc', dir: 'CALL', entryTime: T0 + 26, entryPrice: 0.0077, entryAtr: 0.00001, validFor: 30,
    atr: 0.00002, expirySec: 900, candleTime: T0 - 42, tf: 900 });
  await wait(20);
  const r = T.portSent.filter((m) => m.type === 'execResult').pop();
  // the harness has no PO page, so setting the duration fails — but it asked for M30 (offered), not M15 (not offered)
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /could not set expiry 1800s/);
});

test('content scripts: the scan leader analyses pairs nobody has open, from 1M history only', async () => {
  const T = loadTab();
  T.toTab({ type: 'config', cfg: { maxTradeSec: null } });
  const { OTC } = require('./load.js').load(['engine/core.js']);
  const N_PAST = 2000, N_LIVE = 20;
  const path = makeCandles({ start: T0 - 60 * N_PAST, tf: 60, price: 0.91, segments: [{ n: N_PAST + N_LIVE, drift: 0.2, vol: 0.0002 }], seed: 9 });
  let now = T0 + 5;
  vm.runInContext(`state.assets = [{ symbol: 'AUDCAD_otc', payout: 92, active: true }, { symbol: 'EURUSD', payout: 90, active: true }, { symbol: 'NZDJPY_otc', payout: 40, active: false }];`, T.ctx);
  const setNow = () => vm.runInContext(`state.lastTick = { ts: ${now}, price: 1 };`, T.ctx);
  setNow();
  T.toTab({ type: 'scanRole', leader: true, exclude: [] });
  const IT = T.ctx.globalThis.IntelTab;
  assert.deepEqual([...IT.scanList()], ['AUDCAD_otc'], 'OTC, active pairs only');
  const serve = async (p) => {
    let done = false;
    p.then(() => { done = true; });
    while (!done) {
      while (T.posted.length) {
        const m = T.posted.shift();
        if (m.src !== 'POBOT_CMD' || m.kind !== 'loadHistory') continue;
        const rows = m.period === 60 ? path : OTC.U.aggregate(path, 60, m.period);
        const data = rows.filter((c) => c.time + m.period <= now && c.time < m.time && c.time >= m.time - m.offset);
        T.deliver({ src: 'POBOT', kind: 'frame', event: 'loadHistoryPeriodFast', text: JSON.stringify({ asset: m.asset, period: m.period, data }) });
      }
      await tick();
    }
  };
  for (let k = 0; k < N_LIVE - 1; k++) {
    await serve(IT.pollOnce());
    now += 60; setNow();
  }
  const F = IT.feeds.get('AUDCAD_otc');
  assert.ok(F && F.polled, 'scanned feed');
  assert.ok(F.feed.series[60].closed().length >= 200);
  const recs = T.portSent.filter((m) => m.type === 'decision' && m.record.asset === 'AUDCAD_otc' && m.record.kind === 'setup');
  assert.ok(recs.filter((d) => d.record.tf === 60).length >= N_LIVE - 3, `1M analyses of the scanned pair: ${recs.length}`);
  assert.ok(recs.some((d) => d.record.tf === 300), '5M analysis from aggregated 1M history');
  assert.ok(recs.every((d) => d.record.scanned === true && d.record.profile?.PRIMARY === d.record.tf));
  assert.ok(!recs.some((d) => d.record.skipReasons.some((r) => /missing|stale|timeframe|duplicat/i.test(r))), 'clean data from history alone');
  // 1M candles of the scanned pair reach the worker, so its outcomes resolve like any other
  assert.ok(T.portSent.some((m) => m.type === 'candles' && m.asset === 'AUDCAD_otc' && m.tf === 60));
  // once nobody needs it scanned (another tab has it live), it is dropped
  T.toTab({ type: 'scanRole', leader: true, exclude: ['AUDCAD_otc'] });
  await serve(IT.pollOnce());
  assert.ok(!IT.feeds.has('AUDCAD_otc'));
  T.toTab({ type: 'scanRole', leader: false, exclude: [] }); // stops the minute timer
});

test('content scripts: waiting for PO before the click doesn\'t use timers (a background tab runs them about once a second)', async () => {
  const T = loadTab();
  // a hidden tab: every timer at least a second
  T.ctx.setTimeout = (f, ms, ...a) => { const t = setTimeout(f, Math.max(1000, ms), ...a); t.unref?.(); return t; };
  let ready = false; setTimeout(() => { ready = true; }, 30);
  T.ctx.isReady = () => ready;
  const t0 = Date.now();
  assert.equal(await vm.runInContext('waitFor(() => isReady(), 400)', T.ctx), true);
  assert.ok(Date.now() - t0 < 300, `took ${Date.now() - t0} ms`);
  const t1 = Date.now(); await vm.runInContext('quickSleep(80)', T.ctx);
  assert.ok(Date.now() - t1 >= 79 && Date.now() - t1 < 400, `quickSleep(80) took ${Date.now() - t1} ms`);
});

test('content scripts: changing the duration waits for PO\'s display, not for its list to close (it often stays open)', async () => {
  const T = loadTab();
  // PO's duration control: the value opens a list; picking an item changes the display, the list stays open until Escape
  let shown = 'M1', open = false;
  const display = { get textContent() { return shown; } };
  const item = (txt) => ({ textContent: txt, get offsetParent() { return open ? {} : null; }, click: () => { shown = txt; } });
  const items = ['S15', 'S30', 'M1', 'M3', 'M5'].map(item);
  const trigger = { click: () => { open = true; } };
  T.ctx.document = { querySelector: (sel) => (sel === '.block--expiration-inputs .value' ? trigger : sel === '.block--expiration-inputs .value__val' ? display : null),
    querySelectorAll: () => items, dispatchEvent: () => { open = false; }, body: null };
  const t0 = Date.now();
  assert.equal(await vm.runInContext('setExpiry(15)', T.ctx), null);
  assert.equal(shown, 'S15'); assert.equal(open, false, 'closed with Escape');
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms (it was 400+ waiting for the list to close)`);
});

test('content scripts: execute is refused unless this tab is armed for that pair', async () => {
  const T = loadTab();
  T.toTab({ type: 'execute', id: 'x1', asset: 'EURUSD_otc', dir: 'CALL', candleTime: T0, closePrice: 1.08, atr: 0.001, expirySec: 300 });
  await wait(5);
  const r = T.portSent.find((m) => m.type === 'execResult');
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /not armed/);
  // armed, but the chart shows another pair
  vm.runInContext("state.running = true; state.settings.strategy = 'intel'; state.asset = 'GBPUSD_otc';", T.ctx);
  T.toTab({ type: 'execute', id: 'x2', asset: 'EURUSD_otc', dir: 'CALL', candleTime: T0, closePrice: 1.08, atr: 0.001, expirySec: 300 });
  await wait(5);
  assert.match(T.portSent.filter((m) => m.type === 'execResult').pop().reason, /chart shows GBPUSD_otc/);
  // right pair, but no live price for it → refused (and nothing clicked)
  vm.runInContext("state.asset = 'EURUSD_otc';", T.ctx);
  T.toTab({ type: 'execute', id: 'x3', asset: 'EURUSD_otc', dir: 'CALL', candleTime: T0, closePrice: 1.08, atr: 0.001, expirySec: 300 });
  await wait(5);
  assert.match(T.portSent.filter((m) => m.type === 'execResult').pop().reason, /no live price/);
});

test('content scripts: no entry once the price has gone against the signal — checked again right before the click', async () => {
  const T = loadTab();
  T.toTab({ type: 'config', cfg: { maxTradeSec: null, ownOnly: false } });
  vm.runInContext("state.running = true; state.settings.strategy = 'intel'; state.asset = 'KESUSD_otc'; state.settings.demoOnly = false; state.assets = [{ symbol: 'KESUSD_otc', payout: 92, active: true }];", T.ctx);
  const send = (ts, price) => T.deliver({ src: 'POBOT', kind: 'frame', event: 'updateStream', text: JSON.stringify([['KESUSD_otc', ts, price]]) });
  for (let k = 0; k < 14; k++) send(T0 + 2 * k, 0.0077);
  await tick();
  const ex = (id, dir, entryPrice) => T.toTab({ type: 'execute', id, kind: 'opp', asset: 'KESUSD_otc', dir, entryTime: T0 + 26, entryPrice, entryAtr: 0.00001, validFor: 30, atr: 0.00002, expirySec: 60, candleTime: T0 + 11, tf: 15 });
  ex('a1', 'CALL', 0.0078); await wait(20);   // CALL signal at 0.0078, price now 0.0077: below → against
  assert.match(T.portSent.filter((m) => m.type === 'execResult').pop().reason, /price went against the signal/);
  ex('a2', 'PUT', 0.0076); await wait(20);    // PUT signal at 0.0076, price now 0.0077: above → against
  assert.match(T.portSent.filter((m) => m.type === 'execResult').pop().reason, /price went against the signal/);
  ex('a3', 'CALL', 0.0077); await wait(20);   // same price: goes on (the harness then fails at the duration: no PO page)
  assert.doesNotMatch(T.portSent.filter((m) => m.type === 'execResult').pop().reason, /against/);
  T.toTab({ type: 'config', cfg: { maxTradeSec: null, ownOnly: false, noAdverseEntry: false } });
  ex('a4', 'CALL', 0.0078); await wait(20);   // the rule off
  assert.doesNotMatch(T.portSent.filter((m) => m.type === 'execResult').pop().reason, /against/);
});

test('content scripts: the candle gate\'s confirmation candle — the entry waits for its close and goes on only if it closed the signal\'s way', async () => {
  const T = loadTab();
  T.toTab({ type: 'config', cfg: { maxTradeSec: null, ownOnly: false } });
  vm.runInContext("state.running = true; state.settings.strategy = 'intel'; state.asset = 'KESUSD_otc'; state.settings.demoOnly = false; state.assets = [{ symbol: 'KESUSD_otc', payout: 92, active: true }];", T.ctx);
  const send = (ts, price) => T.deliver({ src: 'POBOT', kind: 'frame', event: 'updateStream', text: JSON.stringify([['KESUSD_otc', ts, price]]) });
  for (let k = 0; k < 14; k++) send(T0 + 2 * k, 0.0077);
  await tick();
  const last = () => T.portSent.filter((m) => m.type === 'execResult').pop();
  const ex = (id, dir, at) => T.toTab({ type: 'execute', id, kind: 'opp', asset: 'KESUSD_otc', dir, entryTime: T0 + 26, entryPrice: 0.0077, entryAtr: 0.00001, validFor: 30, atr: 0.00002, expirySec: 60, candleTime: T0 + 11, tf: 15, confirm: { at, frame: 15, from: 0.0077 } });
  // CALL: the candle up to T0+28 closes at 0.0078 (above the signal's 0.0077) → goes on to the click (the harness then fails at the duration: no PO page)
  ex('c1', 'CALL', T0 + 28);
  send(T0 + 27, 0.0078); await wait(30);
  assert.equal(T.portSent.filter((m) => m.type === 'execResult').length, 0, 'waits for the candle to close');
  send(T0 + 28.5, 0.0078); await wait(40);
  assert.doesNotMatch(last().reason, /confirmation/);
  // PUT on the same close (0.0078 is above 0.0077) → refused, nothing clicked
  ex('c2', 'PUT', T0 + 30);
  send(T0 + 30.2, 0.0078); await wait(40);
  assert.match(last().reason, /confirmation candle closed against the signal \(0.0077 → 0.0078\)/);
  assert.equal(last().confirm.confirmed, false);
});

test('content scripts: no trade against one of the bot\'s trades still open on the same pair', async () => {
  const T = loadTab();
  T.toTab({ type: 'config', cfg: { maxTradeSec: null, ownOnly: false } });
  vm.runInContext("state.running = true; state.settings.strategy = 'intel'; state.asset = 'KESUSD_otc'; state.settings.demoOnly = false; state.assets = [{ symbol: 'KESUSD_otc', payout: 92, active: true }];", T.ctx);
  const send = (ts, price) => T.deliver({ src: 'POBOT', kind: 'frame', event: 'updateStream', text: JSON.stringify([['KESUSD_otc', ts, price]]) });
  for (let k = 0; k < 14; k++) send(T0 + 2 * k, 0.0077);
  await tick();
  vm.runInContext(`state.trades.push({ id: 'po-1', dir: 'put', stake: 50, expiry: 60, asset: 'KESUSD_otc', openedAt: Date.now() })`, T.ctx);
  const ex = (id, dir) => T.toTab({ type: 'execute', id, kind: 'opp', asset: 'KESUSD_otc', dir, entryTime: T0 + 26, entryPrice: 0.0077, entryAtr: 0.00001, validFor: 30, atr: 0.00002, expirySec: 60, candleTime: T0 + 11, tf: 15 });
  ex('o1', 'CALL'); await wait(20);
  assert.match(T.portSent.filter((m) => m.type === 'execResult').pop().reason, /PUT trade is still open on this pair/);
  ex('o2', 'PUT'); await wait(20);   // the same way: not this rule (the harness then fails at the duration)
  assert.doesNotMatch(T.portSent.filter((m) => m.type === 'execResult').pop().reason, /still open/);
});

test('content scripts: a tab refuses an entry it did not find itself, or on a pair its chart does not show', async () => {
  const T = loadTab();
  T.toTab({ type: 'config', cfg: { ownOnly: true } });
  vm.runInContext("state.running = true; state.settings.strategy = 'intel'; state.asset = 'NZDUSD_otc'; state.settings.demoOnly = false;", T.ctx);
  T.toTab({ type: 'execute', id: 'opp|NZDUSD_otc|15|123', kind: 'opp', asset: 'NZDUSD_otc', dir: 'CALL', entryTime: T0, entryPrice: 0.6, validFor: 30, atr: 0.0002, expirySec: 60, candleTime: T0 - 15, tf: 15 });
  await wait(20);
  assert.match(T.portSent.filter((m) => m.type === 'execResult').pop().reason, /not a signal this tab found/);
  assert.ok(!T.posted.some((m) => m?.type === 'click' || m?.kind === 'click'), 'nothing clicked');
});

test('content scripts: an execute that needs another pair fails cleanly when the pair cannot be opened', async () => {
  const T = loadTab();
  T.toTab({ type: 'config', cfg: { ownOnly: false } });
  vm.runInContext("state.running = true; state.settings.strategy = 'intel'; state.asset = 'NZDUSD_otc'; state.settings.demoOnly = false;", T.ctx);
  T.toTab({ type: 'execute', id: 'x7', kind: 'opp', switch: true, asset: 'AUDCAD_otc', dir: 'CALL', entryTime: T0, entryPrice: 0.9, entryAtr: 0.0001, validFor: 30, atr: 0.0002, expirySec: 300, candleTime: T0 - 60, tf: 300 });
  await wait(20);
  const r = T.portSent.filter((m) => m.type === 'execResult').pop();
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /could not open AUDCAD_otc: asset menu button not found/);
  // without permission to switch it is refused outright
  T.toTab({ type: 'execute', id: 'x8', kind: 'opp', asset: 'AUDCAD_otc', dir: 'CALL', entryTime: T0, entryPrice: 0.9, validFor: 30, atr: 0.0002, expirySec: 300 });
  await wait(20);
  assert.match(T.portSent.filter((m) => m.type === 'execResult').pop().reason, /chart shows NZDUSD_otc/);
});

// A copy-mode tab with PO history for one pair (1M path), answering every history request.
function copyTabHarness(pairAsset = 'AUDCAD_otc', cfg = { maxTradeSec: null }) {
  const T = loadTab();
  T.toTab({ type: 'config', cfg });
  const { OTC } = require('./load.js').load(['engine/core.js']);
  const path = makeCandles({ start: T0 - 60 * 2000, tf: 60, price: 0.91, segments: [{ n: 2030, drift: 0.15, vol: 0.0002 }], seed: 21 });
  const now = T0 + 25 * 60 + 7;
  vm.runInContext(`state.settings.strategy = 'copyplus'; state.running = true; state.asset = 'EURUSD_otc'; state.lastTick = { ts: ${now}, price: 1.08 };
    state.assets = [{ symbol: '${pairAsset}', payout: 92, active: true, name: 'AUD/CAD OTC' }, { symbol: 'EURUSD_otc', payout: 92, active: true }];`, T.ctx);
  const serve = async (p) => {
    let done = false;
    p?.then?.(() => { done = true; });
    for (let i = 0; i < 4000 && !done; i++) {
      while (T.posted.length) {
        const m = T.posted.shift();
        if (m.src !== 'POBOT_CMD' || m.kind !== 'loadHistory') continue;
        const rows = m.period === 60 ? path : m.period < 60 ? [] : OTC.U.aggregate(path, 60, m.period);
        const data = rows.filter((c) => c.time + m.period <= now && c.time < m.time && c.time >= m.time - m.offset);
        T.deliver({ src: 'POBOT', kind: 'frame', event: 'loadHistoryPeriodFast', text: JSON.stringify({ asset: m.asset, period: m.period, data }) });
      }
      await tick();
      if (!p && i > 400) break;
    }
  };
  return { T, now, serve, IT: T.ctx.globalThis.IntelTab };
}

test('content scripts: copy + verify — a signal on a pair nobody has open is checked against the engine\'s analysis and becomes an entry or a gated record', async () => {
  const { T, now, serve, IT } = copyTabHarness();
  IT.onCopySignal({ asset: 'AUDCAD_otc', dir: 'CALL', at: now, left: 120, elapsed: 4, copies: 3 });
  await serve(null);
  const d = T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'opp' && m.record.origin === 'copy').pop();
  assert.ok(d, 'the signal was verified and logged');
  const r = d.record;
  if (process.env.SHOW) console.log('SHOW', r.state, JSON.stringify(r.cal.blocks), r.regime, r.cal.status, r.expirySec, '| against:', (r.evidenceAgainst || []).join(' ; '));
  assert.equal(r.asset, 'AUDCAD_otc');
  assert.equal(r.setupKind, 'copy');
  assert.ok(['ENTERED', 'GATED'].includes(r.state));
  assert.ok(r.copy && r.copy.left >= 100);
  assert.equal(r.expirySec, 180, 'closest duration PO offers to the ~2 minutes the signal has left');
  assert.equal(r.ts % 60, 0, 'a scanned pair is measured from a 1M close');
  if (r.state === 'ENTERED') {
    assert.ok(d.cand && d.cand.source === 'copy' && d.cand.validFor === 12);
    assert.equal(d.cand.expirySec, 180);
  } else {
    assert.equal(d.cand, null);
    assert.ok(r.cal.blocks.length, 'a gated signal says why');
  }
  // too little time left: always gated, with that reason
  IT.onCopySignal({ asset: 'AUDCAD_otc', dir: 'PUT', at: now, left: 12, elapsed: 0, copies: 1 });
  await serve(null);
  const d2 = T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'opp' && m.record.origin === 'copy').pop();
  assert.equal(d2.record.state, 'GATED');
  assert.ok(d2.record.cal.blocks.includes('too_little_time'), JSON.stringify(d2.record.cal.blocks));
  assert.equal(d2.cand, null);
});

test('content scripts: copy + verify never copies with a duration far from the signal\'s time left (12:48 left → no 30-minute trade)', async () => {
  // seen in the user's panel: a signal with 12:48 left was given 30 minutes (PO offers nothing between M5 and M30)
  const { T, now, serve, IT } = copyTabHarness();
  IT.onCopySignal({ asset: 'AUDCAD_otc', dir: 'CALL', at: now, left: 768, elapsed: 120, copies: 44 });
  await serve(null);
  const r = T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'opp' && m.record.origin === 'copy').pop().record;
  assert.equal(r.state, 'GATED');
  assert.ok(r.cal.blocks.includes('no_duration'), JSON.stringify(r.cal.blocks));
  // 5 minutes left → M5 is the copy
  IT.onCopySignal({ asset: 'AUDCAD_otc', dir: 'PUT', at: now, left: 290, elapsed: 10, copies: 5 });
  await serve(null);
  const r2 = T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'opp' && m.record.origin === 'copy').pop().record;
  assert.ok(!r2.cal.blocks.includes('no_duration'), JSON.stringify(r2.cal.blocks));
  assert.equal(r2.expirySec, 300);
});

test('content scripts: Start survives a reload of the tab (it was off after every update — nothing could be placed)', async () => {
  const T = loadTab({ settings: { strategy: 'both', amount: 50, demoOnly: true }, __session: { pobotRunning: '1' } });
  await wait(1700);
  assert.equal(vm.runInContext('state.running', T.ctx), true, 'armed again after the reload');
  vm.runInContext('stop()', T.ctx);
  assert.equal(T.session.get('pobotRunning'), undefined, 'Stop is remembered too');
  const fresh = loadTab({ settings: { strategy: 'both' } });
  await wait(1700);
  assert.equal(vm.runInContext('state.running', fresh.ctx), false, 'a tab never started stays stopped');
});

test('content scripts: history requests are served most urgent first (gap repairs and copy checks before the scanner)', async () => {
  const T = loadTab();
  vm.runInContext(`historyRequest('A_otc', 60, 1000, 600, 1); historyRequest('SCAN_otc', 60, 1000, 600, 2); historyRequest('GAP_otc', 60, 1000, 600, 0); historyRequest('SEED_otc', 300, 1000, 600, 1);`, T.ctx);
  const order = () => T.posted.filter((m) => m.kind === 'loadHistory').map((m) => m.asset);
  assert.deepEqual(order(), ['A_otc'], 'one request in flight at a time');
  for (const asset of ['A_otc', 'GAP_otc', 'SEED_otc']) {
    T.deliver({ src: 'POBOT', kind: 'frame', event: 'loadHistoryPeriodFast', text: JSON.stringify({ asset, period: asset === 'SEED_otc' ? 300 : 60, data: [] }) });
    await tick();
  }
  assert.deepEqual(order(), ['A_otc', 'GAP_otc', 'SEED_otc', 'SCAN_otc']);
});

test('content scripts: copy + verify judges a signal on the frame that matches its time left', async () => {
  const { T, now, serve, IT } = copyTabHarness();
  const last = () => T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'opp' && m.record.origin === 'copy').pop().record;
  IT.onCopySignal({ asset: 'AUDCAD_otc', dir: 'CALL', at: now, left: 100, elapsed: 2, copies: 1 });
  await serve(null);
  assert.equal(last().copy.verifyFrame, 60);
  IT.onCopySignal({ asset: 'AUDCAD_otc', dir: 'PUT', at: now + 1, left: 600, elapsed: 2, copies: 1 });
  await serve(null);
  assert.equal(last().copy.verifyFrame, 300);
  assert.ok(last().evidenceAgainst.every((x) => /^5M|context/.test(x)), 'other frames are marked as context');
  IT.onCopySignal({ asset: 'AUDCAD_otc', dir: 'CALL', at: now + 2, left: 1500, elapsed: 2, copies: 1 });
  await serve(null);
  assert.equal(last().copy.verifyFrame, 900);
  assert.equal(last().cal.status, 'INSUFFICIENT_DATA', 'no copy history yet');
});

test('content scripts: copy + verify weighs the list by copies; two signals in one candle are two records', async () => {
  const { T, now, serve, IT } = copyTabHarness();
  // the rest of the list on AUDCAD: six sells copied 30 times each, one buy copied 5 times
  const hist = [...Array(6)].map((_, i) => ({ dir: 'PUT', at: now - 60 + i, left: 600, elapsed: 30, copies: 30 })).concat([{ dir: 'CALL', at: now - 20, left: 600, elapsed: 10, copies: 5 }]);
  vm.runInContext(`copy.hist['AUDCAD_otc'] = ${JSON.stringify(hist)};`, T.ctx);
  const copyRecs = () => T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'opp' && m.record.origin === 'copy').map((m) => m.record);
  IT.onCopySignal({ asset: 'AUDCAD_otc', dir: 'PUT', at: now, left: 300, elapsed: 3, copies: 40, pnl: '-' });
  await serve(null);
  IT.onCopySignal({ asset: 'AUDCAD_otc', dir: 'CALL', at: now, left: 300, elapsed: 3, copies: 2, pnl: '+' });
  await serve(null);
  const [put, call] = copyRecs().slice(-2);
  assert.notEqual(put.id, call.id, 'separate records');
  assert.ok(!put.cal.blocks.includes('copy_flipping') && !put.cal.blocks.includes('copy_conflict'), JSON.stringify(put.cal.blocks));
  assert.ok(put.copy.share > 0.9);
  assert.ok(call.cal.blocks.includes('copy_conflict'), JSON.stringify(call.cal.blocks));
  assert.equal(put.copy.pnl, '-');
});

test('content scripts: short trades by default — copy signals longer than the maximum are not even looked at', async () => {
  const { T, now, serve, IT } = copyTabHarness('AUDCAD_otc', {}); // default: at most 1 minute
  const copyRecs = () => T.portSent.filter((m) => m.type === 'decision' && m.record.kind === 'opp' && m.record.origin === 'copy');
  const last = () => copyRecs().pop().record;
  IT.onCopySignal({ asset: 'AUDCAD_otc', dir: 'CALL', at: now, left: 600, elapsed: 3, copies: 10, pnl: '-' });
  await serve(null);
  assert.equal(copyRecs().length, 0, 'no verification, no record, no screen update');
  assert.ok(!T.posted.some((m) => m.kind === 'loadHistory' && m.asset === 'AUDCAD_otc'), 'and no history requests for it');
  IT.onCopySignal({ asset: 'AUDCAD_otc', dir: 'PUT', at: now + 1, left: 50, elapsed: 3, copies: 10, pnl: '-' });
  await serve(null);
  assert.ok(!last().cal.blocks.includes('too_long'));
  assert.ok([30, 60].includes(last().expirySec), String(last().expirySec));
  assert.equal(last().copy.verifyFrame, 60);
  IT.onCopySignal({ asset: 'AUDCAD_otc', dir: 'CALL', at: now + 2, left: 85, elapsed: 3, copies: 10, pnl: '-' });
  await serve(null);
  assert.equal(last().expirySec, 60, 'never longer than the maximum');
});

test('content scripts: one decision engine — a tab saved in an old one-pair mode runs the engine; its stake and demo-only carry over', () => {
  const T = loadTab({ settings: { strategy: 'hunter', amount: 120, currency: 'USD', demoOnly: true, martingale: true, period: 15, minPayout: 92 } });
  const st = JSON.parse(vm.runInContext('JSON.stringify(state.settings)', T.ctx));
  assert.equal(st.strategy, 'both', 'an old mode → the engine, placing its opportunities and verified copy signals');
  assert.equal(st.amount, 120);
  assert.equal(st.currency, 'USD');
  assert.equal(st.demoOnly, true);
  for (const k of ['martingale', 'period']) assert.ok(!(k in st), `${k} is gone`);
  assert.equal(st.minPayout, 80, 'the old bot\'s payout setting is not carried over: the panel\'s new floor starts at 80%');
  for (const g of ['evaluateAll', 'runBacktest', 'scalpEngine', 'placeTrade', 'limitHit']) assert.equal(vm.runInContext(`typeof ${g}`, T.ctx), 'undefined', `${g} is gone`);
  const C = loadTab({ settings: { strategy: 'copyplus', amount: 50 } });
  assert.equal(vm.runInContext('state.settings.strategy', C.ctx), 'copyplus', 'Copy + verify stays');
});

// ── discovered strategies in the worker ─────────────────────────────────────
const discRow = (status, extra = {}) => ({ key: `DISC-00001#0001#RUN-1`, strategy_id: 'DISC-00001', version: 1, type: 'STRATEGY', status, direction: 'CALL', expiry: 1,
  rule: { dir: 'CALL', expiry: 1, all: [{ f: 'pa.doji', op: '==', v: true }], none: [] }, name: 'CALL · doji', cluster: 'C1', live_since: 0, updated_at: 1,
  out_of_sample_results: { n: 80, lo: 58, be: 54 }, history: [], ...extra });

test('worker: tracked discovered strategies reach the tabs; promotion adds an AUTO profile; suspension removes it', async () => {
  const W = await loadWorker(FAST);
  await W.DB.put('strategies', discRow('WATCHLIST'));
  const dash = W.connectDash();
  await dash.send({ type: 'discRefresh' });
  const tab = W.connectTab(11);
  await wait(10);
  const cfgMsg = tab.sent.find((m) => m.type === 'config');
  assert.equal(cfgMsg.discovered.length, 1);
  assert.equal(cfgMsg.discovered[0].id, 'DISC-00001');
  await dash.send({ type: 'discPromote', id: 'DISC-00001' });
  const versions = [...W.DB.stores.strategies.values()].filter((r) => r.strategy_id === 'DISC-00001');
  assert.equal(versions.length, 2, 'old version preserved, new one added');
  assert.equal(versions.find((v) => v.version === 2).status, 'PROMOTED');
  assert.ok(W.store.intelConfig.promotedProfiles.includes('DISC-00001|*|E1'));
  assert.equal(tab.sent.filter((m) => m.type === 'config').pop().discovered[0].status, 'PROMOTED');
  // promoting something that is not on the watchlist is refused
  await W.DB.put('strategies', discRow('PAPER_TEST', { key: 'DISC-00002#0001#RUN-1', strategy_id: 'DISC-00002' }));
  await dash.send({ type: 'discPromote', id: 'DISC-00002' });
  assert.ok(![...W.DB.stores.strategies.values()].some((r) => r.strategy_id === 'DISC-00002' && r.status === 'PROMOTED'));
  await dash.send({ type: 'discSuspend', id: 'DISC-00001' });
  assert.ok(!W.store.intelConfig.promotedProfiles.includes('DISC-00001|*|E1'));
});

test('worker: paper results from live records move a strategy from PAPER_TEST to WATCHLIST', async () => {
  const W = await loadWorker(FAST);
  await W.DB.put('strategies', discRow('PAPER_TEST'));
  for (let i = 0; i < 80; i++) {
    const win = i % 4 !== 0;
    await W.DB.put('records', { id: `live|EURUSD_otc|${i}`, source: 'live', asset: 'EURUSD_otc', ts: 1000 + i * 600, candleTime: 700 + i * 600, payout: 85,
      entryPrice: 1, exits: { 1: win ? 1.01 : 0.99 }, status: 'resolved', disc: [['DISC-00001', 'CALL', 1]] });
  }
  const dash = W.connectDash();
  await dash.send({ type: 'discRefresh' });
  const latest = [...W.DB.stores.strategies.values()].sort((a, b) => b.version - a.version)[0];
  assert.equal(latest.status, 'WATCHLIST');
  assert.equal(latest.paper_results.n, 80);
  assert.ok(W.notifications.some((n) => /اجتاز الاختبار/.test(n.title)));
});

test('worker: 1M candles are stored separately for discovery', async () => {
  const W = await loadWorker(FAST);
  const tab = W.connectTab(12);
  await tab.send({ type: 'candles', asset: 'EURUSD_otc', tf: 60, rows: [{ time: T0 + 60, open: 1, high: 1.1, low: 0.9, close: 1.05 }] });
  assert.equal(W.DB.stores.candles_m1.size, 1);
  assert.equal(W.DB.stores.candles.size, 0);
});

test('panel mode "كيلتنر 10د": the worker switches to the Keltner strategy on 10-minute candles with 30-minute trades, and gives the old settings back', async () => {
  const W = await loadWorker({ intelConfig: { risk: { batchWindowMs: 20 }, maxTradeSec: 60 } });
  const tab = W.connectTab(91);
  const state = (panelMode) => ({ type: 'state', chartAsset: 'EURUSD_otc', armed: true, isDemo: true, engine: panelMode === 'copyplus' ? 'copy' : 'intel', panelMode, running: true, openTrades: [], assets: [] });
  await tab.send(state('keltner'));
  let c = W.store.intelConfig;
  assert.equal(c.solo, 'keltner_trend_pullback');
  assert.equal(c.onlyFrame, 600);
  assert.equal(c.maxTradeSec, 1800, 'its trades last 30 minutes');
  assert.ok(tab.sent.some((m) => m.type === 'config' && m.cfg.solo === 'keltner_trend_pullback'), 'tabs are told');
  await tab.send(state('intel'));
  c = W.store.intelConfig;
  assert.equal(c.solo, null);
  assert.equal(c.onlyFrame, null);
  assert.equal(c.maxTradeSec, 60, 'the user\'s own maximum is back');
  assert.ok(!('soloPrev' in c));
});

test('panel mode "استراتيجيات يوتيوب": the worker runs the videos\' strategies on their own frames, then restores the settings', async () => {
  const W = await loadWorker({ intelConfig: { risk: { batchWindowMs: 20 }, maxTradeSec: 60 } });
  const tab = W.connectTab(92);
  const state = (panelMode) => ({ type: 'state', chartAsset: 'EURUSD_otc', armed: true, isDemo: true, engine: 'intel', panelMode, running: true, openTrades: [], assets: [] });
  await tab.send(state('youtube'));
  let c = W.store.intelConfig;
  assert.equal(c.soloMode, 'youtube');
  assert.equal(c.solo.length, 18);
  assert.deepEqual(c.soloFrames, [5, 15, 30, 60, 300, 600]);
  assert.equal(c.maxTradeSec, 1800);
  await tab.send(state('keltner'));
  c = W.store.intelConfig;
  assert.equal(c.solo, 'keltner_trend_pullback');
  assert.equal(c.soloFrames, null);
  await tab.send(state('both'));
  c = W.store.intelConfig;
  assert.equal(c.solo, null);
  assert.equal(c.maxTradeSec, 60, 'the user\'s own maximum is back');
  assert.ok(!('soloMode' in c) && !('soloPrev' in c));
});

test('worker AUTO, "استراتيجيات يوتيوب" with the real-account gate off: the user chose no checks — an unmeasured signal is executed even on a real account', async () => {
  // protection limits that would stop any other entry (no trades left today) don't apply to this mode
  const W = await loadWorker({ intelConfig: { candleGate: { on: false }, ytRealGate: { on: false }, execMode: 'AUTO', risk: { batchWindowMs: 20, maxTradesPerDay: 0 } } });
  const tab = W.connectTab(83);
  await tab.send({ type: 'state', poNow: T0 + 1, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: false, openTrades: [], assets: [], limits: { minPayout: 50, stopLoss: 10 } });
  assert.equal(W.store.intelConfig.soloMode, 'youtube');
  const rec = makeOpp('EURUSD_otc', T0, 'CALL', { setup: 'yt_macd_zero' });
  // unmeasured, a negative measured value and a payout below the user's minimum: entered anyway (the user's choice)
  const cand = { ...oppCand(rec), setup: 'yt_macd_zero', payout: 60, cal: { status: 'MEASURED', measured: true, winProb: 48, ev: -0.1, qualified: true, raw: true, blocks: [], payout: 60 } };
  await tab.send({ type: 'decision', record: rec, cand, poNow: T0 + 2 });
  await wait(60);
  assert.ok(tab.sent.some((m) => m.type === 'execute' && m.id === rec.id), 'executed without a measured record');
  // the panel's limits: below its payout floor → no entry
  const low = makeOpp('GBPUSD_otc', T0 + 30, 'CALL', { setup: 'yt_macd_zero' });
  await tab.send({ type: 'decision', record: low, cand: { ...oppCand(low), setup: 'yt_macd_zero', payout: 30, cal: { measured: false, qualified: true, raw: true, blocks: [], payout: 30 } }, poNow: T0 + 32 });
  await wait(60);
  assert.ok(!tab.sent.some((m) => m.type === 'execute' && m.id === low.id), 'payout 30% < the panel\'s 50%');
  // …and once the panel reports its stop loss hit (the day's money that far below its best) → no entry, tabs told
  await tab.send({ type: 'tradeClosed', id: rec.id, result: 'loss', profit: -15, stake: 15 });
  await tab.send({ type: 'state', poNow: T0 + 2, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: false, openTrades: [], assets: [], limits: { minPayout: 50, stopLoss: 10, stopHit: true } });
  await tab.send({ type: 'tradeClosed', id: rec.id, result: 'loss', profit: 0, stake: 15 });
  assert.ok(tab.sent.some((m) => m.type === 'dayNet' && m.stopped));
  const after = makeOpp('EURUSD_otc', T0 + 300, 'PUT', { setup: 'yt_macd_zero' });
  await tab.send({ type: 'decision', record: after, cand: { ...oppCand(after), setup: 'yt_macd_zero', payout: 92, cal: { measured: false, qualified: true, raw: true, blocks: [], payout: 92 } }, poNow: T0 + 302 });
  await wait(60);
  assert.ok(!tab.sent.some((m) => m.type === 'execute' && m.id === after.id), 'daily stop loss reached');
  assert.match((await W.DB.get('records', after.id)).skipReasons.join(' '), /stop loss/);
  // outside that mode the real-account rule is back
  await tab.send({ type: 'state', poNow: T0 + 3, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'intel', isDemo: false, openTrades: [], assets: [] });
  const rec2 = makeOpp('EURUSD_otc', T0 + 600, 'CALL');
  await tab.send({ type: 'decision', record: rec2, cand: { ...oppCand(rec2), cal: { status: 'INSUFFICIENT_DATA', measured: false, qualified: true, raw: true, blocks: [], payout: 92 } }, poNow: T0 + 602 });
  await wait(60);
  assert.ok(!tab.sent.some((m) => m.type === 'execute' && m.id === rec2.id));
});

test('worker AUTO, "استراتيجيات يوتيوب" (real-account gate on by default): real money only for a strategy whose own signals clear break-even', async () => {
  const W = await loadWorker({ intelConfig: { candleGate: { on: false }, execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(85);
  await tab.send({ type: 'state', poNow: T0 + 1, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: false, openTrades: [], assets: [], limits: { minPayout: 50, stopLoss: 1000 } });
  // a record: yt_stoch_cross 45 of 100 at 15 s (under break-even), yt_macd_zero 70 of 100 (clears it)
  const seed = async (setup, wins, base) => { for (let i = 0; i < 100; i++) {
    const r = makeOpp('GBPUSD_otc', base + i * 60, 'CALL', { setup }); r.state = 'ENTERED'; r.expirySec = 15; r.chart = i % 2 === 0; r.entryPrice = 1; r.exits = { 15: i < wins ? 1.001 : 0.999 }; // off-chart signals count too
    await W.DB.put('records', r); } };
  await seed('yt_stoch_cross', 45, T0 - 100000); await seed('yt_macd_zero', 70, T0 - 50000);
  const send = async (setup, t) => { const rec = makeOpp('EURUSD_otc', t, 'CALL', { setup });
    await tab.send({ type: 'decision', record: rec, cand: { ...oppCand(rec), setup, expirySec: 15, payout: 92, cal: { measured: false, qualified: true, raw: true, blocks: [], payout: 92 } }, poNow: t + 2 });
    await wait(60); return rec; };
  const losing = await send('yt_stoch_cross', T0);
  assert.ok(!tab.sent.some((m) => m.type === 'execute' && m.id === losing.id), 'below break-even: research only');
  assert.match((await W.DB.get('records', losing.id)).exec.note, /real account: yt_stoch_cross wins 45% of 100/);
  const fresh = await send('yt_williams_macd', T0 + 60);
  assert.ok(!tab.sent.some((m) => m.type === 'execute' && m.id === fresh.id), 'no record yet: research only');
  const proven = await send('yt_macd_zero', T0 + 120);
  assert.ok(tab.sent.some((m) => m.type === 'execute' && m.id === proven.id), 'clears break-even: placed');
  // on a demo account the gate doesn't apply
  await tab.send({ type: 'state', poNow: T0 + 200, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [], limits: { minPayout: 50, stopLoss: 1000 } });
  const demo = await send('yt_stoch_cross', T0 + 300);
  assert.ok(tab.sent.some((m) => m.type === 'execute' && m.id === demo.id), 'demo: entered');
});

test('"استراتيجيات mostafa elashhab": a strategy whose own executed trades lose (20+, under break-even 52.1%) is switched off by itself', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(84);
  await tab.send({ type: 'state', poNow: T0 + 1, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [] });
  // 10 of 20 (50 %): kept before, below break-even now; wins and losses mixed (no 4 losses in a row)
  for (let i = 0; i < 20; i++) {
    const r = makeOpp('EURUSD_otc', T0 + i * 300, 'CALL', { setup: 'yt_williams_macd' });
    r.exec = { action: 'auto', result: i % 2 ? 'W' : 'L' };
    await W.DB.put('records', r);
  }
  const good = makeOpp('GBPUSD_otc', T0 + 99999, 'CALL', { setup: 'yt_bollinger_supertrend' }); good.exec = { action: 'auto' }; await W.DB.put('records', good);
  await tab.send({ type: 'tradeClosed', id: good.id, result: 'win', profit: 46, stake: 50 });
  await wait(30);
  const off = W.store.intelConfig.soloOff;
  assert.ok(off.includes('yt_williams_macd'), `10 of 20: switched off (${off})`);
  assert.ok(off.includes('yt_supertrend_5s'), 'the one removed by default stays off');
  assert.ok(!off.includes('yt_bollinger_supertrend'));
  assert.ok(W.store.intelConfig.soloAutoOffLog.some((x) => x.id === 'yt_williams_macd' && x.n === 20 && x.w === 10));
});

test('loss review 2026-10-05: only the six strategies that won on real trades stay on (once), and the panel is told', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', soloOff: ['yt_macd_zero', 'yt_stoch_cross', 'yt_katie_dema'] } });
  const off = new Set(W.store.intelConfig.soloOff), keep = ['yt_wma_stoch_macd', 'yt_bollinger_supertrend', 'yt_stoch_cross', 'yt_ichimoku_williams', 'yt_supertrend_rsi', 'yt_williams_macd'];
  for (const id of vm.runInContext("OTC.YouTube.ids()", W.ctx)) assert.equal(off.has(id), !keep.includes(id), id);
  assert.equal(W.store.intelConfig.soloOff.length, off.size, 'no duplicate');
  assert.equal(W.store.intelConfig.lossReview, '2026-10-05b');
  const tab = W.connectTab(90);
  await tab.send({ type: 'state', poNow: T0 + 1, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [] });
  const told = tab.sent.find((m) => m.type === 'stratOff')?.items[0];
  assert.equal(told.kind, 'keep'); assert.equal(told.items.length, 6); assert.equal(told.off, 10);
  // done once: a strategy the user turns back on stays on
  const W2 = await loadWorker({ intelConfig: { execMode: 'AUTO', soloOff: ['yt_macd_zero'], lossReview: '2026-10-05b' } });
  assert.deepEqual([...W2.store.intelConfig.soloOff], ['yt_macd_zero']);
});

test('worker AUTO, candle gate: no candle pattern with the signal → no entry; with one the entry goes with its confirmation candle', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', candleGate: { on: true, pattern: true, confirm: true }, soloMode: 'youtube', solo: ['yt_bollinger_supertrend'], risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(93);
  await tab.send({ type: 'state', poNow: T0, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [], limits: { minPayout: 50, stopLoss: 0, maxOpen: 0 } });
  const raw = (r) => ({ ...oppCand(r), setup: r.setup, payout: 92, cal: { measured: false, qualified: true, raw: true, blocks: [], payout: 92 } });
  const none = makeOpp('EURUSD_otc', T0 + 60, 'CALL', { setup: 'yt_bollinger_supertrend', frame: 15, facts: { pattern: null, risks: [] } });
  await tab.send({ type: 'decision', record: none, cand: raw(none), poNow: T0 + 61 }); await wait(60);
  assert.ok(!tab.sent.some((m) => m.type === 'execute' && m.id === none.id));
  assert.match((await W.DB.get('records', none.id)).skipReasons.join(' '), /no candle pattern/);
  const eng = makeOpp('EURUSD_otc', T0 + 300, 'CALL', { setup: 'yt_bollinger_supertrend', frame: 15, entryPrice: 1.08, facts: { pattern: 'bullish_engulfing', risks: [] } });
  await tab.send({ type: 'decision', record: eng, cand: raw(eng), poNow: T0 + 301 }); await wait(60);
  const ex = tab.sent.find((m) => m.type === 'execute' && m.id === eng.id);
  assert.deepEqual({ ...ex.confirm }, { at: T0 + 315, frame: 15, from: 1.08 }, 'the next 15 s candle confirms it');
  assert.equal((await W.DB.get('records', eng.id)).candleGate.pattern, 'bullish_engulfing');
  await tab.send({ type: 'execResult', id: eng.id, status: 'placed', stake: 50, demo: true, expirySec: 60, confirm: { price: 1.0802, confirmed: true } });
  assert.equal((await W.DB.get('records', eng.id)).candleGate.confirmed, true);
});

test('worker AUTO, strategies mode (defaults): a signal on a pair no tab shows → a free armed tab switches to it, pattern only, no confirmation candle', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', soloMode: 'youtube', solo: ['yt_bollinger_supertrend'], risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(94);
  await tab.send({ type: 'state', poNow: T0, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [], limits: { minPayout: 50, stopLoss: 0, maxOpen: 0 } });
  const r = makeOpp('AUDCAD_otc', T0 + 60, 'PUT', { setup: 'yt_bollinger_supertrend', frame: 15, entryPrice: 0.9, facts: { pattern: 'bearish_engulfing', risks: [] } });
  // a 15 s signal: 5 s entry window, 1 s gone → 4 s left, enough for a switch
  await tab.send({ type: 'decision', record: r, cand: { ...oppCand(r), entryTime: T0 + 60, validFor: 5, setup: r.setup, payout: 92, cal: { measured: false, qualified: true, raw: true, blocks: [], payout: 92 } }, poNow: T0 + 61 });
  await wait(60);
  const ex = tab.sent.find((m) => m.type === 'execute' && m.id === r.id);
  assert.ok(ex, 'sent to the tab');
  assert.equal(ex.switch, true);
  assert.equal(ex.asset, 'AUDCAD_otc');
  assert.equal(ex.confirm, null, 'no confirmation candle');
});

test('worker AUTO, strategies mode: protection — no entry on a signal with high volatility; exhausted / late still enter', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', candleGate: { on: false }, soloMode: 'youtube', solo: ['yt_bollinger_supertrend'], risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(95);
  await tab.send({ type: 'state', poNow: T0, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [], limits: { minPayout: 50, stopLoss: 0, maxOpen: 0 } });
  const raw = (r) => ({ ...oppCand(r), setup: r.setup, facts: r.facts, payout: 92, cal: { measured: false, qualified: true, raw: true, blocks: [], payout: 92 } });
  const vol = makeOpp('EURUSD_otc', T0 + 60, 'CALL', { setup: 'yt_bollinger_supertrend', frame: 15, facts: { pattern: null, risks: [{ code: 'volatility', severity: 'medium', hard: false }] } });
  await tab.send({ type: 'decision', record: vol, cand: raw(vol), poNow: T0 + 61 }); await wait(60);
  assert.ok(!tab.sent.some((m) => m.type === 'execute' && m.id === vol.id));
  assert.equal((await W.DB.get('records', vol.id)).protect, 'volatility in the top 10 %');
  const ok = makeOpp('EURUSD_otc', T0 + 300, 'CALL', { setup: 'yt_bollinger_supertrend', frame: 15, facts: { pattern: null, risks: [{ code: 'exhausted' }, { code: 'late' }, { code: 'level_close' }] } });
  await tab.send({ type: 'decision', record: ok, cand: raw(ok), poNow: T0 + 301 }); await wait(60);
  assert.ok(tab.sent.some((m) => m.type === 'execute' && m.id === ok.id));
});

test('worker AUTO: no entry when another strategy signalled the other way on the pair in the minute before; a learned condition holds entries', async () => {
  // records where "momentum against" lost on the older and the newer part → learned at start
  const seed = [];
  for (let i = 0; i < 120; i++) {
    const mom = i % 2 === 0, r = makeOpp(`P${i % 5}_otc`, T0 - 200000 + i * 900, 'CALL', { setup: 'yt_bollinger_supertrend', expirySec: 60, entryPrice: 1, chart: true,
      exits: { 60: (mom ? i % 8 === 0 : i % 4 !== 3) ? 1.001 : 0.999 }, facts: { momentum: mom ? 'against' : 'with', risks: [] } });
    seed.push(r);
  }
  const W = await loadWorker({ intelConfig: { candleGate: { on: false }, execMode: 'AUTO', soloMode: 'youtube', solo: ['yt_bollinger_supertrend', 'yt_wma_stoch_macd'], risk: { batchWindowMs: 20 } } });
  for (const r of seed) await W.DB.put('records', r);
  const tab = W.connectTab(92);
  await tab.send({ type: 'state', poNow: T0, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [], limits: { minPayout: 50, stopLoss: 0, maxOpen: 0 } });
  // learning runs at start (before the records above existed) and after every 10 results: run it now
  await vm.runInContext('learnConditions()', W.ctx);
  assert.deepEqual([...vm.runInContext('learned.blocked.map((c) => c.k)', W.ctx)], ['momAgainst']);
  assert.ok(tab.sent.some((m) => m.type === 'stratOff' && m.items.some((x) => x.kind === 'learn' && x.on)), 'the panel is told');
  const raw = (r) => ({ ...oppCand(r), setup: r.setup, payout: 92, cal: { measured: false, qualified: true, raw: true, blocks: [], payout: 92 } });
  const go = async (r) => { await tab.send({ type: 'decision', record: r, cand: raw(r), poNow: r.ts + 2 }); await wait(60); return tab.sent.some((m) => m.type === 'execute' && m.id === r.id); };
  const conflict = makeOpp('EURUSD_otc', T0 + 60, 'CALL', { setup: 'yt_wma_stoch_macd', agree: { same: 0, against: 1 }, facts: { momentum: 'with', risks: [] } });
  assert.equal(await go(conflict), false, 'conflict');
  assert.match((await W.DB.get('records', conflict.id)).skipReasons.join(' '), /signalled the other way/);
  const mom = makeOpp('EURUSD_otc', T0 + 300, 'CALL', { setup: 'yt_wma_stoch_macd', agree: { same: 0, against: 0 }, facts: { momentum: 'against', risks: [] } });
  assert.equal(await go(mom), false, 'learned');
  assert.match((await W.DB.get('records', mom.id)).skipReasons.join(' '), /learned: momAgainst/);
  const ok = makeOpp('EURUSD_otc', T0 + 600, 'CALL', { setup: 'yt_wma_stoch_macd', agree: { same: 1, against: 0 }, facts: { momentum: 'with', risks: [] } });
  assert.equal(await go(ok), true, 'nothing against it');
});

test('worker AUTO: a mode strategy whose last 4 real trades lost places nothing for 30 minutes after that loss (signals still recorded)', async () => {
  const W = await loadWorker({ intelConfig: { candleGate: { on: false }, execMode: 'AUTO', soloMode: 'youtube', solo: ['yt_bollinger_supertrend', 'yt_wma_stoch_macd'], risk: { batchWindowMs: 20 } } });
  for (let i = 0; i < 6; i++) {
    const r = makeOpp('EURUSD_otc', T0 - 600 + i * 60, 'PUT', { setup: 'yt_bollinger_supertrend' });
    r.exec = { action: 'auto', result: i < 2 ? 'W' : 'L', expiry: 60 };
    await W.DB.put('records', r);
  }
  const tab = W.connectTab(91);
  const state = (t) => tab.send({ type: 'state', poNow: t, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [], limits: { minPayout: 50, stopLoss: 0, maxOpen: 0 } });
  await state(T0);
  await wait(40);
  assert.ok(tab.sent.some((m) => m.type === 'stratOff' && m.items.some((x) => x.kind === 'pause' && x.id === 'yt_bollinger_supertrend')), 'the panel is told');
  const raw = (r, setup) => ({ ...oppCand(r), setup, payout: 92, cal: { measured: false, qualified: true, raw: true, blocks: [], payout: 92 } });
  const a = makeOpp('EURUSD_otc', T0 + 60, 'CALL', { setup: 'yt_bollinger_supertrend' });
  await tab.send({ type: 'decision', record: a, cand: raw(a, 'yt_bollinger_supertrend'), poNow: T0 + 62 });
  const b = makeOpp('EURUSD_otc', T0 + 75, 'CALL', { setup: 'yt_wma_stoch_macd' });
  await tab.send({ type: 'decision', record: b, cand: raw(b, 'yt_wma_stoch_macd'), poNow: T0 + 62 });
  await wait(60);
  assert.ok(!tab.sent.some((m) => m.type === 'execute' && m.id === a.id), 'paused');
  assert.match((await W.DB.get('records', a.id)).skipReasons.join(' '), /paused after 4 losses/);
  assert.ok(tab.sent.some((m) => m.type === 'execute' && m.id === b.id), 'another strategy still trades');
  // last loss at T0−300 + 60 s → paused to T0+1560
  await state(T0 + 1600);
  const c = makeOpp('EURUSD_otc', T0 + 1600, 'CALL', { setup: 'yt_bollinger_supertrend' });
  await tab.send({ type: 'decision', record: c, cand: raw(c, 'yt_bollinger_supertrend'), poNow: T0 + 1602 });
  await wait(60);
  assert.ok(tab.sent.some((m) => m.type === 'execute' && m.id === c.id), 'trades again after 30 minutes');
});

test('worker AUTO: the panel\'s number of trades open at the same time — at that many, no new entry until one closes', async () => {
  const W = await loadWorker({ intelConfig: { candleGate: { on: false }, execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(85);
  await tab.send({ type: 'state', poNow: T0 + 1, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [], limits: { minPayout: 50, stopLoss: 0, maxOpen: 1 } });
  const raw = (r, payout = 92) => ({ ...oppCand(r), setup: 'yt_macd_zero', payout, cal: { measured: false, qualified: true, raw: true, blocks: [], payout } });
  const a = makeOpp('EURUSD_otc', T0, 'CALL', { setup: 'yt_macd_zero' });
  await tab.send({ type: 'decision', record: a, cand: raw(a), poNow: T0 + 2 });
  await wait(60);
  assert.ok(tab.sent.some((m) => m.type === 'execute' && m.id === a.id));
  await tab.send({ type: 'execResult', id: a.id, status: 'placed', stake: 50, demo: true, expirySec: 60 });
  const b = makeOpp('EURUSD_otc', T0 + 10, 'PUT', { setup: 'yt_macd_zero' });
  await tab.send({ type: 'decision', record: b, cand: raw(b), poNow: T0 + 12 });
  await wait(60);
  assert.ok(!tab.sent.some((m) => m.type === 'execute' && m.id === b.id), '1 open, 1 allowed at once');
  assert.match((await W.DB.get('records', b.id)).skipReasons.join(' '), /open already/);
});

test('worker: the same signal arriving twice (two tabs, a re-post) is placed once and its record keeps the trade', async () => {
  const W = await loadWorker({ intelConfig: { candleGate: { on: false }, execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(87), tab2 = W.connectTab(88);
  await tab.send({ type: 'state', poNow: T0 + 1, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [], limits: { minPayout: 50, stopLoss: 0, maxOpen: 0 } });
  await tab2.send({ type: 'state', poNow: T0 + 1, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [], limits: { minPayout: 50, stopLoss: 0, maxOpen: 0 } });
  const raw = (r) => ({ ...oppCand(r), setup: 'yt_macd_zero', payout: 92, cal: { measured: false, qualified: true, raw: true, blocks: [], payout: 92 } });
  const a = makeOpp('EURUSD_otc', T0, 'CALL', { setup: 'yt_macd_zero' });
  await tab.send({ type: 'decision', record: a, cand: raw(a), poNow: T0 + 2 });
  await wait(60);
  await tab.send({ type: 'execResult', id: a.id, status: 'placed', stake: 50, demo: true, expirySec: 60 });
  // the same id again, 11 s later, from the other tab and from the same one (no limit on open trades)
  await tab2.send({ type: 'decision', record: { ...a }, cand: raw(a), poNow: T0 + 13 });
  await tab.send({ type: 'decision', record: { ...a }, cand: raw(a), poNow: T0 + 14 });
  await wait(60);
  const execs = [...tab.sent, ...tab2.sent].filter((m) => m.type === 'execute' && m.id === a.id);
  assert.equal(execs.length, 1, 'placed once');
  const rec = await W.DB.get('records', a.id);
  assert.equal(rec.exec.action, 'auto'); assert.equal(rec.exec.dir, 'CALL'); assert.equal(rec.decision, 'CALL');
});

test('worker: «تظلّم» on a losing trade — explained, kept on the record and in the list of appeals, answered to the tab', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(89);
  const r = makeOpp('EURUSD_otc', T0, 'CALL', { setup: 'yt_macd_zero', expirySec: 60, entryPrice: 1.08, exits: { 60: 1.0801, 120: 1.0803 },
    exec: { action: 'auto', dir: 'CALL', status: 'confirmed', result: 'L', profit: -50, po: { openPrice: 1.0802, closePrice: 1.0801, openTs: T0 + 1, closeTs: T0 + 61 }, forensics: { delaySec: 1, marketAtClose: 1.0801, poOutcome: 'L', marketOutcome: 'L' } } });
  await W.DB.put('records', r);
  await tab.send({ type: 'appeal', id: r.id });
  await wait(30);
  const ans = tab.sent.find((m) => m.type === 'appealResult' && m.id === r.id);
  assert.ok(ans?.report?.title, JSON.stringify(ans));
  assert.equal(ans.report.verdict, 'entry', 'won from the signal price, lost from PO\'s open');
  assert.equal((await W.DB.get('records', r.id)).appeal.verdict, 'entry');
  assert.equal(W.store.appeals.at(-1).id, r.id);
  assert.equal(W.store.appeals.at(-1).open, 1.0802);
});

test('worker: a strategy mode already on takes the current strategy list after an update', async () => {
  const W = await loadWorker({ intelConfig: { soloMode: 'youtube', solo: ['yt_macd_zero'], soloFrames: [5], onlyFrame: null } });
  const tab = W.connectTab(86);
  await tab.send({ type: 'state', chartAsset: 'EURUSD_otc', armed: true, isDemo: true, engine: 'intel', panelMode: 'youtube', running: true, openTrades: [], assets: [] });
  assert.equal(W.store.intelConfig.solo.length, 18);
  assert.deepEqual([...W.store.intelConfig.soloFrames], [5, 15, 30, 60, 300, 600]);
});

test('«حسّن»: a duration set before that does not hold on the record goes back to the strategy\'s own (checked at start)', async () => {
  const W = await loadWorker({ intelConfig: { soloMode: 'youtube', solo: ['yt_bollinger_supertrend', 'yt_macd_zero'], soloExpiryOf: { yt_bollinger_supertrend: 300 } } });
  const tab = W.connectTab(87);
  await tab.send({ type: 'state', chartAsset: 'EURUSD_otc', armed: true, isDemo: true, engine: 'intel', panelMode: 'intel', running: true, openTrades: [], assets: [] });
  await wait(100);
  assert.deepEqual({ ...(W.store.intelConfig.soloExpiryOf || {}) }, {}, 'no record holds 5 minutes up → back to 1 minute');
});

test('worker AUTO, «استراتيجيات mostafa elashhab»: a 1-minute signal is sent at once, not after the ranking window', async () => {
  const W = await loadWorker({ intelConfig: { candleGate: { on: false }, execMode: 'AUTO', risk: { batchWindowMs: 3000 } } });
  const tab = W.connectTab(88);
  await tab.send({ type: 'state', poNow: T0 + 1, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [], limits: { minPayout: 50, stopLoss: 0 } });
  const r = makeOpp('EURUSD_otc', T0, 'CALL', { setup: 'yt_supertrend_rsi' });
  await tab.send({ type: 'decision', record: r, cand: { ...oppCand(r), setup: 'yt_supertrend_rsi', tf: 60, entryTf: 60, payout: 92, cal: { measured: false, qualified: true, raw: true, blocks: [], payout: 92 } }, poNow: T0 + 2 });
  await wait(150);
  assert.ok(tab.sent.some((m) => m.type === 'execute' && m.id === r.id), 'sent within 150 ms (the window is 3 s)');
});

test('panel: the stop loss counts from the day\'s highest point — a good morning does not hide the afternoon', () => {
  // all inside today, whatever the hour the tests run (minutes before now crossed midnight after 00:00)
  const now = Date.now(), d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const at = (min) => new Date(Math.min(now - 1000, d0.getTime() + (400 - min) * 60000)).toISOString();
  // today, demo: +700 in the morning, then −400 → still +300 for the day, but 400 below its best
  const log = [...Array(14)].map((_, i) => ({ time: at(300 - i), profit: 50, demo: true })).concat([...Array(8)].map((_, i) => ({ time: at(100 - i), profit: -50, demo: true })));
  log.push({ time: new Date(now - 86400000 * 2).toISOString(), profit: -5000, demo: true }); // another day: not counted
  log.push({ time: at(5), profit: -5000, demo: false });                                     // the other account: not counted
  const T = loadTab({ settings: { version: 8, amount: 50, stopLoss: 250, strategy: 'youtube', demoOnly: true }, log });
  const dm = vm.runInContext('dayMoney()', T.ctx);
  assert.deepEqual({ ...dm }, { net: 300, peak: 700, down: 400, n: 22 });
  assert.equal(vm.runInContext('stopLossHit()', T.ctx), true, '400 below the best ≥ 250');
  vm.runInContext('start()', T.ctx);
  assert.equal(vm.runInContext('state.running', T.ctx), false, 'Start refuses');
  assert.match(vm.runInContext('state.status', T.ctx), /stop loss/);
  vm.runInContext('state.settings.stopLoss = 500', T.ctx);
  assert.equal(vm.runInContext('stopLossHit()', T.ctx), false);
  vm.runInContext('state.settings.stopLoss = 0', T.ctx);
  assert.equal(vm.runInContext('stopLossHit()', T.ctx), false, '0 = off');
  // "I have 1683, the most it may lose is 100": set now → counts from now, and open trades are counted
  vm.runInContext('setStopLoss(100); state.settings.amount = 50', T.ctx);
  assert.equal(vm.runInContext('dayMoney().n', T.ctx), 0, 'nothing since it was set');
  assert.equal(vm.runInContext('stopLossRoom()', T.ctx), 100);
  vm.runInContext('state.trades.push({ stake: 50 })', T.ctx);
  assert.equal(vm.runInContext('stopLossRoom()', T.ctx), 50, 'one 50 trade open: 50 left — one more fits');
  vm.runInContext('state.trades.push({ stake: 50 })', T.ctx);
  assert.equal(vm.runInContext('stopLossRoom()', T.ctx), 0, 'two open: a third could pass 100 — refused');
  vm.runInContext('state.trades = []; state.log.push({ time: new Date().toISOString(), profit: -50, demo: true }, { time: new Date().toISOString(), profit: -50, demo: true })', T.ctx);
  assert.equal(vm.runInContext('stopLossHit()', T.ctx), true, 'lost 100 → stop');
});

test('panel: a trade past its end is not "open" any more; PO\'s result still lands; a manual deal never takes its id', () => {
  const T = loadTab({ settings: { version: 8, amount: 50, strategy: 'youtube', demoOnly: true } });
  const now = Date.now();
  vm.runInContext(`state.trades.push({ id: null, dir: 'call', stake: 50, expiry: 60, asset: 'EURUSD_otc', openedAt: ${now - 200000}, demo: true })`, T.ctx);
  // a deal the user opened by hand on another pair is not the bot's
  vm.runInContext(`onOrderOpened({ id: 'manual-1', asset: 'GBPUSD_otc', amount: 10 })`, T.ctx);
  assert.equal(vm.runInContext('state.trades[0].id', T.ctx), null);
  // 200 s after a 60 s trade with no result: no longer open (the panel and the at-once limit stop counting it)
  vm.runInContext('sweepTrades()', T.ctx);
  assert.equal(vm.runInContext('state.trades.length', T.ctx), 0);
  assert.equal(vm.runInContext('state.late.length', T.ctx), 1);
  // PO's closed-deals list brings its result
  vm.runInContext(`onOrderClosed([{ id: 'po-7', asset: 'EURUSD_otc', amount: 50, profit: 46 }])`, T.ctx);
  assert.equal(vm.runInContext('state.late.length', T.ctx), 0);
  assert.equal(vm.runInContext('state.log.at(-1).result', T.ctx), 'win');
});

test('panel: a reload while a trade is open keeps it — PO\'s result is still logged', () => {
  const now = Date.now();
  const T = loadTab({ settings: { version: 8, amount: 50, strategy: 'youtube', demoOnly: true } });
  vm.runInContext(`state.trades.push({ id: null, intelId: 'opp|UAHUSD_otc|15|1', dir: 'call', stake: 50, expiry: 60, asset: 'UAHUSD_otc', openedAt: ${now - 5000}, demo: true, voters: ['intel:yt_macd_zero'] })`, T.ctx);
  vm.runInContext(`onOrderOpened({ id: 'po-uah', asset: 'UAHUSD_otc', amount: 50, command: 0 })`, T.ctx);
  // the page reloads: same tab, its sessionStorage stays
  const T2 = loadTab({ settings: { version: 8, amount: 50, strategy: 'youtube', demoOnly: true }, __session: Object.fromEntries(T.session) });
  assert.equal(vm.runInContext('state.trades.length', T2.ctx), 1, 'still open after the reload');
  assert.equal(vm.runInContext('state.trades[0].id', T2.ctx), 'po-uah');
  vm.runInContext(`onOrderClosed([{ id: 'po-uah', asset: 'UAHUSD_otc', amount: 50, profit: 46 }])`, T2.ctx);
  assert.equal(vm.runInContext('state.trades.length', T2.ctx), 0);
  assert.equal(vm.runInContext('state.log.at(-1).result', T2.ctx), 'win');
  assert.equal(vm.runInContext('state.log.at(-1).dealId', T2.ctx), 'po-uah');
  // a third load does not bring it back
  const T3 = loadTab({ settings: { version: 8, amount: 50, strategy: 'youtube', demoOnly: true }, log: vm.runInContext('JSON.parse(JSON.stringify(state.log))', T2.ctx), __session: Object.fromEntries(T2.session) });
  assert.equal(vm.runInContext('state.trades.length + state.late.length', T3.ctx), 0);
});

test('panel: the stop loss is reached once not even one more trade fits (46 left, the stake is 50)', () => {
  const t = new Date().toISOString();
  const log = [-50, 46, 46, -50, 46, -50].map((p) => ({ time: t, profit: p, demo: true, result: p > 0 ? 'win' : 'loss', stake: 50 }));
  const T = loadTab({ settings: { version: 8, amount: 50, stopLoss: 100, stopLossFrom: Date.now() - 60000, strategy: 'youtube', demoOnly: true }, log });
  assert.deepEqual({ ...vm.runInContext('dayMoney()', T.ctx) }, { net: -12, peak: 42, down: 54, n: 6 });
  assert.equal(vm.runInContext('stopLossHit()', T.ctx), true, 'the bot stops and says so, instead of running without trading');
  vm.runInContext('state.settings.amount = 40', T.ctx);
  assert.equal(vm.runInContext('stopLossHit()', T.ctx), false, 'a 40 trade still fits in the 46 left');
  // an unknown result counts as lost
  vm.runInContext(`state.log.push({ time: new Date().toISOString(), profit: 0, result: 'unknown', stake: 40, demo: true })`, T.ctx);
  assert.equal(vm.runInContext('dayMoney().down', T.ctx), 94);
});

test('worker AUTO: a pair moving several times faster than its normal is not entered while it lasts', async () => {
  const W = await loadWorker({ intelConfig: { candleGate: { on: false }, execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(89);
  await tab.send({ type: 'state', poNow: T0, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [], limits: { minPayout: 50, stopLoss: 0 } });
  // 30 minutes of 1 s prices: calm, then the last 30 s five times wider
  const rows = []; let p = 1.1;
  for (let t = T0 - 1830; t < T0; t++) { p += (t % 2 ? 1 : -1) * (t >= T0 - 31 ? 0.0005 : 0.0001); rows.push({ time: t, open: p, high: p, low: p, close: p }); }
  await tab.send({ type: 'candles', asset: 'EURUSD_otc', rows, tf: 1, poNow: T0 });
  const raw = (r) => ({ ...oppCand(r), setup: 'yt_macd_zero', payout: 92, cal: { measured: false, qualified: true, raw: true, blocks: [], payout: 92 } });
  const a = makeOpp('EURUSD_otc', T0, 'CALL', { setup: 'yt_macd_zero' });
  await tab.send({ type: 'decision', record: a, cand: raw(a), poNow: T0 });
  await wait(60);
  assert.ok(!tab.sent.some((m) => m.type === 'execute' && m.id === a.id), 'not entered');
  assert.match((await W.DB.get('records', a.id)).skipReasons.join(' '), /faster than its normal/);
  // another pair (no fast moves known) is entered as usual
  const b = makeOpp('GBPUSD_otc', T0, 'PUT', { setup: 'yt_macd_zero' });
  await tab.send({ type: 'state', poNow: T0, chartAsset: 'GBPUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [], limits: { minPayout: 50, stopLoss: 0 } });
  await tab.send({ type: 'decision', record: b, cand: raw(b), poNow: T0 });
  await wait(60);
  assert.ok(tab.sent.some((m) => m.type === 'execute' && m.id === b.id));
});

test('«🔧 حسّن» by itself: after enough new results it runs, applies only what holds, and tells the panel what changed', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', autoImprove: { everyMs: 0, newResults: 3 }, risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(90);
  await tab.send({ type: 'state', poNow: T0, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [] });
  // a mode strategy with 120 trades below 50 % at its duration on both the older and the newer part → off
  for (let i = 0; i < 120; i++) { const r = makeOpp('EURUSD_otc', T0 - 100000 + i * 300, 'CALL', { setup: 'yt_williams_macd' }); r.expirySec = 60; r.entryPrice = 1; r.exits = { 60: i % 5 < 2 ? 1.001 : 0.999 }; r.exec = { action: 'paper', dir: 'CALL' }; await W.DB.put('records', r); }
  for (let i = 0; i < 3; i++) { const r = makeOpp('GBPUSD_otc', T0 + i * 60, 'CALL', { setup: 'yt_macd_zero' }); await W.DB.put('records', r); await tab.send({ type: 'tradeClosed', id: r.id, result: 'win', profit: 46, stake: 50 }); }
  await wait(150);
  assert.ok(W.store.intelConfig.soloOff.includes('yt_williams_macd'), 'switched off by itself');
  const told = tab.sent.find((m) => m.type === 'improved');
  assert.ok(told?.result.auto && told.result.changes.some((c) => c.id === 'yt_williams_macd' && c.kind === 'off'));
});

test('panel: the day\'s profit target closes the day once the money since it was set reaches it', () => {
  const T = loadTab({ settings: { version: 8, amount: 50, strategy: 'youtube', demoOnly: true } });
  vm.runInContext('setTarget(300)', T.ctx);
  vm.runInContext(`for (const p of [46, 46, -50, 46, 46, 46, 46, 46]) state.log.push({ time: new Date().toISOString(), profit: p, result: p > 0 ? 'win' : 'loss', stake: 50, demo: true })`, T.ctx);
  assert.equal(vm.runInContext('targetMoney().net', T.ctx), 272);
  assert.equal(vm.runInContext('targetHit()', T.ctx), false);
  vm.runInContext(`state.log.push({ time: new Date().toISOString(), profit: 46, result: 'win', stake: 50, demo: true })`, T.ctx);
  assert.equal(vm.runInContext('targetHit()', T.ctx), true, '+318 ≥ 300');
  vm.runInContext('start()', T.ctx);
  assert.equal(vm.runInContext('state.running', T.ctx), false);
  assert.match(vm.runInContext('state.status', T.ctx), /target/);
  vm.runInContext('setTarget(500)', T.ctx);
  assert.equal(vm.runInContext('targetHit()', T.ctx), false, 'a new target counts from when it is set');
});

test('panel: a deal PO opened that differs from what the bot clicked for stops the bot and says what differed', () => {
  const T = loadTab({ settings: { version: 8, amount: 50, strategy: 'youtube', demoOnly: true } });
  vm.runInContext('state.running = true', T.ctx);
  const push = (id) => vm.runInContext(`state.trades.push({ id: null, dir: 'call', stake: 50, expiry: 60, asset: 'EURUSD_otc', openedAt: Date.now(), demo: true }); '${id}'`, T.ctx);
  // the deal as meant: nothing happens
  push('a');
  vm.runInContext(`onOrderOpened({ id: 'ok-1', asset: 'EURUSD_otc', amount: 50, command: 0, openTimestamp: 1000, closeTimestamp: 1060, isDemo: 1 })`, T.ctx);
  assert.equal(vm.runInContext('state.badDeal', T.ctx), undefined);
  assert.equal(vm.runInContext('state.running', T.ctx), true);
  // the next click opened 100 on a 3-minute PUT: stopped, with the reasons
  push('b');
  vm.runInContext(`onOrderOpened({ id: 'bad-1', asset: 'EURUSD_otc', amount: 100, command: 1, openTimestamp: 2000, closeTimestamp: 2180, isDemo: 1 })`, T.ctx);
  assert.equal(vm.runInContext('state.running', T.ctx), false);
  const why = vm.runInContext('state.badDeal.reasons.join(" | ")', T.ctx);
  assert.match(why, /المبلغ 100 بدل 50/); assert.match(why, /بيع بدل شراء/); assert.match(why, /المدة 180 ثانية بدل 60/);
  // a manual deal on another pair long after the click is not the bot's and changes nothing
  const T2 = loadTab({ settings: { version: 8, amount: 50, strategy: 'youtube', demoOnly: true } });
  vm.runInContext(`state.running = true; state.trades.push({ id: null, dir: 'call', stake: 50, expiry: 60, asset: 'EURUSD_otc', openedAt: Date.now() - 20000, demo: true })`, T2.ctx);
  vm.runInContext(`onOrderOpened({ id: 'manual', asset: 'GBPUSD_otc', amount: 10, command: 1 })`, T2.ctx);
  assert.equal(vm.runInContext('state.running', T2.ctx), true);
});

test('worker: a strategy on trial is switched off after 4 real losses in a row, and the panel is told', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', soloOff: [], lossReview: '2026-10-05b', risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(91);
  await tab.send({ type: 'state', poNow: T0, chartAsset: 'EURUSD_otc', armed: true, running: true, engine: 'intel', panelMode: 'youtube', isDemo: true, openTrades: [], assets: [] });
  const res = ['W', 'L', 'W', 'L', 'L', 'L'];
  for (let i = 0; i < res.length; i++) { const r = makeOpp('EURUSD_otc', T0 + i * 300, 'CALL', { setup: 'yt_5candles_rev30' }); r.exec = { action: 'auto', result: res[i] }; await W.DB.put('records', r); }
  const last = makeOpp('EURUSD_otc', T0 + 6 * 300, 'CALL', { setup: 'yt_5candles_rev30' }); last.exec = { action: 'auto' }; await W.DB.put('records', last);
  await tab.send({ type: 'tradeClosed', id: last.id, result: 'loss', profit: -50, stake: 50 });
  await wait(100);
  assert.ok(W.store.intelConfig.soloOff.includes('yt_5candles_rev30'), '4 losses in a row');
  const told = tab.sent.find((m) => m.type === 'stratOff' && m.items.some((x) => x.id === 'yt_5candles_rev30'));
  assert.equal(told?.items[0].kind, 'streak'); assert.equal(told.items[0].streak, 4);
  // the other one on trial, 3 losses in a row: still on
  assert.ok(!W.store.intelConfig.soloOff.includes('yt_ichimoku_williams_5m'));
});
