// Arabic wording for the interface. Turns engine facts and codes into short,
// plain sentences. No numbers unless they help (minutes, counts, waiting time).
(function (G) {
  const OTC = G.OTC;
  const pair = (a) => OTC.U.pairLabel(a);

  const DIR = { CALL: 'شراء', PUT: 'بيع' };
  const REGIME = {
    TRENDING_UP: 'اتجاه صاعد', TRENDING_DOWN: 'اتجاه هابط', RANGING: 'حركة جانبية', BREAKOUT: 'اختراق',
    REVERSAL: 'انعكاس محتمل', HIGH_VOLATILITY: 'تذبذب مرتفع', LOW_VOLATILITY: 'هدوء شديد', TRANSITIONING: 'مرحلة تحوّل', UNCLEAR: 'غير واضح',
  };
  const TREND = { UP: 'صاعد', DOWN: 'هابط', FLAT: 'عرضي' };
  const TF = { 60: 'ساعة', 15: '15 دقيقة', 5: '5 دقائق', 1: 'دقيقة' };
  const KIND = {
    pullback: 'ارتداد مع الاتجاه', retest: 'اختراق وإعادة اختبار', breakout: 'اختراق', reversal: 'انعكاس من منطقة مهمة',
    range: 'ارتداد داخل نطاق', momentum: 'استمرار الزخم', pattern: 'نموذج سعري عند منطقة', trend: 'استمرار الاتجاه', discovered: 'نمط مكتشف',
  };
  const PATTERN = {
    bullish_engulfing: 'ابتلاع شرائي', bearish_engulfing: 'ابتلاع بيعي', pin_bar: 'شمعة رفض', hammer: 'المطرقة', shooting_star: 'النجم الساقط',
    doji: 'دوجي', doji_rejection: 'دوجي رفض', inside_bar: 'شمعة داخلية', outside_bar: 'شمعة ابتلاع خارجية', morning_star: 'نجمة الصباح',
    evening_star: 'نجمة المساء', tweezer_bottom: 'قاع مزدوج قصير', tweezer_top: 'قمة مزدوجة قصيرة', long_wick_rejection: 'ذيل رفض طويل', strong_body: 'شمعة قوية',
  };

  const conf = (level) => ({ high: 'ثقة مرتفعة', mid: 'ثقة متوسطة', low: 'إشارة ضعيفة' }[level] || 'إشارة ضعيفة');

  // One status per pair, in words.
  const STATUS = {
    enter: { label: 'ادخل الآن', tone: 'go' }, entered: { label: 'تم الدخول', tone: 'muted' }, wait: { label: 'انتظار', tone: 'wait' },
    watch: { label: 'تحت المراقبة', tone: 'wait' }, ended: { label: 'انتهت الفرصة', tone: 'muted' }, below: { label: 'غير مؤهلة', tone: 'muted' },
    strong: { label: 'فرصة قوية', tone: 'go' }, possible: { label: 'فرصة محتملة', tone: 'go' },
    none: { label: 'لا توجد فرصة', tone: 'muted' }, analyzing: { label: 'تحليل جارٍ', tone: 'muted' }, error: { label: 'تعذر قراءة البيانات', tone: 'warn' },
  };
  const RANK = { enter: 0, strong: 1, possible: 2, wait: 3, watch: 4, below: 5, entered: 6, ended: 7, analyzing: 8, none: 9, error: 10 };

  // ── opportunities: frames, durations, states ───────────────────────────────
  const FRAME = { 5: '5 ثوانٍ', 10: '10 ثوانٍ', 15: '15 ثانية', 30: '30 ثانية', 60: 'دقيقة', 300: '5 دقائق', 900: '15 دقيقة', 1800: '30 دقيقة', 3600: 'ساعة' };
  const frame = (tf) => FRAME[tf] || `${Math.round(tf / 60)} دقيقة`;
  // gen: after a preposition or noun ("بعد انتظار دقيقتين")
  function duration(sec, gen = false) {
    const m = Math.round(sec / 60);
    if (sec < 60) return sec <= 10 ? `${sec} ثوانٍ` : `${sec} ثانية`;
    return m === 1 ? (gen ? 'دقيقة' : 'دقيقة واحدة') : m === 2 ? (gen ? 'دقيقتين' : 'دقيقتان') : m <= 10 ? `${m} دقائق` : `${m} دقيقة`;
  }
  const clock = (sec) => { const s = Math.max(0, Math.round(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const OPP_STATE = {
    ENTER_NOW: 'ادخل الآن', ENTERED: 'تم الدخول', WAIT_FOR_CONFIRMATION: 'انتظار تأكيد', WAIT_FOR_CANDLE_CLOSE: 'انتظار إغلاق الشمعة',
    WAIT_FOR_RETEST: 'انتظار عودة السعر', WAIT_FOR_BREAKOUT: 'انتظار الاختراق', WAIT_FOR_REJECTION: 'انتظار شمعة رفض',
    MISSED_ENTRY: 'فاتت الفرصة', INVALIDATED: 'أُلغيت الفرصة', EXPIRED: 'انتهت الفرصة', NO_SETUP: 'لا توجد فرصة', GATED: 'لم تجتز شروط الدخول',
  };
  const ENTRY_WHY = { setup_close: 'عند إغلاق شمعة الفرصة', strong_setup: 'فرصة قوية — دخول مباشر', confirmed: 'بعد شمعة تأكيد',
    retest: 'بعد عودة السعر لنقطة الدخول', rejection: 'بعد شمعة رفض' };
  const END_WHY = { price_beyond_invalidation: 'السعر تجاوز النقطة التي تلغي الفكرة', new_contradiction: 'ظهر تعارض قوي بعد التحليل الجديد',
    moved_without_us: 'السعر تحرك قبل أن يتوفر دخول مناسب', validity_over: 'لم يظهر تأكيد خلال مدة صلاحية الفرصة', strong_candle_against: 'شمعة قوية عكس الفكرة' };
  const endWhy = (w) => (/^opposite_setup_(\d+)/.test(w || '') ? `ظهرت فرصة عكسية على فريم ${frame(+/(\d+)$/.exec(w)[1])}` : END_WHY[w] || '');
  const ADJ = { fast: 'السوق سريع', slow: 'السوق هادئ', accelerating: 'الحركة تتسارع', level_close: 'منطقة سعرية قريبة' };
  function expiryWhy(ex) {
    if (!ex) return '';
    if (ex.source === 'history') return 'المدة التي أعطت أفضل نتائج سابقة لهذا النوع من الفرص';
    if (ex.source === 'discovered') return 'المدة التي اختُبر عليها النمط';
    const adj = (ex.reason?.adj || []).map((a) => ADJ[a]).filter(Boolean);
    return `تناسب نوع الفرصة على فريم ${frame(ex.reason?.tf)}${adj.length ? ` (${adj.join('، ')})` : ''}`;
  }
  const framesText = (o) => `${frame(o.tf)}${o.timingTf ? ` · التأكيد من ${frame(o.timingTf)}` : ''}${o.alsoOn?.length ? ` · وتؤيدها ${o.alsoOn.map(frame).join(' و')}` : ''}`;
  function waitFor(o) {
    const up = o.dir === 'CALL';
    switch (o.state) {
      case 'WAIT_FOR_CONFIRMATION': return { what: `شمعة ${frame(o.timingTf)} ${up ? 'صاعدة' : 'هابطة'} واضحة`, confirm: `إغلاق شمعة ${frame(o.timingTf)} في اتجاه ${DIR[o.dir]}` };
      case 'WAIT_FOR_RETEST': return { what: 'السعر تحرك بسرعة — ننتظر عودته قرب نقطة الدخول', confirm: 'إغلاق شمعة قريبًا من نقطة الدخول' };
      case 'WAIT_FOR_REJECTION': return { what: 'السعر تحرك عكس الفكرة — ننتظر شمعة رفض', confirm: `شمعة ${up ? 'صاعدة بذيل سفلي' : 'هابطة بذيل علوي'} واضح` };
      case 'WAIT_FOR_CANDLE_CLOSE': return { what: `إغلاق شمعة ${frame(o.tf)} الحالية`, confirm: `أن تُغلق الشمعة وفرصة ${DIR[o.dir]} ما زالت قائمة` };
      case 'WAIT_FOR_BREAKOUT': return { what: `السعر مضغوط عند ${up ? 'أعلى' : 'أسفل'} النطاق`, confirm: `إغلاق شمعة ${frame(o.tf)} ${up ? 'فوق' : 'تحت'} النطاق` };
      default: return null;
    }
  }
  // Entry gate: payout ≥ 92%, plus the calibrated confidence — P(this kind of setup beats
  // break-even), measured on past outcomes — when it has been measured.
  const BLOCK = {
    payout: 'نسبة الربح أقل من المطلوب', payout_unknown: 'نسبة الربح غير معروفة',
    confidence: 'النتائج السابقة لفرص مشابهة لم تتفوق على نقطة التعادل', no_history: 'لا توجد صفقات مشابهة كافية لحساب الثقة بعد',
    no_edge: 'نتائج الفرص المشابهة لا تعطي ربحًا متوقعًا عند نسبة الربح الحالية', insufficient_data: 'لا توجد بيانات تاريخية كافية للحكم عليها',
    no_history_at_duration: 'لا توجد نتائج كافية بهذه المدة', unstable: 'نتائج الفرص المشابهة غير مستقرة عبر الزمن',
    contradiction: 'يوجد تعارض قوي', risk_high: 'المخاطر مرتفعة', data: 'بيانات الزوج غير مكتملة', copy_against: 'إشارات النسخ عكس الفكرة',
    model_rejected: 'نموذج الثقة مرفوض: الفرص التي سمح بها لم تتفوق على نقطة التعادل',
  };
  function blockText(cal) {
    const b = (cal?.blocks || [])[0];
    if (b === 'payout') return `نسبة الربح ${cal.payout}% — المطلوب ${cal.minPayout ?? 92}% أو أكثر`;
    return BLOCK[b] || '';
  }
  // Estimated win probability from similar past opportunities (out-of-sample), or "not established".
  function calText(cal) {
    if (!cal) return null;
    if (!cal.measured && cal.reason !== 'measured' && cal.reason !== 'unstable') return 'غير مؤكدة: لا توجد بيانات تاريخية كافية للحكم عليها';
    if (cal.winProb == null) return `${Math.round(cal.p)}%${cal.oos ? ` من ${Math.round(cal.oos.n)} فرصة مشابهة` : ''}`; // older records
    const iv = cal.interval ? ` (${Math.round(cal.interval[0])}–${Math.round(cal.interval[1])}%)` : '';
    return `احتمال الفوز ${Math.round(cal.winProb)}%${iv} من ${Math.round(cal.n || cal.oos?.n || 0)} فرصة مشابهة${cal.stable === false ? ' — غير مستقر' : ''}`;
  }
  const payoutText = (cal) => (cal?.payout != null ? `${cal.payout}%` : null);
  const MODEL = { COLLECTING: 'يجمع النتائج', OK: 'سليم حتى الآن', CONFIRMED: 'مؤكَّد بالنتائج', REJECTED: 'مرفوض — التداول متوقف' };

  // What the system did with an entry (the worker reports it back to the tab).
  const RISK_FLAG = { COOLDOWN: 'استراحة بعد صفقة خاسرة', LOSS_STREAK: 'خسائر متتالية', MAX_TRADES: 'حد الصفقات اليومي', DAILY_STOP: 'حد الخسارة اليومي',
    PAIR_COOLDOWN: 'تم التداول على الزوج مؤخرًا', DUPLICATE: 'دخول مكرر', MAX_CONCURRENT: 'توجد صفقة مفتوحة بالفعل', PAIR_OPEN: 'صفقة مفتوحة على نفس الزوج',
    EXPOSURE_CONFLICT: 'تعارض على نفس العملة مع صفقة أخرى', TAB_DISCONNECTED: 'التبويب غير متصل', EMERGENCY: 'إيقاف الطوارئ' };
  function actionText(a) {
    if (!a) return null;
    switch (a.action) {
      case 'sent': return { title: 'جاري التنفيذ', tone: 'go', live: true };
      case 'placed': case 'confirmed': return { title: 'تم التنفيذ', tone: 'go', live: true };
      case 'unconfirmed': return { title: 'المنصة لم تؤكد الصفقة', tone: 'bad', why: 'تم إيقاف النظام للاحتياط — راجع المنصة' };
      case 'failed': return { title: 'تعذر التنفيذ', tone: 'bad', why: execState({ status: 'failed', reason: a.detail || '' })?.text.replace(/^تعذر التنفيذ: /, '') };
      case 'shadow': return { title: 'الزوج غير مفتوح للتنفيذ', tone: 'muted', why: 'سُجّلت كصفقة ورقية — افتح هذا الزوج في تبويب مفعّل للتنفيذ' };
      case 'risk': return { title: 'منعتها الحماية', tone: 'muted', why: (a.detail || []).map((c) => RISK_FLAG[c] || c).join('، ') };
      case 'gated': return { title: 'لم تجتز شروط الدخول', tone: 'muted', why: /payout/.test(a.detail || '') ? 'نسبة الربح أقل من المطلوب' : 'لم تعد مؤهلة' };
      case 'paper': return { title: 'صفقة ورقية', tone: 'muted', why: 'وضع المراقبة: لا تنفيذ' };
      case 'alert': return { title: 'تنبيه فقط', tone: 'muted', why: 'وضع التنبيه: القرار لك' };
      case 'manual': return { title: 'بانتظار تأكيدك', tone: 'wait', why: 'أكّد من النافذة قبل انتهاء وقت الدخول', live: true };
      default: return null;
    }
  }

  const copyText = (c) => (!c ? null : c.late ? 'جاءت بعد الحركة' : c.agree ? 'تؤيد الفكرة' : 'عكس الفكرة');

  // The decision for one pair: ENTER (direction, timing, duration, frames, why), WAIT (what for,
  // what confirms, when it ends) or SKIP (why). Same wording in the popup and the in-page panel.
  function decision(p, nowSec, cfg = OTC.DEFAULT_CONFIG) {
    const o = p.opp, rows = [];
    const row = (k, v) => { if (v) rows.push([k, v]); };
    if (o) {
      const f = o.facts || {};
      // Below the calibrated confidence gate (or another final check): not an opportunity to act on.
      if (o.cal && !o.cal.qualified && (o.state === 'GATED' || !['MISSED_ENTRY', 'INVALIDATED', 'EXPIRED', 'ENTERED'].includes(o.state))) {
        row('أقرب فرصة', `${DIR[o.dir]} · ${KIND[o.kind] || 'فرصة'} · فريم ${frame(o.tf)}`);
        row('نسبة الربح', payoutText(o.cal)); row('التقدير من البيانات', calText(o.cal)); row('السبب', blockText(o.cal));
        return { key: 'below', ...STATUS.below, verdict: 'SKIP', dir: o.dir, title: 'لا توجد فرصة مؤهلة', rows, timer: null, facts: f, p: o.cal.p };
      }
      if (o.state === 'ENTERED' && o.entry) {
        const win = OTC.entryWindow(cfg, o.entry.tf || o.tf), left = o.entry.time + win - nowSec, end = o.entry.time + (o.expiry?.sec || 0) - nowSec;
        if (left > 0 || end > 0) {
          row('التوقيت', ENTRY_WHY[o.entry.why] || 'عند إغلاق الشمعة');
          row('المدة', o.expiry ? `${duration(o.expiry.sec)} — ${expiryWhy(o.expiry)}` : null);
          row('الفريم', framesText(o)); row('نوع الفرصة', KIND[o.kind] || 'فرصة'); row('نسبة الربح', payoutText(o.cal)); row('التقدير من البيانات', calText(o.cal)); row('إشارات النسخ', copyText(o.copy || f.copy));
          // what the system really did with it, when known — never a bare "enter now" for an entry it won't place
          const act = actionText(o.action);
          if (act && !act.live) {
            rows.unshift(['التنفيذ', act.why]);
            return { key: 'entered', ...STATUS.entered, label: act.title, tone: act.tone === 'bad' ? 'warn' : 'muted', verdict: 'ENTER', dir: o.dir, title: act.title, rows, timer: null, facts: f };
          }
          if (act) return { key: left > 0 ? 'enter' : 'entered', ...STATUS.entered, label: act.title, tone: 'go', verdict: 'ENTER', dir: o.dir, title: act.title, rows,
            timer: end > 0 ? { label: 'تنتهي الصفقة خلال', sec: end } : null, facts: f };
          return left > 0 ? { key: 'enter', ...STATUS.enter, verdict: 'ENTER', dir: o.dir, title: 'ادخل الآن', rows, timer: { label: 'متبقٍ للدخول', sec: left }, facts: f }
            : { key: 'entered', ...STATUS.entered, verdict: 'ENTER', dir: o.dir, title: 'تم الدخول', rows, timer: end > 0 ? { label: 'تنتهي الصفقة خلال', sec: end } : null, facts: f };
        }
      } else if (['WAIT_FOR_CONFIRMATION', 'WAIT_FOR_RETEST', 'WAIT_FOR_REJECTION', 'CONFIRMED'].includes(o.state)) {
        const w = waitFor(o);
        row('ننتظر', w?.what); row('ما يؤكدها', w?.confirm); row('الفريم', framesText(o)); row('نوع الفرصة', KIND[o.kind] || 'فرصة');
        row('نسبة الربح', payoutText(o.cal)); row('التقدير من البيانات', calText(o.cal)); row('إشارات النسخ', copyText(o.copy || f.copy));
        return { key: 'wait', ...STATUS.wait, label: OPP_STATE[o.state], verdict: 'WAIT', dir: o.dir, title: OPP_STATE[o.state], rows,
          timer: { label: 'تنتهي صلاحيتها خلال', sec: o.expiresAt - nowSec }, facts: f };
      } else if (['MISSED_ENTRY', 'INVALIDATED', 'EXPIRED'].includes(o.state)) {
        row('السبب', endWhy(o.why)); row('الفريم', framesText(o));
        return { key: 'ended', ...STATUS.ended, label: OPP_STATE[o.state], verdict: 'SKIP', dir: o.dir, title: OPP_STATE[o.state], rows, timer: null, facts: f };
      }
    }
    if (p.watch) {
      const w = waitFor(p.watch);
      row('ننتظر', w?.what); row('ما يؤكدها', w?.confirm); row('الفريم', frame(p.watch.tf));
      return { key: 'watch', ...STATUS.watch, label: OPP_STATE[p.watch.state], verdict: 'WAIT', dir: p.watch.dir, title: OPP_STATE[p.watch.state], rows,
        timer: { label: 'تُغلق الشمعة خلال', sec: p.watch.closesAt - nowSec }, facts: p.last?.facts || null };
    }
    const st = pairStatus({ ...p, opp: null, watch: null }, nowSec);
    const f = p.last?.facts;
    if (st.key === 'analyzing' || st.key === 'error') return { ...st, verdict: null, title: st.label, rows, timer: null, facts: f || null };
    row('السبب', p.last?.conflict ? 'الفريمات متعارضة: فرصة في اتجاه وفرصة عكسها' : p.last?.unclear ? 'الفريم غير واضح الآن (حركة عشوائية أو شموع ضعيفة)' : skipReason(f));
    return { ...st, key: 'none', tone: 'muted', label: STATUS.none.label, verdict: 'SKIP', title: 'لا توجد فرصة الآن', rows, timer: null, facts: f || null };
  }

  // Trend per frame, largest first (older records only have the fixed 1H/15M/5M roles).
  const trendRows = (f) => (f?.trend ? Object.entries(f.trend).sort((a, b) => b[0] - a[0]).map(([tf, d]) => [frame(+tf), TREND[d] || 'غير متاح'])
    : [60, 15, 5].map((k) => [TF[k], TREND[f?.tf?.[k]] || 'غير متاح']));

  function pairStatus(p, nowSec) {
    if (p.feed?.dqOk === false && !p.opp) return { key: 'error', ...STATUS.error };
    if (p.opp || p.watch) {
      const d = decision(p, nowSec);
      if (d.key !== 'none') return { key: d.key, label: d.label, tone: d.tone, dir: d.dir };
    }
    const L = p.last;
    if (!L || !L.facts) return { key: 'analyzing', ...STATUS.analyzing };
    const tf = L.tf || 300, fresh = L.candleTime != null && nowSec - (L.candleTime + tf) < Math.max(tf, 120);
    const f = L.facts;
    if (fresh && L.decision !== 'SKIP' && !L.conflict) return { key: f.level === 'high' ? 'strong' : 'possible', ...STATUS[f.level === 'high' ? 'strong' : 'possible'], dir: L.decision };
    const soft = f.skip.every((c) => ['weak', 'scanner', 'no_setup', 'timing', 'other'].includes(c));
    if (fresh && f.dir && soft && f.conf >= 50 && ['DEEP', 'WATCH'].includes(p.scan?.status)) return { key: 'wait', ...STATUS.wait, label: 'ميل ضعيف', dir: f.dir };
    return { key: 'none', ...STATUS.none };
  }

  // "لماذا؟" — what supports the idea, and what argues against it.
  const RISK = {
    htf_conflict: 'الاتجاهات الزمنية الأكبر عكس الفكرة', h1_against: 'اتجاه الساعة عكس الفكرة', m15_against: 'اتجاه 15 دقيقة عكس الفكرة',
    level_close: (d) => (d === 'CALL' ? 'توجد مقاومة قريبة جدًا' : 'يوجد دعم قريب جدًا'), level_near: (d) => (d === 'CALL' ? 'توجد مقاومة قريبة' : 'يوجد دعم قريب'),
    round: 'رقم سعري دائري قريب', momentum_against: 'الحركة الحالية عكس الفكرة', momentum_weak: 'الحركة ضعيفة', exhausted: 'الحركة ممتدة وقد تكون منهكة',
    stretched: 'السعر ممتد في اتجاه الفكرة', late: 'الدخول متأخر بعد حركة كبيرة', candle_against: 'آخر شمعة عكس الفكرة', volatility: 'التذبذب أعلى من المعتاد',
    abnormal: 'حركة غير طبيعية في السعر', conflict: 'الاستراتيجيات متعارضة', conflict_soft: 'بعض الإشارات تعارض الفكرة',
    confluence_against: 'أغلب الأدلة عكس الفكرة', evidence_against: 'بعض الأدلة عكس الفكرة', signal_against: 'إشارة المنصة عكس الفكرة',
    m1_against: 'شمعة الدقيقة الأخيرة عكس الفكرة', data: 'بيانات الفريمات الأكبر غير مكتملة',
  };
  const riskText = (r, dir) => { const t = RISK[r.code]; return typeof t === 'function' ? t(dir) : t || null; };

  function why(f) {
    const good = [], bad = [];
    if (!f || !f.dir) return { good, bad };
    if (f.align === 'high') good.push('الاتجاه العام متوافق');
    else if (f.align === 'mid') good.push('الاتجاه العام لا يعارض');
    if (f.zone === 'level') good.push(f.dir === 'CALL' ? 'السعر ارتد من منطقة دعم' : 'السعر ارتد من منطقة مقاومة');
    else if (f.zone === 'band') good.push('السعر عند طرف نطاق حركته');
    else if (f.zone === 'fib') good.push('السعر في منطقة تصحيح مناسبة');
    if (f.momentum === 'with') good.push('الحركة الحالية تؤكد الاتجاه');
    if (f.pattern) good.push(`تأكيد من الشموع: ${PATTERN[f.pattern] || 'نموذج سعري'}`);
    for (const r of f.risks) { const t = riskText(r, f.dir); if (t && !bad.includes(t)) bad.push(t); }
    if (f.align === 'low' && !f.risks.some((r) => /htf|h1|m15/.test(r.code))) bad.push('الاتجاهات الزمنية غير متوافقة');
    if (f.momentum === 'weak' && !bad.includes(RISK.momentum_weak)) bad.push(RISK.momentum_weak);
    if (!f.risks.some((r) => r.severity === 'high' || r.hard)) good.push('لا يوجد تعارض قوي');
    return { good: good.slice(0, 4), bad: bad.slice(0, 4) };
  }

  // The main reason for waiting, in one line.
  const SKIP = {
    data: 'بيانات الزوج غير مكتملة الآن', regime: 'حالة السوق الحالية لا تناسب أي نموذج', no_setup: 'لا يوجد نموذج واضح',
    weak: 'التوافق غير كافٍ بعد', scanner: 'الإشارة ليست قوية بما يكفي', timing: 'فات وقت الدخول لهذه الشمعة', conflict: 'الإشارات متعارضة',
    htf_conflict: 'الاتجاهات الزمنية الأكبر عكس الفكرة', level: 'منطقة سعرية قوية تعترض الحركة', late: 'الحركة ممتدة والدخول متأخر',
    filter: 'ظرف ثبت تاريخيًا أن نتائجه ضعيفة', risk: 'حدود الحماية تمنع صفقة جديدة الآن', other: 'لا توجد فرصة مناسبة',
  };
  const ORDER = ['risk', 'data', 'filter', 'htf_conflict', 'conflict', 'level', 'late', 'timing', 'regime', 'no_setup', 'weak', 'scanner', 'other'];
  const skipReason = (f) => SKIP[ORDER.find((c) => f?.skip?.includes(c)) || 'other'];

  const ZONE = { level: (d) => (d === 'CALL' ? 'عند منطقة دعم' : 'عند منطقة مقاومة'), band: () => 'عند طرف النطاق', fib: () => 'في منطقة تصحيح',
    opposing: (d) => (d === 'CALL' ? 'قريب من مقاومة' : 'قريب من دعم'), open: () => 'بعيد عن المستويات المهمة' };
  const MOMENTUM = { with: 'متوافقة', weak: 'ضعيفة', against: 'عكسية' };
  const ALIGN = { high: 'مرتفع', mid: 'متوسط', low: 'ضعيف' };

  function timing(L, nowSec, entryWindowSec = 30) {
    if (!L || L.decision === 'SKIP' || L.candleTime == null) return null;
    const tf = L.tf || 300, elapsed = nowSec - (L.candleTime + tf);
    if (elapsed <= entryWindowSec) return { ok: true, text: 'جاهز للدخول', left: Math.max(0, Math.round(entryWindowSec - elapsed)) };
    return { ok: false, text: elapsed < tf ? 'فات وقت الدخول — انتظار الشمعة القادمة' : 'انتهت الفرصة' };
  }

  // Relative time, with Arabic number agreement.
  function unit(n, one, two, few, many) { return n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`; }
  function ago(sec) {
    if (sec == null || !Number.isFinite(sec)) return 'لا يوجد';
    if (sec < 45) return 'منذ لحظات';
    const m = Math.round(sec / 60);
    if (m < 60) return `منذ ${unit(m, 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة')}`;
    const h = Math.round(m / 60);
    if (h < 24) return `منذ ${unit(h, 'ساعة', 'ساعتين', 'ساعات', 'ساعة')}`;
    const d = Math.round(h / 24);
    return `منذ ${unit(d, 'يوم', 'يومين', 'أيام', 'يومًا')}`;
  }
  const count = (n, one, two, few, many) => (n === 0 ? `لا ${many}` : unit(n, one, two, few, many));

  const RESULT = { W: { text: 'نجاح', tone: 'go' }, L: { text: 'خسارة', tone: 'bad' }, T: { text: 'تعادل', tone: 'muted' } };

  function execState(ex) {
    if (!ex) return null;
    if (ex.status === 'sent') return { text: 'جاري التنفيذ', tone: 'wait' };
    if (ex.status === 'placed' || ex.status === 'confirmed') return { text: 'تم التنفيذ', tone: 'go' };
    if (ex.status === 'unconfirmed') return { text: 'المنصة لم تؤكد الصفقة — تم إيقاف النظام للاحتياط', tone: 'bad' };
    if (ex.status === 'failed') {
      const r = ex.reason || '';
      const why = /not armed/.test(r) ? 'التبويب غير مفعّل للتنفيذ' : /could not open|asset (menu|list)|chart did not switch/.test(r) ? 'تعذر فتح الزوج من قائمة المنصة'
        : /chart shows/.test(r) ? 'الشارت يعرض زوجًا آخر'
        : /Demo-only/.test(r) ? 'التنفيذ مسموح على الحساب التجريبي فقط' : /window|timing|chasing|opposite/.test(r) ? 'فات وقت الدخول'
        : /expiry/.test(r) ? 'تعذر ضبط مدة الصفقة' : /amount/.test(r) ? 'تعذر ضبط مبلغ الصفقة' : /payout/.test(r) ? 'نسبة الربح أقل من الحد' : 'تعذر التواصل مع المنصة';
      return { text: `تعذر التنفيذ: ${why}`, tone: 'bad' };
    }
    return null;
  }

  // Discovered strategies, without ids or jargon.
  const GROUP = { price: 'سلوك الشمعة', sequence: 'تسلسل الشموع', pattern: 'نموذج شموع', structure: 'هيكل السوق', liquidity: 'سحب سيولة', breakout: 'اختراق',
    trend: 'الاتجاه', momentum: 'الزخم', divergence: 'انحراف المؤشرات', volatility: 'التذبذب', bollinger: 'حدود الحركة', fibonacci: 'التصحيح', sr: 'الدعم والمقاومة',
    time: 'التوقيت', context: 'حالة السوق', engine: 'قرار المحرك', pair: 'زوج محدد', strategy: 'استراتيجيات مجمعة' };
  function discName(row) {
    const groups = [];
    for (const a of row.rule?.all || []) {
      const g = OTC.FeatureLib?.groupOf ? OTC.FeatureLib.groupOf(a) : null;
      const t = GROUP[g];
      if (t && !groups.includes(t)) groups.push(t);
    }
    const head = row.type === 'FILTER' ? `تجنّب ${DIR[row.direction]}` : `نمط ${DIR[row.direction]}`;
    return `${head}: ${groups.slice(0, 3).join(' + ') || 'شروط مركبة'}`;
  }
  const DISC_STATUS = {
    PAPER_TEST: { text: 'قيد الاختبار', tone: 'wait', note: 'النمط ما زال تحت الاختبار على بيانات حية.' },
    WATCHLIST: { text: 'تم التحقق', tone: 'go', note: 'اجتاز الاختبار ويحتاج قرارك لاعتماده.' },
    PROMOTED: { text: 'معتمد', tone: 'go', note: 'مفعّل ضمن الاستراتيجيات المستخدمة.' },
    DECAYING: { text: 'تراجع أداؤه', tone: 'bad', note: 'تراجعت نتائجه مؤخرًا فتوقف استخدامه.' },
    SUSPENDED: { text: 'متوقف', tone: 'muted', note: 'أوقفته يدويًا.' },
    UNSTABLE: { text: 'غير مستقر', tone: 'bad', note: 'نتائجه تتغير كثيرًا بين الفترات.' },
    VALIDATING: { text: 'ينتظر بيانات', tone: 'muted', note: 'يحتاج بيانات أكثر قبل الحكم عليه.' },
    OUT_OF_SAMPLE: { text: 'ينتظر بيانات', tone: 'muted', note: 'يحتاج بيانات أكثر قبل الحكم عليه.' },
    REJECTED: { text: 'مرفوض', tone: 'muted', note: 'لم يصمد أمام الاختبار.' },
    OVERFIT: { text: 'مرفوض', tone: 'muted', note: 'يبدو مطابقًا للماضي فقط.' },
    INSUFFICIENT_DATA: { text: 'بيانات غير كافية', tone: 'muted', note: 'عدد الحالات قليل جدًا.' },
  };
  function bestUse(row) {
    const r = row.regime?.length ? row.regime : row.regimes_covered || [];
    return r.length ? r.map((x) => REGIME[x] || x).join('، ') : 'ظروف السوق المختلفة';
  }

  // Arabic names for every library strategy (shown only when details are opened).
  const STRATEGY = {
    trend_following: 'متابعة الاتجاه', trend_continuation: 'استمرار الاتجاه', trend_pullback: 'ارتداد مع الاتجاه', ema_pullback: 'ارتداد إلى المتوسط',
    ma_alignment: 'ترتيب المتوسطات', momentum_continuation: 'استمرار الزخم', htf_trend_continuation: 'استمرار اتجاه الفريم الأكبر',
    range_breakout: 'اختراق النطاق', resistance_breakout: 'اختراق مقاومة', support_breakout: 'كسر دعم', trendline_breakout: 'كسر خط اتجاه',
    breakout_retest: 'اختراق وإعادة اختبار', compression_breakout: 'اختراق بعد انضغاط', momentum_breakout: 'اختراق بزخم',
    support_reversal: 'ارتداد من دعم', resistance_reversal: 'ارتداد من مقاومة', exhaustion_reversal: 'انعكاس بعد إنهاك', rsi_divergence: 'انحراف RSI',
    macd_divergence: 'انحراف MACD', liquidity_sweep_reversal: 'انعكاس بعد سحب سيولة', failed_breakout_reversal: 'انعكاس بعد اختراق فاشل', choch_reversal: 'تغيّر طبيعة الحركة',
    range_bounce: 'ارتداد داخل نطاق', support_bounce: 'ارتداد من دعم داخل نطاق', resistance_rejection: 'رفض عند مقاومة', mean_reversion: 'العودة إلى المتوسط',
    range_liquidity_sweep: 'سحب سيولة داخل نطاق', bullish_engulfing: 'ابتلاع شرائي', bearish_engulfing: 'ابتلاع بيعي', pin_bar: 'شمعة رفض', hammer: 'المطرقة',
    shooting_star: 'النجم الساقط', doji_rejection: 'دوجي رفض', outside_bar: 'شمعة خارجية', morning_star: 'نجمة الصباح', evening_star: 'نجمة المساء',
    tweezer_bottom: 'قاع مزدوج قصير', tweezer_top: 'قمة مزدوجة قصيرة', long_wick_rejection: 'ذيل رفض طويل', inside_bar_break: 'كسر شمعة داخلية',
    strong_body_continuation: 'استمرار بشمعة قوية', bos_continuation: 'كسر هيكل مع الاتجاه', bos_retest: 'إعادة اختبار كسر الهيكل', hh_hl_continuation: 'قمم وقيعان صاعدة',
    lh_ll_continuation: 'قمم وقيعان هابطة', swing_failure: 'فشل قمة أو قاع', liquidity_sweep: 'سحب سيولة القمم أو القيعان', ema_rsi: 'المتوسطات مع RSI',
    ema_macd: 'المتوسطات مع MACD', ema_bollinger: 'المتوسطات مع بولينجر', rsi_sr: 'RSI عند دعم أو مقاومة', macd_structure: 'MACD مع هيكل السوق',
    fib_structure: 'فيبوناتشي مع هيكل السوق', bollinger_pa: 'بولينجر مع الشموع', rsi_div_structure: 'انحراف RSI مع هيكل السوق', ema_fib_pa: 'المتوسطات وفيبوناتشي والشموع',
    fib_382: 'تصحيح 38.2', fib_500: 'تصحيح 50', fib_618: 'تصحيح 61.8', fib_786: 'تصحيح 78.6', fib_support: 'فيبوناتشي عند دعم', fib_resistance: 'فيبوناتشي عند مقاومة',
    fib_trend_pullback: 'تصحيح فيبوناتشي مع الاتجاه', bb_band_rejection: 'رفض عند حد بولينجر', bb_band_breakout: 'اختراق حد بولينجر', bb_squeeze: 'انضغاط بولينجر',
    bb_expansion: 'اتساع بولينجر', bb_mean_reversion: 'العودة لمتوسط بولينجر', bb_trend_continuation: 'استمرار الاتجاه مع بولينجر', rsi_momentum: 'زخم RSI',
    macd_momentum: 'زخم MACD', stoch_momentum: 'زخم الاستوكاستك', roc_momentum: 'زخم معدل التغير', candle_momentum: 'زخم الشموع',
    consecutive_candle_momentum: 'شموع متتالية', momentum_acceleration: 'تسارع الزخم', momentum_exhaustion: 'إنهاك الزخم',
  };
  const strategyName = (id) => (/^DISC-/.test(id) ? 'نمط مكتشف' : STRATEGY[id] || 'استراتيجية');


  // ── conditions of discovered strategies, in Arabic ─────────────────────────
  const TFW = { 1: 'دقيقة', 5: '5د', 15: '15د', 60: 'ساعة' };
  const NAME = {
    color: 'لون الشمعة', body_atr: 'حجم جسم الشمعة', upper_wick: 'الذيل العلوي', lower_wick: 'الذيل السفلي', range_atr: 'مدى الشمعة', body_ratio: 'نسبة الجسم إلى المدى',
    close_pos: 'موقع الإغلاق داخل الشمعة', run_green: 'شموع صاعدة متتالية', run_red: 'شموع هابطة متتالية', prev_rel: 'العلاقة بالشمعة السابقة',
    chg1_atr: 'تغير آخر شمعة', chg3_atr: 'تغير آخر 3 شموع', chg1_bp: 'تغير آخر شمعة بالنقاط', accel: 'تسارع الحركة',
    dir: 'الاتجاه', order: 'ترتيب المتوسطات', slope21: 'ميل EMA21', dist_e21: 'البعد عن EMA21', dist_e9: 'البعد عن EMA9', dist_e18: 'البعد عن EMA18',
    dist_e24: 'البعد عن EMA24', dist_e50: 'البعد عن EMA50', dist_e200: 'البعد عن EMA200', sep: 'تباعد المتوسطات', sep_change: 'تغير تباعد المتوسطات',
    cross: 'تقاطع EMA9/21', adx: 'قوة الاتجاه ADX', er: 'كفاءة الحركة', trend: 'هيكل السوق', last: 'آخر قمة أو قاع', bos: 'كسر الهيكل', choch: 'تغير طبيعة الحركة',
    sweep: 'سحب سيولة', sfp: 'فشل قمة أو قاع', sweep_confirmed: 'سحب سيولة مؤكد', equal_levels_taken: 'سحب قمم أو قيعان متساوية', breakout: 'حالة الاختراق',
    breakout_ext: 'امتداد الاختراق', compression: 'انضغاط السعر', trendline: 'كسر خط اتجاه', rsi: 'RSI', rsi_zone: 'منطقة RSI', rsi_slope: 'ميل RSI',
    rsi_cross50: 'عبور RSI لمستوى 50', macd_hist_atr: 'هيستوجرام MACD', macd_slope: 'اتجاه MACD', macd_flip: 'انقلاب MACD', stoch_k: 'مؤشر Stochastic',
    stoch_cross: 'تقاطع Stochastic', roc_cross: 'عبور ROC للصفر', decel: 'تباطؤ الزخم', weak_up: 'ضعف الزخم الصاعد', weak_down: 'ضعف الزخم الهابط',
    exh_up: 'إنهاك الصعود', exh_down: 'إنهاك الهبوط', recover_up: 'تعافي الزخم صعودًا', recover_down: 'تراجع الزخم', atr_pct: 'ترتيب التذبذب الحالي',
    atr_ratio: 'التذبذب مقارنة بالمعتاد', range5: 'متوسط مدى آخر 5 شموع', state: 'حالة التذبذب', abnormal: 'شمعة غير طبيعية', atr_bp: 'تذبذب الزوج',
    width_pct: 'عرض نطاق بولينجر', width_trend: 'حركة نطاق بولينجر', squeeze: 'انضغاط بولينجر', squeeze_recent: 'انضغاط بولينجر حديث', pctb: 'الموقع داخل بولينجر',
    dist_upper: 'البعد عن حد بولينجر العلوي', dist_lower: 'البعد عن حد بولينجر السفلي', touch_upper: 'لمس حد بولينجر العلوي', touch_lower: 'لمس حد بولينجر السفلي',
    reject_upper: 'رفض عند حد بولينجر العلوي', reject_lower: 'رفض عند حد بولينجر السفلي', break_upper: 'إغلاق فوق حد بولينجر', break_lower: 'إغلاق تحت حد بولينجر',
    crossed_mid: 'عبور منتصف بولينجر', leg: 'آخر موجة', zone: 'منطقة التصحيح', depth: 'عمق التصحيح', dist_236: 'البعد عن مستوى 23.6', dist_382: 'البعد عن مستوى 38.2',
    dist_500: 'البعد عن مستوى 50', dist_618: 'البعد عن مستوى 61.8', dist_786: 'البعد عن مستوى 78.6', on_sr: 'مستوى فيبوناتشي على دعم أو مقاومة',
    with_structure: 'الموجة مع هيكل السوق', dist_sup: 'البعد عن الدعم', dist_res: 'البعد عن المقاومة', sup_touches: 'عدد لمسات الدعم', res_touches: 'عدد لمسات المقاومة',
    sup_strength: 'قوة الدعم', res_strength: 'قوة المقاومة', touched_sup: 'ارتداد من دعم', touched_res: 'ارتداد من مقاومة', broke_res: 'اختراق مقاومة', broke_sup: 'كسر دعم',
    psych_above: 'البعد عن رقم دائري أعلى', psych_below: 'البعد عن رقم دائري أسفل', rej_bull: 'رفض شرائي', rej_bear: 'رفض بيعي',
    hour: 'الساعة (UTC)', session: 'الجلسة', min15: 'ربع الساعة', dow: 'يوم الأسبوع', pos15: 'ترتيب الشمعة داخل 15 دقيقة', pos60: 'ترتيب الشمعة داخل الساعة',
    regime: 'حالة السوق', htf: 'توافق الفريمات', scanner: 'درجة الماسح', decision: 'قرار المحرك', lean: 'ميل المحرك', deep: 'ثقة المحرك',
  };
  const VAL = {
    UP: 'صاعد', DOWN: 'هابط', FLAT: 'عرضي', BULL: 'صاعد', BEAR: 'هابط', RANGE: 'نطاق', UNCLEAR: 'غير واضح', MIXED: 'متداخل', CALL: 'شراء', PUT: 'بيع',
    NEUTRAL: 'محايد', none: 'لا يوجد', SKIP: 'انتظار', G: 'صاعدة', R: 'هابطة', D: 'دوجي', OS: 'تشبع بيعي', LOW: 'منخفضة', MID: 'محايدة', HIGH: 'مرتفعة', OB: 'تشبع شرائي',
    HH: 'قمة أعلى', HL: 'قاع أعلى', LH: 'قمة أدنى', LL: 'قاع أدنى', EXPANDING: 'يتسع', CONTRACTING: 'يضيق', STEADY: 'ثابت', NORMAL: 'عادية', UNKNOWN: 'غير معروفة',
    outside: 'تبتلعها', inside: 'داخلها', closed_above: 'أغلقت فوقها', closed_below: 'أغلقت تحتها', overlap: 'متداخلة',
    ALL_UP: 'كلها صاعدة', ALL_DOWN: 'كلها هابطة', HTF_UP: 'الأكبر صاعد', HTF_DOWN: 'الأكبر هابط', HTF_CONFLICT: 'الأكبر متعارض', HTF_FLAT: 'الأكبر عرضي',
    REAL_UP: 'اختراق صاعد حقيقي', REAL_DN: 'اختراق هابط حقيقي', WEAK_UP: 'اختراق صاعد ضعيف', WEAK_DN: 'اختراق هابط ضعيف', FALSE_UP: 'اختراق صاعد فاشل',
    FALSE_DN: 'اختراق هابط فاشل', RETEST_UP: 'إعادة اختبار صاعدة', RETEST_DN: 'إعادة اختبار هابطة',
    Asia: 'آسيا', London: 'لندن', 'London/NY': 'لندن/نيويورك', 'New York': 'نيويورك', Late: 'متأخرة',
    Sun: 'الأحد', Mon: 'الاثنين', Tue: 'الثلاثاء', Wed: 'الأربعاء', Thu: 'الخميس', Fri: 'الجمعة', Sat: 'السبت',
  };
  const SEQ = { 'U+': 'صاعدة قوية', U: 'صاعدة', N: 'دوجي', D: 'هابطة', 'D+': 'هابطة قوية' };
  const OPS = { '<=': '≤', '>=': '≥', '==': '=', '!=': '≠' };
  function featName(id) {
    if (id.startsWith('strat.')) return `ظهور «${strategyName(id.slice(6))}»`;
    if (id.startsWith('pa.')) {
      const k = id.slice(3), dirAr = /^(pin|doji_rej|outside|lwr|strong)_bull/.test(k) ? 'شرائي' : /^(pin|doji_rej|outside|lwr|strong)_bear/.test(k) ? 'بيعي' : '';
      const base = { bull_engulf: 'bullish_engulfing', bear_engulf: 'bearish_engulfing', pin_bull: 'pin_bar', pin_bear: 'pin_bar', doji_rej_bull: 'doji_rejection', doji_rej_bear: 'doji_rejection',
        outside_bull: 'outside_bar', outside_bear: 'outside_bar', lwr_bull: 'long_wick_rejection', lwr_bear: 'long_wick_rejection', strong_bull: 'strong_body', strong_bear: 'strong_body' }[k] || k;
      if (k === 'bull_rejection') return 'رفض شرائي في شمعة 5د';
      if (k === 'bear_rejection') return 'رفض بيعي في شمعة 5د';
      return `${PATTERN[base] || 'نموذج شموع'}${dirAr && !/(شرائي|بيعي)$/.test(PATTERN[base] || '') ? ` ${dirAr}` : ''} (5د)`;
    }
    if (id === 'pair') return 'الزوج';
    if (id === 'seq2') return 'آخر شمعتين';
    if (id === 'seq3') return 'آخر 3 شموع';
    if (id === 'd5.rsi') return 'انحراف RSI (5د)';
    if (id === 'd5.macd') return 'انحراف MACD (5د)';
    const [pre, key] = id.split('.');
    const tf = pre === 'rH' ? 'الفريم الأكبر' : TFW[(pre.match(/\d+/) || [])[0]];
    const n = NAME[key] || key;
    return tf && !['time', 'ctx', 'eng', 'r', 'pair'].includes(pre) ? `${n} (${tf})` : n;
  }
  function featValue(id, v) {
    if (typeof v === 'number') return String(+v.toFixed(3));
    if (typeof v === 'boolean') return v ? 'نعم' : 'لا';
    if (id === 'ctx.regime') return REGIME[v] || v;
    if (id === 'pair') return pair(v);
    if (id === 'seq2' || id === 'seq3') return String(v).split(',').map((x) => SEQ[x] || x).join(' ← ');
    return VAL[v] || v;
  }
  function condLabel(a) {
    if (a.or) return `(${a.or.map(condLabel).join(' أو ')})`;
    const f = OTC.FeatureLib?.get(a.f), name = featName(a.f);
    if (f?.type === 'bool') return a.v ? name : `ليس: ${name}`;
    if (a.op === 'between') return `${name} بين ${featValue(a.f, a.v[0])} و${featValue(a.f, a.v[1])}`;
    return `${name} ${OPS[a.op] || a.op} ${featValue(a.f, a.v)}`;
  }

  // Arabic explanation and limitations for a stored discovered strategy (built from its numbers).
  const ORIGIN = { discovery: 'البحث المفتوح', combination: 'دمج استراتيجيات', variation: 'تعديل استراتيجية موجودة', mutation: 'تعديل نمط سابق',
    simplification: 'تبسيط نمط', specialisation: 'تخصيص نمط', 'negative-refinement': 'إضافة شرط تجنّب', 'filter-discovery': 'البحث عن ظروف ضعيفة', reevaluation: 'إعادة تقييم' };
  const p1 = (x) => (x == null || !Number.isFinite(x) ? '–' : `${x.toFixed(1)}%`);
  function discExplain(r) {
    const c = (r.rule?.all || []).map(condLabel), neg = (r.rule?.none || []).map(condLabel), t = r.training_results || {};
    const lines = [`اكتُشف عبر ${ORIGIN[r.origin] || r.origin}${r.mutation ? ` (${r.mutation})` : ''}.`];
    if (r.type === 'FILTER') lines.push(`عندما أراد المحرك ${DIR[r.direction]} وتحققت الشروط، نجحت تلك الصفقات في ${p1(t.wr)} من ${t.n ?? 0} في فترة التدريب، مقابل ${p1(r.complement?.train?.wr)} لباقي صفقاته.`);
    else lines.push(`عندما تتحقق الشروط${neg.length ? ' ولا تتحقق شروط التجنّب' : ''}، نجحت صفقة ${DIR[r.direction]} بمدة ${r.expiry * 5} دقائق في ${p1(t.wr)} من ${t.n ?? 0} صفقة تدريب غير متداخلة (النطاق المرجّح ${p1(t.lo)}–${p1(t.hi)})، ونقطة التعادل ${p1(t.be)}${r.baseline != null ? `، بينما كانت نسبة نجاح أي صفقة ${DIR[r.direction]} في نفس الفترة ${p1(r.baseline)}` : ''}.`);
    lines.push('هذه علاقة إحصائية غير معتادة في بيانات سابقة، وليست سببًا مؤكدًا.');
    const v = r.validation_results, o = r.out_of_sample_results;
    lines.push(`التحقق: ${v?.n ? `${p1(v.wr)} من ${v.n}` : 'لا توجد بيانات'} · خارج العينة: ${o?.n ? `${p1(o.wr)} من ${o.n}` : 'لا توجد بيانات'}.`);
    if (r.paper_results?.n) lines.push(`الاختبار الحي (ورقي): ${p1(r.paper_results.wr)} من ${r.paper_results.n}.`);
    return { conditions: c, negatives: neg, text: lines.join('\n') };
  }
  const FLAG = { SMALL_SAMPLE: 'العينة صغيرة.', SINGLE_PAIR: 'يعمل على زوج واحد فقط.', UNTESTED_ACROSS_PAIRS: 'لم يُختبر على أزواج أخرى.',
    SAME_AS_LIBRARY: 'يظهر تقريبًا في نفس أوقات استراتيجية موجودة، فقد لا يكون جديدًا.', NEGATIVE_CONFIRMED_ON_VALIDATION: 'شرط التجنّب أُكّد على فترة التحقق، فلم تعد مستقلة لهذه النسخة.',
    ASYMMETRIC: 'النسخة المعاكسة من النمط تتصرف بشكل مختلف.', FRAGILE_PARAMS: 'ينهار عند تحريك العتبات قليلًا.', OOS_COLLAPSE: 'انهار خارج العينة.',
    NARROW_PERIOD: 'نجح في فترة ضيقة فقط.', EXCESSIVE_CONDITIONS: 'شروط أكثر من اللازم.' };
  function discLimitations(r) {
    const out = ['علاقة في بيانات سابقة فقط، ولا شيء هنا يضمن النتائج المستقبلية.', 'الاختبار التاريخي يفترض الدخول عند إغلاق الشمعة، ولا يحاكي تأخر الدخول.'];
    if (['INSUFFICIENT', 'PRELIMINARY'].includes(r.sample_class)) out.push(`حجم العينة ${r.sample_class === 'INSUFFICIENT' ? 'غير كافٍ' : 'أولي'} (${r.sample_size} صفقة تدريب).`);
    for (const f of r.flags || []) if (FLAG[f]) out.push(FLAG[f]);
    return out;
  }
  G.AR = { DIR, REGIME, TREND, TF, KIND, PATTERN, STATUS, RANK, RISK, FRAME, OPP_STATE, ENTRY_WHY, frame, duration, clock, decision, expiryWhy, endWhy, framesText, waitFor, trendRows, calText, blockText, BLOCK, MODEL, actionText, RISK_FLAG, SKIP, ZONE, MOMENTUM, ALIGN, RESULT, DISC_STATUS, STRATEGY, GROUP,
    pair, conf, pairStatus, why, skipReason, timing, ago, count, execState, discName, bestUse, strategyName, condLabel, featName, discExplain, discLimitations, ORIGIN,
    dir: (d) => DIR[d] || 'انتظار', regime: (r) => REGIME[r] || 'غير واضح', trend: (t) => TREND[t] || 'غير متاح', kind: (k) => KIND[k] || 'فرصة' };
})(typeof globalThis !== 'undefined' ? globalThis : this);
