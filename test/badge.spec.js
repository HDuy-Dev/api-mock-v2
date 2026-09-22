const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage } = require('./helpers');

const post = (page, message) => page.evaluate((m) => window.postMessage(m, '*'), message);
const fetchText = (page, url) => page.evaluate((u) => fetch(u).then((r) => r.text()), url);

test.describe('shared/status.js', () => {
  let ext;
  test.beforeEach(async ({ context, extensionId }) => {
    ext = await openExtensionPage(context, extensionId);
  });
  const run = (name, ...args) => ext.evaluate(async ([n, a]) => (await import('/shared/status.js'))[n](...a), [name, args]);

  test('computeBadge: priority OFF > ! > count > none', async () => {
    expect(await run('computeBadge', { globalEnabled: false, mocked: 5, issues: 2 })).toEqual({
      text: 'OFF', bg: '#4b5563', color: '#ffffff', title: 'API Mock — Off',
    });
    expect(await run('computeBadge', { globalEnabled: true, mocked: 5, issues: 1 })).toEqual({
      text: '!', bg: '#ef4444', color: '#ffffff', title: 'API Mock — 1 issue on this tab',
    });
    expect((await run('computeBadge', { globalEnabled: true, mocked: 0, issues: 2 })).title).toBe('API Mock — 2 issues on this tab');
    expect(await run('computeBadge', { globalEnabled: true, mocked: 3, issues: 0 })).toEqual({
      text: '3', bg: '#10b981', color: '#06281c', title: 'API Mock — Active · 3 mocked on this tab',
    });
    expect((await run('computeBadge', { globalEnabled: true, mocked: 150, issues: 0 })).text).toBe('99+');
    expect(await run('computeBadge', { globalEnabled: true })).toEqual({
      text: '', bg: '#10b981', color: '#06281c', title: 'API Mock — Active',
    });
  });

  test('drawIcon paints the amber (on) or grey (off) background', async () => {
    const pixel = (active) =>
      ext.evaluate(async (a) => {
        const { drawIcon } = await import('/shared/status.js');
        const img = drawIcon(16, a);
        const i = (8 * 16 + 2) * 4; // x = 2, y = 8: inside the rounded square, away from the glyph
        return Array.from(img.data.slice(i, i + 4));
      }, active);
    expect(await pixel(true)).toEqual([245, 158, 11, 255]);
    expect(await pixel(false)).toEqual([75, 85, 99, 255]);
  });
});

test.describe('service worker: badge and tooltip (spec assumption 8)', () => {
  const tabIdOf = async (sw) => {
    const s = await sw.evaluate(() => chrome.storage.session.get(null));
    const k = Object.keys(s).find((key) => key.startsWith('tab:'));
    return k ? Number(k.slice(4)) : null;
  };
  const badge = (sw, tabId) =>
    sw.evaluate(async (id) => ({
      text: await chrome.action.getBadgeText({ tabId: id }),
      bg: await chrome.action.getBadgeBackgroundColor({ tabId: id }),
      color: await chrome.action.getBadgeTextColor({ tabId: id }),
      title: await chrome.action.getTitle({ tabId: id }),
    }), tabId);

  test('follows mocked requests, issues, the global switch, clearing and reloading', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: [rule({ id: 'r1', url: '/mocked' })] });
    const ext = await openExtensionPage(context, extensionId);
    const send = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    await expect.poll(() => tabIdOf(serviceWorker)).not.toBeNull();
    const tabId = await tabIdOf(serviceWorker);

    await expect.poll(async () => (await badge(serviceWorker, tabId)).title).toBe('API Mock — Active');
    expect((await badge(serviceWorker, tabId)).text).toBe('');

    await fetchText(page, '/mocked');
    await expect.poll(async () => (await badge(serviceWorker, tabId)).text).toBe('1');
    expect(await badge(serviceWorker, tabId)).toEqual({
      text: '1', bg: [16, 185, 129, 255], color: [6, 40, 28, 255], title: 'API Mock — Active · 1 mocked on this tab',
    });

    await post(page, { type: '__API_MOCK__/ENGINE_ERROR', message: 'boom', ruleId: 'r1' });
    await expect.poll(async () => (await badge(serviceWorker, tabId)).text).toBe('!');
    expect((await badge(serviceWorker, tabId)).bg).toEqual([239, 68, 68, 255]);

    await send({ type: 'SET_GLOBAL', enabled: false });
    await expect.poll(async () => (await badge(serviceWorker, tabId)).text).toBe('OFF');
    expect(await badge(serviceWorker, tabId)).toMatchObject({ bg: [75, 85, 99, 255], title: 'API Mock — Off' });
    // The global badge (used by tabs without an engine) follows too.
    expect(await serviceWorker.evaluate(() => chrome.action.getBadgeText({}))).toBe('OFF');

    await send({ type: 'SET_GLOBAL', enabled: true });
    await expect.poll(async () => (await badge(serviceWorker, tabId)).text).toBe('!');
    expect(await serviceWorker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');

    await send({ type: 'CLEAR_LOG', tabId });
    await expect.poll(async () => (await badge(serviceWorker, tabId)).text).toBe('1');

    await page.reload();
    await expect.poll(async () => (await badge(serviceWorker, tabId)).text).toBe('');
  });
});
