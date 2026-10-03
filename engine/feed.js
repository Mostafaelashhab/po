// Market-data observer for one pair inside one tab: builds 1M/5M/15M/1H candles
// from live ticks and merges history fetched from Pocket Option. Pure logic —
// the tab script feeds it ticks and history rows.
(function (G) {
  const OTC = G.OTC, U = OTC.U, TF = OTC.TF;
  const KEEP = { 5: 720, 10: 400, 15: 300, 30: 240, 60: 400, 300: 400, 900: 300, 1800: 200, 3600: 200 };
  const MAX_FILL = 12; // seconds frames: up to this many tick-less candles are filled flat (longer gaps stay gaps)

  class Series {
    constructor(tf) { this.tf = tf; this.map = new Map(); this.forming = null; this.historyAt = 0; this.mismatches = 0; }

    // Returns the candle that just closed, or null.
    ingest(ts, price) {
      const t = Math.floor(ts / this.tf) * this.tf, f = this.forming;
      if (f && t < f.time) return null; // late tick for an old candle
      if (f && t === f.time) {
        f.high = Math.max(f.high, price); f.low = Math.min(f.low, price); f.close = price;
        return null;
      }
      let closed = null;
      if (f) {
        closed = { time: f.time, open: f.open, high: f.high, low: f.low, close: f.close };
        if (f.partial) closed.partial = true;
        this.map.set(f.time, closed);
        // On seconds frames a few seconds without a tick is normal: those candles exist, flat at the last price.
        const gap = (t - f.time) / this.tf - 1;
        if (this.tf < 60 && gap > 0 && gap <= MAX_FILL) {
          for (let k = 1; k <= gap; k++) this.map.set(f.time + k * this.tf, { time: f.time + k * this.tf, open: f.close, high: f.close, low: f.close, close: f.close, filled: true });
        }
        this.trim();
      }
      // The first candle after (re)start began before we saw it, so its open/high/low are unknown.
      this.forming = { time: t, open: price, high: price, low: price, close: price, partial: !f && ts - t > 2 };
      return closed;
    }

    // History is authoritative for closed candles; it also repairs a partial forming candle.
    mergeHistory(rows) {
      let n = 0;
      for (const r of rows) {
        if (r.time % this.tf !== 0) continue;
        if (this.forming && r.time === this.forming.time) {
          const f = this.forming;
          f.open = r.open; f.high = Math.max(f.high, r.high); f.low = Math.min(f.low, r.low); f.partial = false;
          continue;
        }
        if (this.forming && r.time > this.forming.time) continue;
        // A live-built candle that disagrees with PO's own history means ticks were missed.
        const old = this.map.get(r.time);
        if (old && !old.partial && Math.abs(old.close - r.close) > 1e-9 * Math.abs(r.close)) this.mismatches++;
        this.map.set(r.time, { time: r.time, open: r.open, high: r.high, low: r.low, close: r.close });
        n++;
      }
      this.trim();
      return n;
    }

    trim() {
      const keep = KEEP[this.tf] || 300;
      if (this.map.size <= keep) return;
      const keys = [...this.map.keys()].sort((a, b) => a - b);
      for (const k of keys.slice(0, keys.length - keep)) this.map.delete(k);
    }

    // A missing candle among the last n closed ones (e.g. PO's history ended a minute or two before
    // live candles began). Analysis treats recent gaps as fatal, so the caller refills them from history.
    recentGap(n = 30) {
      const c = this.closed(n + 1);
      for (let i = 1; i < c.length; i++) if (c[i].time - c[i - 1].time > this.tf) return true;
      return false;
    }

    // Closed candles, oldest first; partial ones are dropped (they are always the oldest).
    closed(n = Infinity) {
      const arr = [...this.map.values()].filter((c) => !c.partial).sort((a, b) => a.time - b.time);
      return n === Infinity ? arr : arr.slice(-n);
    }
  }

  class Feed {
    constructor(asset) {
      this.asset = asset;
      this.series = {};
      for (const tf of OTC.FEED_TFS) this.series[tf] = new Series(tf);
      this.lastTick = null;
    }
    // Returns [{ tf, candle }] for every timeframe that closed a candle on this tick.
    ingest(ts, price) {
      if (!Number.isFinite(ts) || !Number.isFinite(price)) return [];
      if (this.lastTick && ts < this.lastTick.ts - 5) return []; // out-of-order tick
      this.lastTick = { ts, price };
      const out = [];
      for (const s of Object.values(this.series)) { const c = s.ingest(ts, price); if (c) out.push({ tf: s.tf, candle: c }); }
      return out;
    }
    merge(tf, rows) { return this.series[tf] ? this.series[tf].mergeHistory(rows) : 0; }
    // What the pipeline needs for the ACTIVE profile (OTC.withProfile), as of the latest closed setup candle.
    // withForming: the setup candle still forming is appended as if it closed now (provisional look only).
    snapshot({ withForming = false } = {}) {
      let c = this.series[TF.PRIMARY].closed(200);
      const fm = this.series[TF.PRIMARY].forming;
      if (withForming && fm && !fm.partial) c = [...c.slice(c.length >= 200 ? 1 : 0), { time: fm.time, open: fm.open, high: fm.high, low: fm.low, close: fm.close }];
      const out = {
        [TF.PRIMARY]: c,
        [TF.MID]: OTC.Pipeline.htfWithPartial(this.series[TF.MID].closed(120), c, TF.MID),
        [TF.MACRO]: OTC.Pipeline.htfWithPartial(this.series[TF.MACRO].closed(120), c, TF.MACRO),
      };
      if (TF.TIMING) out[TF.TIMING] = this.series[TF.TIMING].closed(60);
      return out;
    }
    counts() { return Object.fromEntries(Object.entries(this.series).map(([tf, s]) => [tf, s.map.size])); }
  }

  OTC.Feed = { Series, Feed };
})(typeof globalThis !== 'undefined' ? globalThis : this);
