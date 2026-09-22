const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage } = require('./helpers');

const session = (sw) => sw.evaluate(() => chrome.storage.session.get(null));
const localKey = (sw, key) => sw.evaluate((k) => chrome.storage.local.get(k).then((r) => r[k]), key);
const post = (page, message) => page.evaluate((m) => window.postMessage(m, '*'), message);
const fetchText = (page, url) => page.evaluate((u) => fetch(u).then((r) => r.text()), url);

// The log and counters of the single open tab.
async function tabData(sw) {
  const s = await session(sw);
  const lk = Object.keys(s).find((k) => k.startsWith('log:'));
  const tk = Object.keys(s).find((k) => k.startsWith('tab:'));
  return { log: lk ? s[lk] : [], counters: tk ? s[tk] : null, tabId: tk ? Number(tk.slice(4)) : null };
}

async function openMocked({ context, server, serviceWorker }, rules) {
  await setState(serviceWorker, { rules });
  const page = await context.newPage();
  await page.goto(server.origin + '/');
  return page;
}

test.describe('service worker: log, counters and hits', () => {
  test('logs a mocked request with the rule name and delay, and counts it', async ({ context, server, serviceWorker }) => {
    const page = await openMocked({ context, server, serviceWorker }, [
      rule({ id: 'r1', name: 'Users list', url: '/mocked', response: { status: 500, delay: 5 } }),
    ]);
    await fetchText(page, '/mocked');
    await expect.poll(async () => (await tabData(serviceWorker)).log.length).toBe(1);
    const { log, counters } = await tabData(serviceWorker);
    expect(log[0]).toMatchObject({
      kind: 'mock', method: 'GET', url: server.origin + '/mocked', ruleId: 'r1', ruleName: 'Users list', status: 500, delay: 5,
    });
    expect(typeof log[0].ts).toBe('number');
    expect(counters).toEqual({ mocked: 1, issues: 0 });
  });

  test('counts hits and flushes them to storage.local about a second later', async ({ context, server, serviceWorker }) => {
    const page = await openMocked({ context, server, serviceWorker }, [rule({ id: 'r1', url: '/mocked' })]);
    for (let i = 0; i < 3; i++) await fetchText(page, '/mocked');
    await expect.poll(async () => (await localKey(serviceWorker, 'hits'))?.r1, { timeout: 5000 }).toBe(3);
  });

  test('hit counting never rewrites the rule state (so it never triggers a RULES push)', async ({ context, server, serviceWorker, extensionId }) => {
    const page = await openMocked({ context, server, serviceWorker }, [rule({ id: 'r1', url: '/mocked' })]);
    const ext = await openExtensionPage(context, extensionId);
    await ext.evaluate(() => {
      window.__changed = [];
      chrome.storage.onChanged.addListener((changes, area) => window.__changed.push(`${area}:${Object.keys(changes).join(',')}`));
    });
    for (let i = 0; i < 3; i++) await fetchText(page, '/mocked');
    await expect.poll(() => ext.evaluate(() => window.__changed), { timeout: 5000 }).toContain('local:hits');
    expect((await ext.evaluate(() => window.__changed)).filter((c) => c.includes('state'))).toEqual([]);
  });

  test('a top-frame load resets the counters; the log survives navigation', async ({ context, server, serviceWorker }) => {
    const page = await openMocked({ context, server, serviceWorker }, [rule({ id: 'r1', url: '/mocked' })]);
    await fetchText(page, '/mocked');
    await fetchText(page, '/mocked');
    await expect.poll(async () => (await tabData(serviceWorker)).counters).toEqual({ mocked: 2, issues: 0 });
    await page.reload();
    await expect.poll(async () => (await tabData(serviceWorker)).counters).toEqual({ mocked: 0, issues: 0 });
    expect((await tabData(serviceWorker)).log).toHaveLength(2);
  });

  test('RULES_UNAVAILABLE and ENGINE_ERROR count as issues and are logged', async ({ context, server, serviceWorker }) => {
    const page = await openMocked({ context, server, serviceWorker }, [rule({ id: 'r1', name: 'Orders', url: '/mocked' })]);
    await post(page, { type: '__API_MOCK__/RULES_UNAVAILABLE' });
    await post(page, { type: '__API_MOCK__/ENGINE_ERROR', message: 'boom', ruleId: 'r1' });
    await expect.poll(async () => (await tabData(serviceWorker)).log.length).toBe(2);
    const { log, counters } = await tabData(serviceWorker);
    expect(log[0]).toMatchObject({ kind: 'unavailable' });
    expect(log[1]).toMatchObject({ kind: 'error', ruleId: 'r1', ruleName: 'Orders', message: 'boom' });
    expect(counters).toEqual({ mocked: 0, issues: 2 });
  });

  test('CLEAR_LOG empties the log and resets issues but not the mocked count', async ({ context, server, serviceWorker, extensionId }) => {
    const page = await openMocked({ context, server, serviceWorker }, [rule({ id: 'r1', url: '/mocked' })]);
    await fetchText(page, '/mocked');
    await post(page, { type: '__API_MOCK__/RULES_UNAVAILABLE' });
    await expect.poll(async () => (await tabData(serviceWorker)).counters).toEqual({ mocked: 1, issues: 1 });
    const { tabId } = await tabData(serviceWorker);
    const ext = await openExtensionPage(context, extensionId);
    expect(await ext.evaluate((id) => chrome.runtime.sendMessage({ type: 'CLEAR_LOG', tabId: id }), tabId)).toEqual({ ok: true });
    await expect.poll(async () => (await tabData(serviceWorker)).log).toEqual([]);
    expect((await tabData(serviceWorker)).counters).toEqual({ mocked: 1, issues: 0 });
  });

  test('keeps only the last 200 log entries', async ({ context, server, serviceWorker }) => {
    test.setTimeout(45_000);
    const page = await openMocked({ context, server, serviceWorker }, []);
    // 5 batches of 50 events, one rate-limit window apart (the bridge forwards at most 50 per second).
    for (let batch = 0; batch < 5; batch++) {
      await page.evaluate((b) => {
        for (let i = 0; i < 50; i++) {
          window.postMessage({ type: '__API_MOCK__/MOCK_EVENT', ruleId: 'none', url: `/n/${b * 50 + i}`, method: 'GET', status: 200 }, '*');
        }
      }, batch);
      await page.waitForTimeout(1100);
    }
    await expect.poll(async () => (await tabData(serviceWorker)).log.length, { timeout: 5000 }).toBe(200);
    const { log } = await tabData(serviceWorker);
    expect(log[0].url).toBe('/n/50');
    expect(log[199].url).toBe('/n/249');
  });

  test('removes a closed tab\'s data (spec assumption 1: tabs.onRemoved works without the tabs permission)', async ({ context, server, serviceWorker }) => {
    const page = await openMocked({ context, server, serviceWorker }, []);
    await expect.poll(async () => (await tabData(serviceWorker)).counters).not.toBeNull();
    await page.close();
    await expect.poll(async () => Object.keys(await session(serviceWorker)).filter((k) => /^(log|tab):/.test(k))).toEqual([]);
  });

  test('ignores events sent by extension pages', async ({ context, extensionId, serviceWorker }) => {
    const ext = await openExtensionPage(context, extensionId);
    await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'MOCK_EVENT', ruleId: 'r', url: '/x', method: 'GET', status: 200 }).catch(() => {}));
    await ext.waitForTimeout(500);
    expect(Object.keys(await session(serviceWorker)).filter((k) => /^(log|tab):/.test(k))).toEqual([]);
  });

  test('DELETE_RULE drops the rule\'s hit count', async ({ context, server, serviceWorker, extensionId }) => {
    const page = await openMocked({ context, server, serviceWorker }, [rule({ id: 'r1', url: '/mocked' })]);
    await fetchText(page, '/mocked');
    await expect.poll(async () => (await localKey(serviceWorker, 'hits'))?.r1, { timeout: 5000 }).toBe(1);
    const ext = await openExtensionPage(context, extensionId);
    await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'DELETE_RULE', id: 'r1' }));
    await expect.poll(async () => (await localKey(serviceWorker, 'hits')) || {}, { timeout: 5000 }).not.toHaveProperty('r1');
  });
});
