// OTC Intelligence dashboard. Live state comes from the service worker over a
// port; the decision log, statistics and research read IndexedDB directly and
// use the same engine code as the tabs.
const $ = (sel, el = document) => el.querySelector(sel);
const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f1 = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));
const pct = (v) => (v == null || !Number.isFinite(v) ? '–' : `${v.toFixed(1)}%`);
const time = (ts) => (ts ? new Date(ts * 1000).toISOString().replace('T', ' ').slice(5, 16) : '–');
const dirCls = (d) => (d === 'CALL' ? 'call' : d === 'PUT' ? 'put' : 'skip');
const pair = (a) => OTC.U.pairLabel(a);
const dw = (d) => (d === 'CALL' ? 'شراء' : d === 'PUT' ? 'بيع' : d === 'SKIP' ? 'انتظار' : d || '–');
const rg = (r) => (r ? `<span title="${e(r)}">${e(AR.regime(r))}</span>` : '–');
const MODULE_AR = { trend: 'الاتجاه', structure: 'هيكل السوق', priceAction: 'الشموع', sr: 'الدعم والمقاومة', momentum: 'الزخم', volatility: 'التذبذب',
  breakout: 'الاختراق والسيولة', fibonacci: 'فيبوناتشي', bollinger: 'بولينجر', signal: 'إشارة المنصة' };
const FAMILY_AR = { trend: 'اتجاه', breakout: 'اختراق', reversal: 'انعكاس', liquidity: 'سيولة', range: 'نطاق', priceaction: 'شموع', structure: 'هيكل',
  confluence: 'توافق', fibonacci: 'فيبوناتشي', bollinger: 'بولينجر', momentum: 'زخم', discovered: 'مكتشف' };
const sname = (id) => (id ? (/^DISC-/.test(id) ? id : AR.strategyName(id)) : '–');

const S = {
  snap: null, view: 'live', port: null, records: null, loadedAt: 0, expanded: new Set(), logSel: null,
  opt: { source: 'all', expiry: 1, basis: 'taken', nonOverlap: true, matrixBasis: 'fired', asset: '', decision: 'all', frame: '300' },
  research: { log: [], busy: false },
};

// ── service worker connection ────────────────────────────────────────────────
function connect() {
  S.port = chrome.runtime.connect({ name: 'intel-dash' });
  S.port.onMessage.addListener((m) => {
    if (m.type === 'snapshot') { S.snap = m; renderHeader(); if (S.view === 'live') renderLive(); if (S.view === 'settings' && !S.settingsDrawn) renderSettings(); }
    else if (m.type === 'historyProgress' || m.type === 'historyDone') onHistoryMsg(m);
  });
  S.port.onDisconnect.addListener(() => { S.port = null; setTimeout(connect, 1500); });
}
const send = (m) => S.port?.postMessage(m);

// ── header ───────────────────────────────────────────────────────────────────
function renderHeader() {
  const s = S.snap;
  if (!s) return;
  if (document.activeElement !== $('#execMode')) $('#execMode').value = s.cfg.execMode;
  const em = s.risk?.emergency;
  $('#emergency').textContent = em ? 'تشغيل النظام' : 'إيقاف النظام';
  $('#emergency').classList.toggle('on', !!em);
  const b = $('#banner');
  if (em) { b.className = 'banner'; b.textContent = `النظام متوقف — ${em}. لن يتم تنفيذ أو تنبيه أي صفقة حتى تعيد التشغيل.`; }
  else if (s.cfg.execMode === 'AUTO') { b.className = 'banner'; b.textContent = `التنفيذ التلقائي مفعّل: التبويبات المفعّلة تنفّذ الأنماط المعتمدة فقط (${(s.cfg.promotedProfiles || []).length}). كل ما عداها ورقي.`; }
  else if (!s.tabs) { b.className = 'banner info'; b.textContent = 'لا يوجد تبويب Pocket Option متصل. افتح المنصة على أزواج OTC، ويمكن ترك التبويبات في الخلفية.'; }
  else b.className = 'banner hidden';
}
$('#execMode').addEventListener('change', (ev) => {
  const v = ev.target.value;
  if (v === 'AUTO' && !confirm('التنفيذ التلقائي ينفّذ صفقات دون سؤالك، فقط للأنماط التي اعتمدتها بعد التحقق، وفقط في التبويبات التي فعّلتها، ويبقى قيد "الحساب التجريبي فقط" قائمًا ما لم تلغه في التبويب. متابعة؟')) { ev.target.value = S.snap?.cfg.execMode || 'PAPER'; return; }
  send({ type: 'setConfig', patch: { execMode: v } });
});
$('#emergency').addEventListener('click', () => send({ type: 'emergency', on: !S.snap?.risk?.emergency }));

$('#nav').addEventListener('click', (ev) => {
  const v = ev.target.dataset?.view;
  if (!v) return;
  S.view = v;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  document.querySelectorAll('.view').forEach((x) => x.classList.toggle('hidden', x.id !== `view-${v}`));
  render();
});

async function loadRecords(force = false) {
  if (!force && S.records && Date.now() - S.loadedAt < 30000) return S.records;
  S.records = await DB.all('records');
  S.loadedAt = Date.now();
  return S.records;
}
// Records of one kind only: per-frame analyses of one setup frame (outcomes in candles of that frame),
// or opportunities (outcomes in minutes after entry). Mixing them would mix units.
const inFrame = (r, fr) => (fr === 'opp' ? r.kind === 'opp' : r.kind !== 'opp' && (r.tf || 300) === +fr);
function filtered() {
  const o = S.opt;
  return (S.records || []).filter((r) => inFrame(r, o.frame) && (o.source === 'all' || r.source === o.source) && (!o.asset || r.asset === o.asset));
}
// Outcome horizons of the current selection, with labels in minutes.
function horizons() {
  const c = S.snap?.cfg || OTC.DEFAULT_CONFIG;
  const lab = (sec) => (sec < 60 ? `${sec}ث` : `${sec / 60}د`), long = (sec) => (sec < 60 ? `${sec} ثانية` : `${sec / 60} دقيقة`);
  if (S.opt.frame === 'opp') return c.oppHorizonsSec.map((sec) => ({ N: sec, label: lab(sec), long: `${long(sec)} بعد الدخول` }));
  const tf = +S.opt.frame;
  return c.expiries.map((x) => ({ N: x, label: lab(x * tf), long: `${long(x * tf)} (${x} شمعة)` }));
}
const FRAME_OPTS = [['5', 'تحليلات فريم 5 ثوانٍ'], ['10', 'تحليلات فريم 10 ثوانٍ'], ['15', 'تحليلات فريم 15 ثانية'], ['30', 'تحليلات فريم 30 ثانية'], ['60', 'تحليلات فريم الدقيقة'], ['300', 'تحليلات فريم 5 دقائق'], ['900', 'تحليلات فريم 15 دقيقة'], ['opp', 'الفرص (دخول فعلي أو ميل)']];

function render() {
  const fn = { live: renderLive, log: renderLog, stats: renderStats, matrix: renderMatrix, validation: renderValidation, research: renderResearch, discovery: renderDiscovery, settings: renderSettings }[S.view];
  Promise.resolve(fn()).catch((err) => { $(`#view-${S.view}`).innerHTML = `<p class="bad">خطأ: ${e(err.message)}</p>`; console.error(err); });
}

// Calibrated confidence: the gate, and whether the model is honest so far. Buckets of the
// confidence the engine claimed at entry (traded or gated), against what then happened.
function calHtml(s) {
  const c = s.calStatus || { status: 'COLLECTING', rows: [] }, g = s.cfg.gate || {};
  const ST = { COLLECTING: ['muted', 'يجمع النتائج'], OK: ['', 'سليم حتى الآن'], CONFIRMED: ['ok', 'مؤكَّد'], REJECTED: ['bad', 'مرفوض — التداول متوقف'] };
  const [cls, txt] = ST[c.status] || ST.COLLECTING;
  const label = (r) => (r.lo == null ? 'لم تُقَس (بلا تاريخ)' : `${r.lo}–${Math.min(100, r.hi)}%`);
  return `<h2>شروط الدخول ونموذج الثقة <span class="${cls}" style="font-size:.8em">${txt}</span></h2>
    <p class="note">لا دخول على زوج نسبة ربحه أقل من ${g.minPayout ?? 92}%. الثقة المعايرة = احتمال أن نوع الفرصة يتفوق على نقطة التعادل، من نتائج فرص مشابهة خارج العينة؛ تمنع الدخول فقط عندما تُقاس وتكون أقل من ${g.minConfidence ?? 50}%. الجدول يقارن الثقة عند الدخول بما حدث فعلًا؛ إذا لم تتفوق الفرص التي سمح بها النموذج على نقطة التعادل (بعد ${g.monitorMinN ?? 30} فرصة) يُرفض ويتوقف التداول.</p>
    <div class="tablewrap"><table><tr><th>الثقة عند الدخول</th><th class="n">العدد</th><th class="n">نسبة النجاح الفعلية</th><th class="n">نطاق 90%</th><th class="n">التعادل</th></tr>
    ${(c.rows || []).map((r) => `<tr><td>${label(r)}</td><td class="n">${r.n}</td><td class="n ${r.n >= 30 ? (r.ci[0] >= r.be ? 'ok' : r.ci[1] < r.be ? 'bad' : '') : 'dim'}">${pct(r.wr)}</td>
      <td class="n dim">${r.n ? `${f1(r.ci[0])}–${f1(r.ci[1])}` : '–'}</td><td class="n dim">${f1(r.be)}%</td></tr>`).join('') || '<tr><td colspan="5" class="dim">لا توجد فرص منتهية بعد.</td></tr>'}</table></div>`;
}

// ── LIVE ─────────────────────────────────────────────────────────────────────
function renderLive() {
  const el = $('#view-live'), s = S.snap;
  if (!s) { el.innerHTML = '<p class="muted">جاري الاتصال بالنظام…</p>'; return; }
  const r = s.risk || {}, rc = s.cfg.risk;
  const cooldownLeft = r.lastLossAt ? Math.max(0, r.lastLossAt + rc.lossCooldownMin * 60 - s.poNow) : 0;
  const card = (k, v, sub = '') => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  const status = (p) => {
    const d = AR.decision(p, s.poNow, s.cfg);
    if (d.key === 'error') return '<span class="warn">مشكلة بيانات</span>';
    if (['enter', 'wait', 'watch', 'entered', 'ended'].includes(d.key)) {
      return `<span class="${d.verdict === 'ENTER' ? dirCls(d.dir) : d.verdict === 'WAIT' ? 'warn' : 'muted'}">${e(d.title)}${d.dir ? ` · ${dw(d.dir)}` : ''}</span>${d.timer && d.timer.sec > 0 ? ` <span class="dim">${AR.clock(d.timer.sec)}</span>` : ''}${p.opp ? `<div class="dim">${e(AR.framesText(p.opp))}${p.opp.expiry ? ` · ${e(AR.duration(p.opp.expiry.sec))}` : ''}</div>` : ''}`;
    }
    return `<span class="pill ${p.scan?.status || ''}">${{ DEEP: 'تحليل عميق', WATCH: 'متابعة', IGNORE: 'تجاهل' }[p.scan?.status] || 'تجهيز'}</span>`;
  };
  const rank = { DEEP: 0, WATCH: 1, IGNORE: 2 };
  const pairs = [...s.pairs].sort((a, b) => (rank[a.scan?.status] ?? 3) - (rank[b.scan?.status] ?? 3) || (b.scan?.score ?? 0) - (a.scan?.score ?? 0));
  const ul = (xs, cls = '') => (xs?.length ? `<ul class="ev ${cls}">${xs.slice(0, 5).map((x) => `<li>${e(x)}</li>`).join('')}</ul>` : '<span class="dim">–</span>');

  el.innerHTML = `
    <div class="grid">
      ${card('الوضع', e({ OBSERVE: 'مراقبة', PAPER: 'ورقي', ALERT: 'تنبيه', MANUAL: 'تأكيد يدوي', AUTO: 'تلقائي' }[s.cfg.execMode]), s.cfg.execMode === 'AUTO' ? `${(s.cfg.promotedProfiles || []).length} نمط معتمد` : 'لا يتم تنفيذ صفقات حقيقية')}
      ${card('التبويبات / الأزواج', `${s.tabs} / ${s.pairs.length}`, `${s.pairs.filter((p) => p.armed).length} مفعّل للتنفيذ`)}
      ${card('صفقات اليوم', `${r.trades ?? 0} / ${rc.maxTradesPerDay}`, `${r.wins ?? 0} نجاح · ${r.losses ?? 0} خسارة · ${r.ties ?? 0} تعادل · يوم ${e(r.day)} UTC`)}
      ${card('صافي اليوم (بالرهانات)', `<span class="${(r.net ?? 0) >= 0 ? 'ok' : 'bad'}">${f1(r.net, 2)}</span>`, `حد الإيقاف −${rc.dailyStopUnits}`)}
      ${card('خسائر متتالية', `${r.consecLosses ?? 0} / ${rc.maxConsecutiveLosses}`, cooldownLeft ? `استراحة ${Math.ceil(cooldownLeft / 60)} دقيقة` : 'لا توجد استراحة')}
      ${card('بانتظار النتيجة', s.pending, 'قرارات لم تُغلق شموع انتهائها بعد')}
    </div>
    ${s.manual.length ? `<h2>بانتظار تأكيدك</h2><div class="tablewrap"><table><tr><th>الزوج</th><th>الاتجاه</th><th>النموذج</th><th class="n">الثقة</th><th>ضد الفكرة</th><th class="n">ثوانٍ متبقية</th><th></th></tr>
      ${s.manual.map((m) => `<tr><td class="pairname">${e(pair(m.asset))}</td><td class="${dirCls(m.dir)}">${dw(m.dir)}</td><td>${e(m.setup)}</td><td class="n">${m.deep}</td><td>${ul(m.evidenceAgainst)}</td>
        <td class="n">${Math.max(0, Math.round(m.expiresAt - s.poNow))}</td><td><button class="primary" data-confirm="${e(m.id)}">تنفيذ</button> <button data-reject="${e(m.id)}">تجاهل</button></td></tr>`).join('')}</table></div>` : ''}
    ${calHtml(s)}
    <h2>الأزواج</h2>
    <p class="note">درجة الماسح تحدد الأزواج التي تحصل على تحليل كامل متعدد الفريمات (≥ ${s.cfg.deepThreshold}). درجة الثقة تقدير داخلي من 0 إلى 100 وليست احتمالًا — راجع الإحصائيات ← المعايرة لترى ماذا عنت فعليًا.</p>
    <div class="tablewrap"><table>
      <tr><th>الزوج</th><th>حالة السوق</th><th class="n">الماسح</th><th class="n">الثقة</th><th>الاتجاه</th><th>النموذج</th><th>الاستراتيجيات</th><th>مع الفكرة</th><th>ضد الفكرة</th><th>المخاطرة</th><th>الحالة</th></tr>
      ${pairs.map((p) => {
        const L = p.last || {}, key = `${p.tabId}|${p.asset}`;
        const row = `<tr class="click" data-exp="${e(key)}"><td><b class="pairname">${e(pair(p.asset))}</b>${p.armed ? ' <span class="pill">مفعّل</span>' : ''}<div class="dim">تبويب ${p.tabId}${p.payout ? ` · ربح ${p.payout}%` : ''}</div></td>
          <td>${rg(p.regime?.regime)}</td><td class="n">${p.scan?.score ?? '–'}</td><td class="n">${L.deep ?? '–'}</td>
          <td class="${dirCls(L.decision === 'SKIP' ? L.lean : L.decision)}">${L.decision === 'SKIP' ? (L.lean ? `(${dw(L.lean)})` : '–') : dw(L.decision)}</td>
          <td>${e(L.facts?.kind ? AR.kind(L.facts.kind) : '–')}</td><td>${ul((L.stratIds || []).map(sname))}</td>
          <td>${ul(L.facts ? AR.why(L.facts).good : [])}</td><td>${ul(L.facts ? [...(L.decision === 'SKIP' ? [AR.skipReason(L.facts)] : []), ...AR.why(L.facts).bad] : [], 'warn')}</td>
          <td>${e({ LOW: 'منخفضة', MEDIUM: 'متوسطة', HIGH: 'مرتفعة' }[L.risk] || '–')}</td><td>${status(p)}</td></tr>`;
        if (!S.expanded.has(key)) return row;
        const c = p.feed?.counts || {};
        return row + `<tr><td colspan="11"><div class="detail">الشموع: 5د ${c[300] ?? 0} · 15د ${c[900] ?? 0} · ساعة ${c[3600] ?? 0} · دقيقة ${c[60] ?? 0}${p.feed?.missing?.length ? ` · التاريخ غير متاح لـ ${p.feed.missing.map((t) => OTC.TF_LABEL[t]).join('، ')}` : ''}
جودة البيانات: ${p.feed?.dqOk === false ? 'بها مشكلة' : 'سليمة'}${p.feed?.issues?.length ? '\n  ' + p.feed.issues.map(e).join('\n  ') : ''}
مكونات الماسح: <span class="mono">${e(JSON.stringify(p.scan?.components || {}))}</span>
أسباب حالة السوق: ${e((p.regime?.reasons || []).join('؛ ') || '–')}
الفريمات: ${Object.entries(p.frames || {}).map(([tf, x]) => `${AR.frame(+tf)}: ${x.decision && x.decision !== 'SKIP' ? dw(x.decision) : x.lean ? `(${dw(x.lean)})` : '–'}${x.watch ? ` [${AR.OPP_STATE[x.watch.state]}]` : ''}`).join(' · ') || '–'}
${p.opp ? `الفرصة: ${AR.OPP_STATE[p.opp.state] || p.opp.state} ${dw(p.opp.dir)} · ${e(AR.framesText(p.opp))}${p.opp.why ? ` · ${e(AR.ENTRY_WHY[p.opp.why] || AR.endWhy(p.opp.why))}` : ''}${p.opp.expiry ? ` · المدة ${e(AR.duration(p.opp.expiry.sec))} (${e(AR.expiryWhy(p.opp.expiry))})` : ''}\n` : ''}قابلية القراءة: ${Object.entries(p.frames || {}).map(([tf, x]) => `${AR.frame(+tf)} ${x.quality ?? '–'}${x.usable ? '' : ' (غير واضح)'}${x.roles ? ` [سياق ${AR.frame(x.roles.MID)}${x.roles.TIMING ? `، تأكيد ${AR.frame(x.roles.TIMING)}` : ''}]` : ''}`).join(' · ') || '–'}${p.scanned ? ' · زوج ممسوح من التاريخ (بدون شارت)' : ''}
${p.opp?.cal ? `الثقة المعايرة: ${e(AR.calText(p.opp.cal))}${p.opp.cal.level ? ` · المجموعة: ${e(p.opp.cal.level)}${p.opp.cal.oos ? `، ${p.opp.cal.oos.wr}% خارج العينة` : ''}` : ''}${p.opp.cal.blocks?.length ? ` · ${e(AR.blockText(p.opp.cal))}` : ''}\n` : ''}آخر تحليل (${AR.frame(L.tf || 300)}): ${e(dw(L.decision))} عند ${time(L.candleTime)}${L.facts && L.decision === 'SKIP' ? ` — ${e(AR.skipReason(L.facts))}` : ''}${L.skipReasons?.length ? '\nأسباب تقنية للانتظار:\n  ' + L.skipReasons.map(e).join('\n  ') : ''}
ضد الفكرة (تقني):\n  ${(L.evidenceAgainst || []).map(e).join('\n  ') || '–'}${p.error ? `\nخطأ: ${e(p.error)}` : ''}</div></td></tr>`;
      }).join('') || '<tr><td colspan="11" class="muted">لا توجد أزواج بعد. افتح Pocket Option على زوج OTC، وكل تبويب يضيف الأزواج التي يستقبل أسعارها.</td></tr>'}
    </table></div>
    ${s.queue.length ? `<h3>قيد المفاضلة الآن</h3><p>${s.queue.map((q) => `${e(pair(q.asset))} <span class="${dirCls(q.dir)}">${dw(q.dir)}</span> ${q.deep}`).join(' · ')}</p>` : ''}
    <div class="two">
      <div><h2>الحماية</h2><div class="card">
        <div>حد الصفقات اليومي ${rc.maxTradesPerDay} · أقصى خسائر متتالية ${rc.maxConsecutiveLosses} · إيقاف يومي عند −${rc.dailyStopUnits} رهان</div>
        <div>استراحة بعد الخسارة ${rc.lossCooldownMin} دقيقة · استراحة لكل زوج ${rc.pairCooldownMin ?? (rc.pairCooldownCandles ?? 2) * 5} دقيقة · أقصى صفقات متزامنة ${rc.maxConcurrent}</div>
        <div class="dim">مفتوحة: ${(r.open || []).filter((o) => o.until > s.poNow).map((o) => `${pair(o.asset)} ${dw(o.dir)}`).join('، ') || 'لا يوجد'}</div>
        <div class="row"><button id="resetDay">تصفير عدادات اليوم</button></div></div></div>
      <div><h2>الأحداث</h2><div class="card events">${s.events.slice().reverse().map((x) => `<div class="${x.level === 'error' ? 'bad' : x.level === 'warn' ? 'warn' : ''}">${new Date(x.at).toLocaleTimeString()} — ${e(x.text)}</div>`).join('') || '<span class="dim">–</span>'}</div></div>
    </div>`;
  el.querySelectorAll('[data-exp]').forEach((tr) => tr.addEventListener('click', () => { const k = tr.dataset.exp; S.expanded.has(k) ? S.expanded.delete(k) : S.expanded.add(k); renderLive(); }));
  // pointerdown, not click: the view redraws while a countdown runs and could swallow a click
  el.querySelectorAll('[data-confirm]').forEach((b) => b.addEventListener('pointerdown', () => send({ type: 'manualConfirm', id: b.dataset.confirm })));
  el.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('pointerdown', () => send({ type: 'manualReject', id: b.dataset.reject })));
  $('#resetDay')?.addEventListener('click', () => confirm('تصفير عدد صفقات اليوم والخسائر والصافي؟') && send({ type: 'resetDay' }));
}

// ── shared filter bar ────────────────────────────────────────────────────────
function filterBar(extra = '') {
  const o = S.opt, assets = [...new Set((S.records || []).map((r) => r.asset))].sort();
  const hz = horizons();
  if (!hz.some((h) => h.N === o.expiry)) o.expiry = hz[0].N;
  return `<div class="row">
    <label>السجلات<select data-opt="frame">${FRAME_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
    <label>المصدر<select data-opt="source"><option value="all">مباشر + اختبار تاريخي</option><option value="live">مباشر فقط</option><option value="backtest">اختبار تاريخي فقط</option></select></label>
    <label>الزوج<select data-opt="asset"><option value="">كل الأزواج</option>${assets.map((a) => `<option value="${e(a)}">${e(pair(a))}</option>`).join('')}</select></label>
    <label>مدة الصفقة<select data-opt="expiry">${hz.map((h) => `<option value="${h.N}">${h.long}</option>`).join('')}</select></label>
    ${extra}
    <button id="reload">تحديث البيانات</button>
    <span class="dim">${(S.records || []).length} سجل محمّل</span></div>`;
}
function bindFilters(el) {
  el.querySelectorAll('[data-opt]').forEach((x) => {
    const k = x.dataset.opt;
    if (x.type === 'checkbox') x.checked = !!S.opt[k]; else x.value = S.opt[k];
    x.addEventListener('change', () => { S.opt[k] = x.type === 'checkbox' ? x.checked : k === 'expiry' ? +x.value : x.value; render(); });
  });
  $('#reload', el)?.addEventListener('click', async () => { await loadRecords(true); render(); });
}

const tallyCells = (r) => {
  const enough = r.n >= 30;
  const cls = r.wr == null ? '' : r.lo != null && r.be != null && r.lo >= r.be ? 'ok' : r.wr < (r.be ?? 54) ? 'bad' : 'warn';
  return `<td class="n">${r.n}</td><td class="n">${r.w}</td><td class="n">${r.l}</td><td class="n">${r.t}</td>
    <td class="n ${enough ? cls : 'dim'}">${pct(r.wr)}</td><td class="n dim">${r.n ? `${f1(r.lo)}–${f1(r.hi)}` : '–'}</td>
    <td class="n ${r.ev > 0 ? 'ok' : r.ev < 0 ? 'bad' : ''}">${f1(r.ev, 3)}</td><td class="n dim">${f1(r.be)}%</td>`;
};
const TALLY_HEAD = '<th class="n">العدد</th><th class="n">نجاح</th><th class="n">خسارة</th><th class="n">تعادل</th><th class="n">نسبة النجاح</th><th class="n">نطاق 90%</th><th class="n">العائد/صفقة</th><th class="n">التعادل</th>';

// ── DECISION LOG ─────────────────────────────────────────────────────────────
async function renderLog() {
  const el = $('#view-log');
  await loadRecords();
  const o = S.opt;
  const rows = filtered().filter((r) => o.decision === 'all' || (o.decision === 'taken' ? r.decision !== 'SKIP' : r.decision === 'SKIP'))
    .sort((a, b) => b.ts - a.ts);
  const out = (r, N) => { const x = OTC.Stats.outcome(r, r.decision !== 'SKIP' ? r.decision : r.lean, N); return x ? `<span class="${x === 'W' ? 'ok' : x === 'L' ? 'bad' : 'muted'}">${x}</span>` : '<span class="dim">·</span>'; };
  const hz = horizons(), exps = hz.map((h) => h.N);
  el.innerHTML = `<h2>سجل القرارات</h2>
    <p class="note">كل إغلاق شمعة لكل فريم بحث ولكل زوج مراقَب يُسجَّل، بما في ذلك قرارات الانتظار. الفرص تُسجَّل عند الدخول، أو عند انتهائها بدون دخول (فاتت / أُلغيت / انتهت) مع نتيجة الميل، لتعرف هل كان الانتظار صحيحًا.</p>
    ${filterBar(`<label>القرار<select data-opt="decision"><option value="all">الكل</option><option value="taken">شراء/بيع فقط</option><option value="skip">انتظار فقط</option></select></label>`)}
    <div class="row"><button id="csv">تصدير CSV</button><button id="json">تصدير JSON</button><button id="delBt" class="danger">حذف سجلات الاختبار التاريخي</button></div>
    <div class="tablewrap"><table><tr><th>الوقت (UTC)</th><th>الزوج</th><th>المصدر</th><th>القرار</th><th>النموذج</th><th>حالة السوق</th><th class="n">الماسح</th><th class="n">الثقة</th>${hz.map((h) => `<th class="n">${h.label}</th>`).join('')}${S.opt.frame === 'opp' ? '<th>الحالة</th><th>المدة</th>' : ''}<th>التنفيذ</th></tr>
    ${rows.slice(0, 400).map((r) => `<tr class="click" data-id="${e(r.id)}"><td>${time(r.candleTime)}</td><td class="pairname">${e(pair(r.asset))}</td><td class="dim">${r.source === 'live' ? 'مباشر' : 'تاريخي'}</td>
      <td class="${dirCls(r.decision === 'SKIP' ? null : r.decision)}">${dw(r.decision)}${r.decision === 'SKIP' && r.lean ? ` <span class="dim">(${dw(r.lean)})</span>` : ''}${r.engineDecision ? ` <span class="warn" title="قرار المحرك ${dw(r.engineDecision)} واستبعدته الحماية">حماية</span>` : ''}</td>
      <td>${e(sname(r.setup))}</td><td>${rg(r.regime)}</td><td class="n">${r.scanner?.score ?? '–'}</td><td class="n">${r.deep ?? '–'}</td>
      ${exps.map((x) => `<td class="n">${out(r, x)}</td>`).join('')}${r.kind === 'opp' ? `<td>${e(AR.OPP_STATE[r.state] || r.state)}${r.cal ? ` <span class="${r.cal.qualified ? 'ok' : 'dim'}">${r.cal.measured ? `${Math.round(r.cal.p)}%` : 'لم تُقَس'}${r.cal.blocks?.length ? ` · ${e(AR.blockText(r.cal))}` : ''}</span>` : ''}${r.why ? ` <span class="dim">${e(AR.ENTRY_WHY[r.why] || AR.endWhy(r.why))}</span>` : ''}</td><td>${r.expirySec ? `${e(AR.duration(r.expirySec))} ${out(r, r.expirySec / (r.tf || 60))}` : '–'}</td>` : ''}<td>${e(r.exec ? `${{ paper: 'ورقي', alert: 'تنبيه', manual: 'يدوي', auto: 'تلقائي', none: '—', 'risk-skip': 'استبعاد', 'awaiting-confirmation': 'بانتظار التأكيد' }[r.exec.action] || r.exec.action}${r.exec.result ? ` ← ${{ W: 'نجاح', L: 'خسارة', T: 'تعادل' }[r.exec.result]}` : ''}` : '')}</td></tr>
      ${S.logSel === r.id ? `<tr><td colspan="${11 + exps.length}">${recordDetail(r)}</td></tr>` : ''}`).join('')}
    </table></div>${rows.length > 400 ? `<p class="dim">يُعرض 400 من ${rows.length}. صدّر الملف لرؤية الباقي.</p>` : ''}`;
  bindFilters(el);
  el.querySelectorAll('[data-id]').forEach((tr) => tr.addEventListener('click', () => { S.logSel = S.logSel === tr.dataset.id ? null : tr.dataset.id; renderLog(); }));
  $('#csv').onclick = () => download(`otc-decisions-${Date.now()}.csv`, toCsv(rows), 'text/csv');
  $('#json').onclick = () => download(`otc-decisions-${Date.now()}.json`, JSON.stringify(rows), 'application/json');
  $('#delBt').onclick = async () => {
    if (!confirm('حذف كل سجلات الاختبار التاريخي؟ السجلات المباشرة تبقى.')) return;
    await DB.deleteWhere('records', 'source', 'backtest');
    await loadRecords(true); renderLog();
  };
}

function recordDetail(r) {
  const li = (xs) => (xs?.length ? xs.map((x) => `• ${e(x)}`).join('\n') : '–');
  const mods = Object.entries(r.modules || {}).map(([k, m]) => `${k}: ${m[0]} ${m[1]}`).join(' · ');
  const strats = (r.strategies || []).map((s) => `${sname(s[0])} — ${dw(s[1])} ${s[2]}${s[3] ? '' : ' (غير نشطة)'}`).join('\n');
  const w = r.facts ? AR.why(r.facts) : null;
  return `<div class="two"><div class="detail">${dw(r.decision)}${r.lean && r.decision === 'SKIP' ? ` (الميل ${dw(r.lean)})` : ''} · الثقة ${r.deep} · ${e(AR.regime(r.regime))}
${w ? `\nلماذا:\n${li([...w.good.map((x) => `✓ ${x}`), ...w.bad.map((x) => `⚠ ${x}`)])}\n` : ''}${r.facts ? `السبب الرئيسي للانتظار: ${e(r.decision === 'SKIP' ? AR.skipReason(r.facts) : '—')}\n` : ''}
سعر الدخول <span class="mono">${r.entryPrice}</span> · الخروج <span class="mono">${e(JSON.stringify(r.exits))}</span>${r.timing ? ` · بعد ${r.timing.elapsed} ث من بداية الشمعة، تحرك ${r.timing.move} ATR` : ''}
${r.skipReasons?.length ? `\nأسباب تقنية للانتظار:\n${li(r.skipReasons)}` : ''}
\nمع الفكرة (تقني):\n${li(r.evidenceFor)}\n\nضد الفكرة (تقني):\n${li(r.evidenceAgainst)}\n\nملاحظات المخاطرة:\n${li(r.riskFlags)}
\nالوحدات: <span class="mono">${e(mods)}</span>\nمكونات الدرجة: <span class="mono">${e(JSON.stringify(r.components || {}))}</span>${r.exec ? `\nالتنفيذ: <span class="mono">${e(JSON.stringify(r.exec))}</span>` : ''}</div>
<div><div class="detail">الاستراتيجيات التي ظهرت:\n${e(strats) || '–'}\n\nالمؤشرات: <span class="mono">${e(JSON.stringify(r.ind || {}))}</span></div>${r.snapshot ? candleSvg(r.snapshot, r.entryPrice) : ''}</div></div>`;
}

function candleSvg(rows, mark) {
  const W = 420, H = 150, n = rows.length, hi = Math.max(...rows.map((x) => x[2])), lo = Math.min(...rows.map((x) => x[3]));
  const y = (p) => 8 + ((hi - p) / (hi - lo || 1)) * (H - 16), cw = W / n;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="آخر 30 شمعة 5 دقائق" style="direction:ltr">${rows.map((x, i) => {
    const up = x[4] >= x[1], col = up ? 'var(--call)' : 'var(--put)', cx = i * cw + cw / 2;
    return `<line x1="${cx}" x2="${cx}" y1="${y(x[2])}" y2="${y(x[3])}" stroke="${col}"/><rect x="${cx - cw * 0.3}" y="${y(Math.max(x[1], x[4]))}" width="${cw * 0.6}" height="${Math.max(1, Math.abs(y(x[1]) - y(x[4])))}" fill="${col}"/>`;
  }).join('')}${mark ? `<line x1="0" x2="${W}" y1="${y(mark)}" y2="${y(mark)}" stroke="var(--accent)" stroke-dasharray="3 3"/>` : ''}</svg>`;
}

function toCsv(rows) {
  const cols = ['id', 'source', 'asset', 'candleTime', 'decision', 'engineDecision', 'lean', 'setup', 'combo', 'regime', 'scanner', 'deep', 'payout', 'entryPrice', 'exits',
    'rsi', 'macdHist', 'adx', 'pctB', 'fibDepth', 'distSup', 'distRes', 't5', 't15', 't60', 'signal', 'evidenceFor', 'evidenceAgainst', 'skipReasons', 'riskFlags', 'exec'];
  const val = (r, c) => {
    if (c === 'candleTime') return new Date(r.candleTime * 1000).toISOString();
    if (c === 'scanner') return r.scanner?.score;
    if (r.ind && c in r.ind) return r.ind[c];
    const v = r[c];
    return Array.isArray(v) ? v.join(' | ') : v && typeof v === 'object' ? JSON.stringify(v) : v;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => JSON.stringify(val(r, c) ?? '')).join(','))].join('\n');
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ── STATISTICS ───────────────────────────────────────────────────────────────
async function renderStats() {
  const el = $('#view-stats');
  await loadRecords();
  const o = S.opt, recs = filtered().filter((r) => r.status === 'resolved' || Object.keys(r.exits || {}).length);
  const opt = { basis: o.basis, expiry: o.expiry, nonOverlap: o.nonOverlap };
  const all = OTC.Stats.by(recs, 'all', opt)[0];
  const eq = OTC.Stats.equity(recs, { expiry: o.expiry });
  const skipRate = recs.length ? (100 * recs.filter((r) => r.decision === 'SKIP').length) / recs.length : null;
  const card = (k, v, s = '') => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const table = (title, dim, note = '') => {
    const rows = OTC.Stats.by(recs, dim, opt).filter((r) => r.key != null);
    if (dim === 'score' || dim === 'scanner') rows.sort((a, b) => parseFloat(a.key) - parseFloat(b.key));
    return `<h3>${title}</h3>${note ? `<p class="note">${note}</p>` : ''}<div class="tablewrap"><table><tr><th>${title}</th>${TALLY_HEAD}</tr>
      ${rows.slice(0, 40).map((r) => `<tr><td>${e(dim === 'pair' ? pair(r.key) : dim === 'setup' ? sname(r.key) : dim === 'regime' ? AR.regime(r.key) : dim === 'decision' ? { taken: 'منفَّذة', skipped: 'مستبعدة' }[r.key] : dim === 'combination' ? String(r.key).split('+').map(sname).join(' + ') : dim === 'module' ? MODULE_AR[r.key] || r.key : r.key)}</td>${tallyCells(r)}</tr>`).join('') || '<tr><td colspan="9" class="dim">لا توجد بيانات</td></tr>'}</table></div>`;
  };
  const corr = OTC.Stats.moduleCorrelation(recs);
  el.innerHTML = `<h2>الإحصائيات</h2>
    <p class="note">محسوبة فقط من النتائج المسجلة. نسب النجاح الرمادية مبنية على أقل من 30 صفقة ولا يُعتمد عليها. "نطاق 90%" هو فاصل ويلسون: النسبة الحقيقية قد تكون في أي مكان داخله. النموذج لا يتغلب على نسبة الربح إلا إذا كان حده الأدنى فوق نقطة التعادل. ${o.nonOverlap ? 'الصفقات المتداخلة في نفس المجموعة تُحسب مرة واحدة.' : '<span class="warn">حساب التداخل مُلغى: الصفقات المتتالية تتشارك نفس حركة السعر فتبدو العينة أكبر من حقيقتها.</span>'}</p>
    ${filterBar(`<label>الأساس<select data-opt="basis"><option value="taken">القرارات المنفذة (شراء/بيع)</option><option value="lean">كل ميل بما فيه الانتظار</option></select></label>
      <label style="display:flex;gap:4px;align-items:center"><input type="checkbox" data-opt="nonOverlap"> بدون تداخل</label>`)}
    <div class="grid">
      ${card('الصفقات', all?.n ?? 0, `${all?.t ?? 0} تعادل · ${recs.length} سجل`)}
      ${card('نسبة النجاح', pct(all?.wr), all?.n ? `نطاق 90%: ${f1(all.lo)}–${f1(all.hi)}%` : 'لا توجد صفقات')}
      ${card('نقطة التعادل', `${f1(all?.be)}%`, 'من نسب الربح المسجلة')}
      ${card('العائد لكل صفقة', `<span class="${(all?.ev ?? 0) > 0 ? 'ok' : 'bad'}">${f1(all?.ev, 3)}</span>`, 'بالرهان، والتعادل = 0')}
      ${card('نسبة الانتظار', pct(skipRate), S.opt.frame === 'opp' ? 'من الفرص' : `من إغلاقات شموع ${AR.frame(+S.opt.frame)}`)}
      ${card('أقصى تراجع', f1(eq.maxDrawdown, 2), `بالرهان · الصافي ${f1(eq.net, 2)}`)}
      ${card('أطول سلسلة خسائر', eq.maxLossStreak, `أطول سلسلة نجاح ${eq.maxWinStreak}`)}
    </div>
    ${eq.curve.length > 1 ? equitySvg(eq.curve) : ''}
    ${o.basis === 'taken' && !(all?.n) ? '<p class="note warn">لا توجد صفقات منفذة بعد. اختر الأساس "كل ميل بما فيه الانتظار" لدراسة ما كان المحرك يميل إليه.</p>' : ''}
    <div class="two"><div>${table('المنفذة مقابل المستبعدة', 'decision', 'اتجاه ميل القرارات المستبعدة مقابل الصفقات المنفذة. إذا نجح ميل المستبعدة بنفس القدر، فالفلاتر لا تضيف شيئًا.')}</div>
      <div>${table('المعايرة — درجة الثقة', 'score', 'ما حققته كل فئة درجات فعليًا. الدرجة ليست احتمالًا حتى يثبت هذا الجدول ذلك.')}</div></div>
    <div class="two"><div>${table('الزوج', 'pair')}</div><div>${table('حالة السوق', 'regime')}</div></div>
    <div class="two"><div>${table('النموذج', 'setup')}</div><div>${table('تركيبة الاستراتيجيات', 'combination')}</div></div>
    <div class="two"><div>${table('الساعة', 'hour')}</div><div>${table('الجلسة', 'session')}</div></div>
    <div class="two"><div>${table('درجة الماسح', 'scanner')}</div><div>${table('وحدات الأدلة (عند تصويتها)', 'module', 'كم مرة كان تصويت كل وحدة صحيحًا، بغض النظر عن القرار النهائي.')}</div></div>
    <h3>ارتباط تصويت الوحدات</h3><p class="note">1.0 تعني أنها تصوّت دائمًا بنفس الاتجاه. الوحدات شديدة الارتباط ليست تأكيدات مستقلة، لذلك يجمعها محرك التوافق في مجموعات.</p>
    <div class="tablewrap"><table><tr><th></th>${corr.modules.map((m) => `<th class="n">${e(MODULE_AR[m] || m)}</th>`).join('')}</tr>
      ${corr.modules.map((a, i) => `<tr><td>${e(MODULE_AR[a] || a)}</td>${corr.matrix[i].map((v, j) => `<td class="n ${i !== j && v != null && Math.abs(v) >= 0.5 ? 'warn' : 'dim'}">${v == null ? '–' : v.toFixed(2)}</td>`).join('')}</tr>`).join('')}</table></div>`;
  bindFilters(el);
}

function equitySvg(curve) {
  const W = 900, H = 160, xs = curve.map((c) => c[0]), ys = curve.map((c) => c[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(0, ...ys), y1 = Math.max(0, ...ys);
  const X = (v) => 30 + ((v - x0) / (x1 - x0 || 1)) * (W - 40), Y = (v) => 10 + ((y1 - v) / (y1 - y0 || 1)) * (H - 25);
  return `<h3>منحنى الرصيد (بالرهان)</h3><div class="card"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="منحنى الرصيد" style="direction:ltr">
    <line x1="30" x2="${W - 10}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--line)"/><text x="2" y="${Y(0) + 3}">0</text>
    <text x="2" y="${Y(y1) + 3}">${y1.toFixed(1)}</text><text x="2" y="${Y(y0) + 3}">${y0.toFixed(1)}</text>
    <polyline fill="none" stroke="var(--accent)" stroke-width="1.5" points="${curve.map((c) => `${X(c[0]).toFixed(1)},${Y(c[1]).toFixed(1)}`).join(' ')}"/></svg></div>`;
}

// ── STRATEGY MATRIX ──────────────────────────────────────────────────────────
async function renderMatrix() {
  const el = $('#view-matrix');
  await loadRecords();
  const cfg = S.snap?.cfg || OTC.DEFAULT_CONFIG;
  const recs = filtered();
  const m = OTC.Stats.strategyMatrix(recs, cfg, { expiry: S.opt.expiry, basis: S.opt.matrixBasis });
  const fired = new Set(m.map((r) => r.strategy));
  const never = OTC.Strategies.list().filter((s) => !fired.has(s.id));
  const best = (b, fmt) => (b ? `${e(fmt(b.key))} <span class="dim">${pct(b.wr)} من ${b.n}</span>` : '<span class="dim">–</span>');
  el.innerHTML = `<h2>مصفوفة أداء الاستراتيجيات</h2>
    <p class="note">كل استراتيجية تُقيَّم على اتجاهها في كل مرة ظهرت فيها، سواء نُفذت أم لا. أعمدة "الأفضل" تحتاج 30 صفقة على الأقل وتختار أعلى حد أدنى، أي أنها مختارة بعد الحدث — تأكد منها في صفحة التحقق قبل الاعتماد عليها. الثبات = نسبة النجاح في 4 فترات زمنية متتالية؛ التذبذب الكبير يعني أن النتيجة تعتمد على توقيت النظر.</p>
    ${filterBar(`<label>العد<select data-opt="matrixBasis"><option value="fired">كل مرة ظهرت</option><option value="active">فقط عندما تكون نشطة</option></select></label>`)}
    <div class="tablewrap"><table><tr><th>الاستراتيجية</th><th>العائلة</th>${TALLY_HEAD}<th>أفضل حالة سوق</th><th>أفضل زوج</th><th>أفضل مدة</th><th>الثبات (4 فترات)</th></tr>
      ${m.map((r) => `<tr><td>${e(sname(r.strategy))}</td><td class="dim">${e(FAMILY_AR[r.family] || r.family)}</td>${tallyCells(r)}
        <td>${best(r.bestRegime, AR.regime)}</td><td>${best(r.bestPair, pair)}</td><td>${r.bestExpiry ? `${horizons().find((h) => h.N === r.bestExpiry.expiry)?.label || r.bestExpiry.expiry} <span class="dim">${pct(r.bestExpiry.wr)} من ${r.bestExpiry.n}</span>` : '<span class="dim">–</span>'}</td>
        <td class="dim">${r.foldWr.map((x) => (x == null ? '·' : x.toFixed(0))).join(' / ')}${r.stabilitySd != null ? ` (انحراف ${r.stabilitySd.toFixed(1)})` : ''}</td></tr>`).join('') || '<tr><td colspan="14" class="dim">لا توجد سجلات بنتائج بعد.</td></tr>'}
    </table></div>
    ${never.length ? `<p class="note">لم تظهر أبدًا في هذه البيانات (${never.length}): ${never.map((s) => e(sname(s.id))).join('، ')}</p>` : ''}`;
  bindFilters(el);
}

// ── VALIDATION ───────────────────────────────────────────────────────────────
async function renderValidation() {
  const el = $('#view-validation');
  await loadRecords();
  const cfg = S.snap?.cfg || OTC.DEFAULT_CONFIG, v = cfg.validation;
  const res = OTC.Stats.discoverProfiles(filtered(), cfg);
  const promoted = new Set(cfg.promotedProfiles || []);
  const counts = {};
  for (const r of res.results) counts[r.status] = (counts[r.status] || 0) + 1;
  const cell = (x) => (x ? `${x.n} · ${pct(x.wr)}` : '<span class="dim">–</span>');
  const name = (key) => key.split('|')[0].split('+').map(sname).join(' + ');
  const VST = { VALIDATED: 'تم التحقق', UNSTABLE: 'غير مستقر', CANDIDATE: 'مرشح', FAILED_VALIDATION: 'فشل التحقق', REJECTED: 'مرفوض' };
  const shown = res.results.filter((r) => S.opt.showRejected || r.status !== 'REJECTED').slice(0, 300);
  el.innerHTML = `<h2>التحقق خارج العينة وملفات النماذج</h2>
    <p class="note">تُقسَّم السجلات زمنيًا: أقدم ${v.split[0] * 100}% للتدريب، ثم ${v.split[1] * 100}% للتحقق، وأحدث ${v.split[2] * 100}% خارج العينة. الملف (استراتيجية أو زوج استراتيجيات + حالة سوق + مدة) يجب أن يتجاوز نقطة التعادل في التدريب بحد أدنى ${v.zTrain} انحراف معياري (${v.minTrain} صفقة على الأقل)، ثم يصمد على بيانات التحقق وخارج العينة التي لم يرها (${v.minHoldout} صفقة لكل منهما على الأقل)، ويبقى فوق التعادل في 75% على الأقل من فترات التدريب.
    لا يُعتمد أي شيء تلقائيًا، والاعتماد لا يؤثر إلا في التنفيذ التلقائي.</p>
    ${filterBar()}
    <div class="grid">
      <div class="card"><div class="k">السجلات</div><div class="v">${res.sizes.train + res.sizes.validation + res.sizes.oos}</div><div class="s">تدريب ${res.sizes.train} · تحقق ${res.sizes.validation} · خارج العينة ${res.sizes.oos}</div></div>
      <div class="card"><div class="k">الملفات المختبرة</div><div class="v">${res.tested}</div><div class="s">بها ${v.minTrain} صفقة تدريب على الأقل</div></div>
      <div class="card"><div class="k">نجاحات بالصدفة متوقعة</div><div class="v">${res.expectedFalseCandidates}</div><div class="s">عدد ما سينجح في التدريب بالصدفة لو لم يكن هناك أي أفضلية</div></div>
      <div class="card"><div class="k">تم التحقق</div><div class="v">${counts.VALIDATED || 0}</div><div class="s">${Object.entries(counts).map(([k, n]) => `${VST[k] || k} ${n}`).join(' · ')}</div></div>
    </div>
    ${res.bounds.trainEnd ? `<p class="dim">التدريب حتى ${time(res.bounds.trainEnd)} · التحقق حتى ${time(res.bounds.validationEnd)} · وما بعده خارج العينة.</p>` : ''}
    <div class="row"><label style="display:flex;gap:4px;align-items:center"><input type="checkbox" data-opt="showRejected"> إظهار المرفوض</label></div>
    <div class="tablewrap"><table><tr><th>الملف</th><th>حالة السوق</th><th>المدة</th><th>الحالة</th><th class="n">تدريب: العدد · النجاح</th><th class="n">الحد الأدنى للتدريب</th><th class="n">التحقق</th><th class="n">خارج العينة</th><th>الفترات</th><th>السبب</th><th></th></tr>
      ${shown.map((r) => `<tr><td>${e(name(r.key))}</td><td>${e(AR.regime(r.key.split('|')[1]))}</td><td>${e(horizons().find((h) => h.N === r.expiry)?.label || `${r.expiry}`)}</td><td><span class="pill ${r.status}">${VST[r.status] || r.status}</span></td>
        <td class="n">${cell(r.train)}</td><td class="n">${f1(r.train.lo)}% <span class="dim">مقابل ${f1(r.be)}%</span></td><td class="n">${cell(r.validation)}</td><td class="n">${cell(r.oos)}</td>
        <td class="dim">${(r.folds || []).map((x) => (x == null ? '·' : x.toFixed(0))).join('/')}</td><td class="dim mono">${e(r.why)}</td>
        <td>${promoted.has(r.profile) ? `<button data-demote="${e(r.profile)}">إلغاء الاعتماد</button>` : r.status === 'VALIDATED' ? `<button class="primary" data-promote="${e(r.profile)}">اعتماد</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="11" class="dim">لا يوجد ملف بعدد صفقات تدريب كافٍ بعد. جمّع بيانات تاريخية أكثر، أو اترك المحرك الحي يجمع البيانات.</td></tr>'}
    </table></div>
    <h3>الملفات المعتمدة</h3>
    ${(cfg.promotedProfiles || []).length ? `<div class="tablewrap"><table><tr><th>الملف</th><th class="n">مباشر منذ الاعتماد</th><th></th></tr>${cfg.promotedProfiles.map((p) => {
      const f = S.snap?.forward?.[p]; const n = f ? f.w + f.l : 0;
      return `<tr><td class="mono">${e(p)}</td><td class="n">${n ? `${f.w}/${n} (${pct((100 * f.w) / n)})` : '0'}</td><td><button data-demote="${e(p)}">إلغاء الاعتماد</button></td></tr>`;
    }).join('')}</table></div><p class="note">يُلغى اعتماد الملف تلقائيًا إذا هبط أداؤه الحي تحت نقطة التعادل بعد 30 صفقة.</p>` : '<p class="dim">لا يوجد.</p>'}`;
  bindFilters(el);
  el.querySelectorAll('[data-promote]').forEach((b) => b.addEventListener('click', () => {
    if (confirm(`اعتماد ${b.dataset.promote}؟\n\nفي التنفيذ التلقائي ستنفّذ التبويبات المفعّلة صفقات حقيقية لهذا النموذج. نجاح التحقق السابق لا يضمن النتائج المستقبلية.`)) send({ type: 'promote', profile: b.dataset.promote });
  }));
  el.querySelectorAll('[data-demote]').forEach((b) => b.addEventListener('click', () => send({ type: 'demote', profile: b.dataset.demote })));
}

// ── RESEARCH ─────────────────────────────────────────────────────────────────
const historyJobs = new Map(); // reqId → { asset, resolve }
function onHistoryMsg(m) {
  const j = historyJobs.get(m.reqId);
  if (m.type === 'historyProgress') researchLog(`${pair(m.asset)}: ${m.count} شمعة حتى ${time(m.oldest)}`);
  if (m.type === 'historyDone') {
    researchLog(`${pair(m.asset)}: اكتمل التحميل، ${m.count} شمعة${m.error ? ` — ${m.error === 'no Pocket Option tab connected' ? 'لا يوجد تبويب Pocket Option متصل' : m.error}` : ''}`);
    if (j) { historyJobs.delete(m.reqId); j.resolve(m.count); }
  }
}
function researchLog(t) { S.research.log.push(`${new Date().toLocaleTimeString()} ${t}`); const x = $('#rlog'); if (x) { x.textContent = S.research.log.slice(-40).join('\n'); x.scrollTop = 1e9; } }

async function renderResearch() {
  const el = $('#view-research');
  const candles = await DB.all('candles');
  const byAsset = {};
  for (const c of candles) (byAsset[c.asset] ||= []).push(c);
  const known = [...new Set([...Object.keys(byAsset), ...(S.snap?.pairs || []).map((p) => p.asset)])].sort();
  el.innerHTML = `<h2>البيانات التاريخية</h2>
    <p class="note">1) حمّل تاريخ شموع 5 دقائق عبر أي تبويب Pocket Option مفتوح (يمكنه تحميل أي زوج OTC، لا الزوج المعروض فقط). 2) أعد تشغيله عبر نفس مسار التحليل الحي لإنشاء سجلات اختبار تاريخي. الاختبار التاريخي يفترض الدخول عند إغلاق الشمعة ولا يحاكي توقيت الدخول ولا تأكيد الدقيقة ولا إشارات المنصة — اعتبر نتائجه متفائلة.</p>
    <div class="row">
      <label>الزوج (مثل EURUSD_otc)<input id="rAsset" list="assetList" dir="ltr" value="${e(known[0] || 'EURUSD_otc')}"><datalist id="assetList">${known.map((a) => `<option value="${e(a)}">`).join('')}</datalist></label>
      <label>عدد الساعات<input id="rHours" type="number" min="6" max="720" value="168"></label>
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="rM1"> تحميل شموع الدقيقة أيضًا (أبطأ، ويتيح شروط الدقيقة في الاكتشاف)</label>
      <label>فريم الاختبار<select id="rTf"><option value="60">دقيقة</option><option value="300" selected>5 دقائق</option><option value="900">15 دقيقة</option></select></label>
      <label>نسبة الربح للاختبار %<input id="rPayout" type="number" min="1" max="100" value="${e((S.snap?.pairs || []).find((p) => p.payout)?.payout || 85)}"></label>
      <button id="rFetch">تحميل التاريخ</button><button id="rRun" class="primary">تشغيل الاختبار التاريخي</button><button id="rAll">تحميل واختبار كل الأزواج</button>
    </div>
    <pre id="rlog" class="detail" style="max-height:180px;overflow:auto;direction:rtl;text-align:right">${e(S.research.log.slice(-40).join('\n'))}</pre>
    <h3>شموع 5 دقائق المخزنة</h3>
    <div class="tablewrap"><table><tr><th>الزوج</th><th class="n">الشموع</th><th>من</th><th>إلى</th><th class="n">فجوات</th><th class="n">ارتباط العوائد</th><th class="n">ارتباط اللون</th><th>نفس اللون بعد سلسلة طولها k (1…6)</th><th class="n">استمرار بعد شمعة كبيرة</th><th class="n">الجسم/المدى</th></tr>
      ${Object.entries(byAsset).map(([a, cs]) => {
        cs.sort((x, y) => x.time - y.time);
        const gaps = cs.reduce((n, c, i) => n + (i && c.time - cs[i - 1].time !== 300 ? 1 : 0), 0);
        const R = OTC.Stats.candleResearch(cs);
        return `<tr><td class="pairname">${e(pair(a))}</td><td class="n">${cs.length}</td><td>${time(cs[0].time)}</td><td>${time(cs[cs.length - 1].time)}</td><td class="n">${gaps}</td>
          <td class="n">${R ? f1(R.returnAutocorr, 3) : '–'}</td><td class="n">${R ? f1(R.colorAutocorr, 3) : '–'}</td>
          <td class="dim">${R ? R.sameColorAfterRun.sort((x, y) => x.run - y.run).map((x) => `${x.run}: ${x.pSame.toFixed(0)}% <span title="95% CI ${f1(x.lo)}–${f1(x.hi)}">(${x.n})</span>`).join(' · ') : '–'}</td>
          <td class="n">${R?.bigCandle.n ? `${f1(R.bigCandle.continued)}% من ${R.bigCandle.n}` : '–'}</td><td class="n">${R ? f1(R.bodyRatio, 2) : '–'}</td></tr>`;
      }).join('') || '<tr><td colspan="10" class="dim">لا توجد شموع مخزنة بعد.</td></tr>'}
    </table></div>
    <p class="note">سلوك OTC كما تقيسه هذه الشموع، دون تفسيرات. ارتباط قريب من 0 = لا ذاكرة؛ سالب = يميل للانعكاس؛ موجب = يميل للاستمرار. نسبة "نفس اللون" قرب 50% تعني أن السلاسل لا تتنبأ بشيء؛ راجع حجم العينة قبل أي استنتاج.</p>`;
  const asset = () => $('#rAsset').value.trim();
  const rtf = () => +$('#rTf').value;
  const fetchFor = async (a) => { await fetchHist(a, +$('#rHours').value); if ($('#rM1').checked || rtf() === 60) await fetchHist(a, Math.min(+$('#rHours').value, 72), 60); };
  $('#rFetch').onclick = () => fetchFor(asset());
  $('#rRun').onclick = () => runReplay(asset(), +$('#rPayout').value, rtf()).then(renderResearch);
  $('#rAll').onclick = async () => {
    for (const a of known) { await fetchFor(a); await runReplay(a, +$('#rPayout').value, rtf()); }
    renderResearch();
  };
}

function fetchHist(asset, hours, tf = 300) {
  if (!S.port) return researchLog('غير متصل بالنظام');
  const reqId = `dash-${Date.now()}-${asset}`;
  researchLog(`${pair(asset)}: طلب ${hours} ساعة من شموع ${tf === 60 ? 'الدقيقة' : '5 دقائق'}…`);
  return new Promise((resolve) => {
    historyJobs.set(reqId, { asset, resolve });
    send({ type: 'fetchHistory', reqId, asset, hours, tf });
    setTimeout(() => { if (historyJobs.delete(reqId)) { researchLog(`${pair(asset)}: لم يرد التبويب`); resolve(0); } }, Math.max(60000, hours * (tf === 60 ? 10000 : 2000)));
  });
}

// Candles of a setup frame: 1M and 5M are stored; 15M is built from 5M.
async function candlesOf(asset, tf) {
  if (tf === 60) return DB.candlesFor(asset, 60);
  const c5 = await DB.candlesFor(asset);
  return tf === 300 ? c5 : OTC.U.aggregate(c5, 300, tf);
}

async function runReplay(asset, payout, tf = 300) {
  if (S.research.busy) return researchLog('يوجد اختبار تاريخي قيد التشغيل');
  const cs = await candlesOf(asset, tf);
  if (cs.length < 500) return researchLog(`${pair(asset)}: ${cs.length} شمعة ${AR.frame(tf)} فقط — حمّل تاريخًا أطول أولًا`);
  S.research.busy = true;
  try {
    const cfg = S.snap?.cfg || OTC.DEFAULT_CONFIG;
    researchLog(`${pair(asset)}: اختبار ${cs.length} شمعة…`);
    let lastPct = -1;
    const recs = await OTC.Replay.replay(cs, { asset, payout, cfg, tf, onProgress: (p) => {
      const pc = Math.floor((100 * p.done) / p.total / 10) * 10;
      if (pc !== lastPct) { lastPct = pc; researchLog(`${pair(asset)}: ${pc}% (${p.records} سجل)`); }
    } });
    await DB.deleteWhere('records', 'asset', asset, (r) => r.source === 'backtest' && (r.tf || 300) === tf);
    await DB.putMany('records', recs);
    const taken = recs.filter((r) => r.decision !== 'SKIP').length;
    researchLog(`${pair(asset)}: حُفظ ${recs.length} سجل على فريم ${AR.frame(tf)} (${taken} شراء/بيع، ${recs.length - taken} انتظار) — اختر «تحليلات فريم ${AR.frame(tf)}» في الإحصائيات`);
    await loadRecords(true);
    send({ type: 'refreshPerf' });
  } finally { S.research.busy = false; }
}

// ── DISCOVERY ────────────────────────────────────────────────────────────────
const DISC_GROUPS = {
  live: ['PAPER_TEST', 'WATCHLIST', 'PROMOTED'], waiting: ['VALIDATING', 'OUT_OF_SAMPLE'],
  failed: ['REJECTED', 'OVERFIT', 'UNSTABLE', 'DECAYING', 'SUSPENDED', 'INSUFFICIENT_DATA'],
};
S.disc = { worker: null, running: false, log: [], sel: null, status: 'live', type: 'all', q: '', auto: false, autoHours: 6, lastRunAt: 0 };
const discLog = (t) => { S.disc.log.push(`${new Date().toLocaleTimeString()} ${t}`); const x = $('#dlog'); if (x) { x.textContent = S.disc.log.slice(-60).join('\n'); x.scrollTop = 1e9; } };
const sres = (r) => (r && r.n ? `${pct(r.wr)} <span class="dim">من ${r.n}</span>` : '<span class="dim">–</span>');
const DST = (st) => AR.DISC_STATUS[st]?.text || st;
const ROBUST = { HIGH: 'مرتفعة', MEDIUM: 'متوسطة', LOW: 'منخفضة', 'N/A': 'لا تنطبق' };
const CROSS = { PAIR_SPECIFIC: 'زوج واحد', CROSS_PAIR: 'عدة أزواج', MULTI_PAIR_STABLE: 'ثابت عبر الأزواج', SINGLE_PAIR_DATA: 'بيانات زوج واحد', NO_PAIR_WORKS: 'لا يعمل' };
const STAB = { STABLE: 'ثابت', DECAYING: 'يتراجع', IMPROVING: 'يتحسن', UNSTABLE: 'غير مستقر', WEAK: 'ضعيف', UNKNOWN: 'غير معروف' };
const SCLASS = { INSUFFICIENT: 'غير كافية', PRELIMINARY: 'أولية', RESEARCH: 'بحثية', STRONGER: 'أقوى' };

async function renderDiscovery() {
  const el = $('#view-discovery');
  const [rows, runs, candles] = await Promise.all([DB.all('strategies'), DB.all('discovery_runs'), DB.all('candles')]);
  const latest = OTC.Lifecycle.latest(rows);
  const counts = {};
  for (const c of candles) counts[c.asset] = (counts[c.asset] || 0) + 1;
  const assets = Object.keys(counts).sort();
  S.disc.assets ||= new Set(assets);
  const run = runs.sort((a, b) => b.at - a.at)[0];
  const rep = run?.report;
  const D = S.disc, dc = S.snap?.cfg?.discovery || OTC.DEFAULT_CONFIG.discovery;
  const shown = latest.filter((r) => (D.status === 'all' || (DISC_GROUPS[D.status] || [D.status]).includes(r.status))
    && (D.type === 'all' || r.type === D.type) && (!D.q || `${r.strategy_id} ${r.name}`.toLowerCase().includes(D.q.toLowerCase())))
    .sort((a, b) => (DISC_GROUPS.live.indexOf(b.status) - DISC_GROUPS.live.indexOf(a.status)) || ((b.rank ?? -1e9) - (a.rank ?? -1e9)));
  const byStatus = {};
  for (const r of latest) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const card = (k, v, s = '') => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const pw = rep?.processWalkForward;
  const repMsg = !rep ? '' : rep.nothingFound
    ? `لم يجتز أي نمط كل مراحل الاختبار في هذه الدورة${rep.counts?.validatedFilters ? ` (اجتاز ${rep.counts.validatedFilters} فلتر تجنّب)` : ''}. هذه نتيجة طبيعية، ولم تُخفَّض المعايير لإنتاج نمط.`
    : `اجتاز ${rep.counts.validated} نمط في ${rep.counts.validatedClusters ?? 0} مجموعة مستقلة كل مراحل الاختبار التاريخي، وتحتاج الآن تأكيدًا ورقيًا حيًا. لا يُعتمد أي نمط تلقائيًا.`;
  el.innerHTML = `<h2>اكتشاف الاستراتيجيات</h2>
    <p class="note">يبحث في التاريخ المخزن عن ظروف تلتها نتائج غير معتادة، ثم يحاول بجدية إسقاط كل اكتشاف: التحقق مع ضبط الاكتشافات الزائفة، وبيانات خارج العينة لم يرها، والاختبار المتقدم زمنيًا، وتحريك العتبات، وأزواج وفترات أخرى — وأخيرًا التداول الورقي الحي. الاكتشاف فرضية حتى يصمد أمام كل ذلك. "لم يُعثر على شيء" نتيجة صحيحة.</p>
    <div class="card">
      <div class="row"><span class="muted">الأزواج (شموع 5 دقائق مخزنة):</span><div class="chips">${assets.map((a) => `<label><input type="checkbox" data-asset="${e(a)}" ${D.assets.has(a) ? 'checked' : ''}> <span class="pairname">${e(pair(a))}</span> <span class="dim">${counts[a]}</span></label>`).join('') || '<span class="warn">لا توجد شموع مخزنة — حمّل التاريخ من صفحة البيانات أولًا.</span>'}</div></div>
      <div class="row">
        <label>نسبة الربح الافتراضية %<input id="dPayout" type="number" min="1" max="100" value="${e((S.snap?.pairs || []).find((p) => p.payout)?.payout || 85)}"></label>
        <label>أقصى عدد شروط<input id="dMaxC" type="number" min="1" max="6" value="${dc.maxConditions}"></label>
        <label>عرض البحث<input id="dBeam" type="number" min="5" max="100" value="${dc.beamWidth}"></label>
        <label>الحد الزمني (ث)<input id="dBudget" type="number" min="30" max="1800" value="${dc.timeBudgetSec}"></label>
        <label>فريم البحث<select id="dTf"><option value="60" ${S.disc.tf === 60 ? 'selected' : ''}>دقيقة</option><option value="300" ${(S.disc.tf ?? 300) === 300 ? 'selected' : ''}>5 دقائق</option><option value="900" ${S.disc.tf === 900 ? 'selected' : ''}>15 دقيقة</option></select></label>
        <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="dM1"> استخدام شموع الدقيقة المخزنة</label>
        <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="dPWF" ${dc.processWalkForward ? 'checked' : ''}> اختبار طريقة البحث نفسها زمنيًا</label>
        <button class="primary" id="dRun" ${D.running ? 'disabled' : ''}>تشغيل دورة اكتشاف</button><button id="dStop" ${D.running ? '' : 'disabled'}>إيقاف</button>
        <button id="dLife">تحديث النتائج الورقية</button>
      </div>
      <div class="row"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="dAuto" ${D.auto ? 'checked' : ''}> تشغيل تلقائي كل</label>
        <input id="dAutoH" type="number" min="1" max="72" value="${D.autoHours}" style="width:60px"> <span class="muted">ساعة طالما هذه الصفحة مفتوحة</span></div>
      <pre id="dlog" class="detail" style="max-height:140px;overflow:auto;direction:rtl;text-align:right">${e(D.log.slice(-60).join('\n'))}</pre>
    </div>
    ${rep ? `<h2>آخر دورة — ${new Date(rep.at).toLocaleString('ar-EG-u-nu-latn')}</h2>
      <p class="${rep.nothingFound ? 'warn' : 'ok'}"><b>${e(rep.counts?.candidates != null ? repMsg : 'بيانات غير كافية لتشغيل دورة.')}</b></p>
      <div class="grid">
        ${card('البيانات', rep.rows ?? 0, `${(rep.assets || []).map(pair).join('، ')}`)}
        ${card('شروط تم تقييمها', (rep.evaluations || 0).toLocaleString('ar-EG-u-nu-latn'), `${rep.atoms || 0} شرط أساسي · ${Math.round((rep.ms || 0) / 1000)} ث${rep.budgetHit ? ' · بلغ الحد الزمني' : ''}`)}
        ${card('المرشحون', rep.counts?.candidates ?? 0, `حُذف ${rep.counts?.duplicatesDropped ?? 0} مكرر · ${rep.counts?.filters ?? 0} فلتر`)}
        ${card('اجتاز كل المراحل', rep.counts?.validated ?? 0, `${rep.counts?.validatedClusters ?? 0} مجموعة مستقلة · المعتمد 0`)}
        ${card('مرفوض / مطابق للماضي', `${rep.counts?.rejected ?? 0} / ${rep.counts?.overfit ?? 0}`, `${rep.counts?.unstable ?? 0} غير مستقر أو يتراجع`)}
        ${card('يحتاج بيانات أكثر', rep.counts?.needMoreData ?? 0, 'غير كافٍ أو بانتظار صفقات تحقق أو خارج العينة')}
      </div>
      ${pw ? `<div class="card" style="margin-top:12px"><b>هل طريقة البحث نفسها تعمل؟</b> <span class="${pw.wr >= pw.be ? 'ok' : 'bad'}">${pw.n ? `الأنماط التي وُجدت على بيانات سابقة نجحت في ${pct(pw.wr)} من ${pw.n} صفقة في الفترة التالية (التعادل ${pct(pw.be)})${pw.wr >= pw.be ? '.' : ' — ما يجده البحث لم يصمد.'}` : 'لم يجد البحث ما يمكن اختباره في الفترات التالية.'}</span>
        <div class="dim">لكل فترة: ${(pw.perFold || []).map((f) => `${time(f.from).slice(0, 5)}: ${f.rules} نمط ← ${f.n ? `${f.wr.toFixed(1)}% من ${f.n}` : 'لا صفقات'}`).join(' · ')}</div></div>` : ''}
      <p class="note">ضبط الاكتشافات الزائفة: وصل ${rep.fdr?.tested ?? 0} نمط إلى مرحلة التحقق؛ ومن بين الناجحين عند q ≤ ${rep.fdr?.q} يُتوقع أن يكون نحو ${rep.fdr?.expectedFalseAmongPassing ?? 0} زائفًا. ${rep.oosReuse ? `<span class="warn">فترة خارج العينة هذه تتداخل مع ${rep.oosReuse} دورة سابقة، فلم تعد غير مرئية بالكامل.</span>` : ''}</p>
      ${rep.top?.length ? `<h3>أبرز المرشحين للبحث (مرتبون حسب قوة الدليل والثبات والبساطة — لا نسبة النجاح وحدها)</h3><div class="tablewrap"><table><tr><th>المعرّف</th><th>النمط</th><th>الحالة</th><th class="n">العينة</th><th>لماذا يستحق المتابعة</th></tr>
        ${rep.top.map((t) => { const row = latest.find((x) => x.strategy_id === t.id); return `<tr class="click" data-sid="${e(t.id)}"><td class="mono">${e(t.id)}</td><td>${e(row ? AR.discName(row) : t.name)}</td><td><span class="pill ${t.status}">${e(DST(t.status))}</span></td><td class="n">${t.sample} <span class="dim">${e(SCLASS[t.sampleClass] || '')}</span></td><td class="dim">${row ? `${sres(row.out_of_sample_results?.n ? row.out_of_sample_results : row.validation_results)} · متانة ${e(ROBUST[row.robustness?.label] || '–')} · ثابت في ${Math.round((row.pass_ratio || 0) * 100)}% من الفترات` : ''}</td></tr>`; }).join('')}</table></div>` : ''}` : '<p class="muted">لم تُشغَّل أي دورة اكتشاف بعد.</p>'}
    <h2>الأنماط المكتشفة</h2>
    <div class="row">
      <label>عرض<select id="dStatus">${[['live', 'قيد الاختبار / تم التحقق / معتمد'], ['waiting', 'بانتظار بيانات'], ['failed', 'مرفوض / متوقف'], ['all', 'الكل'],
        ...Object.keys(byStatus).map((k) => [k, DST(k)])].map(([v, l]) => `<option value="${v}" ${D.status === v ? 'selected' : ''}>${e(l)}${byStatus[v] ? ` (${byStatus[v]})` : ''}</option>`).join('')}</select></label>
      <label>النوع<select id="dType"><option value="all">الكل</option><option value="STRATEGY" ${D.type === 'STRATEGY' ? 'selected' : ''}>أنماط</option><option value="FILTER" ${D.type === 'FILTER' ? 'selected' : ''}>فلاتر تجنّب</option></select></label>
      <label>بحث<input id="dQ" value="${e(D.q)}" placeholder="معرّف أو شرط"></label>
      <span class="dim">${latest.length} نمط · ${rows.length} نسخة مخزنة</span>
    </div>
    <div class="tablewrap"><table><tr><th>المعرّف</th><th>النمط</th><th>الحالة</th><th class="n">العينة</th><th>حالة السوق</th><th class="n">المدة</th><th class="n">التحقق</th><th class="n">خارج العينة</th><th class="n">تقدّم زمني</th><th>المتانة</th><th class="n">التعقيد</th><th>الأزواج</th><th>الثبات</th><th class="n">ورقي</th></tr>
      ${shown.slice(0, 300).map((r) => `<tr class="click" data-sid="${e(r.strategy_id)}"><td class="mono">${e(r.strategy_id)}${r.type === 'FILTER' ? ' <span class="pill">فلتر</span>' : ''}</td>
        <td>${e(AR.discName(r))}</td><td><span class="pill ${r.status}">${e(DST(r.status))}</span></td>
        <td class="n">${r.sample_size} <span class="dim">${e(SCLASS[r.sample_class] || '')}</span></td>
        <td class="dim">${e((r.regime || r.regimes_covered || []).map(AR.regime).join('، ') || 'أي حالة')}</td><td class="n">${(r.expiry * (r.tf || 300)) / 60}د${r.tf && r.tf !== 300 ? ` <span class="dim">${e(AR.frame(r.tf))}</span>` : ''}</td>
        <td class="n">${sres(r.validation_results)}</td><td class="n">${sres(r.out_of_sample_results)}</td>
        <td class="n">${r.walk_forward ? sres(r.walk_forward) : '–'}</td><td>${e(ROBUST[r.robustness?.label] || '–')}</td><td class="n">${r.complexity ?? '–'}</td>
        <td class="dim">${e(CROSS[r.cross_pair] || '')}</td><td class="dim">${e(STAB[r.stability] || '')}</td>
        <td class="n">${sres(r.paper_results)}</td></tr>
        ${D.sel === r.strategy_id ? `<tr><td colspan="14">${strategyDetail(r, rows.filter((x) => x.strategy_id === r.strategy_id))}</td></tr>` : ''}`).join('') || '<tr><td colspan="14" class="dim">لا شيء في هذا العرض.</td></tr>'}
    </table></div>
    ${clusterSummary(latest)}
    <h3>الدورات</h3><div class="tablewrap"><table><tr><th>الدورة</th><th>الوقت</th><th class="n">الصفوف</th><th>البيانات</th><th class="n">المرشحون</th><th class="n">اجتاز</th><th>اختبار طريقة البحث</th><th class="n">المدة</th></tr>
      ${runs.slice(0, 20).map((x) => `<tr><td class="mono">${e(x.id)}</td><td>${new Date(x.at).toLocaleString('ar-EG-u-nu-latn')}</td><td class="n">${x.report?.rows ?? '–'}</td>
        <td class="dim mono">${e(x.dataset?.hash || '')} ${e((x.dataset?.assets || []).join(','))}</td><td class="n">${x.report?.counts?.candidates ?? '–'}</td><td class="n">${x.report?.counts?.validated ?? '–'}</td>
        <td>${x.report?.processWalkForward?.wr != null ? `${x.report.processWalkForward.wr.toFixed(1)}% من ${x.report.processWalkForward.n}` : '–'}</td><td class="n">${Math.round((x.report?.ms || 0) / 1000)} ث</td></tr>`).join('') || '<tr><td colspan="8" class="dim">لا يوجد</td></tr>'}</table></div>`;

  el.querySelectorAll('[data-asset]').forEach((x) => x.addEventListener('change', () => { x.checked ? D.assets.add(x.dataset.asset) : D.assets.delete(x.dataset.asset); }));
  el.querySelectorAll('[data-sid]').forEach((tr) => tr.addEventListener('click', () => { D.sel = D.sel === tr.dataset.sid ? null : tr.dataset.sid; if (D.sel) D.status = 'all'; renderDiscovery(); }));
  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const [act, id] = b.dataset.act.split(':');
    if (act === 'promote' && !confirm(`اعتماد ${id} ضمن الاستراتيجيات المستخدمة؟\n\nسيشارك في القرارات الحية، وفي التنفيذ التلقائي ستتداول به التبويبات المفعّلة. نتائج التحقق والاختبار الورقي لا تضمن المستقبل.`)) return;
    send({ type: { promote: 'discPromote', suspend: 'discSuspend', resume: 'discResume' }[act], id });
    setTimeout(renderDiscovery, 600);
  }));
  $('#dStatus').onchange = (ev) => { D.status = ev.target.value; renderDiscovery(); };
  $('#dType').onchange = (ev) => { D.type = ev.target.value; renderDiscovery(); };
  $('#dQ').onchange = (ev) => { D.q = ev.target.value; renderDiscovery(); };
  $('#dRun').onclick = () => runDiscovery();
  $('#dStop').onclick = () => { D.worker?.postMessage({ type: 'stop' }); discLog('جاري الإيقاف…'); };
  $('#dLife').onclick = () => { send({ type: 'discRefresh' }); discLog('طُلب تحديث النتائج الورقية'); setTimeout(renderDiscovery, 1500); };
  $('#dAuto').onchange = (ev) => { D.auto = ev.target.checked; };
  $('#dAutoH').onchange = (ev) => { D.autoHours = Math.max(1, +ev.target.value || 6); };
}

function runDiscovery() {
  const D = S.disc;
  if (D.running) return;
  const assets = [...D.assets];
  if (!assets.length) return discLog('اختر زوجًا واحدًا على الأقل');
  const base = S.snap?.cfg || OTC.DEFAULT_CONFIG;
  const cfg = OTC.U.mergeConfig(S.snap?.overrides || {}, { discovery: {
    maxConditions: Math.min(6, Math.max(1, +($('#dMaxC')?.value || base.discovery.maxConditions))),
    beamWidth: +($('#dBeam')?.value || base.discovery.beamWidth), timeBudgetSec: +($('#dBudget')?.value || base.discovery.timeBudgetSec),
    processWalkForward: $('#dPWF') ? $('#dPWF').checked : true } });
  const payouts = {};
  for (const p of S.snap?.pairs || []) if (p.payout) payouts[p.asset] = p.payout;
  D.running = true; D.lastRunAt = Date.now();
  D.worker ||= new Worker('../discovery-worker.js');
  D.worker.onmessage = ({ data: m }) => {
    const STAGE = { load: 'تحميل', dataset: 'بناء البيانات', atoms: 'تجهيز الشروط', search: 'البحث', combinations: 'دمج الاستراتيجيات', variations: 'تعديلات الاستراتيجيات',
      mutations: 'تعديل الأنماط السابقة', simplify: 'التبسيط', filters: 'فلاتر التجنّب', assess: 'التقييم', negatives: 'شروط التجنّب', 'process walk-forward': 'اختبار طريقة البحث' };
    if (m.type === 'progress') discLog(m.stage === 'load' ? m.text.replace(/(\d+) 5M/, '$1 شمعة 5د').replace(/(\d+) 1M/, '$1 شمعة دقيقة').replace(' candles', '') : `${STAGE[m.stage] || m.stage}${m.done != null ? ` ${m.done}/${m.total ?? m.candidates ?? ''}` : ''}${m.dir ? ` ${dw(m.dir)} ${(m.N * (D.tf || 300)) / 60}د` : ''}${m.rows != null ? ` · ${m.rows} صف` : ''}`);
    else if (m.type === 'done') { D.running = false; discLog(m.report.nothingFound ? 'انتهت الدورة — لم يجتز أي نمط كل المراحل.' : `انتهت الدورة — اجتاز ${m.report.counts.validated} نمط كل المراحل التاريخية.`); send({ type: 'discRefresh' }); renderDiscovery(); }
    else if (m.type === 'stopped') { D.running = false; discLog('أُوقفت — لم يُحفظ شيء'); renderDiscovery(); }
    else if (m.type === 'error') { D.running = false; discLog(`خطأ: ${m.error.split('\n')[0]}`); console.error(m.error); renderDiscovery(); }
  };
  discLog(`بدء دورة على ${assets.length} زوج…`);
  D.tf = +($('#dTf')?.value || 300);
  D.worker.postMessage({ type: 'run', assets, cfg, payouts, defaultPayout: +($('#dPayout')?.value || 85), useM1: !!$('#dM1')?.checked, tf: D.tf });
  renderDiscovery();
}
setInterval(() => { const D = S.disc; if (D.auto && !D.running && Date.now() - D.lastRunAt > D.autoHours * 3600 * 1000) runDiscovery(); }, 60 * 1000);

function clusterSummary(latest) {
  const alive = latest.filter((r) => r.cluster && r.type === 'STRATEGY' && !DISC_GROUPS.failed.includes(r.status));
  if (!alive.length) return '';
  const by = new Map();
  for (const r of alive) { if (!by.has(r.cluster)) by.set(r.cluster, []); by.get(r.cluster).push(r); }
  return `<h3>مجموعات مترابطة</h3><p class="note">الأنماط التي تظهر في نفس الصفقات تقريبًا (φ ≥ 0.5) تشكل مجموعة واحدة؛ هي فكرة واحدة، والتصويت الحي يحسب كل مجموعة مرة واحدة.</p>
    <div class="tablewrap"><table><tr><th>المجموعة</th><th class="n">الأعضاء</th><th>أقوى عضو</th></tr>
    ${[...by.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20).map(([k, xs]) => { const top = xs.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))[0]; return `<tr class="click" data-sid="${e(top.strategy_id)}"><td class="mono">${e(k)}</td><td class="n">${xs.length}</td><td>${e(top.strategy_id)} — ${e(AR.discName(top))}</td></tr>`; }).join('')}</table></div>`;
}

function strategyDetail(r, versions) {
  const res = (label, x, extra = '') => `<tr><td>${label}</td><td class="n">${x?.n ?? '–'}</td><td class="n">${x?.w ?? '–'}</td><td class="n">${x?.l ?? '–'}</td><td class="n">${pct(x?.wr)}</td><td class="n dim">${x?.n ? `${f1(x.lo)}–${f1(x.hi)}` : '–'}</td><td class="n">${f1(x?.ev, 3)}</td><td class="n dim">${f1(x?.be)}%</td><td class="dim">${extra}</td></tr>`;
  const bd = (title, rows, fmtKey = (k) => k) => (rows?.length ? `<h3>${title}</h3><table><tr><th></th><th class="n">العدد</th><th class="n">النجاح</th><th class="n">التعادل</th></tr>${rows.slice(0, 12).map((x) => `<tr><td>${e(fmtKey(x.key))}</td><td class="n">${x.n}</td><td class="n ${x.wr >= x.be ? 'ok' : 'bad'}">${pct(x.wr)}</td><td class="n dim">${f1(x.be)}%</td></tr>`).join('')}</table>` : '');
  const ex = AR.discExplain(r), st = AR.DISC_STATUS[r.status];
  const actions = [r.status === 'WATCHLIST' ? `<button class="primary" data-act="promote:${e(r.strategy_id)}">اعتماد</button>` : '',
    !['SUSPENDED', 'REJECTED', 'OVERFIT', 'INSUFFICIENT_DATA'].includes(r.status) ? `<button data-act="suspend:${e(r.strategy_id)}">إيقاف</button>` : '',
    ['SUSPENDED', 'WATCHLIST', 'DECAYING', 'OUT_OF_SAMPLE', 'VALIDATING'].includes(r.status) ? `<button data-act="resume:${e(r.strategy_id)}">إعادة الاختبار الورقي</button>` : ''].join(' ');
  const cond = (x) => (x.atom ? (x.kind === 'negative' ? `تجنّب: ${AR.condLabel(x.atom)}` : AR.condLabel(x.atom)) : x.condition || x.why);
  return `<div class="detail" style="white-space:normal">
    <div class="row">${actions}<span>${e(st?.note || '')}</span></div>
    <p class="dim mono" style="margin:2px 0">${e(r.status_reason || '')}</p>
    <p style="white-space:pre-line;margin:8px 0">${e(ex.text)}</p>
    <div class="two"><div>
      <h3>الشروط (${dw(r.direction)}، مدة ${(r.expiry * (r.tf || 300)) / 60} دقيقة على فريم ${AR.frame(r.tf || 300)}${r.pairs ? `، فقط ${r.pairs.map(pair).join('، ')}` : ''})</h3>
      <ul class="ev">${ex.conditions.map((c) => `<li>${e(c)}</li>`).join('')}${ex.negatives.map((c) => `<li class="warn">تجنّب: ${e(c)}</li>`).join('')}</ul>
      <h3>النتائج</h3><table><tr><th></th><th class="n">العدد</th><th class="n">نجاح</th><th class="n">خسارة</th><th class="n">النجاح</th><th class="n">نطاق 90%</th><th class="n">العائد</th><th class="n">التعادل</th><th></th></tr>
        ${res('التدريب', r.training_results, `عينة ${SCLASS[r.sample_class] || ''}؛ تُرك ${r.training_results?.skipped ?? 0} متداخل؛ أسوأ سلسلة ${r.training_results?.maxConsecLoss ?? '–'} خسائر؛ أقصى تراجع ${r.training_results?.maxDrawdown ?? '–'}`)}
        ${res('التحقق', r.validation_results, r.validation_results?.q != null ? `q = ${r.validation_results.q.toFixed(3)}` : '')}
        ${res('خارج العينة', r.out_of_sample_results)}
        ${r.walk_forward ? res('تقدّم زمني', r.walk_forward, `استمر في ${r.walk_forward.selections}/${r.walk_forward.folds} مراحل`) : ''}
        ${res('ورقي (حي)', r.paper_results, r.paper_results?.recent ? `آخر ${r.paper_results.recent.n}: ${pct(r.paper_results.recent.wr)}` : '')}
        ${r.mirror ? res(`النسخة المعاكسة (${dw(r.direction === 'CALL' ? 'PUT' : 'CALL')})`, r.mirror, 'نفس النمط في الاتجاه الآخر') : ''}
        ${r.type === 'FILTER' && r.complement ? res('باقي الصفقات (تدريب)', r.complement.train, `z = ${r.z?.train?.toFixed(1)}`) : ''}
      </table>
      ${r.periods ? `<h3>الفترات (تدريب + تحقق)</h3><p>${r.periods.map((p) => (p.n ? `${p.wr.toFixed(0)}% (${p.n})` : '·')).join('  ')} ← ${e(STAB[r.stability] || '')}</p>` : ''}
      ${r.importance?.length ? `<h3>مساهمة كل شرط</h3><table><tr><th>الشرط</th><th class="n">ما يُفقد من الحد الأدنى بدونه</th><th class="n">النجاح بدونه</th></tr>${r.importance.map((x) => `<tr><td>${e(cond(x))}</td><td class="n ${x.low ? 'dim' : ''}">${x.drop.toFixed(1)} نقطة${x.low ? ' (ضعيفة)' : ''}</td><td class="n">${pct(x.wrWithout)} <span class="dim">من ${x.nWithout}</span></td></tr>`).join('')}</table>` : ''}
      ${r.robustness?.neighbors?.length ? `<h3>المتانة: ${e(ROBUST[r.robustness.label] || r.robustness.label)} (${Math.round(r.robustness.score * 100)}% من العتبات المحرّكة صمدت)</h3><table>${r.robustness.neighbors.map((x) => `<tr><td>${e(cond(x))}</td><td class="n">${pct(x.wr)} <span class="dim">من ${x.n}</span></td><td class="${x.pass ? 'ok' : 'bad'}">${x.pass ? 'صمد' : 'انهار'}</td></tr>`).join('')}</table>` : `<p class="dim">المتانة: ${e(ROBUST[r.robustness?.label] || '–')}${r.robustness?.label === 'N/A' ? ' — لا توجد عتبات رقمية لتحريكها' : ''}</p>`}
    </div><div>
      ${bd('حسب حالة السوق', r.regime_breakdown, AR.regime)}${bd('حسب الزوج', r.pair_breakdown, pair)}${bd('حسب المدة', r.expiry_breakdown, (k) => `${(Number(String(k).slice(1)) * (r.tf || 300)) / 60} دقيقة`)}${bd('حسب الجلسة', r.session_breakdown, (k) => AR.featName && ({ Asia: 'آسيا', London: 'لندن', 'London/NY': 'لندن/نيويورك', 'New York': 'نيويورك', Late: 'متأخرة' }[k] || k))}${bd('حسب ثقة المحرك', r.score_breakdown)}
      ${r.similar_library?.length ? `<p class="dim">يتداخل مع استراتيجيات موجودة: ${r.similar_library.map((x) => `${e(sname(x.strategy))} φ ${x.phi}`).join('، ')}</p>` : ''}
      <h3>القيود</h3><ul class="ev">${AR.discLimitations(r).map((x) => `<li>${e(x)}</li>`).join('')}</ul>
      <h3>سجل النسخ</h3><table><tr><th class="n">نسخة</th><th>الحالة</th><th>السبب</th><th>الوقت</th></tr>${versions.sort((a, b) => b.version - a.version || b.updated_at - a.updated_at).map((v) => `<tr><td class="n">${v.version}</td><td><span class="pill ${v.status}">${e(DST(v.status))}</span></td><td class="dim mono">${e(v.status_reason || '')}</td><td class="dim">${new Date(v.updated_at).toLocaleString('ar-EG-u-nu-latn')}</td></tr>`).join('')}</table>
      <p class="dim">المصدر: ${e(AR.ORIGIN[r.origin] || r.origin)}${r.parent ? ` من ${e(r.parent)}` : ''}. المجموعة ${e(r.cluster || '–')}. الترتيب ${r.rank ?? '–'}. القاعدة الدقيقة: <span class="mono">${e(r.ruleKey)}</span></p>
    </div></div></div>`;
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────
function renderSettings() {
  const el = $('#view-settings'), s = S.snap;
  if (!s) { el.innerHTML = '<p class="muted">جاري الاتصال…</p>'; return; }
  S.settingsDrawn = true;
  const c = s.cfg;
  const num = (path, label, step = 1) => {
    const v = path.split('.').reduce((o, k) => o?.[k], c);
    return `<label>${label}<input type="number" step="${step}" data-path="${path}" value="${v}"></label>`;
  };
  el.innerHTML = `<h2>الإعدادات المتقدمة</h2>
    <p class="note">كل رقم هنا افتراض مبدئي. غيّر شيئًا واحدًا في كل مرة وقارن في الإحصائيات؛ ضبط إعدادات كثيرة على نفس البيانات هو الطريق إلى مطابقة الماضي فقط.</p>
    <h3>عتبات القرار</h3><div class="row">
      ${num('watchThreshold', 'الماسح: متابعة ≥')}${num('deepThreshold', 'الماسح: تحليل عميق ≥')}${num('minDeepConfidence', 'أدنى ثقة للقرار')}${num('minStrategyScore', 'أدنى درجة للاستراتيجية')}
      ${num('entryWindowSec', 'نافذة الدخول (ث)')}${num('maxChaseAtr', 'أقصى مطاردة (ATR)', 0.05)}${num('maxAdverseAtr', 'أقصى حركة عكسية (ATR)', 0.05)}${num('opposingLevelAtr', 'منع المستوى المعاكس (ATR)', 0.05)}
      ${num('paperExpiry', 'مدة الصفقة (شموع 5د)')}</div>
    <h3>الحماية</h3><div class="row">
      ${num('risk.maxTradesPerDay', 'حد الصفقات اليومي')}${num('risk.maxConsecutiveLosses', 'أقصى خسائر متتالية')}${num('risk.dailyStopUnits', 'الإيقاف اليومي (رهانات)', 0.5)}
      ${num('risk.lossCooldownMin', 'استراحة بعد الخسارة (د)')}${num('risk.pairCooldownMin', 'استراحة الزوج (د)')}${num('risk.maxConcurrent', 'أقصى صفقات متزامنة')}</div>
    <h3>أوزان التوافق (%)</h3><div class="row">${Object.keys(c.weights).map((k) => num(`weights.${k}`, MODULE_AR[k] || k)).join('')}</div>
    <h3>التحقق</h3><div class="row">${num('validation.minTrain', 'أدنى صفقات تدريب')}${num('validation.minHoldout', 'أدنى صفقات اختبار')}${num('validation.zTrain', 'معامل التدريب z', 0.05)}${num('validation.zHoldout', 'معامل الاختبار z', 0.05)}</div>
    <div class="row"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="requireHTF" ${c.requireHTF ? 'checked' : ''}> اشتراط بيانات 15 دقيقة وساعة (وإلا انتظار)</label>
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="researchDeepAll" ${c.researchDeepAll ? 'checked' : ''}> تحليل عميق لكل زوج لأغراض البحث (القرار ما زال يشترط درجة الماسح)</label></div>
    <div class="row"><button class="primary" id="saveCfg">حفظ</button><button id="resetCfg">استعادة الافتراضي</button></div>
    <h3>متقدم: التعديلات بصيغة JSON</h3>
    <textarea id="cfgJson">${e(JSON.stringify(s.overrides, null, 2))}</textarea>
    <div class="row"><button id="saveJson">حفظ JSON</button></div>
    <h3>القيم الافتراضية</h3><pre class="detail" style="max-height:300px;overflow:auto">${e(JSON.stringify(OTC.DEFAULT_CONFIG, null, 2))}</pre>`;
  $('#saveCfg').onclick = () => {
    const patch = {};
    el.querySelectorAll('[data-path]').forEach((i) => {
      const keys = i.dataset.path.split('.'), v = Number(i.value);
      if (!Number.isFinite(v)) return;
      let o = patch;
      keys.slice(0, -1).forEach((k) => (o = o[k] ||= {}));
      o[keys[keys.length - 1]] = v;
    });
    patch.requireHTF = $('#requireHTF').checked;
    patch.researchDeepAll = $('#researchDeepAll').checked;
    send({ type: 'setConfig', patch });
    S.settingsDrawn = false;
  };
  $('#resetCfg').onclick = () => { if (confirm('استعادة كل الإعدادات الافتراضية؟ (يُلغى اعتماد الملفات أيضًا)')) { send({ type: 'resetConfig' }); S.settingsDrawn = false; } };
  $('#saveJson').onclick = () => {
    try { const patch = JSON.parse($('#cfgJson').value); send({ type: 'setConfig', patch }); S.settingsDrawn = false; }
    catch (err) { alert(`صيغة JSON غير صحيحة: ${err.message}`); }
  };
}

// Deep link from the popup: dashboard/index.html#discovery
const startView = location.hash.slice(1);
if (startView && document.querySelector(`#nav [data-view="${startView}"]`)) document.querySelector(`#nav [data-view="${startView}"]`).click();
connect();
render();
// Snapshots redraw the live view when something changes; the 1s tick only drives confirmation countdowns.
setInterval(() => { if (S.view === 'live' && S.snap?.manual.length) renderLive(); }, 1000);
