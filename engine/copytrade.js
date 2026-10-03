// Copy Trade Intelligence. Pocket Option's copy-trading list shows other traders'
// running trades. They are ONE source of evidence: never "most copies say CALL → CALL".
// What matters is agreement, freshness, whether they arrived before or after the move,
// and whether they agree with price action and structure (the confluence/contradiction
// engines weigh that).
(function (G) {
  const OTC = G.OTC, U = OTC.U;

  // signals: [{ dir: 'CALL'|'PUT', at (PO time first seen), left (s remaining when seen),
  //             elapsed (s already running when seen, or null), price (when seen), copies }]
  function evaluate(signals, { now, price = null, atr = null, windowSec = 180 } = {}) {
    const live = (signals || []).filter((s) => now - s.at <= windowSec && s.at + s.left > now - 5).sort((a, b) => a.at - b.at);
    const out = { dir: null, calls: 0, puts: 0, total: live.length, agreement: 0, fresh: false, late: false, synced: false, flipping: false, confidence: 0, moveAtr: null };
    if (!live.length) return out;
    out.calls = live.filter((s) => s.dir === 'CALL').length;
    out.puts = live.length - out.calls;
    const major = out.calls >= out.puts ? 'CALL' : 'PUT';
    out.agreement = Math.max(out.calls, out.puts) / live.length;
    const ages = live.map((s) => now - s.at + (s.elapsed ?? 0));
    out.fresh = Math.min(...ages) <= 45;
    out.synced = live.length >= 2 && live[live.length - 1].at - live[0].at <= 60;
    const last3 = live.slice(-3).map((s) => s.dir);
    out.flipping = last3.length >= 2 && new Set(last3).size > 1;
    // Did they come before the move, or after it had already happened?
    const first = live.find((s) => s.dir === major);
    if (first?.price != null && price != null && atr) {
      out.moveAtr = ((price - first.price) / atr) * (major === 'CALL' ? 1 : -1);
      out.late = out.moveAtr > 0.6;
    }
    const clear = out.agreement >= 0.7 && (live.length >= 2 || out.fresh);
    if (!clear || out.flipping) return out;
    out.dir = major;
    let c = 52;
    if (live.length >= 3 && out.agreement >= 0.8) c += 6;
    if (out.synced) c += 3;
    if (!out.fresh) c -= 5;
    if (out.late) c -= 10;
    out.confidence = Math.round(U.clamp(c, 40, 65));
    return out;
  }

  OTC.CopyTrade = { evaluate };
})(typeof globalThis !== 'undefined' ? globalThis : this);
