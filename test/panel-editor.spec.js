const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage } = require('./helpers');

const seed = () =>
  rule({
    id: 'a', name: 'Users list', method: 'GET', url: '/api/users*',
    response: {
      status: 500, delay: 800, body: '{\n  "error": "Internal Server Error"\n}',
      headers: [{ name: 'Content-Type', value: 'application/json' }, { name: 'X-Mock', value: '1' }],
    },
  });
const other = () => rule({ id: 'b', name: 'Login', method: 'POST', url: '/api/login' });

async function openEditor(context, extensionId, serviceWorker, rules = [seed(), other()]) {
  await setState(serviceWorker, { rules });
  const panel = await openExtensionPage(context, extensionId, 'panel/panel.html');
  await panel.locator('.editor').waitFor();
  return panel;
}
const stored = (sw) => sw.evaluate(() => chrome.storage.local.get('state').then((r) => r.state));
const savedRule = async (sw, id) => (await stored(sw)).rules.find((r) => r.id === id);

test.describe('shared/rule.js JSON helpers', () => {
  test('deepExpand and formatJson', async ({ context, extensionId }) => {
    const ext = await openExtensionPage(context, extensionId);
    const out = await ext.evaluate(async () => {
      const { formatJson } = await import('/shared/rule.js');
      return {
        nested: formatJson('{"a":"{\\"b\\":[1,\\"{\\\\\\"c\\\\\\":2}\\"]}","d":"plain"}'),
        invalid: formatJson('{oops'),
        scalar: formatJson('123'),
      };
    });
    expect(out.nested.ok).toBe(true);
    expect(JSON.parse(out.nested.text)).toEqual({ a: { b: [1, { c: 2 }] }, d: 'plain' });
    expect(out.nested.text).toContain('\n  "a": {');
    expect(out.invalid).toEqual({ ok: false, text: '{oops' });
    expect(out.scalar).toEqual({ ok: true, text: '123' });
  });
});

test.describe('panel: editor', () => {
  test('shows the selected rule in its fields', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await expect(panel.locator('.editor .name')).toHaveValue('Users list');
    await expect(panel.locator('.editor .method')).toHaveValue('GET');
    await expect(panel.locator('.editor .url')).toHaveValue('/api/users*');
    await expect(panel.locator('.editor .status')).toHaveValue('500');
    await expect(panel.locator('.editor .delay')).toHaveValue('800');
    await expect(panel.locator('.editor .headers')).toHaveValue('Content-Type: application/json\nX-Mock: 1');
    await expect(panel.locator('.editor .body')).toHaveValue('{\n  "error": "Internal Server Error"\n}');
    await expect(panel.locator('.editor .note')).toHaveText('✓ Valid JSON');
    await expect(panel.locator('.editor .saved')).toHaveText('');
  });

  test('auto-saves a valid edit after the debounce and shows Saved', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .body').fill('{"ok":true}');
    await expect.poll(async () => (await savedRule(serviceWorker, 'a')).response.body).toBe('{"ok":true}');
    await expect(panel.locator('.editor .saved')).toHaveText('✓ Saved');
    await expect(panel.locator('.editor .saved')).toHaveText('', { timeout: 5000 }); // hides after about 2 s
  });

  test('a burst of typing produces a single save', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.evaluate(() => {
      window.__saves = 0;
      chrome.storage.onChanged.addListener((c, area) => {
        if (area === 'local' && c.state) window.__saves += 1;
      });
    });
    await panel.locator('.editor .body').pressSequentially('abc', { delay: 100 });
    await expect.poll(async () => (await savedRule(serviceWorker, 'a')).response.body).toContain('abc');
    await panel.waitForTimeout(1200);
    expect(await panel.evaluate(() => window.__saves)).toBe(1);
  });

  test('invalid values are flagged in place, never saved, and marked Unsaved edits', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .url').fill('');
    await panel.locator('.editor .status').fill('700');
    await panel.locator('.editor .delay').fill('70000');
    await panel.locator('.editor .headers').fill('not a header');

    await expect(panel.locator('.fmsg[data-for="url"]')).toHaveText('URL is required');
    await expect(panel.locator('.fmsg[data-for="status"]')).toHaveText('Must be 200–599');
    await expect(panel.locator('.fmsg[data-for="delay"]')).toHaveText('Must be 0–60000');
    await expect(panel.locator('.fmsg[data-for="headers"]')).toHaveText('Line 1: invalid header name');
    await expect(panel.locator('.editor .url')).toHaveClass(/\berr\b/);
    await expect(panel.locator('.editor .saved')).toHaveText('● Not saved — fix 4 errors');
    await expect(panel.locator('.row').nth(0).locator('.draft')).toHaveText('Unsaved edits');

    await panel.waitForTimeout(1000); // longer than the debounce
    expect((await savedRule(serviceWorker, 'a')).url).toBe('/api/users*'); // the stored rule is untouched
  });

  test('fixing the errors saves and clears the marks', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .status').fill('700');
    await expect(panel.locator('.editor .saved')).toHaveText('● Not saved — fix 1 error');
    await panel.locator('.editor .status').fill('404');
    await expect.poll(async () => (await savedRule(serviceWorker, 'a')).response.status).toBe(404);
    await expect(panel.locator('.fmsg[data-for="status"]')).toHaveText('');
    await expect(panel.locator('.editor .status')).not.toHaveClass(/\berr\b/);
    await expect(panel.locator('.row').nth(0).locator('.draft')).toHaveCount(0);
  });

  test('a new rule stays a draft until it is valid, then it is stored on top', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.bar .add').click();
    await expect(panel.locator('.editor .url')).toHaveValue('');
    await expect(panel.locator('.fmsg[data-for="url"]')).toHaveText(''); // no errors before the first edit
    await panel.locator('.editor .name').fill('Fresh');
    await expect(panel.locator('.fmsg[data-for="url"]')).toHaveText('URL is required');
    await expect(panel.locator('.row').nth(0).locator('.draft')).toHaveText('Not applied');
    expect((await stored(serviceWorker)).rules).toHaveLength(2);

    await panel.locator('.editor .url').fill('/fresh');
    await expect.poll(async () => (await stored(serviceWorker)).rules.length).toBe(3);
    const rules = (await stored(serviceWorker)).rules;
    expect(rules[0]).toMatchObject({ name: 'Fresh', url: '/fresh', method: 'GET' });
    await expect(panel.locator('.row').nth(0).locator('.draft')).toHaveCount(0);
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/);
    await expect(panel.locator('.editor .name')).toHaveValue('Fresh');
  });

  test('method, name and headers are saved in their stored form', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .method').selectOption('POST');
    await panel.locator('.editor .name').fill('Renamed');
    await panel.locator('.editor .headers').fill('A: 1\nB: two');
    await expect.poll(async () => (await savedRule(serviceWorker, 'a')).method).toBe('POST');
    const r = await savedRule(serviceWorker, 'a');
    expect(r.name).toBe('Renamed');
    expect(r.response.headers).toEqual([{ name: 'A', value: '1' }, { name: 'B', value: 'two' }]);
    await expect(panel.locator('.row').nth(0).locator('.nm')).toHaveText('Renamed');
  });

  test('an empty name falls back to the name derived from the URL', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .name').fill('');
    await expect.poll(async () => (await savedRule(serviceWorker, 'a')).name).toBe('users');
  });

  test('the body note follows the content', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .body').fill('Created!');
    await expect(panel.locator('.editor .note')).toHaveText('Not JSON'); // the rule has a Content-Type header
    await panel.locator('.editor .headers').fill('X-Mock: 1');
    await expect(panel.locator('.editor .note')).toHaveText('Not JSON — sent as text/plain');
    await panel.locator('.editor .body').fill('');
    await expect(panel.locator('.editor .note')).toHaveText('');
    await panel.locator('.editor .body').fill('[1]');
    await expect(panel.locator('.editor .note')).toHaveText('✓ Valid JSON');
  });

  test('Format JSON pretty-prints and expands nested JSON strings; invalid JSON is left alone', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .body').fill('{"a":"{\\"b\\":1}"}');
    await panel.locator('.editor .format').click();
    await expect(panel.locator('.editor .body')).toHaveValue('{\n  "a": {\n    "b": 1\n  }\n}');
    await panel.locator('.editor .body').fill('{oops');
    await panel.locator('.editor .format').click();
    await expect(panel.locator('.editor .body')).toHaveValue('{oops');
  });

  test('switching rules flushes a pending save', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .body').fill('quick');
    await panel.locator('.row').nth(1).click(); // well before the 700 ms debounce
    await expect.poll(async () => (await savedRule(serviceWorker, 'a')).response.body).toBe('quick');
    await expect(panel.locator('.editor .name')).toHaveValue('Login');
  });

  test('leaving a rule discards its invalid edits', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .url').fill('');
    await expect(panel.locator('.row').nth(0).locator('.draft')).toHaveText('Unsaved edits');
    await panel.locator('.row').nth(1).click();
    await expect(panel.locator('.row').nth(0).locator('.draft')).toHaveCount(0);
    await panel.locator('.row').nth(0).click();
    await expect(panel.locator('.editor .url')).toHaveValue('/api/users*');
  });

  test('a draft keeps its values while you look at another rule', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.bar .add').click();
    await panel.locator('.editor .name').fill('Half done');
    await panel.locator('.row').nth(1).click(); // another rule
    await panel.locator('.row').nth(0).click(); // back to the draft
    await expect(panel.locator('.editor .name')).toHaveValue('Half done');
    await expect(panel.locator('.row').nth(0).locator('.draft')).toHaveText('Not applied');
  });

  test('never reverts an enabled/disabled switch flipped elsewhere', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    const ext = await openExtensionPage(context, extensionId);
    const current = await savedRule(serviceWorker, 'a');
    await ext.evaluate((r) => chrome.runtime.sendMessage({ type: 'SAVE_RULE', rule: r }), { ...current, enabled: false });
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\boff\b/);
    await panel.locator('.editor .body').fill('after');
    await expect.poll(async () => (await savedRule(serviceWorker, 'a')).response.body).toBe('after');
    expect((await savedRule(serviceWorker, 'a')).enabled).toBe(false);
  });
});
