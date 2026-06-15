// Runs volume/pause operations directly in the page via scripting.executeScript
// This is far more reliable than the tabs.sendMessage → postMessage chain

function execInTab(tabId, func, args = []) {
  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func,
    args,
  }, () => { void chrome.runtime.lastError; });
}

const setVolumeInPage = (vol) => {
  if (window.__vmGains) {
    window.__vmGains.forEach(g => { try { g.gain.value = vol; } catch (_) {} });
  }
  document.querySelectorAll('audio, video').forEach(el => {
    try { el.volume = Math.min(1, vol); } catch (_) {}
  });
  window.__vmVolume = vol;
};

const pauseInPage = () => {
  document.querySelectorAll('audio, video').forEach(el => { try { el.pause(); } catch (_) {} });
};

const playInPage = () => {
  document.querySelectorAll('audio, video').forEach(el => { try { el.play(); } catch (_) {} });
};

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
      execInTab(tabId, setVolumeInPage, [volume]);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'pauseTab') {
    execInTab(msg.tabId, pauseInPage);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'playTab') {
    execInTab(msg.tabId, playInPage);
    sendResponse({ ok: true });
    return false;
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

// Re-apply stored volume when a tab finishes loading
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  chrome.storage.session.get(`vol_${tabId}`, result => {
    const vol = result[`vol_${tabId}`];
    if (vol !== undefined && vol !== 1.0) {
      execInTab(tabId, setVolumeInPage, [vol]);
    }
  });
});

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(`vol_${tabId}`);
});
