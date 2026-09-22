const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage, openPageWithTab } = require('./helpers');

const badgeText = (sw, tabId) => sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
const fetchSummary = (page, url) => page.evaluate(async (u) => {
  const r = await fetch(u);
  return { status: r.status, text: await r.text() };
}, url);
const isReal = (res) => res.text.includes('"source":"server"');

async function openAll({ context, server, serviceWorker, extensionId }) {
  server.requests.length = 0;
  const { page, tabId } = await openPageWithTab(context, server, serviceWorker);
  const panel = await openExtensionPage(context, extensionId, `panel/panel.html?tabId=${tabId}`);
  const popup = await openExtensionPage(context, extensionId, `popup/popup.html?tabId=${tabId}`);
  return { page, tabId, panel, popup };
}

test.describe('end to end through the UI', () => {
  test('a rule created in the panel mocks the page, and shows up in the log, hits, popup and badge', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, tabId, panel, popup } = await openAll({ context, server, serviceWorker, extensionId });

    // 1. Create the rule in the panel.
    await expect(panel.locator('.empty')).toBeVisible();
    await panel.locator('.empty .btn.pri').click();
    await panel.locator('.editor .name').fill('Users');
    await panel.locator('.editor .url').fill('/api/users*');
    await panel.locator('.editor .status').fill('500');
    await panel.locator('.editor .body').fill('{"error":"boom"}');
    await expect(panel.locator('.row .draft')).toHaveCount(0, { timeout: 5000 }); // saved
    await expect(panel.locator('.row .nm')).toHaveText('Users');

    // 2. The page is answered by the mock (the bridge pushes the new rule).
    await expect.poll(() => fetchSummary(page, '/api/users?page=1')).toEqual({ status: 500, text: '{"error":"boom"}' });
    server.requests.length = 0;
    await fetchSummary(page, '/api/users');
    expect(server.requests.some((r) => r.includes('/api/users'))).toBe(false);

    // 3. The log, the hit count, the popup and the badge all reflect it.
    await expect(panel.locator('.log-list .lr').last()).toContainText('→ Users');
    await expect(panel.locator('.log-list .lr').last().locator('.st')).toHaveText('500');
    await expect(panel.locator('.row .hit')).not.toHaveText('0', { timeout: 6000 }); // hits are flushed about 1 s later
    await expect(popup.locator('.status')).toContainText('mocked on this tab');
    await expect.poll(() => badgeText(serviceWorker, tabId)).toMatch(/^\d+$/);
  });

  test('switches in the popup and the panel stop and resume mocking; deleting the rule empties everything', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, {
      rules: [rule({ id: 'a', name: 'Users', url: '/api/users*', response: { status: 500, body: '{"error":"boom"}' } })],
    });
    const { page, tabId, panel, popup } = await openAll({ context, server, serviceWorker, extensionId });
    await expect.poll(() => fetchSummary(page, '/api/users')).toMatchObject({ status: 500 });

    // The rule switch in the popup.
    await popup.locator('.row').nth(0).locator('.tg').click();
    await expect.poll(async () => isReal(await fetchSummary(page, '/api/users'))).toBe(true);
    await popup.locator('.row').nth(0).locator('.tg').click();
    await expect.poll(async () => (await fetchSummary(page, '/api/users')).status).toBe(500);

    // The global switch in the panel.
    await panel.locator('.bar .tg').click();
    await expect.poll(async () => isReal(await fetchSummary(page, '/api/users'))).toBe(true);
    await expect(popup.locator('.status')).toContainText('Off · requests go straight to the network');
    await expect.poll(() => badgeText(serviceWorker, tabId)).toBe('OFF');
    await panel.locator('.bar .tg').click();
    await expect.poll(async () => (await fetchSummary(page, '/api/users')).status).toBe(500);

    // Delete the rule from the panel.
    await panel.locator('.kebab').click();
    await panel.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await panel.locator('.dialog .btn.danger').click();
    await expect(panel.locator('.empty')).toBeVisible();
    await expect(popup.locator('.status')).toContainText('Active · no rules yet');
    await expect.poll(async () => isReal(await fetchSummary(page, '/api/users'))).toBe(true);
  });
});
