const { test, expect } = require('./fixtures');
const { rule, pushRules } = require('./helpers');

const payloadOf = (r) => [{ id: r.id, method: r.method, url: r.url, response: r.response }];

// Navigates and starts collecting engine events (everything except RULES) in window.__events.
async function open(page, server) {
  server.requests.length = 0;
  await page.goto(server.origin + '/');
  await page.evaluate(() => {
    window.__events = [];
    window.addEventListener('message', (e) => {
      const t = e.data && e.data.type;
      if (typeof t === 'string' && t.startsWith('__API_MOCK__/') && t !== '__API_MOCK__/RULES') window.__events.push(e.data);
    });
  });
}
const events = (page, kind) => page.evaluate((k) => window.__events.filter((e) => e.type === '__API_MOCK__/' + k), kind);
const doFetch = (page, url) => page.evaluate((u) => fetch(u).then((r) => r.text()), url);
const isMocked = (text) => !text.includes('"source":"server"');

test.describe('engine: startup gate', () => {
  test('a request issued before the first RULES is held and answered once they arrive', async ({ enginePage, server }) => {
    await open(enginePage, server);
    const r = rule({ url: '/mocked', response: { body: 'held' } });
    // Same task: fetch is called first, RULES are posted right after.
    const out = await enginePage.evaluate(async (rules) => {
      const pending = fetch('/mocked').then((res) => res.text());
      window.postMessage({ type: '__API_MOCK__/RULES', rules }, '*');
      return pending;
    }, payloadOf(r));
    expect(out).toBe('held');
    expect(server.requests.some((x) => x.includes('/mocked'))).toBe(false);
  });

  test('a deferred async XHR is mocked once RULES arrive', async ({ enginePage, server }) => {
    await open(enginePage, server);
    const r = rule({ url: '/mocked', response: { body: 'held' } });
    const out = await enginePage.evaluate(
      (rules) =>
        new Promise((resolve) => {
          const x = new XMLHttpRequest();
          x.onloadend = () => resolve({ status: x.status, text: x.responseText });
          x.open('GET', '/mocked');
          x.send();
          window.postMessage({ type: '__API_MOCK__/RULES', rules }, '*');
        }),
      payloadOf(r),
    );
    expect(out).toEqual({ status: 200, text: 'held' });
    expect(server.requests.some((x) => x.includes('/mocked'))).toBe(false);
  });

  test('aborting a deferred XHR cancels it: abort events fire and nothing reaches the network', async ({ enginePage, server }) => {
    await open(enginePage, server);
    const r = rule({ url: '/mocked' });
    const out = await enginePage.evaluate(
      (rules) =>
        new Promise((resolve) => {
          const x = new XMLHttpRequest();
          const events = [];
          for (const t of ['readystatechange', 'abort', 'loadend', 'load']) x.addEventListener(t, () => events.push(`${t}:${x.readyState}`));
          x.open('GET', '/mocked');
          x.send();
          x.abort();
          window.postMessage({ type: '__API_MOCK__/RULES', rules }, '*');
          setTimeout(() => resolve({ events, readyState: x.readyState }), 300);
        }),
      payloadOf(r),
    );
    expect(out.events).toEqual(['readystatechange:1', 'readystatechange:4', 'abort:4', 'loadend:4']);
    expect(out.readyState).toBe(0);
    expect(server.requests.some((x) => x.includes('/mocked'))).toBe(false);
  });

  test('a synchronous XHR never waits: it passes through and reports RULES_UNAVAILABLE once', async ({ enginePage, server }) => {
    await open(enginePage, server);
    const text = () =>
      enginePage.evaluate(() => {
        const x = new XMLHttpRequest();
        x.open('GET', '/api/sync', false);
        x.send();
        return x.responseText;
      });
    expect(await text()).toContain('"source":"server"');
    expect(await text()).toContain('"source":"server"');
    await expect.poll(() => events(enginePage, 'RULES_UNAVAILABLE')).toHaveLength(1);
    await enginePage.waitForTimeout(100);
    expect(await events(enginePage, 'RULES_UNAVAILABLE')).toHaveLength(1);
  });

  test('after 1 second without RULES the engine fails open, reports once, and late RULES still apply', async ({ enginePage, server }) => {
    await open(enginePage, server);
    await enginePage.waitForTimeout(1300);
    await expect.poll(() => events(enginePage, 'RULES_UNAVAILABLE')).toHaveLength(1);
    expect(isMocked(await doFetch(enginePage, '/mocked'))).toBe(false); // passes through, not held
    await pushRules(enginePage, [rule({ url: '/mocked' })]);
    expect(isMocked(await doFetch(enginePage, '/mocked'))).toBe(true);
    expect(await events(enginePage, 'RULES_UNAVAILABLE')).toHaveLength(1);
  });
});

test.describe('engine: fail-open and error reporting', () => {
  test('a rule that cannot be compiled is skipped and reported with its id; other rules still work', async ({ enginePage, server }) => {
    await open(enginePage, server);
    await pushRules(enginePage, [
      rule({ id: 'bad', url: '/bad', response: { status: 700 } }),
      rule({ id: 'good', url: '/good' }),
    ]);
    await expect.poll(() => events(enginePage, 'ENGINE_ERROR')).toHaveLength(1);
    const [err] = await events(enginePage, 'ENGINE_ERROR');
    expect(err.ruleId).toBe('bad');
    expect(typeof err.message).toBe('string');
    expect(isMocked(await doFetch(enginePage, '/good'))).toBe(true);
  });

  test('fetch: a fault while building the response falls back to the network and is reported', async ({ enginePage, server }) => {
    await open(enginePage, server);
    await pushRules(enginePage, [rule({ id: 'f1', url: '/api/fault' })]);
    await enginePage.evaluate(() => {
      window.Response = function () {
        throw new Error('boom');
      };
    });
    expect(await doFetch(enginePage, '/api/fault')).toContain('"source":"server"');
    await expect.poll(() => events(enginePage, 'ENGINE_ERROR')).toHaveLength(1);
    expect(await events(enginePage, 'ENGINE_ERROR')).toMatchObject([{ ruleId: 'f1', message: 'boom' }]);
  });

  test('XHR: a fault while starting the mock falls back to the network and is reported', async ({ enginePage, server }) => {
    await open(enginePage, server);
    await pushRules(enginePage, [rule({ id: 'x1', url: '/api/fault' })]);
    await enginePage.evaluate(() => {
      window.TextEncoder = function () {
        throw new Error('boom');
      };
    });
    const text = await enginePage.evaluate(
      () =>
        new Promise((resolve) => {
          const x = new XMLHttpRequest();
          x.onloadend = () => resolve(x.responseText);
          x.open('GET', '/api/fault');
          x.send();
        }),
    );
    expect(text).toContain('"source":"server"');
    await expect.poll(() => events(enginePage, 'ENGINE_ERROR')).toHaveLength(1);
    expect(await events(enginePage, 'ENGINE_ERROR')).toMatchObject([{ ruleId: 'x1', message: 'boom' }]);
  });

  test('a URL the browser cannot parse is left to the browser and is not reported as an engine error', async ({ enginePage, server }) => {
    await open(enginePage, server);
    await pushRules(enginePage, [rule({ url: '/x' })]);
    const name = await enginePage.evaluate(() => fetch('http://[').then(() => 'resolved', (e) => e.name));
    expect(name).toBe('TypeError');
    await enginePage.waitForTimeout(100);
    expect(await events(enginePage, 'ENGINE_ERROR')).toHaveLength(0);
  });
});

test.describe('engine: silence', () => {
  test('prints nothing, changes no DOM and leaves no enumerable globals', async ({ enginePage, server }) => {
    const logs = [];
    enginePage.on('console', (m) => logs.push(m.text()));
    enginePage.on('pageerror', (e) => logs.push(String(e)));
    await open(enginePage, server);
    const domBefore = await enginePage.evaluate(() => document.documentElement.outerHTML);

    await pushRules(enginePage, [
      rule({ id: 'ok', url: '/mocked' }),
      rule({ id: 'bad', url: '/bad', response: { status: 700 } }),
      rule({ id: 'fault', url: '/api/fault' }),
    ]);
    await doFetch(enginePage, '/mocked'); // mocked fetch
    await doFetch(enginePage, '/api/real'); // pass-through fetch
    await enginePage.evaluate(
      () =>
        new Promise((resolve) => {
          const x = new XMLHttpRequest();
          x.onloadend = resolve;
          x.open('GET', '/mocked');
          x.send();
        }),
    );
    await enginePage.evaluate(() => {
      window.Response = function () {
        throw new Error('boom');
      };
    });
    await doFetch(enginePage, '/api/fault'); // engine fault
    await enginePage.waitForTimeout(100);

    expect(logs).toEqual([]);
    expect(await enginePage.evaluate(() => document.documentElement.outerHTML)).toBe(domBefore);
    expect(await enginePage.evaluate(() => Object.keys(window).filter((k) => /mock|engine|__api/i.test(k)))).toEqual([]);
  });
});

test.describe('engine: privacy (spec assumption 2)', () => {
  test('page listeners registered later never see RULES, only metadata-only MOCK_EVENTs', async ({ enginePage, server }) => {
    await open(enginePage, server);
    await enginePage.evaluate(() => {
      window.__seen = [];
      window.__mockEvents = [];
      window.addEventListener('message', (e) => {
        window.__seen.push('bubble:' + (e.data && e.data.type));
        if (e.data && e.data.type === '__API_MOCK__/MOCK_EVENT') window.__mockEvents.push(e.data);
      });
      window.addEventListener('message', (e) => window.__seen.push('capture:' + (e.data && e.data.type)), true);
    });
    await pushRules(enginePage, [rule({ id: 's1', name: 'Secret name', url: '/mocked', response: { body: 'secret-body' } })]);
    await doFetch(enginePage, '/mocked');
    await expect.poll(() => enginePage.evaluate(() => window.__mockEvents.length)).toBe(1);

    const seen = await enginePage.evaluate(() => window.__seen);
    expect(seen.filter((s) => s.endsWith('/RULES'))).toEqual([]);
    expect(seen).toContain('bubble:__API_MOCK__/MOCK_EVENT');
    expect(seen).toContain('capture:__API_MOCK__/MOCK_EVENT');

    const [ev] = await enginePage.evaluate(() => window.__mockEvents);
    expect(Object.keys(ev).sort()).toEqual(['method', 'ruleId', 'status', 'ts', 'type', 'url']);
    expect(JSON.stringify(ev)).not.toContain('secret');
  });
});
