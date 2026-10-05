// Hosts research cycles for the service worker: a service worker cannot start a Web Worker, and a cycle (replay,
// similarity, strategy discovery) must never block the live side (decisions, executions, predictions).
let worker = null;
chrome.runtime.onMessage.addListener((m) => {
  if (m?.target !== 'offscreen' || m.type !== 'research') return;
  worker ||= new Worker('../research-worker.js');
  worker.onmessage = ({ data }) => {
    if (data.type === 'done' || data.type === 'error' || data.type === 'stopped') chrome.runtime.sendMessage({ type: 'researchDone', result: data });
  };
  worker.postMessage({ type: 'run', payout: m.payout, cfg: m.cfg, by: 'worker' });
});
