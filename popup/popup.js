// مراقب OTC — the main interface. Shows what is happening, why, what to do and
// whether there is risk. Everything technical stays behind "التفاصيل الفنية" or the
// advanced dashboard.
const $ = (s, el = document) => el.querySelector(s);
const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Clean line icons (no emoji).
const I = {
  home: '<path d="M4 11 12 4l8 7"/><path d="M6 10v9h12v-9"/>',
  pairs: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  history: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  research: '<path d="M10 4v6L5 19h14l-5-9V4"/><path d="M9 4h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  power: '<path d="M12 4v8"/><path d="M7 7a7 7 0 1 0 10 0"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
  alert: '<path d="M12 4 3 19h18z"/><path d="M12 10v4M12 17h0"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 1.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chev: '<path d="m14 6-6 6 6 6"/>',
  pulse: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
  open: '<path d="M14 5h5v5M19 5l-8 8M18 14v5H5V6h5"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true">${I[n]}</svg>`;

const S = { snap: null, port: null, tab: 'home', prefs: { theme: 'dark', size: 'normal', advanced: false }, sheet: null, records: null, strategies: null, recordsAt: 0, seenOpp: null };

// ── connection to the service worker ────────────────────────────────────────
function connect() {
  try { S.port = chrome.runtime.connect({ name: 'intel-dash' }); } catch (_) { return; }
  S.port.onMessage.addListener((m) => { if (m.type === 'snapshot') { S.snap = m; render(); } });
  S.port.onDisconnect.addListener(() => { S.port = null; setTimeout(connect, 1000); });
}
const send = (m) => S.port?.postMessage(m);
const now = () => S.snap?.poNow ?? Date.now() / 1000;
const openAdvanced = (hash = '') => chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard/index.html${hash}`) });

// ── preferences (local to this browser) ────────────────────────────────────
async function loadPrefs() {
  try { const r = await chrome.storage.local.get('uiPrefs'); Object.assign(S.prefs, r.uiPrefs || {}); } catch (_) {}
  applyPrefs();
}
function setPref(k, v) { S.prefs[k] = v; applyPrefs(); try { chrome.storage.local.set({ uiPrefs: S.prefs }); } catch (_) {} render(); }
function applyPrefs() { document.documentElement.dataset.theme = S.prefs.theme; document.documentElement.dataset.size = S.prefs.size; }

// ── confirmation dialog ─────────────────────────────────────────────────────
function ask(title, text, okLabel = 'تأكيد') {
  return new Promise((resolve) => {
    $('#modalTitle').textContent = title; $('#modalText').textContent = text; $('#modalOk').textContent = okLabel;
    $('#modal').classList.remove('hidden');
    const done = (v) => { $('#modal').classList.add('hidden'); $('#modalOk').onclick = $('#modalCancel').onclick = null; resolve(v); };
    $('#modalOk').onclick = () => done(true);
    $('#modalCancel').onclick = () => done(false);
    $('#modalOk').focus();
  });
}

// ── derived state ───────────────────────────────────────────────────────────
function pairsWithStatus() {
  const s = S.snap;
  if (!s) return [];
  return s.pairs.map((p) => ({ p, st: AR.pairStatus(p, s.poNow) }))
    .sort((a, b) => AR.RANK[a.st.key] - AR.RANK[b.st.key] || (b.p.opp?.confidence ?? b.p.last?.facts?.conf ?? 0) - (a.p.opp?.confidence ?? a.p.last?.facts?.conf ?? 0));
}
function systemState() {
  const s = S.snap;
  if (!s) return { cls: '', text: 'جاري الاتصال…' };
  if (s.risk?.emergency) return { cls: 'off', text: 'النظام متوقف' };
  if (!s.tabs) return { cls: 'warn', text: 'لا يوجد اتصال بالمنصة' };
  return { cls: 'on', text: 'يعمل' };
}

function statusPill(st) {
  const cls = st.tone === 'go' ? `go ${st.dir || ''}` : st.tone === 'wait' ? 'wait' : st.tone === 'warn' ? 'warn' : '';
  return `<span class="status ${cls}"><span class="dot"></span>${e(st.label)}</span>`;
}

// ── views ───────────────────────────────────────────────────────────────────
function render() {
  const s = S.snap, sys = systemState();
  $('#sys').className = `sys ${sys.cls}`;
  $('#sys .txt').textContent = sys.text;
  const stopped = !!s?.risk?.emergency;
  $('#power').innerHTML = `${icon('power')}<span>${stopped ? 'تشغيل النظام' : 'إيقاف النظام'}</span>`;
  $('#power').classList.toggle('stopped', stopped);
  const bar = $('#bar');
  const ex = s?.lastExec && Date.now() - s.lastExec.at < 120000 ? AR.execState(s.lastExec) : null;
  const legacy = (s?.tabsInfo || []).find((t) => t.engine === 'legacy' && t.running);
  if (ex) { bar.className = `bar ${ex.tone === 'bad' ? 'bad' : ''}`; bar.textContent = `${AR.pair(s.lastExec.asset)} · ${AR.dir(s.lastExec.dir)} — ${ex.text}`; }
  else if (legacy) { bar.className = 'bar'; bar.textContent = `تبويب ${AR.pair(legacy.chartAsset)} يتداول بالبوت القديم (شموع 15 ثانية)، وقراراته لا تظهر هنا.`; }
  else if (s?.cfg?.execMode === 'AUTO' && !stopped) { bar.className = 'bar'; bar.textContent = 'التنفيذ التلقائي مفعّل'; }
  else bar.className = 'bar hidden';
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  const views = { home: viewHome, pairs: viewPairs, history: viewHistory, research: viewResearch, settings: viewSettings };
  Promise.resolve(views[S.tab]()).then((html) => { if (html != null) { $('#view').innerHTML = html; bind(); } });
  if (S.sheet) renderSheet();
}

function viewHome() {
  const s = S.snap;
  if (!s) return `<div class="card calm">${icon('pulse')}<h2>جاري الاتصال بالنظام</h2></div>`;
  if (s.risk?.emergency) {
    return `<div class="card calm enter">${icon('power')}<h2>النظام متوقف</h2><p>لن يتم تنفيذ أو اقتراح أي صفقة حتى تعيد التشغيل.</p>
      <div class="actions"><button class="btn primary" data-act="resume">تشغيل النظام</button></div></div>`;
  }
  if (!s.tabs) {
    return `<div class="card calm">${icon('pulse')}<h2>لا توجد أزواج متصلة</h2><p>افتح Pocket Option على أزواج OTC، ويمكن ترك التبويبات في الخلفية.</p></div>`;
  }
  const list = pairsWithStatus();
  const manual = s.manual || [];
  // Open trades first: they are what is actually happening right now.
  const open = (s.tabsInfo || []).flatMap((t) => t.openTrades || []);
  let html = open.map((o) => {
    const left = Math.max(0, Math.round((o.openedAt + o.expiry * 1000 - Date.now()) / 1000));
    return `<div class="card" style="margin-bottom:10px"><div class="opp-head"><span class="pair">${e(AR.pair(o.asset))}</span><span class="dir ${o.dir}">${AR.dir(o.dir)}</span></div>
      <div class="state"><span><b>صفقة مفتوحة</b></span><span>باقٍ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</span><span>${o.intel ? 'نفّذها المحرك الذكي' : 'نفّذها البوت القديم'}</span></div></div>`;
  }).join('');
  // The one opportunity worth looking at: a confirmation request, else ENTER, else a WAIT, else a watch.
  const opp = manual.length ? list.find((x) => x.p.asset === manual[0].asset)
    : ['enter', 'wait', 'entered'].map((k) => list.find((x) => x.st.key === k)).find(Boolean); // only what passed the gate
  if (opp) {
    const { p } = opp, d = AR.decision(p, now(), s.cfg), w = AR.why(d.facts);
    const pend = manual.find((m) => m.asset === p.asset);
    const key = `${p.asset}|${p.opp?.id || p.watch?.closesAt}|${d.key}`;
    const fresh = S.seenOpp !== key;
    S.seenOpp = key;
    const head = { enter: 'فرصة دخول', wait: 'فرصة تنتظر شرطًا', watch: 'تحت المراقبة', entered: 'آخر دخول' }[d.key] || 'الفرصة الحالية';
    html += `<div class="label">${head}</div>
      <div class="card ${fresh ? 'enter' : ''}">
        <div class="opp-head"><span class="pair">${e(AR.pair(p.asset))}</span>${d.dir ? `<span class="dir ${d.dir}">${AR.dir(d.dir)}</span>` : ''}</div>
        <div class="state"><span><b>${e(d.title)}</b></span>${d.timer && d.timer.sec > 0 ? `<span>${e(d.timer.label)} ${AR.clock(d.timer.sec)}</span>` : ''}</div>
        ${decisionRows(d)}
        <ul class="why">${w.good.slice(0, 3).map((x) => `<li class="g">${icon('check')}<span>${e(x)}</span></li>`).join('')}${w.bad.slice(0, 3).map((x) => `<li class="b">${icon('alert')}<span>${e(x)}</span></li>`).join('')}</ul>
        <div class="actions">
          ${pend ? `<button class="btn go" data-act="confirm" data-id="${e(pend.id)}">تنفيذ</button><button class="btn" data-act="reject" data-id="${e(pend.id)}">تجاهل</button>` : ''}
          <button class="btn ${pend ? '' : 'primary'}" data-pair="${e(p.asset)}" data-tab-id="${p.tabId}">عرض التحليل</button>
        </div>
        ${!pend && d.key === 'enter' ? `<div class="dim" style="margin-top:8px">${e(modeLine(s.cfg.execMode))}</div>` : ''}
      </div>`;
  } else {
    // NO QUALIFIED OPPORTUNITY: what was scanned, the nearest candidate and why it isn't enough.
    const minPay = s.cfg.gate?.minPayout ?? 92, scanned = s.pairs.filter((p) => p.scanned).length;
    const near = list.filter((x) => x.st.key === 'below').sort((a, b) => (b.p.opp?.cal?.p ?? 0) - (a.p.opp?.cal?.p ?? 0))[0];
    const nd = near ? AR.decision(near.p, now(), s.cfg) : null;
    html += `<div class="card calm">${icon('pulse')}<h2>لا توجد فرصة مؤهلة الآن</h2>
      <p>تم فحص ${e(AR.count(list.length, 'زوج واحد', 'زوجين', 'أزواج', 'زوجًا'))}${scanned ? ` (${scanned} منها من التاريخ دون شارت)` : ''}. لا يدخل النظام إلا على زوج نسبة ربحه ${minPay}% أو أكثر، وبعد أن تجتاز الفرصة كل الفحوص.</p>
      ${near ? `<p class="note" style="margin-top:8px">الأقرب: <span class="pair" style="font-size:1em">${e(AR.pair(near.p.asset))}</span> · ${e(AR.dir(near.p.opp?.dir))}<br><span class="dim">${e(nd.rows.find((r) => r[0] === 'السبب')?.[1] || '')}</span></p>` : ''}
      <div class="dim">نموذج الثقة: ${e(AR.MODEL[s.calStatus?.status] || AR.MODEL.COLLECTING)} · آخر تحديث ${e(AR.ago(lastUpdateAgo()))}</div></div>`;
  }
  html += `<div class="label space">الأزواج المراقبة</div><div class="list">${list.slice(0, 5).map(pairRow).join('')}
    ${list.length > 5 ? `<button class="more" data-go="pairs">عرض كل الأزواج (${list.length})</button>` : ''}</div>`;
  html += footer(list);
  return html;
}
const modeLine = (m) => ({ OBSERVE: 'وضع المراقبة: لن يتم تنفيذ أي صفقة.', PAPER: 'وضع المراقبة: تُسجَّل الفرصة كصفقة ورقية دون تنفيذ.', ALERT: 'وضع التنبيه: القرار لك.',
  MANUAL: 'تأكيد يدوي: سيُطلب تأكيدك قبل التنفيذ.', AUTO: 'التنفيذ التلقائي مفعّل — يدخل في التبويب المفعّل لهذا الزوج.' }[m] || '');
function lastUpdateAgo() { const ages = (S.snap?.pairs || []).map((p) => p.seenAgo).filter((x) => x != null); return ages.length ? Math.min(...ages) : null; }
function footer(list) {
  const err = list.some((x) => x.st.key === 'error');
  return `<div class="foot"><span>المراقبة: ${list.length ? e(AR.count(list.length, 'زوج واحد', 'زوجان', 'أزواج', 'زوجًا')) : 'لا توجد أزواج'}</span>
    ${err ? '<span class="warn">تعذر قراءة بيانات أحد الأزواج</span>' : `<span>آخر تحديث ${e(AR.ago(lastUpdateAgo()))}</span>`}</div>`;
}
function decisionRows(d) {
  if (!d.rows.length) return '';
  return `<div class="drows">${d.rows.map(([k, v]) => `<div class="kv"><span>${e(k)}</span><span>${e(v)}</span></div>`).join('')}</div>`;
}
function pairRow({ p, st }) {
  const sub = `${p.regime ? AR.regime(p.regime.regime) : 'تحليل جارٍ'}${p.scanned ? ' · من التاريخ' : ''}${p.payout != null ? ` · ربح ${p.payout}%` : ''}`;
  return `<button class="row" data-pair="${e(p.asset)}" data-tab-id="${p.tabId}"><div class="main"><div class="pair" style="font-size:1em">${e(AR.pair(p.asset))}</div><div class="sub">${e(sub)}</div></div>
    ${st.dir && ['enter', 'wait', 'watch', 'strong', 'possible'].includes(st.key) ? `<span class="word ${st.dir}">${AR.dir(st.dir)}</span>` : ''}${statusPill(st)}${icon('chev').replace('<svg', '<svg class="chev"')}</button>`;
}

function viewPairs() {
  const list = pairsWithStatus();
  if (!S.snap) return '';
  if (!list.length) return `<div class="card calm">${icon('pairs')}<h2>لا توجد أزواج بعد</h2><p>كل تبويب Pocket Option مفتوح على زوج OTC يُضاف هنا تلقائيًا.</p></div>`;
  return `<div class="label">الأزواج</div><div class="list">${list.map(pairRow).join('')}</div>${footer(list)}`;
}

// ── history ─────────────────────────────────────────────────────────────────
async function loadRecords() {
  if (S.records && Date.now() - S.recordsAt < 20000) return S.records;
  // Entries only: opportunity entries, and anything the worker acted on. Per-frame analyses are research records.
  const TAKEN = ['paper', 'alert', 'auto', 'manual', 'risk-skip'];
  try {
    const t = Date.now() / 1000;
    const [opps, recent] = await Promise.all([DB.byIndex('records', 'kind', 'opp'), DB.range('records', 'ts', t - 14 * 86400, t + 3600)]);
    const byId = new Map();
    for (const r of [...opps, ...recent]) if (r.source === 'live' && ((r.kind === 'opp' && r.decision !== 'SKIP') || TAKEN.includes(r.exec?.action))) byId.set(r.id, r);
    S.records = [...byId.values()];
  } catch (_) { S.records = []; }
  S.records.sort((a, b) => b.ts - a.ts);
  S.recordsAt = Date.now();
  return S.records;
}
function resultOf(r) {
  const dir = r.exec?.dir || (r.decision !== 'SKIP' ? r.decision : r.engineDecision);
  const expiry = r.exec?.expiry || (r.kind === 'opp' && r.expirySec ? r.expirySec / (r.tf || 60) : S.snap?.cfg?.paperExpiry || 1);
  const R = r.exec?.result || OTC.Stats.outcome(r, dir, expiry);
  return { dir, R };
}
async function viewHistory() {
  const recs = await loadRecords();
  if (!recs.length) return `<div class="card calm">${icon('history')}<h2>لا يوجد سجل بعد</h2><p>كل فرصة يقررها النظام تُسجَّل هنا مع نتيجتها.</p></div>`;
  const taken = recs.filter((r) => r.exec && ['paper', 'alert', 'auto', 'manual'].includes(r.exec.action) && r.exec.status !== 'expired' && r.exec.status !== 'failed');
  const res = taken.map(resultOf).filter((x) => x.R);
  const wins = res.filter((x) => x.R === 'W').length, losses = res.filter((x) => x.R === 'L').length;
  const byKind = {};
  for (const r of taken) { const x = resultOf(r); if (!x.R || x.R === 'T') continue; const k = r.facts?.kind || 'trend'; (byKind[k] ||= { w: 0, n: 0 }); byKind[k].n++; if (x.R === 'W') byKind[k].w++; }
  const best = Object.entries(byKind).filter(([, v]) => v.n >= 20).sort((a, b) => b[1].w / b[1].n - a[1].w / a[1].n)[0];
  return `<div class="label">ملخص</div>
    <div class="sum"><div><b>${recs.length}</b><span>فرص</span></div><div><b>${taken.length}</b><span>صفقات</span></div><div><b>${wins} / ${losses}</b><span>نجاح / خسارة</span></div></div>
    <p class="dim" style="margin-top:6px">أفضل نوع فرص: ${best ? e(AR.kind(best[0])) : 'لا توجد بيانات كافية للحكم بعد'}</p>
    <div class="label space">السجل</div>
    <div class="list">${recs.slice(0, 60).map((r) => {
      const { dir, R } = resultOf(r), res = R ? AR.RESULT[R] : null;
      return `<button class="row" data-rec="${e(r.id)}"><div class="main"><div><span class="pair" style="font-size:1em">${e(AR.pair(r.asset))}</span> · <span class="word ${dir}">${AR.dir(dir)}</span></div>
        <div class="sub">${e(AR.kind(r.facts?.kind))} · ${e(decisionWord(r))} · ${e(AR.ago(now() - r.ts))}</div></div>
        <span class="status ${res ? (res.tone === 'go' ? 'go' : res.tone === 'bad' ? 'bad' : '') : ''}"><span class="dot"></span>${res ? res.text : 'بانتظار النتيجة'}</span></button>`;
    }).join('')}</div>`;
}
function decisionWord(r) {
  const a = r.exec?.action;
  if (r.decision === 'SKIP' && r.engineDecision) return 'استبعدتها الحماية';
  return { paper: 'ورقية', alert: 'تنبيه', manual: r.exec.status === 'expired' ? 'لم تؤكَّد' : 'تأكيد يدوي', auto: 'تنفيذ تلقائي' }[a] || 'مراقبة';
}

// ── research ────────────────────────────────────────────────────────────────
async function viewResearch() {
  let latest = [];
  try { latest = OTC.Lifecycle.latest(await DB.all('strategies')); } catch (_) {}
  const nowMs = Date.now();
  const groups = [
    ['استراتيجيات جديدة', latest.filter((r) => r.status === 'PAPER_TEST' && nowMs - (r.live_since || 0) < 3 * 86400e3)],
    ['تحت الاختبار', latest.filter((r) => r.status === 'PAPER_TEST' && nowMs - (r.live_since || 0) >= 3 * 86400e3)],
    ['المستقرة', latest.filter((r) => r.status === 'WATCHLIST' || r.status === 'PROMOTED')],
    ['المتوقفة', latest.filter((r) => ['SUSPENDED', 'DECAYING'].includes(r.status))],
  ];
  const any = groups.some(([, xs]) => xs.length);
  let html = `<div class="label">البحث</div><p class="note">أنماط اكتشفها النظام من بيانات التداول السابقة، ولا تُستخدم إلا بعد اختبارها على بيانات حية وموافقتك.</p>`;
  if (!any) html += `<div class="card calm" style="margin-top:10px">${icon('research')}<h2>لا توجد أنماط قيد الاختبار</h2><p>شغّل دورة بحث من الوضع المتقدم. عدم العثور على نمط نتيجة طبيعية.</p></div>`;
  for (const [title, xs] of groups) {
    if (!xs.length) continue;
    html += `<div class="label space">${title}</div>${xs.slice(0, 12).map((r) => {
      const st = AR.DISC_STATUS[r.status] || { text: r.status, tone: 'muted', note: '' };
      return `<div class="card"><div class="opp-head"><b>${e(AR.discName(r))}</b><span class="status ${st.tone === 'go' ? 'go' : st.tone === 'wait' ? 'wait' : st.tone === 'bad' ? 'bad' : ''}"><span class="dot"></span>${e(st.text)}</span></div>
        <div class="state"><span>أفضل استخدام: <b>${e(AR.bestUse(r))}</b></span></div>
        <p class="note" style="margin-top:4px">${e(st.note)} تم اكتشافه من بيانات التداول السابقة.</p>
        ${r.status === 'WATCHLIST' ? `<div class="actions"><button class="btn primary" data-promote="${e(r.strategy_id)}">اعتماد</button></div>` : ''}
        ${r.status === 'PROMOTED' ? `<div class="actions"><button class="btn danger" data-suspend="${e(r.strategy_id)}">إيقاف</button></div>` : ''}</div>`;
    }).join('')}`;
  }
  html += `<button class="btn" style="margin-top:14px;width:100%" data-adv="#discovery">${icon('open')} تفاصيل البحث في الوضع المتقدم</button>`;
  return html;
}

// ── settings ────────────────────────────────────────────────────────────────
function viewSettings() {
  const s = S.snap;
  if (!s) return '';
  const c = s.cfg, P = S.prefs;
  const seg = (k, opts, cur) => `<div class="seg">${opts.map(([v, l]) => `<button class="${cur === v ? 'on' : ''}" data-${k}="${v}">${l}</button>`).join('')}</div>`;
  const stepper = (path, v, min, max, inc = 1) => `<div class="num"><button data-step="${path}" data-d="${-inc}" data-min="${min}" data-max="${max}" aria-label="أقل">−</button><b>${v}</b><button data-step="${path}" data-d="${inc}" data-min="${min}" data-max="${max}" aria-label="أكثر">+</button></div>`;
  const mode = c.execMode === 'OBSERVE' || c.execMode === 'ALERT' ? 'PAPER' : c.execMode;
  const radio = (v, t, sub) => `<button class="radio ${mode === v ? 'on' : ''}" data-mode="${v}"><span class="ring"></span><span><b>${t}</b><small>${sub}</small></span></button>`;
  return `<div class="label">المراقبة</div><div class="set">
      <div class="item"><div class="t">الأزواج<small>تتم مراقبة كل زوج OTC مفتوح في تبويبات المنصة</small></div><span>${s.pairs.length ? e(AR.count(s.pairs.length, 'زوج واحد', 'زوجان', 'أزواج', 'زوجًا')) : 'لا يوجد'}</span></div>
      <div class="item stack"><div class="t">فريمات البحث عن الفرص<small>لا يوجد فريم ثابت: كل فرصة تأخذ فريمها وفريم السياق والتأكيد المناسب لها. فريمات الثواني للأزواج المفتوحة على الشارت فقط.</small></div>
        <div class="seg wrap">${[[5, '5ث'], [10, '10ث'], [15, '15ث'], [30, '30ث'], [60, 'دقيقة'], [300, '5د'], [900, '15د']].map(([v, l]) => `<button class="${(c.setupFrames || []).includes(v) ? 'on' : ''}" data-frame="${v}">${l}</button>`).join('')}</div></div>
      <div class="item"><div class="t">أقل نسبة ربح للدخول<small>لا يدخل النظام (ورقيًا أو فعليًا) على زوج نسبة ربحه أقل من ذلك</small></div><span>${c.gate?.minPayout ?? 92}%</span></div>
      <div class="item"><div class="t">الثقة المعايرة<small>احتمال أن هذا النوع من الفرص يتفوق على نقطة التعادل، من نتائج فرص مشابهة سابقة. تمنع الدخول فقط عندما تُقاس وتكون أقل من ${c.gate?.minConfidence ?? 50}%.</small></div><span>${e(AR.MODEL[s.calStatus?.status] || AR.MODEL.COLLECTING)}</span></div>
      <div class="item"><div class="t">مدة الصفقة<small>تُختار لكل فرصة حسب نوعها وسرعة السوق، ثم حسب ما نجح سابقًا</small></div><span>يحددها النظام</span></div>
      <div class="item"><div class="t">توقيت الدخول<small>عند إغلاق الشمعة، فورًا أو بعد تأكيد أو عودة السعر</small></div><span>يحدده النظام</span></div></div>
    <div class="label space">التنبيهات</div><div class="set"><div class="item"><div class="t">تنبيه الفرص</div>
      ${seg('notify', [['browser', 'تنبيه المتصفح'], ['sound', 'مع صوت'], ['none', 'بدون']], c.ui?.notify || 'browser')}</div></div>
    <div class="label space">التداول</div><div class="set">
      ${radio('PAPER', 'مراقبة فقط', 'تُسجَّل الفرص كصفقات ورقية لقياس النتائج، دون تنفيذ.')}
      ${radio('MANUAL', 'تأكيد يدوي', 'يطلب تأكيدك قبل كل صفقة خلال نافذة الدخول.')}
      ${radio('AUTO', 'تنفيذ تلقائي', 'ينفّذ دون سؤالك في التبويبات المفعّلة، حسب اختيارك تحت.')}
      ${mode === 'AUTO' ? `<div class="item"><div class="t">على الحساب التجريبي</div>${seg('autodemo', [['all', 'كل الفرص المؤهلة'], ['promoted', 'المعتمدة فقط']], c.autoDemoAll !== false ? 'all' : 'promoted')}</div>
      <div class="item"><div class="t">فتح الزوج تلقائيًا<small>عند وجود فرصة مؤهلة على زوج غير مفتوح، يفتحه التبويب المفعّل من قائمة الأزواج في المنصة</small></div>${seg('autoswitch', [['on', 'تشغيل'], ['off', 'إيقاف']], c.autoSwitch !== false ? 'on' : 'off')}</div>
      <div class="item"><div class="t">على الحساب الحقيقي</div>${seg('autoreal', [['all', 'كل الفرص المؤهلة'], ['promoted', 'المعتمدة فقط']], c.autoRealAll === true ? 'all' : 'promoted')}</div>` : ''}</div>
    <div class="label space">الحماية</div><div class="set">
      <div class="item"><div class="t">إيقاف بعد خسائر متتالية</div>${stepper('risk.maxConsecutiveLosses', c.risk.maxConsecutiveLosses, 1, 20)}</div>
      <div class="item"><div class="t">حد الصفقات اليومي</div>${stepper('risk.maxTradesPerDay', c.risk.maxTradesPerDay, 1, 200)}</div>
      <div class="item"><div class="t">استراحة بعد الخسارة<small>دقائق بلا صفقات جديدة بعد كل صفقة خاسرة (0 = بلا استراحة)</small></div>${stepper('risk.lossCooldownMin', c.risk.lossCooldownMin, 0, 60)}</div>
      <div class="item"><div class="t">صفقات مفتوحة في نفس الوقت</div>${stepper('risk.maxConcurrent', c.risk.maxConcurrent, 1, 5)}</div>
      <div class="item"><div class="t">انتظار قبل تكرار نفس الزوج<small>دقائق بعد آخر صفقة على الزوج (0 = بلا انتظار)</small></div>${stepper('risk.pairCooldownMin', c.risk.pairCooldownMin ?? 10, 0, 60)}</div>
      <div class="item"><div class="t">عدادات اليوم<small>${s.risk ? `${s.risk.trades ?? 0} صفقة · ${s.risk.consecLosses ?? 0} خسائر متتالية · الصافي ${(s.risk.net ?? 0).toFixed(2)} رهان` : ''}</small></div><button class="btn small" data-act="resetday">تصفير</button></div>
      <div class="item"><div class="t">إيقاف الطوارئ<small>يوقف كل التنفيذ والاقتراحات فورًا</small></div><button class="switch ${s.risk?.emergency ? 'on' : ''}" data-act="${s.risk?.emergency ? 'resume' : 'stop'}" aria-label="إيقاف الطوارئ"></button></div></div>
    <div class="label space">المظهر</div><div class="set">
      <div class="item"><div class="t">الوضع الداكن</div><button class="switch ${P.theme === 'dark' ? 'on' : ''}" data-pref="theme" aria-label="الوضع الداكن"></button></div>
      <div class="item"><div class="t">حجم الواجهة</div>${seg('size', [['normal', 'عادي'], ['large', 'كبير']], P.size)}</div>
      <div class="item"><div class="t">الوضع المتقدم<small>يُظهر التفاصيل الفنية في شاشة التحليل</small></div><button class="switch ${P.advanced ? 'on' : ''}" data-pref="advanced" aria-label="الوضع المتقدم"></button></div></div>
    <button class="btn" style="margin-top:14px;width:100%" data-adv="">${icon('open')} فتح لوحة الوضع المتقدم</button>
    <p class="dim" style="margin-top:12px;text-align:center">النتائج السابقة لا تضمن نتائج مستقبلية.</p>`;
}

// ── analysis drawer ─────────────────────────────────────────────────────────
function openSheet(kind, id, tabId) { S.sheet = { kind, id, tabId }; $('#sheet').classList.remove('hidden'); renderSheet(); }
function closeSheet() { S.sheet = null; $('#sheet').classList.add('hidden'); }

function renderSheet() {
  const sh = S.sheet;
  if (!sh) return;
  if (sh.kind === 'pair') {
    const p = (S.snap?.pairs || []).find((x) => x.asset === sh.id && (sh.tabId == null || String(x.tabId) === String(sh.tabId))) || (S.snap?.pairs || []).find((x) => x.asset === sh.id);
    $('#sheetTitle').textContent = `تحليل ${AR.pair(sh.id)}`;
    $('#sheetBody').innerHTML = p ? analysisHtml(p) : '<p class="note">لم يعد هذا الزوج متصلًا.</p>';
  } else if (sh.kind === 'rec') {
    const r = (S.records || []).find((x) => x.id === sh.id);
    $('#sheetTitle').textContent = r ? AR.pair(r.asset) : 'السجل';
    $('#sheetBody').innerHTML = r ? recordHtml(r) : '';
  }
  $('#sheetBody').querySelectorAll('[data-adv]').forEach((b) => (b.onclick = () => openAdvanced(b.dataset.adv)));
  // keep "التفاصيل الفنية" open across live updates
  const d = $('#sheetBody details');
  if (d) { d.open = !!S.detailsOpen; d.ontoggle = () => (S.detailsOpen = d.open); }
}

function analysisHtml(p) {
  const L = p.last, d = AR.decision(p, now(), S.snap.cfg);
  if (!L?.facts && !p.opp) return `<p class="note">النظام يجمع بيانات هذا الزوج. يظهر التحليل بعد إغلاق أول شمعة.</p>`;
  const f = d.facts || L?.facts || {}, w = AR.why(f);
  const strat = (L?.stratIds || []).map(AR.strategyName);
  const frames = Object.entries(p.frames || {}).sort((a, b) => b[0] - a[0]);
  const frameWord = (x) => (x.usable === false ? 'غير واضح الآن' : x.watch ? AR.OPP_STATE[x.watch.state] : x.decision && x.decision !== 'SKIP' ? `فرصة ${AR.dir(x.decision)}` : x.conflict ? 'متعارض' : x.lean ? `ميل ${AR.dir(x.lean)}` : 'لا توجد فرصة');
  const roles = (x) => (x.roles ? `السياق ${AR.frame(x.roles.MID)}${x.roles.TIMING ? ` · التأكيد ${AR.frame(x.roles.TIMING)}` : ' · بلا فريم تأكيد'}` : '');
  return `<div class="sec"><h3>القرار</h3><div class="opp-head"><span class="big ${d.dir && d.verdict === 'ENTER' ? `word ${d.dir}` : ''}">${e(d.verdict === 'ENTER' ? AR.dir(d.dir) : d.verdict === 'WAIT' ? 'انتظار' : 'لا دخول')}</span>${statusPill(d)}</div>
      <p class="note">${e(d.title)}${d.timer && d.timer.sec > 0 ? ` · ${e(d.timer.label)} ${AR.clock(d.timer.sec)}` : ''}</p>${decisionRows(d)}</div>
    ${frames.length ? `<div class="sec"><h3>الفريمات</h3>${frames.map(([tf, x]) => `<div class="kv"><span>${e(AR.frame(+tf))}</span><span>${e(frameWord(x))}${x.kind && x.decision !== 'SKIP' ? ` · ${e(AR.kind(x.kind))}` : ''}</span></div>${x.usable && x.roles ? `<div class="dim" style="margin:-2px 0 4px">${e(roles(x))}</div>` : ''}`).join('')}</div>` : ''}
    ${f.dir ? `<div class="sec"><h3>نوع الفرصة</h3><div>${e(AR.kind(f.kind))}${d.verdict !== 'ENTER' ? ` <span class="dim">(الميل: ${AR.dir(f.dir)})</span>` : ''}</div></div>` : ''}
    <div class="sec"><h3>الاتجاه</h3>${AR.trendRows(f).map(([k, v]) => `<div class="kv"><span>${e(k)}</span><span>${e(v)}</span></div>`).join('')}
      <div class="kv"><span>حالة السوق</span><span>${e(AR.regime(f.regime))}</span></div></div>
    ${f.dir ? `<div class="sec"><h3>المنطقة</h3><div>${e(AR.ZONE[f.zone]?.(f.dir) || 'غير محددة')}</div></div>
    <div class="sec"><h3>الحركة</h3><div>${e(AR.MOMENTUM[f.momentum] || '—')}</div></div>
    <div class="sec"><h3>السلوك السعري</h3><div>${e(f.pattern ? AR.PATTERN[f.pattern] || 'نموذج سعري' : 'لا يوجد نموذج واضح')}</div></div>
    <div class="sec"><h3>التوافق</h3><div>${e(AR.ALIGN[f.align] || '—')}</div></div>` : ''}
    <div class="sec"><h3>لماذا؟</h3><ul class="why" style="margin-top:2px">${w.good.map((x) => `<li class="g">${icon('check')}<span>${e(x)}</span></li>`).join('')}${w.bad.map((x) => `<li class="b">${icon('alert')}<span>${e(x)}</span></li>`).join('') || ''}</ul>
      ${!w.good.length && !w.bad.length ? '<p class="note">لا توجد إشارة واضحة.</p>' : ''}</div>
    <div class="sec"><h3>المخاطر</h3><div>${w.bad.length ? e(w.bad.join('، ')) : 'لا توجد مخاطر واضحة'}</div></div>
    <details class="sec"><summary>${icon('chev')}<span>التفاصيل الفنية</span></summary>
      <ul class="why">${strat.length ? strat.map((x) => `<li class="g">${icon('check')}<span>${e(x)}</span></li>`).join('') : '<li>لا توجد استراتيجيات نشطة الآن</li>'}</ul>
      ${S.prefs.advanced ? `<div class="tech" style="margin-top:8px">
        <div class="kv"><span>تقدير الثقة الداخلي</span><span>${f.conf} / 100</span></div>
        <div class="kv"><span>درجة الماسح</span><span>${p.scan?.score ?? '—'} / 100</span></div>
        <div class="kv"><span>حالة السوق (رمز)</span><span>${e(f.regime || '—')}</span></div>
        ${(L?.skipReasons || []).length ? `<div class="kv"><span>أسباب الاستبعاد</span><span></span></div><div dir="ltr" style="text-align:left">${(L.skipReasons || []).map(e).join('<br>')}</div>` : ''}</div>` : ''}
      <p class="dim" style="margin-top:8px">الثقة تقدير داخلي من النظام، وليست احتمال ربح.</p>
      <button class="btn small" style="margin-top:8px" data-adv="">${icon('open')} الوضع المتقدم</button>
    </details>`;
}

function recordHtml(r) {
  const { dir, R } = resultOf(r), f = r.facts, w = AR.why(f);
  return `<div class="sec"><div class="opp-head"><span class="big word ${dir}">${AR.dir(dir)}</span><span>${R ? AR.RESULT[R].text : 'بانتظار النتيجة'}</span></div>
      <p class="note">${e(AR.kind(f?.kind))} · ${e(decisionWord(r))} · ${e(new Date(r.ts * 1000).toLocaleString('ar-EG-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' }))}</p></div>
    ${f ? `<div class="sec"><h3>الاتجاه وقتها</h3>${AR.trendRows(f).map(([k, v]) => `<div class="kv"><span>${e(k)}</span><span>${e(v)}</span></div>`).join('')}</div>
    <div class="sec"><h3>لماذا؟</h3><ul class="why">${w.good.map((x) => `<li class="g">${icon('check')}<span>${e(x)}</span></li>`).join('')}${w.bad.map((x) => `<li class="b">${icon('alert')}<span>${e(x)}</span></li>`).join('')}</ul></div>` : ''}
    ${r.kind === 'opp' ? `<div class="sec"><h3>الفرصة</h3>
      <div class="kv"><span>الفريم</span><span>${e(AR.framesText({ tf: r.frame, timingTf: r.timingTf, alsoOn: r.alsoOn }))}</span></div>
      ${r.path?.includes('ENTERED') ? `<div class="kv"><span>التوقيت</span><span>${e(AR.ENTRY_WHY[r.why] || 'عند إغلاق الشمعة')}${r.waitSec > 0 ? ` · بعد انتظار ${AR.duration(r.waitSec, true)}` : ''}</span></div>` : ''}
      ${r.expirySec ? `<div class="kv"><span>المدة</span><span>${e(AR.duration(r.expirySec))} — ${e(AR.expiryWhy(r.expiry))}</span></div>` : ''}</div>` : ''}
    ${r.decision === 'SKIP' && r.engineDecision ? `<div class="sec"><h3>لماذا لم تُنفّذ؟</h3><div>حدود الحماية منعت صفقة جديدة في ذلك الوقت.</div></div>` : ''}
    <button class="btn small" style="margin-top:8px" data-adv="#log">${icon('open')} التفاصيل الكاملة في الوضع المتقدم</button>`;
}

// ── events ──────────────────────────────────────────────────────────────────
function bind() {
  const v = $('#view');
  v.querySelectorAll('[data-pair]').forEach((b) => (b.onclick = () => openSheet('pair', b.dataset.pair, b.dataset.tabId)));
  v.querySelectorAll('[data-rec]').forEach((b) => (b.onclick = () => openSheet('rec', b.dataset.rec)));
  v.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => { S.tab = b.dataset.go; render(); }));
  v.querySelectorAll('[data-adv]').forEach((b) => (b.onclick = () => openAdvanced(b.dataset.adv)));
  // pointerdown: the home view redraws every second during a countdown and could swallow a click
  v.querySelectorAll('[data-act]').forEach((b) => (b.onpointerdown = () => act(b.dataset.act, b.dataset.id)));
  v.querySelectorAll('[data-notify]').forEach((b) => (b.onclick = () => send({ type: 'setConfig', patch: { ui: { notify: b.dataset.notify } } })));
  v.querySelectorAll('[data-size]').forEach((b) => (b.onclick = () => setPref('size', b.dataset.size)));
  v.querySelectorAll('[data-frame]').forEach((b) => (b.onclick = () => {
    const cur = S.snap?.cfg?.setupFrames || [], tf = +b.dataset.frame;
    const next = cur.includes(tf) ? cur.filter((x) => x !== tf) : [...cur, tf].sort((x, y) => x - y);
    if (next.length) send({ type: 'setConfig', patch: { setupFrames: next } }); // at least one frame stays on
  }));
  v.querySelectorAll('[data-autoswitch]').forEach((b) => (b.onclick = () => send({ type: 'setConfig', patch: { autoSwitch: b.dataset.autoswitch === 'on' } })));
  v.querySelectorAll('[data-autodemo]').forEach((b) => (b.onclick = () => send({ type: 'setConfig', patch: { autoDemoAll: b.dataset.autodemo === 'all' } })));
  v.querySelectorAll('[data-autoreal]').forEach((b) => (b.onclick = async () => {
    const all = b.dataset.autoreal === 'all';
    if (all && !(await ask('كل القرارات على الحساب الحقيقي؟',
      'سيدخل المحرك بأموال حقيقية في كل قرار، بما فيها أنماط لم تُختبر على بيانات حية بعد.\nلا يوجد حتى الآن دليل كافٍ على أن قراراته تتجاوز نقطة التعادل (حوالي 52–54%).\nحدود الحماية تبقى فعّالة، ويجب إلغاء "الحساب التجريبي فقط" في التبويب ليعمل.', 'نعم، كل القرارات'))) return;
    send({ type: 'setConfig', patch: { autoRealAll: all } });
  }));
  v.querySelectorAll('[data-pref]').forEach((b) => (b.onclick = () => (b.dataset.pref === 'theme' ? setPref('theme', S.prefs.theme === 'dark' ? 'light' : 'dark') : setPref('advanced', !S.prefs.advanced))));
  v.querySelectorAll('[data-step]').forEach((b) => (b.onclick = () => {
    const [grp, key] = b.dataset.step.split('.'), cur = S.snap.cfg[grp][key];
    const next = Math.max(Number(b.dataset.min ?? 1), Math.min(Number(b.dataset.max ?? 200), (cur ?? 0) + Number(b.dataset.d)));
    send({ type: 'setConfig', patch: { [grp]: { [key]: next } } });
  }));
  v.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = async () => {
    const m = b.dataset.mode;
    if (m === 'AUTO' && !(await ask('تفعيل التنفيذ التلقائي؟',
      'سيتم تنفيذ صفقات دون سؤالك في التبويبات التي فعّلتها للتنفيذ.\nعلى الحساب التجريبي: كل قرارات المحرك. على الحساب الحقيقي: الأنماط التي اعتمدتها فقط.\nحدود الحماية تبقى فعّالة، والنتائج السابقة لا تضمن نتائج مستقبلية.', 'تفعيل'))) return;
    send({ type: 'setConfig', patch: { execMode: m } });
  }));
  v.querySelectorAll('[data-promote]').forEach((b) => (b.onclick = async () => {
    if (!(await ask('اعتماد هذا النمط؟', 'سيبدأ النمط في المشاركة في القرارات الحية. يمكنك إيقافه في أي وقت، وسيتوقف تلقائيًا إذا تراجع أداؤه.', 'اعتماد'))) return;
    send({ type: 'discPromote', id: b.dataset.promote }); setTimeout(render, 700);
  }));
  v.querySelectorAll('[data-suspend]').forEach((b) => (b.onclick = () => { send({ type: 'discSuspend', id: b.dataset.suspend }); setTimeout(render, 700); }));
}

async function act(what, id) {
  if (what === 'stop') return send({ type: 'emergency', on: true, reason: 'أوقفه المستخدم' });
  if (what === 'resume') {
    if (await ask('تشغيل النظام؟', 'سيعود النظام إلى المراقبة وفق الوضع المحدد في الإعدادات.', 'تشغيل')) send({ type: 'emergency', on: false });
    return;
  }
  if (what === 'resetday') {
    if (await ask('تصفير عدادات اليوم؟', 'يعيد عدد الصفقات والخسائر المتتالية وصافي اليوم إلى الصفر، فتعود الحماية للعمل من جديد.', 'تصفير')) send({ type: 'resetDay' });
    return;
  }
  if (what === 'confirm') return send({ type: 'manualConfirm', id });
  if (what === 'reject') return send({ type: 'manualReject', id });
}

$('#power').onclick = () => act(S.snap?.risk?.emergency ? 'resume' : 'stop');
const TAB_LABEL = { home: ['home', 'الرئيسية'], pairs: ['pairs', 'الأزواج'], history: ['history', 'السجل'], research: ['research', 'البحث'], settings: ['settings', 'الإعدادات'] };
document.querySelectorAll('#tabs button').forEach((b) => {
  const [ic, label] = TAB_LABEL[b.dataset.tab];
  b.innerHTML = `${icon(ic)}<span>${label}</span>`;
  b.onclick = () => { S.tab = b.dataset.tab; S.records = null; $('#view').scrollTop = 0; render(); };
});
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeSheet));
$('.sheet-head .icon-btn').innerHTML = icon('close');
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { if (!$('#modal').classList.contains('hidden')) $('#modalCancel').click(); else closeSheet(); } });

loadPrefs().then(() => { connect(); render(); });
// Countdowns tick every second; "منذ …" texts refresh every 10 seconds.
let tick = 0;
setInterval(() => {
  tick++;
  const counting = (S.snap?.manual || []).length || (S.snap?.tabsInfo || []).some((t) => t.openTrades?.length) || pairsWithStatus().some((x) => ['enter', 'wait', 'watch', 'entered'].includes(x.st.key));
  if ((S.tab === 'home' && counting) || tick % 10 === 0) render();
}, 1000);
