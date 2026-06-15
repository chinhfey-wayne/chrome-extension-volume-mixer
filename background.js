// Service worker — persists tab volumes in chrome.storage.session
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getVolume') {
    const key = `vol_${sender.tab?.id}`;
    chrome.storage.session.get(key, result => {
      sendResponse({ volume: result[key] ?? 1.0 });
    });
    return true;
  }

  if (msg.type === 'setTabVolume') {
    const { tabId, volume } = msg;
    chrome.storage.session.set({ [`vol_${tabId}`]: volume }, () => {
      chrome.tabs.sendMessage(tabId, { type: 'setVolume', volume }, () => {
        void chrome.runtime.lastError; // suppress error for tabs without content script
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'getAllVolumes') {
    chrome.storage.session.get(null, items => {
      const volumes = {};
      for (const [k, v] of Object.entries(items)) {
        if (k.startsWith('vol_')) volumes[parseInt(k.slice(4))] = v;
      }
      sendResponse({ volumes });
    });
    return true;
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(`vol_${tabId}`);
});
