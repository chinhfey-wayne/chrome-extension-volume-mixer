const MAX_VOL = 150;

let allTabs = [];
let states = {}; // tabId -> { volume, muted }
let showAll = false;
const pausedTabs = new Set();
const removedTabIds = new Set(JSON.parse(localStorage.getItem('removedTabIds') || '[]'));

// ── Init ──
async function init() {
  [allTabs, states] = await Promise.all([
    chrome.tabs.query({}),
    getAllStates(),
  ]);
  render();
  startWaveformAnimation();

  const globalSlider = document.getElementById('globalSlider');
  syncGlobalUI(parseInt(globalSlider.value));

  globalSlider.addEventListener('input', onGlobalSlider);
  document.getElementById('globalStepDown').addEventListener('click', () => onGlobalStep(-5));
  document.getElementById('globalStepUp').addEventListener('click', () => onGlobalStep(5));
  document.getElementById('muteAllBtn').addEventListener('click', onMuteAll);
  document.getElementById('boostAllBtn').addEventListener('click', onBoostAll);
  document.getElementById('resetAllBtn').addEventListener('click', onResetAll);
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    allTabs = await chrome.tabs.query({});
    states = await getAllStates();
    render();
  });
  document.getElementById('toggleAllBtn').addEventListener('click', toggleShowAll);
  document.getElementById('addTabBtn').addEventListener('click', onAddTabBtn);

  document.addEventListener('click', e => {
    if (!e.target.closest('.more-btn') && !e.target.closest('.tab-menu')) {
      document.querySelectorAll('.tab-menu').forEach(m => m.classList.add('hidden'));
    }
    if (!e.target.closest('.add-tab-btn') && !e.target.closest('.add-tab-menu')) {
      document.getElementById('addTabMenu').classList.add('hidden');
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.audible !== undefined || changeInfo.status === 'complete' || changeInfo.mutedInfo !== undefined) {
      refreshTabsLive();
    }
  });
  chrome.tabs.onActivated.addListener(refreshTabsLive);
  chrome.tabs.onRemoved.addListener(refreshTabsLive);

  // Live-sync when state changes outside the popup (hotkeys write storage.local).
  chrome.storage.onChanged.addListener(onStorageChanged);

  // If this popup was opened by a shortcut (a fresh ping), run as an auto-closing
  // HUD. A real click/drag anywhere cancels that — the user is now in control.
  chrome.storage.session.get('hudPing', r => {
    if (r.hudPing && Date.now() - r.hudPing < 1500) startHud();
  });
  document.addEventListener('pointerdown', cancelHud);
}

// ── Shortcut HUD: auto-close the popup a short while after the last shortcut ──
const HUD_MS = 2500;
let hudTimer = null;
let hudActive = false;

function startHud() {
  hudActive = true;
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => { try { window.close(); } catch (_) {} }, HUD_MS);
}
function cancelHud() {
  hudActive = false;
  clearTimeout(hudTimer);
}

// Reflect external { volume, muted } changes on the matching card in real time.
function onStorageChanged(changes, area) {
  // Each shortcut pings session storage → (re)start the HUD close timer.
  if (area === 'session') {
    if (changes.hudPing) startHud();
    return;
  }
  if (area !== 'local') return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (!key.startsWith('vol_')) continue;
    const tabId = parseInt(key.slice(4));
    if (!newValue) { delete states[tabId]; continue; }
    states[tabId] = newValue;
    const card = document.querySelector(`.tab-card[data-tab-id="${tabId}"]`);
    if (!card) continue;
    const input = card.querySelector('.range-input');
    if (input !== document.activeElement) {
      const pct = Math.round(newValue.volume * 100);
      input.value = pct;
      if (pct > 0) input.dataset.prevVol = pct;
      syncSliderUI(card, pct); // updates knob position + percentage label
    }
    syncMuteUI(card, newValue.muted);
  }
}

async function refreshTabsLive() {
  allTabs = await chrome.tabs.query({});
  states = await getAllStates();
  render();
}

function toggleShowAll() {
  showAll = !showAll;
  document.getElementById('toggleAllBtn').classList.toggle('active', showAll);
  render();
}

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

function visibleTabs() {
  const tabs = allTabs.filter(t => !removedTabIds.has(t.id));

  const filtered = showAll
    ? tabs
    : tabs.filter(t => t.audible || states[t.id] !== undefined);

  // Stable: natural tab-strip position. Never reorder on audible/volume change.
  return filtered.sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));
}

// ── Global Output ──
function onGlobalSlider(e) {
  const pct = parseInt(e.target.value);
  const vol = pct / 100;
  document.getElementById('globalVolLabel').textContent = pct + '%';
  syncGlobalUI(pct);

  document.querySelectorAll('.tab-card').forEach(card => {
    const tabId = parseInt(card.dataset.tabId);
    const input = card.querySelector('.range-input');
    input.value = pct;
    if (vol > 0) input.dataset.prevVol = pct;
    syncSliderUI(card, pct);
    sendVolume(tabId, vol);
  });
}

function syncGlobalUI(pct) {
  const frac = Math.min(pct / MAX_VOL, 1);
  document.querySelector('.global-card .slider-track').style.setProperty('--pos', frac);
}

// ── Render ──
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
    const st = stateWithMuted(tab);
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

// A tab's effective state, folding in Chrome's real native mute.
function stateWithMuted(tab) {
  const s = states[tab.id] ?? { volume: 1.0, muted: false };
  return { volume: s.volume, muted: s.muted || !!tab.mutedInfo?.muted };
}

// Update an existing card in place — never during an active slider drag.
function updateCard(card, tab, st) {
  const input = card.querySelector('.range-input');
  if (input === document.activeElement) return;
  const pct = Math.round(st.volume * 100);
  if (parseInt(input.value) !== pct) { input.value = pct; syncSliderUI(card, pct); }
  syncMuteUI(card, st.muted);
  card.classList.toggle('audible', !!tab.audible);
  const name = card.querySelector('.tab-name');
  if (name && tab.title) name.textContent = trunc(tab.title, 28);
}

// Wire the per-card listeners (shared by first render and later inserts).
function wireCard(card) {
  card.querySelectorAll('.range-input').forEach(r => r.addEventListener('input', onSlider));
  card.querySelectorAll('.mute-btn').forEach(b => b.addEventListener('click', onMute));
  card.querySelectorAll('.pause-btn').forEach(b => b.addEventListener('click', onPause));
  card.querySelectorAll('.more-btn').forEach(b => b.addEventListener('click', onMoreMenu));
  card.querySelectorAll('.menu-item').forEach(b => b.addEventListener('click', onMenuAction));
  card.querySelectorAll('.vol-step-btn').forEach(b => b.addEventListener('click', onStepBtn));
}

function makeCard(tab, st, index = 0) {
  const vol = st.volume;
  const muted = st.muted;
  const pct = Math.round(vol * 100);
  const frac = Math.min(pct / MAX_VOL, 1);
  const isPaused = pausedTabs.has(tab.id);
  const hostname = tab.url ? (() => { try { return new URL(tab.url).hostname.replace('www.', ''); } catch { return ''; } })() : '';

  const card = document.createElement('div');
  card.className = 'tab-card glass-card' + (tab.audible ? ' audible' : '');
  card.dataset.tabId = tab.id;
  card.style.animationDelay = `${index * 45}ms`;

  const faviconHtml = tab.favIconUrl
    ? `<img class="tab-favicon" src="${esc(tab.favIconUrl)}">`
    : `<span class="material-symbols-outlined favicon-fallback">public</span>`;

  const waveHtml = tab.audible
    ? `<div class="waveform">
        <div class="bar" style="height:5px"></div>
        <div class="bar" style="height:10px"></div>
        <div class="bar" style="height:7px"></div>
      </div>`
    : '';

  card.innerHTML = `
    <div class="tab-header">
      <div class="tab-icon-area">
        ${faviconHtml}
        ${waveHtml}
      </div>
      <div class="tab-meta">
        <span class="tab-name" title="${esc(tab.title || '')}">${esc(trunc(tab.title || 'Untitled', 28))}</span>
        ${hostname ? `<span class="tab-url">${esc(hostname)}</span>` : ''}
      </div>
      <div class="tab-controls">
        <button class="ctrl-btn pause-btn ${isPaused ? 'paused' : ''}" data-tab-id="${tab.id}" title="${isPaused ? 'Resume' : 'Pause'}">
          <span class="material-symbols-outlined">${isPaused ? 'play_arrow' : 'pause'}</span>
        </button>
        <button class="ctrl-btn mute-btn ${muted ? 'muted' : ''}" data-tab-id="${tab.id}" title="${muted ? 'Unmute' : 'Mute'}">
          <span class="material-symbols-outlined">${muted ? 'volume_off' : 'volume_up'}</span>
        </button>
        <button class="ctrl-btn more-btn" data-tab-id="${tab.id}" title="More options">
          <span class="material-symbols-outlined">more_vert</span>
        </button>
      </div>
    </div>
    <div class="slider-row">
      <button class="vol-step-btn" data-dir="-1" data-tab-id="${tab.id}" title="Decrease volume" aria-label="Decrease volume">
        <span class="material-symbols-outlined">remove</span>
      </button>
      <div class="slider-track" style="--pos:${frac}">
        <div class="slider-fill"></div>
        <div class="slider-thumb"></div>
        <input type="range" class="range-input"
          min="0" max="${MAX_VOL}" value="${pct}"
          data-tab-id="${tab.id}" data-prev-vol="${vol === 0 ? 100 : pct}">
      </div>
      <button class="vol-step-btn" data-dir="1" data-tab-id="${tab.id}" title="Increase volume" aria-label="Increase volume">
        <span class="material-symbols-outlined">add</span>
      </button>
      <span class="vol-label">${pct}%</span>
    </div>
    <div class="tab-menu hidden" data-tab-id="${tab.id}">
      <button class="menu-item" data-action="close" data-tab-id="${tab.id}">
        <span class="material-symbols-outlined">tab_close</span>
        Close tab
      </button>
      <button class="menu-item danger" data-action="remove" data-tab-id="${tab.id}">
        <span class="material-symbols-outlined">remove_from_queue</span>
        Remove from list
      </button>
    </div>
  `;

  const favicon = card.querySelector('.tab-favicon');
  if (favicon) {
    favicon.addEventListener('error', () => {
      const fallback = document.createElement('span');
      fallback.className = 'material-symbols-outlined favicon-fallback';
      fallback.textContent = 'public';
      favicon.replaceWith(fallback);
    });
  }

  return card;
}

function syncSliderUI(card, pct) {
  const frac = Math.min(pct / MAX_VOL, 1);
  // Single source of truth: fill width and knob position both derive from --pos.
  card.querySelector('.slider-track').style.setProperty('--pos', frac);

  const label = card.querySelector('.vol-label');
  label.textContent = pct + '%';
  pulseLabel(label);
}

function syncMuteUI(card, muted) {
  const btn = card.querySelector('.mute-btn');
  if (!btn) return;
  const icon = btn.querySelector('.material-symbols-outlined');
  if (icon) icon.textContent = muted ? 'volume_off' : 'volume_up';
  btn.classList.toggle('muted', muted);
  btn.title = muted ? 'Unmute' : 'Mute';
}

function pulseLabel(el) {
  el.classList.remove('vol-pulse');
  void el.offsetWidth; // reflow to restart animation
  el.classList.add('vol-pulse');
}

// ── Step Buttons ──
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

function onGlobalStep(delta) {
  const slider = document.getElementById('globalSlider');
  slider.value = Math.max(0, Math.min(MAX_VOL, parseInt(slider.value) + delta));
  slider.dispatchEvent(new Event('input'));
}

// ── Slider ──
function onSlider(e) {
  const input = e.target;
  const tabId = parseInt(input.dataset.tabId);
  const pct = parseInt(input.value);
  const card = input.closest('.tab-card');
  syncSliderUI(card, pct);
  if (pct > 0) input.dataset.prevVol = pct;
  sendVolume(tabId, pct / 100);
}

// ── Mute ──
function onMute(e) {
  const btn = e.currentTarget;
  const tabId = parseInt(btn.dataset.tabId);
  const card = btn.closest('.tab-card');
  // Toggle relative to the REAL current mute (stored intent OR Chrome's tab state),
  // so unmuting an externally-muted tab works correctly.
  const tab = allTabs.find(t => t.id === tabId);
  const currentlyMuted = !!(stateFor(tabId).muted || tab?.mutedInfo?.muted);
  const muted = !currentlyMuted;
  sendMuted(tabId, muted);
  syncMuteUI(card, muted);
}

// ── Pause / Play ──
function onPause(e) {
  const btn = e.currentTarget;
  const tabId = parseInt(btn.dataset.tabId);
  const icon = btn.querySelector('.material-symbols-outlined');
  const isPaused = pausedTabs.has(tabId);

  if (isPaused) {
    pausedTabs.delete(tabId);
    icon.textContent = 'pause';
    btn.classList.remove('paused');
    btn.title = 'Pause';
    chrome.runtime.sendMessage({ type: 'playTab', tabId });
  } else {
    pausedTabs.add(tabId);
    icon.textContent = 'play_arrow';
    btn.classList.add('paused');
    btn.title = 'Resume';
    chrome.runtime.sendMessage({ type: 'pauseTab', tabId });
  }
}

// ── 3-dot menu ──
function onMoreMenu(e) {
  e.stopPropagation();

  const card = e.currentTarget.closest('.tab-card');
  const menu = card.querySelector('.tab-menu');
  const list = document.getElementById('tabs-list');
  const isOpen = !menu.classList.contains('hidden');

  document.querySelectorAll('.tab-menu').forEach(m => m.classList.add('hidden'));

  if (!isOpen) {
    menu.classList.remove('hidden');

    requestAnimationFrame(() => {
      const menuRect = menu.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const overflowBottom = menuRect.bottom - listRect.bottom + 24;
      if (overflowBottom > 0) {
        list.scrollTop += overflowBottom;
      }
    });
  }
}

function onMenuAction(e) {
  const action = e.currentTarget.dataset.action;
  const tabId = parseInt(e.currentTarget.dataset.tabId);
  const card = document.querySelector(`.tab-card[data-tab-id="${tabId}"]`);

  const removeCard = () => {
    card.style.animation = 'cardOut 0.2s cubic-bezier(0.4,0,1,1) forwards';
    setTimeout(() => {
      card.remove();
      allTabs = allTabs.filter(t => t.id !== tabId);
      delete states[tabId];
      const remaining = visibleTabs().length;
      document.getElementById('sourceCount').textContent =
        `${remaining} TAB${remaining !== 1 ? 'S' : ''}`;
      if (remaining === 0) document.getElementById('empty').classList.remove('hidden');
    }, 210);
  };

  if (action === 'close') {
    chrome.tabs.remove(tabId, () => { removeCard(); });
  } else if (action === 'remove') {
    removedTabIds.add(tabId);
    localStorage.setItem('removedTabIds', JSON.stringify([...removedTabIds]));
    removeCard();
  }
}

// ── Bulk actions ──
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

// ── Add-tab picker (restore removed tabs) ──
function onAddTabBtn(e) {
  e.stopPropagation();
  const menu = document.getElementById('addTabMenu');
  if (!menu.classList.contains('hidden')) {
    menu.classList.add('hidden');
    return;
  }

  if (removedTabIds.size === 0) {
    menu.innerHTML = '<div class="add-menu-empty">No removed tabs to restore.</div>';
    menu.classList.remove('hidden');
    return;
  }

  chrome.tabs.query({}, tabs => {
    const restorable = tabs.filter(t => removedTabIds.has(t.id));
    if (restorable.length === 0) {
      menu.innerHTML = '<div class="add-menu-empty">No removed tabs to restore.</div>';
    } else {
      menu.innerHTML = restorable.map(tab => `
        <button class="add-menu-item" data-tab-id="${tab.id}">
          ${tab.favIconUrl
            ? `<img src="${esc(tab.favIconUrl)}" width="16" height="16">`
            : `<span class="material-symbols-outlined" style="font-size:16px;color:#9ca3af">public</span>`}
          <span class="tab-pick-name">${esc(trunc(tab.title || 'Untitled', 30))}</span>
        </button>
      `).join('');
      menu.querySelectorAll('.add-menu-item').forEach(btn => {
        btn.addEventListener('click', () => {
          const tabId = parseInt(btn.dataset.tabId);
          removedTabIds.delete(tabId);
          localStorage.setItem('removedTabIds', JSON.stringify([...removedTabIds]));
          chrome.tabs.get(tabId, tab => {
            if (chrome.runtime.lastError) return;
            if (!allTabs.find(t => t.id === tabId)) allTabs.push(tab);
            menu.classList.add('hidden');
            render();
          });
        });
      });
    }
    menu.classList.remove('hidden');
  });
}

// ── Waveform animation ──
function startWaveformAnimation() {
  setInterval(() => {
    document.querySelectorAll('.waveform .bar').forEach(bar => {
      bar.style.height = (Math.floor(Math.random() * 9) + 4) + 'px';
    });
  }, 140);
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function trunc(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

document.addEventListener('DOMContentLoaded', init);
