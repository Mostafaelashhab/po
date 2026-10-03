// IndexedDB storage shared by the service worker and the dashboard (same
// extension origin). Stores:
//   records  — every analysis and opportunity (live and backtest), keyed by id; index 'kind' ('setup' | 'opp')
//   candles  — closed 5M candles per asset, keyed [asset, time]
//   candles_m1 — closed 1M candles (optional; enables 1M conditions in discovery)
//   strategies — discovered strategies/filters, one row per VERSION (rows are never overwritten
//                when a strategy changes; a new version row is added)
//   discovery_runs — config, data fingerprint and report of each discovery cycle
(function (G) {
  const NAME = 'otc-intel', VERSION = 3;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('records')) {
          const s = db.createObjectStore('records', { keyPath: 'id' });
          s.createIndex('ts', 'ts');
          s.createIndex('asset', 'asset');
          s.createIndex('source', 'source');
          s.createIndex('status', 'status');
          s.createIndex('kind', 'kind');
        } else {
          // v3: opportunity records (kind 'opp') are read on their own by the popup
          const s = req.transaction.objectStore('records');
          if (!s.indexNames.contains('kind')) s.createIndex('kind', 'kind');
        }
        if (!db.objectStoreNames.contains('candles')) {
          const s = db.createObjectStore('candles', { keyPath: ['asset', 'time'] });
          s.createIndex('asset', 'asset');
        }
        if (!db.objectStoreNames.contains('candles_m1')) {
          const s = db.createObjectStore('candles_m1', { keyPath: ['asset', 'time'] });
          s.createIndex('asset', 'asset');
        }
        if (!db.objectStoreNames.contains('strategies')) {
          const s = db.createObjectStore('strategies', { keyPath: 'key' });
          s.createIndex('strategy_id', 'strategy_id');
          s.createIndex('status', 'status');
        }
        if (!db.objectStoreNames.contains('discovery_runs')) db.createObjectStore('discovery_runs', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        // another context (e.g. a newer extension version) wants to upgrade: let it
        db.onversionchange = () => { db.close(); dbp = null; };
        resolve(db);
      };
      req.onerror = () => { dbp = null; reject(req.error); };
    });
    return dbp;
  }

  const done = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      let out;
      Promise.resolve(fn(t.objectStore(store))).then((v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const DB = {
    open,
    put: (store, obj) => tx(store, 'readwrite', (s) => { s.put(obj); }),
    putMany: (store, arr) => tx(store, 'readwrite', (s) => { for (const o of arr) s.put(o); }),
    get: (store, key) => tx(store, 'readonly', (s) => done(s.get(key))),
    all: (store) => tx(store, 'readonly', (s) => done(s.getAll())),
    byIndex: (store, index, value) => tx(store, 'readonly', (s) => done(s.index(index).getAll(value))),
    range: (store, index, lo, hi) => tx(store, 'readonly', (s) => done(s.index(index).getAll(IDBKeyRange.bound(lo, hi)))),
    count: (store) => tx(store, 'readonly', (s) => done(s.count())),
    del: (store, key) => tx(store, 'readwrite', (s) => { s.delete(key); }),
    clear: (store) => tx(store, 'readwrite', (s) => { s.clear(); }),
    // Deletes records matching a predicate (e.g. all backtest records of one asset).
    deleteWhere: (store, index, value, pred = () => true) => tx(store, 'readwrite', (s) => new Promise((res) => {
      const req = s.index(index).openCursor(value);
      let n = 0;
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return res(n);
        if (pred(cur.value)) { cur.delete(); n++; }
        cur.continue();
      };
    })),
    candlesFor: async (asset, tf = 300) => (await DB.byIndex(tf === 60 ? 'candles_m1' : 'candles', 'asset', asset)).sort((a, b) => a.time - b.time),
  };
  G.DB = DB;
})(typeof globalThis !== 'undefined' ? globalThis : this);
