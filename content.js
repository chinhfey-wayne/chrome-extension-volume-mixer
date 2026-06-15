// Isolated world — bridges background service worker <-> injected.js
(function () {
  function send(data) {
    window.postMessage({ __vm__: true, ...data }, '*');
  }

  chrome.runtime.sendMessage({ type: 'getVolume' }, res => {
    if (chrome.runtime.lastError) return;
    if (res && res.volume !== undefined) send({ action: 'setVolume', volume: res.volume });
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'setVolume')  { send({ action: 'setVolume', volume: msg.volume }); sendResponse({ ok: true }); }
    if (msg.type === 'pauseMedia') { send({ action: 'pause' }); sendResponse({ ok: true }); }
    if (msg.type === 'playMedia')  { send({ action: 'play' });  sendResponse({ ok: true }); }
  });
})();
