const MAX_VOL = 150;

let allTabs = [];
let volumes = {};
let showAll = false;
const pausedTabs = new Set();
const removedTabIds = new Set(JSON.parse(localStorage.getItem('removedTabIds') || '[]'));

// ── Init ──
async function init() {
  [allTabs, volumes] = await Promise.all([
    chrome.tabs.query({}),
    getAllVolumes(),
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
    volumes = await getAllVolumes();
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
    if (changeInfo.audible !== undefined || changeInfo.status === 'complete') {
      refreshTabsLive();
    }
  });
  chrome.tabs.onActivated.addListener(refreshTabsLive);
  chrome.tabs.onRemoved.addListener(refreshTabsLive);
}

async function refreshTabsLive() {
  const latestTabs = await chrome.tabs.query({});
  const latestVolumes = await getAllVolumes();

  allTabs = latestTabs;
  volumes = latestVolumes;
  render();
}

function toggleShowAll() {
  showAll = !showAll;
  document.getElementById('toggleAllBtn').classList.toggle('active', showAll);
  render();
}

function getAllVolumes() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'getAllVolumes' }, res => {
      if (chrome.runtime.lastError) return resolve({});
      resolve(res?.volumes ?? {});
    });
  });
}

function visibleTabs() {
  const tabs = allTabs.filter(t => !removedTabIds.has(t.id));

  const filtered = showAll
    ? tabs
    : tabs.filter(t => t.audible || volumes[t.id] !== undefined);

  return filtered.sort((a, b) => {
    if (a.audible && !b.audible) return -1;
    if (!a.audible && b.audible) return 1;
    return a.index - b.index;
  });
}

// Direct native mute — no background roundtrip, no service-worker wakeup delay
function nativeMute(tabId, muted) {
  chrome.tabs.update(tabId, { muted }, () => { void chrome.runtime.lastError; });
}

// ── Global Output ──
function onGlobalSlider(e) {
  const pct = parseInt(e.target.value);
  const vol = pct / 100;
  document.getElementById('globalVolLabel').textContent = pct + '%';
  syncGlobalUI(pct);

  document.querySelectorAll('.tab-card').forEach(card => {
    const tabId = parseInt(card.dataset.tabId);
    volumes[tabId] = vol;
    const input = card.querySelector('.range-input');
    input.value = pct;
    if (vol > 0) input.dataset.prevVol = pct;
    syncSliderUI(card, pct);
    nativeMute(tabId, vol === 0);
    chrome.runtime.sendMessage({ type: 'setTabVolume', tabId, volume: vol });
  });
}

function syncGlobalUI(pct) {
  const fillScale = Math.min(pct / MAX_VOL, 1);
  const thumbPct = Math.max(Math.min((pct / MAX_VOL) * 100 - 2, 94), 2);
  document.getElementById('globalFill').style.transform = `scaleX(${fillScale})`;
  document.getElementById('globalThumb').style.left = thumbPct + '%';
}

// ── Render ──
function render() {
  const list = document.getElementById('tabs-list');
  const empty = document.getElementById('empty');
  const tabs = visibleTabs();

  document.getElementById('sourceCount').textContent =
    `${tabs.length} TAB${tabs.length !== 1 ? 'S' : ''}`;

  if (tabs.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = '';
  tabs.forEach((tab, i) => {
    const card = makeCard(tab, volumes[tab.id] ?? 1.0, i);
    list.appendChild(card);
  });

  list.querySelectorAll('.range-input').forEach(r => r.addEventListener('input', onSlider));
  list.querySelectorAll('.mute-btn').forEach(b => b.addEventListener('click', onMute));
  list.querySelectorAll('.pause-btn').forEach(b => b.addEventListener('click', onPause));
  list.querySelectorAll('.more-btn').forEach(b => b.addEventListener('click', onMoreMenu));
  list.querySelectorAll('.menu-item').forEach(b => b.addEventListener('click', onMenuAction));
  list.querySelectorAll('.vol-step-btn').forEach(b => b.addEventListener('click', onStepBtn));
}

function makeCard(tab, vol, index = 0) {
  const pct = Math.round(vol * 100);
  const fillScale = Math.min(pct / MAX_VOL, 1);
  const thumbPct = Math.max(Math.min((pct / MAX_VOL) * 100 - 2, 94), 2);
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
        <button class="ctrl-btn mute-btn ${vol === 0 ? 'muted' : ''}" data-tab-id="${tab.id}" title="${vol === 0 ? 'Unmute' : 'Mute'}">
          <span class="material-symbols-outlined">${vol === 0 ? 'volume_off' : 'volume_up'}</span>
        </button>
        <button class="ctrl-btn more-btn" data-tab-id="${tab.id}" title="More options">
          <span class="material-symbols-outlined">more_vert</span>
        </button>
      </div>
    </div>
    <div class="slider-row">
      <button class="vol-step-btn" data-dir="-1" data-tab-id="${tab.id}" title="Decrease volume">&#9664;</button>
      <div class="slider-track">
        <div class="slider-fill" style="transform:scaleX(${fillScale})"></div>
        <div class="slider-thumb" style="left:${thumbPct}%"></div>
        <input type="range" class="range-input"
          min="0" max="${MAX_VOL}" value="${pct}"
          data-tab-id="${tab.id}" data-prev-vol="${vol === 0 ? 100 : pct}">
      </div>
      <button class="vol-step-btn" data-dir="1" data-tab-id="${tab.id}" title="Increase volume">&#9654;</button>
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
  const fillScale = Math.min(pct / MAX_VOL, 1);
  const thumbPct = Math.max(Math.min((pct / MAX_VOL) * 100 - 2, 94), 2);
  card.querySelector('.slider-fill').style.transform = `scaleX(${fillScale})`;
  card.querySelector('.slider-thumb').style.left = thumbPct + '%';

  const label = card.querySelector('.vol-label');
  label.textContent = pct + '%';
  pulseLabel(label);

  const vol = pct / 100;
  card.querySelector('.mute-btn .material-symbols-outlined').textContent =
    vol === 0 ? 'volume_off' : 'volume_up';
  card.querySelector('.mute-btn').classList.toggle('muted', vol === 0);
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
  const vol = newPct / 100;
  if (vol > 0) input.dataset.prevVol = newPct;
  syncSliderUI(card, newPct);
  volumes[tabId] = vol;
  nativeMute(tabId, vol === 0);
  chrome.runtime.sendMessage({ type: 'setTabVolume', tabId, volume: vol });
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
  const vol = pct / 100;
  const card = input.closest('.tab-card');
  syncSliderUI(card, pct);
  if (vol > 0) input.dataset.prevVol = pct;
  volumes[tabId] = vol;
  nativeMute(tabId, vol === 0);
  chrome.runtime.sendMessage({ type: 'setTabVolume', tabId, volume: vol });
}

// ── Mute ──
function onMute(e) {
  const btn = e.currentTarget;
  const tabId = parseInt(btn.dataset.tabId);
  const card = btn.closest('.tab-card');
  const input = card.querySelector('.range-input');
  const currentVol = volumes[tabId] ?? 1.0;

  const newVol = currentVol === 0
    ? parseFloat(input.dataset.prevVol ?? 100) / 100
    : (() => { input.dataset.prevVol = Math.round(currentVol * 100); return 0; })();

  const newPct = Math.round(newVol * 100);
  input.value = newPct;
  syncSliderUI(card, newPct);
  volumes[tabId] = newVol;
  nativeMute(tabId, newVol === 0);
  chrome.runtime.sendMessage({ type: 'setTabVolume', tabId, volume: newVol });
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
      delete volumes[tabId];
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
  visibleTabs().forEach(tab => {
    volumes[tab.id] = 0;
    nativeMute(tab.id, true);
    chrome.runtime.sendMessage({ type: 'setTabVolume', tabId: tab.id, volume: 0 });
  });
  render();
}

function onBoostAll() {
  visibleTabs().forEach(tab => {
    volumes[tab.id] = 1.5;
    nativeMute(tab.id, false);
    chrome.runtime.sendMessage({ type: 'setTabVolume', tabId: tab.id, volume: 1.5 });
  });
  render();
}

function onResetAll() {
  visibleTabs().forEach(tab => {
    volumes[tab.id] = 1.0;
    nativeMute(tab.id, false);
    chrome.runtime.sendMessage({ type: 'setTabVolume', tabId: tab.id, volume: 1.0 });
  });
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
