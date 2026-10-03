// Runs in the page's own JS world. Wraps WebSocket so the bot can see
// price ticks, history and order events, and forwards them via postMessage.
(function () {
  const Native = window.WebSocket;
  if (!Native || Native.__poBotHooked) return;
  let latestSocket = null;

  const post = (kind, payload) => {
    try { window.postMessage({ src: 'POBOT', kind, ...payload }, '*'); } catch (_) {}
  };

  const Hooked = new Proxy(Native, {
    construct(target, args) {
      const ws = new target(...args);
      if (/po\.market|pocketoption|po\.trade|po\.cash/.test(String(args[0]))) latestSocket = ws;
      // socket.io sends `451-["eventName",{"_placeholder":true}]` then the payload as a binary frame
      let pendingEvent = null;

      ws.addEventListener('message', (e) => {
        if (typeof e.data === 'string') {
          const m = /^45\d-\["([^"]+)"/.exec(e.data);
          pendingEvent = m ? m[1] : null;
          // Plain-text socket.io events (42["name",{...}]) — forwarded so the bot can catalogue them
          const t = !m && /^42\["([^"]+)"/.exec(e.data);
          if (t) post('text_event', { event: t[1], text: e.data.slice(0, 800) });
          return;
        }
        const event = pendingEvent;
        pendingEvent = null;
        const emit = (text) => post('frame', { event, text });
        if (e.data instanceof ArrayBuffer) emit(new TextDecoder().decode(e.data));
        else if (e.data instanceof Blob) e.data.text().then(emit).catch(() => {});
      });

      const send = ws.send.bind(ws);
      ws.send = (data) => {
        // Outgoing events too (names + a short sample), so request formats can be learned
        const out = typeof data === 'string' && /^42\["([^"]+)"/.exec(data);
        if (out) post('sent_event', { event: out[1], text: data.slice(0, 600) });
        if (typeof data === 'string' && data.includes('changeSymbol')) {
          try {
            const arr = JSON.parse(data.slice(data.indexOf('[')));
            post('symbol', { asset: arr[1]?.asset, period: arr[1]?.period });
          } catch (_) {}
        }
        return send(data);
      };
      return ws;
    },
  });
  Hooked.__poBotHooked = true;

  // PO answers "changeSymbol" with ~11 minutes of raw ticks, which is enough to
  // seed the candle buffer instantly instead of waiting for live candles.
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.src !== 'POBOT_CMD' || e.data.kind !== 'history') return;
    if (!latestSocket || latestSocket.readyState !== 1) return post('history_failed', {});
    latestSocket.send('42["changeSymbol",' + JSON.stringify({ asset: e.data.asset, period: e.data.period }) + ']');
  });

  // History requests for the pair scanner — the same message PO's chart sends when dragged back.
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.src !== 'POBOT_CMD' || e.data.kind !== 'loadHistory') return;
    if (!latestSocket || latestSocket.readyState !== 1) return post('history_failed', {});
    const { asset, time, offset, period } = e.data;
    const index = Math.floor(Date.now() / 1000) * 100 + Math.floor(Math.random() * 100);
    latestSocket.send('42["loadHistoryPeriod",' + JSON.stringify({ asset, index, time, offset, period }) + ']');
  });

  try {
    window.WebSocket = Hooked;
  } catch (_) {}
  if (window.WebSocket !== Hooked) {
    console.warn('[PO Bot] Could not hook WebSocket — another extension locked it. Disable other PO bots.');
    post('hook_failed', {});
  }
})();
