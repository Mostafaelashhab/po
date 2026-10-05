// The popup's home as a conversation: the bot tells you, in its own words, what it is doing — scanning, a signal,
// a trade opening, the result and why it lost — with a living orb, typing dots and animated counters. Built once and
// updated in place (render() runs every second while something counts down; animations must not restart).
(function () {
  const C = { shown: new Set(), queue: [], typing: false, cur: 'ج', seen: new Set(), first: true };
  try { C.seen = new Set(JSON.parse(localStorage.getItem('chatSeen') || '[]')); } catch (_) {}
  try { chrome.storage.local.get(['settings'], (r) => { const c = r?.settings?.currency; C.cur = !c || c === 'EGP' ? 'ج' : c; }); } catch (_) {}
  const remember = () => { try { localStorage.setItem('chatSeen', JSON.stringify([...C.seen].slice(-400))); } catch (_) {} };
  const nowS = () => Math.floor(Date.now() / 1000);
  const money = (x) => `${Math.round(Math.abs(x) * 100) / 100} ${C.cur}`;
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
  const pairName = (a) => AR.pair(a);
  const stratName = (id) => (id === 'keltner_trend_pullback' ? 'كيلتنر 10د' : OTC.Strategies?.get?.(id)?.name || AR.STRATEGY?.[id] || (id || '').replace(/_/g, ' '));
  const dirWord = (d) => (d === 'CALL' || d === 'call' ? 'شراء' : 'بيع');
  const dirIcon = (d) => (d === 'CALL' || d === 'call' ? '📈' : '📉');
  const CAUSE = { late: 'اتأخرنا في الدخول ثانية أو اتنين — من سعر الإشارة كانت هتكسب', too_short: 'المدة كانت قصيرة — لو كانت أطول كانت هتكسب', too_long: 'المدة كانت طويلة — كانت كسبانة وبعدين رجعت',
    wrong_way: 'السوق راح عكسها على طول', platform: 'السوق قفل في صالحنا بس المنصة حسبتها خسارة 🤨', chance: 'صدفة — مفيش مدة كانت هتكسب بوضوح' };

  // ── the stage: orb + counters, the conversation, quick replies ───────────────
  function mount(v) {
    v.innerHTML = `<div class="chat">
      <div class="hero2">
        <div class="orb" id="orb"><div class="ring"></div><div class="core"></div><div class="face"><i></i><i></i></div></div>
        <div class="who"><b>البوت</b><span id="mood">بيصحى…</span></div>
        <div class="tally"><div><b id="tW" data-v="0">0</b><span>كسب</span></div><div><b id="tL" data-v="0">0</b><span>خسارة</span></div><div><b id="tN" data-v="0">0</b><span>صافي اليوم</span></div></div>
      </div>
      <div class="stream" id="stream"></div>
      <div class="chips" id="chips">
        <button data-q="news">إيه الأخبار؟</button><button data-q="day">النهارده عامل إيه؟</button><button data-q="last">آخر صفقة؟</button><button data-q="power" id="qPower">وقّف ✋</button>
      </div></div>`;
    v.querySelectorAll('#chips button').forEach((b) => (b.onclick = () => ask(b.dataset.q)));
    C.shown.clear(); C.queue = []; C.typing = false; C.first = true;
  }

  // messages: { id, text (html), tone, live } — live ones are updated in place
  function push(m, { instant = false } = {}) {
    if (C.shown.has(m.id)) return update(m);
    C.shown.add(m.id);
    const old = C.seen.has(m.id);
    C.seen.add(m.id); remember();
    if (instant || old) return append(m, false);
    C.queue.push(m); pump();
  }
  function pump() {
    if (C.typing || !C.queue.length) return;
    const m = C.queue.shift(), s = document.getElementById('stream'); if (!s) return;
    C.typing = true;
    const t = document.createElement('div'); t.className = 'msg bot typing'; t.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    s.appendChild(t); s.scrollTop = s.scrollHeight;
    C.pending = { m, t, timer: setTimeout(() => { C.pending = null; t.remove(); append(m, true); C.typing = false; pump(); }, Math.min(1400, 450 + m.text.length * 9)) };
  }
  // the user spoke: whatever the bot was still typing is shown at once, so the answer comes right after the question
  function flush() {
    if (C.pending) { clearTimeout(C.pending.timer); C.pending.t.remove(); append(C.pending.m, false); C.pending = null; }
    while (C.queue.length) append(C.queue.shift(), false);
    C.typing = false;
  }
  function append(m, animate) {
    const s = document.getElementById('stream'); if (!s) return;
    const d = document.createElement('div');
    d.className = `msg ${m.me ? 'me' : 'bot'} ${m.tone || ''} ${animate ? 'pop' : ''}`; d.dataset.id = m.id;
    d.innerHTML = `<div class="bubble">${m.text}</div>${m.at ? `<span class="at">${m.at}</span>` : ''}`;
    s.appendChild(d);
    if (animate && m.tone === 'win') burst(d);
    s.scrollTop = s.scrollHeight;
  }
  function update(m) {
    const el = document.querySelector(`.msg[data-id="${CSS.escape(m.id)}"] .bubble`);
    if (el && el.innerHTML !== m.text) el.innerHTML = m.text;
  }
  function burst(el) {
    const b = document.createElement('div'); b.className = 'burst';
    b.innerHTML = Array.from({ length: 10 }, (_, i) => `<i style="--a:${i * 36}deg;--c:${['#34d399', '#fbbf24', '#a78bfa', '#60a5fa'][i % 4]}"></i>`).join('');
    el.appendChild(b); setTimeout(() => b.remove(), 1200);
  }
  function countTo(el, v, fmt = (x) => x) {
    if (!el) return; const from = +el.dataset.v || 0; if (from === v) { el.textContent = fmt(v); return; }
    el.dataset.v = v; const t0 = performance.now(), dur = 700;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), x = from + (v - from) * (1 - Math.pow(1 - k, 3)); el.textContent = fmt(Math.round(x * 100) / 100); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  // ── what the bot says ────────────────────────────────────────────────────────
  function statusOf(s, list) {
    const open = (s.tabsInfo || []).flatMap((t) => t.openTrades || []);
    if (s.risk?.emergency) return { mood: 'stop', text: 'أنا واقف دلوقتي ✋ مش هدخل أي صفقة لحد ما تقولّي «شغّل».' };
    if (!s.tabs) return { mood: 'sleep', text: 'مش شايف أي تاب للمنصة مفتوح 👀 افتح Pocket Option وأنا أبدأ على طول.' };
    if (['AUTO', 'MANUAL'].includes(s.cfg?.execMode) && (s.tabsInfo || []).length && !(s.tabsInfo || []).some((t) => t.armed))
      return { mood: 'sleep', text: 'التاب مفتوح بس محدش داس «تشغيل» في اللوحة اللي جوه المنصة 🙃 دوس عليها وأنا أشتغل.' };
    if (open.length) {
      const o = open[0], left = Math.round((o.openedAt + o.expiry * 1000 - Date.now()) / 1000);
      return { mood: o.dir === 'call' || o.dir === 'CALL' ? 'up' : 'down', text: `داخل صفقة <b>${dirWord(o.dir)}</b> ${dirIcon(o.dir)} على <b>${pairName(o.asset)}</b> بـ${money(o.stake)} — فاضل <b class="clock">${mmss(left)}</b> ⏳${open.length > 1 ? ` (ومعاها ${open.length - 1} كمان)` : ''}` };
    }
    const enter = list.find((x) => x.st.key === 'enter');
    if (enter) { const d = AR.decision(enter.p, nowS(), s.cfg); return { mood: d.dir === 'CALL' ? 'up' : 'down', text: `⚡ لقيت إشارة <b>${dirWord(d.dir)}</b> على <b>${pairName(enter.p.asset)}</b> — بدخل دلوقتي!` }; }
    const mode = s.cfg?.soloMode === 'youtube' ? ' بالاستراتيجيات بتاعتك' : '';
    return { mood: 'scan', text: `بفتّش في <b>${list.length}</b> ${list.length === 1 ? 'زوج' : 'زوج'}${mode} 🔎 مستني إشارة تستاهل…` };
  }
  function eventsOf(recs, s) {
    const out = [], today = new Date(); today.setHours(0, 0, 0, 0);
    const taken = recs.filter((r) => ['auto', 'manual', 'paper'].includes(r.exec?.action) && r.exec?.status !== 'failed' && r.ts * 1000 >= today.getTime() - 3 * 3600e3).sort((a, b) => a.ts - b.ts).slice(-14);
    for (const r of taken) {
      const d = r.exec?.dir || r.decision, real = r.exec?.action !== 'paper', at = new Date(r.ts * 1000).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
      const stake = r.exec?.stake;
      out.push({ id: `${r.id}|o`, at, text: `${dirIcon(d)} إشارة <b>${dirWord(d)}</b> على <b>${pairName(r.asset)}</b> من «${stratName(r.setup)}» — ${real ? 'دخلت' : 'سجّلتها ورقي'}${stake ? ` بـ${money(stake)}` : ''}، مدتها ${AR.duration(r.expirySec || 60)}.` });
      const R = r.exec?.result;
      if (!R) continue;
      const p = r.exec.profit;
      if (R === 'W') out.push({ id: `${r.id}|r`, tone: 'win', text: `كسبنا 🎉 ${p != null ? `<b class="g">+${money(p)}</b>` : ''} على ${pairName(r.asset)}` });
      else if (R === 'L') { const pm = OTC.PostMortem?.analyze(r); out.push({ id: `${r.id}|r`, tone: 'loss', text: `خسرنا دي 😕 ${p != null ? `<b class="r">−${money(p)}</b>` : ''} على ${pairName(r.asset)}${pm?.cause ? `<br><span class="why">السبب: ${CAUSE[pm.cause]}</span>` : ''}` }); }
      else out.push({ id: `${r.id}|r`, text: `رجعت فلوسها زي ما هي 🤝 على ${pairName(r.asset)}` });
    }
    return out;
  }
  function dayOf(recs) {
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const xs = recs.filter((r) => ['auto', 'manual'].includes(r.exec?.action) && r.exec?.result && r.ts * 1000 >= t0.getTime());
    const W = xs.filter((r) => r.exec.result === 'W').length, L = xs.filter((r) => r.exec.result === 'L').length, net = xs.reduce((a, r) => a + (Number(r.exec.profit) || 0), 0);
    const by = {}; for (const r of xs) { const b = (by[r.setup] ||= { n: 0, net: 0 }); b.n++; b.net += Number(r.exec.profit) || 0; }
    const ranked = Object.entries(by).sort((a, b) => b[1].net - a[1].net);
    return { W, L, n: xs.length, net: Math.round(net * 100) / 100, best: ranked[0], worst: ranked.length > 1 ? ranked[ranked.length - 1] : null };
  }
  const dayText = (dy) => (dy.n ? `حصيلة النهارده: <b class="g">${dy.W}</b> كسب و<b class="r">${dy.L}</b> خسارة — ${dy.net >= 0 ? `<b class="g">+${money(dy.net)}</b> 💰` : `<b class="r">−${money(dy.net)}</b>`}
    <div class="wr"><i style="width:${Math.round((100 * dy.W) / Math.max(1, dy.W + dy.L))}%"></i></div>${dy.best && dy.best[1].net > 0 ? `<span class="why">الأشطر النهارده: «${stratName(dy.best[0])}» (${dy.best[1].net >= 0 ? '+' : '−'}${money(dy.best[1].net)})</span>` : ''}`
    : 'لسه مادخلناش أي صفقة النهارده 🙂');

  async function ask(q) {
    const s = S.snap; if (!s) return;
    const recs = await loadRecords(), list = pairsWithStatus();
    flush();
    const me = { news: 'إيه الأخبار؟', day: 'النهارده عامل إيه؟', last: 'آخر صفقة؟', power: s.risk?.emergency ? 'شغّل ▶' : 'وقّف ✋' }[q];
    push({ id: `u${Date.now()}`, me: true, text: me }, { instant: true });
    let text;
    if (q === 'news') text = statusOf(s, list).text;
    else if (q === 'day') { const dy = dayOf(recs); text = dayText(dy) + (dy.worst && dy.worst[1].net < 0 ? `<br><span class="why">اللي تعبتنا: «${stratName(dy.worst[0])}» (−${money(dy.worst[1].net)})</span>` : ''); }
    else if (q === 'last') {
      const r = recs.find((x) => ['auto', 'manual'].includes(x.exec?.action));
      if (!r) text = 'لسه مافيش صفقات اتنفذت 🙂';
      else { const R = r.exec?.result, pm = R === 'L' ? OTC.PostMortem?.analyze(r) : null;
        text = `آخر صفقة: <b>${dirWord(r.exec?.dir || r.decision)}</b> على <b>${pairName(r.asset)}</b> من «${stratName(r.setup)}» ${AR.ago(nowS() - r.ts)} — ${R === 'W' ? 'كسبت 🎉' : R === 'L' ? 'خسرت 😕' : R === 'T' ? 'تعادل 🤝' : 'لسه مستني نتيجتها ⏳'}${pm?.cause ? `<br><span class="why">${CAUSE[pm.cause]}</span>` : ''}`; }
    } else if (q === 'power') {
      if (s.risk?.emergency) { await act('resume'); text = 'تمام، رجعت أشتغل 💪'; } else { await act('stop'); text = 'وقفت ✋ مش هدخل حاجة لحد ما تقولّي.'; }
    }
    push({ id: `a${Date.now()}`, text });
  }

  // ── the view ─────────────────────────────────────────────────────────────────
  globalThis.viewChat = async function viewChat() {
    const v = document.getElementById('view');
    if (!v.querySelector('.chat')) mount(v);
    const s = S.snap;
    const orb = document.getElementById('orb'), mood = document.getElementById('mood');
    if (!s) { orb.className = 'orb sleep'; mood.textContent = 'بيتصل بالنظام…'; return null; }
    if (Date.now() - S.recordsAt > 5000) S.records = null;
    const recs = await loadRecords(), list = pairsWithStatus();
    const st = statusOf(s, list);
    orb.className = `orb ${st.mood}`;
    mood.textContent = { stop: 'واقف', sleep: 'مستني التاب', up: 'في صفقة شراء', down: 'في صفقة بيع', scan: 'شغال وبيدوّر' }[st.mood] || '';
    document.getElementById('qPower').textContent = s.risk?.emergency ? 'شغّل ▶' : 'وقّف ✋';
    const dy = dayOf(recs);
    countTo(document.getElementById('tW'), dy.W); countTo(document.getElementById('tL'), dy.L);
    const tN = document.getElementById('tN'); countTo(tN, dy.net, (x) => `${x > 0 ? '+' : ''}${x}`); tN.className = dy.net > 0 ? 'g' : dy.net < 0 ? 'r' : '';
    // the conversation: greeting, what happened today, the day's tally, what it is doing now
    const h = new Date().getHours(), day = new Date().toDateString();
    push({ id: `hello|${day}`, text: `${h < 12 ? 'صباح الفل ☀️' : h < 18 ? 'أهلًا 👋' : 'مساء الخير 🌙'} أنا البوت بتاعك، بتابعلك السوق ثانية بثانية وهقولك كل حاجة بتحصل.` }, { instant: C.first });
    const evs = eventsOf(recs, s);
    evs.forEach((m, i) => push(m, { instant: C.first && i < evs.length - 2 }));
    if (dy.n) push({ id: `day|${dy.W}|${dy.L}`, text: dayText(dy) });
    // "now" lives at the bottom: one bubble updated in place, re-sent when the situation changes
    const key = `now|${st.mood}|${(s.tabsInfo || []).flatMap((t) => t.openTrades || []).map((o) => o.openedAt).join(',')}`;
    if (C.nowKey !== key) { C.nowKey = key; push({ id: key, text: st.text, live: true }); } else update({ id: key, text: st.text });
    C.first = false;
    return null;
  };
})();
