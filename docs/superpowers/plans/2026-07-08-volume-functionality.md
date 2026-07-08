# Volume Control — Functionality Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make per-tab volume/mute reliable across all tabs simultaneously (incl. 2 Google Meets) by replacing the tabCapture engine with content-script Web Audio injection, decoupling mute from volume, stabilizing the mixer UI, adding global hotkeys, and adding a Playwright self-test harness.

**Architecture:** Volume is scaled inside each page by an injected MAIN-world script (`injected.js`) that patches `AudioContext.destination` (a gain node) and `HTMLMediaElement.volume`. An isolated-world bridge (`content.js`) carries the per-tab volume from the service worker to the page. The service worker (`background.js`) owns per-tab `{volume, muted}` state in `chrome.storage.local`, applies native mute, handles hotkeys, and clears state when a tab closes. The popup renders a stable, in-place-updated mixer.

**Tech Stack:** Chrome Extension MV3, Web Audio API, `chrome.scripting`/`storage`/`tabs`/`commands`, Playwright (dev/test only).

## Global Constraints

- Manifest V3. `injected.js` runs in `world: "MAIN"`, `content.js` in the default isolated world, both `run_at: "document_start"`, `all_frames: true`.
- Volume range: `0`–`1.5` (float), where `1.0` = 100%. Popup MAX_VOL = `150`.
- Per-tab state key: `chrome.storage.local` entry `vol_<tabId> = { volume: number, muted: boolean }`.
- Persistence is **per-tab, tab-lifetime**: default 100% on first visit, no per-site memory; cleared only on `tabs.onRemoved`.
- Mute is native (`chrome.tabs.update(tabId, { muted })`) and **independent** of volume.
- **Testing note (deviation from unit-TDD):** Chrome extension APIs and page audio cannot be unit-tested without a browser. Per-task verification is `node --check` (syntax) + a stated manual load-check. The automated regression test is the Playwright harness in Task 8; it is the project's test suite. Real audio and Google Meet remain manual-only (no audio device / no login in automation).
- Commit after every task.

---

### Task 1: Revert manifest to injection engine + add hotkey commands

**Files:**
- Modify: `manifest.json`
- Delete: `offscreen.html`, `offscreen.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `content_scripts` loading `injected.js` (MAIN) and `content.js` (isolated); `commands` named `toggle-mute`, `volume-up`, `volume-down`; permissions `["tabs", "storage", "scripting"]`.

- [ ] **Step 1: Replace `manifest.json` with the injection-engine manifest**

```json
{
  "manifest_version": 3,
  "name": "Volume Control",
  "version": "1.0.0",
  "description": "Per-tab volume control — mute, duck, or boost any tab",
  "permissions": ["tabs", "storage", "scripting"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js"
  },
  "icons": {
    "48": "icons/logo.png",
    "128": "icons/logo.png"
  },
  "action": {
    "default_popup": "popup.html",
    "default_title": "Volume Control",
    "default_icon": {
      "48": "icons/logo.png",
      "128": "icons/logo.png"
    }
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["injected.js"],
      "run_at": "document_start",
      "world": "MAIN",
      "all_frames": true
    },
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_start",
      "all_frames": true
    }
  ],
  "commands": {
    "toggle-mute": {
      "suggested_key": { "default": "Alt+Shift+M" },
      "description": "Mute/unmute the active tab"
    },
    "volume-up": {
      "suggested_key": { "default": "Alt+Shift+Up" },
      "description": "Increase active tab volume 10%"
    },
    "volume-down": {
      "suggested_key": { "default": "Alt+Shift+Down" },
      "description": "Decrease active tab volume 10%"
    }
  }
}
```

- [ ] **Step 2: Delete the offscreen files**

```bash
git rm offscreen.html offscreen.js
```

- [ ] **Step 3: Validate manifest JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add manifest.json
git commit -m "manifest: revert to injection engine, add hotkey commands"
```

---

### Task 2: Volume engine — `injected.js` (MAIN world, 0–100%)

**Files:**
- Create: `injected.js`

**Interfaces:**
- Consumes: nothing (reads `sessionStorage.__vmVol`).
- Produces (page globals): `window.__vmApply(v: number)` sets volume and re-applies; `window.__vmGains: GainNode[]`. Listens for `window.postMessage({ __vm__: true, action: 'setVolume'|'pause'|'play', volume })`. Tags Web-Audio-routed elements with `el.__vmRouted = true`.

- [ ] **Step 1: Create `injected.js`**

```javascript
// injected.js — MAIN world. The single place page audio volume is scaled.
(function () {
  const clamp01 = v => Math.max(0, Math.min(1, v));

  // Per-tab volume, cached per browsing context so a reload re-applies instantly.
  let volume = (() => {
    try { return parseFloat(sessionStorage.getItem('__vmVol') || '1') || 1.0; }
    catch (_) { return 1.0; }
  })();

  const gainNodes = [];
  window.__vmGains = gainNodes;

  // ---- AudioContext: route destination through our gain (covers Google Meet, games) ----
  const OrigCtx = window.AudioContext || window.webkitAudioContext;
  if (OrigCtx) {
    const OrigBase = window.BaseAudioContext || OrigCtx;
    const destDesc = Object.getOwnPropertyDescriptor(OrigBase.prototype, 'destination');
    const origDestGetter = destDesc && destDesc.get;
    const origCreateMES = OrigCtx.prototype.createMediaElementSource;

    if (origDestGetter) {
      function PatchedAudioContext(...args) {
        const ctx = new OrigCtx(...args);
        const realDest = origDestGetter.call(ctx);
        const gain = OrigCtx.prototype.createGain.call(ctx);
        gain.gain.value = volume;
        gain.connect(realDest);
        gainNodes.push(gain);
        Object.defineProperty(ctx, 'destination', { get: () => gain, configurable: true });
        return ctx;
      }
      PatchedAudioContext.prototype = OrigCtx.prototype;
      Object.setPrototypeOf(PatchedAudioContext, OrigCtx);
      window.AudioContext = PatchedAudioContext;
      if (window.webkitAudioContext) window.webkitAudioContext = PatchedAudioContext;
    }

    // Tag any element the site routes into Web Audio so we never double-scale it.
    if (origCreateMES) {
      OrigCtx.prototype.createMediaElementSource = function (el) {
        try { if (el) el.__vmRouted = true; } catch (_) {}
        return origCreateMES.call(this, el);
      };
    }
  }

  // ---- HTMLMediaElement.volume override (covers plain <audio>/<video>) ----
  const volDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  if (volDesc) {
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      get() { return this._reqVol ?? volDesc.get.call(this); },
      set(v) { this._reqVol = v; applyToElement(this); },
      configurable: true,
    });

    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (this._reqVol === undefined) this._reqVol = volDesc.get.call(this);
      applyToElement(this);
      return origPlay.apply(this, args);
    };
  }

  function applyToElement(el) {
    if (!volDesc) return;
    const req = el._reqVol ?? 1.0;
    // Routed into Web Audio → the gain scales it; element carries the raw request only.
    if (el.__vmRouted) { volDesc.set.call(el, clamp01(req)); return; }
    // Plain element: scale directly. Boost >100% is handled in Task 7.
    volDesc.set.call(el, clamp01(req * Math.min(volume, 1)));
  }

  function applyVolume(v) {
    volume = v;
    try { sessionStorage.setItem('__vmVol', String(v)); } catch (_) {}
    gainNodes.forEach(g => { try { g.gain.value = v; } catch (_) {} });
    document.querySelectorAll('audio, video').forEach(applyToElement);
  }
  window.__vmApply = applyVolume;

  // Apply to media/audio elements added after load.
  const observer = new MutationObserver(muts => {
    if (volume === 1.0) return;
    for (const m of muts) for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches && node.matches('audio, video')) applyToElement(node);
      if (node.querySelectorAll) node.querySelectorAll('audio, video').forEach(applyToElement);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Message bridge from content.js.
  window.addEventListener('message', e => {
    if (!e.data || !e.data.__vm__ || e.source !== window) return;
    if (e.data.action === 'setVolume') applyVolume(e.data.volume);
    if (e.data.action === 'pause') document.querySelectorAll('audio, video').forEach(el => { try { el.pause(); } catch (_) {} });
    if (e.data.action === 'play')  document.querySelectorAll('audio, video').forEach(el => { try { el.play().catch(() => {}); } catch (_) {} });
  });
})();
```

- [ ] **Step 2: Syntax check**

Run: `node --check injected.js`
Expected: no output (exit 0).

- [ ] **Step 3: Manual load-check**

Load unpacked at `chrome://extensions`, open any YouTube tab, open DevTools console, run `window.__vmApply(0.3)` — audio should drop to 30%. Run `window.__vmApply(1)` — back to full.

- [ ] **Step 4: Commit**

```bash
git add injected.js
git commit -m "feat: content-script Web Audio volume engine (injected.js)"
```

---

### Task 3: Bridge — `content.js` (isolated world)

**Files:**
- Create: `content.js`

**Interfaces:**
- Consumes: background message `{ type: 'setVolume', volume }`; background response to `{ type: 'getVolume' }` = `{ volume: number }`.
- Produces: posts `{ __vm__: true, action: 'setVolume', volume }` to the page for `injected.js`.

- [ ] **Step 1: Create `content.js`**

```javascript
// content.js — isolated world. Bridges service worker <-> injected.js (MAIN world).
(function () {
  function send(data) { window.postMessage({ __vm__: true, ...data }, '*'); }

  // On load, pull this tab's stored volume and apply it (closes the reload gap).
  chrome.runtime.sendMessage({ type: 'getVolume' }, res => {
    if (chrome.runtime.lastError) return;
    if (res && res.volume !== undefined) send({ action: 'setVolume', volume: res.volume });
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'setVolume') { send({ action: 'setVolume', volume: msg.volume }); sendResponse({ ok: true }); }
    if (msg.type === 'pauseMedia') { send({ action: 'pause' }); sendResponse({ ok: true }); }
    if (msg.type === 'playMedia')  { send({ action: 'play' });  sendResponse({ ok: true }); }
    return false;
  });
})();
```

- [ ] **Step 2: Syntax check**

Run: `node --check content.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add content.js
git commit -m "feat: isolated-world bridge (content.js)"
```

---

### Task 4: Service worker — injection apply, decoupled `{volume, muted}`, lifecycle, hotkeys

**Files:**
- Modify (full rewrite): `background.js`

**Interfaces:**
- Consumes: popup messages `getVolume`, `getAllVolumes`, `setTabVolume {tabId, volume}`, `setTabMuted {tabId, muted}`, `pauseTab {tabId}`, `playTab {tabId}`. `injected.js` global `window.__vmApply`. `content.js` message `setVolume`.
- Produces: `getVolume` → `{ volume }`; `getAllVolumes` → `{ states: { [tabId]: { volume, muted } } }`. Stores `vol_<tabId> = { volume, muted }`.

- [ ] **Step 1: Replace `background.js`**

```javascript
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
```

- [ ] **Step 2: Syntax check**

Run: `node --check background.js`
Expected: no output.

- [ ] **Step 3: Manual load-check**

Reload extension. On a YouTube tab, in the service-worker console run:
`chrome.tabs.query({active:true,currentWindow:true},t=>chrome.runtime.sendMessage({type:'setTabVolume',tabId:t[0].id,volume:0.4}))` — audio drops. Press `Alt+Shift+M` — tab mutes; again — unmutes.

- [ ] **Step 4: Commit**

```bash
git add background.js
git commit -m "feat: injection-based service worker with decoupled mute + hotkeys"
```

---

### Task 5: Popup — decouple mute from volume, real mute state

**Files:**
- Modify: `popup.js`

**Interfaces:**
- Consumes: `getAllVolumes` → `{ states: { [tabId]: {volume, muted} } }`; sends `setTabVolume`, `setTabMuted`.
- Produces: module state `states[tabId] = { volume, muted }`; helper `applyVolume(tabId, volume)`, `applyMuted(tabId, muted)`.

- [ ] **Step 1: Replace the state bootstrap and volume/mute senders in `popup.js`**

Replace `let volumes = {};` (line 4) with:

```javascript
let states = {}; // tabId -> { volume, muted }
```

Replace `getAllVolumes()` (lines 68-75) with:

```javascript
function getAllStates() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'getAllVolumes' }, res => {
      if (chrome.runtime.lastError) return resolve({});
      resolve(res?.states ?? {});
    });
  });
}

function stateFor(tabId) { return states[tabId] ?? { volume: 1.0, muted: false }; }

function sendVolume(tabId, volume) {
  const s = stateFor(tabId);
  states[tabId] = { ...s, volume };
  chrome.runtime.sendMessage({ type: 'setTabVolume', tabId, volume });
}
function sendMuted(tabId, muted) {
  const s = stateFor(tabId);
  states[tabId] = { ...s, muted };
  chrome.runtime.sendMessage({ type: 'setTabMuted', tabId, muted });
}
```

- [ ] **Step 2: Update `init()` and `refreshTabsLive()` to load `states`**

In `init()` (lines 11-14) replace `getAllVolumes()` with `getAllStates()` and assign to `states`:

```javascript
  [allTabs, states] = await Promise.all([
    chrome.tabs.query({}),
    getAllStates(),
  ]);
```

In `refreshTabsLive()` (lines 53-60) replace the volumes fetch:

```javascript
async function refreshTabsLive() {
  allTabs = await chrome.tabs.query({});
  states = await getAllStates();
  render();
}
```

- [ ] **Step 3: Rewrite the per-tab handlers to use the decoupled model**

Replace `onSlider` (lines 280-291):

```javascript
function onSlider(e) {
  const input = e.target;
  const tabId = parseInt(input.dataset.tabId);
  const pct = parseInt(input.value);
  const card = input.closest('.tab-card');
  syncSliderUI(card, pct);
  if (pct > 0) input.dataset.prevVol = pct;
  sendVolume(tabId, pct / 100);
}
```

Replace `onStepBtn` (lines 257-271):

```javascript
function onStepBtn(e) {
  const btn = e.currentTarget;
  const dir = parseInt(btn.dataset.dir);
  const tabId = parseInt(btn.dataset.tabId);
  const card = btn.closest('.tab-card');
  const input = card.querySelector('.range-input');
  const newPct = Math.max(0, Math.min(MAX_VOL, parseInt(input.value) + dir * 5));
  input.value = newPct;
  if (newPct > 0) input.dataset.prevVol = newPct;
  syncSliderUI(card, newPct);
  sendVolume(tabId, newPct / 100);
}
```

Replace `onMute` (lines 294-311) — mute is now a real independent toggle:

```javascript
function onMute(e) {
  const btn = e.currentTarget;
  const tabId = parseInt(btn.dataset.tabId);
  const card = btn.closest('.tab-card');
  const muted = !stateFor(tabId).muted;
  sendMuted(tabId, muted);
  syncMuteUI(card, muted);
}
```

Replace `onGlobalSlider` per-tab loop body (lines 103-112) to use `sendVolume`:

```javascript
  document.querySelectorAll('.tab-card').forEach(card => {
    const tabId = parseInt(card.dataset.tabId);
    const input = card.querySelector('.range-input');
    input.value = pct;
    if (vol > 0) input.dataset.prevVol = pct;
    syncSliderUI(card, pct);
    sendVolume(tabId, vol);
  });
```

Replace the bulk actions `onMuteAll`, `onBoostAll`, `onResetAll` (lines 388-417):

```javascript
function onMuteAll() {
  visibleTabs().forEach(tab => sendMuted(tab.id, true));
  render();
}
function onBoostAll() {
  visibleTabs().forEach(tab => sendVolume(tab.id, 1.5));
  render();
}
function onResetAll() {
  visibleTabs().forEach(tab => { sendVolume(tab.id, 1.0); sendMuted(tab.id, false); });
  const slider = document.getElementById('globalSlider');
  slider.value = 100;
  document.getElementById('globalVolLabel').textContent = '100%';
  syncGlobalUI(100);
  render();
}
```

- [ ] **Step 4: Add `syncMuteUI` and make `syncSliderUI` stop touching mute**

In `syncSliderUI` (lines 234-248) remove the mute-button lines (the last three statements referencing `.mute-btn`). Add:

```javascript
function syncMuteUI(card, muted) {
  const icon = card.querySelector('.mute-btn .material-symbols-outlined');
  if (icon) icon.textContent = muted ? 'volume_off' : 'volume_up';
  card.querySelector('.mute-btn')?.classList.toggle('muted', muted);
}
```

- [ ] **Step 5: In `makeCard`, drive mute button from real state**

In `makeCard` (line 151) change the signature and mute-button rendering to take state. Replace the call site in `render()` (line 139):

```javascript
    const st = states[tab.id] ?? { volume: (tab.mutedInfo?.muted ? 0 : 1.0), muted: !!tab.mutedInfo?.muted };
    const card = makeCard(tab, st, i);
```

Change `makeCard(tab, vol, index = 0)` to `makeCard(tab, st, index = 0)` and near the top compute:

```javascript
  const vol = st.volume;
  const muted = st.muted || !!tab.mutedInfo?.muted;
  const pct = Math.round(vol * 100);
```

In the mute button markup (lines 189-191) use `muted` instead of `vol === 0`:

```javascript
        <button class="ctrl-btn mute-btn ${muted ? 'muted' : ''}" data-tab-id="${tab.id}" title="${muted ? 'Unmute' : 'Mute'}">
          <span class="material-symbols-outlined">${muted ? 'volume_off' : 'volume_up'}</span>
        </button>
```

- [ ] **Step 6: Syntax check**

Run: `node --check popup.js`
Expected: no output.

- [ ] **Step 7: Manual load-check**

Reload extension + popup. Set a tab to 50%, then click mute — button shows muted, tab silent; unmute — returns to 50% (not 0). Mute the tab via Chrome's own tab icon, reopen popup — button reflects muted.

- [ ] **Step 8: Commit**

```bash
git add popup.js
git commit -m "feat: decouple mute from volume in popup, real mute state"
```

---

### Task 6: Popup — stable ordering + in-place updates

**Files:**
- Modify: `popup.js`

**Interfaces:**
- Consumes: `states`, `allTabs`.
- Produces: `visibleTabs()` returns tabs in stable order; `render()` diffs by `tabId` instead of rebuilding.

- [ ] **Step 1: Make `visibleTabs()` order stable**

Replace `visibleTabs()` (lines 77-89):

```javascript
function visibleTabs() {
  const tabs = allTabs.filter(t => !removedTabIds.has(t.id));
  const filtered = showAll ? tabs : tabs.filter(t => t.audible || states[t.id] !== undefined);
  // Stable: natural tab-strip position. Never reorder on audible/volume change.
  return filtered.sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));
}
```

- [ ] **Step 2: Make `render()` diff by tabId instead of nuking innerHTML**

Replace `render()` (lines 123-149):

```javascript
function render() {
  const list = document.getElementById('tabs-list');
  const empty = document.getElementById('empty');
  const tabs = visibleTabs();

  document.getElementById('sourceCount').textContent =
    `${tabs.length} TAB${tabs.length !== 1 ? 'S' : ''}`;

  empty.classList.toggle('hidden', tabs.length !== 0);

  const seen = new Set();
  tabs.forEach((tab, i) => {
    seen.add(tab.id);
    const existing = list.querySelector(`.tab-card[data-tab-id="${tab.id}"]`);
    const st = states[tab.id] ?? { volume: (tab.mutedInfo?.muted ? 0 : 1.0), muted: !!tab.mutedInfo?.muted };
    if (existing) {
      updateCard(existing, tab, st);
    } else {
      const card = makeCard(tab, st, i);
      list.appendChild(card);
      wireCard(card);
    }
  });

  // Remove cards for tabs no longer visible.
  list.querySelectorAll('.tab-card').forEach(card => {
    if (!seen.has(parseInt(card.dataset.tabId))) card.remove();
  });
}

// Update an existing card in place — never during an active slider drag.
function updateCard(card, tab, st) {
  if (card.querySelector('.range-input') === document.activeElement) return;
  const pct = Math.round(st.volume * 100);
  const input = card.querySelector('.range-input');
  if (parseInt(input.value) !== pct) { input.value = pct; syncSliderUI(card, pct); }
  syncMuteUI(card, st.muted || !!tab.mutedInfo?.muted);
  card.classList.toggle('audible', !!tab.audible);
  const name = card.querySelector('.tab-name');
  if (name && tab.title) name.textContent = trunc(tab.title, 28);
}

// Wire the per-card listeners (extracted so both makeCard paths share it).
function wireCard(card) {
  card.querySelectorAll('.range-input').forEach(r => r.addEventListener('input', onSlider));
  card.querySelectorAll('.mute-btn').forEach(b => b.addEventListener('click', onMute));
  card.querySelectorAll('.pause-btn').forEach(b => b.addEventListener('click', onPause));
  card.querySelectorAll('.more-btn').forEach(b => b.addEventListener('click', onMoreMenu));
  card.querySelectorAll('.menu-item').forEach(b => b.addEventListener('click', onMenuAction));
  card.querySelectorAll('.vol-step-btn').forEach(b => b.addEventListener('click', onStepBtn));
}
```

- [ ] **Step 3: Remove the now-duplicated global listener wiring**

In `render()` there previously was a block (old lines 143-148) attaching listeners to `list.querySelectorAll(...)`. It is replaced by `wireCard`. Confirm no leftover `list.querySelectorAll('.range-input')...` listener block remains after the rewrite.

- [ ] **Step 4: Syntax check**

Run: `node --check popup.js`
Expected: no output.

- [ ] **Step 5: Manual load-check**

Open two audio tabs. Confirm rows do NOT reorder when the second tab becomes louder/audible. Start dragging a slider while the other tab toggles audio — the drag is not interrupted.

- [ ] **Step 6: Commit**

```bash
git add popup.js
git commit -m "feat: stable mixer ordering + in-place card updates"
```

---

### Task 7: Boost > 100% for plain media elements

**Files:**
- Modify: `injected.js`

**Interfaces:**
- Consumes: `applyToElement`, `volume`, `OrigCtx`.
- Produces: elements boosted above 100% via a private `GainNode`; `el.__vmBoost: GainNode`.

- [ ] **Step 1: Add lazy boost routing in `injected.js`**

Add a private context + `ensureBoost`, and call it from `applyToElement` when `volume > 1` and the element is not Web-Audio-routed. Replace the plain-element branch of `applyToElement`:

```javascript
  function applyToElement(el) {
    if (!volDesc) return;
    const req = el._reqVol ?? 1.0;
    if (el.__vmRouted && !el.__vmBoost) { volDesc.set.call(el, clamp01(req)); return; }
    if (volume > 1.0) {
      volDesc.set.call(el, clamp01(req)); // element at full; extra gain via boost node
      ensureBoost(el);
      if (el.__vmBoost) el.__vmBoost.gain.value = volume;
    } else {
      if (el.__vmBoost) el.__vmBoost.gain.value = volume; // routed by us; keep gain in sync
      else volDesc.set.call(el, clamp01(req * volume));
    }
  }

  let boostCtx = null;
  function ensureBoost(el) {
    if (el.__vmBoost || !OrigCtx) return;
    try {
      boostCtx = boostCtx || new OrigCtx();
      const src = boostCtx.createMediaElementSource(el); // one-shot; page must not re-route
      const g = boostCtx.createGain();
      g.gain.value = volume;
      src.connect(g); g.connect(boostCtx.destination);
      el.__vmRouted = true;
      el.__vmBoost = g;
    } catch (_) { /* already source-node'd by the site; leave as-is */ }
  }
```

Note: `OrigCtx` and `clamp01` are already in scope from Task 2. This replaces the `applyToElement` defined in Task 2.

- [ ] **Step 2: Syntax check**

Run: `node --check injected.js`
Expected: no output.

- [ ] **Step 3: Manual load-check**

On a quiet YouTube video, set the tab to 150% via the popup — audio is audibly louder than 100%. Set back to 100% — returns to normal without distortion.

- [ ] **Step 4: Commit**

```bash
git add injected.js
git commit -m "feat: >100% boost for plain media elements via gain routing"
```

---

### Task 8: Playwright self-test harness

**Files:**
- Create: `test/fixtures/audio.html`
- Create: `test/smoke.spec.js`
- Create: `test/package.json`
- Create: `playwright.config.js`

**Interfaces:**
- Consumes: the built extension in the repo root.
- Produces: a runnable `npx playwright test` that loads the extension, screenshots the popup, and asserts UI/console behavior.

- [ ] **Step 1: Create the test audio fixture `test/fixtures/audio.html`**

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>vm-test</title></head>
<body>
<video id="v" src="data:video/mp4;base64,AAAA" muted></video>
<script>
  // Expose a Web Audio graph + a probe the harness can read.
  window.__probe = { gain: null };
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.connect(g); g.connect(ctx.destination);
  osc.start();
  // The extension patches ctx.destination; read the patched gain value back.
  window.__readGain = () => (window.__vmGains && window.__vmGains[0] ? window.__vmGains[0].gain.value : null);
</script>
</body></html>
```

- [ ] **Step 2: Create `playwright.config.js`**

```javascript
module.exports = {
  testDir: './test',
  timeout: 30000,
  use: { headless: false },
};
```

- [ ] **Step 3: Create `test/package.json`**

```json
{ "name": "vm-tests", "private": true, "version": "1.0.0" }
```

- [ ] **Step 4: Create `test/smoke.spec.js`**

```javascript
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXT = path.resolve(__dirname, '..');

async function launch() {
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  // Get the extension id from the service worker.
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  return { ctx, extId };
}

test('popup opens and screenshots without console errors', async () => {
  const { ctx, extId } = await launch();
  const errors = [];
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await page.waitForSelector('.widget');
  await page.screenshot({ path: 'test/popup.png' });
  expect(errors).toEqual([]);
  await ctx.close();
});

test('injected engine scales the AudioContext gain', async () => {
  const { ctx, extId } = await launch();
  const page = await ctx.newPage();
  await page.goto('file://' + path.resolve(__dirname, 'fixtures/audio.html'));
  await page.waitForFunction(() => window.__readGain() !== null);
  await page.evaluate(() => window.__vmApply(0.25));
  const g = await page.evaluate(() => window.__readGain());
  expect(g).toBeCloseTo(0.25, 2);
  await ctx.close();
});
```

- [ ] **Step 5: Install Playwright and run**

Run:
```bash
cd test && npm i -D @playwright/test && npx playwright install chromium && cd .. && npx playwright test
```
Expected: 2 passed; `test/popup.png` exists.

- [ ] **Step 6: Add `test/node_modules` and artifacts to `.gitignore`**

Append to `.gitignore` (create if absent):
```
test/node_modules/
test/popup.png
```

- [ ] **Step 7: Commit**

```bash
git add test playwright.config.js .gitignore
git commit -m "test: Playwright smoke harness (popup screenshot + gain assertion)"
```

---

### Task 9: Full manual verification pass

**Files:** none (verification only).

- [ ] **Step 1: Multi-tab volume**

Open two audio tabs (e.g. a YouTube + a Google Meet, or two Meets). From the popup, lower one and raise the other while both play. Confirm each changes independently, without clicking into either.

- [ ] **Step 2: Persistence across events**

Set a tab to 40%. Reload the page → still 40%. Switch to another app 30s, return → still 40%. Switch Chrome windows/profile, return → still 40%.

- [ ] **Step 3: Tab-lifetime clear**

Close the tab, reopen the same site in a new tab → plays at 100% (no memory), confirming per-tab lifetime.

- [ ] **Step 4: Mute independence + real state**

Set 50%, mute → silent; unmute → 50%. Mute via Chrome tab icon → popup button reflects it.

- [ ] **Step 5: Hotkeys**

With a tab active, `Alt+Shift+M` mutes/unmutes; `Alt+Shift+Up`/`Down` change volume 10% per press.

- [ ] **Step 6: Commit any doc updates**

Update `README.md`/`SECURITY.md` if they still describe tabCapture/offscreen or storage.session. Commit:
```bash
git add README.md SECURITY.md
git commit -m "docs: update architecture notes to injection engine"
```

---

## Self-Review

**Spec coverage:**
- Volume engine (injection, Meet, double-attn guard, boost, observer, sessionStorage) → Tasks 2, 7. ✓
- Bridge → Task 3. ✓
- Decoupled native mute + real state → Tasks 4, 5. ✓
- Per-tab tab-lifetime persistence (default 100%, clear on close, stale cleanup) → Task 4. ✓
- Mixer stable ordering + in-place updates → Task 6. ✓
- Real mute-state sync (external mute) → Tasks 4 (onUpdated.mutedInfo), 5/6 (mutedInfo in render). ✓
- Global hotkeys → Tasks 1 (commands), 4 (handlers). ✓
- Playwright harness → Task 8. ✓
- Phasing P2/P3 (Brave/Edge/Firefox) → out of P1 scope, not tasked here (correct). ✓

**Placeholder scan:** No TBD/TODO; all code steps contain full code. ✓

**Type consistency:** `states[tabId] = {volume, muted}` used consistently across popup (Tasks 5, 6) and background (Task 4). `getAllVolumes` returns `{states}` (Task 4) and popup reads `res.states` (Task 5). `sendVolume`/`sendMuted` defined Task 5, used Tasks 5, 6. `window.__vmApply`/`__vmGains` defined Task 2, consumed Task 4 (fallback) + Task 8 (probe). `applyToElement` defined Task 2, replaced Task 7. ✓
