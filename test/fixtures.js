const { test: base, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./server');

const EXTENSION_PATH = path.resolve(__dirname, '..');

const test = base.extend({
  server: [
    async ({}, use) => {
      const s = await startServer();
      await use(s);
      await s.close();
    },
    { scope: 'worker' },
  ],

  // A fresh profile per test: no state leaks between tests.
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-mock-v2-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium', // new headless mode, required for extensions
      headless: !process.env.HEADED,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },

  // A plain Chromium page (no extension) with only engine.js injected at document start.
  // No bridge: the test controls exactly when RULES arrive.
  enginePage: async ({ browser }, use) => {
    const context = await browser.newContext();
    await context.addInitScript({ path: path.join(EXTENSION_PATH, 'engine.js') });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

module.exports = { test, expect };
