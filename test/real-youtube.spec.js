const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const EXT = path.resolve(__dirname, '..');
const LOG_PATH = path.join(__dirname, 'real-youtube.log');

const URL1 = 'https://www.youtube.com/watch?v=UwuAPyOImoI&list=RDLsmcZqWmx5I&index=2';
const URL2 = 'https://www.youtube.com/watch?v=NQiAh7sNPGc&list=RDNQiAh7sNPGc&start_radio=1';

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

function attachLogger(target, label, lines) {
  target.on('console', msg => {
    const text = msg.text();
    if (text.includes('[VolumeControl]')) lines.push(`[${label}] ${text}`);
  });
}

test('real youtube tabs, one at a time, with full log capture', async () => {
  const lines = [];
  const { ctx, sw, extId } = await launch();
  attachLogger(sw, 'sw', lines);

  const page1 = await ctx.newPage();
  attachLogger(page1, 'yt1', lines);
  await page1.goto(URL1);
  await page1.waitForTimeout(4000); // let it actually start playing

  const tabId1 = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(t => t.url && t.url.includes('youtube.com/watch')).id;
  });
  lines.push(`[test] tab1=${tabId1}`);

  const popup = await ctx.newPage();
  attachLogger(popup, 'popup', lines);
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('.widget');
  await popup.waitForTimeout(1000);

  // ---- Step 1: single tab — click the extension's own mute button ----
  await popup.waitForSelector(`.tab-card[data-tab-id="${tabId1}"]`, { timeout: 10000 }).catch(() => {});
  const hasCard1 = await popup.evaluate((id) => !!document.querySelector(`.tab-card[data-tab-id="${id}"]`), tabId1);
  lines.push(`[test] step1 hasCard1=${hasCard1}`);
  if (hasCard1) {
    await popup.click(`.tab-card[data-tab-id="${tabId1}"] .mute-btn`);
    await popup.waitForTimeout(1000);
    const real1 = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).mutedInfo.muted, tabId1);
    const card1 = await popup.evaluate((id) => document.querySelector(`.tab-card[data-tab-id="${id}"] .mute-btn`).classList.contains('muted'), tabId1);
    lines.push(`[test] step1 after click: real=${real1} card=${card1}`);
  }

  // ---- Step 2: open second tab, wait, THEN re-check first tab's card ----
  const page2 = await ctx.newPage();
  attachLogger(page2, 'yt2', lines);
  await page2.goto(URL2);
  await page2.waitForTimeout(4000);

  const tabId2 = await sw.evaluate(async (excludeId) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(t => t.url && t.url.includes('youtube.com/watch') && t.id !== excludeId).id;
  }, tabId1);
  lines.push(`[test] tab2=${tabId2}`);

  await popup.waitForTimeout(2000); // let the second tab settle into the popup's list

  const real1After2 = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).mutedInfo.muted, tabId1);
  const card1After2 = await popup.evaluate((id) => {
    const btn = document.querySelector(`.tab-card[data-tab-id="${id}"] .mute-btn`);
    return btn ? btn.classList.contains('muted') : null;
  }, tabId1);
  lines.push(`[test] step2 tab1 after tab2 opened: real=${real1After2} card=${card1After2}`);

  // ---- Step 3: now mute tab2 via the extension, check both cards ----
  await popup.waitForSelector(`.tab-card[data-tab-id="${tabId2}"]`, { timeout: 10000 }).catch(() => {});
  const hasCard2 = await popup.evaluate((id) => !!document.querySelector(`.tab-card[data-tab-id="${id}"]`), tabId2);
  lines.push(`[test] step3 hasCard2=${hasCard2}`);
  if (hasCard2) {
    await popup.click(`.tab-card[data-tab-id="${tabId2}"] .mute-btn`);
    await popup.waitForTimeout(1000);
    const real2 = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).mutedInfo.muted, tabId2);
    const card2 = await popup.evaluate((id) => document.querySelector(`.tab-card[data-tab-id="${id}"] .mute-btn`).classList.contains('muted'), tabId2);
    const real1Final = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).mutedInfo.muted, tabId1);
    const card1Final = await popup.evaluate((id) => document.querySelector(`.tab-card[data-tab-id="${id}"] .mute-btn`).classList.contains('muted'), tabId1);
    lines.push(`[test] step3 after muting tab2: tab2 real=${real2} card=${card2} | tab1 real=${real1Final} card=${card1Final}`);
  }

  // ---- Step 4: right-click-equivalent native unmute on tab1 while tab2 exists ----
  await sw.evaluate(async (id) => { await chrome.tabs.update(id, { muted: false }); }, tabId1);
  await popup.waitForTimeout(1500);
  const real1Native = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).mutedInfo.muted, tabId1);
  const card1Native = await popup.evaluate((id) => document.querySelector(`.tab-card[data-tab-id="${id}"] .mute-btn`).classList.contains('muted'), tabId1);
  lines.push(`[test] step4 native unmute tab1 with tab2 present: real=${real1Native} card=${card1Native}`);

  fs.writeFileSync(LOG_PATH, lines.join('\n') + '\n');

  await ctx.close();
});
