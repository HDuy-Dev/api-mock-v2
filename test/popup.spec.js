const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage, openPageWithTab } = require('./helpers');

const RULES = () => [
  rule({ id: 'a', name: 'Users list', method: 'GET', url: '/api/users*' }),
  rule({ id: 'b', name: 'Login', method: 'POST', url: '/api/login' }),
  rule({ id: 'c', name: 'Orders', method: 'GET', url: 'https://shop.dev/api/orders/*', enabled: false }),
  rule({ id: 'd', name: 'Delete user', method: 'DELETE', url: '/api/users/*' }),
];

async function openPopup(context, extensionId, tabId) {
  return openExtensionPage(context, extensionId, `popup/popup.html?tabId=${tabId}`);
}
const stored = (sw) => sw.evaluate(() => chrome.storage.local.get('state').then((r) => r.state));

test.describe('popup', () => {
  test('active: lists rules with method labels, hits and disabled styling; follows mocked requests live', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    await serviceWorker.evaluate(() => chrome.storage.local.set({ hits: { a: 3 } }));
    const { page, tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);

    await expect(popup.locator('.status')).toHaveClass(/\bok\b/);
    await expect(popup.locator('.status')).toContainText('Active · nothing mocked on this tab yet');
    await expect(popup.locator('.row')).toHaveCount(4);
    await expect(popup.locator('.row').nth(0).locator('.nm')).toHaveText('Users list');
    await expect(popup.locator('.row').nth(0).locator('.hit')).toHaveText('3');
    await expect(popup.locator('.row').nth(3).locator('.mth')).toHaveText('DEL');
    await expect(popup.locator('.row').nth(2)).toHaveClass(/\boff\b/);
    await expect(popup.locator('.foot')).toContainText('Edit rules: DevTools → API Mock tab');
    await expect(popup.locator('.search')).toBeHidden();

    await page.evaluate(() => fetch('/api/users'));
    await expect(popup.locator('.status')).toContainText('Active · 1 mocked on this tab');
  });

  test('off: dimmed list, grey status and an unchecked global switch', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { globalEnabled: false, rules: RULES() });
    const { tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    await expect(popup.locator('.status')).toHaveClass(/\boff\b/);
    await expect(popup.locator('.status')).toContainText('Off · requests go straight to the network');
    await expect(popup.locator('.list')).toHaveClass(/\bdim\b/);
    await expect(popup.locator('.head .tg')).toHaveAttribute('aria-checked', 'false');
  });

  test('issue: an engine error shows a warning with the count', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const { page, tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    await page.evaluate(() => window.postMessage({ type: '__API_MOCK__/ENGINE_ERROR', message: 'boom', ruleId: 'a' }, '*'));
    await expect(popup.locator('.status')).toHaveClass(/\bwarn\b/);
    await expect(popup.locator('.status')).toContainText('1 issue on this tab');
  });

  test('a tab without an engine says it is not active yet', async ({ context, extensionId, serviceWorker }) => {
    await setState(serviceWorker, { rules: RULES() });
    const other = await openExtensionPage(context, extensionId); // extension pages have no content scripts
    const otherId = await other.evaluate(() => chrome.tabs.getCurrent().then((t) => t.id));
    const popup = await openPopup(context, extensionId, otherId);
    await expect(popup.locator('.status')).toHaveClass(/\bwarn\b/);
    await expect(popup.locator('.status')).toContainText('Not active on this tab yet');
  });

  test('empty: no rules shows the DevTools hint and the Network-tab reminder', async ({ context, server, serviceWorker, extensionId }) => {
    const { tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    await expect(popup.locator('.status')).toContainText('Active · no rules yet');
    await expect(popup.locator('.none')).toContainText('No rules yet.');
    await expect(popup.locator('.none')).toContainText('+ Add rule');
    await expect(popup.locator('.foot')).toHaveText("Mocked requests won't appear in the Network tab.");
  });

  test('the search box appears only with more than 5 rules and filters by name or URL', async ({ context, server, serviceWorker, extensionId }) => {
    const five = RULES().concat(rule({ id: 'e', name: 'Extra', url: '/extra' })); // 5 rules
    await setState(serviceWorker, { rules: five });
    const { tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    await expect(popup.locator('.row')).toHaveCount(5);
    await expect(popup.locator('.search')).toBeHidden();

    await setState(serviceWorker, { rules: five.concat(rule({ id: 'f', name: 'Sixth', url: '/sixth' })) });
    await expect(popup.locator('.search')).toBeVisible();
    await popup.locator('.search input').fill('login');
    await expect(popup.locator('.row')).toHaveCount(1);
    await expect(popup.locator('.row .nm')).toHaveText('Login');
    await popup.locator('.search input').fill('shop.dev');
    await expect(popup.locator('.row .nm')).toHaveText('Orders');
    await popup.locator('.search input').fill('zzz');
    await expect(popup.locator('.none')).toHaveText('No rules match "zzz".');
    await popup.locator('.search input').fill('');
    await expect(popup.locator('.row')).toHaveCount(6);
  });

  test('a rule switch enables or disables that rule', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const { tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    const first = popup.locator('.row').nth(0);
    await first.locator('.tg').click();
    await expect(first).toHaveClass(/\boff\b/);
    await expect(first.locator('.tg')).toHaveAttribute('aria-checked', 'false');
    expect((await stored(serviceWorker)).rules.find((r) => r.id === 'a').enabled).toBe(false);
  });

  test('the global switch turns mocking off and on', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const { tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    await popup.locator('.head .tg').click();
    await expect(popup.locator('.status')).toContainText('Off · requests go straight to the network');
    expect((await stored(serviceWorker)).globalEnabled).toBe(false);
    await popup.locator('.head .tg').click();
    await expect(popup.locator('.status')).toContainText('Active');
    expect((await stored(serviceWorker)).globalEnabled).toBe(true);
  });

  test('rule names are text, never HTML', async ({ context, server, serviceWorker, extensionId }) => {
    const evil = '<img src=x onerror="window.__xss=1">';
    await setState(serviceWorker, { rules: [rule({ id: 'x', name: evil, url: '/x' })] });
    const { tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    await expect(popup.locator('.row .nm')).toHaveText(evil);
    expect(await popup.evaluate(() => window.__xss)).toBeUndefined();
    expect(await popup.locator('.row img').count()).toBe(0);
  });
});
