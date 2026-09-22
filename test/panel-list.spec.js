const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage } = require('./helpers');

const RULES = () => [
  rule({ id: 'a', name: 'Users list', method: 'GET', url: '/api/users*' }),
  rule({ id: 'b', name: 'Login', method: 'POST', url: '/api/login' }),
  rule({ id: 'c', name: 'Orders', method: 'GET', url: 'https://shop.dev/api/orders/*', enabled: false }),
  rule({ id: 'd', name: 'Delete user', method: 'DELETE', url: '/api/users/*' }),
];
const openPanel = (context, extensionId) => openExtensionPage(context, extensionId, 'panel/panel.html');
const stored = (sw) => sw.evaluate(() => chrome.storage.local.get('state').then((r) => r.state));

test.describe('panel: rules list', () => {
  test('renders rules with method labels, URLs and hits; selects the first; dims disabled rules', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    await serviceWorker.evaluate(() => chrome.storage.local.set({ hits: { a: 3 } }));
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('.list .row')).toHaveCount(4);
    const first = panel.locator('.row').nth(0);
    await expect(first.locator('.nm')).toHaveText('Users list');
    await expect(first.locator('.ur')).toHaveText('/api/users*');
    await expect(first.locator('.hit')).toHaveText('3');
    await expect(first).toHaveClass(/\bsel\b/);
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('.row').nth(3).locator('.mth')).toHaveText('DEL');
    await expect(panel.locator('.row').nth(2)).toHaveClass(/\boff\b/);
    await expect(panel.locator('.empty')).toBeHidden();
  });

  test('empty state: explains that mocked requests do not show in the Network tab', async ({ context, extensionId }) => {
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('.empty')).toBeVisible();
    await expect(panel.locator('.empty h4')).toHaveText('No rules yet');
    await expect(panel.locator('.empty .hint')).toContainText("won't appear in the Network tab");
    await expect(panel.locator('.empty .btn.pri')).toHaveText('+ Add your first rule');
    await expect(panel.locator('.list')).toBeHidden();
    await expect(panel.locator('.bar .ttl')).toHaveText('API Mock');
  });

  test('clicking or using the arrow keys selects a rule', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const panel = await openPanel(context, extensionId);
    await panel.locator('.row').nth(1).click();
    await expect(panel.locator('.row').nth(1)).toHaveClass(/\bsel\b/);
    await expect(panel.locator('.row.sel')).toHaveCount(1);

    await panel.locator('.row').nth(1).focus();
    await panel.keyboard.press('ArrowDown');
    await expect(panel.locator('.row').nth(2)).toHaveClass(/\bsel\b/);
    await panel.keyboard.press('ArrowUp');
    await panel.keyboard.press('ArrowUp');
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/);
  });

  test('a rule switch toggles that rule without changing the selection', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const panel = await openPanel(context, extensionId);
    await panel.locator('.row').nth(1).locator('.tg').click();
    await expect(panel.locator('.row').nth(1)).toHaveClass(/\boff\b/);
    expect((await stored(serviceWorker)).rules.find((r) => r.id === 'b').enabled).toBe(false);
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/); // still the first rule
  });

  test('Enter or Space on the row itself selects it (focus not on a nested control)', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const panel = await openPanel(context, extensionId);

    await panel.locator('.row').nth(1).focus();
    await panel.keyboard.press('Enter');
    await expect(panel.locator('.row').nth(1)).toHaveClass(/\bsel\b/);

    await panel.locator('.row').nth(2).focus();
    await panel.keyboard.press(' ');
    await expect(panel.locator('.row').nth(2)).toHaveClass(/\bsel\b/);
  });

  test('Space or Enter on a rule switch toggles it, even though the keydown bubbles through the row', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const panel = await openPanel(context, extensionId);
    const row = panel.locator('.row').nth(1); // 'Login', enabled: true, not selected (first row is)
    const sw = row.locator('.tg');
    await expect(sw).toHaveAttribute('aria-checked', 'true');

    await sw.focus();
    await panel.keyboard.press(' ');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(row).toHaveClass(/\boff\b/);
    expect((await stored(serviceWorker)).rules.find((r) => r.id === 'b').enabled).toBe(false);
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/); // selection unchanged: still the first row
    await expect(row).not.toHaveClass(/\bsel\b/);

    await sw.focus();
    await panel.keyboard.press('Enter');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    expect((await stored(serviceWorker)).rules.find((r) => r.id === 'b').enabled).toBe(true);
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/); // still unchanged
  });

  test('the global switch turns mocking off and on', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const panel = await openPanel(context, extensionId);
    const sw = panel.locator('.bar .tg');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect((await stored(serviceWorker)).globalEnabled).toBe(false);
  });

  test('search filters by name or URL', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const panel = await openPanel(context, extensionId);
    await panel.locator('.bar .search').fill('shop.dev');
    await expect(panel.locator('.row')).toHaveCount(1);
    await expect(panel.locator('.row .nm')).toHaveText('Orders');
    await panel.locator('.bar .search').fill('zzz');
    await expect(panel.locator('.no-match')).toHaveText('No rules match "zzz".');
    await panel.locator('.bar .search').fill('');
    await expect(panel.locator('.row')).toHaveCount(4);
  });

  test('+ Add rule creates a draft on top that is selected but not stored', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const panel = await openPanel(context, extensionId);
    await panel.locator('.bar .add').click();
    const draft = panel.locator('.row').nth(0);
    await expect(draft).toHaveClass(/\bsel\b/);
    await expect(draft.locator('.nm')).toHaveText('New rule');
    await expect(draft.locator('.ur')).toHaveText('(no URL yet)');
    await expect(draft.locator('.draft')).toHaveText('Not applied');
    await expect(draft.locator('.tg')).toHaveCount(0);
    await expect(panel.locator('.row')).toHaveCount(5);
    expect((await stored(serviceWorker)).rules).toHaveLength(4);
  });

  test('+ Add your first rule leaves the empty state with a draft', async ({ context, extensionId }) => {
    const panel = await openPanel(context, extensionId);
    await panel.locator('.empty .btn.pri').click();
    await expect(panel.locator('.empty')).toBeHidden();
    await expect(panel.locator('.row')).toHaveCount(1);
    await expect(panel.locator('.row .draft')).toHaveText('Not applied');
  });

  test('follows storage changes made elsewhere', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('.row')).toHaveCount(4);
    await setState(serviceWorker, { rules: RULES().slice(0, 2) });
    await expect(panel.locator('.row')).toHaveCount(2);
  });

  test('rule names are text, never HTML', async ({ context, serviceWorker, extensionId }) => {
    const evil = '<img src=x onerror="window.__xss=1">';
    await setState(serviceWorker, { rules: [rule({ id: 'x', name: evil, url: '/x' })] });
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('.row .nm')).toHaveText(evil);
    expect(await panel.evaluate(() => window.__xss)).toBeUndefined();
    expect(await panel.locator('.row img').count()).toBe(0);
  });
});
