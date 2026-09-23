const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage, openPageWithTab } = require('./helpers');

const post = (page, message) => page.evaluate((m) => window.postMessage(m, '*'), message);

async function openLog(context, server, serviceWorker, extensionId, rules = []) {
  await setState(serviceWorker, { rules });
  const { page, tabId } = await openPageWithTab(context, server, serviceWorker);
  const panel = await openExtensionPage(context, extensionId, `panel/panel.html?tabId=${tabId}`);
  await panel.locator('.log').waitFor();
  return { page, panel, tabId };
}

test.describe('panel: log', () => {
  test('starts empty', async ({ context, server, serviceWorker, extensionId }) => {
    const { panel } = await openLog(context, server, serviceWorker, extensionId);
    await expect(panel.locator('.log-h')).toContainText('this tab · 0');
    await expect(panel.locator('.lr.none')).toHaveText('No mocked requests on this tab yet.');
    await expect(panel.locator('.btn.clear')).toBeDisabled();
  });

  test('shows mocked requests as they happen (spec assumption 4: storage.session onChanged reaches the panel)', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, panel } = await openLog(context, server, serviceWorker, extensionId, [
      rule({ id: 'r1', name: 'Users list', url: '/mocked', response: { status: 500, delay: 5 } }),
    ]);
    await page.evaluate(() => fetch('/mocked?page=2'));
    await expect(panel.locator('.log-list .lr')).toHaveCount(1);
    const row = panel.locator('.log-list .lr').nth(0);
    await expect(row.locator('.t')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
    await expect(row.locator('.mth')).toHaveText('GET');
    await expect(row.locator('.u')).toHaveText('/mocked?page=2');
    await expect(row).toHaveAttribute('title', server.origin + '/mocked?page=2');
    await expect(row).toContainText('→ Users list');
    await expect(row.locator('.st')).toHaveText('500');
    await expect(row.locator('.st')).toHaveClass(/\bbad\b/);
    await expect(row).toContainText('5 ms');
    await expect(panel.locator('.log-h')).toContainText('this tab · 1');
  });

  test('status pills follow the status class', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, panel } = await openLog(context, server, serviceWorker, extensionId, [
      rule({ id: 'a', url: '/s200', response: { status: 200 } }),
      rule({ id: 'b', url: '/s302', response: { status: 302 } }),
      rule({ id: 'c', url: '/s404', response: { status: 404 } }),
    ]);
    for (const p of ['/s200', '/s302', '/s404']) await page.evaluate((u) => fetch(u), p);
    await expect(panel.locator('.log-list .st')).toHaveCount(3);
    await expect(panel.locator('.log-list .st')).toHaveClass([/\bgood\b/, /\binfo\b/, /\bwarn\b/]);
  });

  test('issues are listed with an explanation; the filter chips count and filter', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, panel } = await openLog(context, server, serviceWorker, extensionId, [
      rule({ id: 'r1', name: 'Orders', url: '/mocked' }),
    ]);
    await page.evaluate(() => fetch('/mocked'));
    await post(page, { type: '__API_MOCK__/RULES_UNAVAILABLE' });
    await post(page, { type: '__API_MOCK__/ENGINE_ERROR', message: 'boom', ruleId: 'r1' });
    await post(page, { type: '__API_MOCK__/ENGINE_ERROR', message: 'other' });
    await expect(panel.locator('.log-list .lr')).toHaveCount(4);

    await expect(panel.locator('.lr.warn')).toContainText("rules-unavailable");
    await expect(panel.locator('.lr.warn')).toContainText("Rules didn't load in time — request passed through to the network");
    await expect(panel.locator('.lr.fail').nth(0)).toContainText('engine-error');
    await expect(panel.locator('.lr.fail').nth(0)).toContainText('Rule "Orders": couldn\'t build the response — request passed through');
    await expect(panel.locator('.lr.fail').nth(0)).toHaveAttribute('title', 'boom');
    await expect(panel.locator('.lr.fail').nth(1)).toContainText('Engine error — request passed through');

    await expect(panel.locator('.chip')).toHaveText(['All', 'Mocked 1', 'Issues 3']);
    await expect(panel.locator('.chip').nth(0)).toHaveAttribute('aria-pressed', 'true');
    await panel.locator('.chip', { hasText: 'Issues' }).click();
    await expect(panel.locator('.log-list .lr')).toHaveCount(3);
    await expect(panel.locator('.chip', { hasText: 'Issues' })).toHaveAttribute('aria-pressed', 'true');
    await panel.locator('.chip', { hasText: 'Mocked' }).click();
    await expect(panel.locator('.log-list .lr')).toHaveCount(1);
    await panel.locator('.chip', { hasText: 'All' }).click();
    await expect(panel.locator('.log-list .lr')).toHaveCount(4);
  });

  test('a new mocked request arriving does not steal focus from a focused filter chip', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, panel } = await openLog(context, server, serviceWorker, extensionId, [
      rule({ id: 'r1', name: 'Users list', url: '/mocked' }),
    ]);
    const issuesChip = panel.locator('.chip', { hasText: 'Issues' });
    await issuesChip.focus();
    await expect(issuesChip).toBeFocused();
    await page.evaluate(() => fetch('/mocked')); // triggers a log re-render ~independently of the panel
    await expect(panel.locator('.log-list .lr')).toHaveCount(1);
    await expect(issuesChip).toBeFocused();
  });

  test('an empty filter says so', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, panel } = await openLog(context, server, serviceWorker, extensionId, [rule({ url: '/mocked' })]);
    await page.evaluate(() => fetch('/mocked'));
    await expect(panel.locator('.log-list .lr')).toHaveCount(1);
    await panel.locator('.chip', { hasText: 'Issues' }).click();
    await expect(panel.locator('.lr.none')).toHaveText('Nothing to show for this filter.');
  });

  test('Clear empties the log', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, panel, tabId } = await openLog(context, server, serviceWorker, extensionId, [rule({ url: '/mocked' })]);
    await page.evaluate(() => fetch('/mocked'));
    await expect(panel.locator('.log-list .lr')).toHaveCount(1);
    await panel.locator('.btn.clear').click();
    await expect(panel.locator('.lr.none')).toHaveText('No mocked requests on this tab yet.');
    await expect.poll(() => serviceWorker.evaluate((id) => chrome.storage.session.get(`log:${id}`).then((r) => r[`log:${id}`]), tabId)).toEqual([]);
  });

  test('new entries scroll into view unless the user scrolled up', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, panel } = await openLog(context, server, serviceWorker, extensionId);
    const forge = (n, from) =>
      page.evaluate(([count, start]) => {
        for (let i = 0; i < count; i++) {
          window.postMessage({ type: '__API_MOCK__/MOCK_EVENT', ruleId: 'none', url: `/n/${start + i}`, method: 'GET', status: 200 }, '*');
        }
      }, [n, from]);
    const geometry = () => panel.locator('.log-list').evaluate((el) => ({ top: el.scrollTop, gap: el.scrollHeight - el.clientHeight - el.scrollTop, scrolls: el.scrollHeight > el.clientHeight }));

    await forge(30, 0);
    await expect(panel.locator('.log-list .lr')).toHaveCount(30);
    await expect.poll(async () => (await geometry()).gap).toBeLessThan(6); // stuck to the bottom
    expect((await geometry()).scrolls).toBe(true);

    await panel.locator('.log-list').evaluate((el) => { el.scrollTop = 0; });
    await forge(3, 30);
    await expect(panel.locator('.log-list .lr')).toHaveCount(33);
    expect((await geometry()).top).toBe(0); // the view did not jump
  });

  test('without a tab the panel explains itself and Clear is disabled', async ({ context, extensionId }) => {
    const panel = await openExtensionPage(context, extensionId, 'panel/panel.html');
    await expect(panel.locator('.lr.none')).toHaveText('Open this panel from DevTools to see the log of the inspected tab.');
    await expect(panel.locator('.btn.clear')).toBeDisabled();
  });

  test('log content is text, and an unknown method is never used as a class', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, panel } = await openLog(context, server, serviceWorker, extensionId);
    await post(page, { type: '__API_MOCK__/MOCK_EVENT', ruleId: 'x', url: '/<img src=x onerror="window.__xss=1">', method: 'NOT A METHOD', status: 200 });
    await expect(panel.locator('.log-list .lr')).toHaveCount(1);
    expect(await panel.evaluate(() => window.__xss)).toBeUndefined();
    expect(await panel.locator('.log-list img').count()).toBe(0);
    await expect(panel.locator('.log-list .mth')).toHaveClass(/\bANY\b/);
  });
});
