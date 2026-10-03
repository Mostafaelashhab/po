// Opportunity lifecycle. A setup confirmed on some frame becomes an opportunity, and the
// decision is not "CALL now" but a state that keeps being re-checked:
//
//   CONFIRMED → ENTER_NOW → ENTERED (qualified) | GATED (below the confidence gate: logged, not traded)
//             → WAIT_FOR_CONFIRMATION  (a confirmation-frame candle must close in direction)
//             → WAIT_FOR_RETEST        (price ran away; wait for it to come back near the entry)
//             → WAIT_FOR_REJECTION     (price moved against; wait for a rejection candle)
//   any wait  → MISSED_ENTRY | INVALIDATED | EXPIRED
//
// Before a setup candle closes, a pair can also be in a watch state:
//   WAIT_FOR_CANDLE_CLOSE (the forming candle would complete a setup) or WAIT_FOR_BREAKOUT.
// Entries only happen at candle closes, so every entry price is a 1-minute close and the
// outcome can be measured exactly afterwards. Pure logic; the tab feeds it events.
(function (G) {
  const OTC = G.OTC, U = OTC.U;
  const TERMINAL = ['ENTERED', 'GATED', 'MISSED_ENTRY', 'INVALIDATED', 'EXPIRED'];
  const WAITING = ['WAIT_FOR_CONFIRMATION', 'WAIT_FOR_RETEST', 'WAIT_FOR_REJECTION'];

  // spec: { asset, tf, timingTf, setupTime, closePrice, atr, dir, kind, setup, setupName, confidence, level,
  //         invalidation, regime, facts, expiry, frames, copy, evidenceFor, evidenceAgainst, strategies }
  function create(spec, cfg, now) {
    const oc = cfg.opportunity, tf = spec.tf;
    const closeTime = spec.setupTime + tf;
    const opp = { ...spec, id: `${spec.asset}|${tf}|${closeTime}`, closeTime, state: 'CONFIRMED',
      expiresAt: closeTime + (oc.validityCandles[tf] ?? 1) * tf, history: [{ state: 'DISCOVERED', at: closeTime }, { state: 'CONFIRMED', at: closeTime }],
      alsoOn: [], entry: null };
    return step(opp, { kind: 'close', now: now ?? closeTime, price: spec.closePrice, candle: null }, cfg);
  }

  const moveOf = (opp, price) => ((price - opp.closePrice) / opp.atr) * (opp.dir === 'CALL' ? 1 : -1);

  // ev: { kind: 'tick' | 'close', now, price, candle?: { tf, time, open, high, low, close }, candleAtr?,
  //       reanalysis?: { tf, decision, hardAgainst: [labels] } }
  // Returns { opp, enter: null | { time, price, why } }.
  function step(opp, ev, cfg) {
    if (TERMINAL.includes(opp.state) || opp.state === 'ENTER_NOW') return { opp, enter: null };
    const oc = cfg.opportunity, up = opp.dir === 'CALL', now = ev.now;
    const to = (state, why) => { opp.state = state; opp.history.push({ state, at: now, why }); return { opp, enter: null }; };
    // hard exits first
    if (opp.invalidation != null && (up ? ev.price < opp.invalidation : ev.price > opp.invalidation)) return to('INVALIDATED', 'price_beyond_invalidation');
    const r = ev.reanalysis;
    if (r) {
      if (r.decision && r.decision !== 'SKIP' && r.decision !== opp.dir) return to('INVALIDATED', `opposite_setup_${r.tf}`);
      if (r.hardAgainst?.length) return to('INVALIDATED', 'new_contradiction');
    }
    const move = moveOf(opp, ev.price);
    if (move > oc.missedAtr) return to('MISSED_ENTRY', 'moved_without_us');
    if (now >= opp.expiresAt) return to(opp.state === 'WAIT_FOR_RETEST' ? 'MISSED_ENTRY' : 'EXPIRED', 'validity_over');
    if (ev.kind !== 'close') return { opp, enter: null };

    const enter = (why) => {
      opp.state = 'ENTER_NOW';
      const time = ev.candle ? ev.candle.time + ev.candle.tf : opp.closeTime;
      opp.entry = { time, price: ev.candle ? ev.candle.close : opp.closePrice, tf: ev.candle?.tf ?? opp.tf, atr: ev.candleAtr ?? opp.atr, why };
      opp.history.push({ state: 'ENTER_NOW', at: now, why });
      return { opp, enter: opp.entry };
    };
    const maxChase = cfg.maxChaseAtr, maxAdverse = cfg.maxAdverseAtr;
    switch (opp.state) {
      case 'CONFIRMED':
        if (move > maxChase) return to('WAIT_FOR_RETEST', 'price_ran');
        if (move < -maxAdverse) return to('WAIT_FOR_REJECTION', 'price_against');
        if (!opp.timingTf || opp.confidence >= oc.enterNowConfidence) return enter(opp.timingTf ? 'strong_setup' : 'setup_close');
        return to('WAIT_FOR_CONFIRMATION', 'needs_confirmation');
      case 'WAIT_FOR_CONFIRMATION': {
        const c = ev.candle;
        if (!c || c.tf !== opp.timingTf) return { opp, enter: null };
        const body = (c.close - c.open) * (up ? 1 : -1), a = ev.candleAtr || opp.atr;
        if (body <= -1.0 * a) return to('INVALIDATED', 'strong_candle_against');
        if (move > maxChase) return to('WAIT_FOR_RETEST', 'price_ran');
        if (body >= oc.confirmBodyAtr * a) return enter('confirmed');
        return { opp, enter: null };
      }
      case 'WAIT_FOR_RETEST':
        if (ev.candle && Math.abs(move) <= oc.retestAtr) return enter('retest');
        return { opp, enter: null };
      case 'WAIT_FOR_REJECTION': {
        const c = ev.candle;
        if (!c) return { opp, enter: null };
        const range = c.high - c.low || 1e-12, wick = up ? Math.min(c.open, c.close) - c.low : c.high - Math.max(c.open, c.close);
        const withDir = up ? c.close > c.open : c.close < c.open;
        if (withDir && wick / range >= 0.4 && move >= -maxAdverse) return enter('rejection');
        return { opp, enter: null };
      }
      default: return { opp, enter: null };
    }
  }

  // After ENTER_NOW was acted on (executed or paper), the opportunity is closed.
  function markEntered(opp, now, how) {
    opp.state = 'ENTERED';
    opp.history.push({ state: 'ENTERED', at: now, why: how });
    return opp;
  }

  // The entry moment came but the opportunity did not pass the confidence gate (or another final
  // check): nothing is traded, but the entry is recorded and its outcome measured like any other.
  function markGated(opp, now, why) {
    opp.state = 'GATED';
    opp.history.push({ state: 'GATED', at: now, why });
    return opp;
  }

  const isActive = (o) => !!o && !TERMINAL.includes(o.state);

  OTC.Opportunity = { create, step, markEntered, markGated, isActive, TERMINAL, WAITING };
})(typeof globalThis !== 'undefined' ? globalThis : this);
