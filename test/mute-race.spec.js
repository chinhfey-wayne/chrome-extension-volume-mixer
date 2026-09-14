const { test, expect, chromium } = require('@playwright/test');
const http = require('http');
const path = require('path');

const EXT = path.resolve(__dirname, '..');

// A genuinely audible page — real audio output, so Chrome's own tab.audible
// flag flips and background.js's reassert() fires concurrently, the same as
// a real YouTube/Meet tab, unlike a silent static page.
const AUDIBLE_FIXTURE = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body><script>
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  g.gain.value = 0.05;
  osc.connect(g); g.connect(ctx.destination);
  osc.start();
</script></body></html>`;

function startAudibleServer() {
  return new Promise(resolve => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(AUDIBLE_FIXTURE);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function launch() {
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  return { ctx, sw, extId };
}

test('rapid native mute toggles settle to the last real value, in storage and in an open popup', async () => {
  const { ctx, sw, extId } = await launch();

  const page = await ctx.newPage();
  await page.goto('https://example.com');
  const tabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(t => t.url && t.url.includes('example.com')).id;
  });

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('.widget');

  // Simulate a burst of native mute/unmute toggles fired back-to-back — the
  // same shape as a user rapidly right-clicking "Mute Site" / "Unmute Site",
  // or as two of Chrome's own onUpdated events landing close together.
  await sw.evaluate(async (id) => {
    await chrome.tabs.update(id, { muted: true });
    await chrome.tabs.update(id, { muted: false });
    await chrome.tabs.update(id, { muted: true });
    await chrome.tabs.update(id, { muted: false });
  }, tabId);

  // Give the extension's async storage/adopt chain a moment to fully settle.
  await new Promise(r => setTimeout(r, 500));

  const real = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).mutedInfo.muted, tabId);
  const stored = await sw.evaluate(async (id) => {
    const key = `vol_${id}`;
    const r = await chrome.storage.local.get(key);
    return r[key]?.muted;
  }, tabId);

  expect(real).toBe(false);
  expect(stored).toBe(false); // storage must match the last real toggle, not an earlier one

  // Force the open popup to re-render from current storage/state and check its DOM.
  await popup.evaluate(() => { if (typeof refreshTabsLive === 'function') refreshTabsLive(); });
  await popup.waitForTimeout(300);
  const cardMuted = await popup.evaluate((id) => {
    const card = document.querySelector(`.tab-card[data-tab-id="${id}"]`);
    return card ? card.querySelector('.mute-btn')?.classList.contains('muted') : null;
  }, tabId);

  expect(cardMuted).toBe(false);

  await ctx.close();
});

test('a single native mute live-updates an already-open popup with no manual refresh', async () => {
  const { ctx, sw, extId } = await launch();

  const page = await ctx.newPage();
  await page.goto('https://example.com');
  const tabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(t => t.url && t.url.includes('example.com')).id;
  });

  // Popup is open BEFORE the native mute happens — this is the exact scenario
  // reported: right-click "Mute Site" while the popup stays open, with no
  // manual reopen/refresh, and check whether it reflects live.
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('.widget');

  await sw.evaluate(async (id) => { await chrome.tabs.update(id, { muted: true }); }, tabId);

  // Passive wait only — no forced refreshTabsLive()/render() call — to prove
  // storage.onChanged alone drives the live update, the way it must for a
  // popup a user is actually looking at.
  await popup.waitForTimeout(500);

  const cardMuted = await popup.evaluate((id) => {
    const card = document.querySelector(`.tab-card[data-tab-id="${id}"]`);
    return card ? card.querySelector('.mute-btn')?.classList.contains('muted') : null;
  }, tabId);

  expect(cardMuted).toBe(true);

  await ctx.close();
});

test('native mute/unmute on a genuinely audible tab (reassert() firing concurrently) stays correct', async () => {
  const server = await startAudibleServer();
  const port = server.address().port;
  const { ctx, sw, extId } = await launch();

  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof window.__vmApply === 'function');
  await page.waitForFunction(() => window.__vmGains && window.__vmGains.length > 0);
  const tabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(t => t.url && t.url.includes('127.0.0.1')).id;
  });
  // Confirm Chrome actually considers this tab audible before proceeding —
  // that's what makes reassert() fire repeatedly via the audible-flip path.
  let audible = false;
  for (let i = 0; i < 20 && !audible; i++) {
    audible = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).audible, tabId);
    if (!audible) await new Promise(r => setTimeout(r, 200));
  }
  expect(audible).toBe(true);

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('.widget');

  await sw.evaluate(async (id) => { await chrome.tabs.update(id, { muted: true }); }, tabId);
  await new Promise(r => setTimeout(r, 800)); // let reassert()/audible churn overlap with the mute adopt
  await sw.evaluate(async (id) => { await chrome.tabs.update(id, { muted: false }); }, tabId);
  await new Promise(r => setTimeout(r, 800));

  const real = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).mutedInfo.muted, tabId);
  const stored = await sw.evaluate(async (id) => {
    const key = `vol_${id}`;
    const r = await chrome.storage.local.get(key);
    return r[key]?.muted;
  }, tabId);
  expect(real).toBe(false);
  expect(stored).toBe(false);

  const cardMuted = await popup.evaluate((id) => {
    const card = document.querySelector(`.tab-card[data-tab-id="${id}"]`);
    return card ? card.querySelector('.mute-btn')?.classList.contains('muted') : null;
  }, tabId);
  expect(cardMuted).toBe(false);

  await ctx.close();
  server.close();
});
