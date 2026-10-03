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
// isDemoAccount, readPayout, limitHit, finishTrade, state, poSig, copy, sigStats, pickerSeen.
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
  const setupFrames = (F = null) => (cfg.setupFrames?.length ? cfg.setupFrames : [300])
    .filter((tf) => cfg.frameSelect.options[tf] && !(F?.polled && OTC.SUBMINUTE(tf)));
  // Frames whose candles the analyses need: every setup frame and every role it may be given.
  const neededFrames = (F = null) => [...new Set(setupFrames(F).flatMap((tf) => { const o = cfg.frameSelect.options[tf]; return [tf, ...o.MID, o.MACRO, ...o.TIMING]; }).filter(Boolean))];
  const anySubminute = (F) => neededFrames(F).some(OTC.SUBMINUTE);

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
      if (m.discovered) OTC.Lifecycle.setLive(m.discovered); // discovered strategies in paper test / watchlist / promoted
      if (m.calTables) calTables = m.calTables;
      if (m.calStatus) calStatus = m.calStatus;
    }
    else if (m.type === 'scanRole') { scanRole = m; schedulePoll(); }
    else if (m.type === 'oppAction') {
      // what the worker did with an entry this tab found (executed, paper, blocked …)
      const asset = String(m.id || '').split('|')[1];
      const o = feeds.get(asset)?.opps.find((x) => `opp|${x.asset}|${x.tf}|${x.closeTime}` === m.id);
      if (o) { o.action = { action: m.action, detail: m.detail ?? null, at: state.lastTick?.ts ?? null }; beat(); }
    }
    else if (m.type === 'switchAsset') switchTo(m.asset).then((err) => post({ type: 'switchResult', asset: m.asset, ok: !err, err: err || null }));
    else if (m.type === 'execute') execute(m).catch((e) => post({ type: 'execResult', id: m.id, status: 'failed', reason: String(e?.message || e) }));
    else if (m.type === 'fetchHistory') fetchHistory(m).catch(() => post({ type: 'historyDone', reqId: m.reqId, asset: m.asset, count: 0 }));
  }

  // ── history ────────────────────────────────────────────────────────────────
  const SEED = { 60: 200, 300: 200, 900: 160, 1800: 130, 3600: 130 };
  const STORED = [60, 300, 900]; // frames whose candles the worker stores (outcomes, research); 5s ones only feed outcomes
  const SEED_5S_PAGES = 5;       // 5 × 1000s of 5s history (PO's page size) ≈ 83 min, so 30s frames have their context at once

  // Seconds frames: PO serves 5s history; 10s/15s/30s are built from it (only complete candles).
  function fromFive(rows, tf) {
    if (tf === 5) return rows;
    return OTC.U.aggregate(rows, 5, tf).filter((c) => rows.length && c.time >= rows[0].time);
  }
  async function seedSeconds(asset, F) {
    let cursor = Math.floor(F.feed.lastTick?.ts ?? state.lastTick?.ts ?? Date.now() / 1000), all = [];
    for (let i = 0; i < SEED_5S_PAGES; i++) {
      const rows = await historyRequest(asset, 5, cursor, 1000);
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
        const rows = await historyRequest(asset, tf, now, tf * SEED[tf]);
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
  async function refresh(asset, tf, count = 6) {
    const F = feeds.get(asset);
    if (!F?.feed.lastTick) return;
    if (OTC.SUBMINUTE(tf)) { // from 5s history
      const five = await historyRequest(asset, 5, Math.floor(F.feed.lastTick.ts), Math.max(60, tf * (count + 1)));
      if (five?.length) { F.feed.merge(5, five); if (tf !== 5) F.feed.merge(tf, fromFive(five, tf)); }
      return;
    }
    const rows = await historyRequest(asset, tf, Math.floor(F.feed.lastTick.ts), tf * count);
    if (rows?.length) {
      F.feed.merge(tf, rows);
      if (STORED.includes(tf)) post({ type: 'candles', asset, rows, tf });
    }
  }

  // Dashboard/worker asked for deep history (research or resolving old records).
  async function fetchHistory({ reqId, asset, hours = 24, tf = 300 }) {
    let cursor = Math.floor(state.lastTick?.ts ?? Date.now() / 1000);
    const target = cursor - hours * 3600, PAGE = tf * 200;
    let total = 0, fails = 0;
    while (cursor > target) {
      const rows = await historyRequest(asset, tf, cursor, PAGE);
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
      const keep = !OTC.SUBMINUTE(tf) || a.decision !== 'SKIP' || scan.status === 'DEEP';
      const record = X.f5.ready ? OTC.Pipeline.toRecord(X, a, scan, { source: 'live', asset, payout: payoutOf(asset), entryTick: tick.price, snapshot: tf > 60 }) : null;
      if (record && OTC.SUBMINUTE(tf)) record.strategies = record.strategies.filter((x) => x[3]);
      if (record && keep) {
        record.facts = facts;
        record.profile = { ...OTC.TF };
        record.frameQuality = F.q?.[tf]?.score ?? null;
        record.scanned = !!F.polled;
        post({ type: 'decision', record, cand: null, poNow: tick.ts });
      }
      Fr.last = { facts, decision: a.decision, lean: a.lean, deep: a.confidence, setup: a.setupName || null, combo: a.combo || null, tf,
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
      const hard = a.lean === o.dir && tf >= o.tf ? a.contradiction?.hard || [] : [];
      stepOpp(asset, o, { kind: 'close', now: tick.ts, price: tick.price, reanalysis: { tf, decision: a.decision, hardAgainst: hard } });
    }
    if (!dir) return;
    if (conflict) { frameOf(F, tf).last.conflict = true; return; } // frames disagree: neither side is taken
    if (!F.sel?.setupFrames.includes(tf)) { frameOf(F, tf).last.unclear = true; return; } // frame too noisy to trade setups on
    const same = F.opps.find((o) => Opp.isActive(o) && o.dir === dir);
    if (same) { if (!same.alsoOn.includes(tf)) same.alsoOn.push(tf); return; }
    const P = res.profile, f = X.f5, s = OTC.U.side(dir);
    const spec = {
      asset, tf, timingTf: P.TIMING, setupTime: lastC.time, closePrice: lastC.close, atr: f.atr, dir,
      kind: facts.kind, setup: a.setup, setupName: a.setupName, combo: a.combo, confidence: a.confidence,
      invalidation: invalidationOf(f, dir), regime: X.regime.regime, facts, frames: { setup: tf, mid: P.MID, macro: P.MACRO, timing: P.TIMING },
      levelAtr: OTC.Strategies.H.opposingDist(X, s), vol: f.volatility.state, accel: !!f.momentum.accel,
      strategies: record?.strategies || [], disc: record?.disc, evidenceFor: a.evidenceFor.slice(0, 8), evidenceAgainst: a.evidenceAgainst.slice(0, 8),
      risk: a.risk || null, recordId: record?.id || null, payout: payoutOf(asset), copy: facts.copy || null,
      hard: a.contradiction?.hard || [], dqOk: res.dq?.ok !== false, frameQuality: F.q?.[tf]?.score ?? null, scanned: !!F.polled,
      signal: X.signal ? { dir: X.signal.dir ?? null, source: X.signal.source, confidence: X.signal.confidence ?? null } : null,
    };
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
    return seen[asset] || seen['*'] || PO_PRESETS;
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
    const cal = OTC.Calibration.assess({ frame: o.tf, setup: o.setup, kind: o.kind, dir: o.dir, regime: o.regime, asset: o.asset, payout: payout ?? 85 },
      calTables, { cfg, available: availableFor(o.asset), expiryOpts: { f: { volatility: { state: o.vol }, momentum: { accel: o.accel } }, levelAtr: o.levelAtr } });
    const measured = cal.measured;
    if (measured && !(cal.ev > 0)) blocks.push('no_edge');           // the data says this kind of setup loses money at this payout
    if (measured && cal.stable === false) blocks.push('unstable');   // …or worked only in part of the time
    if (!measured && g.requireHistory) blocks.push('insufficient_data');
    if (o.hard?.length) blocks.push('contradiction');
    if (o.risk === 'HIGH') blocks.push('risk_high');
    if (o.dqOk === false) blocks.push('data');
    if (o.copy?.dir && !o.copy.agree && !o.copy.late) blocks.push('copy_against');
    if (calStatus.status === 'REJECTED') blocks.push('model_rejected');
    return { ...cal, payout, minPayout: g.minPayout, measured, qualified: !blocks.length, blocks: [...new Set(blocks)] };
  }

  // ENTER_NOW: final gate, duration from the calibration, and — if qualified — hand the entry to
  // the worker (ranking, risk, execution mode). Below the gate it is GATED: logged, not traded.
  function onEnter(asset, o, entry) {
    const F = feeds.get(asset), now = F.feed.lastTick.ts;
    o.cal = qualify(o);
    o.expiry = { sec: o.cal.expirySec, source: o.cal.expiry.source, reason: o.cal.expiry.reason };
    if (!o.cal.qualified) {
      Opp.markGated(o, now, o.cal.blocks.join(','));
      post({ type: 'decision', record: oppRecord(o), cand: null, poNow: now });
      return;
    }
    Opp.markEntered(o, now, entry.why);
    const record = oppRecord(o);
    const entryTf = entry.tf || o.tf;
    const cand = {
      id: record.id, kind: 'opp', asset, dir: o.dir, candleTime: record.candleTime, entryTime: entry.time, entryPrice: entry.price,
      entryAtr: entry.atr || o.atr, entryTf, validFor: OTC.entryWindow(cfg, entryTf), expirySec: o.expiry.sec, tf: o.tf, frames: o.frames,
      invalidation: o.invalidation, deep: o.confidence, setup: o.setup, setupName: o.setupName, regime: o.regime, combo: o.combo,
      evidenceAgainst: o.evidenceAgainst, atr: o.atr, strategies: o.strategies, payout: o.cal.payout ?? o.payout, disc: o.disc, facts: o.facts, why: entry.why,
      cal: calSummary(o.cal), frameQuality: o.frameQuality, scanned: o.scanned, copy: o.copy,
    };
    post({ type: 'decision', record, cand, poNow: now });
  }

  // An opportunity that ended without an entry is still logged (lean, from the setup close), so
  // waiting, missing and invalidating can be measured against what price actually did.
  function finish(asset, o) {
    post({ type: 'decision', record: oppRecord(o), cand: null, poNow: feeds.get(asset)?.feed.lastTick?.ts });
  }

  const calSummary = (c) => (c ? { status: c.status, measured: c.measured, winProb: c.winProb, interval: c.interval, ev: c.ev, evLo: c.evLo, p: c.p, n: c.n,
    payout: c.payout, minPayout: c.minPayout, qualified: c.qualified, blocks: c.blocks, source: c.source, level: c.level, key: c.key, oos: c.oos,
    stable: c.stable, reason: c.reason, version: c.version } : null);

  function oppRecord(o) {
    const reached = (o.state === 'ENTERED' || o.state === 'GATED') && o.entry, entered = o.state === 'ENTERED', t = reached ? o.entry.time : o.closeTime;
    const entryTf = reached ? o.entry.tf || o.tf : o.tf;
    // tf 1: exits are keyed by SECONDS after `ts` (5s … 30 min). Entries on seconds frames get every
    // horizon (5s closes resolve them); entries on minute frames the ≥ 60s ones (1M closes).
    const horizons = cfg.oppHorizonsSec.filter((h) => OTC.SUBMINUTE(entryTf) || h >= 60);
    return {
      id: `opp|${o.asset}|${o.tf}|${o.closeTime}`, v: OTC.VERSION, kind: 'opp', tf: 1, horizons, frame: o.tf, timingTf: o.timingTf, frames: o.frames,
      source: 'live', asset: o.asset, candleTime: t - entryTf, ts: t, payout: o.cal?.payout ?? o.payout, decision: entered ? o.dir : 'SKIP', lean: o.dir,
      deep: o.confidence, regime: o.regime, setup: o.setup, combo: o.combo, strategies: o.strategies, disc: o.disc, setupKind: o.kind,
      state: o.state, path: o.history.map((h) => h.state), why: o.history[o.history.length - 1]?.why || null, alsoOn: o.alsoOn,
      waitSec: t - o.closeTime, expirySec: reached ? o.expiry.sec : null, expiry: reached ? { source: o.expiry.source, reason: o.expiry.reason } : null,
      entryPrice: reached ? o.entry.price : o.closePrice, invalidation: o.invalidation, copy: o.copy,
      cal: calSummary(o.cal), profile: o.frames, frameQuality: o.frameQuality, scanned: o.scanned,
      // what the system knew at that moment (rebuildable later): roles of each frame, platform signal, raw score,
      // durations the platform offered, versions
      roles: { context: o.frames?.mid ?? null, macro: o.frames?.macro ?? null, setup: o.tf, confirmation: o.timingTf ?? null, entryTiming: reached ? o.entry.tf ?? o.tf : null },
      signal: o.signal || null, rawScore: o.confidence, availableExpiries: availableFor(o.asset),
      engineVersion: (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return null; } })(),
      exits: {}, status: 'pending', facts: o.facts, evidenceFor: o.evidenceFor, evidenceAgainst: o.evidenceAgainst, risk: o.risk,
      riskFlags: [], skipReasons: entered ? [] : o.state === 'GATED' ? [`entry gate: ${o.cal?.blocks?.join(', ')}`] : [`opportunity ${o.state.toLowerCase()}`], exec: null, setupRecord: o.recordId,
    };
  }

  // ── tick entry point (called by bot.js for every tick of every asset) ──────
  // synthetic: a tick rebuilt from a scanned pair's 1M history (see replay1m)
  // A pair is LIVE only with a steady price flow (a chart showing it). PO also sends occasional prices
  // for other pairs; built from those, candles would be full of holes. Such pairs stay with the
  // scanner (1M history each minute) until their flow is steady.
  const LIVE_TICKS_PER_MIN = 6;
  function noteTick(F, ts) {
    const t = (F.ticks ||= []);
    t.push(ts);
    while (t.length && t[0] < ts - 60) t.shift();
    return t.length >= LIVE_TICKS_PER_MIN;
  }

  function onTick(asset, ts, price, synthetic = false) {
    if (!/_otc$/i.test(asset) && !cfg.allowNonOtc) return;
    let F = feeds.get(asset);
    if (!F) { F = { feed: new OTC.Feed.Feed(asset), frames: {}, opps: [], polled: true, createdAt: Date.now() }; feeds.set(asset, F); }
    if (!synthetic) {
      const steady = noteTick(F, ts);
      if (F.polled) {
        if (!steady) return;  // occasional prices: not a chart pair (the scanner's 1M history is the better source)
        F.polled = false;     // steady flow: the pair is on a chart here, live ticks take over
        F.lastPolled = null;
        // seconds frames weren't seeded while it was scanned
        if (F.seededAt && anySubminute(F) && F.feed.series[5].closed().length < 200) seedSeconds(asset, F).catch(() => {});
      }
    }
    const closes = F.feed.ingest(ts, price);
    if (!F.seededAt && !F.seeding) seed(asset);
    const guard = (fn) => { try { fn(); F.error = null; } catch (e) { F.error = String(e?.message || e); console.warn('[PO Bot] intel', e); } };

    // 1. every tick: invalidation, missed move, expiry of live opportunities
    for (const o of F.opps) if (Opp.isActive(o)) guard(() => stepOpp(asset, o, { kind: 'tick', now: ts, price }));
    // 2. confirmation candles (before new setups, so a setup is never confirmed by its own last minute)
    for (const x of closes) if (!x.candle.partial) guard(() => onCandleClose(asset, x.tf, x.candle));

    // 3. setup frames that closed a candle. A candle that started before this tab saw it has unknown
    // open/high/low: fetch it from PO first, otherwise the analysis is a data-gap SKIP.
    const frames = setupFrames(F);
    const due = closes.filter((x) => frames.includes(x.tf)).map((x) => x.tf).sort((a, b) => b - a); // larger frames first
    // Candles to fetch from PO before analysing: a partial first candle (unknown open/high/low), or a
    // recent gap — PO's history often ends a minute or two before live candles begin, and a recent gap
    // would block that frame for 30 candles. At most one repair per frame per minute.
    const repairs = (F.repairAt ||= {});
    const gapped = closes.filter((x) => !x.candle.partial && neededFrames(F).includes(x.tf) && ts - (repairs[x.tf] ?? -1e9) >= 60
      && F.feed.series[x.tf].recentGap(30)).map((x) => x.tf);
    for (const tf of gapped) repairs[tf] = ts;
    const partial = [...new Set([...closes.filter((x) => x.candle.partial && neededFrames(F).includes(x.tf)).map((x) => x.tf), ...gapped])];
    const run = () => {
      // which frames are readable right now, and their roles (seconds frames close every few seconds:
      // re-scoring every frame on each of those closes would be wasted work)
      if (!F.selAt || ts - F.selAt >= 30 || due.some((tf) => tf >= 60)) guard(() => { selectFrames(asset); F.selAt = ts; });
      for (const tf of due) guard(() => onSetupClose(asset, tf, analyse(asset, tf, { full: true })));
      beat();
    };
    if (due.length) {
      if (partial.length) Promise.all(partial.map((tf) => refresh(asset, tf, gapped.includes(tf) ? 40 : 3))).then(run);
      else { run(); if (!F.polled) for (const tf of due) if (tf > 60) refresh(asset, tf); } // check live candles against PO (not every few seconds)
    }
    // 4. on each minute: refresh scanners and take a provisional look at larger frames' forming candles
    if (closes.some((x) => x.tf === 60)) {
      for (const tf of frames) if (!due.includes(tf)) guard(() => { analyse(asset, tf, { full: false }); if (tf > 60) provisional(asset, tf); });
      const m1 = closes.find((x) => x.tf === 60);
      if (!m1.candle.partial) post({ type: 'candles', asset, rows: [m1.candle], tf: 60 }); // outcomes are resolved from 1M closes
    }
    // 5s closes resolve the seconds horizons of entries on seconds frames (live pairs only)
    const s5 = closes.find((x) => x.tf === 5);
    if (s5 && !s5.candle.partial && !F.polled && anySubminute(F)) post({ type: 'candles', asset, rows: [s5.candle], tf: 5 });
    if (!F.polled) for (const tf of [900, 1800, 3600]) if (closes.some((x) => x.tf === tf) && !partial.includes(tf) && !due.includes(tf) && neededFrames(F).includes(tf)) refresh(asset, tf, 3);
    // context-only frames with a gap are refilled too (no analysis waits for them)
    for (const tf of gapped) if (!due.includes(tf)) refresh(asset, tf, 40);
    if ((closes.length && !synthetic) || Date.now() - lastBeat > 5000) beat();
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
    return (state.assets || []).filter((a) => /_otc$/i.test(a.symbol) && a.active !== false && (a.payout ?? 0) >= (cfg.scanner.minPayout || 0) && !taken.has(a.symbol))
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
      const list = scanList();
      for (const [a, F] of feeds) if (F.polled && !list.includes(a)) feeds.delete(a);
      for (const asset of list) {
        if (!scanRole.leader) break;
        let F = feeds.get(asset);
        if (F && !F.polled) continue;
        if (!F) { F = { feed: new OTC.Feed.Feed(asset), frames: {}, opps: [], polled: true }; feeds.set(asset, F); }
        if (!F.seededAt) { await seed(asset); if (!F.seededAt) continue; }
        const now = Math.floor(state.lastTick?.ts ?? Date.now() / 1000);
        // back to the last minute replayed (or the end of the seeded history), so no minute is skipped
        const from = F.lastPolled ?? F.feed.series[60].closed(1)[0]?.time ?? now - 360;
        const rows = await historyRequest(asset, 60, now, Math.min(3600, Math.max(360, now - from + 120)));
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
      if (!F.polled && F.feed.lastTick && now - F.feed.lastTick.ts > 45) {
        F.polled = true; F.ticks = []; F.lastPolled = null; F.feed.lastTick = null;
      }
      const lastSeen = Math.max(F.feed.lastTick?.ts ?? 0, F.ticks?.[F.ticks.length - 1] ?? 0);
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
    return { id: o.id, state: o.state, dir: o.dir, tf: o.tf, timingTf: o.timingTf, kind: o.kind, setupName: o.setupName, confidence: o.confidence,
      closeTime: o.closeTime, expiresAt: o.expiresAt, entry: o.entry, expiry: o.expiry || null, alsoOn: o.alsoOn, frames: o.frames,
      why: o.history[o.history.length - 1]?.why || null, facts: o.facts, copy: o.copy || null, cal: calSummary(o.cal), scanned: !!o.scanned, action: o.action || null };
  }
  function view(F) {
    const now = F.feed.lastTick?.ts ?? Date.now() / 1000;
    const live = F.opps.filter(Opp.isActive).sort((a, b) => (b.cal?.qualified ? 1 : 0) - (a.cal?.qualified ? 1 : 0) || (b.cal?.p ?? 0) - (a.cal?.p ?? 0) || b.confidence - a.confidence)[0];
    const ended = F.opps.filter((o) => !Opp.isActive(o)).sort((a, b) => (b.history.at(-1)?.at ?? 0) - (a.history.at(-1)?.at ?? 0))[0];
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
    return { opp: oppView(live || recent), watch, frames, last: pick?.last || null, scan: pick?.scan || null, regime: pick?.regime || null, dq: pick?.dq || null };
  }

  function beat() {
    lastBeat = Date.now();
    if (!port) connect();
    post({
      type: 'state', poNow: state.lastTick?.ts ?? null, chartAsset: state.asset, armed: state.running && isIntel(), isDemo: isDemoAccount(),
      // which engine trades in this tab, and its open trades (so the popup shows the same picture as the panel)
      engine: isIntel() ? 'intel' : 'legacy', running: state.running, switching,
      openTrades: state.trades.map((t) => ({ asset: t.asset, dir: t.dir.toUpperCase(), stake: t.stake, expiry: t.expiry, openedAt: t.openedAt, intel: !!t.intelId })),
      assets: liveFeeds().map(([asset, F]) => {
        const v = view(F);
        return {
          asset, payout: payoutOf(asset), scan: v.scan, regime: v.regime ? { regime: v.regime.regime, confidence: v.regime.confidence, reasons: v.regime.reasons } : null,
          last: v.last, opp: v.opp, watch: v.watch, frames: v.frames, error: F.error || null, scanned: !!F.polled,
          feed: { counts: F.feed.counts(), lastTickTs: F.feed.lastTick?.ts ?? null, seeded: !!F.seededAt, missing: F.historyMissing || [],
            dqOk: v.dq?.ok ?? null, issues: (v.dq?.issues || []).slice(0, 6).map((i) => `${i.tf ? OTC.TF_LABEL[i.tf] + ' ' : ''}${i.detail}`) },
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
  let switching = false;
  async function switchTo(asset) {
    if (state.asset === asset) return null;
    if (switching) return 'already switching';
    if (!(state.running && isIntel()) || state.placing || state.trades.length) return 'tab busy or not armed';
    switching = true;
    const before = state.lastTick?.ts ?? 0;
    try {
      const err = await switchAsset(asset);
      if (err) return err;
      for (let i = 0; i < 20 && !(state.lastTick && state.lastTick.ts > before); i++) await sleep(150);
      return null;
    } finally { switching = false; }
  }

  async function execute(cmd) {
    const fail = (reason) => post({ type: 'execResult', id: cmd.id, status: 'failed', reason });
    if (!(state.running && isIntel())) return fail('tab not armed — choose Intel mode in this tab and press Start');
    if (state.settings.demoOnly && !isDemoAccount()) return fail('Demo-only is on and this is not a demo account');
    if (state.placing || state.trades.length || switching) return fail('a trade is already being placed or open in this tab');
    const lim = limitHit();
    if (lim) return fail(`tab limit: ${lim}`);
    if (cmd.asset !== state.asset) {
      if (!cmd.switch) return fail(`this tab's chart shows ${state.asset}, not ${cmd.asset}`);
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
        const o = F?.opps.find((x) => `opp|${x.asset}|${x.tf}|${x.closeTime}` === cmd.id);
        if (o && o.state !== 'ENTERED') flags.push(`opportunity is ${o.state}`);
        const late = ts - cmd.entryTime;
        if (late > cmd.validFor) flags.push(`entry window missed (${Math.round(late)}s after the entry candle, window ${cmd.validFor}s)`);
        const move = ((price - cmd.entryPrice) / (cmd.entryAtr || cmd.atr)) * (up ? 1 : -1);
        if (move > cfg.maxChaseAtr) flags.push(`price already moved ${move.toFixed(2)} ATR our way — chasing`);
        if (move < -cfg.maxAdverseAtr) flags.push(`sudden opposite move ${(-move).toFixed(2)} ATR`);
        if (cmd.invalidation != null && (up ? price < cmd.invalidation : price > cmd.invalidation)) flags.push('price beyond the invalidation level');
        if (F?.opps.some((x) => Opp.isActive(x) && x.dir !== cmd.dir)) flags.push('an opposite opportunity opened on this pair');
        // recalculate, never reuse: market state, copy trades, calibrated confidence and duration
        if (o) {
          try { analyse(cmd.asset, o.tf, { full: false }); } catch (_) {}
          const rg = F.frames[o.tf]?.regime?.regime;
          if (rg && rg !== o.regime) flags.push(`market state changed (${o.regime} → ${rg})`);
          const ct = copyFor(cmd.asset, ts);
          if (ct?.dir && ct.dir !== cmd.dir && !ct.late) flags.push('copy trades turned against');
          const q = qualify(o);
          if (!q.qualified) flags.push(`no longer qualified: ${q.blocks.join(', ')}`);
          else if (q.expirySec !== cmd.expirySec && q.expirySec !== expirySec) flags.push(`duration changed to ${q.expirySec}s`);
        }
        return { ok: !flags.length, flags };
      }
      return OTC.Risk.entryTiming({ candleTime: cmd.candleTime, nowSec: ts, price, closePrice: cmd.closePrice, atr: cmd.atr, dir: cmd.dir, cfg, tf: cmd.tf || 300 });
    };
    let t = safety();
    if (!t.ok) return fail(t.flags.join('; '));
    const payout = readPayout() ?? payoutOf(cmd.asset);
    if (payout == null) return fail('payout unknown');
    if (payout < cfg.gate.minPayout) return fail(`payout ${payout}% < ${cfg.gate.minPayout}%`);
    if (payout < state.settings.minPayout) return fail(`payout ${payout}% < ${state.settings.minPayout}%`);

    state.placing = true;
    try {
      const err = await setExpiry(expirySec);
      if (err) return fail(`could not set expiry ${expirySec}s: ${err}`);
      const stake = state.settings.amount;
      if (!setAmount(stake)) return fail('could not set the trade amount');
      await sleep(300);
      t = safety(); // background tabs can delay timers — re-check right before clicking
      if (!t.ok) return fail(`changed while preparing: ${t.flags.join('; ')}`);
      const dir = cmd.dir.toLowerCase();
      if (!clickDirection(dir)) return fail('CALL/PUT button not found');
      const trade = { id: null, intelId: cmd.id, dir, stake, expiry: expirySec, asset: cmd.asset, openedAt: Date.now(),
        voters: [`intel:${cmd.setup || 'setup'}`], payout, demo: isDemoAccount() };
      state.trades.push(trade);
      state.status = `Intel: opened ${cmd.dir} ${cmd.asset} (${cmd.setupName || cmd.setup})`;
      post({ type: 'execResult', id: cmd.id, status: 'placed', stake, demo: trade.demo, expirySec });
      // PO confirms with an order id (onOrderOpened). No id → the click may not have registered.
      setTimeout(() => post({ type: 'execResult', id: cmd.id, status: trade.id ? 'confirmed' : 'unconfirmed', poId: trade.id }), 8000);
      setTimeout(() => { if (state.trades.includes(trade)) finishTrade(trade, null, 'unknown'); }, Math.max(RESULT_TIMEOUT_MS, (expirySec + 90) * 1000) + 1000);
    } finally {
      state.placing = false;
      render();
    }
  }

  function onTradeClosed(t, result, profit) {
    post({ type: 'tradeClosed', id: t.intelId, result, profit, stake: t.stake });
  }

  // ── panel text ─────────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function statusLine() {
    const F = feeds.get(state.asset);
    if (!F) return 'المحرك الذكي: بانتظار الأسعار';
    const v = view(F), now = F.feed.lastTick?.ts ?? Date.now() / 1000;
    if (!v.last && !v.opp) return 'المحرك الذكي: يجمع البيانات';
    return `المحرك الذكي: ${AR.pairStatus({ ...v, feed: { dqOk: v.dq?.ok } }, now).label}`;
  }
  function heroLine() {
    const F = feeds.get(state.asset);
    if (!F) return 'بانتظار الأسعار';
    const v = view(F), st = AR.pairStatus({ ...v, feed: { dqOk: v.dq?.ok } }, F.feed.lastTick?.ts ?? Date.now() / 1000);
    return esc(`${st.label}${v.regime ? ` · ${AR.regime(v.regime.regime)}` : ''}${port ? '' : ' · غير متصل بالنظام'}`);
  }
  function panelHtml() {
    const list = liveFeeds();
    if (!list.length) return 'المحرك الذكي: لم تصل أسعار OTC بعد';
    const nowTs = state.lastTick?.ts ?? Date.now() / 1000;
    return list.map(([asset, F]) => {
      const v = view(F), st = AR.pairStatus({ ...v, feed: { dqOk: v.dq?.ok } }, nowTs);
      return `<div><b dir="ltr">${esc(OTC.U.pairLabel(asset))}</b> · ${esc(st.label)}${v.regime ? ` · ${esc(AR.regime(v.regime.regime))}` : ''}${F.error ? ' · <span class="neg">خطأ في التحليل</span>' : ''}</div>`;
    }).join('') + `<div class="no">${port ? 'متصل بالنظام' : 'غير متصل بالنظام'} · ${state.running && isIntel() ? 'التبويب مفعّل للتنفيذ' : 'التبويب غير مفعّل للتنفيذ'}</div>`;
  }
  function openDashboard() {
    try { chrome.runtime.sendMessage({ type: 'openDashboard' }); } catch (_) {}
  }

  // The same per-pair view the popup gets from the worker, for the in-page panel.
  function pairView(asset) {
    const F = feeds.get(asset);
    if (!F) return null;
    const v = view(F);
    return { asset, ...v, feed: { dqOk: v.dq?.ok ?? null }, nowTs: F.feed.lastTick?.ts ?? Date.now() / 1000 };
  }

  globalThis.IntelTab = { onTick, onUnsolicitedHistory, onTradeClosed, statusLine, heroLine, panelHtml, openDashboard, pairView, feeds,
    entryWindow: (tf) => OTC.entryWindow(cfg, tf), cfg: () => cfg, pollOnce, scanList };
  connect();
})();
