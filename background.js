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
  if (typeof window.__vmApply === 'function') {
    window.__vmApply(vol);
    return;
  }
  // Fallback if injected.js hasn't run yet (e.g. restricted page)
  if (window.__vmGains) {
    window.__vmGains.forEach(g => { try { g.gain.value = vol; } catch (_) {} });
  }
  document.querySelectorAll('audio, video').forEach(el => {
    try { el.volume = Math.min(1, vol); } catch (_) {}
  });
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
      // Native browser mute when vol=0 — survives app switches, page reloads, window focus changes
      chrome.tabs.update(tabId, { muted: volume === 0 }, () => { void chrome.runtime.lastError; });
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

function reapplyVolume(tabId) {
  chrome.storage.session.get(`vol_${tabId}`, result => {
    const vol = result[`vol_${tabId}`];
    if (vol !== undefined) {
      // Re-enforce native mute if stored vol is 0 (Chrome may reset it on navigation)
      if (vol === 0) {
        chrome.tabs.update(tabId, { muted: true }, () => { void chrome.runtime.lastError; });
      }
      execInTab(tabId, setVolumeInPage, [vol]);
    }
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.status === 'complete' || changeInfo.audible !== undefined) {
    reapplyVolume(tabId);
  }

  // Self-heal: if tab becomes audible while it should be muted, hammer it immediately
  if (changeInfo.audible === true) {
    chrome.storage.session.get(`vol_${tabId}`, result => {
      if (result[`vol_${tabId}`] === 0) {
        chrome.tabs.update(tabId, { muted: true }, () => { void chrome.runtime.lastError; });
        execInTab(tabId, setVolumeInPage, [0]);
      }
    });
  }

  // Self-heal: if something externally unmutes a tab we muted, re-mute it
  if (changeInfo.mutedInfo !== undefined && !changeInfo.mutedInfo.muted) {
    chrome.storage.session.get(`vol_${tabId}`, result => {
      if (result[`vol_${tabId}`] === 0) {
        chrome.tabs.update(tabId, { muted: true }, () => { void chrome.runtime.lastError; });
      }
    });
  }
});

// Re-apply when user switches to a tab — catches already-loaded tabs
chrome.tabs.onActivated.addListener(({ tabId }) => {
  reapplyVolume(tabId);
});

// Re-apply to ALL tabs in the window when it regains focus
// onActivated does NOT fire on window focus change — only onFocusChanged does
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ windowId }, tabs => {
    tabs.forEach(tab => reapplyVolume(tab.id));
  });
});

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(`vol_${tabId}`);
});

// Alarm-based enforcement — fires every 30s from the service worker (not throttled,
// unlike setInterval inside a background tab's page JS which Chrome freezes)
chrome.alarms.create('vmEnforce', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'vmEnforce') return;
  chrome.storage.session.get(null, items => {
    for (const [k, v] of Object.entries(items)) {
      if (!k.startsWith('vol_')) continue;
      const tabId = parseInt(k.slice(4));
      if (isNaN(tabId)) continue;
      if (v === 0) {
        chrome.tabs.update(tabId, { muted: true }, () => { void chrome.runtime.lastError; });
      }
      execInTab(tabId, setVolumeInPage, [v]);
    }
  });
});
