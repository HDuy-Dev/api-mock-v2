const { test, expect } = require('./fixtures');
const { openExtensionPage } = require('./helpers');

test.describe('registration', () => {
  test('the manifest declares the devtools page and still only the storage permission', async ({ serviceWorker }) => {
    const m = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
    expect(m.devtools_page).toBe('devtools.html');
    expect(m.permissions).toEqual(['storage']);
  });

  test('devtools.html loads outside DevTools without errors', async ({ context, extensionId }) => {
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`chrome-extension://${extensionId}/devtools.html`);
    await page.waitForTimeout(200);
    expect(errors).toEqual([]);
  });
});

test.describe('shared modules', () => {
  let ext;
  test.beforeEach(async ({ context, extensionId }) => {
    ext = await openExtensionPage(context, extensionId);
  });

  test('h() builds elements and never interprets HTML', async () => {
    const out = await ext.evaluate(async () => {
      const { h, clear } = await import('/shared/dom.js');
      const clicks = [];
      const btn = h(
        'button',
        { class: 'a b', title: 'T', dataset: { x: '1' }, 'aria-label': 'L', onclick: () => clicks.push(1) },
        h('b', {}, '<i>x</i>'),
        ' tail',
        null,
        false,
        ['p', 'q'],
      );
      btn.click();
      const input = h('input', { disabled: true, value: 'v', hidden: false, placeholder: undefined });
      const box = h('div', {}, 'a', 'b');
      return {
        cls: btn.className, title: btn.title, x: btn.dataset.x, aria: btn.getAttribute('aria-label'),
        text: btn.textContent, inner: btn.firstChild.innerHTML, clicks: clicks.length,
        disabled: input.disabled, value: input.value, hidden: input.hidden, hasPlaceholder: input.hasAttribute('placeholder'),
        cleared: clear(box).childNodes.length,
      };
    });
    expect(out).toEqual({
      cls: 'a b', title: 'T', x: '1', aria: 'L', text: '<i>x</i> tailpq', inner: '&lt;i&gt;x&lt;/i&gt;', clicks: 1,
      disabled: true, value: 'v', hidden: false, hasPlaceholder: false, cleared: 0,
    });
  });

  test('methodLabel shortens DELETE and OPTIONS only', async () => {
    const out = await ext.evaluate(async () => {
      const { methodLabel } = await import('/shared/rule.js');
      return ['GET', 'DELETE', 'OPTIONS', 'ANY', 'PATCH'].map(methodLabel);
    });
    expect(out).toEqual(['GET', 'DEL', 'OPT', 'ANY', 'PATCH']);
  });

  test('computePopupStatus: first matching condition wins', async () => {
    const run = (input) =>
      ext.evaluate(async (i) => (await import('/shared/status.js')).computePopupStatus(i), input);
    const base = { globalEnabled: true, reachable: true, issues: 0, mocked: 0, ruleCount: 2 };

    expect(await run({ ...base, globalEnabled: false, reachable: false, issues: 3 })).toEqual({
      kind: 'off', title: 'Off', detail: 'requests go straight to the network',
    });
    expect(await run({ ...base, reachable: false, issues: 3 })).toMatchObject({ kind: 'warn', title: 'Not active on this tab yet' });
    expect(await run({ ...base, issues: 1 })).toMatchObject({ kind: 'warn', title: '1 issue on this tab' });
    expect(await run({ ...base, issues: 2 })).toMatchObject({ kind: 'warn', title: '2 issues on this tab' });
    expect(await run({ ...base, ruleCount: 0 })).toEqual({ kind: 'ok', title: 'Active', detail: 'no rules yet' });
    expect(await run({ ...base, mocked: 3 })).toEqual({ kind: 'ok', title: 'Active', detail: '3 mocked on this tab' });
    expect(await run(base)).toEqual({ kind: 'ok', title: 'Active', detail: 'nothing mocked on this tab yet' });
  });

  test('store.readAll returns defaults, then stored values (spec assumption 4: storage.session is readable)', async ({ serviceWorker }) => {
    const readAll = (tabId) => ext.evaluate(async (id) => (await import('/shared/store.js')).readAll(id), tabId);
    expect(await readAll(7)).toEqual({
      state: { version: 1, globalEnabled: true, rules: [] }, hits: {}, log: [], tab: { mocked: 0, issues: 0 },
    });
    await serviceWorker.evaluate(() =>
      Promise.all([
        chrome.storage.local.set({ state: { version: 1, globalEnabled: false, rules: [] }, hits: { a: 2 } }),
        chrome.storage.session.set({ 'log:7': [{ kind: 'mock' }], 'tab:7': { mocked: 1, issues: 3 } }),
      ]),
    );
    expect(await readAll(7)).toEqual({
      state: { version: 1, globalEnabled: false, rules: [] }, hits: { a: 2 }, log: [{ kind: 'mock' }], tab: { mocked: 1, issues: 3 },
    });
    expect((await readAll(null)).log).toEqual([]);
  });

  test('store.subscribe fires for state, hits and this tab\'s log/counters only (spec assumption 4)', async ({ serviceWorker }) => {
    await ext.evaluate(async () => {
      const { subscribe } = await import('/shared/store.js');
      window.__n = 0;
      window.__off = subscribe(7, () => {
        window.__n += 1;
      });
    });
    const count = () => ext.evaluate(() => window.__n);

    await serviceWorker.evaluate(() => chrome.storage.local.set({ state: { version: 1, globalEnabled: true, rules: [] } }));
    await expect.poll(count).toBe(1);
    await serviceWorker.evaluate(() => chrome.storage.local.set({ hits: { x: 1 } }));
    await expect.poll(count).toBe(2);
    await serviceWorker.evaluate(() => chrome.storage.session.set({ 'log:7': [] }));
    await expect.poll(count).toBe(3);
    await serviceWorker.evaluate(() => chrome.storage.session.set({ 'tab:7': { mocked: 0, issues: 0 } }));
    await expect.poll(count).toBe(4);

    // Not ours: another tab's data and unrelated keys.
    await serviceWorker.evaluate(() => chrome.storage.session.set({ 'log:8': [], other: 1 }));
    await serviceWorker.evaluate(() => chrome.storage.local.set({ unrelated: 1 }));
    await ext.waitForTimeout(200);
    expect(await count()).toBe(4);

    await ext.evaluate(() => window.__off());
    await serviceWorker.evaluate(() => chrome.storage.local.set({ state: { version: 1, globalEnabled: false, rules: [] } }));
    await ext.waitForTimeout(200);
    expect(await count()).toBe(4);
  });

  test('store.send reaches the service worker', async () => {
    const res = await ext.evaluate(async () => {
      const { send } = await import('/shared/store.js');
      return send({
        type: 'SAVE_RULE',
        rule: { enabled: true, name: 'X', method: 'GET', url: '/x', response: { status: 200, headers: [], body: '{}', delay: 0 } },
      });
    });
    expect(res.ok).toBe(true);
    expect(res.rule.url).toBe('/x');
  });
});
