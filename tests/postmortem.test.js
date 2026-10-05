// Loss review: each losing trade gets its most likely reason, and each strategy its win rate at every duration.
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load.js');

const { OTC } = load();
const P = OTC.PostMortem;
const T0 = 1_790_000_000;
// a CALL from price 1.0000 with the prices `path` (seconds → price) after the signal
const rec = (path, extra = {}) => ({ id: `opp|X|${extra.ts || T0}`, kind: 'opp', state: 'ENTERED', origin: 'engine', setup: 'yt_macd_zero', asset: 'EURUSD_otc', ts: T0, decision: 'CALL', entryPrice: 1, expirySec: 60, exits: path, ...extra });
const up = 1.001, down = 0.999;

test('post-mortem: the reason of a loss', () => {
  // the market won from the signal price, PO's deal opened 3 s late and lost → late
  const late = P.analyze(rec({ 60: up }, { exec: { result: 'L', forensics: { delaySec: 3, poOutcome: 'L', marketOutcome: 'L' } } }));
  assert.equal(late.cause, 'late');
  // lost at 1 min, won at 2 min → too short
  const short = P.analyze(rec({ 30: down, 60: down, 120: up, 180: up }, { exec: { result: 'L' } }));
  assert.equal(short.cause, 'too_short'); assert.equal(short.better, 120);
  // won at 15 s and 30 s, lost at 1 min → too long
  const long = P.analyze(rec({ 15: up, 30: up, 60: down, 120: down }, { exec: { result: 'L' } }));
  assert.equal(long.cause, 'too_long'); assert.equal(long.better, 30);
  // lost at every duration → wrong way; its reverse would have won
  const wrong = P.analyze(rec({ 5: down, 15: down, 30: down, 60: down, 120: down, 180: down }, { exec: { result: 'L' } }));
  assert.equal(wrong.cause, 'wrong_way'); assert.equal(wrong.reverse, 'W');
  // the market said win, PO's own result said loss → platform
  const plat = P.analyze(rec({ 60: down }, { exec: { result: 'L', forensics: { delaySec: 0.4, poOutcome: 'L', marketOutcome: 'W' } } }));
  assert.equal(plat.cause, 'platform');
  // a win has no cause
  assert.equal(P.analyze(rec({ 60: up }, { exec: { result: 'W' } })).cause, null);
});

test('post-mortem: per strategy — results, causes, win rate by duration, and the best duration once there are enough trades', () => {
  const rs = [];
  for (let i = 0; i < 30; i++) rs.push(rec({ 60: i % 3 ? down : up, 120: i % 4 ? up : down }, { id: `a${i}`, ts: T0 + i * 300, exec: { result: i % 3 ? 'L' : 'W' } }));
  rs.push(rec({ 60: up }, { id: 'copy', origin: 'copy' })); // copy signals are not reviewed here
  const [s] = P.summary(rs);
  assert.equal(s.setup, 'yt_macd_zero');
  assert.equal(s.n, 30); assert.equal(s.W, 10); assert.equal(s.L, 20);
  assert.equal(s.used, 60);
  assert.equal(s.rate[60].rate, 33.3);
  assert.equal(s.best.sec, 120, 'two minutes did better on these trades');
  assert.ok(s.causes.too_short > 0);
  assert.equal(s.losses.length, 20);
});

test('«حسّن»: a change only when the older part of the record shows it and the newer part confirms it', () => {
  // deterministic coin: i-th trade wins at a horizon with a given rate (spread evenly through time)
  const hit = (i, pct) => (i * pct) % 100 < pct;
  const mk = (setup, n, rates) => Array.from({ length: n }, (_, i) => rec(Object.fromEntries(Object.entries(rates).map(([h, p]) => [h, hit(i + 7, p) ? up : down])), { setup, ts: T0 + i * 60, id: `${setup}|${i}` }));
  const records = [
    ...mk('yt_macd_zero', 300, { 60: 50, 120: 62, 30: 49, 5: 80 }), // 2 min holds up on both parts → 60 → 120 (5 s is never offered: under 15 s)
    ...mk('yt_fractal_ema', 200, { 60: 45, 120: 46, 30: 44 }),    // loses everywhere → off
    ...mk('yt_cci_psar', 30, { 60: 30 }),                         // too few to judge
  ];
  // a "better" duration only in the older part: wins at 15 s early, loses later → not applied
  records.push(...Array.from({ length: 200 }, (_, i) => rec({ 60: hit(i + 3, 52) ? up : down, 15: (i < 140 ? hit(i, 65) : hit(i, 40)) ? up : down }, { setup: 'yt_alligator_rsi', ts: T0 + i * 60, id: `al|${i}` })));
  const r = P.improve(records, { ids: ['yt_macd_zero', 'yt_fractal_ema', 'yt_cci_psar', 'yt_alligator_rsi'], payout: 92, choices: [5, 15, 30, 60, 120] });
  const ch = Object.fromEntries(r.changes.map((c) => [c.id, c]));
  assert.equal(ch.yt_macd_zero?.kind, 'expiry'); assert.equal(ch.yt_macd_zero.to, 120);
  assert.equal(ch.yt_fractal_ema?.kind, 'off');
  assert.equal(r.kept.find((k) => k.id === 'yt_cci_psar')?.reason, 'few');
  assert.equal(r.kept.find((k) => k.id === 'yt_alligator_rsi')?.reason, 'not_confirmed', 'found on the older part only');
  assert.equal(r.breakEven, 52.1);
  // a strategy already off is left alone
  assert.ok(!P.improve(records, { ids: ['yt_fractal_ema'], off: ['yt_fractal_ema'] }).changes.length);
});

test('off-chart signals never judge a strategy: summary, «حسّن» and the split count chart signals only', () => {
  const on = (i, extra = {}) => rec({ 60: i % 2 ? up : down }, { id: `on${i}`, ts: T0 + i * 60, exec: { action: 'auto', result: i % 2 ? 'W' : 'L' }, ...extra });
  const off = (i) => rec({ 60: down }, { id: `off${i}`, ts: T0 + i * 60 + 30, exec: { action: 'paper', note: 'qualified, but the pair is not on the chart of an armed tab' } });
  assert.equal(P.onChart(on(1)), true);
  assert.equal(P.onChart(off(1)), false);
  assert.equal(P.onChart(rec({}, { chart: false, exec: { action: 'auto' } })), false, 'the flag recorded at the signal wins');
  assert.equal(P.onChart(rec({}, { exec: { action: 'paper', note: 'the tab showing this pair is not started (Start in its panel)' } })), true);
  assert.equal(P.onChart(rec({})), null, 'unknown → kept');
  const rs = [...Array.from({ length: 40 }, (_, i) => on(i, { agree: { same: i % 4 === 0 ? 2 : 0, against: 0 }, speed: 1 })), ...Array.from({ length: 200 }, (_, i) => off(i))];
  const [s] = P.summary(rs);
  assert.equal(s.n, 40, '200 off-chart losers are left out');
  assert.equal(P.summary(rs, { chartOnly: false })[0].n, 240);
  // 200 off-chart losses would switch the strategy off; the chart record (50 %) alone has too few to judge
  assert.equal(P.improve(rs, { ids: ['yt_macd_zero'], chartOnly: false }).changes[0]?.kind, 'off');
  assert.equal(P.improve(rs, { ids: ['yt_macd_zero'] }).kept[0]?.reason, 'few');
  const sp = P.split(rs);
  assert.equal(sp.chart.n, 40); assert.equal(sp.chart.rate, 50);
  assert.equal(sp.off.n, 200); assert.equal(sp.off.rate, 0);
  assert.equal(sp.agree.more.n, 10); assert.equal(sp.agree.alone.n, 30); assert.equal(sp.speed.normal.n, 40);
});

test('«تظلّم»: a losing trade explained — the platform, the delay, the duration, or the signal itself', () => {
  // CALL at 1.00000; PO opened at 1.00002 (2 points worse) 1.2 s later and closed at 1.00001 → lost; from the signal price it won
  const entry = P.appeal(rec({ 60: 1.00001, 120: 1.00005 }, { entryPrice: 1.00000, exec: { dir: 'CALL', result: 'L', po: { openPrice: 1.00002, closePrice: 1.00001, openTs: T0 + 1.2 }, forensics: { delaySec: 1.2, marketAtClose: 1.00001, poOutcome: 'L', marketOutcome: 'L' } } }), { recent: { n: 20, w: 11 } });
  assert.equal(entry.verdict, 'entry');
  assert.ok(entry.lines.some((l) => /أسوأ بـ 2 نقطة/.test(l)));
  assert.ok(entry.lines.some((l) => /كانت كسبانة/.test(l)));
  assert.ok(entry.lines.some((l) => /آخر 20 صفقة/.test(l) && /11 كسب/.test(l)));
  // the market at PO's close second said win, PO's close said loss
  const plat = P.appeal(rec({ 60: 0.99999 }, { entryPrice: 1.00000, exec: { dir: 'CALL', result: 'L', po: { openPrice: 1.00000, closePrice: 0.99999 }, forensics: { marketAtClose: 1.00003, poOutcome: 'L', marketOutcome: 'W' } } }));
  assert.equal(plat.verdict, 'platform');
  assert.ok(plat.lines.some((l) => /سعر السوق في ثانية القفل/.test(l)));
  // lost at 1 min, won at 2 → too short
  const short = P.appeal(rec({ 30: 0.99998, 60: 0.99998, 120: 1.00004 }, { entryPrice: 1.00000, exec: { dir: 'CALL', result: 'L', po: { openPrice: 1.00000, closePrice: 0.99998 } } }));
  assert.equal(short.verdict, 'too_short'); assert.equal(short.better, 120);
  assert.match(short.title, /دقيقتين كانت هتكسب/);
  // lost everywhere → the signal itself
  assert.equal(P.appeal(rec({ 5: down, 15: down, 30: down, 60: down, 120: down, 180: down }, { exec: { dir: 'CALL', result: 'L' } })).verdict, 'wrong_way');
});

test('«تظلّم»: "would have won at 3 s" is not a reason (mostly the entry delay) — only 15 s and longer count', () => {
  const r = P.appeal(rec({ 3: up, 5: up, 15: down, 30: down, 60: down, 120: down, 180: down }, { exec: { dir: 'CALL', result: 'L' } }));
  assert.equal(r.verdict, 'wrong_way');
  assert.ok(!r.lines.some((l) => /3 ثانية/.test(l)));
});

test('«تظلّم» pressed right after the loss: it says the longer durations are still coming, then answers again with them', () => {
  const r = rec({ 15: down, 30: down, 60: down }, { horizons: [15, 30, 60, 120, 180, 300], exec: { dir: 'CALL', result: 'L' } });
  const early = P.appeal(r);
  assert.equal(early.pending, true);
  assert.ok(early.lines.some((l) => /لسه مستني السعر بعد دقيقتين/.test(l)));
  // two minutes later: it had won at 2 minutes → too short, not "the signal was wrong"
  const later = P.appeal({ ...r, exits: { ...r.exits, 120: up, 180: up, 300: down } });
  assert.equal(later.pending, false);
  assert.equal(later.verdict, 'too_short'); assert.equal(later.better, 120);
});

test('conditions: held only when they lose on the older part AND the newer part (walk-forward)', () => {
  // 200 chart signals; "momentum against" loses all along (1 in 4), "15M against" loses only in the older part
  const rs = [];
  for (let i = 0; i < 200; i++) {
    const mom = i % 3 === 0, m15 = i % 3 === 1;
    const win = mom ? i % 4 === 0 : m15 ? (i < 120 ? i % 4 === 0 : i % 4 !== 0) : i % 5 < 3;
    rs.push(rec({ 60: win ? up : down }, { id: `opp|C|${i}`, ts: T0 + i * 600, asset: `P${i % 7}`, chart: true,
      facts: { momentum: mom ? 'against' : 'with', risks: m15 ? [{ code: 'm15_against' }] : [] } }));
  }
  const c = P.conditions(rs);
  assert.equal(c.n, 200);
  assert.deepEqual([...c.blocked.map((x) => x.k)], ['momAgainst']);
  assert.ok(c.all.find((x) => x.k === 'm15Against').train.rate < 50, 'lost on the older part, then won → not held');
  // off-chart signals don't count
  assert.equal(P.conditions(rs.map((r) => ({ ...r, chart: false }))).n, 0);
  // the flags of one signal, with the pair's earlier ones
  const r = rec({}, { ts: T0 + 400, agree: { same: 0, against: 1 }, facts: { momentum: 'against' } });
  const prior = P.priorOf([rec({ 60: down }, { ts: T0 + 200 })]);
  assert.deepEqual([...P.condFlags(r, prior)].sort(), ['afterLoss', 'conflict', 'momAgainst']);
});
