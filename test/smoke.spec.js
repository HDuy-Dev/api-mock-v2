const { test, expect } = require('./fixtures');
const { openExtensionPage, rule, pushRules } = require('./helpers');

test('extension loads with a running service worker and the minimal manifest', async ({ extensionId, serviceWorker }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(['storage']);
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.minimum_chrome_version).toBe('111');
});

test('engine content script runs in the MAIN world of a plain http page (spec assumptions 1 and 7)', async ({ context, server }) => {
  const page = await context.newPage();
  await page.goto(server.origin + '/');
  await pushRules(page, [rule({ url: '/mocked' })]);
  expect(await page.evaluate(() => fetch('/mocked').then((r) => r.text()))).toBe('{"mocked":true}');
});

test('bridge content script (ISOLATED world) reports PAGE_START to extension pages', async ({ context, server, extensionId }) => {
  const ext = await openExtensionPage(context, extensionId);
  await ext.evaluate(() => {
    window.__msgs = [];
    chrome.runtime.onMessage.addListener((msg) => {
      window.__msgs.push(msg);
    });
  });
  const page = await context.newPage();
  await page.goto(server.origin + '/');
  await expect.poll(() => ext.evaluate(() => window.__msgs.map((m) => m.type))).toContain('PAGE_START');
});
