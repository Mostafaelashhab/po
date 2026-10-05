// Post-mortem of each trade: what would have happened with another duration, a later entry or the other side, and
// — for a loss — the most likely reason: entered late, duration too short, duration too long, wrong side, the
// platform's result differing from the market, or plain chance. Built from what every opportunity record already
// keeps: the signal price, the price 5 s … 30 min after it (exits, keyed by seconds), and PO's own deal (forensics).
(function (G) {
  const OTC = G.OTC;
  const H = [3, 5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800];
  const CAUSES = ['late', 'too_short', 'too_long', 'wrong_way', 'platform', 'chance'];
  const dirOf = (r) => r.exec?.dir || (r.decision && r.decision !== 'SKIP' ? r.decision : null);
  // Was the pair on a tab's chart when the signal came? Real data (2026-10-03..04, 16k signals): the same strategies
  // won 54.5 % on chart pairs (n 721, placed or not) and 48.2 % on pairs off the chart (n 6199) — same pair, same half
  // hour, both halves of the period. Only chart signals are traded, so only they judge a strategy.
  // true / false, or null when the record doesn't say (older records, tests): those are kept.
  function onChart(r) {
    if (typeof r.chart === 'boolean') return r.chart;
    const x = r.exec; if (!x) return null;
    if (x.action === 'auto' || x.action === 'manual') return true;
    if (x.action === 'paper' || x.action === 'alert') {
      if (/not on the chart/.test(x.note || '')) return false;
      if (/not started|mode:/.test(x.note || '') || x.otherMode) return true;
    }
    return null;
  }
  const counts = (r, chartOnly) => !chartOnly || onChart(r) !== false;
  // W / L / T of a trade from price `from` (null = the signal price) to the price `to` seconds after the signal
  const outcome = (r, from, to, d) => {
    const a = from == null ? r.entryPrice : r.exits?.[from], b = r.exits?.[to];
    if (a == null || b == null) return null;
    if (b === a) return 'T';
    return (b > a) === (d === 'CALL') ? 'W' : 'L';
  };

  function analyze(r) {
    const d = dirOf(r), exp = r.expirySec || null;
    if (!d || !exp || r.entryPrice == null) return null;
    const at = {}; for (const h of H) at[h] = outcome(r, null, h, d);
    const reverse = at[exp] === 'W' ? 'L' : at[exp] === 'L' ? 'W' : at[exp];
    // entering w seconds after the signal with the same duration (only where both prices were recorded)
    const later = {}; for (const w of H) if (w < exp && H.includes(w + exp)) later[w] = outcome(r, w, w + exp, d);
    const f = r.exec?.forensics || null, placed = r.exec?.result != null;
    const result = placed ? r.exec.result : at[exp];
    const out = { id: r.id, ts: r.ts, asset: r.asset, setup: r.setup, combo: r.combo || r.setup, dir: d, expirySec: exp, placed, result,
      atSignal: at[exp], at, later, reverse, delaySec: f?.delaySec ?? null, slipBp: f?.openSlipBp ?? null, cause: null, better: null };
    if (result !== 'L') return out;
    const winsLonger = H.filter((h) => h > exp && h <= exp * 3 && at[h] === 'W'), winsShorter = H.filter((h) => h < exp && at[h] === 'W');
    if (placed && at[exp] === 'W' && (f?.delaySec ?? 0) > 1) out.cause = 'late';                     // from the signal price it won
    else if (placed && f?.marketOutcome === 'W' && f?.poOutcome === 'L') out.cause = 'platform';     // the market won, PO's deal lost
    else if (winsLonger.length) { out.cause = 'too_short'; out.better = winsLonger[0]; }
    else if (winsShorter.length) { out.cause = 'too_long'; out.better = winsShorter[winsShorter.length - 1]; }
    else if (H.filter((h) => at[h] != null).every((h) => at[h] !== 'W')) out.cause = 'wrong_way';
    else out.cause = 'chance';
    return out;
  }

  // Per strategy: results, causes of the losses, win rate at every duration, a later entry, the other side, and
  // the duration that did best (only once it has enough trades to mean something).
  function summary(records, { minN = 20, chartOnly = true } = {}) {
    const by = new Map();
    for (const r of records) {
      if (r.kind !== 'opp' || r.state !== 'ENTERED' || r.origin === 'copy' || !counts(r, chartOnly)) continue;
      const a = analyze(r); if (!a || !a.result) continue;
      const key = a.setup || 'unknown';
      const s = by.get(key) || by.set(key, { setup: key, n: 0, W: 0, L: 0, T: 0, placed: 0, causes: Object.fromEntries(CAUSES.map((c) => [c, 0])), rate: {}, later: {}, reverse: [0, 0], expiries: {}, losses: [] }).get(key);
      s.n++; s[a.result]++; if (a.placed) s.placed++;
      s.expiries[a.expirySec] = (s.expiries[a.expirySec] || 0) + 1;
      if (a.cause) s.causes[a.cause]++;
      for (const h of H) if (a.at[h] && a.at[h] !== 'T') { const x = (s.rate[h] ||= [0, 0]); x[0]++; if (a.at[h] === 'W') x[1]++; }
      for (const [w, v] of Object.entries(a.later)) if (v && v !== 'T') { const x = (s.later[w] ||= [0, 0]); x[0]++; if (v === 'W') x[1]++; }
      if (a.reverse && a.reverse !== 'T') { s.reverse[0]++; if (a.reverse === 'W') s.reverse[1]++; }
      if (a.result === 'L') s.losses.push(a);
    }
    for (const s of by.values()) {
      const pct = ([n, w]) => (n ? +((100 * w) / n).toFixed(1) : null);
      s.rate = Object.fromEntries(Object.entries(s.rate).map(([h, x]) => [h, { n: x[0], rate: pct(x) }]));
      s.later = Object.fromEntries(Object.entries(s.later).map(([w, x]) => [w, { n: x[0], rate: pct(x) }]));
      s.reverse = { n: s.reverse[0], rate: pct(s.reverse) };
      const used = +Object.entries(s.expiries).sort((a, b) => b[1] - a[1])[0]?.[0];
      const cand = Object.entries(s.rate).filter(([, x]) => x.n >= minN).sort((a, b) => b[1].rate - a[1].rate)[0];
      s.used = used || null;
      s.best = cand ? { sec: +cand[0], rate: cand[1].rate, n: cand[1].n, current: s.rate[used]?.rate ?? null } : null;
      s.losses.sort((a, b) => b.ts - a.ts);
    }
    return [...by.values()].sort((a, b) => b.n - a.n);
  }

  // "حسّن": for each strategy of the mode, a change is made only when the data hold it up twice — found on the older
  // 70 % of its record (chart signals, placed and paper alike: off-chart ones don't count), and confirmed on the newer 30 % it never saw:
  //   • a duration (15 s or longer: the outcomes are counted from the signal price, and a shorter trade is mostly the
  //     entry delay): the best one on the older part, applied only if on the newer part (≥ minTest trades) it beats
  //     the duration in use by `margin` points AND the break-even win rate clearly (z ≥ zMin: chance alone rarely
  //     gets that far above it);
  //   • off: below 50 % at its duration on both parts (and no confirmed duration saves it).
  // Everything else stays as it is, with the reason (too few trades, nothing confirmed).
  function improve(records, { ids, current = {}, off = [], payout = 92, minN = 60, minTest = 40, margin = 3, zMin = 1.28, minSec = 15, choices = H, chartOnly = true } = {}) {
    const be = 10000 / (100 + payout), offSet = new Set(off), out = { changes: [], kept: [], breakEven: +be.toFixed(1) };
    const by = new Map();
    for (const r of records) {
      if (r.kind !== 'opp' || r.origin === 'copy' || !ids.includes(r.setup) || offSet.has(r.setup) || !counts(r, chartOnly)) continue;
      const a = analyze(r); if (!a) continue;
      (by.get(r.setup) || by.set(r.setup, []).get(r.setup)).push(a);
    }
    const rate = (arr, h) => { let n = 0, w = 0; for (const a of arr) { const v = a.at[h]; if (v === 'W' || v === 'L') { n++; if (v === 'W') w++; } } return { n, rate: n ? +((100 * w) / n).toFixed(1) : null }; };
    for (const id of ids) {
      if (offSet.has(id)) continue;
      const arr = (by.get(id) || []).sort((x, y) => x.ts - y.ts);
      const cur = current[id] || arr.at(-1)?.expirySec || null;
      const all = cur ? rate(arr, cur) : { n: 0, rate: null };
      if (!cur || all.n < minN) { out.kept.push({ id, reason: 'few', n: all.n, rate: all.rate, cur }); continue; }
      const cut = Math.floor(arr.length * 0.7), train = arr.slice(0, cut), test = arr.slice(cut);
      const trCur = rate(train, cur), teCur = rate(test, cur);
      // the best duration on the older part, among those recorded for most of its trades
      let best = null;
      for (const h of choices.filter((x) => x >= minSec)) { const x = rate(train, h); if (x.n >= 0.8 * trCur.n && (!best || x.rate > best.rate)) best = { h, ...x }; }
      const teBest = best && best.h !== cur ? rate(test, best.h) : null;
      const z = teBest?.n ? (teBest.rate - be) / Math.sqrt((be * (100 - be)) / teBest.n) : -Infinity;
      if (teBest && teBest.n >= minTest && z >= zMin && teBest.rate >= (teCur.rate ?? 0) + margin) {
        out.changes.push({ id, kind: 'expiry', from: cur, to: best.h, train: { cur: trCur, best: { n: best.n, rate: best.rate } }, test: { cur: teCur, best: teBest } });
        continue;
      }
      if (trCur.rate < 50 && teCur.rate < 50 && teCur.n >= 20) { out.changes.push({ id, kind: 'off', from: cur, train: trCur, test: teCur }); continue; }
      out.kept.push({ id, reason: best && best.h !== cur ? 'not_confirmed' : 'best_already', n: all.n, rate: all.rate, cur, tried: best && best.h !== cur ? { h: best.h, train: best.rate, test: teBest?.rate ?? null, testN: teBest?.n ?? 0, small: !teBest || teBest.n < minTest } : null });
    }
    return out;
  }

  // Win rate at each signal's own duration, from the signal price: chart vs off-chart, and — chart signals only, to
  // be judged once there are enough of them — by how many other strategies agreed in the minute before (agree) and
  // by how fast the pair moved against its own normal (speed). Measured, not used in any decision yet: on the
  // data so far neither held (agreement: 1 other agreeing 49–54 %, 2+ 54–71 % on 24–97 trades; speed: OTC's speed
  // barely changes, 90 % of signals within 0.83–1.18× normal).
  function split(records, { ids = null } = {}) {
    const z = () => ({ n: 0, w: 0 }), out = { chart: z(), off: z(), unknown: z(), agree: { alone: z(), one: z(), more: z(), against: z() }, speed: { slow: z(), normal: z(), fast: z() } };
    const add = (c, win) => { c.n++; if (win) c.w++; };
    for (const r of records) {
      if (r.kind !== 'opp' || r.state !== 'ENTERED' || r.origin === 'copy' || (ids && !ids.includes(r.setup))) continue;
      const a = analyze(r); const v = a?.atSignal; if (v !== 'W' && v !== 'L') continue;
      const c = onChart(r), win = v === 'W';
      add(c === true ? out.chart : c === false ? out.off : out.unknown, win);
      if (c !== true) continue;
      const g = r.agree; if (g) add(out.agree[g.against ? 'against' : g.same >= 2 ? 'more' : g.same === 1 ? 'one' : 'alone'], win);
      if (r.speed != null) add(out.speed[r.speed < 0.8 ? 'slow' : r.speed > 1.25 ? 'fast' : 'normal'], win);
    }
    const fin = (c) => ({ n: c.n, rate: c.n ? +((100 * c.w) / c.n).toFixed(1) : null });
    return { chart: fin(out.chart), off: fin(out.off), unknown: fin(out.unknown),
      agree: Object.fromEntries(Object.entries(out.agree).map(([k, c]) => [k, fin(c)])), speed: Object.fromEntries(Object.entries(out.speed).map(([k, c]) => [k, fin(c)])) };
  }

  // Conditions at the signal that may mark a losing entry, read from the record (what the tab saw then) and from the
  // pair's earlier signals (`prior`, oldest first). Learned by conditions() below; the worker holds an entry only for a
  // condition that the record shows losing on its older part AND on its newer part.
  const opp = (d) => (d === 'CALL' ? 'PUT' : 'CALL');
  const COND = {
    conflict: { ar: 'إشارة عكسية على نفس الزوج في آخر دقيقة', f: (r) => (r.agree?.against || 0) >= 1 },
    momAgainst: { ar: 'الزخم عكس الصفقة', f: (r) => r.facts?.momentum === 'against' },
    tfAgainst: { ar: 'الترند على الفريمات عكس الصفقة', f: (r, d) => { let w = 0, a = 0; for (const k of ['1', '5', '15']) { const t = r.facts?.tf?.[k]; if (t === 'UP' || t === 'DOWN') (t === 'UP') === (d === 'CALL') ? w++ : a++; } return a >= 2 && w === 0; } },
    consAgainst: { ar: 'باقي الاستراتيجيات عكسها', f: (r, d) => r.cons?.dir === opp(d) },
    regimeAgainst: { ar: 'عكس اتجاه السوق', f: (r, d) => (d === 'CALL' && r.regime === 'TRENDING_DOWN') || (d === 'PUT' && r.regime === 'TRENDING_UP') },
    m15Against: { ar: 'فريم 15 دقيقة عكسها', f: (r) => (r.facts?.risks || []).some((x) => x.code === 'm15_against') },
    volatile: { ar: 'السوق متذبذب جامد', f: (r) => (r.facts?.risks || []).some((x) => x.code === 'volatility') },
    exhausted: { ar: 'الحركة مستنزفة', f: (r) => (r.facts?.risks || []).some((x) => x.code === 'exhausted') },
    fast: { ar: 'الزوج بيتحرك أسرع من العادي', f: (r) => r.speed > 1.15 },
    afterLoss: { ar: 'آخر إشارة على الزوج بنفس الاتجاه خسرت', f: (r, d, prior) => { const p = prior.filter((x) => x.end <= r.ts).at(-1); return !!p && p.res === 'L' && p.dir === d && r.ts - p.end < 600; } },
  };
  const resultOf = (r) => (r.exec?.result === 'W' || r.exec?.result === 'L' ? r.exec.result : analyze(r)?.atSignal);
  function condFlags(r, prior = []) {
    const d = dirOf(r); if (!d) return [];
    return Object.entries(COND).filter(([, c]) => { try { return c.f(r, d, prior); } catch (_) { return false; } }).map(([k]) => k);
  }
  // prior entries of a pair, for condFlags: { dir, end, res }
  const priorOf = (rs) => rs.map((x) => ({ dir: dirOf(x), end: x.ts + (x.exec?.expiry ?? x.expirySec ?? 60), res: resultOf(x) })).filter((x) => x.res === 'W' || x.res === 'L');
  // Walk-forward: each condition is judged on the first `train` part of the mode's chart signals (placed: PO's result,
  // else the signal price at its own duration) and must hold again on the rest: there and on the rest, entries with it
  // won under 50 % and at least `margin` points below those without it, on enough of them. (On the 861 chart signals
  // to 2026-10-05 a one-part judgement held "momentum against" — and on the later data it won more than the rest.)
  function conditions(records, { ids = null, minN = 30, minTest = 12, train = 0.6, margin = 5 } = {}) {
    const rs = records.filter((r) => r.kind === 'opp' && r.state === 'ENTERED' && r.origin !== 'copy' && (!ids || ids.includes(r.setup)) && onChart(r) === true && dirOf(r))
      .map((r) => ({ r, res: resultOf(r) })).filter((x) => x.res === 'W' || x.res === 'L').sort((a, b) => a.r.ts - b.r.ts);
    const byPair = {};
    for (const x of rs) { const h = (byPair[x.r.asset] ||= []); x.flags = condFlags(x.r, priorOf(h.slice(-6))); h.push(x.r); }
    const cut = Math.floor(rs.length * train), parts = [rs.slice(0, cut), rs.slice(cut)];
    const st = (arr, k) => { const y = arr.filter((x) => x.flags.includes(k)), n = arr.filter((x) => !x.flags.includes(k)), rate = (a) => (a.length ? (100 * a.filter((x) => x.res === 'W').length) / a.length : null);
      return { n: y.length, w: y.filter((x) => x.res === 'W').length, rate: rate(y), rest: rate(n) }; };
    const all = Object.keys(COND).map((k) => {
      const [a, b] = parts.map((p) => st(p, k));
      const bad = (s, min) => s.n >= min && s.rate < 50 && s.rest != null && s.rate <= s.rest - margin;
      return { k, ar: COND[k].ar, train: a, test: b, block: bad(a, minN) && bad(b, minTest) };
    });
    return { n: rs.length, blocked: all.filter((c) => c.block), all };
  }

  // «تظلّم»: a losing trade explained step by step, from what its record holds — the signal price, PO's own open and
  // close (price and time), the market price at PO's close second, the price at every duration, the other side, and
  // the strategy's latest real results. verdict: platform (the market said win, PO's close said loss) · entry (won from
  // the signal price, lost from PO's open: the price moved in the delay) · too_short · too_long · wrong_way · chance.
  // recent: { n, w } of the strategy's latest real trades.
  const VERDICT_AR = {
    platform: '⚠️ <b>المنصة قفلت على سعر غير السوق</b>',
    entry: '⏱️ <b>السعر اتحرك ضدنا قبل ما الصفقة تتفتح</b>',
    too_short: '⏳ <b>المدة كانت قصيرة</b>',
    too_long: '⌛ <b>المدة كانت طويلة</b>',
    wrong_way: '↩️ <b>الإشارة نفسها كانت غلط</b> — السعر راح عكسها في كل المدد',
    chance: '🎲 <b>حركة عشوائية</b> — مفيش مدة كانت هتكسب بوضوح',
  };
  function appeal(r, { recent = null } = {}) {
    const a = analyze(r); if (!a) return null;
    const up = a.dir === 'CALL', po = r.exec?.po || null, f = r.exec?.forensics || null, exp = a.expirySec;
    // the price's last digit: the most decimals any of its prices shows (1.0 prints as "1")
    const dec = (x) => (x == null ? 0 : (String(x).split('.')[1] || '').length);
    const digits = Math.min(6, Math.max(dec(r.entryPrice), dec(po?.openPrice), dec(po?.closePrice), ...Object.values(r.exits || {}).map(dec))), unit = Math.pow(10, -digits);
    const pts = (x) => Math.round(Math.abs(x) / unit);             // a price difference in the price's last digit ("points")
    const durAr = (s) => (s < 60 ? `${s} ثانية` : s % 60 ? `${(s / 60).toFixed(1)} دقيقة` : s === 60 ? 'دقيقة' : s === 120 ? 'دقيقتين' : `${s / 60} دقايق`);
    const lines = [], pol = up ? 1 : -1;
    const open = po?.openPrice > 0 ? po.openPrice : null, close = po?.closePrice > 0 ? po.closePrice : null;
    const delay = f?.delaySec ?? (po?.openTs && r.ts ? +(po.openTs - r.ts).toFixed(2) : null);
    if (r.candleGate?.confirmed) lines.push(`🕯️ دخل بعد شمعة التأكيد${r.candleGate.pattern ? ` (نموذج ${r.candleGate.pattern})` : ''} على <b>${r.candleGate.price}</b>`);
    lines.push(`📍 سعر الإشارة <b>${r.entryPrice}</b>${open != null ? ` · المنصة فتحت على <b>${open}</b>${delay != null ? ` بعد ${delay} ث` : ''}` : ''}`);
    if (open != null) {
      const mv = (open - r.entryPrice) * pol;
      lines.push(mv === 0 ? '✔️ الفتح على نفس سعر الإشارة' : mv > 0 ? `❗ الفتح جه <b>أسوأ بـ ${pts(mv)} نقطة</b> من سعر الإشارة` : `✔️ الفتح جه أحسن بـ ${pts(mv)} نقطة من سعر الإشارة`);
    }
    if (close != null && open != null) lines.push(`🏁 القفل <b>${close}</b> — ${(close - open) * pol > 0 ? 'فوق' : 'عكس'} اتجاهنا بـ <b>${pts(close - open)} نقطة</b>`);
    if (f?.marketAtClose != null && close != null) lines.push(f.marketAtClose === close ? '✔️ سعر السوق في ثانية القفل = سعر المنصة' : `🔎 سعر السوق في ثانية القفل <b>${f.marketAtClose}</b> (فرق ${pts(f.marketAtClose - close)} نقطة عن المنصة)`);
    // 15 s and longer only: a shorter "would have won" is mostly the entry delay, nothing to act on
    const wins = H.filter((h) => h !== exp && h >= 15 && a.at[h] === 'W');
    if (a.atSignal) lines.push(`📐 من سعر الإشارة بعد ${durAr(exp)}: ${a.atSignal === 'W' ? '<b>كانت كسبانة</b>' : a.atSignal === 'L' ? 'خسرانة برضه' : 'تعادل'}`);
    if (wins.length) lines.push(`🕒 كانت هتكسب لو المدة: ${wins.slice(0, 4).map(durAr).join('، ')}`);
    if (a.reverse === 'W') lines.push('🔁 العكس كان هيكسب');
    // pressed right after the loss: the longer durations' prices aren't in yet — said, and the answer updates itself
    const pending = [120, 180, 300].filter((h) => h > exp && (r.horizons || H).includes(h) && r.exits?.[h] == null);
    if (pending.length) lines.push(`⏳ لسه مستني السعر بعد ${pending.map(durAr).join(' و')} — الرد هيتحدّث لوحده`);
    const longer = wins.filter((h) => h > exp && h <= exp * 3), shorter = wins.filter((h) => h < exp);
    let verdict, better = null;
    if (f?.marketOutcome === 'W' && f?.poOutcome === 'L') verdict = 'platform';
    else if (a.atSignal === 'W') verdict = 'entry';
    else if (longer.length) { verdict = 'too_short'; better = longer[0]; }
    else if (shorter.length) { verdict = 'too_long'; better = shorter[shorter.length - 1]; }
    else if (H.filter((h) => h >= 15 && a.at[h] != null).every((h) => a.at[h] !== 'W')) verdict = 'wrong_way';
    else verdict = 'chance';
    const out = { id: r.id, verdict, title: VERDICT_AR[verdict], lines, better, pending: pending.length > 0 };
    if (better) out.title += ` — ${durAr(better)} كانت هتكسب`;
    if (recent?.n) lines.push(`📊 الاستراتيجية دي آخر ${recent.n} صفقة حقيقية: <b>${recent.w} كسب</b> (${Math.round((100 * recent.w) / recent.n)}%)`);
    return out;
  }

  OTC.PostMortem = { analyze, summary, improve, split, onChart, appeal, conditions, condFlags, priorOf, COND, H, CAUSES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
