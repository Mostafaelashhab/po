// OTC Intelligence Engine — the observer inside each Pocket Option tab.
// Pairs: every pair this tab receives ticks for (open charts), and — in the one tab the worker
// makes scan leader — every other OTC pair, scanned from PO's history each minute.
// Frames: per pair, every frame is scored for readability (engine/frameselect.js); readable
// frames become setup frames, each with the context and confirmation frames chosen for it.
// Each setup frame is analysed at its own candle close. A setup becomes an OPPORTUNITY that is
// re-checked on every tick and candle close (engine/opportunity.js) until its entry moment, when
// the calibrated confidence gate decides (engine/calibration.js): ENTERED (qualified) or GATED
// (logged and measured, never traded). The expiry comes with the calibration (engine/expiry.js).
// The service worker ranks entries across pairs, applies the Risk Engine and the execution mode.
// Live pairs are driven by WebSocket ticks; scanned pairs by synthetic ticks from 1M history.
// Uses helpers from bot.js: historyRequest, setExpiry, setAmount, clickDirection,
// isDemoAccount, readPayout, finishTrade, state, poSig, copy, sigStats, pickerSeen, SIGNAL_MINUTES.
(function () {
  const Opp = OTC.Opportunity;
  const feeds = new Map(); // asset → { feed, frames: { tf → frame state }, opps: [], seededAt, seeding, ... }
  let cfg = OTC.config();
  let calTables = null;    // cohort outcome tables (engine/calibration.js), built by the worker
  let calStatus = { status: 'COLLECTING' }; // the worker's check of whether the gate is honest
  let scanRole = { leader: false, exclude: [] }; // this tab scans the pairs nobody has open
  let port = null;
  let lastBeat = 0;

  // Setup frames for one pair. Seconds frames need live ticks: a scanned pair (1M history polled
  // each minute) only gets the minute frames and up.
  const maxTrade = () => cfg.maxTradeSec || Infinity;
  // short trades: short frames — but never below 5s, the shortest frame: a 3-second trade is read from 5s candles
  const setupFrames = (F = null) => (cfg.soloFrames?.length ? cfg.soloFrames.filter((tf) => cfg.frameSelect.options[tf] && !(F?.polled && OTC.SUBMINUTE(tf)))
    : cfg.onlyFrame && cfg.frameSelect.options[cfg.onlyFrame] ? [cfg.onlyFrame] : (cfg.setupFrames?.length ? cfg.setupFrames : [300])
    .filter((tf) => cfg.frameSelect.options[tf] && !(F?.polled && OTC.SUBMINUTE(tf)) && tf <= Math.max(maxTrade(), 5)));
  // Frames whose candles the analyses need: every setup frame and every role it may be given.
  const neededFrames = (F = null) => [...new Set(setupFrames(F).flatMap((tf) => { const o = cfg.frameSelect.options[tf]; return [tf, ...o.MID, o.MACRO, ...o.TIMING]; }).filter(Boolean))];
  const anySubminute = (F) => neededFrames(F).some(OTC.SUBMINUTE);
  // What this tab places: 'intel' (the engine's own opportunities), 'copy' (verified copy signals) or 'both'.
  // 'keltner' (panel "كيلتنر 10د") places the engine's opportunities, which the worker then limits to that one strategy
  const mode = () => (state.settings.strategy === 'both' ? 'both' : state.settings.strategy === 'intel' || state.settings.strategy === 'keltner' || state.settings.strategy === 'youtube' ? 'intel' : state.settings.strategy === 'copyplus' ? 'copy' : null);
  const placesHere = (source) => mode() === 'both' || mode() === (source === 'copy' ? 'copy' : 'intel'); // what this tab may place
  const copyOn = () => placesHere('copy');
  // an entry of the "استراتيجيات يوتيوب" mode: the user chose no checks besides the strategy itself
  let dayNet = null, chatFeed = null; // the panel bot's feed from the worker // the day's money result of the bot's trades, from the worker (YouTube mode's stop loss)
  const ytRaw = (o) => cfg.soloMode === 'youtube' && !!o && o.source !== 'copy' && o.cal?.raw === true;
  const oppId = (x) => x.recId || `opp|${x.asset}|${x.tf}|${x.closeTime}`;
  // the code this tab runs (a tab not reloaded after an update keeps running the old code)
  const extVersion = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return null; } })();

  // ── service-worker connection (reconnects if the worker restarts) ─────────
  function connect() {
    if (!chrome.runtime?.id) return; // extension reloaded: this script is orphaned
    try {
      port = chrome.runtime.connect({ name: 'intel-tab' });
    } catch (_) { port = null; return; }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 3000); });
    post({ type: 'hello', isDemo: isDemoAccount(), chartAsset: state.asset });
  }
  function post(msg) {
    if (!port) return;
    try { port.postMessage(msg); } catch (_) { port = null; }
  }

  function onMessage(m) {
    if (m.type === 'config') {
      cfg = OTC.config(m.cfg);
      // entering Keltner mode: copy signals already being verified or waiting are dropped
      if (cfg.solo) { copyPending.clear(); for (const F of feeds.values()) F.opps = F.opps.filter((o) => !(o.kind === 'copy' || o.source === 'copy') || o.state === 'ENTERED'); }
      if (m.discovered) OTC.Lifecycle.setLive(m.discovered); // discovered strategies in paper test / watchlist / promoted
      if (m.calTables) calTables = m.calTables;
      if (m.relTables) OTC.Consensus.tables = m.relTables; // strategy track records: the consensus weights
      if (m.calStatus) calStatus = m.calStatus;
    }
    else if (m.type === 'scanRole') { scanRole = m; schedulePoll(); }
    else if (m.type === 'dayNet') dayNet = { net: m.net, stopped: !!m.stopped, };
    else if (m.type === 'chatFeed') { chatFeed = m.feed; globalThis.PanelChat?.update(); }
    else if (m.type === 'improved') globalThis.PanelChat?.improved?.(m.result);
    else if (m.type === 'appealResult') globalThis.PanelChat?.appealed?.(m.id, m.report);
    else if (m.type === 'stratOff') globalThis.PanelChat?.stratOff?.(m.items);
    else if (m.type === 'showPanel') globalThis.PanelChat?.show();
    else if (m.type === 'oppAction') {
      // what the worker did with an entry this tab found (executed, paper, blocked …)
      const asset = String(m.id || '').split('|')[1];
      const o = feeds.get(asset)?.opps.find((x) => oppId(x) === m.id);
      if (o) { o.action = { action: m.action, detail: m.detail ?? null, at: state.lastTick?.ts ?? null }; beat(); }
    }
    else if (m.type === 'switchAsset') switchTo(m.asset).then((err) => post({ type: 'switchResult', asset: m.asset, ok: !err, err: err || null }));
    // entries are placed one after another (one click at a time), but several trades may be open together
    else if (m.type === 'execute') {
      m.gotAt = performance.now();
      const run = () => { execQueue = execQueue.then(() => execute(m)).catch((e) => post({ type: 'execResult', id: m.id, status: 'failed', reason: String(e?.message || e) })); };
      if (m.confirm) confirmThen(m).then((ok) => ok && run()).catch((e) => post({ type: 'execResult', id: m.id, status: 'failed', reason: `confirmation candle: ${e?.message || e}` }));
      else run();
    }
    else if (m.type === 'fetchHistory') fetchHistory(m).catch(() => post({ type: 'historyDone', reqId: m.reqId, asset: m.asset, count: 0 }));
    else if (m.type === 'memory') { const f = memWait.get(m.reqId); if (f) { memWait.delete(m.reqId); f(m.rows || []); } }
    else if (m.type === 'histPredict') { const f = histWait.get(m.reqId); if (f) { histWait.delete(m.reqId); f(m.prediction); } }
  }

  // ── chart memory ───────────────────────────────────────────────────────────
  // The worker keeps the 5s candles of pairs on a chart (6 hours) and the 1M/5M ones. A pair being (re)built —
  // after a reload, or ticks resuming after a pause — asks it first: PO's history often ends minutes before
  // live candles begin, and memory has those minutes if any tab watched the pair live.
  const memWait = new Map();
  let memSeq = 0;
  function memory(asset, tf, from, to) {
    if (!port) return Promise.resolve(null);
    const reqId = `mem${++memSeq}`;
    return new Promise((resolve) => {
      const t = setTimeout(() => { memWait.delete(reqId); resolve(null); }, 3000);
      memWait.set(reqId, (rows) => { clearTimeout(t); resolve(rows); });
      post({ type: 'memory', reqId, asset, tf, from, to });
    });
  }
  // every candle of [from, to) present and complete (a partial one — unknown open — is still a hole)
  const covers = (series, from, to) => { for (let t = from; t < to; t += series.tf) { const c = series.map.get(t); if (!c || c.partial) return false; } return true; };

  // ── history ────────────────────────────────────────────────────────────────
  const SEED = { 60: 200, 300: 200, 600: 160, 900: 160, 1800: 130, 3600: 130 };
  const STORED = [60, 300, 900]; // frames whose candles the worker stores (outcomes, research); 5s ones only feed outcomes
  const SEED_5S_PAGES = 5;
  const MEMORY_TFS = [5, 60, 300]; // frames the worker remembers (chart memory)       // 5 × 1000s of 5s history (PO's page size) ≈ 83 min, so 30s frames have their context at once

  // Seconds frames: PO serves 5s history; 10s/15s/30s are built from it (only complete candles).
  function fromFive(rows, tf) {
    if (tf === 5) return rows;
    return OTC.U.aggregate(rows, 5, tf).filter((c) => rows.length && c.time >= rows[0].time);
  }
  async function seedSeconds(asset, F) {
    let cursor = Math.floor(F.feed.lastTick?.ts ?? state.lastTick?.ts ?? Date.now() / 1000), all = [];
    const mem = await memory(asset, 5, cursor - SEED_5S_PAGES * 1000, cursor);
    if (mem?.length) for (const tf of neededFrames(F).filter(OTC.SUBMINUTE)) F.feed.merge(tf, fromFive(mem, tf)); // PO's history below overrides it
    for (let i = 0; i < SEED_5S_PAGES; i++) {
      const rows = await historyRequest(asset, 5, cursor, 1000, 1);
      if (!rows?.length) break;
      all = [...rows, ...all];
      if (rows[0].time >= cursor) break;
      cursor = rows[0].time;
    }
    all = OTC.U.cleanRows(all).filter((c, i, a) => !i || c.time !== a[i - 1].time);
    if (!all.length) { F.historyMissing = [...new Set([...(F.historyMissing || []), 5])]; return; }
    for (const tf of neededFrames(F).filter(OTC.SUBMINUTE)) F.feed.merge(tf, fromFive(all, tf));
  }

  async function seed(asset) {
    const F = feeds.get(asset);
    if (!F || F.seeding) return;
    F.seeding = true;
    try {
      if (anySubminute(F)) await seedSeconds(asset, F);
      for (const tf of OTC.FEED_TFS) {
        if (OTC.SUBMINUTE(tf) || !neededFrames(F).includes(tf)) continue;
        const now = Math.floor(F.feed.lastTick?.ts ?? state.lastTick?.ts ?? Date.now() / 1000);
        if (tf === 60 || tf === 300) { const mem = await memory(asset, tf, now - tf * SEED[tf], now); if (mem?.length) F.feed.merge(tf, mem); }
        // a pair with a copy signal to verify is urgent; scanned pairs are background work
        const rows = await historyRequest(asset, tf, now, tf * SEED[tf], F.copyUntil > now ? 0 : F.polled ? 2 : 1);
        if (rows?.length) {
          F.feed.merge(tf, rows);
          if (STORED.includes(tf)) post({ type: 'candles', asset, rows: rows.slice(-SEED[tf]), tf });
        } else F.historyMissing = [...new Set([...(F.historyMissing || []), tf])];
      }
      F.seededAt = Date.now();
      selectFrames(asset);
      if (!F.polled) for (const tf of setupFrames(F)) if (!OTC.SUBMINUTE(tf)) earlyAnalysis(asset, tf, 0); // seconds frames close again in moments
    } finally { F.seeding = false; }
  }

  // Show an analysis as soon as history is in, instead of waiting for the frame's next close.
  // Its entry moment has passed, so it is recorded but never becomes an opportunity. PO's history
  // reply often lacks the candle that closed a moment ago; until it arrives the data would look stale.
  function earlyAnalysis(asset, tf, tries) {
    const F = feeds.get(asset);
    if (!F?.feed.lastTick || F.frames[tf]?.last) return; // a real close already produced an analysis
    const c = F.feed.series[tf].closed();
    const last = c[c.length - 1];
    const fresh = last && F.feed.lastTick.ts - (last.time + tf) <= tf + 5;
    if (c.length >= OTC.minCandles(cfg, tf) && fresh) {
      try { analyse(asset, tf, { full: true, early: true }); F.error = null; } catch (e) { F.error = String(e?.message || e); }
      beat();
    } else if (tries < 4) setTimeout(() => refresh(asset, tf, 3).then(() => earlyAnalysis(asset, tf, tries + 1)), 30000);
  }

  // Latest page for one timeframe — repairs the partial first candle and checks live candles against PO.
  async function refresh(asset, tf, count = 6, priority = 1) {
    const F = feeds.get(asset);
    if (!F?.feed.lastTick) return;
    if (OTC.SUBMINUTE(tf)) { // from 5s history
      const five = await historyRequest(asset, 5, Math.floor(F.feed.lastTick.ts), Math.max(60, tf * (count + 1)), priority);
      if (five?.length) { F.feed.merge(5, five); if (tf !== 5) F.feed.merge(tf, fromFive(five, tf)); }
      return;
    }
    const rows = await historyRequest(asset, tf, Math.floor(F.feed.lastTick.ts), tf * count, priority);
    if (rows?.length) {
      F.feed.merge(tf, rows);
      if (STORED.includes(tf)) post({ type: 'candles', asset, rows, tf });
    }
  }

  // Fetch exactly the missing stretch of a frame. PO's history often ends a few minutes before live candles
  // began (seen: ~3 minutes of 5s candles after a reload), so a request "up to now" may not reach it yet;
  // asking for the stretch itself, again while it is missing, fills it as soon as PO has it.
  async function refreshGap(asset, tf, gap, priority = 0) {
    const F = feeds.get(asset);
    if (!F || !gap) return;
    const base = OTC.SUBMINUTE(tf) ? 5 : tf;
    const put = (rows, fromPO) => {
      if (base === 5) { F.feed.merge(5, rows); for (const t of neededFrames(F).filter(OTC.SUBMINUTE)) if (t !== 5) F.feed.merge(t, fromFive(rows, t)); }
      else { F.feed.merge(tf, rows); if (fromPO && STORED.includes(tf)) post({ type: 'candles', asset, rows, tf }); }
    };
    if (MEMORY_TFS.includes(base)) {
      const mem = await memory(asset, base, gap.from - base, gap.to);
      if (mem?.length) put(mem, false);
      if (covers(F.feed.series[base], gap.from, gap.to)) return; // memory had the whole stretch
    }
    const rows = await historyRequest(asset, base, gap.to + base, Math.max(60, gap.to - gap.from + 2 * base), priority);
    if (rows?.length) put(rows, true);
  }

  // Dashboard/worker asked for deep history (research or resolving old records).
  async function fetchHistory({ reqId, asset, hours = 24, tf = 300 }) {
    let cursor = Math.floor(state.lastTick?.ts ?? Date.now() / 1000);
    const target = cursor - hours * 3600, PAGE = tf * 200;
    let total = 0, fails = 0;
    while (cursor > target) {
      const rows = await historyRequest(asset, tf, cursor, PAGE, 2);
      if (!rows?.length) { if (++fails >= 2) break; continue; }
      post({ type: 'candles', asset, rows, tf });
      total += rows.length;
      const oldest = rows[0].time;
      if (oldest >= cursor) break;
      cursor = oldest;
      post({ type: 'historyProgress', reqId, asset, count: total, oldest });
      await sleep(350);
    }
    post({ type: 'historyDone', reqId, asset, count: total });
  }

  function onUnsolicitedHistory(asset, res, rows) {
    const F = feeds.get(asset);
    if (F && res && F.feed.series[res]) F.feed.merge(res, rows);
  }

  // ── platform signals and copy trades as evidence modules ──────────────────
  function atrOf(F, tf, n = 14) {
    const c = F.feed.series[tf]?.closed(n + 1) || [];
    if (c.length < 3) return null;
    let s = 0;
    for (let i = 1; i < c.length; i++) s += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    return s / (c.length - 1);
  }

  function copyFor(asset, nowTs) {
    const F = feeds.get(asset);
    const hist = copy.hist?.[asset];
    if (!hist?.length) return null;
    return OTC.CopyTrade.evaluate(hist, { now: nowTs, price: F?.feed.lastTick?.price ?? null, atr: F ? atrOf(F, 60) : null });
  }

  // A platform signal counts only once the bot's own measurements show it predicts something: at least
  // 100 measured cases for that horizon and code, and the lower bound (90%) of the measured hit rate above
  // 50% in one direction — which also gives its direction, whatever the code was guessed to mean.
  // Unproven codes are still measured (bot.js), just not used.
  const SIGNAL_MIN_N = 100;
  function signalFor(asset, nowTs) {
    const slot = poSig.byAsset[asset];
    if (slot) {
      for (const min of SIGNAL_MINUTES) {
        const x = slot[min];
        if (!x || x.code <= 0 || x.changedAt == null || nowTs - x.changedAt > 60) continue;
        const st = sigStats[`*|${min}|${x.code}`], n = st ? st.up + st.down : 0;
        if (n < SIGNAL_MIN_N) continue;
        const upLo = OTC.Stats.wilson(st.up, n).lo, downLo = OTC.Stats.wilson(st.down, n).lo;
        const dir = upLo > 50 ? 'CALL' : downLo > 50 ? 'PUT' : null;
        if (!dir) continue;
        const lo = Math.max(upLo, downLo);
        return { dir, source: `PO signal ${min}m code ${x.code}`, confidence: Math.round(Math.min(65, lo + 5)), note: `measured ${Math.round((100 * (dir === 'CALL' ? st.up : st.down)) / n)}% of ${n}` };
      }
    }
    // Copy trades: agreement, freshness, before/after the move — never "most copies say CALL".
    const ct = copyFor(asset, nowTs);
    if (ct?.dir) return { dir: ct.dir, source: 'PO copy trades', confidence: ct.confidence,
      note: `${ct.total} trade(s), ${Math.round(ct.agreement * 100)}% agree${ct.late ? ', arrived after the move' : ''}${ct.fresh ? '' : ', not fresh'}`, copy: ct };
    return null;
  }

  // ── analysis of one setup frame ────────────────────────────────────────────
  function payoutOf(asset) {
    if (asset === state.asset) { const p = readPayout(); if (p != null) return p; }
    return state.assets.find((a) => a.symbol === asset)?.payout ?? null;
  }
  const frameOf = (F, tf) => (F.frames[tf] ||= { tf });

  // Where the idea is wrong: just beyond the last swing on our side, else 1.5 ATR away.
  function invalidationOf(f, dir) {
    const up = dir === 'CALL', sw = up ? f.structure.lastLow : f.structure.lastHigh;
    if (sw) {
      const d = ((up ? f.price - sw.price : sw.price - f.price) / f.atr);
      if (d >= 0.3 && d <= 2.5) return up ? sw.price - 0.1 * f.atr : sw.price + 0.1 * f.atr;
    }
    return up ? f.price - 1.5 * f.atr : f.price + 1.5 * f.atr;
  }

  // Readability of every frame of this pair → setup frames and the roles of each (engine/frameselect.js).
  function selectFrames(asset) {
    const F = feeds.get(asset);
    if (!F) return null;
    const q = {};
    for (const tf of neededFrames(F)) {
      const c = F.feed.series[tf]?.closed(200) || [];
      q[tf] = OTC.FrameSelect.quality(c, c.length >= 30 ? OTC.Features.compute(c, tf, { abnormalRangeAtr: cfg.abnormalRangeAtr }) : null, calTables?.frames?.[tf] ?? null);
    }
    F.q = q;
    F.sel = OTC.FrameSelect.choose(q, cfg);
    return F.sel;
  }
  const profileOf = (F, tf) => F.sel?.profiles?.[tf] || { ...OTC.PROFILES[tf] };

  function analyse(asset, tf, { full, early = false }) {
    const F = feeds.get(asset), tick = F.feed.lastTick, Fr = frameOf(F, tf);
    return OTC.withProfile(profileOf(F, tf), () => {
      const series = F.feed.snapshot();
      const dq = OTC.DataQuality.checkSnapshot(series, { now: tick.ts, cfg, lastPrice: tick.price, lastTickAgeSec: 0 });
      if (F.feed.series[tf].mismatches > 3) dq.issues.push({ code: 'LIVE_HISTORY_MISMATCH', severity: 'warn', detail: `${F.feed.series[tf].mismatches} live candles differed from PO history`, tf });
      const signal = signalFor(asset, tick.ts);
      const X = OTC.Pipeline.buildContext(series, { signal, cfg });
      const scan = OTC.Pipeline.fastScan(X);
      Fr.scan = scan; Fr.dq = dq; Fr.regime = X.regime;
      if (!full) return null;

      const c = series[tf], lastC = c[c.length - 1];
      let a;
      if (!cfg.researchDeepAll && scan.score < cfg.deepThreshold) {
        a = { decision: 'SKIP', lean: scan.direction === 'NEUTRAL' ? null : scan.direction, confidence: 0, regime: X.regime,
          skipReasons: [`scanner ${scan.score} < ${cfg.deepThreshold}`], riskFlags: [], fired: [], evidenceFor: [], evidenceAgainst: [] };
      } else a = OTC.Pipeline.deepAnalyze(X, { dq, scan, meta: { asset, time: tick.ts, candleTime: lastC?.time } });
      if (early && a.decision !== 'SKIP') { a.skipReasons.push('entry window missed (analysed after the candle closed)'); a.decision = 'SKIP'; }
      const facts = OTC.Facts.from(X, a, {}); // plain facts for the interface (no numbers, no jargon)
      facts.frame = tf;
      if (signal?.copy) facts.copy = { dir: signal.copy.dir, late: signal.copy.late, fresh: signal.copy.fresh, agree: signal.copy.dir === (a.decision !== 'SKIP' ? a.decision : a.lean) };
      // Analyses are logged (research); only opportunities can lead to a trade. Seconds frames close
      // up to 12 times a minute, so only their decisions and strong scans are kept, slimmed down.
      // …and every close where a discovered strategy fired: its shadow (paper) test is measured on these records
      const keep = !OTC.SUBMINUTE(tf) || a.decision !== 'SKIP' || scan.status === 'DEEP' || !!a.disc?.length;
      const record = X.f5.ready ? OTC.Pipeline.toRecord(X, a, scan, { source: 'live', asset, payout: payoutOf(asset), entryTick: tick.price, snapshot: tf > 60 }) : null;
      if (record && OTC.SUBMINUTE(tf)) record.strategies = record.strategies.filter((x) => x[3]);
      if (record && keep) {
        // research frames: outcomes also at the durations discovered strategies are tested on (paper tracking)
        const rh = OTC.Research?.DEFAULTS.discoverHorizons[tf];
        if (rh) record.horizons = [...new Set([...cfg.expiries, ...rh])].sort((x, y) => x - y);
        record.facts = facts;
        record.profile = { ...OTC.TF };
        record.frameQuality = F.q?.[tf]?.score ?? null;
        record.scanned = !!F.polled;
        post({ type: 'decision', record, cand: null, poNow: tick.ts });
      }
      Fr.last = { facts, decision: a.decision, lean: a.lean, deep: a.confidence, setup: a.setupName || null, combo: a.combo || null, tf, cons: OTC.Consensus.summary(a.consensus),
        evidenceFor: a.evidenceFor.slice(0, 8), evidenceAgainst: a.evidenceAgainst.slice(0, 8), skipReasons: a.skipReasons.slice(0, 6),
        risk: a.risk || null, candleTime: lastC?.time ?? null, strategies: a.fired.filter((x) => x.active).slice(0, 6).map((x) => x.name),
        stratIds: a.fired.filter((x) => x.active && x.direction === (a.decision !== 'SKIP' ? a.decision : a.lean)).slice(0, 6).map((x) => x.strategy) };
      Fr.watch = null; // the provisional look at this candle is replaced by the real analysis
      return { a, X, lastC, facts, record, dq, profile: { ...OTC.TF } };
    });
  }

  // A look at the candle still forming: would it complete a setup, or is price compressed at a
  // range edge? Display only — nothing is logged or entered before the candle closes.
  function provisional(asset, tf) {
    const F = feeds.get(asset), tick = F.feed.lastTick, Fr = frameOf(F, tf);
    const fm = F.feed.series[tf].forming;
    if (!fm || fm.partial || !Fr.last || F.opps.some(Opp.isActive)) { Fr.watch = null; return; }
    const closesAt = fm.time + tf;
    if (closesAt - tick.ts < 15) return;
    Fr.watch = OTC.withProfile(profileOf(F, tf), () => {
      const X = OTC.Pipeline.buildContext(F.feed.snapshot({ withForming: true }), { signal: null, cfg });
      const f = X.f5;
      if (!f.ready) return null;
      const a = OTC.Pipeline.deepAnalyze(X, {});
      if (a.decision !== 'SKIP') return { state: 'WAIT_FOR_CANDLE_CLOSE', dir: a.decision, tf, closesAt, kind: OTC.Facts.setupKind(a.setup) };
      const b = f.breakout;
      if (b?.compression?.is && b.rangeHi != null) {
        const toHi = (b.rangeHi - f.price) / f.atr, toLo = (f.price - b.rangeLo) / f.atr;
        if (Math.min(toHi, toLo) <= 0.4) return { state: 'WAIT_FOR_BREAKOUT', dir: toHi <= toLo ? 'CALL' : 'PUT', tf, closesAt, level: toHi <= toLo ? b.rangeHi : b.rangeLo };
      }
      return null;
    });
  }

  // ── opportunities ──────────────────────────────────────────────────────────
  // A setup frame closed with an analysis: re-check live opportunities, maybe open a new one.
  function onSetupClose(asset, tf, res) {
    const F = feeds.get(asset), tick = F.feed.lastTick;
    if (!res?.lastC || !res.X.f5.ready) return;
    const { a, X, lastC, facts, record } = res;
    const live = F.opps.filter(Opp.isActive);
    const dir = a.decision !== 'SKIP' ? a.decision : null;
    const conflict = !!dir && live.some((o) => o.dir !== dir);
    for (const o of live) {
      if (o.tf === tf && o.setupTime === lastC.time) continue;
      // Hard contradictions count only from frames at least as large as the opportunity's own.
      const hard = cfg.soloMode !== 'youtube' && a.lean === o.dir && tf >= o.tf ? a.contradiction?.hard || [] : [];
      stepOpp(asset, o, { kind: 'close', now: tick.ts, price: tick.price, reanalysis: { tf, decision: a.decision, hardAgainst: hard } });
    }
    if (!dir) return;
    if (conflict && cfg.soloMode !== 'youtube') { frameOf(F, tf).last.conflict = true; return; } // frames disagree: neither side is taken (YouTube mode: each strategy on its own)
    if (!cfg.solo && !F.sel?.setupFrames.includes(tf)) { frameOf(F, tf).last.unclear = true; return; } // frame too noisy to trade setups on (single-strategy mode: the rule as tested, no readability filter)
    const same = F.opps.find((o) => Opp.isActive(o) && o.dir === dir);
    if (same) { if (!same.alsoOn.includes(tf)) same.alsoOn.push(tf); return; }
    const P = res.profile, f = X.f5, s = OTC.U.side(dir);
    const spec = {
      asset, tf, timingTf: P.TIMING, setupTime: lastC.time, closePrice: lastC.close, atr: f.atr, dir,
      kind: facts.kind, setup: a.setup, setupName: a.setupName, combo: a.combo, confidence: a.confidence, cons: OTC.Consensus.summary(a.consensus),
      invalidation: invalidationOf(f, dir), regime: X.regime.regime, facts, frames: { setup: tf, mid: P.MID, macro: P.MACRO, timing: P.TIMING },
      levelAtr: OTC.Strategies.H.opposingDist(X, s), vol: f.volatility.state, accel: !!f.momentum.accel,
      strategies: record?.strategies || [], disc: record?.disc, evidenceFor: a.evidenceFor.slice(0, 8), evidenceAgainst: a.evidenceAgainst.slice(0, 8),
      risk: a.risk || null, recordId: record?.id || null, payout: payoutOf(asset), copy: facts.copy || null,
      hard: a.contradiction?.hard || [], dqOk: res.dq?.ok !== false, frameQuality: F.q?.[tf]?.score ?? null, scanned: !!F.polled,
      signal: X.signal ? { dir: X.signal.dir ?? null, source: X.signal.source, confidence: X.signal.confidence ?? null } : null,
    };
    // a promoted discovered strategy that decided: its own validated duration (rule expiry × frame)
    const disc = a.ensemble?.dir === dir ? OTC.Lifecycle.live.find((d) => d.id === a.setup) : null;
    if (disc?.expiry) { spec.fixedExpiry = disc.expiry * tf; spec.source = 'discovered'; }
    else if (a.soloExpiry) { spec.fixedExpiry = a.soloExpiry; spec.expirySource = 'strategy'; } // the duration its video gives
    else if (cfg.frameExpirySec?.[tf]) { spec.fixedExpiry = cfg.frameExpirySec[tf]; spec.expirySource = 'frame'; } // the duration this frame was tested with
    spec.cal = qualify(spec);
    const { opp, enter } = Opp.create(spec, cfg, tick.ts);
    F.opps.push(opp);
    if (F.opps.length > 12) F.opps = F.opps.filter((o, i) => Opp.isActive(o) || i >= F.opps.length - 6);
    if (enter) onEnter(asset, opp, enter);
  }

  function stepOpp(asset, o, ev) {
    const before = o.state;
    const { enter } = Opp.step(o, ev, cfg);
    if (enter) return onEnter(asset, o, enter);
    if (o.state !== before && Opp.TERMINAL.includes(o.state)) finish(asset, o);
  }

  // Candle closes on each opportunity's confirmation frame (or its own frame when it has none).
  function onCandleClose(asset, tf, candle) {
    const F = feeds.get(asset), tick = F.feed.lastTick;
    const live = F.opps.filter((o) => Opp.isActive(o) && (o.timingTf || o.tf) === tf && candle.time >= o.closeTime);
    if (!live.length) return;
    const atr = atrOf(F, tf);
    for (const o of live) stepOpp(asset, o, { kind: 'close', now: tick.ts, price: candle.close, candle: { ...candle, tf }, candleAtr: atr });
  }

  // Durations PO offers for a pair: its picker list if seen, the picker list seen on any pair, else PO's
  // quick presets (S3 S15 S30 M1 M3 M5 M30 H1 H4 — read from PO's picker on 2026-10-03). PO's asset list
  // is not used: it lists no seconds, so seconds frames were given 1-minute trades.
  const PO_PRESETS = [3, 15, 30, 60, 180, 300, 1800, 3600, 14400];
  function availableFor(asset) {
    const seen = typeof pickerSeen !== 'undefined' ? pickerSeen : {};
    const all = seen[asset] || seen['*'] || PO_PRESETS;
    const short = all.filter((x) => x <= maxTrade()); // never longer than the user's maximum
    return short.length ? short : all;
  }

  // Every final check before an entry: payout ≥ gate.minPayout (the user's 92%), the calibrated
  // confidence when it has been measured, contradictions, data, copy trades, model status.
  // Pure function of the opportunity, the current payout, the cohort tables and the model status —
  // recomputed at creation, at the entry moment, and again right before a click.
  function qualify(o) {
    const g = cfg.gate, blocks = [];
    const payout = payoutOf(o.asset) ?? o.payout ?? null;
    if (payout == null) blocks.push('payout_unknown');
    else if (payout < g.minPayout) blocks.push('payout');
    // a history opportunity carries its own evidence: how its strength did at its duration in the walk-forward test
    if (o.source === 'hist') {
      const cal = histCal(o.hist.tested, payout ?? 85, o.hist.sec);
      if (!(cal.measured && cal.ev > 0 && cal.stable)) blocks.push(cal.measured ? 'no_edge' : 'insufficient_data');
      if (o.dqOk === false) blocks.push('data');
      if (calStatus.status === 'REJECTED') blocks.push('model_rejected');
      return { ...cal, payout, minPayout: g.minPayout, qualified: !blocks.length, blocks };
    }
    // copy signals are compared only with copy signals (their own cohorts), never with the engine's population
    const only = o.source === 'copy' ? { sources: ['entries'], levels: ['pair', 'pair_setup', 'setup_regime', 'setup', 'kind_regime', 'kind'] } : {};
    const ff = o.source !== 'copy' && o.cons?.dir === o.dir && o.cons.ff ? Math.min(o.cons.ff, 5) : null;
    // the engine's own opportunities also learn their direction from their record (with the setup, or against it)
    const cal = OTC.Calibration.assess({ frame: o.tf, setup: o.setup, kind: o.kind, dir: o.dir, regime: o.regime, asset: o.asset, payout: payout ?? 85, ff },
      calTables, { cfg, available: availableFor(o.asset), ...only, learnDirection: o.source !== 'copy', expiryOpts: { f: { volatility: { state: o.vol }, momentum: { accel: o.accel } }, levelAtr: o.levelAtr,
        ...(o.fixedExpiry ? { fixedSec: o.fixedExpiry, fixedSource: o.expirySource || o.source } : {}) } });
    const measured = cal.measured;
    // "استراتيجيات يوتيوب" (the user's explicit choice): every signal is entered as the video says — no measured
    // record, no contradiction, no self-check, no payout minimum. The outcome is still recorded.
    if (cfg.soloMode === 'youtube' && o.source !== 'copy') return { ...cal, reversed: false, payout, minPayout: g.minPayout, measured, raw: true, qualified: true, blocks: [] };
    // REVERSED: its record says this kind of opportunity goes the other way, measured and stable — traded against
    // the setup. What argued against the setup (contradictions, risk, copy trades against it) argues for this.
    if (cal.reversed && measured && cal.ev > 0 && cal.stable !== false) {
      const rb = blocks.filter((b) => b === 'payout' || b === 'payout_unknown');
      if (o.dqOk === false) rb.push('data');
      if (calStatus.status === 'REJECTED') rb.push('model_rejected');
      return { ...cal, payout, minPayout: g.minPayout, measured, qualified: !rb.length, blocks: rb };
    }
    if (o.fade) return { ...cal, reversed: false, payout, minPayout: g.minPayout, measured, qualified: false, blocks: ['no_edge'] }; // the reversal no longer holds
    if (measured && !(cal.ev > 0)) blocks.push('no_edge');           // the data says this kind of setup loses money at this payout
    if (measured && cal.stable === false) blocks.push('unstable');   // …or worked only in part of the time
    if (!measured && g.requireHistory) blocks.push('insufficient_data');
    if (o.hard?.length) blocks.push('contradiction');
    if (o.risk === 'HIGH') blocks.push('risk_high');
    if (o.dqOk === false) blocks.push('data');
    if (o.copy?.dir && !o.copy.agree && !o.copy.late) blocks.push('copy_against');
    // a rejected self-check stops entries made on measured evidence; the user's demo test of unmeasured ones (never
    // on a real account, never counted by the self-check) goes on
    if (calStatus.status === 'REJECTED' && (measured || g.requireHistory)) blocks.push('model_rejected');
    return { ...cal, payout, minPayout: g.minPayout, measured, qualified: !blocks.length, blocks: [...new Set(blocks)] };
  }

  // ENTER_NOW: final gate, duration from the calibration, and — if qualified — hand the entry to
  // the worker (ranking, risk, execution mode). Below the gate it is GATED: logged, not traded.
  function onEnter(asset, o, entry) {
    const F = feeds.get(asset), now = F.feed.lastTick.ts;
    o.cal = qualify(o);
    o.expiry = { sec: o.cal.expirySec, source: o.cal.expiry.source, reason: o.cal.expiry.reason };
    // traded against its setup: o.dir stays the setup's direction (its record keeps teaching the same cohort);
    // the trade, the screen and the safety checks use tradeDir(o)
    if (o.cal.qualified && o.cal.reversed) { o.fade = true; o.invalidation = null; }
    if (!o.cal.qualified) {
      Opp.markGated(o, now, o.cal.blocks.join(','));
      post({ type: 'decision', record: oppRecord(o), cand: null, poNow: now });
      return;
    }
    Opp.markEntered(o, now, entry.why);
    const record = oppRecord(o);
    const entryTf = entry.tf || o.tf;
    post({ type: 'decision', record, cand: candOf(o, record, { entryTime: entry.time, entryPrice: entry.price, entryAtr: entry.atr || o.atr, entryTf, validFor: OTC.entryWindow(cfg, entryTf) }), poNow: now });
  }

  const tradeDir = (o) => (o.fade ? OTC.U.opp(o.dir) : o.dir);
  function candOf(o, record, x) {
    return {
      id: record.id, kind: 'opp', source: o.source === 'copy' ? 'copy' : 'intel', asset: o.asset, dir: tradeDir(o), fade: !!o.fade, candleTime: record.candleTime, ...x,
      expirySec: o.expiry.sec, tf: o.tf, frames: o.frames, invalidation: o.invalidation, deep: o.confidence, setup: o.setup, setupName: o.setupName,
      regime: o.regime, combo: o.combo, evidenceAgainst: o.evidenceAgainst, atr: o.atr, strategies: o.strategies, payout: o.cal.payout ?? o.payout, disc: o.disc,
      facts: o.facts, why: o.entry?.why, cal: calSummary(o.cal), frameQuality: o.frameQuality, scanned: o.scanned, copy: o.copy,
    };
  }

  // An opportunity that ended without an entry is still logged (lean, from the setup close), so
  // waiting, missing and invalidating can be measured against what price actually did.
  function finish(asset, o) {
    post({ type: 'decision', record: oppRecord(o), cand: null, poNow: feeds.get(asset)?.feed.lastTick?.ts });
  }

  const calSummary = (c) => (c ? { status: c.status, measured: c.measured, winProb: c.winProb, interval: c.interval, ev: c.ev, evLo: c.evLo, p: c.p, n: c.n,
    payout: c.payout, minPayout: c.minPayout, qualified: c.qualified, blocks: c.blocks, source: c.source, level: c.level, key: c.key, oos: c.oos,
    stable: c.stable, reason: c.reason, version: c.version, have: c.have, need: c.need, expirySec: c.expirySec, reversed: c.reversed || undefined, raw: c.raw || undefined } : null);

  function oppRecord(o) {
    const reached = (o.state === 'ENTERED' || o.state === 'GATED') && o.entry, entered = o.state === 'ENTERED', t = reached ? o.entry.time : o.closeTime;
    const entryTf = reached ? o.entry.tf || o.tf : o.tf;
    // tf 1: exits are keyed by SECONDS after `ts` (5s … 30 min). Entries on seconds frames get every
    // horizon (5s closes resolve them); entries on minute frames the ≥ 60s ones (1M closes).
    const horizons = cfg.oppHorizonsSec.filter((h) => OTC.SUBMINUTE(entryTf) || h >= 60);
    // measured with every signal (no decision uses them yet): prices received in the last 20 s, and the other
    // strategies' signals on this pair in the minute before — same way / the other way
    const F = feeds.get(o.asset), others = new Set(), against = new Set();
    for (const x of F?.opps || []) {
      if (x === o || x.source === 'copy' || x.setup === o.setup || x.closeTime > o.closeTime || x.closeTime < o.closeTime - 60) continue;
      (x.dir === o.dir ? others : against).add(x.setup);
    }
    return {
      id: oppId(o), v: OTC.VERSION, kind: 'opp', origin: o.source === 'copy' ? 'copy' : o.source === 'hist' ? 'history' : 'engine', hist: o.hist || undefined, tf: 1, horizons, frame: o.tf, timingTf: o.timingTf, frames: o.frames, objections: o.objections || undefined,
      source: 'live', asset: o.asset, candleTime: t - entryTf, ts: t, payout: o.cal?.payout ?? o.payout, decision: entered ? tradeDir(o) : 'SKIP', lean: o.dir, fade: o.fade || undefined,
      deep: o.confidence, regime: o.regime, setup: o.setup, combo: o.combo, strategies: o.strategies, disc: o.disc, setupKind: o.kind, cons: o.cons || undefined,
      state: o.state, path: o.history.map((h) => h.state), why: o.history[o.history.length - 1]?.why || null, alsoOn: o.alsoOn,
      waitSec: t - o.closeTime, expirySec: reached ? o.expiry.sec : null, expiry: reached ? { source: o.expiry.source, reason: o.expiry.reason } : null,
      entryPrice: reached ? o.entry.price : o.closePrice, invalidation: o.invalidation, copy: o.copy,
      cal: calSummary(o.cal), profile: o.frames, frameQuality: o.frameQuality, scanned: o.scanned,
      tick20: F?.ticks?.length ?? null, agree: o.source === 'copy' ? undefined : { same: others.size, against: against.size },
      // what the system knew at that moment (rebuildable later): roles of each frame, platform signal, raw score,
      // durations the platform offered, versions
      roles: { context: o.frames?.mid ?? null, macro: o.frames?.macro ?? null, setup: o.tf, confirmation: o.timingTf ?? null, entryTiming: reached ? o.entry.tf ?? o.tf : null },
      signal: o.signal || null, rawScore: o.confidence, availableExpiries: availableFor(o.asset),
      engineVersion: (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return null; } })(),
      exits: {}, status: 'pending', facts: o.facts, evidenceFor: o.evidenceFor, evidenceAgainst: o.evidenceAgainst, risk: o.risk,
      riskFlags: [], skipReasons: entered ? [] : o.state === 'GATED' ? [`entry gate: ${o.cal?.blocks?.join(', ')}`] : [`opportunity ${o.state.toLowerCase()}`], exec: null, setupRecord: o.recordId,
    };
  }

  // ── copy + verify ──────────────────────────────────────────────────────────
  // Every fresh signal in PO's copy-trading list, on ANY pair, is verified against the engine's own
  // analysis of that pair (live, or rebuilt from PO's history), in the signal's direction:
  //   the contradiction engine on 1M and 5M (opposing levels, over-extension, higher frames against),
  //   the evidence balance, the market state, whether it came after the move, what the rest of the list
  //   says, time left, a proven platform signal against it, and payout.
  // A signal with no objection becomes an entry (ranked, protected, switched-to and placed like any other);
  // one with objections is GATED with them. Both are measured at the duration taken, so the data shows
  // which objections actually remove losers, and the calibrated model blocks signal groups that lose.
  const COPY_VALID_SEC = 12;  // a verified copy entry must be placed within this (opening the pair included)
  const COPY_MIN_LEFT = 20;   // signals with less time left are not followed
  const COPY_DURATION_FIT = 1.6; // the copy's duration within ×1.6 of the time the signal has left
  const COPY_LATE_ATR = 0.6;  // price already moved this far (1M ATR) with the signal since it started → late
  const copyPending = new Map();
  let copySeq = 0;

  function onCopySignal(sig) {
    if (!/_otc$/i.test(sig.asset) && !cfg.allowNonOtc) return;
    if (cfg.solo) return; // a strategy mode (Keltner / YouTube): nothing but its strategies
    // longer than the user trades: not worth a verification, a screen update or any history request
    // (bot.js still measures every signal in the list)
    if (sig.left - 3 > maxTrade() * 1.5) return;
    let F = feeds.get(sig.asset);
    if (!F) { F = { feed: new OTC.Feed.Feed(sig.asset), frames: {}, opps: [], polled: true, createdAt: Date.now() }; feeds.set(sig.asset, F); }
    F.copyUntil = sig.at + sig.left;
    copyPending.set(sig.asset, sig);
    prepareCopy(sig.asset).catch((e) => console.warn('[PO Bot] copy', e));
  }

  async function prepareCopy(asset) {
    const F = feeds.get(asset);
    if (!F) return;
    if (!F.seededAt && !F.seeding) await seed(asset);
    for (let i = 0; i < 50 && F.seeding; i++) await sleep(200);
    if (F.polled && F.seededAt) { // a pair nobody has on a chart: bring it up to the latest closed minute
      const now = Math.floor(state.lastTick?.ts ?? Date.now() / 1000);
      const from = F.lastPolled ?? F.feed.series[60].closed(1)[0]?.time ?? now - 360;
      const rows = await historyRequest(asset, 60, now, Math.min(3600, Math.max(360, now - from + 120)), 0);
      if (rows?.length) replay1m(asset, rows, now);
    }
    const sig = copyPending.get(asset);
    copyPending.delete(asset);
    if (sig) verifyCopy(asset, sig);
  }

  // Close of the candle containing ts (5s if this tab builds it, else 1M) — the price when the signal started.
  function priceAt(F, ts) {
    for (const tf of [5, 60]) {
      const c = F.feed.series[tf]?.closed().find((x) => x.time <= ts && ts < x.time + tf);
      if (c) return c.close;
    }
    return null;
  }

  function verifyCopy(asset, sig) {
    const F = feeds.get(asset);
    if (!F) return;
    const nowTs = Math.max(state.lastTick?.ts ?? 0, F.feed.lastTick?.ts ?? 0) || Date.now() / 1000;
    const dir = sig.dir, opp = dir === 'CALL' ? 'PUT' : 'CALL', objections = [];
    const left = sig.at + sig.left - nowTs;
    // judged on the frame that matches the trade's length: a 15-minute copy trade is not vetoed by a
    // level 0.2 ATR away on the 1-minute chart (the other frames are kept as evidence)
    const tfV = left <= 150 ? 60 : left <= 900 ? 300 : 900;
    const ana = {};
    for (const tf of [...new Set([60, 300, tfV])]) {
      ana[tf] = OTC.withProfile(profileOf(F, tf), () => {
        const series = F.feed.snapshot();
        const dq = OTC.DataQuality.checkSnapshot(series, { cfg });
        const X = OTC.Pipeline.buildContext(series, { signal: null, cfg });
        if (!X.f5?.ready || !dq.ok) return { ok: false };
        const fired = OTC.Strategies.runAll(X);
        const cons = OTC.Consensus.evaluate(fired, { asset, frame: tf, regime: X.regime.regime }, { cfg });
        const conf = OTC.Confluence.evaluate(X, cfg);
        const contra = OTC.Contradiction.evaluate(X, dir, conf, fired, cfg, cons);
        const a = { decision: 'SKIP', lean: dir, confidence: Math.round(conf.scores[dir]), skipReasons: [], contradiction: contra, setup: null };
        return { ok: true, X, conf, contra, cons, regime: X.regime.regime, facts: OTC.Facts.from(X, a, {}), atr: X.f5.atr, price: X.f5.price, profile: { ...OTC.TF } };
      });
    }
    const m1 = ana[60], m5 = ana[300];
    // the verifying frame, or the nearest one with usable data
    const V = [ana[tfV], ...[60, 300, 900].map((tf) => ana[tf])].find((r) => r?.ok) || ana[tfV];
    if (!V.ok) objections.push('no_data');
    else {
      // the strategies' consensus on the verifying frame points the other way (enough families, none with the signal)
      if (V.cons?.status === 'AGREE' && V.cons.dir === opp) objections.push('strategies_against');
      if (V.contra.against.some((x) => x.hard && x.code !== 'conflict')) objections.push('contradiction');
      if (V.conf.scores[opp] - V.conf.scores[dir] >= 15) objections.push('evidence_against');
      const unclear = (r) => !r?.ok || ['UNCLEAR', 'HIGH_VOLATILITY'].includes(r.regime);
      if (unclear(V) && unclear(V === m1 ? m5 : m1)) objections.push('market_unclear');
    }
    const live = !F.polled && F.feed.lastTick ? F.feed.lastTick : null;
    const priceNow = live?.price ?? (m1.ok ? m1.price : null);
    const startPrice = priceAt(F, sig.at - (sig.elapsed ?? 0));
    const move = m1.ok && startPrice != null && priceNow != null ? ((priceNow - startPrice) / m1.atr) * (dir === 'CALL' ? 1 : -1) : null;
    if (move != null && move > COPY_LATE_ATR) objections.push('late');
    // no price history for its start (a pair just opened or scanned): PO's +$ on a trade that has been running
    // a while says the move already happened with it — following now is chasing
    else if (move == null && sig.pnl === '+' && (sig.elapsed ?? 0) > 30) objections.push('late');
    const ct = OTC.CopyTrade.evaluate(copy.hist?.[asset] || [], { now: nowTs, price: priceNow, atr: m1.ok ? m1.atr : null });
    // the rest of the list on this pair (signals still running), each weighted by how many traders copied it:
    // a clear majority against → conflict; close to an even split → no consensus
    const running = (copy.hist?.[asset] || []).filter((x) => x.at + x.left > nowTs);
    const weight = (x) => Math.max(1, x.copies || 0);
    const wFor = running.filter((x) => x.dir === dir).reduce((a, x) => a + weight(x), 0);
    const wAgainst = running.filter((x) => x.dir !== dir).reduce((a, x) => a + weight(x), 0);
    const share = wFor + wAgainst ? wFor / (wFor + wAgainst) : 1;
    if (share < 0.4) objections.push('copy_conflict');
    else if (share < 0.6 && running.filter((x) => x.dir !== dir).length >= 2) objections.push('copy_flipping');
    if (left < COPY_MIN_LEFT) objections.push('too_little_time');
    // the user trades short: a signal with much more time left than the maximum is measured, not followed
    if (left - 3 > maxTrade() * 1.5) objections.push('too_long');
    const ps = signalFor(asset, nowTs);
    if (ps?.dir && ps.dir !== dir && /^PO signal/.test(ps.source)) objections.push('signal_against');
    // the duration: what PO offers closest to the time the signal has left (allowing a few seconds to place it).
    // Copying means ending about when the trader's trade ends: a preset more than COPY_DURATION_FIT× away from
    // that is another trade (seen: 30 min offered for a signal with 12:48 left — PO has nothing between M5 and M30)
    const offered = availableFor(asset).filter((x) => cfg.expiryChoices.includes(x));
    const want = Math.min(maxTrade(), Math.max(15, left - 3));
    const snapped = offered.length ? OTC.Expiry.snap(want, offered) : null;
    const fixedExpiry = snapped && Math.max(snapped / want, want / snapped) <= COPY_DURATION_FIT ? snapped : null;
    if (!fixedExpiry) objections.push('no_duration');
    // measured from a candle close, so the outcome can be read exactly: last 5s close if built here, else last 1M close
    const c5 = !F.polled ? F.feed.series[5]?.closed(1)[0] : null, c1 = F.feed.series[60].closed(1)[0];
    const at = c5 ? { time: c5.time + 5, price: c5.close, tf: 5 } : c1 ? { time: c1.time + 60, price: c1.close, tf: 60 } : null;
    if (!at) return;
    const r1 = V.ok ? V : null; // what the screen shows comes from the frame that judged it
    copySeq = (copySeq + 1) % 1e6;
    const o = {
      recId: `opp|${asset}|copy|${at.time}|${dir}|${copySeq}`, source: 'copy', asset, tf: 60, timingTf: null, setupTime: at.time - 60, closeTime: at.time, closePrice: at.price,
      atr: r1?.atr ?? null, dir, kind: 'copy', setup: 'copy_signal', setupName: 'نسخ مع تحقق', confidence: r1 ? Math.round(r1.conf.scores[dir]) : 0, cons: r1 ? OTC.Consensus.summary(r1.cons) : null,
      invalidation: null, regime: r1?.regime ?? 'UNCLEAR',
      facts: { ...(r1?.facts || { dir, risks: [], skip: [] }), kind: 'copy', frame: r1 ? r1.profile.PRIMARY : tfV, copy: { dir: ct.dir, agree: !ct.dir || ct.dir === dir, late: move != null && move > COPY_LATE_ATR, fresh: true } },
      frames: { setup: 60, mid: r1?.profile.MID ?? 300, macro: r1?.profile.MACRO ?? 900, timing: null }, levelAtr: Infinity,
      vol: r1?.X.f5.volatility.state, accel: false, strategies: [],
      evidenceFor: Object.entries(ana).filter(([, r]) => r.ok).map(([tf, r]) => `${OTC.TF_LABEL[tf]}: evidence ${Math.round(r.conf.scores[dir])} for vs ${Math.round(r.conf.scores[opp])} against`),
      // the verifying frame first; others are context
      evidenceAgainst: Object.entries(ana).sort(([a], [b]) => (+b === (r1?.profile.PRIMARY ?? tfV)) - (+a === (r1?.profile.PRIMARY ?? tfV)))
        .flatMap(([tf, r]) => (r.ok ? r.contra.against.map((x) => `${OTC.TF_LABEL[tf]}${+tf === (r1?.profile.PRIMARY ?? tfV) ? '' : ' (context)'}: ${x.label}${x.hard ? ' [HARD]' : ''}`) : [])).slice(0, 12),
      risk: null, payout: payoutOf(asset), hard: [], dqOk: !!r1, frameQuality: F.q?.[60]?.score ?? null, scanned: !!F.polled,
      copy: { verifyFrame: r1 ? r1.profile.PRIMARY : tfV, dir: ct.dir, agree: !ct.dir || ct.dir === dir, late: move != null && move > COPY_LATE_ATR, calls: ct.calls, puts: ct.puts, total: ct.total,
        left: Math.round(left), elapsed: sig.elapsed != null ? Math.round(sig.elapsed) : null, copies: sig.copies, pnl: sig.pnl ?? null, move: move != null ? +move.toFixed(2) : null,
        // the rest of the list on this pair, weighted by how many traders copied each signal
        copiesFor: wFor, copiesAgainst: wAgainst, share: +share.toFixed(2) },
      signal: ps ? { dir: ps.dir ?? null, source: ps.source, confidence: ps.confidence ?? null } : null,
      objections, fixedExpiry,
      history: [{ state: 'DISCOVERED', at: sig.at }, { state: 'CONFIRMED', at: nowTs, why: 'copy_signal' }], alsoOn: [],
      entry: { time: at.time, price: at.price, tf: at.tf, atr: r1?.atr ?? null, why: 'copy' }, expiresAt: nowTs + COPY_VALID_SEC,
    };
    o.cal = qualify(o);
    o.cal.blocks = [...new Set([...objections, ...o.cal.blocks])];
    o.cal.qualified = !o.cal.blocks.length;
    o.expiry = { sec: o.cal.expirySec, source: 'copy', reason: { code: 'copy', left: Math.round(left) } };
    F.opps.push(o);
    if (F.opps.length > 12) F.opps = F.opps.filter((x, i) => Opp.isActive(x) || i >= F.opps.length - 6);
    if (!o.cal.qualified) {
      Opp.markGated(o, nowTs, o.cal.blocks.join(','));
      post({ type: 'decision', record: oppRecord(o), cand: null, poNow: nowTs });
    } else {
      Opp.markEntered(o, nowTs, 'copy');
      const record = oppRecord(o);
      // placed now, at the current price (the record is measured from the aligned close above)
      post({ type: 'decision', record, cand: candOf(o, record, { entryTime: nowTs, entryPrice: priceNow ?? at.price, entryAtr: r1?.atr ?? null, entryTf: at.tf, validFor: COPY_VALID_SEC }), poNow: nowTs });
    }
    beat();
  }

  // ── tick entry point (called by bot.js for every tick of every asset) ──────
  // synthetic: a tick rebuilt from a scanned pair's 1M history (see replay1m)
  // A pair is LIVE only with a CONTINUOUS price flow — a chart showing it ticks about every second. PO also
  // sends occasional prices, and bursts of them, for pairs in its lists (trades, copy signals); candles
  // built from those are full of holes. Live = at least LIVE_SPAN seconds of prices with no pause longer
  // than LIVE_MAX_PAUSE. Anything else stays with the scanner (1M history each minute).
  const LIVE_SPAN = 20, LIVE_MAX_PAUSE = 6, LIVE_SILENCE = 20;
  function noteTick(F, ts) {
    const t = (F.ticks ||= []);
    if (t.length && ts - t[t.length - 1] > LIVE_MAX_PAUSE) t.length = 0; // a pause breaks the run
    t.push(ts);
    while (t.length > 2 && t[1] <= ts - LIVE_SPAN) t.shift();
    return t.length >= 2 && ts - t[0] >= LIVE_SPAN;
  }

  function onTick(asset, ts, price, synthetic = false) {
    if (!/_otc$/i.test(asset) && !cfg.allowNonOtc) return;
    let F = feeds.get(asset);
    if (!F) { F = { feed: new OTC.Feed.Feed(asset), frames: {}, opps: [], polled: true, createdAt: Date.now() }; feeds.set(asset, F); }
    if (!synthetic) {
      const steady = noteTick(F, ts);
      if (F.polled) {
        // occasional prices: not a chart pair (the scanner's 1M history is the better source). They are held
        // until the flow proves steady, then replayed: every (re)start used to lose its first ~20 s of candles.
        const pre = (F.pre ||= []);
        if (pre.length && ts - pre[pre.length - 1][0] > LIVE_MAX_PAUSE) pre.length = 0;
        if (!steady) { pre.push([ts, price]); return; }
        F.polled = false;     // steady flow: the pair is on a chart here, live ticks take over
        F.lastPolled = null;
        for (const [t, p] of pre) F.feed.ingest(t, p);
        F.pre = null;
        // seconds frames weren't seeded while it was scanned
        if (F.seededAt && anySubminute(F) && F.feed.series[5].closed().length < 200) seedSeconds(asset, F).catch(() => {});
      }
    }
    const closes = F.feed.ingest(ts, price);
    if (!synthetic && !F.polled && anySubminute(F)) noteSecond(asset, F, ts, price);
    if (!synthetic) maybeCollect();
    if (!F.seededAt && !F.seeding) seed(asset);
    const guard = (fn) => { try { fn(); F.error = null; } catch (e) { F.error = String(e?.message || e); console.warn('[PO Bot] intel', e); } };

    // 1. every tick: invalidation, missed move, expiry of live opportunities
    for (const o of F.opps) if (Opp.isActive(o)) guard(() => stepOpp(asset, o, { kind: 'tick', now: ts, price }));
    // 2. confirmation candles (before new setups, so a setup is never confirmed by its own last minute)
    for (const x of closes) if (!x.candle.partial) guard(() => onCandleClose(asset, x.tf, x.candle));

    // 3. setup frames that closed a candle. A candle that started before this tab saw it has unknown
    // open/high/low: fetch it from PO first, otherwise the analysis is a data-gap SKIP.
    const frames = setupFrames(F);
    // Ticks resuming after a pause longer than a flat fill (the chart showed another pair, a frozen tab): the
    // candle that closes now is minutes old — nothing to analyse ("last candle closed long ago"). The hole up to
    // the candle forming now is requested at once, so the next close usually finds it filled.
    const resumed = closes.filter((x) => { const last = F.feed.series[x.tf].closed(1)[0]; return !synthetic && last && ts - (last.time + x.tf) > x.tf + 5; });
    const due = closes.filter((x) => frames.includes(x.tf) && !resumed.includes(x)).map((x) => x.tf).sort((a, b) => b - a); // larger frames first
    // Candles to fetch from PO before analysing: a partial first candle (unknown open/high/low), or a hole —
    // PO's history often ends minutes before live candles begin. The hole itself is requested (refreshGap):
    // every 20s while it still makes the frame unreadable (setup frame: last 30 candles; context frame: last 3),
    // else once a minute while it is among the last 30. Only the first try at a hole delays the analysis.
    const repairs = (F.repairAt ||= {}), tried = (F.gapTried ||= {}), gaps = {};
    for (const x of closes) {
      if (x.candle.partial || !neededFrames(F).includes(x.tf)) continue;
      const g = F.feed.series[x.tf].gapIn(30);
      if (!g) continue;
      const barsAgo = (x.candle.time - g.to) / x.tf + 1, blocking = frames.includes(x.tf) || barsAgo <= 3;
      if (ts - (repairs[x.tf] ?? -1e9) >= (blocking ? 20 : 60)) gaps[x.tf] = g;
    }
    for (const x of resumed) {
      const fm = F.feed.series[x.tf].forming, last = F.feed.series[x.tf].closed(1)[0];
      if (!fm || !neededFrames(F).includes(x.tf)) continue;
      tried[x.tf] = fm.time; repairs[x.tf] = ts; // later tries at this hole: every 20s, in the background
      refreshGap(asset, x.tf, { from: last.time + x.tf, to: fm.time }, 0);
    }
    const gapped = Object.keys(gaps).map(Number);
    const first = gapped.filter((tf) => tried[tf] !== gaps[tf].to);
    for (const tf of gapped) { repairs[tf] = ts; tried[tf] = gaps[tf].to; }
    const partial = [...new Set([...closes.filter((x) => x.candle.partial && neededFrames(F).includes(x.tf)).map((x) => x.tf), ...first])];
    const run = () => {
      // which frames are readable right now, and their roles (seconds frames close every few seconds:
      // re-scoring every frame on each of those closes would be wasted work)
      if (!F.selAt || ts - F.selAt >= 30 || due.some((tf) => tf >= 60)) guard(() => { selectFrames(asset); F.selAt = ts; });
      for (const tf of due) guard(() => onSetupClose(asset, tf, analyse(asset, tf, { full: true })));
      beat();
    };
    if (due.length) {
      if (partial.length) Promise.all(partial.map((tf) => (first.includes(tf) ? refreshGap(asset, tf, gaps[tf], 0) : refresh(asset, tf, 3, 0)))).then(run);
      else { run(); if (!F.polled) for (const tf of due) if (tf > 60) refresh(asset, tf, 6, 2); } // check live candles against PO (not every few seconds)
    }
    // 4. on each minute: refresh scanners and take a provisional look at larger frames' forming candles
    if (closes.some((x) => x.tf === 60)) {
      for (const tf of frames) if (!due.includes(tf)) guard(() => { analyse(asset, tf, { full: false }); if (tf > 60) provisional(asset, tf); });
      const m1 = closes.find((x) => x.tf === 60);
      if (!m1.candle.partial) post({ type: 'candles', asset, rows: [m1.candle], tf: 60 }); // outcomes are resolved from 1M closes
    }
    // what followed similar past states (live pairs: 5s and 1M closes)
    if (!F.polled && !synthetic) for (const x of closes) if ((x.tf === 5 || x.tf === 60) && !x.candle.partial && !resumed.includes(x)) histPredict(asset, F, x.tf);
    // scanned pairs: their latest 1M close only (not the minutes replayed behind it) — every OTC pair is searched
    if (F.polled && synthetic) for (const x of closes) if (x.tf === 60 && !x.candle.partial && x.candle.time + 60 >= (state.lastTick?.ts ?? Infinity) - 90) histPredict(asset, F, 60);
    // 5s closes resolve the seconds horizons of entries on seconds frames (live pairs only)
    const s5 = closes.find((x) => x.tf === 5);
    if (s5 && !s5.candle.partial && !F.polled && (anySubminute(F) || copyOn())) post({ type: 'candles', asset, rows: [s5.candle], tf: 5 });
    if (!F.polled) for (const tf of [600, 900, 1800, 3600]) if (closes.some((x) => x.tf === tf) && !partial.includes(tf) && !due.includes(tf) && neededFrames(F).includes(tf)) refresh(asset, tf, 3);
    // context frames with a hole, and further tries at a hole, are refilled in the background (nothing waits)
    for (const tf of gapped) if (!partial.includes(tf)) refreshGap(asset, tf, gaps[tf], 0);
    if ((closes.length && !synthetic) || Date.now() - lastBeat > 5000) beat();
  }

  // 1-second closes of a pair on the chart: a 3-second trade ends between two 5s closes, so its outcome is
  // read from these. Sent to the worker in batches of about five (not stored, like the 5s ones).
  function noteSecond(asset, F, ts, price) {
    const S = (F.s1 ||= new OTC.Feed.Series(1));
    if (!S.ingest(ts, price)) return;
    const rows = S.closed().filter((c) => c.time > (F.s1Sent ?? -Infinity) && !c.partial);
    if (rows.length < 5 && Math.floor(ts) % 5 !== 0) return;
    F.s1Sent = rows.at(-1)?.time ?? F.s1Sent;
    if (rows.length) post({ type: 'candles', asset, rows, tf: 1 });
  }

  // ── data collector: the research dataset ────────────────────────────────────
  // The scan leader tab pulls PO's history of the OTC pairs (highest payout first), page by page: 5s candles
  // (1000 s a page) back cfg.collector.hours, 1M candles (200 a page) back hours1m, then keeps each pair current.
  // It runs off live ticks rather than timers (a background tab's timers fire once a minute), one page at a
  // time, and only while PO has nothing more urgent to answer (live analyses and repairs come first).
  let collectState = null, collecting = false, lastCollect = 0;
  const saveCollect = () => { try { chrome.storage.local.set({ collector: collectState }); } catch (_) {} };
  function maybeCollect() {
    const C = cfg.collector;
    if (!C?.on || !scanRole.leader || collecting || Date.now() - lastCollect < C.everyMs || historyBusy()) return;
    lastCollect = Date.now();
    collecting = true;
    collectOnce().catch(() => {}).finally(() => { collecting = false; });
  }
  async function collectOnce() {
    const C = cfg.collector;
    collectState ||= await new Promise((r) => { try { chrome.storage.local.get(['collector'], (x) => r(x?.collector || {})); } catch (_) { r({}); } });
    const now = Math.floor(state.lastTick?.ts ?? Date.now() / 1000);
    // OTC pairs, plus real-market pairs while their market is open (crypto at weekends, currencies on weekdays) so the
    // audit can compare the two; PO marks closed markets inactive
    const byPayout = (a, b) => (b.payout ?? 0) - (a.payout ?? 0), open_ = (state.assets || []).filter((a) => a.active !== false);
    const pairs = [...open_.filter((a) => /_otc$/i.test(a.symbol)).sort(byPayout).slice(0, C.maxPairs),
      ...open_.filter((a) => !/_otc$/i.test(a.symbol)).sort(byPayout).slice(0, C.real ?? 0)].map((a) => a.symbol);
    // one job: a pair with nothing yet → one falling behind → the one with the least history (5s, then 1M)
    const job = (() => {
      for (const [tf, page, hours] of [[5, 1000, C.hours], [60, 12000, C.hours1m]]) {
        const st = (a) => collectState[`${a}|${tf}`] || {};
        const none = pairs.find((a) => st(a).newest == null);
        if (none) return { a: none, tf, page, time: now };
        const behind = pairs.find((a) => now - st(a).newest > Math.max(600, tf * 10));
        if (behind) return { a: behind, tf, page, time: Math.min(now, st(behind).newest + page), fwd: true };
        const back = pairs.filter((a) => !st(a).doneBack && now - st(a).oldest < hours * 3600).sort((x, y) => st(y).oldest - st(x).oldest)[0];
        if (back) return { a: back, tf, page, time: st(back).oldest };
      }
      return null;
    })();
    if (!job) return;
    const key = `${job.a}|${job.tf}`, x = (collectState[key] ||= {});
    const rows = await historyRequest(job.a, job.tf, job.time, job.page, 2);
    if (rows?.length) {
      if (job.tf === 5) post({ type: 'hist', asset: job.a, rows });
      else post({ type: 'candles', asset: job.a, rows, tf: 60 });
      const lo = rows[0].time, hi = rows[rows.length - 1].time;
      if (!job.fwd && x.oldest != null && lo >= x.oldest) x.doneBack = true; // PO has nothing older
      x.oldest = Math.min(x.oldest ?? lo, lo); x.newest = Math.max(x.newest ?? hi, hi); x.pages = (x.pages || 0) + 1;
    } else if (job.fwd || x.newest == null) { x.newest = job.time; x.oldest ??= job.time; } // a closed market / no data: move on
    else x.doneBack = true;
    if (Date.now() - (collectState.__savedAt || 0) > 20000) { collectState.__savedAt = Date.now(); saveCollect(); }
  }

  // ── historical similarity, live ─────────────────────────────────────────────
  // At each close of a pair on a chart (5s, and 1M), the current market state goes to the worker, which answers what
  // followed similar past states and how that strength did in the walk-forward test (the latest research model).
  // Shown with the analysis; an opportunity only when that test proved it (BH-significant, stable over time folds,
  // above break-even at this payout) at a duration PO offers within the user's maximum.
  const histWait = new Map();
  let histSeq = 0;
  function histPredict(asset, F, tf) {
    if (!port || (F.polled && tf !== 60)) return; // scanned pairs: 1M (their 1M candles come from PO's history)
    const R = OTC.Research, c = F.feed.series[tf].closed(R.DEFAULTS.W + 40);
    let i = c.length - 1;
    while (i > 0 && c[i].time - c[i - 1].time === tf) i--;
    const seg = c.slice(i);
    if (seg.length < R.DEFAULTS.W + 1) return;
    const st = R.stateAt(seg, seg.length - 1, tf);
    if (!st) return;
    st.asset = asset; st.hs = R.DEFAULTS.horizons[tf];
    const reqId = `h${++histSeq}`;
    histWait.set(reqId, (p) => onHistPrediction(asset, tf, st, p));
    setTimeout(() => histWait.delete(reqId), 10000);
    post({ type: 'histPredict', reqId, state: st });
  }
  // evidence of one strength cell → the same shape as the calibration (win probability shrunk to break-even,
  // expected value at this payout, stable = every time fold with enough tests above break-even)
  function histCal(r, payout, sec) {
    const g = cfg.gate, be = OTC.U.breakEven(payout);
    const base = { expirySec: sec, expiry: { source: 'history', reason: { code: 'history', sec } }, level: 'history', source: 'history', be };
    if (!r || !r.n) return { ...base, status: 'INSUFFICIENT_DATA', measured: false, winProb: null, ev: null, stable: null, n: 0 };
    const hits = r.hits ?? Math.round((r.rate / 100) * r.n), a = g.priorStrength * (be / 100) + hits, b = g.priorStrength * (1 - be / 100) + (r.n - hits);
    const winProb = (100 * a) / (a + b), ci = OTC.Stats.wilson(hits, r.n);
    const stable = !!r.significant && (r.folds || []).filter(([n]) => n >= g.foldMinN).every(([n, k]) => (100 * k) / n >= be);
    const measured = r.n >= g.minOOS && !!r.significant;
    return { ...base, status: measured ? 'MEASURED' : 'INSUFFICIENT_DATA', measured, winProb: +winProb.toFixed(1), interval: [+ci.lo.toFixed(1), +ci.hi.toFixed(1)],
      ev: +((winProb / 100) * (payout / 100) - (1 - winProb / 100)).toFixed(4), n: r.n, oos: { n: r.n, wr: r.rate }, stable, p: winProb, reason: measured ? 'measured' : 'no_history' };
  }
  function onHistPrediction(asset, tf, st, p) {
    const F = feeds.get(asset);
    if (!F || !p) return;
    (F.hist ||= {})[tf] = { at: st.t + tf, tf, ...p };
    if (p.status !== 'OK' || (F.polled && tf !== 60) || !F.feed.lastTick) return; // ANOMALOUS: shown, never entered
    const payout = payoutOf(asset);
    if (payout == null) return;
    const offered = availableFor(asset).filter((x) => cfg.expiryChoices.includes(x));
    const best = p.horizons.filter((h) => h.dir && h.tested && offered.includes(h.sec) && h.sec <= maxTrade())
      .map((h) => ({ h, cal: histCal(h.tested, payout, h.sec) })).filter((x) => x.cal.measured && x.cal.ev > 0 && x.cal.stable)
      .sort((a, b) => b.cal.ev - a.cal.ev)[0];
    if (!best || F.opps.some((o) => o.source === 'hist' && o.closeTime === st.t + tf)) return;
    const h = best.h, nowTs = F.feed.lastTick.ts, close = st.t + tf;
    const o = {
      recId: `opp|${asset}|hist|${close}|${tf}|${h.sec}`, source: 'hist', asset, tf, timingTf: null, setupTime: st.t, closeTime: close, closePrice: st.price,
      atr: st.sigma, dir: h.dir, kind: 'history', setup: `hist:${tf}:${h.sec}`, setupName: 'موقف تكرر في التاريخ', confidence: Math.round(h.p), invalidation: null,
      regime: F.frames[tf]?.regime?.regime ?? 'UNCLEAR', facts: { dir: h.dir, kind: 'history', frame: tf, risks: [], skip: [] }, frames: { setup: tf, mid: null, macro: null, timing: null },
      levelAtr: Infinity, vol: null, accel: false, strategies: [], payout, hard: [], dqOk: true, scanned: false, alsoOn: [],
      evidenceFor: [`similar past states (${h.n}): ${h.up} up / ${h.down} down after ${h.sec}s`, `walk-forward at this strength: ${h.tested.rate}% of ${h.tested.n}`], evidenceAgainst: [],
      hist: { sec: h.sec, up: h.up, down: h.down, n: h.n, p: h.p, bucket: h.bucket, tested: h.tested, model: p.model?.id || null },
      history: [{ state: 'DISCOVERED', at: close }, { state: 'CONFIRMED', at: nowTs, why: 'history' }],
      entry: { time: close, price: st.price, tf, atr: st.sigma, why: 'history' }, expiresAt: nowTs + OTC.entryWindow(cfg, tf),
    };
    o.cal = qualify(o);
    o.expiry = { sec: h.sec, source: 'history', reason: { code: 'history', sec: h.sec } };
    F.opps.push(o);
    if (F.opps.length > 12) F.opps = F.opps.filter((x, i) => Opp.isActive(x) || i >= F.opps.length - 6);
    if (!o.cal.qualified) { Opp.markGated(o, nowTs, o.cal.blocks.join(',')); post({ type: 'decision', record: oppRecord(o), cand: null, poNow: nowTs }); return; }
    Opp.markEntered(o, nowTs, 'history');
    const record = oppRecord(o);
    post({ type: 'decision', record, cand: candOf(o, record, { entryTime: close, entryPrice: st.price, entryAtr: st.sigma, entryTf: tf, validFor: OTC.entryWindow(cfg, tf) }), poNow: nowTs });
    beat();
  }

  // ── scanning pairs that no tab has on a chart ──────────────────────────────
  // The worker makes one tab the scan leader. Each minute it fetches the latest 1M candles of up
  // to cfg.scanner.maxPairs OTC pairs (highest payout first) and replays them as ticks, so those
  // pairs go through exactly the same analysis, opportunities and gate as live ones. They lag
  // live pairs by the polling delay, so they can be paper-traded and recommended, and are
  // executed only once the pair is opened on a chart.
  let pollTimer = null, polling = false;
  function scanList() {
    if (!scanRole.leader || !cfg.scanner?.enabled) return [];
    const taken = new Set([...(scanRole.exclude || []), ...[...feeds.entries()].filter(([, F]) => !F.polled).map(([a]) => a)]);
    const minPay = cfg.scanner.minPayout ?? cfg.gate.minPayout ?? 0;
    return (state.assets || []).filter((a) => /_otc$/i.test(a.symbol) && a.active !== false && (a.payout ?? 0) >= minPay && !taken.has(a.symbol))
      .sort((a, b) => (b.payout ?? 0) - (a.payout ?? 0)).slice(0, cfg.scanner.maxPairs).map((a) => a.symbol);
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!scanRole.leader || !cfg.scanner?.enabled) return;
    const nowMs = Date.now(), next = (Math.floor(nowMs / 60000) + 1) * 60000 + 4000; // a few seconds after each minute
    pollTimer = setTimeout(async () => { try { await pollOnce(); } catch (e) { console.warn('[PO Bot] scan', e); } schedulePoll(); }, Math.max(1000, next - nowMs));
  }
  async function pollOnce() {
    if (polling) return;
    polling = true;
    try {
      const nowTs = state.lastTick?.ts ?? Date.now() / 1000;
      const copyPairs = [...feeds.entries()].filter(([, F]) => F.polled && F.copyUntil > nowTs).map(([a]) => a);
      const list = [...new Set([...copyPairs, ...scanList()])];
      for (const [a, F] of feeds) if (F.polled && !list.includes(a)) feeds.delete(a);
      for (const asset of list) {
        if (!scanRole.leader) break;
        // urgent work (gap repairs, copy verification) goes first: don't pile scanner requests behind it
        if (typeof historyQueue !== 'undefined' && historyQueue.length > 4 && !(feeds.get(asset)?.copyUntil > nowTs)) break;
        let F = feeds.get(asset);
        if (F && !F.polled) continue;
        if (!F) { F = { feed: new OTC.Feed.Feed(asset), frames: {}, opps: [], polled: true }; feeds.set(asset, F); }
        if (!F.seededAt) { await seed(asset); if (!F.seededAt) continue; }
        const now = Math.floor(state.lastTick?.ts ?? Date.now() / 1000);
        // back to the last minute replayed (or the end of the seeded history), so no minute is skipped
        const from = F.lastPolled ?? F.feed.series[60].closed(1)[0]?.time ?? now - 360;
        const rows = await historyRequest(asset, 60, now, Math.min(3600, Math.max(360, now - from + 120)), 2);
        if (rows?.length) replay1m(asset, rows, now);
      }
    } finally { polling = false; }
  }
  // Closed 1M candles → ticks (open, high, low, close), then the next minute's first tick at the
  // close, so the candle closes now rather than at the next poll. The next poll repairs that open.
  function replay1m(asset, rows, now) {
    const F = feeds.get(asset);
    if (!F?.polled) return;
    const closed = OTC.U.cleanRows(rows).filter((c) => c.time % 60 === 0 && c.time + 60 <= now).sort((a, b) => a.time - b.time);
    if (!closed.length) return;
    // first poll: continue from the end of the seeded 1M history, so nothing between them is missing
    if (F.lastPolled == null) {
      const seeded = F.feed.series[60].closed(1)[0]?.time;
      F.lastPolled = seeded != null && seeded >= closed[0].time - 60 ? seeded : closed[closed.length - 1].time - 60;
    }
    F.feed.merge(60, closed.filter((c) => c.time <= F.lastPolled)); // fills any hole in what was already replayed
    const fresh = closed.filter((c) => c.time > F.lastPolled);
    for (const c of fresh) {
      if (F.feed.series[60].forming?.time === c.time) F.feed.merge(60, [c]);
      for (const [dt, px] of [[1, c.open], [20, c.high], [40, c.low], [59, c.close]]) onTick(asset, c.time + dt, px, true);
      F.lastPolled = c.time;
    }
    if (fresh.length) onTick(asset, F.lastPolled + 60, fresh[fresh.length - 1].close, true);
  }

  // A pair stays listed while it receives prices; one left for 10 minutes is forgotten.
  function liveFeeds() {
    // PO time: the newest tick of any pair (the chart pair may not have ticked yet)
    const now = Math.max(state.lastTick?.ts ?? 0, ...[...feeds.values()].map((F) => F.feed.lastTick?.ts ?? 0)) || Date.now() / 1000;
    for (const [a, F] of feeds) {
      // a chart pair that went quiet (the chart switched to another pair): the scanner takes over
      if (!F.polled && F.feed.lastTick && now - F.feed.lastTick.ts > LIVE_SILENCE) {
        F.polled = true; F.ticks = []; F.lastPolled = null; F.feed.lastTick = null;
      }
      const lastSeen = Math.max(F.feed.lastTick?.ts ?? 0, F.ticks?.[F.ticks.length - 1] ?? 0);
      if (F.copyUntil > now) continue; // a pair with a live copy signal is kept (and refreshed) by this tab
      if (F.polled && !scanRole.leader && now - lastSeen > 120) feeds.delete(a); // not this tab's job to scan it
      else if (lastSeen && now - lastSeen > 600) feeds.delete(a);
    }
    return [...feeds.entries()].filter(([, F]) => F.feed.lastTick && now - F.feed.lastTick.ts <= (F.polled ? 180 : 90));
  }

  // ── what the interface shows per pair ──────────────────────────────────────
  // One opportunity (live, or the latest that ended within the last few minutes), the watch
  // states, and per frame the latest analysis. `last` is the most relevant frame's analysis.
  function oppView(o) {
    if (!o) return null;
    return { id: o.id, state: o.state, dir: tradeDir(o), setupDir: o.dir, fade: !!o.fade, tf: o.tf, timingTf: o.timingTf, kind: o.kind, setup: o.setup, combo: o.combo, setupName: o.setupName, confidence: o.confidence,
      closeTime: o.closeTime, expiresAt: o.expiresAt, entry: o.entry, expiry: o.expiry || null, alsoOn: o.alsoOn, frames: o.frames,
      why: o.history[o.history.length - 1]?.why || null, facts: o.facts, copy: o.copy || null, cal: calSummary(o.cal), scanned: !!o.scanned, action: o.action || null, cons: o.cons || null, hist: o.hist || null };
  }
  // the latest "what followed similar states" for a pair (5s if fresh, else 1M), compact for the screens
  function histView(F, now) {
    const h = [F.hist?.[5], F.hist?.[60]].find((x) => x && (x.status === 'OK' || x.status === 'ANOMALOUS') && now - x.at <= (x.tf === 5 ? 15 : 90));
    if (!h) return null;
    if (h.status === 'ANOMALOUS') return { tf: h.tf, at: h.at, anomalous: true, best: null, rows: [], model: h.model?.id || null };
    const rows = h.horizons.filter((x) => x.n && x.dir).map((x) => ({ sec: x.sec, dir: x.dir, p: x.p, n: x.n, tested: x.tested ? { rate: x.tested.rate, n: x.tested.n, significant: x.tested.significant } : null }));
    const best = [...rows].sort((a, b) => (b.tested?.significant ? 1 : 0) - (a.tested?.significant ? 1 : 0) || b.p - a.p)[0] || null;
    return { tf: h.tf, at: h.at, best, rows, patterns: (h.patterns || []).length, model: h.model?.id || null };
  }
  const dqCodes = (dq) => [...new Set((dq?.issues || []).filter((i) => i.severity === 'fatal').map((i) => i.code))];
  function view(F) {
    const now = F.feed.lastTick?.ts ?? Date.now() / 1000;
    // a "Copy + verify" tab shows its copy signals first (the engine's own opportunities aren't placed there)
    const copyFirst = (o) => (mode() === 'copy' && o.kind === 'copy' ? 1 : 0);
    const shown = (o) => !(cfg.solo && (o.kind === 'copy' || o.source === 'copy')); // Keltner mode: nothing but Keltner
    const live = F.opps.filter((o) => Opp.isActive(o) && shown(o)).sort((a, b) => copyFirst(b) - copyFirst(a) || (b.cal?.qualified ? 1 : 0) - (a.cal?.qualified ? 1 : 0) || (b.cal?.p ?? 0) - (a.cal?.p ?? 0) || b.confidence - a.confidence)[0];
    const ended = F.opps.filter((o) => !Opp.isActive(o) && shown(o)).sort((a, b) => (b.history.at(-1)?.at ?? 0) - (a.history.at(-1)?.at ?? 0))[0];
    const recent = ended && now - (ended.history.at(-1)?.at ?? 0) <= Math.max(120, ended.expiry?.sec ?? 0) ? ended : null;
    const frames = {};
    for (const [tf, Fr] of Object.entries(F.frames)) {
      if (!setupFrames(F).includes(+tf)) continue;
      const L = Fr.last;
      frames[tf] = { decision: L?.decision ?? null, lean: L?.lean ?? null, kind: L?.facts?.kind ?? null, level: L?.facts?.level ?? null,
        regime: Fr.regime?.regime ?? null, candleTime: L?.candleTime ?? null, conflict: !!L?.conflict, watch: Fr.watch || null,
        quality: F.q?.[tf]?.score ?? null, usable: !!F.sel?.setupFrames.includes(+tf), roles: F.sel?.profiles?.[tf] || null };
    }
    // most relevant analysis: the live opportunity's frame, else a fresh decision, else the largest analysed frame
    const fresh = (Fr) => Fr?.last && now - (Fr.last.candleTime + 2 * Fr.tf) < 0;
    const pick = (live && F.frames[live.tf]) || Object.values(F.frames).filter((Fr) => fresh(Fr) && Fr.last.decision !== 'SKIP').sort((a, b) => b.tf - a.tf)[0]
      || Object.values(F.frames).filter((Fr) => Fr.last && setupFrames(F).includes(Fr.tf)).sort((a, b) => b.tf - a.tf)[0] || null;
    const watch = Object.values(F.frames).map((Fr) => Fr.watch).filter(Boolean).sort((a, b) => b.tf - a.tf)[0] || null;
    return { opp: oppView(live || recent), watch, frames, last: pick?.last || null, scan: pick?.scan || null, regime: pick?.regime || null, dq: pick?.dq || null, hist: histView(F, now) };
  }

  function beat() {
    lastBeat = Date.now();
    if (!port) connect();
    post({
      type: 'state', poNow: state.lastTick?.ts ?? null, chartAsset: state.asset, armed: !!(state.running && mode()), isDemo: isDemoAccount(),
      // which engine trades in this tab, and its open trades (so the popup shows the same picture as the panel)
      engine: mode() || 'legacy', panelMode: state.settings.strategy, running: state.running, limits: { minPayout: state.settings.minPayout ?? 80, stopLoss: state.settings.stopLoss || 0, stopHit: stopLossHit(), targetHit: targetHit(), maxOpen: state.settings.maxOpen || 0 }, switching, version: extVersion,
      openTrades: state.trades.map((t) => ({ asset: t.asset, dir: t.dir.toUpperCase(), stake: t.stake, expiry: t.expiry, openedAt: t.openedAt, intel: !!t.intelId })),
      assets: liveFeeds().map(([asset, F]) => {
        const v = view(F);
        return {
          asset, payout: payoutOf(asset), scan: v.scan, regime: v.regime ? { regime: v.regime.regime, confidence: v.regime.confidence, reasons: v.regime.reasons } : null,
          last: v.last, opp: v.opp, watch: v.watch, frames: v.frames, hist: v.hist, error: F.error || null, scanned: !!F.polled,
          feed: { counts: F.feed.counts(), lastTickTs: F.feed.lastTick?.ts ?? null, seeded: !!F.seededAt, missing: F.historyMissing || [],
            dqOk: v.dq?.ok ?? null, dqCodes: dqCodes(v.dq), issues: (v.dq?.issues || []).slice(0, 6).map((i) => `${i.tf ? OTC.TF_LABEL[i.tf] + ' ' : ''}${i.detail}`) },
        };
      }),
    });
  }

  // ── execution (only when the worker says so AND this tab is armed) ─────────
  // Safety is re-checked right before the click: the opportunity is still the one that was
  // entered, the entry moment has not passed, price has not run or turned, the duration exists.
  // ── switching this tab's chart to a pair with an opportunity ─────────────
  // Through PO's own asset list (bot.js switchAsset). Done only by an armed tab with no trade open or
  // being placed; it succeeds only once PO reports the new symbol and a first price of it arrived.
  let switching = false, execQueue = Promise.resolve();
  async function switchTo(asset) {
    if (state.asset === asset) return null;
    if (switching) return 'already switching';
    if (!(state.running && mode()) || state.placing) return 'tab busy or not armed';
    switching = true;
    const before = state.lastTick?.ts ?? 0;
    try {
      const err = await switchAsset(asset);
      if (err) return err;
      for (let i = 0; i < 20 && !(state.lastTick && state.lastTick.ts > before); i++) await sleep(150);
      return null;
    } finally { switching = false; }
  }

  // The candle gate's confirmation candle (cfg.candleGate): wait for the next candle of the strategy's frame to close
  // (the last live price before cmd.confirm.at) and go on only if it closed beyond the signal price the signal's way —
  // then the entry is that close, at that time. Outside the one-at-a-time queue: other entries don't wait for it.
  async function confirmThen(cmd) {
    const { at, from } = cmd.confirm, up = cmd.dir === 'CALL';
    const F = feeds.get(cmd.asset), live = () => (F && !F.polled && F.feed.lastTick) || (state.asset === cmd.asset ? state.lastTick : null) || null;
    let close = null;
    for (const t0 = performance.now(); performance.now() - t0 < (cmd.confirm.frame + 20) * 1000;) {
      const t = live();
      if (t && t.ts < at) close = t.price;
      if (t && t.ts >= at) { if (close == null) close = t.price; break; }
      if (t && at - t.ts > 2) await sleep(500); else await quickSleep(20);
    }
    const ok = close != null && (up ? close > from : close < from);
    if (!ok) { post({ type: 'execResult', id: cmd.id, status: 'failed', reason: close == null ? 'no price for the confirmation candle' : `the confirmation candle closed against the signal (${from} → ${close})`, confirm: { price: close, confirmed: false } }); return false; }
    Object.assign(cmd, { entryPrice: close, closePrice: close, entryTime: at, confirmed: true, confirmPrice: close });
    return true;
  }

  async function execute(cmd) {
    const fail = (reason) => post({ type: 'execResult', id: cmd.id, status: 'failed', reason });
    if (!(state.running && placesHere(cmd.source))) return fail(`tab not armed — choose ${cmd.source === 'copy' ? 'Copy + verify (or both)' : 'Intel (or both)'} mode in this tab and press Start`);
    if (state.settings.demoOnly && !isDemoAccount()) return fail('Demo-only is on and this is not a demo account');
    if (state.placing || switching) return fail('a trade is already being placed in this tab');
    // the panel's number of trades open at the same time (every mode)
    if (state.settings.maxOpen > 0 && state.trades.length >= state.settings.maxOpen) return fail(`${state.trades.length} trades open already (the panel allows ${state.settings.maxOpen} at once)`);
    // only this tab's own signal, on the pair its chart shows (cfg.ownOnly): never another tab's, never by switching
    if (cfg.ownOnly && cmd.kind === 'opp' && !feeds.get(cmd.asset)?.opps.some((x) => oppId(x) === cmd.id)) return fail('not a signal this tab found');
    if (cmd.asset !== state.asset) {
      if (!cmd.switch || cfg.ownOnly) return fail(`this tab's chart shows ${state.asset}, not ${cmd.asset}`);
      const err = await switchTo(cmd.asset);
      if (err) return fail(`could not open ${cmd.asset}: ${err}`);
      if (cmd.asset !== state.asset) return fail(`this tab's chart shows ${state.asset}, not ${cmd.asset}`);
    }
    const F = feeds.get(cmd.asset);
    // live price: this pair's live feed, or (just switched to it) the chart's own latest price
    const live = () => (F && !F.polled && F.feed.lastTick) || (state.asset === cmd.asset ? state.lastTick : null) || null;
    if (!live()) return fail('no live price for this pair');
    // the duration actually offered closest to the chosen one (normally the same: it was chosen from this list)
    const avail = availableFor(cmd.asset).filter((x) => cfg.expiryChoices.includes(x));
    const expirySec = avail.length ? OTC.Expiry.snap(cmd.expirySec, avail) : cmd.expirySec;
    if (expirySec / cmd.expirySec > 2.5 || cmd.expirySec / expirySec > 2.5) return fail(`expiry ${cmd.expirySec}s not offered for this pair (closest ${expirySec}s)`);
    const safety = () => {
      const { ts, price } = live(), up = cmd.dir === 'CALL', flags = [];
      if (cmd.kind === 'opp') {
        const o = F?.opps.find((x) => oppId(x) === cmd.id);
        // (taken up again after the candle gate's confirmation candle: its own window has passed by then)
        if (o && o.state !== 'ENTERED' && !cmd.confirmed) flags.push(`opportunity is ${o.state}`);
        // a trade shorter than the entry window (3s, 5s) may start at most half its length late: later, it
        // would cover a different stretch of price than the one its outcomes were measured on
        const late = ts - cmd.entryTime, maxLate = Math.min(cmd.validFor, Math.max(1, expirySec / 2));
        if (late > maxLate) flags.push(`entry window missed (${late.toFixed(1)}s after the entry candle, window ${maxLate}s)`);
        // the bot already has a trade open on this pair the other way: no entry (one of the two would lose)
        if (cfg.noOppositeOpen && state.trades.some((x) => x.asset === cmd.asset && x.dir !== cmd.dir.toLowerCase()))
          flags.push(`a ${cmd.dir === 'CALL' ? 'PUT' : 'CALL'} trade is still open on this pair`);
        // the price already went against the signal: no entry (every mode, the user's rule)
        if (cfg.noAdverseEntry && cmd.entryPrice != null && price != null && (up ? price < cmd.entryPrice : price > cmd.entryPrice))
          flags.push(`price went against the signal (${cmd.entryPrice} → ${price})`);
        // "استراتيجيات يوتيوب": nothing but the strategy — entered at its candle's close, no other check
        if (ytRaw(o)) return { ok: !flags.length, flags };
        const move = ((price - cmd.entryPrice) / (cmd.entryAtr || cmd.atr)) * (up ? 1 : -1);
        if (move > cfg.maxChaseAtr) flags.push(`price already moved ${move.toFixed(2)} ATR our way — chasing`);
        if (move < -cfg.maxAdverseAtr) flags.push(`sudden opposite move ${(-move).toFixed(2)} ATR`);
        if (cmd.invalidation != null && (up ? price < cmd.invalidation : price > cmd.invalidation)) flags.push('price beyond the invalidation level');
        // (a reversed entry trades against setups that are still there — that is the point)
        if (!cmd.fade && F?.opps.some((x) => Opp.isActive(x) && x.dir !== cmd.dir)) flags.push('an opposite opportunity opened on this pair');
        // recalculate, never reuse: market state, copy trades, calibrated confidence and duration
        if (o) {
          // the frame that judged it (a copy signal's verifying frame), and only changes that matter:
          // the market turning against the trade, or becoming unreadable
          const judgeTf = o.copy?.verifyFrame || o.tf;
          try { analyse(cmd.asset, judgeTf, { full: false }); } catch (_) {}
          const rg = F.frames[judgeTf]?.regime?.regime;
          const against = rg === (cmd.dir === 'CALL' ? 'TRENDING_DOWN' : 'TRENDING_UP') || rg === 'HIGH_VOLATILITY' || rg === 'UNCLEAR';
          if (rg && rg !== o.regime && against) flags.push(`market state changed (${o.regime} → ${rg})`);
          const ct = copyFor(cmd.asset, ts);
          if (ct?.dir && ct.dir !== cmd.dir && !ct.late) flags.push('copy trades turned against');
          const q = qualify(o);
          if (!q.qualified) flags.push(`no longer qualified: ${q.blocks.join(', ')}`);
          else if (!!q.reversed !== !!o.fade) flags.push('the learned direction changed');
          else if (q.expirySec !== cmd.expirySec && q.expirySec !== expirySec) flags.push(`duration changed to ${q.expirySec}s`);
        }
        return { ok: !flags.length, flags };
      }
      return OTC.Risk.entryTiming({ candleTime: cmd.candleTime, nowSec: ts, price, closePrice: cmd.closePrice, atr: cmd.atr, dir: cmd.dir, cfg, tf: cmd.tf || 300 });
    };
    let t = safety();
    if (!t.ok) return fail(t.flags.join('; '));
    const payout = readPayout() ?? payoutOf(cmd.asset);
    const rawEntry = cmd.kind === 'opp' && ytRaw(F?.opps.find((x) => oppId(x) === cmd.id));
    if (payout == null && !rawEntry) return fail('payout unknown');
    if (payout != null && payout < cfg.gate.minPayout && !rawEntry) return fail(`payout ${payout}% < ${cfg.gate.minPayout}%`);
    // the YouTube mode's own limits, set in the panel: a payout floor and a daily stop loss
    if (rawEntry && payout != null && payout < (state.settings.minPayout || 0)) return fail(`payout ${payout}% < ${state.settings.minPayout}% (panel)`);
    // the panel's stop loss, every mode: the day's money this far below its highest point today
    if (targetHit()) return fail(`the day's profit target is reached (${targetMoney().net} of ${state.settings.target})`);
    if (stopLossHit()) { const dm = dayMoney(); return fail(`daily stop loss reached (${dm.net}, ${dm.down} below the best ${dm.peak})`); }
    // …and no trade that could take the loss past it: what is lost already + what the open trades can lose + this stake
    if (state.settings.amount > stopLossRoom() + 1e-9) return fail(`stop loss: only ${stopLossRoom()} left before the max loss of ${state.settings.stopLoss}, the stake is ${state.settings.amount}`);

    state.placing = true;
    // how long each step took, kept with the trade (where the time between the signal and PO's open goes)
    const t0 = performance.now(), hidden = document.hidden;
    try {
      const expBefore = readExpiry();
      const err = await setExpiry(expirySec);
      if (err) return fail(`could not set expiry ${expirySec}s: ${err}`);
      const tExp = performance.now();
      const stake = state.settings.amount;
      const amt = setAmount(stake);
      if (!amt) return fail('could not set the trade amount');
      // PO needs a moment to take in a new amount or duration; nothing changed → click at once
      if (amt !== 'same' || expBefore !== expirySec) await quickSleep(80);
      t = safety(); // background tabs can delay timers — re-check right before clicking
      if (!t.ok) return fail(`changed while preparing: ${t.flags.join('; ')}`);
      const dir = cmd.dir.toLowerCase();
      if (!clickDirection(dir)) return fail('CALL/PUT button not found');
      const trade = { id: null, intelId: cmd.id, dir, stake, expiry: expirySec, asset: cmd.asset, openedAt: Date.now(),
        voters: [`intel:${cmd.setup || 'setup'}`], payout, demo: isDemoAccount() };
      state.trades.push(trade);
      state.status = `Intel: opened ${cmd.dir} ${cmd.asset} (${cmd.setupName || cmd.setup})`;
      const timing = { queuedMs: Math.round(t0 - (cmd.gotAt ?? t0)), expiryMs: Math.round(tExp - t0), clickMs: Math.round(performance.now() - t0), hidden: hidden || document.hidden,
        expiryChanged: expBefore !== expirySec, amountChanged: amt !== 'same' };
      post({ type: 'execResult', id: cmd.id, status: 'placed', stake, demo: trade.demo, expirySec, timing, ...(cmd.confirmed ? { confirm: { price: cmd.confirmPrice, confirmed: true } } : {}) });
      // PO confirms with an order id (onOrderOpened). No id → the click may not have registered.
      setTimeout(() => post({ type: 'execResult', id: cmd.id, status: trade.id ? 'confirmed' : 'unconfirmed', poId: trade.id }), 8000);
      setTimeout(() => { if (state.trades.includes(trade) || state.late.includes(trade)) finishTrade(trade, null, 'unknown'); }, Math.max(RESULT_TIMEOUT_MS, (expirySec + 90) * 1000) + 1000);
    } finally {
      state.placing = false;
      render();
    }
  }

  // PO's own record of the deal (open/close price and time, to the millisecond) goes with the result: the worker
  // compares it with the market prices it saw (execution forensics: delay, slippage, close price vs the market)
  function onTradeClosed(t, result, profit, deal = null) {
    const n = (x) => (x == null || x === '' ? null : Number(x));
    const po = deal ? { openPrice: n(deal.openPrice), closePrice: n(deal.closePrice), openTs: n(deal.openTimestamp) + (n(deal.openMs) || 0) / 1000,
      closeTs: n(deal.closeTimestamp) + (n(deal.closeMs) || 0) / 1000, command: deal.command ?? null, percentProfit: n(deal.percentProfit) } : null;
    post({ type: 'tradeClosed', id: t.intelId, result, profit, stake: t.stake, po });
  }

  // ── panel text ─────────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function statusLine() {
    const F = feeds.get(state.asset);
    if (!F) return 'المحرك الذكي: بانتظار الأسعار';
    const v = view(F), now = F.feed.lastTick?.ts ?? Date.now() / 1000;
    if (!v.last && !v.opp) return 'المحرك الذكي: يجمع البيانات';
    return `المحرك الذكي: ${AR.pairStatus({ ...v, feed: { dqOk: v.dq?.ok, dqCodes: dqCodes(v.dq) } }, now).label}`;
  }
  function heroLine() {
    const F = feeds.get(state.asset);
    if (!F) return 'بانتظار الأسعار';
    const v = view(F), st = AR.pairStatus({ ...v, feed: { dqOk: v.dq?.ok, dqCodes: dqCodes(v.dq) } }, F.feed.lastTick?.ts ?? Date.now() / 1000);
    return esc(`${st.label}${v.regime ? ` · ${AR.regime(v.regime.regime)}` : ''}${port ? '' : ' · غير متصل بالنظام'}`);
  }
  function panelHtml() {
    const list = liveFeeds();
    if (!list.length) return 'المحرك الذكي: لم تصل أسعار OTC بعد';
    const nowTs = state.lastTick?.ts ?? Date.now() / 1000;
    return list.map(([asset, F]) => {
      const v = view(F), st = AR.pairStatus({ ...v, feed: { dqOk: v.dq?.ok, dqCodes: dqCodes(v.dq) } }, nowTs);
      return `<div><b dir="ltr">${esc(OTC.U.pairLabel(asset))}</b> · ${esc(st.label)}${v.regime ? ` · ${esc(AR.regime(v.regime.regime))}` : ''}${F.error ? ' · <span class="neg">خطأ في التحليل</span>' : ''}</div>`;
    }).join('') + `<div class="no">${port ? 'متصل بالنظام' : 'غير متصل بالنظام'} · ${state.running && mode() ? 'التبويب مفعّل للتنفيذ' : 'التبويب غير مفعّل للتنفيذ'}</div>`;
  }
  function openDashboard() {
    try { chrome.runtime.sendMessage({ type: 'openDashboard' }); } catch (_) {}
  }

  // The same per-pair view the popup gets from the worker, for the in-page panel.
  function pairView(asset) {
    const F = feeds.get(asset);
    if (!F) return null;
    const v = view(F);
    return { asset, ...v, feed: { dqOk: v.dq?.ok ?? null, dqCodes: dqCodes(v.dq) }, nowTs: F.feed.lastTick?.ts ?? Date.now() / 1000 };
  }

  globalThis.IntelTab = { dayNet: () => dayNet, feed: () => chatFeed, askFeed: () => post({ type: 'chatFeed' }), improve: () => post({ type: 'improve' }), appeal: (id) => post({ type: 'appeal', id }), onTick, onCopySignal, onUnsolicitedHistory, onTradeClosed, statusLine, heroLine, panelHtml, openDashboard, pairView, feeds,
    entryWindow: (tf) => OTC.entryWindow(cfg, tf), cfg: () => cfg, pollOnce, scanList };
  connect();
})();
