// Risk Engine and Entry Timing. Pure functions: the caller owns the state
// object and persists it. The Risk Engine can veto anything the strategy side wants.
(function (G) {
  const OTC = G.OTC, U = OTC.U;

  const dayKey = (tsSec) => new Date(tsSec * 1000).toISOString().slice(0, 10);

  function newRiskState(nowSec) {
    return { day: dayKey(nowSec), trades: 0, wins: 0, losses: 0, ties: 0, net: 0, consecLosses: 0, lastLossAt: null,
      pairLast: {}, open: [], acted: [], emergency: null };
  }

  // New UTC day → daily counters reset; emergency stop and open trades carry over.
  function rollDay(st, nowSec) {
    const d = dayKey(nowSec);
    if (st.day === d) return st;
    return { ...newRiskState(nowSec), pairLast: st.pairLast, open: st.open, acted: st.acted.slice(-200), emergency: st.emergency };
  }

  // cand: { asset, dir, candleTime, ts (decision time), heartbeatAge, tabArmed, isDemo, mode }
  // selected: candidates already accepted in this batch (for concurrency and exposure).
  function check(cand, st, cfg, nowSec, selected = []) {
    const r = cfg.risk, flags = [];
    const add = (code, label) => flags.push({ code, label });
    if (st.emergency) add('EMERGENCY', `emergency stop: ${st.emergency}`);
    if (st.trades >= r.maxTradesPerDay) add('MAX_TRADES', `daily trade limit ${r.maxTradesPerDay} reached`);
    if (st.consecLosses >= r.maxConsecutiveLosses) add('LOSS_STREAK', `${st.consecLosses} losses in a row (limit ${r.maxConsecutiveLosses})`);
    if (st.net <= -Math.abs(r.dailyStopUnits)) add('DAILY_STOP', `daily stop: ${st.net.toFixed(2)} stakes`);
    if (st.lastLossAt != null && nowSec < st.lastLossAt + r.lossCooldownMin * 60) {
      add('COOLDOWN', `cooldown after loss (${Math.ceil((st.lastLossAt + r.lossCooldownMin * 60 - nowSec) / 60)} min left)`);
    }
    const last = st.pairLast[cand.asset], at = cand.entryTime ?? cand.candleTime;
    const pairGap = r.pairCooldownMin != null ? r.pairCooldownMin * 60 : r.pairCooldownSec ?? (r.pairCooldownCandles ?? 2) * 300;
    if (last != null && at - last < pairGap) add('PAIR_COOLDOWN', `traded ${cand.asset} ${Math.round((at - last) / 60)} min ago`);
    if (st.acted.includes(`${cand.asset}|${cand.candleTime}`)) add('DUPLICATE', 'already acted on this pair/candle');
    const open = st.open.filter((o) => o.until > nowSec);
    if (open.length + selected.length >= r.maxConcurrent) add('MAX_CONCURRENT', `${open.length + selected.length} trade(s) already open (max ${r.maxConcurrent})`);
    if (open.some((o) => o.asset === cand.asset)) add('PAIR_OPEN', 'a trade on this pair is still open');
    const conflict = exposureConflict(cand, [...open, ...selected]);
    if (conflict) add('EXPOSURE_CONFLICT', conflict);
    if (cand.heartbeatAge != null && cand.heartbeatAge > 20) add('TAB_DISCONNECTED', `tab silent for ${Math.round(cand.heartbeatAge)}s`);
    return { ok: !flags.length, flags };
  }

  // CALL EUR/USD = long EUR, short USD. Two trades that bet opposite ways on the
  // same currency cancel each other out — the weaker one must be dropped.
  function exposure(asset, dir) {
    const cc = U.currencies(asset);
    if (!cc) return {};
    const sg = dir === 'CALL' ? 1 : -1;
    return { [cc[0]]: sg, [cc[1]]: -sg };
  }
  function exposureConflict(cand, others) {
    const mine = exposure(cand.asset, cand.dir);
    for (const o of others) {
      const theirs = exposure(o.asset, o.dir);
      for (const [cur, v] of Object.entries(mine)) {
        if (theirs[cur] && theirs[cur] !== v) return `opposite ${cur} exposure vs ${U.pairLabel(o.asset)} ${o.dir}`;
      }
    }
    return null;
  }

  function recordOpen(st, { asset, dir, candleTime, entryTime, until }) {
    return { ...st, trades: st.trades + 1, pairLast: { ...st.pairLast, [asset]: entryTime ?? candleTime },
      open: [...st.open.filter((o) => o.until > until - 3600), { asset, dir, until, candleTime }],
      acted: [...st.acted.slice(-500), `${asset}|${candleTime}`] };
  }

  // result: 'W' | 'L' | 'T'; units = profit in stakes (e.g. +0.85, −1, 0)
  function recordResult(st, { asset, candleTime, result, units, at }) {
    const next = { ...st, open: st.open.filter((o) => !(o.asset === asset && o.candleTime === candleTime)), net: +(st.net + units).toFixed(4) };
    if (result === 'W') { next.wins++; next.consecLosses = 0; }
    else if (result === 'L') { next.losses++; next.consecLosses++; next.lastLossAt = at; }
    else next.ties++;
    return next;
  }

  // ── Entry timing ───────────────────────────────────────────────────────────
  // candleTime: open time of the 5M candle the decision was made on (it has closed).
  // closePrice: that candle's close; price: the latest tick.
  function entryTiming({ candleTime, nowSec, price, closePrice, atr, dir, cfg = OTC.DEFAULT_CONFIG, tf = OTC.TF.PRIMARY }) {
    const flags = [];
    const start = candleTime + tf;               // the entry candle starts when the decision candle closes
    const elapsed = nowSec - start, remaining = tf - elapsed;
    if (elapsed < -2) flags.push('decision candle has not closed yet');
    const win = OTC.entryWindow(cfg, tf);
    if (elapsed > win) flags.push(`entry window missed (${Math.round(elapsed)}s into the candle, window ${win}s)`);
    let move = 0;
    if (price != null && closePrice != null && atr) {
      move = ((price - closePrice) / atr) * (dir === 'CALL' ? 1 : -1);
      if (move > cfg.maxChaseAtr) flags.push(`price already moved ${move.toFixed(2)} ATR our way — chasing`);
      if (move < -cfg.maxAdverseAtr) flags.push(`sudden opposite move ${(-move).toFixed(2)} ATR`);
    }
    const quality = Math.round(U.clamp(100 - (Math.max(0, elapsed) / win) * 40 - Math.abs(move) * 60));
    return { ok: !flags.length, flags, elapsed, remaining, move, quality };
  }

  OTC.Risk = { newRiskState, rollDay, check, recordOpen, recordResult, exposureConflict, entryTiming, dayKey };
})(typeof globalThis !== 'undefined' ? globalThis : this);
