// OTC Intelligence Engine — service worker.
// Multi-pair state manager: every Pocket Option tab reports its pairs here. On each
// 5M close the CALL/PUT candidates from all pairs are ranked together, the Risk
// Engine filters them, and the execution mode decides what happens:
//   OBSERVE  log only
//   PAPER    simulated trade, scored from later 5M closes          (default)
//   ALERT    desktop notification + paper tracking
//   MANUAL   dashboard asks you to confirm; the tab places the trade
//   AUTO     the tab places the trade — only for setup profiles a human promoted
//            after out-of-sample validation; everything else stays paper
importScripts('edition.js', 'indicators.js', 'engine/core.js', 'engine/dataquality.js', 'engine/features.js', 'engine/regime.js',
  'engine/factory.js', 'engine/library.js', 'engine/youtube.js', 'engine/consensus.js', 'engine/confluence.js', 'engine/contradiction.js', 'engine/risk.js',
  'engine/pipeline.js', 'engine/stats.js', 'engine/orchestrator.js', 'engine/featurelib.js', 'engine/lifecycle.js', 'engine/expiry.js', 'engine/opportunity.js', 'engine/facts.js', 'engine/calibration.js', 'engine/research.js', 'engine/postmortem.js', 'engine/integrity.js', 'ui/ar.js', 'db.js');

const TFP = OTC.TF.PRIMARY;
const extVersion = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return null; } })();
let overrides = {};
let cfg = OTC.config();
let risk = null;
let forward = {};              // promoted profile → live { w, l, t } since promotion
const tabs = new Map();        // tabId → { port, chartAsset, armed, isDemo, lastSeen, assets: Map }
const dashes = new Set();
const batches = new Map();     // candleTime → { cands, timer }
const manual = new Map();      // record id → { cand, expiresAt }
const pending = new Map();     // record id → record (live, outcome not yet known)
const events = [];
let clockOffset = 0;           // PO time − local time, seconds
let lastExec = null;           // { asset, dir, status, reason, at } — shown in the popup
let perf = new Map();          // "frame|setup|regime" → { n, lo, be } at the paper expiry
let calTables = null;          // cohort outcome tables for calibrated confidence (engine/calibration.js), sent to the tabs
let relTables = null;          // each strategy's own track record (engine/consensus.js), sent to the tabs
let calStatus = { status: 'COLLECTING', rows: [] }; // is the confidence gate honest? (monitor of entries above it)
let discDefs = [];             // discovered strategies/filters in PAPER_TEST / WATCHLIST / PROMOTED, sent to the tabs

const poNow = () => Date.now() / 1000 + clockOffset;
const note = (text, level = 'info') => {
  events.push({ at: Date.now(), text, level });
  if (events.length > 200) events.shift();
  pushDash();
};

const ready = (async () => {
  const s = await chrome.storage.local.get(['intelConfig', 'intelRisk', 'intelForward']);
  overrides = s.intelConfig || {};
  // v0.11: frames are chosen by the system; the fixed confidence threshold and the hand-made regime → family
  // table are gone (the consensus and the strategies' own records replace them)
  const dropped = ['setupFrames', 'minDeepConfidence', 'regimeFamilies'].filter((k) => k in overrides);
  if (dropped.length) { for (const k of dropped) delete overrides[k]; chrome.storage.local.set({ intelConfig: overrides }); }
  if (globalThis.PO_EDITION?.locked) overrides.execMode = 'AUTO'; // locked edition: the panel's Start is all it takes
  cfg = OTC.config(overrides);
  lossReview();
  forward = s.intelForward || {};
  risk = OTC.Risk.rollDay(s.intelRisk || OTC.Risk.newRiskState(poNow()), poNow());
  try {
    await migrateOppRecords();
    for (const r of await DB.byIndex('records', 'status', 'pending')) if (r.source === 'live') pending.set(r.id, r);
  } catch (e) { note(`IndexedDB unavailable: ${e.message}`, 'error'); }
  refreshPerf();
  await loadDiscovered();
  await loadResearch();
  if (Object.keys(cfg.soloExpiryOf || {}).length) await improveStrategies({ dropOnly: true }).catch(() => {});
  await learnConditions().catch(() => {});
})();

const saveRisk = () => chrome.storage.local.set({ intelRisk: risk });

// The loss review of 2026-10-05 (the user: "look at the signals that lose and stop them", then "keep only the strategies
// that win"): on the 330 real trades of the mode to then, only these won above break-even (52.1 %); every other strategy
// of the mode is switched off once — the losing ones and those with too few real trades to show it. [wins, trades]
// yt_stoch_cross comes back: «حسّن» had switched it off on signals that were mostly off the chart.
const LOSS_REVIEW = { at: '2026-10-05b', keep: { yt_wma_stoch_macd: [31, 45], yt_bollinger_supertrend: [19, 34], yt_stoch_cross: [19, 33], yt_ichimoku_williams: [8, 12], yt_supertrend_rsi: [5, 7], yt_williams_macd: [4, 5] } };
let reviewNews = null; // told to the first tab in the mode
function lossReview() {
  if (overrides.lossReview === LOSS_REVIEW.at) return;
  const keep = LOSS_REVIEW.keep, had = new Set(cfg.soloOff || []);
  const now = OTC.YouTube.ids().filter((id) => !keep[id] && !had.has(id)), back = Object.keys(keep).filter((id) => had.has(id));
  overrides.soloOff = [...[...had].filter((id) => !keep[id]), ...now];
  overrides.lossReview = LOSS_REVIEW.at;
  overrides.soloAutoOffLog = [...(overrides.soloAutoOffLog || []), ...now.map((id) => ({ id, at: Date.now(), review: LOSS_REVIEW.at }))].slice(-100);
  cfg = OTC.config(overrides); saveConfig();
  if (now.length || back.length) reviewNews = [{ id: 'review', kind: 'keep', n: LOSS_REVIEW.at, items: Object.keys(keep).map((id) => ({ id, name: nameOfStrategy(id), w: keep[id][0], n: keep[id][1] })), off: now.length }];
}
let pausesLoaded = false;

// Opportunity records from v0.4/v0.5 kept their outcomes in minutes (tf 60); now they are kept
// in seconds (tf 1) so seconds frames fit in. Converted once, in place.
async function migrateOppRecords() {
  const old = (await DB.byIndex('records', 'kind', 'opp')).filter((r) => r.tf === 60);
  if (!old.length) return;
  for (const r of old) {
    r.exits = Object.fromEntries(Object.entries(r.exits || {}).map(([m, v]) => [m * 60, v]));
    r.tf = 1;
    r.horizons = cfg.oppHorizonsSec.filter((h) => h >= 60);
    if (r.exec?.expiry != null) r.exec.expiry *= 60;
  }
  await DB.putMany('records', old);
  note(`Converted ${old.length} opportunity record(s) to outcomes in seconds`);
}
const saveConfig = () => chrome.storage.local.set({ intelConfig: overrides });

// Historical performance per frame+setup+regime, used to rank simultaneous candidates, and per
// frame+kind+regime at every horizon, which the tabs' expiry engine uses to pick durations.
async function refreshPerf() {
  try {
    const recs = await DB.all('records');
    const setups = recs.filter((r) => r.kind !== 'opp'), opps = recs.filter((r) => r.kind === 'opp');
    const rows = OTC.Stats.group(setups, { expiry: cfg.paperExpiry, pick: (r) => (r.setup && r.lean ? [{ key: `${r.tf || 300}|${r.setup}|${r.regime}`, dir: r.lean }] : []) });
    perf = new Map(rows.map((r) => [r.key, { n: r.n, lo: r.lo, be: r.be }]));
    calTables = OTC.Calibration.buildTables(recs, cfg);
    relTables = OTC.Consensus.buildReliability(recs, cfg);
    dataset = await datasetCoverage();
    OTC.Consensus.tables = relTables;
    const before = calStatus.status;
    calStatus = OTC.Calibration.monitor(opps, cfg);
    if (calStatus.status === 'REJECTED' && before !== 'REJECTED') {
      note('Confidence model REJECTED: entries it let through on measured evidence did not beat break-even — trading stopped', 'error');
      notify('تم إيقاف التداول', 'الفرص التي سمح بها نموذج الثقة لم تتفوق على نقطة التعادل. لن يتم التداول حتى تتحسن النتائج.', true);
    }
    broadcastConfig();
  } catch (_) {}
}
setInterval(refreshPerf, 10 * 60 * 1000);

// ── discovered strategies: live tracking and lifecycle ──────────────────────
async function loadDiscovered() {
  try { discDefs = OTC.Lifecycle.trackedDefs(OTC.Lifecycle.latest(await DB.all('strategies')), cfg.discovery); } catch (_) { discDefs = []; }
}
const removeProfiles = (id) => {
  const before = (cfg.promotedProfiles || []).length;
  overrides.promotedProfiles = (cfg.promotedProfiles || []).filter((p) => !p.startsWith(`${id}|`));
  if (overrides.promotedProfiles.length !== before) { cfg = OTC.config(overrides); saveConfig(); }
};

// Paper results of tracked strategies come from live records (record.disc lists what fired).
// A status change adds a new version row; paper numbers alone update the latest row.
async function refreshLifecycle() {
  const latest = OTC.Lifecycle.latest(await DB.all('strategies'));
  const tracked = latest.filter((r) => OTC.Lifecycle.TRACKED.includes(r.status));
  if (tracked.length) {
    const recs = (await DB.byIndex('records', 'source', 'live')).filter((r) => r.disc?.length);
    const now = Date.now();
    for (const row of tracked) {
      const res = OTC.Lifecycle.liveLifecycle(row, recs, cfg.discovery);
      if (!res) continue;
      if (res.unchanged) {
        if (JSON.stringify(row.paper_results) !== JSON.stringify(res.paper)) { row.paper_results = res.paper; await DB.put('strategies', row); }
        continue;
      }
      await DB.put('strategies', OTC.Lifecycle.nextVersion({ ...row, paper_results: res.paper }, res.status, res.reason, now));
      if (row.status === 'PROMOTED') removeProfiles(row.strategy_id);
      note(`${row.strategy_id}: ${row.status} → ${res.status} — ${res.reason}`, ['REJECTED', 'DECAYING'].includes(res.status) ? 'warn' : 'info');
      if (res.status === 'WATCHLIST' && row.status === 'PAPER_TEST') notify('نمط جديد اجتاز الاختبار', `${AR.discName(row)} — راجعه في قسم البحث. لن يُعتمد تلقائيًا.`);
    }
  }
  await loadDiscovered();
  broadcastConfig();
  pushDash();
}
setInterval(() => ready.then(refreshLifecycle).catch((e) => note(`lifecycle error: ${e.message}`, 'error')), 30 * 60 * 1000);

async function changeStatus(id, status, reason, require = null) {
  const row = OTC.Lifecycle.latest(await DB.byIndex('strategies', 'strategy_id', id))[0];
  if (!row) return note(`${id} not found`, 'warn');
  if (require && !require.includes(row.status)) return note(`${id} is ${row.status}; ${status} needs ${require.join(' or ')}`, 'warn');
  await DB.put('strategies', OTC.Lifecycle.nextVersion(row, status, reason, Date.now()));
  if (status === 'PROMOTED' && row.type === 'STRATEGY') {
    overrides.promotedProfiles = [...new Set([...(cfg.promotedProfiles || []), `${id}|*|E${row.expiry}`])];
    cfg = OTC.config(overrides); saveConfig();
  } else if (status !== 'PROMOTED') removeProfiles(id);
  note(`${id}: ${row.status} → ${status} (${reason})`);
  await loadDiscovered();
  broadcastConfig();
}

// ── tabs ─────────────────────────────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'intel-dash') return connectDash(port);
  if (port.name !== 'intel-tab' || !port.sender?.tab) return;
  const tabId = port.sender.tab.id;
  const tab = { port, chartAsset: null, armed: false, isDemo: null, lastSeen: Date.now(), assets: new Map() };
  tabs.set(tabId, tab);
  port.onMessage.addListener((m) => ready.then(() => onTabMessage(tabId, tab, m)).catch((e) => note(`tab message error: ${e.message}`, 'error')));
  port.onDisconnect.addListener(() => {
    if (tabs.get(tabId) === tab) tabs.delete(tabId);
    for (const [id, m] of manual) if (m.cand.tabId === tabId) { manual.delete(id); finishManual(id, 'tab disconnected before confirmation'); }
    note(`Tab ${tabId} disconnected${tab.chartAsset ? ` (${tab.chartAsset})` : ''}`, 'warn');
    for (const t of tabs.values()) t.scanKey = null;
    assignScan();
  });
  port.postMessage({ type: 'config', cfg: overrides, discovered: discDefs, calTables, relTables, calStatus: { status: calStatus.status } });
  pushDash();
});

// Strategy modes of the panel: "كيلتنر 10د" (one strategy, 10-minute candles, 30-minute trades) and "استراتيجيات
// يوتيوب" (the strategies from the videos the user sent, each on its own frame and duration). A tab in one of these
// modes switches the engine to it; when no tab is in a strategy mode any more, the previous settings come back.
const STRATEGY_MODES = {
  keltner: () => ({ solo: 'keltner_trend_pullback', onlyFrame: 600, soloFrames: null }),
  youtube: () => ({ solo: OTC.YouTube.ids(), onlyFrame: null, soloFrames: OTC.YouTube.frames() }),
};
function syncSolo() {
  const want = [...tabs.values()].map((t) => t.panelMode).find((m) => m in STRATEGY_MODES) || null;
  if (want && want === overrides.soloMode) {
    // the same mode, but an update may have changed its strategies or frames: take the current ones
    const fresh = STRATEGY_MODES[want](), same = (k) => JSON.stringify(fresh[k]) === JSON.stringify(overrides[k] ?? null);
    if (same('solo') && same('onlyFrame') && same('soloFrames')) return;
    Object.assign(overrides, fresh);
    cfg = OTC.config(overrides);
    saveConfig(); broadcastConfig(); pushDash();
    return note(`strategy mode ${want}: list updated (${[].concat(fresh.solo).length} strategies)`);
  }
  if (want === (overrides.soloMode || null)) return;
  if (want) {
    // remember what the user had (once), to give it back when strategy modes are left
    if (!overrides.soloPrev) overrides.soloPrev = { onlyFrame: overrides.onlyFrame ?? null, hadMax: 'maxTradeSec' in overrides, maxTradeSec: overrides.maxTradeSec ?? null };
    Object.assign(overrides, STRATEGY_MODES[want](), { soloMode: want });
    if (cfg.maxTradeSec && cfg.maxTradeSec < 1800) overrides.maxTradeSec = 1800; // the longest trades in these modes last 30 minutes
  } else {
    const prev = overrides.soloPrev || {};
    overrides.solo = null; overrides.onlyFrame = prev.onlyFrame ?? null; overrides.soloFrames = null;
    if (prev.hadMax) overrides.maxTradeSec = prev.maxTradeSec; else delete overrides.maxTradeSec;
    delete overrides.soloPrev; delete overrides.soloMode;
  }
  cfg = OTC.config(overrides);
  saveConfig(); broadcastConfig(); pushDash();
  note(want ? `strategy mode on: ${want}` : 'strategy mode off (previous settings restored)');
}

async function onTabMessage(tabId, tab, m) {
  tab.lastSeen = Date.now();
  if (m.poNow) { clockOffset = m.poNow - Date.now() / 1000; noteClock(m.poNow); }
  switch (m.type) {
    case 'hello': tab.isDemo = m.isDemo; tab.chartAsset = m.chartAsset; sendDayNet(); break;
    case 'state':
      tab.chartAsset = m.chartAsset; tab.armed = m.armed; tab.isDemo = m.isDemo;
      tab.engine = m.engine; tab.panelMode = m.panelMode || null; tab.limits = m.limits || null; tab.running = m.running; tab.openTrades = m.openTrades || []; tab.switching = !!m.switching; tab.version = m.version || null;
      syncSolo();
      if (tab.panelMode === 'youtube') {
        if (reviewNews) { try { tab.port.postMessage({ type: 'stratOff', items: reviewNews }); } catch (_) {} reviewNews = null; }
        if (!pausesLoaded) { pausesLoaded = true; DB.byIndex('records', 'kind', 'opp').then((r) => refreshPauses(r)).catch(() => {}); } // PO's clock is known now
      }
      tab.assets = new Map(m.assets.map((a) => [a.asset, a]));
      assignScan();
      maybeSwitch();
      pushDash();
      break;
    case 'candles': await onCandles(m.asset, m.rows, m.tf); break;
    case 'memory': tab.port.postMessage({ type: 'memory', reqId: m.reqId, rows: await memory(m) }); break;
    case 'hist': await histPut(m.asset, m.rows); break;                                              // the collector's pages
    case 'histPredict': tab.port.postMessage({ type: 'histPredict', reqId: m.reqId, prediction: await predictFor(m.state).catch(() => null) }); break;
    case 'decision': await onDecision(tabId, m); break;
    case 'execResult': await onExecResult(m); break;
    case 'tradeClosed': await onTradeClosed(m); break;
    case 'chatFeed': tab.port.postMessage({ type: 'chatFeed', feed: await chatFeed() }); maybeAutoImprove().catch(() => {}); break;
    case 'improve': tab.port.postMessage({ type: 'improved', result: await improveStrategies().catch((e) => ({ error: e.message })) }); break;
    case 'appeal': tab.port.postMessage({ type: 'appealResult', id: m.id, report: await appealFor(m.id).catch((e) => ({ error: e.message })) }); break;
    case 'switchResult':
      if (m.ok) note(`Tab ${tabId} chart switched to ${m.asset}`);
      else { note(`Tab ${tabId} could not open ${m.asset}: ${m.err}`, 'warn'); lastExec = { asset: m.asset, status: 'failed', reason: `could not open ${m.asset}: ${m.err}`, at: Date.now() }; }
      pushDash();
      break;
    case 'historyProgress': case 'historyDone': for (const d of dashes) d.postMessage(m); break;
  }
}

// ── scanning: one tab fetches the pairs no tab has on a chart ───────────────
function assignScan() {
  const live = [...new Set([...tabs.values()].flatMap((t) => [...t.assets.values()].filter((a) => !a.scanned).map((a) => a.asset)))].sort();
  const leaderId = [...tabs.keys()].sort((a, b) => a - b)[0];
  for (const [id, t] of tabs) {
    const role = { type: 'scanRole', leader: id === leaderId, exclude: live };
    const key = JSON.stringify(role);
    if (t.scanKey === key) continue;
    t.scanKey = key;
    try { t.port.postMessage(role); } catch (_) {}
  }
}

// ── decisions and the candidate queue ───────────────────────────────────────
const decided = new Map(); // record id → when its entry was taken (the same signal can come twice: two tabs, a re-post)
async function onDecision(tabId, { record, cand }) {
  // The same opportunity (same id) arriving again — another tab following the pair, or the tab posting it again —
  // must never overwrite an entry already acted on (2026-10-04: 10 placed trades ended up recorded as "gated"
  // or "paper", 11–35 s after they opened) nor be placed a second time (YouTube mode skips the risk duplicate guard).
  const prev = pending.get(record.id) || await DB.get('records', record.id);
  if (decided.has(record.id) || (prev?.exec && prev.exec.action && prev.exec.action !== 'none')) {
    if (cand) note(`same signal again from tab ${tabId}, ignored: ${record.id} (${prev?.exec?.action || 'taken'})`);
    return;
  }
  if (cand) { decided.set(record.id, Date.now()); if (decided.size > 2000) for (const [k, t] of decided) if (Date.now() - t > 3600e3) decided.delete(k); }
  // record times are PO's clock (≈ UTC+2h); keep the real UTC time it was logged too
  record.loggedAt = Date.now();
  record.poClockOffset = Math.round(clockOffset);
  // was the pair on a tab's chart (signals off the chart don't judge strategies: OTC.PostMortem.onChart), and how
  // fast it moved then against its own normal
  if (isOpp(record)) {
    record.chart = [...tabs.values()].some((t) => t.chartAsset === record.asset);
    record.speed = OTC.Integrity.speed(closes.get(record.asset) || new Map(), record.ts)?.ratio ?? null;
  }
  if (cfg.execMode === 'OBSERVE' || !cand) record.exec = { mode: cfg.execMode, action: 'none' };
  pending.set(record.id, record);
  await DB.put('records', record);
  resolveWithKnown(record);
  if (!cand || cfg.execMode === 'OBSERVE') return pushDash();
  cand.tabId = tabId;
  cand.originTab = tabId; // the tab whose engine found it: it is told what became of it
  cand.receivedAt = Date.now();
  // Entries closing on the same minute compete with each other.
  const key = cand.entryTime ?? cand.candleTime;
  let b = batches.get(key);
  if (!b) {
    // entries on seconds frames can't wait for a long ranking window
    // «استراتيجيات mostafa elashhab» ranks nothing (every signal goes): no window at all — waiting 2.5 s on 1-minute
    // candles put its entries 4.3 s after the signal on average (2026-10-04), against 1.6 s on faster frames
    const raw = cfg.soloMode === 'youtube' && isOpp(cand) && cand.source !== 'copy' && cand.cal?.raw === true;
    const ms = raw ? 0 : cand.source === 'copy' || (cand.entryTf ?? cand.tf ?? 300) < 60 ? cfg.risk.batchWindowFastMs ?? 250 : cfg.risk.batchWindowMs;
    b = { cands: [], timer: setTimeout(() => flush(key).catch((e) => note(`batch error: ${e.message}`, 'error')), ms) };
    batches.set(key, b);
  }
  b.cands.push(cand);
  pushDash();
}

// What became of an entry, for the tab that found it (its panel and the popup show it instead of a
// bare "enter now"): sent / placed / confirmed / failed / shadow / risk / gated / paper / alert / manual.
// One execution state per opportunity record, kept apart from how the analysis turned out:
// an analysis can be right and its execution fail.
const EXEC_STATE = { sent: 'SENT', placed: 'EXECUTED', confirmed: 'EXECUTED', unconfirmed: 'EXECUTION_FAILED', failed: 'EXECUTION_FAILED',
  shadow: 'SHADOW', othermode: 'OTHER_MODE', notarmed: 'NOT_ARMED', risk: 'PROTECTION_BLOCKED', gated: 'GATED', paper: 'PAPER', alert: 'ALERT', manual: 'AWAITING_CONFIRMATION', research: 'RESEARCH_ONLY' };
function tellTab(cand, action, detail = null) {
  const t = tabs.get(cand.originTab ?? cand.tabId);
  try { t?.port.postMessage({ type: 'oppAction', id: cand.id, action, detail }); } catch (_) {}
  if (isOpp(cand) && EXEC_STATE[action]) updateRecord(cand.id, (r) => { r.execState = EXEC_STATE[action]; r.execDetail = detail ?? null; }).catch(() => {});
}

// In AUTO/MANUAL, an entry no armed tab can place (its pair is on no armed chart, and there is no time
// to switch one) is a SHADOW trade: logged and paper-scored, but kept out of the Risk Engine, so it never
// fills the open-trade slot or the loss counters that guard the trades that can really be placed.
function executable(cand) {
  if (!['AUTO', 'MANUAL'].includes(cfg.execMode) || !isOpp(cand)) return true;
  if (execTabFor(cand) != null) return true;
  return cfg.execMode === 'AUTO' && canSwitch() && freeArmedTab(sourceOf(cand)) != null && cand.entryTime + cand.validFor - poNow() >= (cfg.switchLeadSec ?? 6);
}

async function flush(candleTime) {
  const b = batches.get(candleTime);
  batches.delete(candleTime);
  if (!b) return;
  const now = poNow(), day0 = risk.day;
  risk = OTC.Risk.rollDay(risk, now);
  if (risk.day !== day0) sendDayNet(); // a new day: the tabs' stop loss starts again
  for (const c of b.cands) c.heartbeatAge = (Date.now() - (tabs.get(c.tabId)?.lastSeen ?? 0)) / 1000;
  for (const c of b.cands.filter((x) => !executable(x))) await act(c, { shadow: true });
  b.cands = b.cands.filter(executable);
  // "استراتيجيات يوتيوب": no ranking and no protection limits — every signal goes; only the emergency stop holds
  const ytRaw = (c) => cfg.soloMode === 'youtube' && isOpp(c) && sourceOf(c) !== 'copy' && c.cal?.raw === true;
  const lim = ytLimits();
  for (const c of b.cands.filter(ytRaw)) {
    // its only limits: the emergency stop, and the panel's payout floor and daily stop loss
    const why = risk.emergency ? ['EMERGENCY', 'emergency stop'] : lim.minPayout && (c.payout ?? 0) < lim.minPayout ? ['PAYOUT', `payout ${c.payout ?? '?'}% < ${lim.minPayout}% (panel)`]
      : lim.stopHit ? ['STOP_LOSS', 'daily stop loss reached (the panel: the day\'s money that far below its best)'] : null;
    if (why) { await updateRecord(c.id, (r) => { r.decision = 'SKIP'; r.skipReasons = [...r.skipReasons, `risk: ${why[1]}`]; r.exec = { mode: cfg.execMode, action: 'risk-skip', flags: [why[0]] }; }); tellTab(c, 'risk', [why[0]]); }
    else await act(c);
  }
  b.cands = b.cands.filter((c) => !ytRaw(c));
  if (!b.cands.length) { saveRisk(); pushDash(); return; }
  const ranked = OTC.Orchestrator.rank(b.cands, cfg, now, (c) => perf.get(`${c.tf || 300}|${c.setup}|${c.regime}`) || null);
  const { selected, rejected } = OTC.Orchestrator.selectBatch(ranked, risk, cfg, now);

  for (const { cand, flags } of rejected) {
    await updateRecord(cand.id, (r) => {
      r.engineDecision = r.decision;
      r.decision = 'SKIP';
      r.skipReasons = [...r.skipReasons, ...flags.map((f) => `risk: ${f.label}`)];
      r.exec = { mode: cfg.execMode, action: 'risk-skip', flags: flags.map((f) => f.code), priority: cand.priority };
    });
    tellTab(cand, 'risk', flags.map((f) => f.code));
  }
  for (const cand of selected) await act(cand);
  if (ranked.length > 1) note(`${new Date(candleTime * 1000).toISOString().slice(11, 16)}: ${ranked.length} candidates → ${selected.map((c) => `${c.asset} ${c.dir}`).join(', ') || 'none taken'}`);
  saveRisk();
  pushDash();
}

// Opportunity entries: exec.expiry is in SECONDS (the record's exit keys, tf 1), chosen per opportunity.
// Older setup candidates: exec.expiry is in 5M candles.
const isOpp = (x) => x?.kind === 'opp';
const unitOf = (x) => (isOpp(x) ? 1 : TFP);
const untilOf = (cand, expiry) => (isOpp(cand) ? cand.entryTime + expiry : cand.candleTime + TFP + expiry * TFP);
const expiresAtOf = (cand) => (isOpp(cand) ? cand.entryTime + cand.validFor : cand.candleTime + TFP + cfg.entryWindowSec);

// An armed tab not switching already, which may switch its chart to another pair (its open trades run on: PO
// settles them whatever the chart shows).
// Entries come from the engine's own opportunities ('intel') or from verified copy signals ('copy'); a tab
// places the kind its mode is set to, or both ('both').
const sourceOf = (cand) => (cand?.source === 'copy' ? 'copy' : 'intel');
// switching a tab's chart to another pair for an entry: never while each tab keeps to its own signals (cfg.ownOnly)
const canSwitch = () => cfg.autoSwitch !== false && !cfg.ownOnly;
const places = (t, source) => t.engine === source || t.engine === 'both';
function freeArmedTab(source = 'intel') {
  const hit = [...tabs.entries()].find(([, t]) => t.armed && t.running && places(t, source) && !t.switching);
  return hit ? hit[0] : null;
}

// While a qualified opportunity WAITS (confirmation, retest, rejection) on a pair no armed tab shows,
// switch a free armed tab to it, so the pair has live prices by the entry moment. Not away from a
// chart that has its own live qualified opportunity; at most once a minute per tab.
const WAITING_STATES = ['CONFIRMED', 'WAIT_FOR_CONFIRMATION', 'WAIT_FOR_RETEST', 'WAIT_FOR_REJECTION'];
let lastSwitchCheck = 0;
function maybeSwitch() {
  if (cfg.execMode !== 'AUTO' || !canSwitch() || risk?.emergency || Date.now() - lastSwitchCheck < 3000) return;
  lastSwitchCheck = Date.now();
  const shownOnArmed = new Set([...tabs.values()].filter((t) => t.armed).map((t) => t.chartAsset));
  const now = poNow(), cands = [];
  for (const t of tabs.values()) for (const a of t.assets.values()) {
    const o = a.opp;
    if (o?.kind === 'copy' || !o?.cal?.qualified || !WAITING_STATES.includes(o.state) || shownOnArmed.has(a.asset) || o.expiresAt - now < 20) continue;
    cands.push({ asset: a.asset, o, score: (o.cal.measured ? o.cal.p : o.confidence) + (o.cal.measured ? 10 : 0) });
  }
  if (!cands.length) return;
  cands.sort((x, y) => y.score - x.score);
  for (const [tabId, t] of tabs) {
    if (!t.armed || !t.running || !places(t, 'intel') || t.switching || Date.now() - (t.switchedAt || 0) < 60000) continue;
    const own = t.assets.get(t.chartAsset)?.opp;
    if (own?.cal?.qualified && (WAITING_STATES.includes(own.state) || own.state === 'ENTER_NOW')) continue;
    const c = cands.shift();
    if (!c) break;
    t.switchedAt = Date.now();
    try { t.port.postMessage({ type: 'switchAsset', asset: c.asset }); } catch (_) { continue; }
    note(`Tab ${tabId}: switching the chart to ${c.asset} (qualified opportunity, ${c.o.state})`);
  }
}

// The tab that can place this trade: armed, with the pair on its chart (scanned pairs are on none).
function execTabFor(cand) {
  const src = sourceOf(cand);
  const own = tabs.get(cand.tabId);
  if (own && own.chartAsset === cand.asset && (places(own, src) || !own.armed)) return cand.tabId;
  if (cfg.ownOnly) return null; // another tab's signal is never placed in this one
  const hit = [...tabs.entries()].find(([, t]) => t.chartAsset === cand.asset && t.armed && places(t, src));
  return hit ? hit[0] : null;
}

async function act(cand, { shadow = false } = {}) {
  const mode = cfg.execMode;
  // The confidence gate is enforced here too: nothing below it is traded, in any mode.
  // The entry gate is enforced here too: payout ≥ gate.minPayout, a qualified opportunity, and a
  // positive expected value when it has been measured. Nothing failing it is traded, in any mode.
  // "استراتيجيات يوتيوب": the user chose no checks at all — not here either
  const rawYt = cfg.soloMode === 'youtube' && isOpp(cand) && sourceOf(cand) !== 'copy' && cand.cal?.raw === true;
  const maxO = maxOpenLimit(), nOpen = maxO > 0 ? openNow() : 0;
  // the panel's stop loss holds every entry, in every mode
  const stopHit = ytLimits().stopHit && (mode === 'AUTO' || mode === 'MANUAL') && !shadow;
  // a pair moving abnormally fast is not entered while it lasts (every mode)
  const fast = !shadow && (mode === 'AUTO' || mode === 'MANUAL') ? fastNow(cand.asset) : null;
  const targetHit = ytLimits().targetHit && (mode === 'AUTO' || mode === 'MANUAL') && !shadow;
  const pause = (mode === 'AUTO' || mode === 'MANUAL') && !shadow && pausedNow(cand.setup);
  const held = (mode === 'AUTO' || mode === 'MANUAL') && !shadow && !stopHit ? await heldBy(cand).catch(() => null) : null;
  const gateFail = stopHit ? 'daily stop loss reached (the panel)' : targetHit ? 'the day\'s profit target is reached (the panel)' : pause ? `${cand.setup} paused after ${cfg.soloPause?.streak} losses in a row (until ${new Date(paused.get(cand.setup) * 1000).toISOString().slice(11, 16)})` : held ? held : fast ? `${cand.asset} moving ${fast.ratio}× faster than its normal — not entered while it lasts` : maxO > 0 && nOpen >= maxO && (mode === 'AUTO' || mode === 'MANUAL') && !shadow ? `${nOpen} trades open already (the panel allows ${maxO} at once)` : rawYt ? null : (cand.payout ?? 0) < cfg.gate.minPayout ? `payout ${cand.payout ?? '?'}% < ${cfg.gate.minPayout}%`
    : isOpp(cand) && !cand.cal?.qualified ? 'not qualified'
    : isOpp(cand) && cand.cal?.measured && !(cand.cal.ev > 0) ? `expected value ${cand.cal.ev} ≤ 0 at ${cand.payout}% payout`
    : calStatus.status === 'REJECTED' ? 'decision model rejected' : null;
  if (gateFail) {
    tellTab(cand, 'gated', gateFail);
    return updateRecord(cand.id, (r) => { r.decision = 'SKIP'; r.skipReasons = [...r.skipReasons, `entry gate (worker): ${gateFail}`]; r.exec = { mode, action: 'gated' }; });
  }
  // protection in the strategies mode (cfg.ytProtect): no entry on a signal carrying one of the listed warnings
  const warn = rawYt && (mode === 'AUTO' || mode === 'MANUAL') && !shadow && cfg.ytProtect?.on ? protectionHit(cand) : null;
  if (warn) {
    const why = `protection: ${warn}`;
    tellTab(cand, 'gated', why);
    return updateRecord(cand.id, (r) => { r.decision = 'SKIP'; r.skipReasons = [...(r.skipReasons || []), why]; r.exec = { mode, action: 'gated' }; r.protect = warn; });
  }
  // the candle gate (cfg.candleGate): a candle pattern with the signal, then the confirmation candle — the entry is
  // taken up again at that candle's close
  if ((mode === 'AUTO' || mode === 'MANUAL') && !shadow && cfg.candleGate?.on && cfg.soloMode === 'youtube' && isOpp(cand) && sourceOf(cand) !== 'copy' && !cand.confirmed) return candleGate(cand, mode);
  const expiry = isOpp(cand) ? cand.expirySec : cfg.paperExpiry;
  const base = { mode, dir: cand.dir, expiry, priority: cand.priority, priorityParts: cand.priorityParts, originTab: cand.originTab };
  const paper = async (action, extra = {}) => {
    // shadow paper trades (pair not placeable) stay out of the Risk Engine
    if (!extra.shadow) risk = OTC.Risk.recordOpen(risk, { asset: cand.asset, dir: cand.dir, candleTime: cand.candleTime, entryTime: cand.entryTime, until: untilOf(cand, expiry) });
    const { tell = null, tellDetail = null, ...kept } = extra;
    await updateRecord(cand.id, (r) => { r.exec = { ...base, action, ...kept }; });
    tellTab(cand, tell || (extra.shadow ? 'shadow' : action), tellDetail);
  };
  const said = `${OTC.U.pairLabel(cand.asset)} · ${AR.dir(cand.dir)} · ${AR.kind(cand.facts?.kind)}${cand.payout != null ? ` · ربح ${cand.payout}%` : ''}${cand.cal?.measured ? ` · ثقة معايرة ${Math.round(cand.cal.p)}%` : ''}`;
  let execTab = execTabFor(cand);
  // AUTO: no armed tab shows the pair → an armed, free tab opens it from PO's list, if the entry window allows
  if (execTab == null && mode === 'AUTO' && canSwitch() && isOpp(cand)) {
    const free = freeArmedTab(sourceOf(cand));
    const left = cand.entryTime + cand.validFor - poNow();
    if (free != null && left >= (cfg.switchLeadSec ?? 6)) { execTab = free; cand.switch = true; }
  }
  if (shadow || (execTab == null && (mode === 'AUTO' || mode === 'MANUAL'))) {
    // The pair IS on an armed chart, but that tab places the other kind of entry: a "Copy + verify" tab
    // places copy signals only, an Intel tab the engine's own opportunities. Not "pair not open".
    const other = [...tabs.values()].find((t) => t.chartAsset === cand.asset && t.armed && !places(t, sourceOf(cand)) && t.engine !== 'legacy')?.engine;
    if (other) return paper('paper', { note: `the pair's tab is in ${other} mode: ${sourceOf(cand)} entries are not placed there`, shadow: true, otherMode: other, tell: 'othermode', tellDetail: other });
    // …or its tab was never started (Start in the panel; seen on real data: every qualified entry for hours)
    if ([...tabs.values()].some((t) => t.chartAsset === cand.asset && !t.armed)) {
      return paper('paper', { note: 'the tab showing this pair is not started (Start in its panel)', shadow: true, tell: 'notarmed' });
    }
    // a scanned pair, or a pair open in no armed tab: it can't be executed — paper it and say where it is
    // (one notification per pair every 10 minutes: seconds frames would otherwise flood them)
    if (!notifiedShadow.has(cand.asset) || Date.now() - notifiedShadow.get(cand.asset) > 600000) {
      notifiedShadow.set(cand.asset, Date.now());
      notify('فرصة مؤهلة على زوج غير مفتوح', `${said} · افتح هذا الزوج في تبويب مفعّل ليتمكن النظام من التنفيذ`);
    }
    return paper('paper', { note: 'qualified, but the pair is not on the chart of an armed tab', shadow: true });
  }
  if (execTab != null) cand.tabId = execTab;
  if (mode !== 'MANUAL') notify('فرصة جديدة', said);
  if (mode === 'PAPER') return paper('paper');
  if (mode === 'ALERT') return paper('alert');
  if (mode === 'MANUAL') {
    const left = Math.max(1, Math.round(expiresAtOf(cand) - poNow()));
    manual.set(cand.id, { cand, expiresAt: expiresAtOf(cand) });
    setTimeout(() => { if (manual.has(cand.id)) { manual.delete(cand.id); finishManual(cand.id, 'not confirmed in time'); } }, (left + 2) * 1000);
    notify('فرصة تنتظر تأكيدك', `${said} · افتح النافذة للتأكيد خلال ${left} ثانية`);
    tellTab(cand, 'manual');
    return updateRecord(cand.id, (r) => { r.exec = { ...base, action: 'awaiting-confirmation' }; });
  }
  if (mode === 'AUTO') {
    // A promoted profile trades at the expiry it was validated on.
    const profile = OTC.Stats.matchProfile({ decision: cand.dir, regime: cand.regime, strategies: cand.strategies, disc: cand.disc }, cfg.promotedProfiles, null);
    // On a demo account every engine decision is executed (real platform results, no money at risk).
    // On a real account only promoted profiles are; the tab also refuses real accounts while "demo only" is on.
    // The user decides, per account type, whether AUTO executes every engine decision or only promoted profiles.
    const isDemo = tabs.get(cand.tabId)?.isDemo;
    // "استراتيجيات يوتيوب": the user chose to enter every signal of the videos' strategies, measured or not, on any account
    const raw = cfg.soloMode === 'youtube' && isOpp(cand) && sourceOf(cand) !== 'copy' && cand.cal?.raw === true;
    const all = raw || (isDemo === true ? cfg.autoDemoAll !== false : isDemo === false ? cfg.autoRealAll === true : false);
    // a real account never trades INSUFFICIENT_DATA: only measured, positive-EV opportunities (or promoted patterns)
    if (!raw && !profile && all && isDemo === false && isOpp(cand) && !cand.cal?.measured) {
      return paper('paper', { note: 'real account: insufficient data — research only', insufficient: true, shadow: true, tell: 'research', tellDetail: 'insufficient data' });
    }
    const unproven = raw && isDemo === false && cfg.ytRealGate?.on !== false ? await ytUnproven(cand).catch((e) => `record unavailable (${e.message})`) : null;
    if (unproven) return paper('paper', { note: `real account: ${unproven} — research only`, insufficient: true, shadow: true, tell: 'research', tellDetail: unproven });
    if (!profile && all) return sendExecute(cand, { ...base, action: 'auto', note: raw ? `${isDemo ? 'demo' : 'real'}: YouTube strategies mode — entered without checks (user choice)` : `${isDemo ? 'demo' : 'real'}: all engine decisions (user setting)` });
    if (!profile) return paper('paper', { note: 'AUTO: setup not a promoted profile → paper only' });
    // profile expiries are in 5M candles
    const pe = Number(profile.split('|')[2].slice(1)) || cfg.paperExpiry;
    return sendExecute(cand, { ...base, expiry: isOpp(cand) ? pe * TFP : pe, action: 'auto', profile });
  }
}

const notifiedShadow = new Map();

// cfg.ytRealGate: why a strategy of the YouTube mode isn't proven enough for real money at this duration (null = it is).
// Its own signals (placed and paper, OTC.PostMortem.summary), counted from the signal price at cand.expirySec — off the
// chart too: AUTO switches a tab to the pair (autoSwitch), and 22 of the first 24 real trades (2026-10-05) were such
// signals (record.chart false), which a chart-only count leaves out.
let ytRecord = { at: 0, by: null };
async function ytUnproven(cand) {
  if (!ytRecord.by || Date.now() - ytRecord.at > 60000) {
    const s = OTC.PostMortem.summary(await DB.byIndex('records', 'kind', 'opp'), { minN: 0, chartOnly: false });
    ytRecord = { at: Date.now(), by: new Map(s.map((x) => [x.setup, x])) };
  }
  const exp = cand.expirySec, x = ytRecord.by.get(cand.setup)?.rate?.[exp], minN = cfg.ytRealGate?.minN ?? 75;
  const be = 100 / (100 + (cand.payout || 92));
  if (!x || x.n < minN) return `${cand.setup} has ${x?.n || 0} of ${minN} signals at ${exp}s`;
  const lo = OTC.Stats.wilson(Math.round((x.rate / 100) * x.n), x.n).lo;
  return lo > be * 100 ? null : `${cand.setup} wins ${x.rate}% of ${x.n} at ${exp}s (lower bound ${lo.toFixed(1)}% ≤ break-even ${(be * 100).toFixed(1)}%)`;
}

// Candle gate (user 2026-10-05, "teach it the candle patterns and the confirmation candle"): a mode entry needs one of
// the candle patterns with its direction on its signal candle (record.facts.pattern: engulfing, hammer, pin bar, stars,
// tweezers, strong body…), then the next candle of its own frame closing its way; it enters at that close with its own
// duration. Measured before (2026-10-05): ≈50 % for every pattern with or without confirmation on 4.7 M 5 s–1 min
// and 409 k 1–5 min pattern signals; the six strategies' chart signals 57 % entered at once, 55 % confirmed (half as
// many). The record keeps r.candleGate { pattern, price, confirmed } so the two can be compared on real trades.
const PROTECT_LABEL = { volatility: 'volatility in the top 10 %', abnormal: 'abnormal candle', exhausted: 'move looks exhausted', late: 'entry late', level_close: 'strong level just ahead' };
// the first warning of cfg.ytProtect.codes the signal carries (its label), or null
function protectionHit(cand) {
  const codes = new Set(cfg.ytProtect?.codes || []), risks = cand.facts?.risks || pending.get(cand.id)?.facts?.risks || [];
  const hit = risks.find((x) => codes.has(x.code));
  return hit ? (PROTECT_LABEL[hit.code] || hit.code) : null;
}

async function candleGate(cand, mode) {
  const G = cfg.candleGate || {}, rec = pending.get(cand.id) || await DB.get('records', cand.id).catch(() => null);
  const pattern = rec?.facts?.pattern || null;
  if (G.pattern !== false && !pattern) {
    const why = 'no candle pattern with the signal on its candle';
    tellTab(cand, 'gated', why);
    return updateRecord(cand.id, (r) => { r.decision = 'SKIP'; r.skipReasons = [...(r.skipReasons || []), `candle gate: ${why}`]; r.exec = { mode, action: 'gated' }; r.candleGate = { pattern: null }; });
  }
  cand.confirmed = true;
  // the tab waits for the next candle of the strategy's frame to close and enters at that close only if it closed
  // the signal's way (its live price: the worker's 1 s closes can come seconds late)
  if (G.confirm !== false && rec) { const frame = rec.frame || cand.tf; cand.confirm = { at: rec.ts + frame, frame, from: rec.entryPrice }; }
  await updateRecord(cand.id, (r) => { r.candleGate = { pattern, ...(cand.confirm ? { frame: cand.confirm.frame, at: cand.confirm.at } : {}) }; });
  return act(cand);
}

async function sendExecute(cand, exec) {
  const tab = tabs.get(cand.tabId);
  if (!tab) return updateRecord(cand.id, (r) => { r.exec = { ...exec, status: 'failed', reason: 'tab gone' }; });
  risk = { ...risk, acted: [...risk.acted, `${cand.asset}|${cand.candleTime}`] }; // duplicate guard before the round trip
  lastExec = { id: cand.id, asset: cand.asset, dir: cand.dir, status: 'sent', at: Date.now() };
  tellTab(cand, 'sent');
  tab.port.postMessage({ type: 'execute', id: cand.id, kind: cand.kind, source: sourceOf(cand), switch: !!cand.switch, asset: cand.asset, dir: cand.dir, candleTime: cand.candleTime, tf: cand.tf,
    entryTime: cand.entryTime, entryPrice: cand.entryPrice, entryAtr: cand.entryAtr, validFor: cand.validFor, invalidation: cand.invalidation,
    closePrice: cand.closePrice, atr: cand.atr, expirySec: (exec.expiry || cfg.paperExpiry) * unitOf(cand), setup: cand.setup, setupName: cand.setupName, fade: !!cand.fade, confirm: cand.confirm || null });
  await updateRecord(cand.id, (r) => { r.exec = { ...exec, status: 'sent' }; });
}

async function finishManual(id, reason) {
  await updateRecord(id, (r) => { r.exec = { ...(r.exec || {}), action: 'manual', status: 'expired', reason }; if (r.kind === 'opp') { r.execState = 'NOT_CONFIRMED'; r.execDetail = reason; } });
  pushDash();
}

async function onExecResult({ id, status, reason, poId, stake, demo, expirySec, timing, confirm }) {
  const rec = await updateRecord(id, (r) => {
    r.exec = { ...(r.exec || {}), status, ...(reason ? { reason } : {}), ...(poId ? { poId } : {}), ...(stake ? { stake, demo } : {}), ...(timing ? { timing } : {}) };
    if (confirm) r.candleGate = { ...(r.candleGate || {}), ...confirm }; // the confirmation candle: { price, confirmed }
    // the tab placed it with the closest duration PO offers: the trade is judged on that one
    if (expirySec && isOpp(r) && r.exec.expiry !== expirySec) { r.exec.chosenExpiry = r.exec.expiry; r.exec.expiry = expirySec; }
    if (isOpp(r) && EXEC_STATE[status]) { r.execState = EXEC_STATE[status]; r.execDetail = reason || null; }
  });
  if (!rec) return;
  if (rec.originTab != null || rec.kind === 'opp') {
    const t = tabs.get(rec.exec?.originTab) || [...tabs.values()].find((x) => x.assets.has(rec.asset));
    try { t?.port.postMessage({ type: 'oppAction', id, action: status, detail: reason || null }); } catch (_) {}
  }
  if (lastExec?.id === id || !lastExec) lastExec = { id, asset: rec.asset, dir: rec.exec?.dir, status, reason: reason || null, at: Date.now() };
  if (status === 'placed') {
    const until = isOpp(rec) ? rec.ts + rec.exec.expiry * (rec.tf || 1) : rec.candleTime + TFP + rec.exec.expiry * TFP;
    risk = OTC.Risk.recordOpen(risk, { asset: rec.asset, dir: rec.exec.dir, candleTime: rec.candleTime, entryTime: isOpp(rec) ? rec.ts : undefined, until });
    risk.open[risk.open.length - 1].placed = true; // a trade really open (the panel's number at once)
    note(`Placed ${rec.asset} ${rec.exec.dir} (${demo ? 'demo' : 'REAL'})`);
  } else if (status === 'failed') note(`Execution failed ${rec.asset}: ${reason}`, 'warn');
  else if (status === 'unconfirmed') {
    risk = { ...risk, emergency: `Pocket Option did not confirm the ${rec.asset} order — check the platform` };
    notify('تم إيقاف النظام', 'المنصة لم تؤكد صفقة. راجع Pocket Option قبل إعادة التشغيل.', true);
    note(risk.emergency, 'error');
  }
  saveRisk();
  pushDash();
}

// Execution forensics: PO's own open/close prices against what the market feed showed. delaySec: from the entry
// moment to PO's open; openSlipBp: PO's open price vs the signal price (+ = worse for the trade); closeDevBp: the
// market price at PO's close time vs PO's close price (+ = PO settled worse for the trade than the market showed).
// A systematic positive closeDevBp would be evidence of settling against open trades; one trade proves nothing.
function forensics(rec, po) {
  if (!po || !(po.openPrice > 0)) return null;
  const up = (rec.exec?.dir || rec.decision) === 'CALL' ? 1 : -1, bp = (a, b) => +(((a - b) / b) * 1e4 * up).toFixed(2);
  const m = closes.get(rec.asset), at = (ts) => { if (!m || !(ts > 0)) return null; for (const k of [Math.ceil(ts), Math.floor(ts), Math.ceil(ts) + 1]) if (m.has(k)) return m.get(k); return null; };
  const mk = at(po.closeTs), sgn = (x) => (x > 0 ? 'W' : x < 0 ? 'L' : 'T');
  return { delaySec: po.openTs && rec.ts ? +(po.openTs - rec.ts).toFixed(2) : null, openSlipBp: rec.entryPrice ? -bp(rec.entryPrice, po.openPrice) : null,
    closeDevBp: mk != null && po.closePrice > 0 ? bp(mk, po.closePrice) : null, marketAtClose: mk,
    poOutcome: po.closePrice > 0 ? sgn(up * (po.closePrice - po.openPrice)) : null, marketOutcome: mk != null ? sgn(up * (mk - po.openPrice)) : null };
}
// The YouTube mode's limits come from the panel of a tab in that mode.
function ytLimits() {
  const t = [...tabs.values()].find((x) => x.panelMode === 'youtube' && x.limits);
  return { minPayout: t?.limits.minPayout ?? 0, stopLoss: t?.limits.stopLoss ?? 0, stopHit: [...tabs.values()].some((x) => x.limits?.stopHit), targetHit: [...tabs.values()].some((x) => x.limits?.targetHit) };
}
// The panel's number of trades open at the same time, in every mode (the smallest one any tab set), and how many
// of the bot's trades are open now (what the tabs report, or the ones placed and not expired yet if that is more)
function maxOpenLimit() {
  const v = [...tabs.values()].map((x) => x.limits?.maxOpen || 0).filter((x) => x > 0);
  return v.length ? Math.min(...v) : 0;
}
const openNow = () => Math.max([...tabs.values()].reduce((n, t) => n + (t.openTrades || []).length, 0), (risk.open || []).filter((o) => o.placed && o.until > poNow()).length);
function sendDayNet() {
  const lim = ytLimits(), net = +(risk.netMoney ?? 0).toFixed(2);
  for (const t of tabs.values()) try { t.port.postMessage({ type: 'dayNet', net, stopped: !!lim.stopHit }); } catch (_) {}
}

// A strategy of the mode whose own executed trades lose (≥ minN trades, win rate below `below` % = break-even) is switched off.
// One whose last soloPause.streak real trades all lost places nothing for soloPause.min minutes after that loss.
const paused = new Map(); // strategy id → PO time (s) it may trade again
async function autoOff() {
  const { minN = 20, below = 52.1 } = cfg.soloAutoOff || {}, ids = new Set(OTC.YouTube.ids()), off = new Set(cfg.soloOff || []), by = {};
  const recs = await DB.byIndex('records', 'kind', 'opp');
  for (const r of recs) {
    if (!ids.has(r.setup) || !['W', 'L'].includes(r.exec?.result) || r.exec?.action !== 'auto') continue;
    const s = (by[r.setup] ||= [0, 0]); s[0]++; if (r.exec.result === 'W') s[1]++;
  }
  const now = Object.entries(by).filter(([id, [n, w]]) => !off.has(id) && n >= minN && (100 * w) / n < below).map(([id]) => id);
  const why = Object.fromEntries(now.map((id) => [id, { kind: 'record', n: by[id][0], w: by[id][1] }]));
  // strategies on trial: their losses in a row, or below break-even once they have enough real trades
  const G = cfg.soloGuard || {};
  for (const id of G.ids || []) {
    if (off.has(id) || now.includes(id)) continue;
    const res = recs.filter((r) => r.setup === id && ['W', 'L'].includes(r.exec?.result) && ['auto', 'manual'].includes(r.exec?.action)).sort((a, b) => a.ts - b.ts).map((r) => r.exec.result);
    let streak = 0; for (let i = res.length - 1; i >= 0 && res[i] === 'L'; i--) streak++;
    const n = res.length, w = res.filter((x) => x === 'W').length;
    if (streak >= (G.streak || 4)) { now.push(id); why[id] = { kind: 'streak', streak, n, w }; }
    else if (n >= (G.minN || 20) && (100 * w) / n < (G.below || 52.1)) { now.push(id); why[id] = { kind: 'record', n, w }; }
  }
  refreshPauses(recs, new Set([...off, ...now])); // one switched off now isn't paused as well
  if (!now.length) return;
  overrides.soloOff = [...off, ...now];
  overrides.soloAutoOffLog = [...(overrides.soloAutoOffLog || []), ...now.map((id) => ({ id, at: Date.now(), n: by[id][0], w: by[id][1] }))].slice(-100);
  cfg = OTC.config(overrides); saveConfig(); broadcastConfig(); pushDash();
  for (const id of now) note(`strategy switched off: ${id} (${why[id].kind === 'streak' ? `${why[id].streak} losses in a row` : `${why[id].w}/${why[id].n}`})`, 'warn');
  // the panel says it
  for (const t of tabs.values()) try { t.port.postMessage({ type: 'stratOff', items: now.map((id) => ({ id, name: nameOfStrategy(id), ...why[id] })) }); } catch (_) {}
}

function refreshPauses(recs, off = new Set(cfg.soloOff || [])) {
  const { streak = 4, min = 30 } = cfg.soloPause || {}, mine = new Set([].concat(cfg.solo || []));
  if (!(streak > 0 && min > 0)) { paused.clear(); return; }
  const by = {}, fresh = [];
  for (const r of recs) if (mine.has(r.setup) && !off.has(r.setup) && ['W', 'L'].includes(r.exec?.result) && ['auto', 'manual'].includes(r.exec?.action)) (by[r.setup] ||= []).push(r);
  for (const [id, rs] of Object.entries(by)) {
    const last = rs.sort((a, b) => a.ts - b.ts).slice(-streak);
    const until = last.length === streak && last.every((r) => r.exec.result === 'L') ? last.at(-1).ts + (last.at(-1).exec.expiry ?? last.at(-1).expirySec ?? 60) + min * 60 : 0;
    if (until > poNow()) { if (paused.get(id) !== until) fresh.push({ id, name: nameOfStrategy(id), kind: 'pause', streak, min, n: until }); paused.set(id, until); }
    else paused.delete(id);
  }
  for (const id of [...paused.keys()]) if (!by[id]) paused.delete(id);
  if (!fresh.length) return;
  for (const x of fresh) note(`strategy paused ${min} min: ${x.id} (${streak} losses in a row)`, 'warn');
  for (const t of tabs.values()) try { t.port.postMessage({ type: 'stratOff', items: fresh }); } catch (_) {}
}
const pausedNow = (id) => (paused.get(id) || 0) > poNow();

// Conditions at the signal that lose (OTC.PostMortem.conditions): learned from the mode's chart signals, held only
// while they lose on the older part AND the newer part of the record; plus cfg.noConflict (another strategy signalled
// the other way on the pair in the minute before: on the chart to 2026-10-05, 2 of 12 such signals won).
let learned = { blocked: [], at: 0 }, learnCount = 0;
async function learnConditions() {
  const res = OTC.PostMortem.conditions(await DB.byIndex('records', 'kind', 'opp'), { ids: OTC.YouTube.ids() });
  const was = new Set(learned.blocked.map((c) => c.k)), now = new Set(res.blocked.map((c) => c.k));
  learned = { blocked: res.blocked, at: Date.now(), n: res.n };
  chrome.storage.local.set({ learned: { at: learned.at, n: res.n, all: res.all } });
  const added = res.blocked.filter((c) => !was.has(c.k)), dropped = [...was].filter((k) => !now.has(k));
  if (!added.length && !dropped.length) return;
  note(`learned: ${added.length ? `holding ${added.map((c) => c.k).join(', ')}` : ''}${dropped.length ? ` released ${dropped.join(', ')}` : ''} (${res.n} chart signals)`, 'warn');
  const items = [...added.map((c) => ({ id: `learn:${c.k}`, kind: 'learn', name: c.ar, on: true, n: c.train.n + c.test.n, w: c.train.w + c.test.w })),
    ...dropped.map((k) => ({ id: `learn:${k}`, kind: 'learn', name: OTC.PostMortem.COND[k]?.ar || k, on: false, n: learned.at }))];
  for (const t of tabs.values()) try { t.port.postMessage({ type: 'stratOff', items }); } catch (_) {}
}
// why an entry of the mode is held by a condition (null = it goes)
async function heldBy(cand) {
  if (cfg.soloMode !== 'youtube' || !isOpp(cand)) return null;
  const rec = pending.get(cand.id) || await DB.get('records', cand.id).catch(() => null);
  if (!rec) return null;
  const before = (await DB.range('records', 'ts', rec.ts - 1500, rec.ts).catch(() => [])).filter((r) => r.kind === 'opp' && r.asset === rec.asset && r.id !== rec.id && OTC.PostMortem.onChart(r) === true).sort((a, b) => a.ts - b.ts);
  const flags = OTC.PostMortem.condFlags(rec, OTC.PostMortem.priorOf(before));
  if (cfg.noConflict && flags.includes('conflict')) return `another strategy signalled the other way on ${rec.asset} in the minute before`;
  const c = learned.blocked.find((x) => flags.includes(x.k));
  return c ? `learned: ${c.k} loses (older ${c.train.w}/${c.train.n}, newer ${c.test.w}/${c.test.n})` : null;
}

// «حسّن» (the panel's button): each strategy of the mode is checked on its own record — a duration or switching it
// off only when what the older part shows holds on the newer part (OTC.PostMortem.improve) — and that is applied.
const nameOfStrategy = (id) => (id === 'keltner_trend_pullback' ? 'كيلتنر 10د' : OTC.Strategies.get(id)?.name || id);
async function improveStrategies({ dropOnly = false } = {}) {
  const ids = [].concat(cfg.solo || []).filter(Boolean);
  if (!ids.length) return { noMode: true };
  const recs = await DB.byIndex('records', 'kind', 'opp');
  const pays = recs.slice(-300).map((r) => r.payout).filter((x) => x > 0).sort((a, b) => a - b);
  const payout = pays.length ? pays[Math.floor(pays.length / 2)] : 92;
  // each strategy is judged against its own duration, so a duration set before is kept only while it still holds
  const current = Object.fromEntries(ids.map((id) => { const m = OTC.Strategies.get(id) || {}; return [id, m.expirySec ?? cfg.frameExpirySec?.[m.frame] ?? null]; }));
  const choices = OTC.PostMortem.H.filter((h) => cfg.expiryChoices.includes(h) && (!cfg.maxTradeSec || h <= cfg.maxTradeSec));
  const res = OTC.PostMortem.improve(recs, { ids, current, off: cfg.soloOff || [], payout, choices });
  const prev = { ...(cfg.soloExpiryOf || {}) }, exp = Object.fromEntries(res.changes.filter((c) => c.kind === 'expiry').map((c) => [c.id, c.to]));
  const other = Object.fromEntries(Object.entries(prev).filter(([id]) => !ids.includes(id)));
  // a duration set before that no longer holds goes back to the strategy's own
  res.reverted = Object.keys(prev).filter((id) => ids.includes(id) && exp[id] !== prev[id]).map((id) => ({ id, from: prev[id], to: exp[id] ?? current[id] }));
  // dropOnly (the check at start): only takes back what no longer holds, adds nothing new
  if (dropOnly) { res.reverted = res.reverted.filter((r) => exp[r.id] == null); res.changes = []; }
  else res.changes = res.changes.filter((c) => c.kind === 'off' || prev[c.id] !== c.to); // a duration already in use is no news
  const keep = dropOnly ? Object.fromEntries(Object.entries(prev).filter(([id]) => !res.reverted.some((r) => r.id === id))) : { ...other, ...exp };
  const offs = res.changes.filter((c) => c.kind === 'off').map((c) => c.id);
  if (res.changes.length || res.reverted.length) {
    overrides.soloOff = [...new Set([...(cfg.soloOff || []), ...offs])];
    overrides.soloExpiryOf = keep;
    overrides.improveLog = [...(overrides.improveLog || []), { at: Date.now(), payout, changes: res.changes }].slice(-50);
    cfg = OTC.config(overrides); saveConfig(); broadcastConfig(); pushDash();
  }
  note(`improve${dropOnly ? ' (re-check)' : ''}: ${res.changes.length ? res.changes.map((c) => `${c.id} ${c.kind === 'off' ? 'off' : `${c.from}s→${c.to}s`}`).join(', ') : 'nothing new confirmed'}${res.reverted.length ? `; back to own duration: ${res.reverted.map((r) => r.id).join(', ')}` : ''} (${ids.length} strategies, payout ${payout}%)`);
  return { ...res, payout, total: ids.length, names: Object.fromEntries(ids.map((id) => [id, nameOfStrategy(id)])) };
}

// ── integrity watch: settling / targeting (from the records, every 2 minutes), pairs moving abnormally fast (from
// the 1 s prices) and PO's clock against real time ──
const clockSamples = [];
function noteClock(po) {
  const l = Date.now() / 1000, off = po - l, last = clockSamples.at(-1);
  if (last && l - last[0] < 10) { if (off > last[1]) last[1] = off; return; } // the freshest price of each 10 s
  clockSamples.push([l, off]);
  while (clockSamples.length && l - clockSamples[0][0] > 900) clockSamples.shift();
}
let integrityCache = null;
// the pair's speed now against its own normal (×3 or more = abnormally fast), from the 1 s prices
const FAST_RATIO = 3;
function fastNow(asset) { const s = OTC.Integrity.speed(closes.get(asset) || new Map(), poNow()); return s?.ratio >= FAST_RATIO ? s : null; }
async function watch() {
  if (!integrityCache || Date.now() - integrityCache.at > 120000) {
    const since = poNow() - 7 * 86400;
    integrityCache = { at: Date.now(), r: OTC.Integrity.settlement(await DB.range('records', 'ts', since, poNow() + 86400)) };
  }
  const now = poNow(), watched = new Set([...tabs.values()].flatMap((t) => [t.chartAsset, ...t.assets.keys()]).filter(Boolean)), fast = [];
  for (const a of watched) { const s = OTC.Integrity.speed(closes.get(a) || new Map(), now); if (s?.ratio >= FAST_RATIO) fast.push({ asset: a, ...s }); }
  fast.sort((x, y) => y.ratio - x.ratio);
  return { integrity: integrityCache.r, fast: fast.slice(0, 5), clock: OTC.Integrity.clockDrift(clockSamples) };
}

// «🔧 حسّن» by itself: at most every 30 minutes, once 10 more trades have a result since the last check, in a
// strategy mode. Same rules as the button (a change only when the newer part of the record confirms it); the panel
// is told only when something changed.
const AUTO_IMPROVE = { everyMs: 30 * 60000, newResults: 10 };
let autoImp = { at: Date.now(), results: 0, running: false };
async function maybeAutoImprove() {
  const ai = { ...AUTO_IMPROVE, ...(cfg.autoImprove || {}) };
  if (!cfg.soloMode || autoImp.running || Date.now() - autoImp.at < ai.everyMs || autoImp.results < ai.newResults) return;
  autoImp.running = true;
  try {
    const r = await improveStrategies();
    autoImp = { at: Date.now(), results: 0, running: false };
    if (r && !r.noMode && (r.changes?.length || r.reverted?.length)) for (const t of tabs.values()) try { t.port.postMessage({ type: 'improved', result: { ...r, auto: true } }); } catch (_) {}
  } catch (e) { autoImp.running = false; autoImp.at = Date.now(); note(`auto improve: ${e.message}`, 'warn'); }
}

// What the panel's bot tells the user: today's entries and results (with the reason of each loss), the day's tally,
// and how many pairs are being watched.
async function chatFeed() {
  const since = poNow() - 12 * 3600, recs = (await DB.range('records', 'ts', since, poNow() + 86400)).filter((r) => r.kind === 'opp' && ['auto', 'manual', 'paper'].includes(r.exec?.action) && r.exec?.status !== 'failed').sort((a, b) => a.ts - b.ts);
  const nameOf = (id) => (id === 'keltner_trend_pullback' ? 'كيلتنر 10د' : OTC.Strategies.get(id)?.name || id);
  // the chat shows executed trades only
  // `at`: the moment on this computer's clock (records keep PO's clock, which runs hours apart)
  const events = recs.filter((r) => r.exec?.action !== 'paper').slice(-8).map((r) => ({ id: r.id, ts: r.ts, at: r.ts - (r.poClockOffset ?? clockOffset), asset: r.asset, dir: r.exec?.dir || r.decision, name: nameOf(r.setup), stake: r.exec?.stake ?? null, expirySec: r.expirySec || r.exec?.expiry || 60,
    paper: r.exec?.action === 'paper', result: r.exec?.result || null, profit: r.exec?.profit ?? null, cause: r.exec?.result === 'L' ? OTC.PostMortem.analyze(r)?.cause || null : null,
    appeal: r.appeal ? { verdict: r.appeal.verdict, title: r.appeal.title, lines: r.appeal.lines } : null }));
  const done = recs.filter((r) => r.exec?.action !== 'paper' && r.exec?.result), by = {};
  for (const r of done) { const b = (by[r.setup] ||= { n: 0, net: 0 }); b.n++; b.net += Number(r.exec.profit) || 0; }
  const ranked = Object.entries(by).sort((a, b) => b[1].net - a[1].net).map(([id, v]) => ({ name: nameOf(id), net: +v.net.toFixed(2) }));
  const day = { W: done.filter((r) => r.exec.result === 'W').length, L: done.filter((r) => r.exec.result === 'L').length, net: +done.reduce((a, r) => a + (Number(r.exec.profit) || 0), 0).toFixed(2),
    best: ranked[0] || null, worst: ranked.length > 1 ? ranked[ranked.length - 1] : null };
  const pairs = new Set([...tabs.values()].flatMap((t) => [...t.assets.keys()]));
  return { events, day, pairs: pairs.size, emergency: !!risk.emergency, mode: cfg.soloMode || null, watch: await watch().catch(() => null) };
}

// «تظلّم» on a losing trade in the panel's chat: why it lost, step by step (OTC.PostMortem.appeal), kept on the record
// and in chrome.storage 'appeals' (the user's flagged trades, to review).
async function appealFor(id) {
  let rec = await DB.get('records', id);
  if (!rec) return { error: 'record not found' };
  // the market price at PO's close second may have come in after the result
  if (rec.exec?.po && rec.exec.forensics?.marketAtClose == null) rec = await updateRecord(id, (r) => { r.exec.forensics = forensics(r, r.exec.po) || r.exec.forensics; });
  const real = (await DB.byIndex('records', 'kind', 'opp')).filter((r) => r.setup === rec.setup && r.id !== id && ['W', 'L'].includes(r.exec?.result) && ['auto', 'manual'].includes(r.exec?.action) && r.ts <= rec.ts)
    .sort((a, b) => b.ts - a.ts).slice(0, 30);
  const report = OTC.PostMortem.appeal(rec, { recent: real.length ? { n: real.length, w: real.filter((r) => r.exec.result === 'W').length } : null });
  if (!report) return { error: 'not enough data on this trade' };
  const recent = real.length ? { n: real.length, w: real.filter((r) => r.exec.result === 'W').length } : null;
  await updateRecord(id, (r) => { r.appeal = { at: Date.now(), recent, ...report }; });
  const { appeals = [] } = await chrome.storage.local.get(['appeals']);
  const f = rec.exec?.forensics || {}, po = rec.exec?.po || {};
  appeals.push({ id, at: Date.now(), asset: rec.asset, setup: rec.setup, dir: rec.exec?.dir, expirySec: rec.expirySec, verdict: report.verdict,
    signal: rec.entryPrice, open: po.openPrice ?? null, close: po.closePrice ?? null, delaySec: f.delaySec ?? null, marketAtClose: f.marketAtClose ?? null });
  await chrome.storage.local.set({ appeals: appeals.slice(-300) });
  note(`appeal: ${rec.asset} ${rec.setup} → ${report.verdict}`);
  return report;
}

async function updateAppealList(rec) {
  const { appeals = [] } = await chrome.storage.local.get(['appeals']);
  const a = appeals.find((x) => x.id === rec.id); if (!a || a.verdict === rec.appeal.verdict) return;
  a.verdict = rec.appeal.verdict; a.updatedAt = Date.now();
  await chrome.storage.local.set({ appeals });
}

async function onTradeClosed({ id, result, profit, stake, po = null }) {
  const R = { win: 'W', loss: 'L', tie: 'T' }[result] || 'L'; // unknown result counts as a loss for risk
  const units = stake ? profit / stake : R === 'L' ? -1 : 0;
  const rec = await updateRecord(id, (r) => { r.exec = { ...(r.exec || {}), result: R, profit, units, raw: result, po: po || undefined, forensics: forensics(r, po) || undefined }; });
  // the market price at PO's close may arrive a few seconds later (1s closes come in batches)
  if (po && rec && rec.exec.forensics?.marketAtClose == null) setTimeout(() => updateRecord(id, (r) => { if (r.exec) r.exec.forensics = forensics(r, po) || r.exec.forensics; }).catch(() => {}), 12000);
  if (!rec) return;
  risk = OTC.Risk.recordResult(risk, { asset: rec.asset, candleTime: rec.candleTime, result: R, units, at: poNow() });
  risk = OTC.Risk.rollDay(risk, poNow());
  risk.netMoney = +((risk.netMoney ?? 0) + (Number(profit) || 0)).toFixed(2); // the day's money result (stop loss)
  sendDayNet();
  if (cfg.soloMode === 'youtube') autoOff().catch(() => {});
  if (++learnCount % 10 === 0) learnConditions().catch(() => {});
  autoImp.results++; maybeAutoImprove().catch(() => {});
  if (rec.exec.profile) trackForward(rec.exec.profile, R, rec.payout);
  saveRisk();
  pushDash();
}

// Promoted profiles keep being checked on live trades; one that falls below break-even is demoted.
function trackForward(profile, R, payout) {
  const f = (forward[profile] ||= { w: 0, l: 0, t: 0 });
  f[{ W: 'w', L: 'l', T: 't' }[R]]++;
  const n = f.w + f.l;
  if (n >= 30 && (100 * f.w) / n < OTC.U.breakEven(payout)) {
    overrides.promotedProfiles = (cfg.promotedProfiles || []).filter((p) => p !== profile);
    cfg = OTC.config(overrides);
    saveConfig();
    broadcastConfig();
    note(`Demoted ${profile}: live ${f.w}/${n} below break-even`, 'warn');
  }
  chrome.storage.local.set({ intelForward: forward });
}

// ── outcomes ─────────────────────────────────────────────────────────────────
const closes = new Map(); // asset → Map(time → close)

// Chart memory: 5s candles of pairs on a chart (and the stored 1M/5M ones), handed back to a tab that
// (re)builds a pair — after a reload PO's history often ends minutes before live candles start.
const s5Assets = new Set();
const MEMORY_STORE = { 5: 'candles_s5', 60: 'candles_m1', 300: 'candles' };
async function memory(m) {
  const store = MEMORY_STORE[m.tf];
  let rows = [];
  if (store) try { rows = (await DB.span(store, m.asset, m.from, m.to)).map(({ asset, ...c }) => c); } catch (_) {}
  return rows;
}
setInterval(() => ready.then(async () => {
  const cut = poNow() - 6 * 3600;
  for (const a of s5Assets) try {
    await histPut(a, await DB.span('candles_s5', a, -Infinity, cut)); // live candles join the research dataset first
    await DB.dropBefore('candles_s5', a, cut);
    await DB.dropBefore('hist5', a, poNow() - HIST_KEEP_SEC);
  } catch (_) {}
}), 30 * 60 * 1000);

// ── research dataset (historical replay, similarity, fingerprints) ──────────
// 5s candles in one row per pair-hour: from the collector (PO's history, pulled in the background by the scan
// leader tab) and from live charts. Research runs in the dashboard (research-worker.js) and saves a versioned
// model; the live side below answers "what followed states like this one?" from the same data.
const HIST_KEEP_SEC = 72 * 3600;
async function histPut(asset, rows) {
  if (!rows?.length) return 0;
  const byHour = new Map();
  for (const c of OTC.U.cleanRows(rows)) { if (c.time % 5) continue; const h = c.time - (c.time % 3600); (byHour.get(h) || byHour.set(h, []).get(h)).push(c); }
  for (const [t0, cs] of byHour) {
    const old = await DB.get('hist5', [asset, t0]), m = new Map();
    if (old) for (let i = 0; i < old.t.length; i++) m.set(old.t[i], [old.o[i], old.h[i], old.l[i], old.c[i]]);
    for (const c of cs) m.set(c.time, [c.open, c.high, c.low, c.close]);
    const ts = [...m.keys()].sort((a, b) => a - b);
    await DB.put('hist5', { asset, t0, t: ts, o: ts.map((t) => m.get(t)[0]), h: ts.map((t) => m.get(t)[1]), l: ts.map((t) => m.get(t)[2]), c: ts.map((t) => m.get(t)[3]) });
  }
  return byHour.size;
}
const chunkRows = (ch) => ch.t.map((t, i) => ({ time: t, open: ch.o[i], high: ch.h[i], low: ch.l[i], close: ch.c[i] }));
// How much history the research dataset holds per pair (hours of 5s, candles of 1M).
async function datasetCoverage() {
  const s5 = {}, m1 = {};
  try { for (const [a, t0] of await DB.keys('hist5')) { const x = (s5[a] ||= { hours: 0, from: t0, to: t0 }); x.hours++; x.from = Math.min(x.from, t0); x.to = Math.max(x.to, t0 + 3600); } } catch (_) {}
  try { for (const [a, t] of await DB.keys('candles_m1')) { const x = (m1[a] ||= { candles: 0, from: t, to: t }); x.candles++; x.from = Math.min(x.from, t); x.to = Math.max(x.to, t); } } catch (_) {}
  return { s5, m1, at: Date.now() };
}
let dataset = null;

// Live: the latest research model, and a similarity library per frame built from the stored history.
const live = { model: null, libs: {}, builtAt: 0, building: null };
async function loadResearch() {
  try { const all = await DB.all('research'); live.model = all.sort((a, b) => b.builtAt - a.builtAt)[0] || null; } catch (_) { live.model = null; }
}
async function buildLibraries() {
  const R = OTC.Research, since = poNow() - 48 * 3600, libs = { 5: R.library(), 60: R.library() };
  const per = {};
  // similar past states come from the same kind of market as the pair asked about (OTC by OTC, real by real)
  try { for (const ch of await DB.all('hist5')) if (ch.t0 >= since - 3600) (per[ch.asset] ||= []).push(...chunkRows(ch)); } catch (_) {}
  try { for (const c of await DB.all('candles_s5')) (per[c.asset] ||= []).push(c); } catch (_) {}
  for (const a of Object.keys(per)) if (!/_otc$/i.test(a)) delete per[a];
  for (const [a, cs] of Object.entries(per)) for (const s of R.build(cs, 5, { asset: a })) libs[5].add(s);
  const m1 = {};
  try { for (const c of await DB.all('candles_m1')) if (c.time >= poNow() - 7 * 86400 && /_otc$/i.test(c.asset)) (m1[c.asset] ||= []).push(c); } catch (_) {}
  for (const [a, cs] of Object.entries(m1)) for (const s of R.build(cs, 60, { asset: a })) libs[60].add(s);
  live.libs = libs; live.builtAt = Date.now();
}
// Continuous learning: a new research cycle every 3 hours once the dataset has grown (new data → replay →
// walk-forward + corrected tests → a new model version). Live use always takes the latest version.
let researchBusy = false;
async function researchCycle() {
  if (researchBusy) return;
  researchBusy = true;
  try {
    const cov = await datasetCoverage(), hours = Object.values(cov.s5).reduce((n, x) => n + x.hours, 0);
    if (live.model && Date.now() - live.model.builtAt < 3 * 3600 * 1000) return;
    if (live.model && hours <= (live.model.datasetHours ?? 0)) return; // nothing new to learn from
    const per5 = {}, per1 = {}, otc = (a) => /_otc$/i.test(a); // the live model learns OTC only (real-market pairs are for the audit)
    for (const ch of await DB.all('hist5')) if (otc(ch.asset)) (per5[ch.asset] ||= []).push(...chunkRows(ch));
    for (const c of await DB.all('candles_s5')) if (otc(c.asset)) (per5[c.asset] ||= []).push(c);
    for (const c of await DB.all('candles_m1')) if (otc(c.asset)) (per1[c.asset] ||= []).push(c);
    researchHours = hours;
    // off the service worker (offscreen document → research-worker.js), so live decisions never wait for it
    if (chrome.offscreen?.createDocument) {
      try { await chrome.offscreen.createDocument({ url: 'research/offscreen.html', reasons: ['WORKERS'], justification: 'research cycles (replay, similarity, strategy discovery) off the service worker' }); } catch (_) {}
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'research', payout: cfg.gate.minPayout, cfg: overrides });
      return; // researchDone (below) finishes it
    }
    const model = OTC.Research.runCycle(per5, per1, { payout: cfg.gate.minPayout }); // no offscreen API (tests): similarity only
    if (model) { model.by = 'worker'; await DB.put('research', model); await researchDone({ type: 'done', id: model.id, summary: model.summary }); }
  } catch (e) { note(`research cycle failed: ${e.message}`, 'warn'); researchBusy = false; } finally { if (!chrome.offscreen?.createDocument) researchBusy = false; }
}
let researchHours = 0;
async function researchDone(result) {
  researchBusy = false;
  try { await chrome.offscreen?.closeDocument?.(); } catch (_) {}
  if (result?.type !== 'done') { note(`research cycle: ${result?.type || 'no result'}${result?.error ? ` — ${String(result.error).split('\n')[0]}` : ''}`, 'warn'); return; }
  await loadResearch();
  if (live.model) { live.model.datasetHours = researchHours; await DB.put('research', live.model); }
  live.builtAt = 0;
  await loadDiscovered(); broadcastConfig(); // newly discovered strategies start their shadow (paper) test in the tabs
  const s = result.summary || {};
  note(`Research model ${result.id}: ${(s.validated?.[5] || 0) + (s.validated?.[60] || 0)} validated pattern(s), ${(s.significantCells?.[5]?.length || 0) + (s.significantCells?.[60]?.length || 0)} proven strength cell(s)`);
}
setInterval(() => ready.then(researchCycle), 30 * 60 * 1000);

async function predictFor(state) {
  if (!live.builtAt || Date.now() - live.builtAt > 30 * 60 * 1000) await (live.building ||= buildLibraries().finally(() => { live.building = null; }));
  const lib = live.libs[state.tf];
  if (!lib) return null;
  const rel = live.model?.reliability?.[state.tf] || null;
  const p = OTC.Research.predict(lib, rel, state, { anomalyP95: live.model?.anomalyP95?.[state.tf] ?? null });
  // the discovered patterns this state matches (validated on data it was not found on)
  p.patterns = (live.model?.patterns?.[state.tf] || []).filter((x) => x.key === state.key);
  p.model = live.model ? { id: live.model.id, builtAt: live.model.builtAt } : null;
  return p;
}

// Outcomes are read from closes keyed by candle END time: 1M candles give every minute boundary,
// larger ones their last minute, 5s ones (pairs on a chart, seconds frames) every 5 seconds, 1s ones every second.
async function onCandles(asset, rows, tf = 300) {
  if (!rows?.length) return;
  const clean = OTC.U.cleanRows(rows).filter((c) => c.time % tf === 0);
  if (tf === 60) await DB.putMany('candles_m1', clean.map((c) => ({ asset, ...c })));
  else if (tf === 300) await DB.putMany('candles', clean.map((c) => ({ asset, ...c })));
  else if (tf === 5) { await DB.putMany('candles_s5', clean.map((c) => ({ asset, ...c }))); s5Assets.add(asset); } // the chart's memory
  const m = closes.get(asset) || new Map();
  closes.set(asset, m);
  for (const c of clean) m.set(c.time + tf, c.close);
  // 1s closes (3s horizons) fill it fastest: trim in chunks, not on every batch
  if (m.size > 20000) [...m.keys()].sort((a, b) => a - b).slice(0, m.size - 16000).forEach((k) => m.delete(k));
  for (const rec of [...pending.values()]) if (rec.asset === asset) await resolveWithKnown(rec);
}

async function resolveWithKnown(rec) {
  const m = closes.get(rec.asset);
  if (!m) return;
  const before = JSON.stringify(rec.exits);
  const changed = OTC.Orchestrator.resolve(rec, m, rec.horizons || (rec.kind === 'opp' ? cfg.oppHorizonsSec.filter((h) => h >= 60) : cfg.expiries), poNow());
  const ex = rec.exec;
  let paperDone = false;
  if (ex && (ex.action === 'paper' || ex.action === 'alert') && !ex.result) {
    const pr = OTC.Orchestrator.paperResult(rec, ex.dir, ex.expiry);
    if (pr) {
      ex.result = pr.result; ex.units = pr.units;
      if (!ex.shadow) { risk = OTC.Risk.recordResult(risk, { asset: rec.asset, candleTime: rec.candleTime, result: pr.result, units: pr.units, at: poNow() }); saveRisk(); }
      paperDone = true;
    }
  }
  if (rec.status !== 'pending') pending.delete(rec.id);
  // an appeal made before the longer durations' prices came in is answered again with them
  if (rec.appeal?.pending && before !== JSON.stringify(rec.exits)) {
    const again = OTC.PostMortem.appeal(rec, { recent: rec.appeal.recent || null });
    if (again) { rec.appeal = { ...rec.appeal, ...again, updatedAt: Date.now() }; updateAppealList(rec).catch(() => {}); }
  }
  if (changed || paperDone || before !== JSON.stringify(rec.exits)) { await DB.put('records', rec); pushDash(); }
}

async function updateRecord(id, fn) {
  let rec = pending.get(id) || await DB.get('records', id);
  if (!rec) return null;
  fn(rec);
  if (rec.status === 'pending') pending.set(id, rec);
  await DB.put('records', rec);
  return rec;
}

// Records whose outcome candles never arrived (pair no longer open in any tab):
// ask a connected tab to fetch that pair's 5M history.
let lastBackfill = 0;
setInterval(() => ready.then(() => {
  if (Date.now() - lastBackfill < 10 * 60 * 1000 || !tabs.size) return;
  const now = poNow(), maxN = Math.max(...cfg.expiries), maxS = Math.max(...cfg.oppHorizonsSec);
  const due = [...pending.values()].filter((r) => (isOpp(r) ? r.ts + maxS + 60 : r.ts + (maxN + 1) * (r.tf || 300)) < now - 120);
  // records whose horizons end between minute boundaries need 5s history (seconds frames)
  const needsFive = (r) => (isOpp(r) ? (r.horizons || []).some((h) => h < 60) || r.ts % 60 !== 0 : (r.tf || 300) < 60);
  const assets = [...new Set(due.map((r) => r.asset))];
  if (!assets.length) return;
  lastBackfill = Date.now();
  const [tabId, tab] = [...tabs.entries()][0];
  for (const asset of assets.slice(0, 5)) {
    const hours = Math.min(24, Math.ceil((now - Math.min(...due.filter((r) => r.asset === asset).map((r) => r.ts))) / 3600) + 1);
    // 1M candles: every horizon of minute-frame records ends on a minute close
    tab.port.postMessage({ type: 'fetchHistory', reqId: `backfill-${Date.now()}-${asset}`, asset, hours, tf: 60 });
    if (due.some((r) => r.asset === asset && needsFive(r))) tab.port.postMessage({ type: 'fetchHistory', reqId: `backfill5-${Date.now()}-${asset}`, asset, hours: Math.min(hours, 3), tf: 5 });
  }
  note(`Backfilling outcomes for ${assets.length} pair(s) via tab ${tabId}`);
}), 60 * 1000);

// ── dashboard ────────────────────────────────────────────────────────────────
function connectDash(port) {
  dashes.add(port);
  port.onDisconnect.addListener(() => dashes.delete(port));
  port.onMessage.addListener((m) => ready.then(() => onDashMessage(port, m)).catch((e) => note(`dashboard error: ${e.message}`, 'error')));
  ready.then(() => pushDash(true));
}

function broadcastConfig() {
  for (const t of tabs.values()) try { t.port.postMessage({ type: 'config', cfg: overrides, discovered: discDefs, calTables, relTables, calStatus: { status: calStatus.status } }); } catch (_) {}
}

const LOCKED = !!globalThis.PO_EDITION?.locked;
async function onDashMessage(port, m) {
  // locked edition: its screens show, they don't change anything (the emergency stop still works)
  if (LOCKED && !['emergency', 'manualConfirm'].includes(m.type) && /^(setConfig|resetConfig|resetDay|promote|demote|disc|retire|resume|clear|delete|import|research)/i.test(m.type)) return;
  switch (m.type) {
    case 'setConfig':
      overrides = OTC.U.mergeConfig(overrides, m.patch);
      if (m.patch.execMode === 'AUTO' && !(overrides.promotedProfiles || []).length) note('AUTO mode: no promoted profiles yet, so every trade stays paper', 'warn');
      cfg = OTC.config(overrides);
      saveConfig(); broadcastConfig();
      note(`Config updated: ${Object.keys(m.patch).join(', ')}`);
      break;
    case 'resetConfig': overrides = {}; cfg = OTC.config(); saveConfig(); broadcastConfig(); note('Config reset to defaults'); break;
    case 'emergency':
      risk = { ...risk, emergency: m.on ? (m.reason || 'manual emergency stop') : null };
      saveRisk(); note(m.on ? 'EMERGENCY STOP' : 'Emergency stop cleared', m.on ? 'error' : 'info');
      break;
    case 'resetDay': risk = { ...OTC.Risk.newRiskState(poNow()), pairLast: risk.pairLast, acted: risk.acted, emergency: risk.emergency }; saveRisk(); note('Daily risk counters reset'); break;
    case 'manualConfirm': await confirmManual(m.id); break;
    case 'manualReject':
      if (manual.delete(m.id)) await updateRecord(m.id, (r) => { r.exec = { ...(r.exec || {}), action: 'manual', status: 'rejected by user' }; });
      break;
    case 'fetchHistory': {
      const entry = [...tabs.entries()].find(([, t]) => t.chartAsset === m.asset) || [...tabs.entries()][0];
      if (!entry) { port.postMessage({ type: 'historyDone', reqId: m.reqId, asset: m.asset, count: 0, error: 'no Pocket Option tab connected' }); break; }
      entry[1].port.postMessage({ type: 'fetchHistory', reqId: m.reqId, asset: m.asset, hours: m.hours, tf: m.tf || 300 });
      break;
    }
    case 'promote':
      overrides.promotedProfiles = [...new Set([...(cfg.promotedProfiles || []), m.profile])];
      cfg = OTC.config(overrides); saveConfig(); broadcastConfig(); note(`Promoted ${m.profile}`);
      break;
    case 'demote':
      overrides.promotedProfiles = (cfg.promotedProfiles || []).filter((p) => p !== m.profile);
      cfg = OTC.config(overrides); saveConfig(); broadcastConfig(); note(`Demoted ${m.profile}`);
      break;
    case 'refreshPerf': await refreshPerf(); break;
    case 'researchUpdated': await loadResearch(); live.builtAt = 0; dataset = await datasetCoverage(); pushDash(true); break;
    case 'discRefresh': await refreshLifecycle(); break;
    case 'discPromote': await changeStatus(m.id, 'PROMOTED', 'promoted by user', ['WATCHLIST']); break;
    case 'discSuspend': await changeStatus(m.id, 'SUSPENDED', 'suspended by user'); break;
    case 'discRetire': await changeStatus(m.id, 'RETIRED', 'retired by user'); break; // kept in the registry, never tracked again
    case 'discResume': await changeStatus(m.id, 'PAPER_TEST', 'paper test restarted by user', ['SUSPENDED', 'WATCHLIST', 'DECAYING', 'REJECTED', 'OUT_OF_SAMPLE', 'VALIDATING']); break;
  }
  pushDash(true);
}

async function confirmManual(id) {
  const m = manual.get(id);
  if (!m) return note('That confirmation has expired', 'warn');
  manual.delete(id);
  const now = poNow();
  if (now > m.expiresAt) return finishManual(id, 'confirmed after the entry window');
  const r = OTC.Risk.check(m.cand, risk, cfg, now);
  if (!r.ok) return updateRecord(id, (rec) => { rec.exec = { ...(rec.exec || {}), action: 'manual', status: 'risk-blocked', flags: r.flags.map((f) => f.code) }; });
  await sendExecute(m.cand, { mode: 'MANUAL', dir: m.cand.dir, expiry: isOpp(m.cand) ? m.cand.expirySec : cfg.paperExpiry, action: 'manual' });
}

let dashTimer = null;
function pushDash(now = false) {
  if (!dashes.size) return;
  if (!now) { if (!dashTimer) dashTimer = setTimeout(() => { dashTimer = null; pushDash(true); }, 500); return; }
  const pairs = [];
  for (const [tabId, t] of tabs) for (const a of t.assets.values()) {
    pairs.push({ ...a, tabId, chartAsset: t.chartAsset, armed: t.armed && t.chartAsset === a.asset, isDemo: t.isDemo, seenAgo: (Date.now() - t.lastSeen) / 1000 });
  }
  const msg = { type: 'snapshot', pairs, risk, cfg, overrides, forward, events: events.slice(-60), poNow: poNow(),
    manual: [...manual.values()].map(({ cand, expiresAt }) => ({ id: cand.id, asset: cand.asset, dir: cand.dir, setup: cand.setupName || cand.setup, deep: cand.deep, expiresAt, evidenceAgainst: cand.evidenceAgainst })),
    queue: [...batches.values()].flatMap((b) => b.cands.map((c) => ({ asset: c.asset, dir: c.dir, deep: c.deep, setup: c.setupName }))),
    pending: pending.size, tabs: tabs.size, lastExec, calStatus, calMeta: calTables ? { version: calTables.version, builtAt: calTables.builtAt, meta: calTables.meta } : null,
    relMeta: relTables ? { version: relTables.version, builtAt: relTables.builtAt, meta: relTables.meta } : null,
    dataset, research: live.model ? { id: live.model.id, builtAt: live.model.builtAt, summary: live.model.summary } : null,
    tabsInfo: [...tabs.entries()].map(([tabId, t]) => ({ tabId, chartAsset: t.chartAsset, engine: t.engine, running: t.running, armed: t.armed, switching: !!t.switching, openTrades: t.openTrades || [],
      version: t.version, stale: !!t.version && t.version !== extVersion })), version: extVersion, discTracked: discDefs.map((d) => ({ id: d.id, status: d.status, type: d.type })) };
  for (const d of dashes) try { d.postMessage(msg); } catch (_) {}
}

// cfg.ui.notify: 'browser' (silent), 'sound', 'none'. Safety notices (force) always show.
function notify(title, message, force = false) {
  const pref = cfg.ui?.notify || 'browser';
  if (pref === 'none' && !force) return;
  try { chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title, message, priority: 2, silent: pref !== 'sound' }); } catch (_) {}
}

// ── opening the dashboard ────────────────────────────────────────────────────
const openDashboard = () => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
chrome.action.onClicked.addListener(async () => {
  const [t] = await chrome.tabs.query({ url: ['https://pocketoption.com/*', 'https://po.trade/*', 'https://po.cash/*'] });
  if (!t) return chrome.tabs.create({ url: 'https://pocketoption.com/en/cabinet/' });
  await chrome.tabs.update(t.id, { active: true });
  try { await chrome.windows.update(t.windowId, { focused: true }); } catch (_) {}
  tabs.get(t.id)?.port.postMessage({ type: 'showPanel' });
});
chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'openDashboard') openDashboard();
  else if (m?.type === 'researchDone') ready.then(() => researchDone(m.result));
});
