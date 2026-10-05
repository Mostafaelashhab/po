// The panel's bot: a living orb, a status line under it, the day's counters, and a chat that holds the day's trades
// only — one short bubble per trade, its countdown while it runs and its result (and why a loss lost) written into
// the same bubble when it closes. Fed by the tab (its open trades) and the worker (today's entries and results).
(function () {
  const C = { shown: new Set(), queue: [], typing: false, pending: null, first: true, asked: 0, appealing: new Set(), appealed: new Set() };
  const $ = (id) => root?.getElementById(id);
  const cur = () => (state.settings.currency === 'EGP' ? 'ج' : state.settings.currency);
  const money = (x) => `${Math.round(Math.abs(x) * 100) / 100} ${cur()}`;
  const mmss = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
  const pairName = (a) => (a || '—').replace('_otc', ' OTC').replace(/^([A-Z]{3})([A-Z]{3})/, '$1/$2');
  const dirWord = (d) => (/call/i.test(d) ? 'شراء' : 'بيع');
  const dirIcon = (d) => (/call/i.test(d) ? '📈' : '📉');

  function mount() {
    C.shown.clear(); C.queue = []; C.typing = false; C.pending = null; C.first = true; 
    root.querySelectorAll('#chips button').forEach((b) => (b.onclick = () => ask(b.dataset.q)));
    $('stream').addEventListener('click', onStreamClick);
    globalThis.IntelTab?.askFeed?.();
  }
  // the bot reacts for a few seconds: a win (jumps, stars), a loss (shakes, a sweat drop), anything it tells you (a bell),
  // a new tip (it talks); its mood (analysing / buying / selling / asleep / stopped) comes back after
  function react(kind, ms = 3000) {
    C.react = { kind, until: Date.now() + ms };
    const o = $('orb'); if (!o) return;
    o.classList.remove('r-win', 'r-loss', 'r-alert', 'r-talk'); void o.offsetWidth; o.classList.add(kind);
    clearTimeout(C.reactT); C.reactT = setTimeout(() => { if (Date.now() >= (C.react?.until || 0)) $('orb')?.classList.remove(kind); }, ms + 50);
  }
  const reactTo = (tone) => react(tone === 'win' ? 'r-win' : tone === 'loss' ? 'r-loss' : 'r-alert', tone === 'win' || tone === 'loss' ? 3200 : 2600);
  function push(m, { instant = false } = {}) {
    if (C.shown.has(m.id)) return refresh(m);
    C.shown.add(m.id);
    if (!instant && !m.me) reactTo(m.tone);
    if (instant) return append(m, false);
    C.queue.push(m); pump();
  }
  function pump() {
    if (C.typing || !C.queue.length) return;
    const s = $('stream'); if (!s) return;
    const m = C.queue.shift(); C.typing = true;
    const t = document.createElement('div'); t.className = 'msg bot typing'; t.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    s.appendChild(t); s.scrollTop = s.scrollHeight;
    C.pending = { m, t, timer: setTimeout(() => { C.pending = null; t.remove(); append(m, true); C.typing = false; pump(); }, Math.min(1400, 450 + m.text.length * 8)) };
  }
  function flush() {
    if (C.pending) { clearTimeout(C.pending.timer); C.pending.t.remove(); append(C.pending.m, false); C.pending = null; }
    while (C.queue.length) append(C.queue.shift(), false);
    C.typing = false;
  }
  function append(m, animate) {
    const s = $('stream'); if (!s) return;
    const d = document.createElement('div');
    d.className = `msg ${m.me ? 'me' : 'bot'} ${m.tone || ''} ${animate ? 'pop' : ''}`; d.dataset.id = m.id;
    d.innerHTML = `<div class="bubble">${m.text}</div>${m.at ? `<span class="at">${m.at}</span>` : ''}`;
    s.appendChild(d);
    if (animate && m.tone === 'win') { const b = document.createElement('div'); b.className = 'burst'; b.innerHTML = Array.from({ length: 10 }, (_, i) => `<i style="--a:${i * 36}deg;--c:${['#34d399', '#fbbf24', '#a78bfa', '#60a5fa'][i % 4]}"></i>`).join(''); d.appendChild(b); setTimeout(() => b.remove(), 1200); }
    while (s.children.length > 60) s.firstChild.remove();
    s.scrollTop = s.scrollHeight;
  }
  function refresh(m) {
    const box = root?.querySelector(`.msg[data-id="${CSS.escape(m.id)}"]`), el = box?.querySelector('.bubble');
    if (!el || el.innerHTML === m.text) return;
    el.innerHTML = m.text;
    if (m.tone !== undefined && !box.classList.contains(m.tone || 'x')) { box.classList.remove('win', 'loss'); if (m.tone) { box.classList.add(m.tone); reactTo(m.tone); } box.animate?.([{ transform: 'scale(1.04)' }, { transform: 'scale(1)' }], { duration: 300 });
      if (m.tone === 'win') { const b = document.createElement('div'); b.className = 'burst'; b.innerHTML = Array.from({ length: 10 }, (_, i) => `<i style="--a:${i * 36}deg;--c:${['#34d399', '#fbbf24', '#a78bfa', '#60a5fa'][i % 4]}"></i>`).join(''); box.appendChild(b); setTimeout(() => b.remove(), 1200); } }
  }
  function countTo(el, v, fmt = (x) => x) {
    if (!el) return; const from = +el.dataset.v || 0; if (from === v) { el.textContent = fmt(v); return; }
    el.dataset.v = v; const t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / 700), x = from + (v - from) * (1 - Math.pow(1 - k, 3)); el.textContent = fmt(Math.round(x * 100) / 100); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  function now(feed) {
    const t = [...state.trades].sort((a, b) => a.openedAt + a.expiry * 1000 - (b.openedAt + b.expiry * 1000))[0];
    if (feed?.emergency) return { mood: 'stop', text: '✋ واقف (إيقاف الطوارئ)' };
    if (t) { const left = Math.round((t.openedAt + t.expiry * 1000 - Date.now()) / 1000);
      return { mood: t.dir === 'call' ? 'up' : 'down', key: t.openedAt, text: `⏳ داخل <b>${dirWord(t.dir)}</b> ${pairName(t.asset)} · فاضل <b class="clock">${mmss(left)}</b>` }; }
    if (!state.running) return { mood: 'sleep', text: 'دوس <b>«شغّل ▶»</b> وأنا أبدأ 💪' };
    // "in a trade" only for a trade PO really has: a signal the bot didn't place (price against, payout, limits) is not one
    const n = feed?.pairs || globalThis.IntelTab?.feeds?.size || 0;
    return { mood: 'scan', text: `🔎 بدوّر في <b>${n}</b> زوج…` };
  }
  const short = (n) => String(n || '').split(' (')[0].split(' —')[0];
  const CAUSE_SHORT = { late: 'اتأخرنا', too_short: 'المدة قصيرة', too_long: 'المدة طويلة', wrong_way: 'الاتجاه غلط', platform: 'المنصة حسبتها غلط', chance: 'صدفة' };
  // one short bubble per executed trade; its result is written into the same bubble when it closes
  const evMsgs = (feed) => (feed?.events || []).filter((e) => !e.paper).slice(-8).map((e) => {
    const at = new Date((e.at ?? e.ts) * 1000).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    const head = `${dirIcon(e.dir)} <b>${dirWord(e.dir)}</b> ${pairName(e.asset)} · ${short(e.name)} · ${AR.duration(e.expirySec)}`;
    const t = state.trades.find((x) => x.intelId === e.id), left = t ? Math.round((t.openedAt + t.expiry * 1000 - Date.now()) / 1000) : null;
    // a loss can be appealed («تظلّم»): the worker explains it step by step and keeps it for review
    const ap = e.appeal || C.appealed.has(e.id) ? '' : C.appealing.has(e.id) ? ' <span class="why">🔎 بيراجع…</span>' : ` <button class="opt ap" data-ap="${e.id}" title="ليه خسرت؟">🧐 تظلّم</button>`;
    const res = e.result === 'W' ? ` <b class="g">✅ +${money(e.profit ?? 0)}</b>` : e.result === 'L' ? ` <b class="r">❌ −${money(e.profit ?? e.stake ?? 0)}</b>${e.cause ? ` <span class="why">· ${CAUSE_SHORT[e.cause]}</span>` : ''}${ap}` : e.result === 'T' ? ' 🤝' : left != null && left > 0 ? ` ⏳ <b class="clock">${mmss(left)}</b>`
      : !t && Date.now() / 1000 + (poOffsetSec() ?? 7200) > (e.at ?? e.ts) + (e.expirySec || 0) + 900 ? ' ❔ <span class="why">النتيجة موصلتش</span>' : ' ⏳';
    return { id: e.id, at, tone: e.result === 'W' ? 'win' : e.result === 'L' ? 'loss' : '', text: head + res };
  });

  // Tips that fit the moment, one at a time in the strip above the chat (never in the chat): the pair's state, the
  // payout, the day so far, open trades — then general ones. Plain facts and risk sense, no promises.
  const REGIME_TIP = {
    TRENDING_UP: (p) => ['📈', `<b>${p}</b> طالع دلوقتي — الترند ممكن يقلب في أي لحظة، خلّي المبلغ زي ما هو.`],
    TRENDING_DOWN: (p) => ['📉', `<b>${p}</b> نازل دلوقتي — الترند ممكن يقلب في أي لحظة، خلّي المبلغ زي ما هو.`],
    RANGING: (p) => ['↔️', `<b>${p}</b> رايح جاي في نطاق — مفيش اتجاه واضح، والصفقات القصيرة بتبقى أقرب للحظ.`],
    RANGE: (p) => ['↔️', `<b>${p}</b> رايح جاي في نطاق — مفيش اتجاه واضح، والصفقات القصيرة بتبقى أقرب للحظ.`],
    HIGH_VOLATILITY: (p) => ['⚡', `<b>${p}</b> متقلّب جامد دلوقتي — الشمعة ممكن تقلب في ثواني، لو قلقان قلّل المبلغ.`],
    LOW_VOLATILITY: (p) => ['😴', `<b>${p}</b> هادي خالص — الحركة صغيرة والتعادل وارد.`],
    UNCLEAR: (p) => ['🌫️', `<b>${p}</b> مش واضح دلوقتي — مفيش حالة سوق ثابتة.`],
  };
  const GENERAL = [
    ['🎯', 'متحطش في الصفقة الواحدة أكتر من <b><bdi>1–2%</bdi></b> من رصيدك.'],
    ['🔁', 'مضاعفة المبلغ بعد الخسارة (مارتينجيل) ممكن تفلّس الحساب في سلسلة خساير واحدة.'],
    ['🧘', 'متجريش ورا الخسارة — الصفقة الجاية ملهاش علاقة باللي فاتت.'],
    ['📏', 'خلّي مبلغ الصفقة ثابت طول اليوم، كده الحساب بيبان صح.'],
    ['📊', 'الحكم على استراتيجية محتاج <b>50 صفقة</b> على الأقل، مش 5.'],
    ['🛑', 'حط وقف خسارة يومي من ⚙ — ولما يتضرب، اقفل اليوم.'],
    ['⏰', 'OTC شغال طول اليوم — مفيش داعي تستعجل أي صفقة.'],
    ['🧾', 'شوف «مراجعة الخسائر» من وقت للتاني — هتعرف الخسارة كانت تأخير ولا مدة.'],
    ['😌', 'لو متضايق أو مستعجل، وقّف البوت شوية — القرار وانت متوتر بيبقى أسوأ.'],
  ];
  function tips(feed) {
    const out = [], pair = pairName(state.asset), pv = globalThis.IntelTab?.pairView?.(state.asset);
    const rg = pv?.regime?.regime; if (rg && REGIME_TIP[rg]) out.push(REGIME_TIP[rg](pair));
    const pay = readPayout();
    if (pay != null) {
      const be = Math.round((10000 / (100 + pay))) / 100;
      out.push(pay < 80 ? ['💸', `الربح على <b>${pair}</b> ${pay}% بس — عشان تكسب لازم تصيب أكتر من <b>${be}%</b> من الصفقات. دوّر على زوج ربحه أعلى.`]
        : ['🧮', `على ربح ${pay}% محتاج تصيب أكتر من <b>${be}%</b> من الصفقات عشان تبقى كسبان.`]);
    }
    const fastHere = (feed?.watch?.fast || []).find((x) => x.asset === state.asset);
    if (fastHere) out.push(['⚡', `<b>${pair}</b> بيتحرك أسرع من طبيعته ×${fastHere.ratio} — الشمعة ممكن تقلب في ثانية.`]);
    const d = feed?.day, sl = state.settings.stopLoss || 0;
    const res = (feed?.events || []).filter((e) => !e.paper && e.result).map((e) => e.result);
    let streak = 0; for (let i = res.length - 1; i >= 0 && res[i] === 'L'; i--) streak++;
    if (streak >= 3) out.push(['😮‍💨', `<b>${streak}</b> خساير ورا بعض — خد استراحة، ومتعوّضش بمبلغ أكبر.`]);
    const dm = dayMoney();
    if (sl > 0 && dm.down >= sl * 0.6) out.push(['🛑', `قرّبت من وقف الخسارة: نازل <b>${money(dm.down)}</b> من أعلى نقطة النهارده، والوقف عند ${money(sl)}.`]);
    if (d && d.net > 0 && d.W + d.L >= 10) out.push(['💰', `كسبان <b>+${money(d.net)}</b> النهارده — ممكن تقفل اليوم وانت كسبان.`]);
    if (d && sl <= 0) out.push(['🛑', 'مفيش وقف خسارة متحط — حطه من ⚙ عشان يوم وحش ميكلش الحساب.']);
    if (state.trades.length >= 3) out.push(['🧺', `عندك <b>${state.trades.length}</b> صفقات مفتوحة مع بعض — المخاطرة كلها في نفس الدقيقة.`]);
    if ((feed?.events || []).some((e) => e.cause === 'platform')) out.push(['🤨', 'فيه صفقة السوق قفل فيها في صالحك والمنصة حسبتها خسارة — راجعها في سجل المنصة.']);
    return [...out, ...GENERAL];
  }
  function tip(feed) {
    if (Date.now() - (C.tipAt || 0) < 12000) return;
    C.tipAt = Date.now();
    const all = tips(feed), live = all.length - GENERAL.length;
    // the moment's tips come first and come back more often than the general ones
    C.tipN = (C.tipN || 0) + 1;
    const pick = live && C.tipN % 2 ? all[(C.tipL = ((C.tipL ?? -1) + 1) % live)] : GENERAL[(C.tipG = ((C.tipG ?? -1) + 1) % GENERAL.length)];
    const box = $('tip'); if (!box || !pick) return;
    box.classList.add('fade');
    setTimeout(() => {
      $('tipI').textContent = pick[0]; $('tipT').innerHTML = pick[1]; wordify($('tipT'));
      box.classList.remove('fade', 'in'); void box.offsetWidth; box.classList.add('in');
      const bar = $('tipBar'); if (bar) bar.replaceWith(bar.cloneNode()); // the countdown to the next tip starts again
      react('r-talk', 1700);                                             // the bot says it
    }, 300);
  }
  // the tip's words appear one after the other (the markup inside is kept)
  function wordify(el) {
    let d = 0;
    const walk = (n) => { for (const c of [...n.childNodes]) {
      if (c.nodeType === 1) { walk(c); continue; }
      if (c.nodeType !== 3) continue;
      const frag = document.createDocumentFragment();
      for (const part of c.textContent.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); continue; }
        const w = document.createElement('span'); w.className = 'w'; w.style.setProperty('--d', d++); w.textContent = part; frag.appendChild(w);
      }
      c.replaceWith(frag);
    } };
    walk(el);
  }

  // ── starting: a short conversation — the stake, how many trades at once, a stop loss — each with its options and
  // a tip, then a quick read of the market, then the bot starts. The questions go away after; the summary and
  // the read stay. ──
  const W = { on: false, n: 0 };
  const balance = () => {
    // PO keeps both balances (demo and real) in the page, one of them hidden: the shown one
    const els = [...document.querySelectorAll('.balance-info-block__balance .js-hd, [class*="balance-info-block__balance"]')];
    const el = els.find((e) => e.getClientRects?.().length && !/hidden|none/.test(getComputedStyle(e).visibility + getComputedStyle(e).display)) || null;
    const m = /\d[\d,]*(\.\d+)?/.exec((el?.textContent || '').replace(/\s/g, ''));
    const v = m ? Number(m[0].replace(/,/g, '')) : null;
    return v > 0 ? v : null;
  };
  const opt = (step, v, label, hint = '') => `<button class="opt" data-w="${step}" data-v="${v}">${label}${hint ? `<small>${hint}</small>` : ''}</button>`;
  const say = (text, cls = 'w') => push({ id: `${cls}|${W.n}|${++C.seq}`, text });
  C.seq = 0;
  function wizard() {
    if (state.running) return;
    flush(); W.on = true; W.n++;
    const st = state.settings, bal = balance(), stake = st.amount, c = cur();
    const last = `${opt('again', 1, `⚡ زي آخر مرة`, `${stake} ${c} · ${st.maxOpen || '∞'} مع بعض`)}`;
    const amounts = [...new Set([stake, ...(bal ? [Math.max(1, Math.round(bal * 0.01)), Math.max(1, Math.round(bal * 0.02))] : []), 10, 25, 50, 100])].filter((x) => x > 0).sort((a, b) => a - b).slice(0, 6);
    const tipTxt = bal ? `💡 رصيدك <b>${Math.round(bal)} ${c}</b> — الأمان إن الصفقة متعدّيش 1–2% منه، يعني <b>${Math.max(1, Math.round(bal * 0.01))}–${Math.max(1, Math.round(bal * 0.02))} ${c}</b>.`
      : '💡 الأمان إن الصفقة متعدّيش <bdi>1–2%</bdi> من رصيدك.';
    say(`💬 <b>هتداول بكام في الصفقة الواحدة؟</b><div class="opts">${amounts.map((x) => opt('amount', x, `${x} ${c}`, bal && x === Math.max(1, Math.round(bal * 0.01)) ? '1%' : bal && x === Math.max(1, Math.round(bal * 0.02)) ? '2%' : x === stake ? 'الحالي' : '')).join('')}
      <span class="own"><input type="number" min="1" step="1" placeholder="مبلغ تاني" data-w="amountIn"><button class="opt" data-w="amountOk">تمام</button></span></div><div class="opts">${last}</div><span class="why">${tipTxt}</span>`);
  }
  function askOpen() {
    const a = state.settings.amount, c = cur();
    say(`📚 <b>تفتح كام صفقة مع بعض بحد أقصى؟</b><div class="opts">${[1, 2, 3, 5].map((n) => opt('open', n, String(n), n > 1 ? `${n * a} ${c}` : '')).join('')}${opt('open', 0, '∞', 'من غير حد')}</div>
      <span class="why">💡 الرقم الصغير تحت كل اختيار = أقصى فلوس ممكن تبقى في السوق مع بعض. صفقات كتير في نفس الدقيقة = خسارة كتير مرة واحدة لو السوق قلب.</span>`);
  }
  // the stop loss as the user thinks of it: "if I lose, how much stays in the account?" — from the balance (read from
  // PO, or asked) the most it may lose follows
  function askStop() { const bal = balance(); if (bal) askFloor(bal); else askBal(); }
  function askBal() {
    say(`💰 <b>رصيدك كام دلوقتي؟</b><div class="opts"><span class="own"><input type="number" min="1" step="1" placeholder="الرصيد"><button class="opt" data-w="balOk">تمام</button></span>${opt('stop', 0, 'من غير حد للخسارة')}</div>`);
  }
  function askFloor(bal) {
    W.bal = Math.floor(bal);
    const a = state.settings.amount, c = cur(), b = W.bal;
    const floors = [...new Set([b - 2 * a, b - 5 * a, Math.round(b * 0.95), Math.round(b * 0.9)])].filter((x) => x > 0 && x < b).sort((x, y) => y - x);
    say(`🛡️ <b>لو خسرت، عاوز يفضل في الحساب كام على الأقل؟</b><br><span class="why">رصيدك دلوقتي <b>${b} ${c}</b></span><div class="opts">${floors.map((f) => opt('floor', f, `${f} ${c}`, `أقصى خسارة ${b - f}`)).join('')}${opt('stop', 0, 'من غير')}
      <span class="own"><input type="number" min="1" step="1" placeholder="رقم تاني"><button class="opt" data-w="floorOk">تمام</button></span></div>
      <span class="why">💡 مش هدخل صفقة ممكن تنزّل الحساب تحت الرقم ده — والصفقات المفتوحة محسوبة. ولو كسبت، بحافظ على المكسب: بقف لما أخسر نفس المبلغ من أعلى نقطة.</span>`);
  }
  function askTarget() {
    const a = state.settings.amount, c = cur(), bal = W.bal || balance();
    const opts = [...new Set([3 * a, 5 * a, 10 * a, ...(bal ? [Math.round(bal * 0.05), Math.round(bal * 0.1)] : [])])].filter((x) => x > 0).sort((x, y) => x - y);
    say(`🎯 <b>عاوز تقفل اليوم لما تكسب كام؟</b><div class="opts">${opts.map((v) => opt('target', v, `+${v} ${c}`, bal && v === Math.round(bal * 0.05) ? '5% من رصيدك' : bal && v === Math.round(bal * 0.1) ? '10% من رصيدك' : '')).join('')}${opt('target', 0, 'من غير')}
      <span class="own"><input type="number" min="1" step="1" placeholder="رقم تاني"><button class="opt" data-w="targetOk">تمام</button></span></div>
      <span class="why">💡 بيتحسب من دلوقتي: أول ما المكسب يوصل الرقم ده، البوت يقفل اليوم وإنت كسبان.</span>`);
  }
  function finish() {
    const st = state.settings, c = cur();
    root.querySelectorAll(`.msg[data-id^="w|${W.n}|"], .msg[data-id^="me|${W.n}|"]`).forEach((el) => el.remove());
    W.on = false;
    say(`✅ <b>ماشي:</b> ${st.amount} ${c} للصفقة · ${st.maxOpen ? `لحد ${st.maxOpen} مع بعض` : 'من غير حد للصفقات مع بعض'}${st.target ? ` · هدف +${st.target} ${c}` : ''} · ${st.stopLoss ? (st.stopFloor ? `هيفضل في الحساب <b>${st.stopFloor} ${c}</b> على الأقل (أقصى خسارة ${st.stopLoss})` : `أقصى خسارة ${st.stopLoss} ${c}`) : 'من غير حد للخسارة'}`, 'ws');
    try { say(analysis(globalThis.IntelTab?.feed?.()), 'wa'); } catch (_) {} // the read never holds the start back
    start();
    if (!state.running) say(`مش قادر أبدأ: ${statusAr(state.status)}`, 'ws');
    update();
  }
  function choose(step, v, label) {
    push({ id: `me|${W.n}|${++C.seq}`, me: true, text: label }, { instant: true });
    const st = state.settings;
    if (step === 'again') return finish();
    if (step === 'amount') { st.amount = v; saveSettings(); render(); return askOpen(); }
    if (step === 'open') { st.maxOpen = v; saveSettings(); render(); return askStop(); }
    if (step === 'stop') { state.settings.stopFloor = 0; setStopLoss(v); render(); return askTarget(); }
    if (step === 'target') { setTarget(v); render(); return finish(); }
    if (step === 'floor') {
      if (!(W.bal > v)) { say(`لازم الرقم يبقى أقل من رصيدك (${W.bal}).`); return askFloor(W.bal); }
      state.settings.stopFloor = v; setStopLoss(W.bal - v); render(); return askTarget();
    }
    if (step === 'bal') return askFloor(v);
  }
  const appealHtml = (r) => `<b>نتيجة التظلّم:</b> ${r.title}<br>${(r.lines || []).map((l) => `<span class="why" style="display:block">${l}</span>`).join('')}`;
  function appealed(id, r) {
    C.appealing.delete(id);
    if (!r || r.error) { push({ id: `ap|${id}|err|${Date.now()}`, tone: 'warn', text: `🧐 مقدرتش أراجع الصفقة دي: ${r?.error || 'مفيش رد'}` }); return update(); }
    C.appealed.add(id);
    push({ id: `ap|${id}`, tone: 'warn', text: appealHtml(r) });
    globalThis.IntelTab?.askFeed?.(); update();
  }
  function onStreamClick(e) {
    const apb = e.target.closest('.ap');
    if (apb) { const id = apb.dataset.ap; if (!id || C.appealing.has(id)) return; C.appealing.add(id); apb.disabled = true; apb.textContent = '🔎 بيراجع…'; globalThis.IntelTab?.appeal?.(id); return; }
    const b = e.target.closest('.opt'); if (!b || !W.on) return;
    const step = b.dataset.w, box = b.closest('.msg');
    if (step === 'targetOk') { const v = Math.round(Number(box.querySelector('input')?.value)); if (!(v > 0)) return; box.querySelectorAll('.opt,input').forEach((x) => (x.disabled = true)); return choose('target', v, `${v} ${cur()}`); }
    if (step === 'balOk' || step === 'floorOk') { const v = Math.round(Number(box.querySelector('input')?.value)); if (!(v > 0)) return; box.querySelectorAll('.opt,input').forEach((x) => (x.disabled = true)); return choose(step === 'balOk' ? 'bal' : 'floor', v, `${v} ${cur()}`); }
    if (step === 'stopOk') { const v = Math.round(Number(box.querySelector('input')?.value)); if (!(v > 0)) return; box.querySelectorAll('.opt,input').forEach((x) => (x.disabled = true)); return choose('stop', v, `${v} ${cur()}`); }
    if (step === 'amountOk') { const v = Math.round(Number(box.querySelector('input')?.value)); if (!(v > 0)) return; box.querySelectorAll('.opt,input').forEach((x) => (x.disabled = true)); return choose('amount', v, `${v} ${cur()}`); }
    box.querySelectorAll('.opt,input').forEach((x) => (x.disabled = true)); b.classList.add('on');
    choose(step, Number(b.dataset.v), b.firstChild.textContent);
  }

  // ── the analyst: what the market is doing now, described — not a forecast ──
  const RG = { TRENDING_UP: '📈 طالع', TRENDING_DOWN: '📉 نازل', RANGING: '↔️ رايح جاي', RANGE: '↔️ رايح جاي', HIGH_VOLATILITY: '⚡ متقلّب', LOW_VOLATILITY: '😴 هادي', UNCLEAR: '🌫️ مش واضح' };
  function analysis(feed) {
    const IT = globalThis.IntelTab, out = ['📊 <b>قراية سريعة للسوق دلوقتي</b>'];
    const rg = IT?.pairView?.(state.asset)?.regime?.regime, pay = readPayout();
    if (state.asset) out.push(`• <b>${pairName(state.asset)}</b> (اللي على الشارت): ${RG[rg] || 'لسه بجمع بياناته'}${pay != null ? ` · ربح ${pay}% — عشان تكسب لازم تصيب أكتر من <b>${Math.round(10000 / (100 + pay)) / 100}%</b>` : ''}`);
    const groups = {};
    for (const a of IT?.feeds?.keys?.() || []) { const r = IT.pairView(a)?.regime?.regime; if (r && RG[r]) (groups[RG[r]] ||= []).push(pairName(a).replace(' OTC', '')); }
    const g = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
    if (g.length) out.push(`• الأزواج اللي بتابعها (${g.reduce((n, x) => n + x[1].length, 0)}): ${g.map(([k, v]) => `${k} <b>${v.length}</b>${v.length <= 3 ? ` (${v.join('، ')})` : ''}`).join(' · ')}`);
    const top = (state.assets || []).filter((a) => /_otc$/i.test(a.symbol) && a.active !== false && a.payout > 0).sort((a, b) => b.payout - a.payout).slice(0, 3);
    if (top.length) out.push(`• أعلى ربح دلوقتي: ${top.map((a) => `${pairName(a.symbol).replace(' OTC', '')} <b>${a.payout}%</b>`).join('، ')}`);
    const d = feed?.day;
    if (d && d.W + d.L) out.push(`• النهارده: <b class="g">${d.W}</b> كسب / <b class="r">${d.L}</b> خسارة · ${d.net >= 0 ? `<b class="g">+${money(d.net)}</b>` : `<b class="r">−${money(d.net)}</b>`}${d.best && d.best.net > 0 ? ` · الأشطر «${short(d.best.name)}»` : ''}${d.worst && d.worst.net < 0 ? ` · الأضعف «${short(d.worst.name)}»` : ''}`);
    else out.push('• النهارده: لسه مفيش صفقات.');
    const wl = watchLine(feed?.watch); if (wl) out.push(wl);
    out.push('<span class="why">ده وصف للسوق دلوقتي مش توقّع — حركة OTC عشوائية، ومفيش حالة بتضمن مكسب.</span>');
    return out.join('<br>');
  }

  // «🔧 حسّن»: the worker checks every strategy of the mode on its own record and applies only what held up on data
  // it did not choose with; the answer says what changed, and what did not and why
  const dur = (s) => AR.duration(s);
  function improved(r) {
    // by itself (every 30 min): said only when something changed
    if (r?.auto) { if (!(r.changes?.length || r.reverted?.length)) return; }
    else C.improving = false;
    if (!r || r.error) return push({ id: `wi|${++C.seq}`, text: `مقدرتش أراجع دلوقتي${r?.error ? ` (${r.error})` : ''} — جرّب تاني.` });
    if (r.noMode) return push({ id: `wi|${++C.seq}`, text: 'التحسين للاستراتيجيات بتاعة المود — اختار مود الاستراتيجيات الأول من ⚙.' });
    const nm = (id) => `«${short(r.names[id] || id)}»`, lines = [];
    for (const c of r.changes) {
      if (c.kind === 'expiry') lines.push(`⏱️ ${nm(c.id)}: المدة <b>${dur(c.from)} ← ${dur(c.to)}</b> <span class="why">(اتأكدت: ${c.test.cur.rate}% ← ${c.test.best.rate}%)</span>`);
      else lines.push(`⛔ ${nm(c.id)} <b>اتقفلت</b> <span class="why">(تحت 50% مرتين: ${c.train.rate}% و${c.test.rate}%)</span>`);
    }
    for (const v of r.reverted || []) lines.push(`↩️ ${nm(v.id)}: رجّعت مدتها لـ<b>${dur(v.to)}</b> <span class="why">(الـ${dur(v.from)} ماثبتتش)</span>`);
    const few = r.kept.filter((k) => k.reason === 'few').length, nc = r.kept.filter((k) => k.reason === 'not_confirmed'), ok = r.kept.filter((k) => k.reason === 'best_already').length;
    const nCh = r.changes.length + (r.reverted?.length || 0);
    const head = nCh ? `🔧 <b>${r.auto ? 'راجعت الاستراتيجيات لوحدي — ' : ''}غيّرت ${nCh} من ${r.total}:</b>` : `🔧 <b>راجعت ${r.total} استراتيجية — مفيش تغيير مثبت بالأرقام.</b>`;
    const faded = nc.filter((k) => !k.tried?.small).length, small = nc.filter((k) => k.tried?.small).length;
    const rest = [faded ? `${faded} مش متأكد منها` : '', small ? `${small} صفقاتها الجديدة قليلة` : '', ok ? `${ok} على أحسن مدة أصلًا` : '', few ? `${few} لسه جديدة` : ''].filter(Boolean);
    push({ id: `wi|${++C.seq}`, tone: r.auto ? 'warn' : '', text: `${head}${lines.length ? `<br>${lines.join('<br>')}` : ''}${rest.length ? `<br><span class="why">الباقي زي ما هو: ${rest.join(' · ')}</span>` : ''}` });
    C.improvedAt = Date.now() / 1000; try { localStorage.setItem('pobotImprovedAt', String(C.improvedAt)); } catch (_) {}
    update();
  }

  // ── the integrity watch: alerts only when something is off (rare by design), and a line in «📊 حلّل» ──
  const INT = {
    settle_against: (f) => `المنصة حسبت <b>${f.against}</b> صفقة خسارة والسوق كان كسبان، مقابل <b>${f.forUs}</b> بس بالعكس`,
    close_worse: (f) => `سعر إغلاق المنصة أسوأ من السوق في <b>${f.worse}</b> من ${f.of} صفقة`,
    placed_lose_more: (f) => `صفقاتك الحقيقية بتكسب <b>${f.placed}%</b> والإشارات اللي مادخلتهاش <b>${f.notPlaced}%</b>`,
    moves_against_placed: () => 'السعر بيتحرك ضد صفقاتك في أول 5 ثواني أكتر من الإشارات اللي مادخلتهاش',
  };
  function alerts(w) {
    if (!w) return;
    const day = new Date().toDateString(), slot = Math.floor(Date.now() / 600000);
    for (const f of w.integrity?.flags || []) push({ id: `int|${f.code}|${day}`, tone: 'warn', text: `🚨 <b>علامة تلاعب:</b> ${INT[f.code]?.(f) || f.code}.<br><span class="why">ده مش صدفة بنسبة كبيرة — خلي بالك، وقلّل المبلغ أو وقّف لحد ما نشوف.</span>` });
    for (const x of (w.fast || []).slice(0, 2)) push({ id: `spd|${x.asset}|${slot}`, tone: 'warn', text: `⚡ <b>${pairName(x.asset)}</b> بيتحرك أسرع من طبيعته <b>×${x.ratio}</b> — مش هدخل عليه لحد ما يهدى.` });
    if (w.clock != null && Math.abs(w.clock) >= 0.02) push({ id: `clk|${Math.floor(Date.now() / 1800000)}`, tone: 'warn', text: `⏩ ساعة المنصة بتجري <b>${w.clock > 0 ? 'أسرع' : 'أبطأ'}</b> من الساعة الحقيقية بـ${Math.abs(Math.round(w.clock * 1000) / 10)}%.` });
  }
  function watchLine(w) {
    const g = w?.integrity; if (!g) return null;
    const head = g.status === 'suspicious' ? '🚨 <b>فيه علامات تلاعب</b>' : g.status === 'clean' ? '🛡️ فحص التلاعب: <b>مفيش علامات</b>' : '🛡️ فحص التلاعب: لسه صفقات قليلة';
    const det = [g.trades ? `المنصة ضدّك ${g.against} / معاك ${g.forUs} من ${g.trades} صفقة` : '', g.placed && g.notPlaced ? `الحقيقي ${g.placed.rate}% والورقي ${g.notPlaced.rate}%` : ''].filter(Boolean).join(' · ');
    const fast = (w.fast || []).length ? `<br>• ⚡ أسرع من طبيعتها: ${w.fast.map((x) => `${pairName(x.asset).replace(' OTC', '')} ×${x.ratio}`).join('، ')}` : '';
    return `• ${head}${det ? ` <span class="why">(${det})</span>` : ''}${fast}`;
  }

  function ask(q) {
    if (q === 'improve') {
      if (C.improving) return;
      C.improving = true; flush();
      push({ id: `me|i|${++C.seq}`, me: true, text: '🔧 حسّن الاستراتيجيات' }, { instant: true });
      globalThis.IntelTab?.improve?.();
      setTimeout(() => { if (C.improving) improved({ error: 'مفيش رد' }); }, 30000);
      return;
    }
    if (q === 'analyze') { flush(); push({ id: `wa|x|${++C.seq}`, text: analysis(globalThis.IntelTab?.feed?.()) }); return; }
    if (q !== 'power') return;
    if (state.running) { stop('Stopped'); update(); } else wizard();
  }

  function update() {
    if (!root || !$('stream')) return;
    if (!C.mounted) { C.mounted = true; mount(); }
    if (Date.now() - C.asked > 5000) { C.asked = Date.now(); globalThis.IntelTab?.askFeed?.(); }
    const feed = globalThis.IntelTab?.feed?.(), st = now(feed);
    const rc = C.react && Date.now() < C.react.until ? ` ${C.react.kind}` : '';
    if ($('orb').className !== `orb ${st.mood}${rc}`) $('orb').className = `orb ${st.mood}${rc}`;
    $('mood').classList.toggle('busy', st.mood === 'scan');
    const open = state.trades.length;
    const mx = state.settings.maxOpen || 0;
    $('mood').textContent = !state.running && state.badDeal ? '⚠️ واقف — صفقة اتفتحت غلط' : !state.running && targetHit() ? '🎯 واقف — وصلت للهدف' : !state.running && stopLossHit() ? '🛑 واقف — وصلنا لحد الخسارة' : mx > 0 && open >= mx ? `⏸ ${open} صفقات مفتوحة (الحد ${mx}) — مستني واحدة تقفل` : open > 1 ? `في ${open} صفقات` : { stop: '✋ واقف (إيقاف الطوارئ)', sleep: 'واقف — دوس «شغّل ▶»', up: 'في صفقة شراء', down: 'في صفقة بيع', scan: `🔎 بيحلل ${feed?.pairs || globalThis.IntelTab?.feeds?.size || 0} زوج` }[st.mood] || '';
    $('qPower').textContent = state.running ? 'وقّف ✋' : 'شغّل ▶';
    // after a loss the button asks to be pressed
    const lastL = [...(feed?.events || [])].reverse().find((e) => !e.paper && e.result === 'L');
    $('qImp')?.classList.toggle('pulse', !!lastL && (lastL.at ?? lastL.ts) > (C.improvedAt ??= (() => { try { return +localStorage.getItem('pobotImprovedAt') || 0; } catch (_) { return 0; } })()));
    const d = feed?.day || { W: 0, L: 0, net: 0 };
    countTo($('tW'), d.W); countTo($('tL'), d.L);
    const tN = $('tN'); countTo(tN, d.net, (x) => `${x > 0 ? '+' : ''}${x}`); tN.className = d.net > 0 ? 'g' : d.net < 0 ? 'r' : '';
    tip(feed);
    if (!feed && C.first) return;
    alerts(feed?.watch);
    // the day's profit target reached → the bot closes the day and says so
    if (targetHit()) {
      if (state.running) stop('Daily target reached');
      const tm = targetMoney();
      push({ id: `tg|${new Date().toDateString()}|${state.settings.targetFrom}`, tone: 'win', text: `🎯 <b>وصلت للهدف: +${money(tm.net)}</b> (الهدف ${money(state.settings.target)}). <b>قفلت اليوم</b> وإنت كسبان 💰<br><span class="why">لو عاوز تكمّل، دوس شغّل واختار هدف جديد.</span>` });
    }
    // a deal PO opened that is not what the bot meant → stopped at once (bot.js); say what differed
    if (state.badDeal) push({ id: `bd|${state.badDeal.at}`, tone: 'loss', text: `⚠️ <b>صفقة اتفتحت مختلفة عن المطلوب</b> على ${pairName(state.badDeal.asset)}: ${state.badDeal.reasons.join('، ')}. <b>وقفت البوت</b> — راجع الصفقة في PO قبل ما تشغّله تاني.` });
    // the stop loss: the day's money this far below its highest point → the bot stops itself and says so
    if (stopLossHit()) {
      const dm = dayMoney(), sl = state.settings.stopLoss;
      if (state.running) stop('Daily stop loss reached');
      const left = Math.max(0, +(sl - dm.down).toFixed(2));
      push({ id: `sl|${new Date().toDateString()}|${sl}|${state.settings.stopLossFrom}`, tone: 'warn', text: `🛑 <b>وصلنا لحد الخسارة:</b> نزلت <b>${money(dm.down)}</b> من أعلى نقطة${left > 0 ? `، وفاضل <b>${money(left)}</b> بس — أقل من مبلغ الصفقة (${money(state.settings.amount)})، فأي صفقة ممكن تعدّي الحد` : ''}. <b>وقفت البوت.</b>${state.settings.stopFloor ? ` عشان يفضل في الحساب ${state.settings.stopFloor} زي ما قلت.` : ''}<br><span class="why">لو عاوز تكمّل، دوس شغّل واختار رقم جديد${left > 0 ? ' — أو صفقة أصغر' : ''}.</span>` });
    }
    const evs = evMsgs(feed), byId = new Map((feed?.events || []).map((e) => [e.id, e]));
    evs.forEach((m, i) => {
      push(m, { instant: C.first && i < evs.length - 2 });
      const ap = byId.get(m.id)?.appeal; // an appeal made earlier: its answer right under the trade
      if (ap) push({ id: `ap|${m.id}`, tone: 'warn', text: appealHtml(ap) }, { instant: C.first });
    });
    C.first = false;
  }
  globalThis.PanelChat = {
    update: () => { try { update(); } catch (_) {} },
    improved: (r) => { try { improved(r); } catch (_) {} },
    appealed: (id, r) => { try { appealed(id, r); } catch (_) {} },
    // a strategy switched off by its own results (its losses in a row, or its record)
    stratOff: (items) => { try { for (const x of items || []) push({ id: `off|${x.id}|${x.n}`, tone: 'loss', text: x.kind === 'learn' ? (x.on ? `🧠 <b>البوت اتعلّم:</b> مش هيدخل لما «${x.name}» — كسبت ${x.w} من ${x.n} بس، في القديم والجديد.` : `🧠 «${x.name}» رجعت مسموحة — مبقتش بتخسر في الصفقات الجديدة.`) : x.kind === 'keep' ? `✅ <b>شغّال دلوقتي الاستراتيجيات الكسبانة بس</b> (${x.items.length}): ${x.items.map((k) => `«${short(k.name)}» ${k.w}/${k.n}`).join('، ')}${x.off ? ` — والباقي (${x.off}) اتقفل` : ''}.` : x.kind === 'pause' ? `⏸️ <b>«${short(x.name)}» واقفة ${x.min} دقيقة</b> — خسرت ${x.streak} مرات ورا بعض، إشاراتها بتتسجل من غير دخول.` : `⛔ <b>«${short(x.name)}» اتقفلت</b> — ${x.kind === 'streak' ? `خسرت ${x.streak} مرات ورا بعض` : `${x.w} كسب من ${x.n} صفقة (${Math.round((100 * x.w) / x.n)}%)`}.` }); } catch (_) {} },
    wizard: () => { try { wizard(); } catch (_) { start(); } },
    show: () => { const p = root?.querySelector('.p'); if (p) { p.classList.remove('min'); p.animate?.([{ transform: 'scale(.96)' }, { transform: 'scale(1)' }], { duration: 250 }); } },
  };
})();
