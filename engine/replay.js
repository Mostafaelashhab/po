// Historical replay. Walks 5M candles one close at a time and runs the exact live
// pipeline on what was known at that moment (15M/1H are rebuilt from 5M, with
// the forming HTF candle included just like live). Each step yields a record whose
// outcomes are read from the candles that followed.
// Works on any setup frame (tf). Not simulated: confirmation timing, platform signals.
(function (G) {
  const OTC = G.OTC, U = OTC.U;
  const WIN = { primary: 200, mid: 120, macro: 120 };

  // candles: the setup frame's candles (tf seconds). Context frames are built from them.
  async function replay(c, { asset, payout = null, cfg = OTC.DEFAULT_CONFIG, tf = 300, from = null, onProgress = null, yieldEvery = 40, shouldStop = null } = {}) {
    const P = OTC.PROFILES[tf] || OTC.PROFILES[300];
    const candles = U.cleanRows(c).filter((x, i, a) => !i || x.time !== a[i - 1].time);
    const cMid = U.aggregate(candles, tf, P.MID), cMac = U.aggregate(candles, tf, P.MACRO);
    const maxN = Math.max(...cfg.expiries);
    const records = [];
    const flags = ['backtest: entry assumed at the setup candle close', 'backtest: confirmation timing and platform signals not simulated'];
    let jm = 0, jM = 0;
    const start = Math.max(cfg.minCandles.primary, Math.ceil(P.MACRO / tf) * (cfg.minCandles.macro + 1));
    for (let i = start; i < candles.length; i++) {
      if (shouldStop?.()) break;
      const T = candles[i].time, endT = T + tf;
      if (from != null && T < from) continue;
      while (jm < cMid.length && cMid[jm].time + P.MID <= endT) jm++;
      while (jM < cMac.length && cMac[jM].time + P.MACRO <= endT) jM++;
      const rec = OTC.withProfile(tf, () => {
        const w = candles.slice(Math.max(0, i + 1 - WIN.primary), i + 1);
        const series = {
          [tf]: w,
          [P.MID]: OTC.Pipeline.htfWithPartial(cMid.slice(Math.max(0, jm - WIN.mid), jm), w, P.MID),
          [P.MACRO]: OTC.Pipeline.htfWithPartial(cMac.slice(Math.max(0, jM - WIN.macro), jM), w, P.MACRO),
        };
        const dq = OTC.DataQuality.checkSnapshot(series, { cfg });
        const X = OTC.Pipeline.buildContext(series, { cfg });
        const scan = OTC.Pipeline.fastScan(X);
        const a = OTC.Pipeline.deepAnalyze(X, { dq, scan });
        a.riskFlags.push(...flags);
        return OTC.Pipeline.toRecord(X, a, scan, { source: 'backtest', asset, payout });
      });
      let complete = true;
      for (const N of cfg.expiries) {
        const k = i + N;
        if (k < candles.length && candles[k].time === T + N * tf) rec.exits[N] = candles[k].close;
        else complete = false;
      }
      rec.status = complete ? 'resolved' : i + maxN < candles.length ? 'unresolved' : 'pending';
      if (rec.status === 'pending') continue; // the future isn't in this data yet
      records.push(rec);
      if (yieldEvery && i % yieldEvery === 0) {
        onProgress?.({ done: i - start + 1, total: candles.length - start, records: records.length });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    onProgress?.({ done: candles.length - start, total: candles.length - start, records: records.length });
    return records;
  }

  OTC.Replay = { replay };
})(typeof globalThis !== 'undefined' ? globalThis : this);
