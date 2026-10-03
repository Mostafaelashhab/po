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
  const stores = { records: new Map(), candles: new Map(), candles_m1: new Map(), strategies: new Map(), discovery_runs: new Map() };
  const key = (s, o) => (s.startsWith('candles') ? `${o.asset}|${o.time}` : s === 'strategies' ? o.key : o.id);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  return {
    stores,
    put: async (s, o) => { stores[s].set(key(s, o), clone(o)); },
    putMany: async (s, arr) => { for (const o of arr) stores[s].set(key(s, o), clone(o)); },
    get: async (s, k) => (stores[s].has(k) ? clone(stores[s].get(k)) : undefined),
    all: async (s) => [...stores[s].values()].map(clone),
    byIndex: async (s, idx, v) => [...stores[s].values()].filter((o) => o[idx] === v).map(clone),
    deleteWhere: async (s, idx, v, pred = () => true) => { let n = 0; for (const [k, o] of stores[s]) if (o[idx] === v && pred(o)) { stores[s].delete(k); n++; } return n; },
    candlesFor: async (a) => [...stores.candles.values()].filter((c) => c.asset === a).sort((x, y) => x.time - y.time),
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
  const cand = { ...oppCand(rec), payout: 90 };
  await tab.send({ type: 'decision', record: rec, cand, poNow: T0 + 2 });
  await wait(60);
  let saved = await W.DB.get('records', rec.id);
  assert.equal(saved.exec.action, 'gated');
  assert.equal(saved.decision, 'SKIP');
  assert.ok(saved.skipReasons.some((r) => /payout 90% < 92%/.test(r)));
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

test('worker AUTO: a qualified entry on a pair not on any chart is sent to a free armed tab to open it first', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO', risk: { batchWindowMs: 20 } } });
  const tab = W.connectTab(51);
  await tab.send({ type: 'hello', isDemo: true, chartAsset: 'NZDUSD_otc' });
  await tab.send({ type: 'state', poNow: T0 + 1, chartAsset: 'NZDUSD_otc', armed: true, running: true, isDemo: true, openTrades: [], assets: [] });
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
  await tab2.send({ type: 'state', poNow: T0 + 27, chartAsset: 'NZDUSD_otc', armed: true, running: true, isDemo: true, openTrades: [], assets: [] });
  const rec2 = makeOpp('AUDCAD_otc', T0, 'CALL');
  await tab2.send({ type: 'decision', record: rec2, cand: oppCand(rec2), poNow: T0 + 27 });
  await wait(60);
  assert.ok(!tab2.sent.some((m) => m.type === 'execute'));
  assert.equal((await W2.DB.get('records', rec2.id)).exec.action, 'paper');
});

test('worker AUTO: while a qualified opportunity waits on another pair, a free armed tab switches to it (once a minute at most)', async () => {
  const W = await loadWorker({ intelConfig: { execMode: 'AUTO' } });
  const tab = W.connectTab(61);
  const opp = (asset, state, p, qualified = true) => ({ asset, scanned: true, opp: { state, dir: 'CALL', tf: 900, confidence: 80, expiresAt: T0 + 900, cal: { qualified, measured: false, p } } });
  const st = (assets, chartAsset = 'NZDUSD_otc', openTrades = []) => ({ type: 'state', poNow: T0, chartAsset, armed: true, running: true, isDemo: true, openTrades, assets });
  await tab.send(st([opp('AUDCAD_otc', 'WAIT_FOR_CONFIRMATION', 0), opp('GBPUSD_otc', 'WAIT_FOR_RETEST', 0, false)]));
  let sw = tab.sent.filter((m) => m.type === 'switchAsset');
  assert.equal(sw.length, 1);
  assert.equal(sw[0].asset, 'AUDCAD_otc', 'only qualified opportunities');
  await wait(3100);
  await tab.send(st([opp('EURJPY_otc', 'WAIT_FOR_CONFIRMATION', 0)]));
  assert.equal(tab.sent.filter((m) => m.type === 'switchAsset').length, 1, 'not again within a minute');
  // never with a trade open
  const W2 = await loadWorker({ intelConfig: { execMode: 'AUTO' } });
  const t2 = W2.connectTab(62);
  await t2.send(st([opp('AUDCAD_otc', 'WAIT_FOR_CONFIRMATION', 0)], 'NZDUSD_otc', [{ asset: 'NZDUSD_otc' }]));
  assert.ok(!t2.sent.some((m) => m.type === 'switchAsset'));
  // not in PAPER mode
  const W3 = await loadWorker({});
  const t3 = W3.connectTab(63);
  await t3.send(st([opp('AUDCAD_otc', 'WAIT_FOR_CONFIRMATION', 0)]));
  assert.ok(!t3.sent.some((m) => m.type === 'switchAsset'));
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

test('worker: simultaneous candidates are ranked, the weaker one is skipped by the risk engine', async () => {
  const W = await loadWorker(FAST);
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
function loadTab() {
  const winListeners = [], posted = [], portSent = [];
  const portOnMessage = listeners();
  const window = {
    addEventListener: (t, f) => { if (t === 'message') winListeners.push(f); },
    postMessage: (data) => posted.push(data),
  };
  const document = { readyState: 'loading', addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [], dispatchEvent: () => {}, body: null };
  const chrome = {
    storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } },
    runtime: { id: 'x', connect: () => ({ onMessage: portOnMessage, onDisconnect: listeners(), postMessage: (m) => portSent.push(plain(m)) }), sendMessage: () => {} },
  };
  // a timer longer than a minute in a test means something waits on real time — show where
  const st = (f, ms, ...rest) => { if (process.env.SHOW && ms > 60000) console.log('SHOW long timer', ms, new Error().stack.split('\n').slice(2, 4).join(' | ')); const t = setTimeout(f, ms, ...rest); t.unref?.(); return t; }; // the tab's own timers never keep a test alive
  const ctx = vm.createContext({ console, setTimeout: st, clearTimeout, setInterval: () => 0, Date, Math, JSON, Map, Set, Promise, window, document, chrome,
    location: { pathname: '/en/cabinet/demo-quick-high-low/' }, getComputedStyle: () => ({}), HTMLInputElement: function () {}, KeyboardEvent: function () {}, Event: function () {} });
  ctx.globalThis = ctx;
  const manifest = JSON.parse(read('manifest.json'));
  for (const f of manifest.content_scripts[1].js) vm.runInContext(read(f), ctx, { filename: f });
  const deliver = (data) => winListeners.forEach((f) => f({ source: window, data }));
  return { ctx, posted, portSent, deliver, toTab: (m) => portOnMessage.fire(m) };
}

// Replays two pairs live (history from one 1M price path, ticks walking each 1M candle).
// Minute frames only: this path is 1M data (seconds frames have their own test with 5s history).
// lag: PO's 1M history ends this many seconds before "now" (seen live: a minute or two).
async function liveRun(T, N_LIVE = 26, { lag = 0 } = {}) {
  const { OTC } = require('./load.js').load(['engine/core.js']);
  T.toTab({ type: 'config', cfg: { setupFrames: [60, 300, 900] } });
  // PO's asset list: EURUSD pays 92% (tradable), GBPUSD 85% (below the payout gate)
  vm.runInContext(`state.assets = [{ symbol: 'EURUSD_otc', payout: 92, active: true }, { symbol: 'GBPUSD_otc', payout: 85, active: true }];`, T.ctx);
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
  }
  for (const d of opps) {
    const r = d.record;
    assert.equal(r.tf, 1, 'opportunity outcomes are keyed by seconds');
    assert.ok([60, 300, 900].includes(r.frame));
    assert.ok(r.horizons.every((h) => h >= 60), 'minute-frame entries: minute horizons');
    assert.equal(r.ts % 60, 0, 'entries and lean records sit on minute closes');
    assert.ok(['ENTERED', 'GATED', 'MISSED_ENTRY', 'INVALIDATED', 'EXPIRED'].includes(r.state), r.state);
    if (r.asset === 'GBPUSD_otc') {
      // pays 85% < 92%: never an entry, but measured like one
      assert.equal(r.decision, 'SKIP');
      assert.equal(d.cand, null);
      if (r.state === 'GATED') assert.ok(r.cal.blocks.includes('payout') && r.cal.payout === 85, JSON.stringify(r.cal));
    }
    if (r.state === 'ENTERED') {
      // pays 92%, and no history yet: confidence not measured → not a veto
      assert.equal(r.asset, 'EURUSD_otc');
      assert.ok(d.cand && d.cand.kind === 'opp' && d.cand.entryTime === r.ts && d.cand.payout === 92);
      assert.ok(d.cand.cal.qualified && !d.cand.cal.measured, JSON.stringify(d.cand.cal));
      assert.equal(r.expirySec, d.cand.expirySec);
    }
    if (r.state === 'GATED' || r.state === 'ENTERED') assert.ok(OTC.DEFAULT_CONFIG.expiryChoices.includes(r.expirySec), 'every entry gets a duration, so its outcome is measured');
  }
  assert.ok(opps.some((d) => d.record.state === 'GATED' || d.record.state === 'ENTERED'), 'some opportunities reached their entry moment');
  const st = T.portSent.filter((m) => m.type === 'state' && m.assets.length === 2).pop();
  assert.ok(st, 'state for both pairs');
  for (const a of st.assets) assert.ok(a.frames && Object.keys(a.frames).length >= 2, 'per-frame view');
  assert.ok(T.portSent.some((m) => m.type === 'candles' && m.asset === 'GBPUSD_otc' && m.tf === 60));
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

test('content scripts: measured evidence of no edge, or a rejected model, blocks entries even at 92% payout', async () => {
  const T = loadTab();
  const { OTC } = require('./load.js').load(['engine/core.js']);
  // a cohort table saying every frame/kind/direction/regime has lost (38% out-of-sample)
  const kinds = ['pullback', 'retest', 'breakout', 'reversal', 'range', 'momentum', 'pattern', 'trend', 'discovered'];
  const cell = { sel: [76, 124], oos: [53, 87], folds: [[60, 100], [60, 100], [60, 100]], n: 340 };
  const entries = {};
  for (const fr of [60, 300, 900]) for (const k of kinds) for (const dir of ['CALL', 'PUT']) for (const rg of OTC.REGIMES) {
    entries[`${fr}|k:${k}|${dir}|${rg}`] = Object.fromEntries(OTC.DEFAULT_CONFIG.expiryChoices.map((sec) => [sec, cell]));
  }
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

test('content scripts: seconds frames (5s/10s/15s/30s) seeded from 5s history and driven by live ticks', async () => {
  const T = loadTab();
  const { OTC } = require('./load.js').load(['engine/core.js']);
  const N_PAST = 2400, N_LIVE = +(process.env.N_LIVE || 96); // 3h20m of 5s history (enough for 5M context), 8 live minutes
  const path = makeCandles({ start: T0 - 5 * N_PAST, tf: 5, segments: [{ n: N_PAST + N_LIVE, drift: 0.25, vol: 0.00006 }], seed: 11 });
  vm.runInContext(`state.assets = [{ symbol: 'EURUSD_otc', payout: 92, active: true }];`, T.ctx);
  T.toTab({ type: 'config', cfg: { setupFrames: [5, 10, 15, 30] } });
  let now = T0;
  const answer = async () => {
    while (T.posted.length) {
      const m = T.posted.shift();
      if (m.src !== 'POBOT_CMD' || m.kind !== 'loadHistory') continue;
      const rows = m.period === 5 ? path : OTC.U.aggregate(path, 5, m.period);
      const data = rows.filter((c) => c.time + m.period <= now && c.time < m.time && c.time >= m.time - m.offset);
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
  // a price every 2s: on a chart here
  for (let k = 0; k < 8; k++) send('AEDCNY_otc', T0 + 300 + 2 * k, 3.67 + k * 1e-4);
  await tick();
  assert.equal(F.polled, false);
  assert.ok(F.feed.lastTick && F.feed.lastTick.ts === T0 + 314);
});

test('content scripts: execution uses the closest duration PO offers (no M15 in its presets)', async () => {
  const T = loadTab();
  vm.runInContext("state.running = true; state.settings.strategy = 'intel'; state.asset = 'KESUSD_otc'; state.settings.demoOnly = false; state.assets = [{ symbol: 'KESUSD_otc', payout: 92, active: true }];", T.ctx);
  const send = (ts, price) => T.deliver({ src: 'POBOT', kind: 'frame', event: 'updateStream', text: JSON.stringify([['KESUSD_otc', ts, price]]) });
  for (let k = 0; k < 10; k++) send(T0 + 2 * k, 0.0077);
  await tick();
  T.toTab({ type: 'execute', id: 'x9', kind: 'opp', asset: 'KESUSD_otc', dir: 'CALL', entryTime: T0 + 18, entryPrice: 0.0077, entryAtr: 0.00001, validFor: 30,
    atr: 0.00002, expirySec: 900, candleTime: T0 - 42, tf: 900 });
  await wait(20);
  const r = T.portSent.filter((m) => m.type === 'execResult').pop();
  // the harness has no PO page, so setting the duration fails — but it asked for M30 (offered), not M15 (not offered)
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /could not set expiry 1800s/);
});

test('content scripts: the scan leader analyses pairs nobody has open, from 1M history only', async () => {
  const T = loadTab();
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

test('content scripts: an execute that needs another pair fails cleanly when the pair cannot be opened', async () => {
  const T = loadTab();
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

test('content scripts: intel mode keeps the legacy strategies from trading', () => {
  const T = loadTab();
  vm.runInContext("state.settings.strategy = 'intel'; state.candles = []; evaluate();", T.ctx);
  assert.equal(vm.runInContext('state.decision.reason', T.ctx), 'intel');
  assert.equal(vm.runInContext('state.decision.action', T.ctx), null);
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
