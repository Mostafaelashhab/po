// Runs Strategy Discovery cycles in a Web Worker (started by the dashboard), so a
// cycle of tens of seconds never freezes the page. Reads candles and earlier
// strategies from IndexedDB and writes the new versioned rows and the run report back.
importScripts('indicators.js', 'engine/core.js', 'engine/dataquality.js', 'engine/features.js', 'engine/regime.js',
  'engine/factory.js', 'engine/library.js', 'engine/consensus.js', 'engine/confluence.js', 'engine/contradiction.js', 'engine/risk.js',
  'engine/pipeline.js', 'engine/stats.js', 'engine/featurelib.js', 'engine/discovery.js', 'engine/discovery-search.js',
  'engine/discovery-assess.js', 'engine/lifecycle.js', 'db.js');

let stop = false;
const post = (m) => self.postMessage(m);

self.onmessage = async ({ data }) => {
  if (data.type === 'stop') { stop = true; return; }
  if (data.type !== 'run') return;
  stop = false;
  try {
    const cfg = OTC.config(data.cfg);
    // Setup frame of this cycle: 1M and 5M candles are stored, 15M is built from 5M.
    const tf = data.tf || 300;
    const sources = [];
    for (const asset of data.assets) {
      const c1 = data.useM1 || tf === 60 ? await DB.candlesFor(asset, 60) : null;
      const c5 = tf === 60 ? null : await DB.candlesFor(asset, 300);
      const candles = tf === 60 ? c1 : tf === 300 ? c5 : OTC.U.aggregate(c5, 300, tf);
      sources.push({ asset, candles, c1 });
      post({ type: 'progress', stage: 'load', text: `${asset}: ${candles.length} ${OTC.TF_LABEL[tf]}${c1 && tf !== 60 ? `, ${c1.length} 1M` : ''} candles` });
    }
    const all = await DB.all('strategies');
    const existing = OTC.Lifecycle.latest(all);
    const previousRuns = await DB.all('discovery_runs');
    let last = 0;
    const res = await OTC.Discovery.runCycle(sources, {
      cfg, tf, payoutByAsset: data.payouts || {}, defaultPayout: data.defaultPayout || 85, existing, previousRuns,
      shouldStop: () => stop,
      onProgress: (p) => { if (Date.now() - last > 300 || p.stage !== 'dataset') { last = Date.now(); post({ type: 'progress', ...p }); } },
    });
    if (stop) { post({ type: 'stopped' }); return; }
    if (res.rows.length) await DB.putMany('strategies', res.rows);
    await DB.put('discovery_runs', { ...res.run, report: res.report });
    post({ type: 'done', report: res.report });
  } catch (e) {
    post({ type: 'error', error: String(e && e.stack || e) });
  }
};
