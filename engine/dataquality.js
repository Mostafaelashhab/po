// Data Quality Engine. Runs before any analysis. A `fatal` issue means the
// series must not be analysed (→ SKIP); `warn` issues are logged as risk flags.
(function (G) {
  const OTC = G.OTC;

  // candles: closed candles, oldest first. opts:
  //   tf          expected timeframe in seconds
  //   now         current PO time (seconds) — for staleness; omit in backtests
  //   minCount    candles needed
  //   lastPrice   latest tick, to catch a chart that diverged from the feed
  //   recentBars  gaps inside this many recent bars are fatal (older ones warn)
  function checkSeries(candles, { tf, now = null, minCount = 30, lastPrice = null, recentBars = 30 } = {}) {
    const issues = [];
    const add = (code, severity, detail) => issues.push({ code, severity, detail });
    const n = candles?.length || 0;
    const stats = { count: n, gaps: 0, missing: 0, duplicates: 0, misaligned: 0, invalid: 0, flat: 0, lastAge: null };

    if (!n) { add('NO_DATA', 'fatal', `no ${OTC.TF_LABEL[tf] || tf + 's'} candles`); return { ok: false, issues, stats }; }
    if (n < minCount) add('TOO_FEW', 'fatal', `${n}/${minCount} ${OTC.TF_LABEL[tf] || tf + 's'} candles`);

    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const valid = [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) && c.open > 0 && c.close > 0
        && c.high >= Math.max(c.open, c.close) - 1e-12 && c.low <= Math.min(c.open, c.close) + 1e-12;
      if (!valid) stats.invalid++;
      if (tf && c.time % tf !== 0) stats.misaligned++;
      if (i) {
        const d = c.time - candles[i - 1].time;
        if (d === 0) stats.duplicates++;
        else if (d < 0) add('OUT_OF_ORDER', 'fatal', `candle ${i} is older than the one before`);
        else if (tf && d > tf) {
          stats.gaps++;
          stats.missing += d / tf - 1;
          const recent = i >= n - recentBars;
          if (recent) add('MISSING_RECENT', 'fatal', `${d / tf - 1} missing candle(s) ${n - i} bars ago`);
        }
      }
    }
    if (stats.gaps && !issues.some((x) => x.code === 'MISSING_RECENT')) add('MISSING_OLD', 'warn', `${stats.missing} older missing candle(s)`);
    if (stats.invalid) add('INVALID_OHLC', 'fatal', `${stats.invalid} malformed candle(s)`);
    if (stats.duplicates) add('DUPLICATE', 'fatal', `${stats.duplicates} duplicated candle(s)`);
    if (stats.misaligned) add('WRONG_TIMEFRAME', 'fatal', `${stats.misaligned} candle(s) not aligned to ${tf}s`);

    const res = OTC.U.resolution(candles);
    if (tf && res && res !== tf && n > 2) add('WRONG_TIMEFRAME', 'fatal', `candles are ${res}s, expected ${tf}s`);

    // Frozen chart: many zero-range candles, or the same close repeated.
    const tail = candles.slice(-10);
    stats.flat = tail.filter((c) => c.high === c.low).length;
    const sameClose = tail.length >= 6 && tail.every((c) => c.close === tail[0].close);
    if (stats.flat >= 5 || sameClose) add('FROZEN', 'fatal', `${stats.flat}/10 flat candles${sameClose ? ', identical closes' : ''}`);

    const last = candles[n - 1];
    if (now != null && tf) {
      // The last closed candle should be the one that ended at the latest boundary.
      stats.lastAge = now - (last.time + tf);
      if (stats.lastAge > tf + 5) add('STALE', 'fatal', `last ${OTC.TF_LABEL[tf] || tf + 's'} candle closed ${Math.round(stats.lastAge)}s ago`);
      if (stats.lastAge < -1) add('FUTURE', 'fatal', 'candle from the future — clock mismatch');
    }
    if (lastPrice != null && Number.isFinite(lastPrice)) {
      const span = Math.max(...tail.map((c) => c.high)) - Math.min(...tail.map((c) => c.low));
      if (span > 0 && Math.abs(lastPrice - last.close) > 10 * span) add('PRICE_MISMATCH', 'fatal', 'live price far from chart — wrong pair or broken feed');
    }
    return { ok: !issues.some((x) => x.severity === 'fatal'), issues, stats };
  }

  // Combined check of a multi-timeframe snapshot. `series` = { 300: [...], 900: [...], 3600: [...], 60: [...] }.
  function checkSnapshot(series, { now = null, cfg = OTC.DEFAULT_CONFIG, lastPrice = null, lastTickAgeSec = null } = {}) {
    const per = {};
    const issues = [];
    const need = [OTC.TF.PRIMARY, ...(cfg.requireHTF ? [OTC.TF.MID, OTC.TF.MACRO] : [])];
    for (const tf of [OTC.TF.PRIMARY, OTC.TF.MID, OTC.TF.MACRO, OTC.TF.TIMING].filter(Boolean)) {
      const s = series[tf];
      if (!s && !need.includes(tf)) continue;
      // HTF series end with a partial (forming) candle built from 5M data; exclude it here.
      const closed = (s || []).filter((c) => !c.partial);
      // a context frame gives direction and levels: a hole a few of its candles back doesn't make it unreadable
      // (PO's history often ends a few minutes before live candles start); the setup frame stays strict
      const r = checkSeries(closed, { tf, now: tf === OTC.TF.PRIMARY ? now : null, minCount: OTC.minCandles(cfg, tf),
        lastPrice: tf === OTC.TF.PRIMARY ? lastPrice : null, recentBars: tf === OTC.TF.PRIMARY ? 30 : 3 });
      per[tf] = r;
      for (const x of r.issues) {
        const required = need.includes(tf);
        issues.push({ ...x, tf, severity: required ? x.severity : 'warn' });
      }
    }
    if (lastTickAgeSec != null && lastTickAgeSec > cfg.staleSec) {
      issues.push({ code: 'FEED_STALE', severity: 'fatal', detail: `no price tick for ${Math.round(lastTickAgeSec)}s`, tf: null });
    }
    return { ok: !issues.some((x) => x.severity === 'fatal'), issues, per };
  }

  OTC.DataQuality = { checkSeries, checkSnapshot };
})(typeof globalThis !== 'undefined' ? globalThis : this);
