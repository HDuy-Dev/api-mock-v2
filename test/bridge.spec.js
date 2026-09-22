const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage } = require('./helpers');

// An extension page that records every runtime message (plus the sender) sent by content scripts.
async function collector(context, extensionId) {
  const ext = await openExtensionPage(context, extensionId);
  await ext.evaluate(() => {
    window.__msgs = [];
    chrome.runtime.onMessage.addListener((msg, sender) => {
      window.__msgs.push({ msg, tabId: sender.tab && sender.tab.id, frameId: sender.frameId });
    });
  });
  return { ext, msgs: () => ext.evaluate(() => window.__msgs) };
}

const fetchText = (page, url) => page.evaluate((u) => fetch(u).then((r) => r.text()), url);

test.describe('bridge: rules', () => {
  test('applies rules seeded in storage, with no help from the test', async ({ context, server, serviceWorker }) => {
    await setState(serviceWorker, { rules: [rule({ url: '/mocked', response: { body: 'from-storage' } })] });
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    expect(await fetchText(page, '/mocked')).toBe('from-storage');
  });

  test('startup race: the first script of the page is already answered by the mock (spec assumption 3)', async ({ context, server, serviceWorker }) => {
    await setState(serviceWorker, { rules: [rule({ url: '/mocked-early', response: { body: 'early-ok' } })] });
    const page = await context.newPage();
    await page.goto(server.origin + '/startup-race.html');
    expect(await page.evaluate(() => window.__early)).toBe('early-ok');
  });

  test('live update: a storage change applies without reloading the page', async ({ context, server, serviceWorker }) => {
    await setState(serviceWorker, { rules: [rule({ id: 'a', url: '/mocked', response: { body: 'A' } })] });
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    expect(await fetchText(page, '/mocked')).toBe('A');
    await setState(serviceWorker, { rules: [rule({ id: 'a', url: '/mocked', response: { body: 'B' } })] });
    await expect.poll(() => fetchText(page, '/mocked')).toBe('B');
  });

  test('disabled rules and a global switch-off are not applied', async ({ context, server, serviceWorker }) => {
    const page = await context.newPage();
    await page.goto(server.origin + '/');

    await setState(serviceWorker, { rules: [rule({ url: '/mocked', enabled: false })] });
    await expect.poll(() => fetchText(page, '/mocked')).toContain('"source":"server"');

    await setState(serviceWorker, { globalEnabled: false, rules: [rule({ url: '/mocked', response: { body: 'on' } })] });
    await expect.poll(() => fetchText(page, '/mocked')).toContain('"source":"server"');

    await setState(serviceWorker, { globalEnabled: true, rules: [rule({ url: '/mocked', response: { body: 'on' } })] });
    await expect.poll(() => fetchText(page, '/mocked')).toBe('on');
  });

  test('the page cannot observe rules or rule names, only metadata-only events', async ({ context, server, serviceWorker }) => {
    await setState(serviceWorker, { rules: [rule({ name: 'Secret name', url: '/mocked', response: { body: 'secret-body' } })] });
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    await page.evaluate(() => {
      window.__seen = [];
      window.addEventListener('message', (e) => window.__seen.push(JSON.stringify(e.data)));
      window.addEventListener('message', (e) => window.__seen.push(JSON.stringify(e.data)), true);
    });
    // Force a fresh RULES push, then make the page issue mocked requests.
    await setState(serviceWorker, { rules: [rule({ name: 'Another secret', url: '/mocked', response: { body: 'secret-body-2' } })] });
    await expect.poll(() => fetchText(page, '/mocked')).toBe('secret-body-2');
    const seen = (await page.evaluate(() => window.__seen)).join('\n');
    expect(seen).not.toContain('__API_MOCK__/RULES"');
    expect(seen).not.toMatch(/secret/i);
    expect(seen).toContain('MOCK_EVENT');
  });
});

test.describe('bridge: events to the service worker', () => {
  test('forwards MOCK_EVENT with only ruleId, url, method and status, and a sender tab id (spec assumption 1)', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: [rule({ id: 'ev1', url: '/mocked', response: { status: 202 } })] });
    const { msgs } = await collector(context, extensionId);
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    await fetchText(page, '/mocked?a=1');
    await expect.poll(async () => (await msgs()).some((m) => m.msg.type === 'MOCK_EVENT')).toBe(true);
    const ev = (await msgs()).find((m) => m.msg.type === 'MOCK_EVENT');
    expect(ev.msg).toEqual({ type: 'MOCK_EVENT', ruleId: 'ev1', url: server.origin + '/mocked?a=1', method: 'GET', status: 202 });
    expect(typeof ev.tabId).toBe('number');
    expect(ev.frameId).toBe(0);
  });

  test('forged events from the page are validated and clipped', async ({ context, server, extensionId }) => {
    const { msgs } = await collector(context, extensionId);
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    await page.evaluate(() => {
      const post = (m) => window.postMessage(m, '*');
      post({ type: '__API_MOCK__/MOCK_EVENT', ruleId: 5, url: 'x', method: 'GET', status: 200 }); // ruleId not a string
      post({ type: '__API_MOCK__/MOCK_EVENT', ruleId: 'r', url: 'x', method: 'GET', status: 'abc' }); // status not an integer
      post({ type: '__API_MOCK__/MOCK_EVENT', ruleId: 'r', url: 'u'.repeat(5000), method: 'g'.repeat(50), status: 200 });
      post({ type: '__API_MOCK__/ENGINE_ERROR', message: 'm'.repeat(1000) });
      post({ type: '__API_MOCK__/SOMETHING_ELSE' });
    });
    await expect.poll(async () => (await msgs()).filter((m) => ['MOCK_EVENT', 'ENGINE_ERROR'].includes(m.msg.type)).length).toBe(2);
    const all = (await msgs()).map((m) => m.msg);
    const mock = all.find((m) => m.type === 'MOCK_EVENT');
    expect(mock.url).toHaveLength(2048);
    expect(mock.method).toBe('G'.repeat(16));
    const err = all.find((m) => m.type === 'ENGINE_ERROR');
    expect(err.message).toHaveLength(300);
    expect(err.ruleId).toBeNull();
    expect(all.filter((m) => m.type === 'MOCK_EVENT')).toHaveLength(1);
  });

  test('a flood of events is rate limited', async ({ context, server, extensionId }) => {
    const { msgs } = await collector(context, extensionId);
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    await page.evaluate(() => {
      for (let i = 0; i < 200; i++) {
        window.postMessage({ type: '__API_MOCK__/MOCK_EVENT', ruleId: 'r', url: '/x', method: 'GET', status: 200 }, '*');
      }
    });
    await page.waitForTimeout(300);
    const n = (await msgs()).filter((m) => m.msg.type === 'MOCK_EVENT').length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(50);
  });

  test('PAGE_START comes from the top frame only', async ({ context, server, extensionId }) => {
    const { msgs } = await collector(context, extensionId);
    const page = await context.newPage();
    await page.goto(server.origin + '/frame-parent.html');
    await expect.poll(async () => (await msgs()).filter((m) => m.msg.type === 'PAGE_START').length).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(300); // give the iframe time to start too
    const starts = (await msgs()).filter((m) => m.msg.type === 'PAGE_START');
    expect(starts).toHaveLength(1);
    expect(starts[0].frameId).toBe(0);
  });
});

test.describe('bridge: PING (spec assumptions 1 and 8)', () => {
  test('a tab with the bridge answers PING; a tab without it does not', async ({ context, server, extensionId }) => {
    const { ext, msgs } = await collector(context, extensionId);
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    await expect.poll(async () => (await msgs()).some((m) => m.msg.type === 'PAGE_START')).toBe(true);
    const tabId = (await msgs()).find((m) => m.msg.type === 'PAGE_START').tabId;

    const ping = (id) =>
      ext.evaluate(
        (t) => chrome.tabs.sendMessage(t, { type: 'PING' }, { frameId: 0 }).then((r) => r, () => 'no receiver'),
        id,
      );
    expect(await ping(tabId)).toEqual({ ok: true });

    // An extension page has no content scripts, so it stands in for a tab without an engine.
    const other = await openExtensionPage(context, extensionId, 'popup/popup.html?other');
    const otherId = await other.evaluate(() => chrome.tabs.getCurrent().then((t) => t.id));
    expect(await ping(otherId)).toBe('no receiver');
  });
});
