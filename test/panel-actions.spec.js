const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage } = require('./helpers');

const RULES = () => [
  rule({ id: 'a', name: 'Users list', method: 'GET', url: '/api/users*' }),
  rule({ id: 'b', name: 'Login', method: 'POST', url: '/api/login' }),
  rule({ id: 'c', name: 'Orders', method: 'GET', url: '/api/orders' }),
];
async function openPanel(context, extensionId, serviceWorker, rules = RULES()) {
  await setState(serviceWorker, { rules });
  const panel = await openExtensionPage(context, extensionId, 'panel/panel.html');
  await panel.locator('.editor').waitFor();
  return panel;
}
const stored = (sw) => sw.evaluate(() => chrome.storage.local.get('state').then((r) => r.state));
const menuItem = (panel, name) => panel.getByRole('menuitem', { name, exact: true });

test.describe('panel: ⋮ menu', () => {
  test('opens with the four actions and closes on Escape (focus returns) or an outside click', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.kebab').click();
    await expect(panel.locator('.menu [role="menuitem"]')).toHaveText(['Duplicate', 'Move up', 'Move down', 'Delete']);
    await expect(panel.locator('.kebab')).toHaveAttribute('aria-expanded', 'true');
    await panel.keyboard.press('Escape');
    await expect(panel.locator('.menu')).toHaveCount(0);
    await expect(panel.locator('.kebab')).toBeFocused();

    await panel.locator('.kebab').click();
    await panel.locator('.bar .ttl').click();
    await expect(panel.locator('.menu')).toHaveCount(0);
  });

  test('arrow keys move between enabled items', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.kebab').click(); // first rule: "Move up" is disabled
    await expect(menuItem(panel, 'Duplicate')).toBeFocused();
    await panel.keyboard.press('ArrowDown');
    await expect(menuItem(panel, 'Move down')).toBeFocused(); // skipped the disabled "Move up"
    await panel.keyboard.press('ArrowUp');
    await expect(menuItem(panel, 'Duplicate')).toBeFocused();
  });

  test('Move up is disabled for the first rule and Move down for the last', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.kebab').click();
    await expect(menuItem(panel, 'Move up')).toBeDisabled();
    await expect(menuItem(panel, 'Move down')).toBeEnabled();
    await panel.keyboard.press('Escape');
    await panel.locator('.row').nth(2).click();
    await panel.locator('.kebab').click();
    await expect(menuItem(panel, 'Move up')).toBeEnabled();
    await expect(menuItem(panel, 'Move down')).toBeDisabled();
  });

  test('Duplicate stores a copy on top and selects it', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.kebab').click();
    await menuItem(panel, 'Duplicate').click();
    await expect.poll(async () => (await stored(serviceWorker)).rules.map((r) => r.name)).toEqual(['Users list copy', 'Users list', 'Login', 'Orders']);
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/);
    await expect(panel.locator('.editor .name')).toHaveValue('Users list copy');
    const [copy, original] = (await stored(serviceWorker)).rules;
    expect(copy.id).not.toBe(original.id);
    expect(copy.url).toBe(original.url);
  });

  test('Move down and Move up reorder the rules and the selection follows the rule', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.kebab').click();
    await menuItem(panel, 'Move down').click();
    await expect.poll(async () => (await stored(serviceWorker)).rules.map((r) => r.id)).toEqual(['b', 'a', 'c']);
    await expect(panel.locator('.row .nm')).toHaveText(['Login', 'Users list', 'Orders']);
    await expect(panel.locator('.row').nth(1)).toHaveClass(/\bsel\b/);
    await expect(panel.locator('.editor .name')).toHaveValue('Users list');

    await panel.locator('.kebab').click();
    await menuItem(panel, 'Move up').click();
    await expect.poll(async () => (await stored(serviceWorker)).rules.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/);
  });

  test('Delete asks for confirmation; Cancel and Escape keep the rule and return focus to the kebab button', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.kebab').click();
    await menuItem(panel, 'Delete').click();
    await expect(panel.locator('.dialog p')).toHaveText('Delete rule "Users list"?');
    await panel.locator('.dialog .btn', { hasText: 'Cancel' }).click();
    await expect(panel.locator('.dialog')).toHaveCount(0);
    await expect(panel.locator('.kebab')).toBeFocused();

    await panel.locator('.kebab').click();
    await menuItem(panel, 'Delete').click();
    await panel.keyboard.press('Escape');
    await expect(panel.locator('.dialog')).toHaveCount(0);
    await expect(panel.locator('.kebab')).toBeFocused();
    expect((await stored(serviceWorker)).rules).toHaveLength(3);
  });

  test('confirming Delete removes the rule and selects the first remaining one', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.kebab').click();
    await menuItem(panel, 'Delete').click();
    await panel.locator('.dialog .btn.danger').click();
    await expect.poll(async () => (await stored(serviceWorker)).rules.map((r) => r.id)).toEqual(['b', 'c']);
    await expect(panel.locator('.dialog')).toHaveCount(0);
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/);
    await expect(panel.locator('.editor .name')).toHaveValue('Login');
  });

  test('deleting the last rule shows the empty state', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker, [RULES()[0]]);
    await panel.locator('.kebab').click();
    await menuItem(panel, 'Delete').click();
    await panel.locator('.dialog .btn.danger').click();
    await expect(panel.locator('.empty')).toBeVisible();
    await expect(panel.locator('.editor')).toHaveCount(0);
  });

  test('a draft can only be discarded, at once and without confirmation', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.bar .add').click();
    await expect(panel.locator('.row')).toHaveCount(4);
    await panel.locator('.kebab').click();
    await expect(menuItem(panel, 'Duplicate')).toBeDisabled();
    await expect(menuItem(panel, 'Move up')).toBeDisabled();
    await expect(menuItem(panel, 'Move down')).toBeDisabled();
    await menuItem(panel, 'Discard draft').click();
    await expect(panel.locator('.dialog')).toHaveCount(0);
    await expect(panel.locator('.row')).toHaveCount(3);
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/);
    expect((await stored(serviceWorker)).rules).toHaveLength(3);
  });
});
