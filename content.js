// Isolated world — bridges background service worker <-> injected.js
(function () {
  function applyVolume(v) {
    window.postMessage({ __vm__: true, volume: v }, '*');
  }

  // Fetch stored volume for this tab on page load
  chrome.runtime.sendMessage({ type: 'getVolume' }, res => {
    if (chrome.runtime.lastError) return;
    if (res && res.volume !== undefined) {
      applyVolume(res.volume);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'setVolume') {
      applyVolume(msg.volume);
      sendResponse({ ok: true });
    }
  });
})();
