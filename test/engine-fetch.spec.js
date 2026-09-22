const { test, expect } = require('./fixtures');
const { rule, pushRules } = require('./helpers');

async function openWithRules({ context, server }, rules) {
  server.requests.length = 0;
  const page = await context.newPage();
  await page.goto(server.origin + '/');
  await pushRules(page, rules);
  return page;
}

const doFetch = (page, url, init) =>
  page.evaluate(
    async ([u, i]) => {
      const res = await fetch(u, i);
      return { status: res.status, text: await res.text() };
    },
    [url, init],
  );

const isMocked = (result) => !result.text.includes('"source":"server"');

test.describe('engine: matching and basic mocking (fetch)', () => {
  test('answers a matching request without touching the network', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [
      rule({ url: '/mocked', response: { status: 201, body: 'hello' } }),
    ]);
    expect(await doFetch(page, '/mocked')).toEqual({ status: 201, text: 'hello' });
    expect(server.requests.some((r) => r.includes('/mocked'))).toBe(false);
  });

  test('passes non-matching requests through to the server', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked' })]);
    const res = await doFetch(page, '/api/other');
    expect(res.text).toContain('"source":"server"');
    expect(server.requests).toContain('GET /api/other');
  });

  test('an empty rule list mocks nothing', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, []);
    expect(isMocked(await doFetch(page, '/mocked'))).toBe(false);
  });

  test('a path-only pattern matches relative URLs and any origin', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/api/users' })]);
    expect(isMocked(await doFetch(page, '/api/users'))).toBe(true);
    expect(isMocked(await doFetch(page, server.origin + '/api/users'))).toBe(true);
    // A different origin that does not even resolve: proves no network request is made.
    expect(isMocked(await doFetch(page, 'https://example.invalid/api/users'))).toBe(true);
  });

  test('a full-URL wildcard pattern ignores the query string when it has no "?"', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: `${server.origin}/api/*` })]);
    expect(isMocked(await doFetch(page, '/api/x?y=1'))).toBe(true);
    expect(isMocked(await doFetch(page, '/other/x'))).toBe(false);
  });

  test('a pattern with "?" is compared against the full URL including the query', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/search?q=*' })]);
    expect(isMocked(await doFetch(page, '/search?q=abc'))).toBe(true);
    expect(isMocked(await doFetch(page, '/search'))).toBe(false);
    expect(isMocked(await doFetch(page, '/search?z=1'))).toBe(false);
  });

  test('method filter: a specific method only, ANY matches all, init.method is case-insensitive', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [
      rule({ url: '/only-post', method: 'POST' }),
      rule({ url: '/any', method: 'ANY' }),
    ]);
    expect(isMocked(await doFetch(page, '/only-post'))).toBe(false);
    expect(isMocked(await doFetch(page, '/only-post', { method: 'POST' }))).toBe(true);
    expect(isMocked(await doFetch(page, '/only-post', { method: 'post' }))).toBe(true);
    expect(isMocked(await doFetch(page, '/any'))).toBe(true);
    expect(isMocked(await doFetch(page, '/any', { method: 'DELETE' }))).toBe(true);
  });

  test('the first matching rule in list order wins', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [
      rule({ url: '/api/users', response: { body: 'specific' } }),
      rule({ url: '/api/*', response: { body: 'generic' } }),
    ]);
    expect((await doFetch(page, '/api/users')).text).toBe('specific');
    expect((await doFetch(page, '/api/other')).text).toBe('generic');
  });

  test('a #fragment does not affect matching', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked' })]);
    expect(isMocked(await doFetch(page, '/mocked#section'))).toBe(true);
  });

  test('regex metacharacters in a pattern are literal', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/a.b+c(1)' })]);
    expect(isMocked(await doFetch(page, '/a.b+c(1)'))).toBe(true);
    expect(isMocked(await doFetch(page, '/aXb+c(1)'))).toBe(false);
  });

  test('works with a Request object and with a URL object', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked', response: { body: 'ok' } })]);
    const viaRequest = await page.evaluate(() => fetch(new Request('/mocked')).then((r) => r.text()));
    const viaUrl = await page.evaluate(() => fetch(new URL('/mocked', location.href)).then((r) => r.text()));
    expect(viaRequest).toBe('ok');
    expect(viaUrl).toBe('ok');
  });

  test('emits a MOCK_EVENT with the absolute URL, method and status', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [
      rule({ id: 'ev1', url: '/mocked', method: 'POST', response: { status: 202 } }),
    ]);
    await page.evaluate(() => {
      window.__events = [];
      window.addEventListener('message', (e) => {
        if (e.data && e.data.type === '__API_MOCK__/MOCK_EVENT') window.__events.push(e.data);
      });
    });
    await doFetch(page, '/mocked?a=1', { method: 'POST' });
    await expect.poll(() => page.evaluate(() => window.__events.length)).toBe(1);
    const ev = await page.evaluate(() => window.__events[0]);
    expect(ev).toMatchObject({ ruleId: 'ev1', method: 'POST', status: 202, url: server.origin + '/mocked?a=1' });
    expect(typeof ev.ts).toBe('number');
  });
});
