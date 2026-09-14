// Service worker — owns per-tab {volume, muted}, native mute, injection apply, hotkeys.
console.log('[VolumeControl] background.js loaded, manifest version', chrome.runtime.getManifest().version);

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

// Every read-modify-write of a tab's state (getState().then(setState)) must run
// to completion before the next one starts, or two events landing close
// together (a native mute toggle racing a popup click, or two native toggles
// back to back) can read stale data and lose or reorder a write. Serialize
// per tab so that can never happen.
const tabLocks = new Map();
function withTabLock(tabId, fn) {
  const prev = tabLocks.get(tabId) || Promise.resolve();
  const next = prev.then(fn, fn).catch(() => {});
  tabLocks.set(tabId, next);
  return next;
}

// Push volume into the page. injected.js (MAIN world, document_start) always
// runs before this can fire, so __vmApply is always present by the time we call it.
const setVolumeInPage = (vol) => {
  if (typeof window.__vmApply === 'function') window.__vmApply(vol);
};
const pauseInPage = () => document.querySelectorAll('audio, video').forEach(el => { try { el.pause(); } catch (_) {} });
const playInPage  = () => document.querySelectorAll('audio, video').forEach(el => { try { el.play().catch(() => {}); } catch (_) {} });

function execInTab(tabId, func, args = []) {
  chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func, args },
    () => { void chrome.runtime.lastError; });
}

function nativeMute(tabId, muted) {
  chrome.tabs.update(tabId, { muted }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[VolumeControl] tabs.update({muted}) failed', { tabId, muted, error: chrome.runtime.lastError.message });
    }
  });
}

// Apply both facets of a tab's state — used for explicit user-driven writes
// (slider/mute/hotkey), not for reassert() (see below), so it never races itself.
function applyState(tabId, state) {
  nativeMute(tabId, state.muted);
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
    withTabLock(tabId, () => getState(tabId).then(s => {
      const next = { ...s, volume };
      return setState(tabId, next).then(() => { applyState(tabId, next); sendResponse({ ok: true }); });
    }));
    return true;
  }
  if (msg.type === 'setTabState') {
    // Atomic write of BOTH volume and mute — avoids the read-modify-write race
    // that happens when volume and mute are sent as two separate messages.
    const { tabId, volume, muted } = msg;
    const next = { volume, muted };
    withTabLock(tabId, () => setState(tabId, next).then(() => { applyState(tabId, next); sendResponse({ ok: true }); }));
    return true;
  }

  if (msg.type === 'setTabMuted') {
    const { tabId, muted } = msg;
    withTabLock(tabId, () => getState(tabId).then(s => {
      const next = { ...s, muted };
      return setState(tabId, next).then(() => {
        nativeMute(tabId, muted);
        sendResponse({ ok: true });
      });
    }));
    return true;
  }
  if (msg.type === 'pauseTab') { execInTab(msg.tabId, pauseInPage); sendResponse({ ok: true }); return false; }
  if (msg.type === 'playTab')  { execInTab(msg.tabId, playInPage);  sendResponse({ ok: true }); return false; }
});

// ---- Re-assert volume on navigation / audible change ----
// Mute is Chrome-native and survives navigation on its own — re-pushing it here
// on every 'audible' flip (which fires constantly on a playing tab) raced against
// user-driven mute/unmute writes and could flip mute back on. Volume is page-level
// (reset by a fresh injected.js on navigation), so only that needs reapplying.
function reassert(tabId) {
  chrome.storage.local.get(KEY(tabId), r => {
    const s = r[KEY(tabId)];
    if (s) execInTab(tabId, setVolumeInPage, [s.volume]);
  });
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.audible !== undefined) reassert(tabId);
  // Adopt Chrome's real mute state as the source of truth. If the tab is muted or
  // unmuted anywhere (Chrome's tab icon, another extension), sync our stored state
  // to match so the UI reflects reality and reassert() won't fight it. Writing
  // storage also live-updates an open popup via storage.onChanged.
  if (changeInfo.mutedInfo !== undefined) {
    const real = !!changeInfo.mutedInfo.muted;
    withTabLock(tabId, () => getState(tabId).then(s => {
      if (s.muted !== real) return setState(tabId, { ...s, muted: real });
    }));
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => reassert(tabId));
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ windowId }, tabs => tabs.forEach(t => reassert(t.id)));
});

// ---- Per-tab lifetime: forget on close ----
chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.local.remove(KEY(tabId));
  tabLocks.delete(tabId);
});

// ---- Global hotkeys ----
const MAX = 1.5, STEP = 0.1;
chrome.commands.onCommand.addListener(command => {
  // Open the popup right away on the user gesture so the change is visible.
  // The popup reads current state on load and live-syncs via storage.onChanged,
  // so it shows the updated value even though the write below is async.
  if (chrome.action.openPopup) chrome.action.openPopup().catch(() => {});
  // Ping the popup so it (re)starts its HUD auto-close timer on every shortcut.
  chrome.storage.session.set({ hudPing: Date.now() });

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab) return;
    withTabLock(tab.id, () => getState(tab.id).then(s => {
      if (command === 'toggle-mute') {
        const next = { ...s, muted: !s.muted };
        return setState(tab.id, next).then(() => nativeMute(tab.id, next.muted));
      } else if (command === 'volume-up' || command === 'volume-down') {
        const delta = command === 'volume-up' ? STEP : -STEP;
        const volume = Math.max(0, Math.min(MAX, Math.round((s.volume + delta) * 100) / 100));
        const next = { ...s, volume };
        return setState(tab.id, next).then(() => applyState(tab.id, next));
      }
    }));
  });
});
