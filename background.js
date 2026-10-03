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
importScripts('indicators.js', 'engine/core.js', 'engine/dataquality.js', 'engine/features.js', 'engine/regime.js',
  'engine/factory.js', 'engine/library.js', 'engine/confluence.js', 'engine/contradiction.js', 'engine/risk.js',
  'engine/pipeline.js', 'engine/stats.js', 'engine/orchestrator.js', 'engine/featurelib.js', 'engine/lifecycle.js', 'engine/expiry.js', 'engine/opportunity.js', 'engine/facts.js', 'engine/calibration.js', 'ui/ar.js', 'db.js');

const TFP = OTC.TF.PRIMARY;
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
  cfg = OTC.config(overrides);
  forward = s.intelForward || {};
  risk = OTC.Risk.rollDay(s.intelRisk || OTC.Risk.newRiskState(poNow()), poNow());
  try {
    await migrateOppRecords();
    for (const r of await DB.byIndex('records', 'status', 'pending')) if (r.source === 'live') pending.set(r.id, r);
  } catch (e) { note(`IndexedDB unavailable: ${e.message}`, 'error'); }
  refreshPerf();
  await loadDiscovered();
})();

const saveRisk = () => chrome.storage.local.set({ intelRisk: risk });

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
  port.postMessage({ type: 'config', cfg: overrides, discovered: discDefs, calTables, calStatus: { status: calStatus.status } });
  pushDash();
});

async function onTabMessage(tabId, tab, m) {
  tab.lastSeen = Date.now();
  if (m.poNow) clockOffset = m.poNow - Date.now() / 1000;
  switch (m.type) {
    case 'hello': tab.isDemo = m.isDemo; tab.chartAsset = m.chartAsset; break;
    case 'state':
      tab.chartAsset = m.chartAsset; tab.armed = m.armed; tab.isDemo = m.isDemo;
      tab.engine = m.engine; tab.running = m.running; tab.openTrades = m.openTrades || []; tab.switching = !!m.switching;
      tab.assets = new Map(m.assets.map((a) => [a.asset, a]));
      assignScan();
      maybeSwitch();
      pushDash();
      break;
    case 'candles': await onCandles(m.asset, m.rows, m.tf); break;
    case 'decision': await onDecision(tabId, m); break;
    case 'execResult': await onExecResult(m); break;
    case 'tradeClosed': await onTradeClosed(m); break;
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
async function onDecision(tabId, { record, cand }) {
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
    const ms = (cand.entryTf ?? cand.tf ?? 300) < 60 ? cfg.risk.batchWindowFastMs ?? 250 : cfg.risk.batchWindowMs;
    b = { cands: [], timer: setTimeout(() => flush(key).catch((e) => note(`batch error: ${e.message}`, 'error')), ms) };
    batches.set(key, b);
  }
  b.cands.push(cand);
  pushDash();
}

// What became of an entry, for the tab that found it (its panel and the popup show it instead of a
// bare "enter now"): sent / placed / confirmed / failed / shadow / risk / gated / paper / alert / manual.
function tellTab(cand, action, detail = null) {
  const t = tabs.get(cand.originTab ?? cand.tabId);
  try { t?.port.postMessage({ type: 'oppAction', id: cand.id, action, detail }); } catch (_) {}
}

// In AUTO/MANUAL, an entry no armed tab can place (its pair is on no armed chart, and there is no time
// to switch one) is a SHADOW trade: logged and paper-scored, but kept out of the Risk Engine, so it never
// fills the open-trade slot or the loss counters that guard the trades that can really be placed.
function executable(cand) {
  if (!['AUTO', 'MANUAL'].includes(cfg.execMode) || !isOpp(cand)) return true;
  if (execTabFor(cand) != null) return true;
  return cfg.execMode === 'AUTO' && cfg.autoSwitch !== false && freeArmedTab() != null && cand.entryTime + cand.validFor - poNow() >= 6;
}

async function flush(candleTime) {
  const b = batches.get(candleTime);
  batches.delete(candleTime);
  if (!b) return;
  const now = poNow();
  risk = OTC.Risk.rollDay(risk, now);
  for (const c of b.cands) c.heartbeatAge = (Date.now() - (tabs.get(c.tabId)?.lastSeen ?? 0)) / 1000;
  for (const c of b.cands.filter((x) => !executable(x))) await act(c, { shadow: true });
  b.cands = b.cands.filter(executable);
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

// An armed tab with no trade open or being placed, which may switch its chart to another pair.
function freeArmedTab() {
  const hit = [...tabs.entries()].find(([, t]) => t.armed && t.running && !t.switching && !(t.openTrades || []).length);
  return hit ? hit[0] : null;
}

// While a qualified opportunity WAITS (confirmation, retest, rejection) on a pair no armed tab shows,
// switch a free armed tab to it, so the pair has live prices by the entry moment. Not away from a
// chart that has its own live qualified opportunity; at most once a minute per tab.
const WAITING_STATES = ['CONFIRMED', 'WAIT_FOR_CONFIRMATION', 'WAIT_FOR_RETEST', 'WAIT_FOR_REJECTION'];
let lastSwitchCheck = 0;
function maybeSwitch() {
  if (cfg.execMode !== 'AUTO' || cfg.autoSwitch === false || risk?.emergency || Date.now() - lastSwitchCheck < 3000) return;
  lastSwitchCheck = Date.now();
  const shownOnArmed = new Set([...tabs.values()].filter((t) => t.armed).map((t) => t.chartAsset));
  const now = poNow(), cands = [];
  for (const t of tabs.values()) for (const a of t.assets.values()) {
    const o = a.opp;
    if (!o?.cal?.qualified || !WAITING_STATES.includes(o.state) || shownOnArmed.has(a.asset) || o.expiresAt - now < 20) continue;
    cands.push({ asset: a.asset, o, score: (o.cal.measured ? o.cal.p : o.confidence) + (o.cal.measured ? 10 : 0) });
  }
  if (!cands.length) return;
  cands.sort((x, y) => y.score - x.score);
  for (const [tabId, t] of tabs) {
    if (!t.armed || !t.running || t.switching || (t.openTrades || []).length || Date.now() - (t.switchedAt || 0) < 60000) continue;
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
  const own = tabs.get(cand.tabId);
  if (own && own.chartAsset === cand.asset) return cand.tabId;
  const hit = [...tabs.entries()].find(([, t]) => t.chartAsset === cand.asset && t.armed);
  return hit ? hit[0] : null;
}

async function act(cand, { shadow = false } = {}) {
  const mode = cfg.execMode;
  // The confidence gate is enforced here too: nothing below it is traded, in any mode.
  // The entry gate is enforced here too: payout ≥ gate.minPayout, a qualified opportunity, and a
  // measured confidence (if any) not below gate.minConfidence. Nothing failing it is traded, in any mode.
  const gateFail = (cand.payout ?? 0) < cfg.gate.minPayout ? `payout ${cand.payout ?? '?'}% < ${cfg.gate.minPayout}%`
    : isOpp(cand) && !cand.cal?.qualified ? 'not qualified'
    : isOpp(cand) && cand.cal?.measured && cand.cal.p < cfg.gate.minConfidence ? `confidence ${cand.cal.p}% < ${cfg.gate.minConfidence}%`
    : calStatus.status === 'REJECTED' ? 'confidence model rejected' : null;
  if (gateFail) {
    tellTab(cand, 'gated', gateFail);
    return updateRecord(cand.id, (r) => { r.decision = 'SKIP'; r.skipReasons = [...r.skipReasons, `entry gate (worker): ${gateFail}`]; r.exec = { mode, action: 'gated' }; });
  }
  const expiry = isOpp(cand) ? cand.expirySec : cfg.paperExpiry;
  const base = { mode, dir: cand.dir, expiry, priority: cand.priority, priorityParts: cand.priorityParts, originTab: cand.originTab };
  const paper = async (action, extra = {}) => {
    // shadow paper trades (pair not placeable) stay out of the Risk Engine
    if (!extra.shadow) risk = OTC.Risk.recordOpen(risk, { asset: cand.asset, dir: cand.dir, candleTime: cand.candleTime, entryTime: cand.entryTime, until: untilOf(cand, expiry) });
    await updateRecord(cand.id, (r) => { r.exec = { ...base, action, ...extra }; });
    tellTab(cand, extra.shadow ? 'shadow' : action);
  };
  const said = `${OTC.U.pairLabel(cand.asset)} · ${AR.dir(cand.dir)} · ${AR.kind(cand.facts?.kind)}${cand.payout != null ? ` · ربح ${cand.payout}%` : ''}${cand.cal?.measured ? ` · ثقة معايرة ${Math.round(cand.cal.p)}%` : ''}`;
  let execTab = execTabFor(cand);
  // AUTO: no armed tab shows the pair → an armed, free tab opens it from PO's list, if the entry window allows
  if (execTab == null && mode === 'AUTO' && cfg.autoSwitch !== false && isOpp(cand)) {
    const free = freeArmedTab();
    const left = cand.entryTime + cand.validFor - poNow();
    if (free != null && left >= 6) { execTab = free; cand.switch = true; }
  }
  if (shadow || (execTab == null && (mode === 'AUTO' || mode === 'MANUAL'))) {
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
    const all = isDemo === true ? cfg.autoDemoAll !== false : isDemo === false ? cfg.autoRealAll === true : false;
    if (!profile && all) return sendExecute(cand, { ...base, action: 'auto', note: `${isDemo ? 'demo' : 'real'}: all engine decisions (user setting)` });
    if (!profile) return paper('paper', { note: 'AUTO: setup not a promoted profile → paper only' });
    // profile expiries are in 5M candles
    const pe = Number(profile.split('|')[2].slice(1)) || cfg.paperExpiry;
    return sendExecute(cand, { ...base, expiry: isOpp(cand) ? pe * TFP : pe, action: 'auto', profile });
  }
}

const notifiedShadow = new Map();

async function sendExecute(cand, exec) {
  const tab = tabs.get(cand.tabId);
  if (!tab) return updateRecord(cand.id, (r) => { r.exec = { ...exec, status: 'failed', reason: 'tab gone' }; });
  risk = { ...risk, acted: [...risk.acted, `${cand.asset}|${cand.candleTime}`] }; // duplicate guard before the round trip
  lastExec = { id: cand.id, asset: cand.asset, dir: cand.dir, status: 'sent', at: Date.now() };
  tellTab(cand, 'sent');
  tab.port.postMessage({ type: 'execute', id: cand.id, kind: cand.kind, switch: !!cand.switch, asset: cand.asset, dir: cand.dir, candleTime: cand.candleTime, tf: cand.tf,
    entryTime: cand.entryTime, entryPrice: cand.entryPrice, entryAtr: cand.entryAtr, validFor: cand.validFor, invalidation: cand.invalidation,
    closePrice: cand.closePrice, atr: cand.atr, expirySec: (exec.expiry || cfg.paperExpiry) * unitOf(cand), setup: cand.setup, setupName: cand.setupName });
  await updateRecord(cand.id, (r) => { r.exec = { ...exec, status: 'sent' }; });
}

async function finishManual(id, reason) {
  await updateRecord(id, (r) => { r.exec = { ...(r.exec || {}), action: 'manual', status: 'expired', reason }; });
  pushDash();
}

async function onExecResult({ id, status, reason, poId, stake, demo, expirySec }) {
  const rec = await updateRecord(id, (r) => {
    r.exec = { ...(r.exec || {}), status, ...(reason ? { reason } : {}), ...(poId ? { poId } : {}), ...(stake ? { stake, demo } : {}) };
    // the tab placed it with the closest duration PO offers: the trade is judged on that one
    if (expirySec && isOpp(r) && r.exec.expiry !== expirySec) { r.exec.chosenExpiry = r.exec.expiry; r.exec.expiry = expirySec; }
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

async function onTradeClosed({ id, result, profit, stake }) {
  const R = { win: 'W', loss: 'L', tie: 'T' }[result] || 'L'; // unknown result counts as a loss for risk
  const units = stake ? profit / stake : R === 'L' ? -1 : 0;
  const rec = await updateRecord(id, (r) => { r.exec = { ...(r.exec || {}), result: R, profit, units, raw: result }; });
  if (!rec) return;
  risk = OTC.Risk.recordResult(risk, { asset: rec.asset, candleTime: rec.candleTime, result: R, units, at: poNow() });
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

// Outcomes are read from closes keyed by candle END time: 1M candles give every minute boundary,
// larger ones their last minute, 5s ones (pairs on a chart, seconds frames) every 5 seconds.
async function onCandles(asset, rows, tf = 300) {
  if (!rows?.length) return;
  const clean = OTC.U.cleanRows(rows).filter((c) => c.time % tf === 0);
  if (tf === 60) await DB.putMany('candles_m1', clean.map((c) => ({ asset, ...c })));
  else if (tf === 300) await DB.putMany('candles', clean.map((c) => ({ asset, ...c })));
  const m = closes.get(asset) || new Map();
  closes.set(asset, m);
  for (const c of clean) m.set(c.time + tf, c.close);
  if (m.size > 20000) [...m.keys()].sort((a, b) => a - b).slice(0, m.size - 20000).forEach((k) => m.delete(k));
  for (const rec of [...pending.values()]) if (rec.asset === asset) await resolveWithKnown(rec);
}

async function resolveWithKnown(rec) {
  const m = closes.get(rec.asset);
  if (!m) return;
  const before = JSON.stringify(rec.exits);
  const changed = OTC.Orchestrator.resolve(rec, m, rec.kind === 'opp' ? rec.horizons || cfg.oppHorizonsSec.filter((h) => h >= 60) : cfg.expiries, poNow());
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
  for (const t of tabs.values()) try { t.port.postMessage({ type: 'config', cfg: overrides, discovered: discDefs, calTables, calStatus: { status: calStatus.status } }); } catch (_) {}
}

async function onDashMessage(port, m) {
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
    case 'discRefresh': await refreshLifecycle(); break;
    case 'discPromote': await changeStatus(m.id, 'PROMOTED', 'promoted by user', ['WATCHLIST']); break;
    case 'discSuspend': await changeStatus(m.id, 'SUSPENDED', 'suspended by user'); break;
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
    pending: pending.size, tabs: tabs.size, lastExec, calStatus,
    tabsInfo: [...tabs.entries()].map(([tabId, t]) => ({ tabId, chartAsset: t.chartAsset, engine: t.engine, running: t.running, armed: t.armed, switching: !!t.switching, openTrades: t.openTrades || [] })), discTracked: discDefs.map((d) => ({ id: d.id, status: d.status, type: d.type })) };
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
chrome.action.onClicked.addListener(openDashboard);
chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'openDashboard') openDashboard(); });
