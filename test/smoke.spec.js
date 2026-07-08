const { test, expect, chromium } = require('@playwright/test');
const http = require('http');
const path = require('path');

const EXT = path.resolve(__dirname, '..');

// Extensions do not inject into file:// pages by default, so serve the fixture
// over http://localhost (covered by the <all_urls> content-script match).
const FIXTURE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>vm-test</title></head>
<body><script>
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.connect(g); g.connect(ctx.destination);
  osc.start();
  window.__readGain = () => (window.__vmGains && window.__vmGains[0] ? window.__vmGains[0].gain.value : null);
</script></body></html>`;

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FIXTURE);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function launch() {
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  return { ctx, extId };
}

test('popup opens and screenshots without uncaught errors', async () => {
  const { ctx, extId } = await launch();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await page.waitForSelector('.widget');
  await page.screenshot({ path: path.join(__dirname, 'popup.png') });
  expect(pageErrors).toEqual([]);
  await ctx.close();
});

test('injected engine scales the AudioContext gain', async () => {
  const server = await startServer();
  const port = server.address().port;
  const { ctx, extId } = await launch();
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof window.__vmApply === 'function');
  await page.waitForFunction(() => window.__readGain() !== null);
  await page.evaluate(() => window.__vmApply(0.25));
  const g = await page.evaluate(() => window.__readGain());
  expect(g).toBeCloseTo(0.25, 2);
  await ctx.close();
  server.close();
});
