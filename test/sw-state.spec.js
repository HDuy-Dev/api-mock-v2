const { test, expect } = require('./fixtures');
const { openExtensionPage } = require('./helpers');

const draft = (over = {}) => ({
  enabled: true,
  name: '',
  method: 'GET',
  url: '/api/x',
  response: { status: 200, headers: [], body: '{}', delay: 0 },
  ...over,
});

test.describe('service worker: state handlers', () => {
  let ext;
  const send = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const stored = (sw) => sw.evaluate(() => chrome.storage.local.get('state').then((r) => r.state));

  test.beforeEach(async ({ context, extensionId }) => {
    ext = await openExtensionPage(context, extensionId);
  });

  test('SAVE_RULE creates a rule on top of an empty state and fills id and name', async ({ serviceWorker }) => {
    const res = await send({ type: 'SAVE_RULE', rule: draft({ url: '/api/users*' }) });
    expect(res.ok).toBe(true);
    expect(res.rule).toMatchObject({ enabled: true, name: 'users', method: 'GET', url: '/api/users*' });
    expect(typeof res.rule.id).toBe('string');
    expect(await stored(serviceWorker)).toEqual({ version: 1, globalEnabled: true, rules: [res.rule] });
  });

  test('a new rule goes to the top; saving an existing id replaces it in place', async ({ serviceWorker }) => {
    const a = (await send({ type: 'SAVE_RULE', rule: draft({ name: 'A', url: '/a' }) })).rule;
    const b = (await send({ type: 'SAVE_RULE', rule: draft({ name: 'B', url: '/b' }) })).rule;
    expect((await stored(serviceWorker)).rules.map((r) => r.name)).toEqual(['B', 'A']);

    await send({ type: 'SAVE_RULE', rule: { ...a, url: '/a2', response: { ...a.response, status: 404 } } });
    const rules = (await stored(serviceWorker)).rules;
    expect(rules.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(rules[1]).toMatchObject({ url: '/a2', response: { status: 404 } });
  });

  test('SAVE_RULE rejects an invalid rule with field errors and stores nothing', async ({ serviceWorker }) => {
    const res = await send({ type: 'SAVE_RULE', rule: draft({ url: '', response: { status: 700, headers: [], body: '', delay: 0 } }) });
    expect(res).toEqual({ ok: false, errors: { url: 'URL is required', status: 'Must be 200–599' } });
    expect(await stored(serviceWorker)).toBeUndefined();
  });

  test('DELETE_RULE removes a rule and reports how many were removed', async ({ serviceWorker }) => {
    const a = (await send({ type: 'SAVE_RULE', rule: draft({ url: '/a' }) })).rule;
    await send({ type: 'SAVE_RULE', rule: draft({ url: '/b' }) });
    expect(await send({ type: 'DELETE_RULE', id: a.id })).toEqual({ ok: true, removed: 1 });
    expect(await send({ type: 'DELETE_RULE', id: a.id })).toEqual({ ok: true, removed: 0 });
    expect((await stored(serviceWorker)).rules.map((r) => r.url)).toEqual(['/b']);
  });

  test('REORDER moves a rule up or down and is a no-op at the edges', async ({ serviceWorker }) => {
    const a = (await send({ type: 'SAVE_RULE', rule: draft({ name: 'A', url: '/a' }) })).rule;
    const b = (await send({ type: 'SAVE_RULE', rule: draft({ name: 'B', url: '/b' }) })).rule;
    const c = (await send({ type: 'SAVE_RULE', rule: draft({ name: 'C', url: '/c' }) })).rule; // order: C B A
    const names = async () => (await stored(serviceWorker)).rules.map((r) => r.name).join('');

    expect(await send({ type: 'REORDER', id: c.id, dir: 'up' })).toEqual({ ok: true, moved: false });
    expect(await send({ type: 'REORDER', id: a.id, dir: 'down' })).toEqual({ ok: true, moved: false });
    expect(await send({ type: 'REORDER', id: 'missing', dir: 'up' })).toEqual({ ok: true, moved: false });
    expect(await send({ type: 'REORDER', id: b.id, dir: 'up' })).toEqual({ ok: true, moved: true });
    expect(await names()).toBe('BCA');
    expect(await send({ type: 'REORDER', id: b.id, dir: 'down' })).toEqual({ ok: true, moved: true });
    expect(await names()).toBe('CBA');
  });

  test('SET_GLOBAL switches mocking off and on', async ({ serviceWorker }) => {
    await send({ type: 'SET_GLOBAL', enabled: false });
    expect((await stored(serviceWorker)).globalEnabled).toBe(false);
    await send({ type: 'SET_GLOBAL', enabled: true });
    expect((await stored(serviceWorker)).globalEnabled).toBe(true);
  });

  test('concurrent saves never lose an update (single writer)', async ({ serviceWorker }) => {
    const results = await ext.evaluate(() =>
      Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          chrome.runtime.sendMessage({
            type: 'SAVE_RULE',
            rule: { enabled: true, name: `R${i}`, method: 'GET', url: `/r${i}`, response: { status: 200, headers: [], body: '{}', delay: 0 } },
          }),
        ),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const rules = (await stored(serviceWorker)).rules;
    expect(rules).toHaveLength(20);
    expect(new Set(rules.map((r) => r.url)).size).toBe(20);
  });
});
