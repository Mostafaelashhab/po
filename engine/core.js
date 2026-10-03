// OTC Intelligence Engine — shared namespace, default config and helpers.
//
// Every engine file is a plain script that attaches to globalThis.OTC, so the
// same code runs in the Pocket Option tab (content script), the service worker
// (importScripts), the dashboard page (<script>) and Node tests (vm context).
// Engine files are pure: no DOM, no chrome.*, no clocks — time is always passed in.
(function (G) {
  const OTC = (G.OTC = G.OTC || {});

  OTC.VERSION = 1;

  // Timeframe roles, in seconds. No frame is "the" trading frame: every enabled SETUP
  // frame (cfg.setupFrames) is analysed at its own candle close, each with its own
  // context and confirmation frames, and the opportunity manager picks between them.
  //   setup 1M : context 5M + 15M, no finer confirmation frame
  //   setup 5M : context 15M + 1H, confirmation 1M
  //   setup 15M: context 30M + 1H, confirmation 5M
  OTC.PROFILES = {
    5: { PRIMARY: 5, MID: 30, MACRO: 60, TIMING: null },
    10: { PRIMARY: 10, MID: 30, MACRO: 300, TIMING: 5 },
    15: { PRIMARY: 15, MID: 60, MACRO: 300, TIMING: 5 },
    30: { PRIMARY: 30, MID: 60, MACRO: 300, TIMING: 5 },
    60: { PRIMARY: 60, MID: 300, MACRO: 900, TIMING: null },
    300: { PRIMARY: 300, MID: 900, MACRO: 3600, TIMING: 60 },
    900: { PRIMARY: 900, MID: 1800, MACRO: 3600, TIMING: 300 },
  };
  OTC.FEED_TFS = [5, 10, 15, 30, 60, 300, 900, 1800, 3600]; // every tab builds these; a profile only assigns roles
  OTC.SUBMINUTE = (tf) => tf < 60; // seconds frames: live ticks only (5s history seeds them), never scanned pairs
  // OTC.TF is the ACTIVE role mapping. It is switched in place, synchronously, around each analysis
  // (withProfile), so every module holding a reference to OTC.TF sees the right roles.
  OTC.TF = { ...OTC.PROFILES[300] };
  // A profile is a setup frame (default roles) or a role object chosen per pair by engine/frameselect.js.
  OTC.applyProfile = (p) => Object.assign(OTC.TF, typeof p === 'object' && p ? p : OTC.PROFILES[p] || OTC.PROFILES[300]);
  OTC.withProfile = (p, fn) => {
    const prev = { ...OTC.TF };
    OTC.applyProfile(p);
    try { return fn(); } finally { Object.assign(OTC.TF, prev); }
  };
  // Role of a timeframe in the active profile.
  OTC.roleOf = (tf) => (tf === OTC.TF.PRIMARY ? 'primary' : tf === OTC.TF.MID ? 'mid' : tf === OTC.TF.MACRO ? 'macro' : tf === OTC.TF.TIMING ? 'timing' : null);
  OTC.minCandles = (cfg, tf) => cfg.minCandles?.[OTC.roleOf(tf)] ?? 20;
  // Seconds after a setup candle closes in which an immediate entry is still "at the close".
  OTC.entryWindow = (cfg, tf = OTC.TF.PRIMARY) => cfg.entryWindowByFrame?.[tf] ?? cfg.entryWindowSec;
  OTC.TF_LABEL = { 5: '5S', 10: '10S', 15: '15S', 30: '30S', 60: '1M', 300: '5M', 900: '15M', 1800: '30M', 3600: '1H' };

  OTC.REGIMES = ['TRENDING_UP', 'TRENDING_DOWN', 'RANGING', 'BREAKOUT', 'REVERSAL',
    'HIGH_VOLATILITY', 'LOW_VOLATILITY', 'TRANSITIONING', 'UNCLEAR'];

  OTC.EXEC_MODES = ['OBSERVE', 'PAPER', 'ALERT', 'MANUAL', 'AUTO'];

  // Initial values only. Every number here is a starting assumption to be tested,
  // not a known-good setting. The dashboard edits them; the stats engine judges them.
  OTC.DEFAULT_CONFIG = {
    execMode: 'PAPER',
    setupFrames: [5, 10, 15, 30, 60, 300, 900], // frames on which setups are looked for; none is privileged
    autoDemoAll: true,        // AUTO on a demo account: every QUALIFIED entry (true) or promoted profiles only
    autoRealAll: false,       // AUTO on a real account: same choice; the user sets it
    autoSwitch: true,         // AUTO: an armed tab may switch its chart (PO's asset list) to a pair with a qualified opportunity
    // Entry gate. No fixed confidence number: nothing is entered (paper or real) on a pair paying
    // less than minPayout; a MEASURED opportunity is entered only if its expected value at the
    // current payout is positive and its cohort is stable (engine/calibration.js). Without enough
    // outcomes it is INSUFFICIENT_DATA: allowed on demo (that is how data is gathered), never on a
    // real account; with requireHistory on, not even on demo.
    gate: {
      minPayout: 92,          // % — the user's hard requirement
      requireHistory: false,  // true: no entry anywhere until similar setups have enough measured outcomes
      minOOS: 30,             // out-of-sample outcomes needed before a cohort gives a confidence at all
      minTableN: 10,          // smaller cohorts are not sent to the tabs
      selFraction: 0.6,       // older 60% chooses the duration, newer 40% is out-of-sample
      folds: 3, foldMinN: 10, // walk-forward folds: any fold (≥ foldMinN) below break-even → unstable → no entry
      priorStrength: 20,      // sceptical prior: 20 pseudo-trades at exactly break-even
      monitorMinN: 30,        // entries let through on measured evidence needed before the monitor can confirm or reject the model
    },
    // Dynamic timeframe selection (engine/frameselect.js): allowed roles per setup frame.
    frameSelect: {
      minSetupQuality: 40,    // a frame less readable than this cannot open opportunities (still logged)
      minConfirmQuality: 35,  // a confirmation frame noisier than this is not used (entry at setup closes)
      options: {
        5: { MID: [30], MACRO: 60, TIMING: [null] },
        10: { MID: [30, 60], MACRO: 300, TIMING: [5] },
        15: { MID: [60], MACRO: 300, TIMING: [5] },
        30: { MID: [60], MACRO: 300, TIMING: [5, 10] },
        60: { MID: [300], MACRO: 900, TIMING: [null] },
        300: { MID: [900, 1800], MACRO: 3600, TIMING: [60] },
        900: { MID: [1800], MACRO: 3600, TIMING: [300, 60] },
      },
    },
    // Pairs without an open chart are scanned from PO's history (latest 1M candles each minute)
    // by one tab. They can be analysed and paper-traded; real execution needs the pair on a chart.
    scanner: { enabled: true, maxPairs: 20, minPayout: 92, pollSec: 60 }, // scan budget goes to pairs that can be traded
    // Scanner bands: below watch → IGNORE, watch..deep → WATCH, ≥ deep → DEEP ANALYSIS.
    watchThreshold: 55,
    deepThreshold: 70,
    // Deep analysis also runs below the scanner threshold, but only to log a research
    // record (decision is still SKIP). This measures whether the scanner filter helps.
    researchDeepAll: true,
    minDeepConfidence: 70,
    minStrategyScore: 60,
    // Confluence module weights (%). Initial guesses — see stats "module" view.
    weights: { trend: 15, structure: 15, priceAction: 15, sr: 10, momentum: 10, volatility: 10,
      breakout: 10, fibonacci: 5, bollinger: 5, signal: 5 },
    // How deep confidence is blended. Also initial guesses.
    blend: { strategy: 0.45, confluence: 0.35, htf: 0.20 },
    // Expiries tested for every record, in 5M candles. paperExpiry is what paper/real trades use.
    expiries: [1, 2, 3],
    paperExpiry: 1,
    entryWindowSec: 30,       // a decision must be acted on in the first N seconds of the candle (5M frame)
    entryWindowByFrame: { 5: 3, 10: 4, 15: 5, 30: 8, 60: 12, 300: 30, 900: 60 },
    // Opportunity lifecycle (engine/opportunity.js)
    opportunity: {
      validityCandles: { 5: 3, 10: 2, 15: 2, 30: 1, 60: 2, 300: 1, 900: 1 }, // how long a setup stays enterable, in setup candles
      enterNowConfidence: 80,  // at/above this, enter at the setup close without waiting for confirmation
      confirmBodyAtr: 0.3,     // a confirmation candle must close in direction with at least this body (its own ATR)
      retestAtr: 0.25,         // after a chase, price must come back within this of the setup close
      missedAtr: 1.0,          // moved this far (setup ATR) without coming back → missed
    },
    // Expiries the engine may choose from (seconds); narrowed to what the platform offers for the pair.
    expiryChoices: [5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800],
    // Outcome horizons recorded for every opportunity, in SECONDS after entry (used to learn which
    // expiry works). Entries on a minute boundary record only the ≥ 60s ones (1M closes resolve them).
    oppHorizonsSec: [5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800],
    maxChaseAtr: 0.5,         // price moved this far (5M ATR) since the close → too late
    maxAdverseAtr: 0.5,       // price moved this far against since the close → sudden opposite move
    minCandles: { primary: 60, mid: 30, macro: 30, timing: 20 }, // per role, not per timeframe
    requireHTF: true,         // no 15M/1H data → SKIP
    opposingLevelAtr: 0.5,    // strong opposing level closer than this → hard SKIP
    abnormalRangeAtr: 3,      // last candle range > N×ATR → abnormal market
    staleSec: 20,             // no tick for N seconds → stale
    risk: {
      maxTradesPerDay: 20,
      maxConsecutiveLosses: 4,
      dailyStopUnits: 5,      // stop for the day after losing this many stakes (net)
      lossCooldownMin: 10,
      pairCooldownMin: 10,    // no new trade on a pair within N minutes of the last one on it
      maxConcurrent: 1,
      batchWindowMs: 2500,    // entries from every pair on the same close are ranked together
      batchWindowFastMs: 250, // …but entries on seconds frames can't wait that long
    },
    validation: { split: [0.6, 0.2, 0.2], minTrain: 50, minHoldout: 25, folds: 4, zTrain: 1.645, zHoldout: 1.0 },
    // Which strategy families are allowed to trade in which regime.
    regimeFamilies: {
      TRENDING_UP: ['trend', 'breakout', 'structure', 'confluence', 'fibonacci', 'momentum', 'priceaction', 'bollinger'],
      TRENDING_DOWN: ['trend', 'breakout', 'structure', 'confluence', 'fibonacci', 'momentum', 'priceaction', 'bollinger'],
      RANGING: ['range', 'reversal', 'priceaction', 'bollinger', 'liquidity', 'confluence', 'fibonacci'],
      BREAKOUT: ['breakout', 'momentum', 'structure', 'bollinger'],
      REVERSAL: ['reversal', 'liquidity', 'structure', 'priceaction', 'confluence'],
      HIGH_VOLATILITY: [],
      LOW_VOLATILITY: ['breakout', 'bollinger'],
      TRANSITIONING: ['breakout', 'structure'],
      UNCLEAR: [],
    },
    promotedProfiles: [],     // setup-profile keys a human promoted after validation
    // Opportunity notifications: 'browser' (silent), 'sound', or 'none'.
    ui: { notify: 'browser' },
    // Strategy Discovery Engine. Every threshold is a research guideline, not proof.
    discovery: {
      expiries: [1, 2, 3],          // must be a subset of `expiries` so live records can score them
      directions: ['CALL', 'PUT'],  // tested separately, never assumed symmetric
      split: [0.6, 0.2, 0.2],       // train / validation / out-of-sample, chronological
      maxConditions: 4,             // search depth; more conditions = more ways to overfit
      maxComplexity: 5,             // multi-timeframe repeats of one concept count 0.5
      beamWidth: 30,
      keepPerScope: 20,
      minSupportPct: 1,             // an atom must match at least this % of training rows
      sampleClasses: [100, 300, 1000], // INSUFFICIENT < 100 ≤ PRELIMINARY < 300 ≤ RESEARCH < 1000 ≤ STRONGER
      minTrainN: 100,
      minValN: 50,
      minOosN: 50,
      zTrain: 1.645,                // training lower bound must clear break-even at this z
      zOos: 1.28,                   // out-of-sample lower bound must clear break-even at this z
      fdrQ: 0.10,                   // Benjamini–Hochberg false-discovery rate on validation
      complexityPenalty: 1.0,       // percentage points of lower bound per extra condition
      minGainPP: 0.5,               // a new condition must add at least this much
      wfFolds: 5,
      wfMinPass: 0.6,               // share of periods that must be above break-even
      processWalkForward: true,     // re-run the search on past data and test on the next period
      robustTolPP: 5,               // a nudged parameter may lose at most this many points
      robustMin: 0.5,               // below → LOW robustness → OVERFIT
      oosCollapsePP: 3,
      decayPP: 5,
      variationsPerStrategy: 2,
      mutationSeeds: 15,
      maxNegatives: 2,
      negZ: 2.5,
      filterZ: 3,
      paperMinN: 50,                // live paper signals before a verdict
      paperZ: 0.84,
      decayWindow: 50,
      simplifyTolPP: 1,             // a simpler rule may lose at most this much training lower bound
      timeBudgetSec: 240,
    },
  };

  // ── helpers ────────────────────────────────────────────────────────────────
  const U = (OTC.U = {});
  U.clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
  U.last = (a, k = 1) => a[a.length - k];
  U.sum = (a) => a.reduce((s, x) => s + x, 0);
  U.mean = (a) => (a.length ? U.sum(a) / a.length : null);
  U.body = (c) => Math.abs(c.close - c.open);
  U.range = (c) => c.high - c.low;
  U.green = (c) => c.close > c.open;
  U.red = (c) => c.close < c.open;
  U.upperWick = (c) => c.high - Math.max(c.open, c.close);
  U.lowerWick = (c) => Math.min(c.open, c.close) - c.low;
  U.opp = (d) => (d === 'CALL' ? 'PUT' : d === 'PUT' ? 'CALL' : null);
  U.side = (dir) => ({ dir, up: dir === 'CALL', sg: dir === 'CALL' ? 1 : -1, opp: U.opp(dir) });

  // Percentile rank (0–100) of the last value among the series' non-null values.
  U.pctRank = (series, lookback = 100) => {
    const vals = series.slice(-lookback).filter((v) => v != null && Number.isFinite(v));
    if (vals.length < 10) return null;
    const x = vals[vals.length - 1];
    return (100 * vals.filter((v) => v < x).length) / (vals.length - 1);
  };

  // Deep-merge config overrides onto defaults (objects merge, arrays replace).
  U.mergeConfig = (base, over) => {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    for (const [k, v] of Object.entries(over || {})) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
        ? U.mergeConfig(base[k], v) : v;
    }
    return out;
  };
  OTC.config = (over) => U.mergeConfig(OTC.DEFAULT_CONFIG, over);

  // Merge candles into `period`-second buckets. Only buckets that are complete
  // (every base candle present) are kept, unless allowPartialLast is set, in which
  // case the trailing bucket may be partial and is flagged `partial: true`.
  U.aggregate = (base, res, period, { allowPartialLast = false } = {}) => {
    const per = period / res;
    if (!Number.isInteger(per) || per < 1) return [];
    const out = [];
    let cur = null;
    for (const c of base) {
      const t = Math.floor(c.time / period) * period;
      if (!cur || cur.time !== t) {
        if (cur) out.push(cur);
        cur = { time: t, open: c.open, high: c.high, low: c.low, close: c.close, _n: 1, _first: c.time };
      } else {
        cur.high = Math.max(cur.high, c.high);
        cur.low = Math.min(cur.low, c.low);
        cur.close = c.close;
        cur._n++;
      }
    }
    if (cur) out.push(cur);
    const done = [];
    out.forEach((b, i) => {
      const complete = b._n === per && b._first === b.time;
      const isLast = i === out.length - 1;
      if (complete || (allowPartialLast && isLast)) {
        const x = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close };
        if (!complete) x.partial = true;
        done.push(x);
      }
    });
    return done;
  };

  // Smallest positive gap between consecutive candle times.
  U.resolution = (rows) => {
    let best = Infinity;
    for (let i = 1; i < rows.length; i++) {
      const d = rows[i].time - rows[i - 1].time;
      if (d > 0 && d < best) best = d;
    }
    return Number.isFinite(best) ? best : null;
  };

  // Normalises PO history rows ({time, open, high, low, close} as strings or numbers).
  U.cleanRows = (rows) => (rows || []).map((c) => ({
    time: Number(c.time), open: +c.open, high: +c.high, low: +c.low, close: +c.close,
  })).filter((c) => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite)).sort((a, b) => a.time - b.time);

  // "EURUSD_otc" → ["EUR", "USD"]
  U.currencies = (asset) => {
    const m = /^([A-Z]{3})([A-Z]{3})/.exec(String(asset || '').toUpperCase());
    return m ? [m[1], m[2]] : null;
  };
  U.pairLabel = (asset) => {
    const c = U.currencies(asset);
    return c ? `${c[0]}/${c[1]}${/_otc$/i.test(asset) ? ' OTC' : ''}` : String(asset || '—');
  };

  U.breakEven = (payoutPct) => 100 / (1 + (payoutPct ?? 85) / 100);

  if (typeof module !== 'undefined' && module.exports) module.exports = OTC;
})(typeof globalThis !== 'undefined' ? globalThis : this);
