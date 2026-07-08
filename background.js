// Service worker — orchestrates muting and volume.
//
// MUTE  : native chrome.tabs.update({muted}) — browser-level, works on ANY tab
//         (even never-visited background tabs), survives app/profile switches,
//         set-and-forget. This is the bulletproof path.
// VOLUME: tabCapture -> offscreen GainNode. The page can't fight a gain node it
//         can't see. Once started, the capture persists even when the tab is
//         backgrounded, so the volume holds. Limitation: starting a capture
//         requires the tab to be capturable (the active tab / activeTab grant);
//         background tabs that were never visited can only be muted, not ducked.

const setVolumeFallback = (vol) => {
  // Only used if capture can't start (e.g. restricted tab). Best-effort.
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

function execInTab(tabId, func, args = []) {
  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func,
    args,
  }, () => { void chrome.runtime.lastError; });
}

// ── Offscreen document lifecycle ──
let creatingOffscreen = null;
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Route captured tab audio through a gain node for volume control.',
  });
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}

function msgOffscreen(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ target: 'offscreen', ...message }, res => {
      void chrome.runtime.lastError;
      resolve(res);
    });
  });
}

// Start or update a capture-based gain for a tab. Returns true on success.
async function startCapture(tabId, volume) {
  await ensureOffscreen();
  // If already capturing, just adjust the gain — no new stream needed.
  const state = await msgOffscreen({ type: 'isCapturing', tabId });
  if (state && state.capturing) {
    await msgOffscreen({ type: 'setGain', tabId, volume });
    return true;
  }
  // Need a fresh stream id. Requires the tab to be capturable.
  const streamId = await new Promise(resolve => {
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, id => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(id);
      });
    } catch (_) { resolve(null); }
  });
  if (!streamId) return false;
  const res = await msgOffscreen({ type: 'startOrUpdate', tabId, streamId, volume });
  return !!(res && res.ok);
}

function stopCapture(tabId) {
  return msgOffscreen({ type: 'stop', tabId });
}

// Apply the stored volume for a tab using the right mechanism.
async function applyVolume(tabId, volume) {
  if (volume === 0) {
    // Mute: native, bulletproof. Release any capture (no need to process silence).
    chrome.tabs.update(tabId, { muted: true }, () => { void chrome.runtime.lastError; });
    await stopCapture(tabId);
    return;
  }
  // Non-zero: make sure native mute is off, then route through gain.
  chrome.tabs.update(tabId, { muted: false }, () => { void chrome.runtime.lastError; });
  if (volume === 1.0) {
    // 100% = passthrough. No capture needed; release it for clean audio.
    await stopCapture(tabId);
    return;
  }
  const ok = await startCapture(tabId, volume);
  if (!ok) execInTab(tabId, setVolumeFallback, [volume]);
}

// ── Startup: drop stale tab ids (storage.local persists; tab ids don't) ──
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
  if (msg.target === 'offscreen') return; // not for us

  if (msg.type === 'getVolume') {
    const key = `vol_${sender.tab?.id}`;
    chrome.storage.local.get(key, result => sendResponse({ volume: result[key] ?? 1.0 }));
    return true;
  }

  if (msg.type === 'setTabVolume') {
    const { tabId, volume } = msg;
    chrome.storage.local.set({ [`vol_${tabId}`]: volume }, () => {
      applyVolume(tabId, volume).catch(() => {});
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'pauseTab') { execInTab(msg.tabId, pauseInPage); sendResponse({ ok: true }); return false; }
  if (msg.type === 'playTab')  { execInTab(msg.tabId, playInPage);  sendResponse({ ok: true }); return false; }

  if (msg.type === 'getAllVolumes') {
    chrome.storage.local.get(null, items => {
      const volumes = {};
      for (const [k, v] of Object.entries(items)) {
        if (k.startsWith('vol_')) volumes[parseInt(k.slice(4))] = v;
      }
      sendResponse({ volumes });
    });
    return true;
  }
});

// Re-establish the stored volume for a tab (e.g. after navigation dropped the
// capture). This IS applyVolume — same per-volume policy, no second copy. Its
// mute/unmute/stopCapture calls are idempotent, so re-running is safe.
function reassert(tabId) {
  chrome.storage.local.get(`vol_${tabId}`, result => {
    const vol = result[`vol_${tabId}`];
    if (vol !== undefined) applyVolume(tabId, vol).catch(() => {});
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Not on 'loading' — page has no media yet and native mute already survives
  // navigation; capture is worth restarting only once the page is up / audible.
  if (changeInfo.status === 'complete' || changeInfo.audible !== undefined) {
    reassert(tabId);
  }
  // Self-heal: external unmute of a tab we muted → re-mute.
  if (changeInfo.mutedInfo !== undefined && !changeInfo.mutedInfo.muted) {
    chrome.storage.local.get(`vol_${tabId}`, result => {
      if (result[`vol_${tabId}`] === 0) {
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

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.local.remove(`vol_${tabId}`);
  stopCapture(tabId);
});
