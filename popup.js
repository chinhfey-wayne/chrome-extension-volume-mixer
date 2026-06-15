const MAX_VOL = 150;

let allTabs = [];
let volumes = {};
let showAll = false;

// ── Init ──
async function init() {
  [allTabs, volumes] = await Promise.all([
    chrome.tabs.query({}),
    getAllVolumes(),
  ]);
  render();
  startWaveformAnimation();

  document.getElementById('globalSlider').addEventListener('input', onGlobalSlider);
  document.getElementById('muteAllBtn').addEventListener('click', onMuteAll);
  document.getElementById('boostAllBtn').addEventListener('click', onBoostAll);
  document.getElementById('resetAllBtn').addEventListener('click', onResetAll);
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    allTabs = await chrome.tabs.query({});
    volumes = await getAllVolumes();
    render();
  });
  document.getElementById('toggleAllBtn').addEventListener('click', toggleShowAll);
  document.getElementById('showAllNavBtn').addEventListener('click', toggleShowAll);
}

function toggleShowAll() {
  showAll = !showAll;
  document.getElementById('showAllNavBtn').classList.toggle('active', showAll);
  document.getElementById('mixerNavBtn').classList.toggle('active', !showAll);
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
  if (showAll) return allTabs;
  return allTabs.filter(t =>
    t.audible || (volumes[t.id] !== undefined && volumes[t.id] !== 1.0)
  );
}

// ── Global Output slider ──
function onGlobalSlider(e) {
  const pct = parseInt(e.target.value);
  const vol = pct / 100;

  document.getElementById('globalVolLabel').textContent = pct + '%';
  syncGlobalUI(pct);

  // Apply to all visible tab cards without re-rendering
  document.querySelectorAll('.tab-card').forEach(card => {
    const tabId = parseInt(card.dataset.tabId);
    volumes[tabId] = vol;
    const input = card.querySelector('.range-input');
    input.value = pct;
    input.dataset.prevVol = pct > 0 ? pct : input.dataset.prevVol;
    syncSliderUI(card, pct);
    chrome.runtime.sendMessage({ type: 'setTabVolume', tabId, volume: vol });
  });
}

function syncGlobalUI(pct) {
  const fillPct = Math.min((pct / MAX_VOL) * 100, 100);
  const thumbPct = Math.min((pct / MAX_VOL) * 100, 96);
  document.getElementById('globalFill').style.width = fillPct + '%';
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
  tabs.forEach(tab => list.appendChild(makeCard(tab, volumes[tab.id] ?? 1.0)));
  list.querySelectorAll('.range-input').forEach(r => r.addEventListener('input', onSlider));
  list.querySelectorAll('.mute-btn').forEach(b => b.addEventListener('click', onMute));
}

function makeCard(tab, vol) {
  const pct = Math.round(vol * 100);
  const fillPct = Math.min((pct / MAX_VOL) * 100, 100);
  const thumbPct = Math.min((pct / MAX_VOL) * 100, 96);
  const hostname = tab.url ? (() => { try { return new URL(tab.url).hostname.replace('www.', ''); } catch { return ''; } })() : '';

  const card = document.createElement('div');
  card.className = 'tab-card glass-card' + (tab.audible ? ' audible' : '');
  card.dataset.tabId = tab.id;

  const faviconHtml = tab.favIconUrl
    ? `<img class="tab-favicon" src="${esc(tab.favIconUrl)}" onerror="this.style.display='none'">`
    : `<span class="material-symbols-outlined favicon-fallback">public</span>`;

  const waveHtml = tab.audible
    ? `<div class="waveform">
        <div class="bar" style="height:6px"></div>
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
        <span class="tab-name" title="${esc(tab.title || '')}">${esc(trunc(tab.title || 'Untitled', 32))}</span>
        ${hostname ? `<span class="tab-url">${esc(hostname)}</span>` : ''}
      </div>
      <button class="mute-btn ${vol === 0 ? 'muted' : ''}" data-tab-id="${tab.id}">
        <span class="material-symbols-outlined">${vol === 0 ? 'volume_off' : 'volume_up'}</span>
      </button>
    </div>
    <div class="slider-row">
      <div class="slider-track">
        <div class="slider-fill" style="width:${fillPct}%"></div>
        <div class="slider-thumb" style="left:${thumbPct}%"></div>
        <input type="range" class="range-input"
          min="0" max="${MAX_VOL}" value="${pct}"
          data-tab-id="${tab.id}" data-prev-vol="${pct}">
      </div>
      <span class="vol-label">${pct}%</span>
    </div>
  `;
  return card;
}

function syncSliderUI(card, pct) {
  const fillPct = Math.min((pct / MAX_VOL) * 100, 100);
  const thumbPct = Math.min((pct / MAX_VOL) * 100, 96);
  card.querySelector('.slider-fill').style.width = fillPct + '%';
  card.querySelector('.slider-thumb').style.left = thumbPct + '%';
  card.querySelector('.vol-label').textContent = pct + '%';
  const vol = pct / 100;
  card.querySelector('.mute-btn .material-symbols-outlined').textContent =
    vol === 0 ? 'volume_off' : 'volume_up';
  card.querySelector('.mute-btn').classList.toggle('muted', vol === 0);
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
  chrome.runtime.sendMessage({ type: 'setTabVolume', tabId, volume: newVol });
}

// ── Bulk actions ──
function onMuteAll() {
  visibleTabs().forEach(tab => {
    if ((volumes[tab.id] ?? 1.0) > 0) {
      volumes[tab.id] = 0;
      chrome.runtime.sendMessage({ type: 'setTabVolume', tabId: tab.id, volume: 0 });
    }
  });
  render();
}

function onBoostAll() {
  visibleTabs().forEach(tab => {
    volumes[tab.id] = 1.5;
    chrome.runtime.sendMessage({ type: 'setTabVolume', tabId: tab.id, volume: 1.5 });
  });
  render();
}

function onResetAll() {
  visibleTabs().forEach(tab => {
    volumes[tab.id] = 1.0;
    chrome.runtime.sendMessage({ type: 'setTabVolume', tabId: tab.id, volume: 1.0 });
  });
  render();
  // reset global slider UI too
  document.getElementById('globalSlider').value = 100;
  document.getElementById('globalVolLabel').textContent = '100%';
  syncGlobalUI(100);
}

// ── Waveform animation (random heights like new design) ──
function startWaveformAnimation() {
  setInterval(() => {
    document.querySelectorAll('.waveform .bar').forEach(bar => {
      const h = Math.floor(Math.random() * 10) + 4;
      bar.style.height = h + 'px';
    });
  }, 140);
}

// ── Helpers ──
function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function trunc(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

document.addEventListener('DOMContentLoaded', init);
