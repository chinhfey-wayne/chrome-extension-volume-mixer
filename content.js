// content.js — isolated world. Bridges service worker <-> injected.js (MAIN world).
(function () {
  function send(data) { window.postMessage({ __vm__: true, ...data }, '*'); }

  // On load, pull this tab's stored volume and apply it (closes the reload gap).
  chrome.runtime.sendMessage({ type: 'getVolume' }, res => {
    if (chrome.runtime.lastError) return;
    if (res && res.volume !== undefined) send({ action: 'setVolume', volume: res.volume });
  });
})();
