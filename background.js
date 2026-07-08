// Service worker — owns per-tab {volume, muted}, native mute, injection apply, hotkeys.

const KEY = id => `vol_${id}`;
const DEFAULT_STATE = { volume: 1.0, muted: false };

function getState(tabId) {
  return new Promise(resolve => {
    chrome.storage.local.get(KEY(tabId), r => resolve(r[KEY(tabId)] ?? { ...DEFAULT_STATE }));
  });
}
function setState(tabId, state) {
  return new Promise(resolve => chrome.storage.local.set({ [KEY(tabId)]: state }, resolve));
}

// Push volume into the page. Prefer the injected __vmApply; fall back to raw scaling.
const setVolumeInPage = (vol) => {
  if (typeof window.__vmApply === 'function') { window.__vmApply(vol); return; }
  if (window.__vmGains) window.__vmGains.forEach(g => { try { g.gain.value = vol; } catch (_) {} });
  document.querySelectorAll('audio, video').forEach(el => { try { el.volume = Math.min(1, vol); } catch (_) {} });
};
const pauseInPage = () => document.querySelectorAll('audio, video').forEach(el => { try { el.pause(); } catch (_) {} });
const playInPage  = () => document.querySelectorAll('audio, video').forEach(el => { try { el.play().catch(() => {}); } catch (_) {} });

function execInTab(tabId, func, args = []) {
  chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func, args },
    () => { void chrome.runtime.lastError; });
}

// Apply both facets of a tab's state. Idempotent — safe to re-run on navigation.
function applyState(tabId, state) {
  chrome.tabs.update(tabId, { muted: state.muted }, () => { void chrome.runtime.lastError; });
  execInTab(tabId, setVolumeInPage, [state.volume]);
}

// ---- Startup: drop stale tab ids (local persists; tab ids don't) ----
chrome.tabs.query({}, tabs => {
  const live = new Set(tabs.map(t => t.id));
  chrome.storage.local.get(null, items => {
    const stale = Object.keys(items).filter(k => {
      if (!k.startsWith('vol_')) return false;
      const id = parseInt(k.slice(4));
      return !isNaN(id) && !live.has(id);
    });
    if (stale.length) chrome.storage.local.remove(stale);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getVolume') {
    getState(sender.tab?.id).then(s => sendResponse({ volume: s.volume }));
    return true;
  }
  if (msg.type === 'getAllVolumes') {
    chrome.storage.local.get(null, items => {
      const states = {};
      for (const [k, v] of Object.entries(items)) if (k.startsWith('vol_')) states[parseInt(k.slice(4))] = v;
      sendResponse({ states });
    });
    return true;
  }
  if (msg.type === 'setTabVolume') {
    const { tabId, volume } = msg;
    getState(tabId).then(s => {
      const next = { ...s, volume };
      setState(tabId, next).then(() => { applyState(tabId, next); sendResponse({ ok: true }); });
    });
    return true;
  }
  if (msg.type === 'setTabMuted') {
    const { tabId, muted } = msg;
    getState(tabId).then(s => {
      const next = { ...s, muted };
      setState(tabId, next).then(() => {
        chrome.tabs.update(tabId, { muted }, () => { void chrome.runtime.lastError; });
        sendResponse({ ok: true });
      });
    });
    return true;
  }
  if (msg.type === 'pauseTab') { execInTab(msg.tabId, pauseInPage); sendResponse({ ok: true }); return false; }
  if (msg.type === 'playTab')  { execInTab(msg.tabId, playInPage);  sendResponse({ ok: true }); return false; }
});

// ---- Re-assert on navigation / audible change (volume + mute are idempotent) ----
function reassert(tabId) {
  chrome.storage.local.get(KEY(tabId), r => {
    const s = r[KEY(tabId)];
    if (s) applyState(tabId, s);
  });
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.audible !== undefined) reassert(tabId);
  // Self-heal: external unmute of a tab we store as muted → re-mute.
  if (changeInfo.mutedInfo !== undefined && !changeInfo.mutedInfo.muted) {
    chrome.storage.local.get(KEY(tabId), r => {
      if (r[KEY(tabId)] && r[KEY(tabId)].muted) {
        chrome.tabs.update(tabId, { muted: true }, () => { void chrome.runtime.lastError; });
      }
    });
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => reassert(tabId));
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ windowId }, tabs => tabs.forEach(t => reassert(t.id)));
});

// ---- Per-tab lifetime: forget on close ----
chrome.tabs.onRemoved.addListener(tabId => chrome.storage.local.remove(KEY(tabId)));

// ---- Global hotkeys ----
const MAX = 1.5, STEP = 0.1;
chrome.commands.onCommand.addListener(command => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab) return;
    getState(tab.id).then(s => {
      if (command === 'toggle-mute') {
        const next = { ...s, muted: !s.muted };
        setState(tab.id, next).then(() => chrome.tabs.update(tab.id, { muted: next.muted }, () => { void chrome.runtime.lastError; }));
      } else if (command === 'volume-up' || command === 'volume-down') {
        const delta = command === 'volume-up' ? STEP : -STEP;
        const volume = Math.max(0, Math.min(MAX, Math.round((s.volume + delta) * 100) / 100));
        const next = { ...s, volume };
        setState(tab.id, next).then(() => applyState(tab.id, next));
      }
    });
  });
});
