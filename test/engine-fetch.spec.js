const { test, expect } = require('./fixtures');
const { rule, pushRules, setState } = require('./helpers');

async function openWithRules({ context, server, serviceWorker }, rules) {
  server.requests.length = 0;
  await setState(serviceWorker, { rules });
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
  test('answers a matching request without touching the network', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [
      rule({ url: '/mocked', response: { status: 201, body: 'hello' } }),
    ]);
    expect(await doFetch(page, '/mocked')).toEqual({ status: 201, text: 'hello' });
    expect(server.requests.some((r) => r.includes('/mocked'))).toBe(false);
  });

  test('passes non-matching requests through to the server', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [rule({ url: '/mocked' })]);
    const res = await doFetch(page, '/api/other');
    expect(res.text).toContain('"source":"server"');
    expect(server.requests).toContain('GET /api/other');
  });

  test('an empty rule list mocks nothing', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, []);
    expect(isMocked(await doFetch(page, '/mocked'))).toBe(false);
  });

  test('a path-only pattern matches relative URLs and any origin', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [rule({ url: '/api/users' })]);
    expect(isMocked(await doFetch(page, '/api/users'))).toBe(true);
    expect(isMocked(await doFetch(page, server.origin + '/api/users'))).toBe(true);
    // A different origin that does not even resolve: proves no network request is made.
    expect(isMocked(await doFetch(page, 'https://example.invalid/api/users'))).toBe(true);
  });

  test('a full-URL wildcard pattern ignores the query string when it has no "?"', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [rule({ url: `${server.origin}/api/*` })]);
    expect(isMocked(await doFetch(page, '/api/x?y=1'))).toBe(true);
    expect(isMocked(await doFetch(page, '/other/x'))).toBe(false);
  });

  test('a pattern with "?" is compared against the full URL including the query', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [rule({ url: '/search?q=*' })]);
    expect(isMocked(await doFetch(page, '/search?q=abc'))).toBe(true);
    expect(isMocked(await doFetch(page, '/search'))).toBe(false);
    expect(isMocked(await doFetch(page, '/search?z=1'))).toBe(false);
  });

  test('method filter: a specific method only, ANY matches all, init.method is case-insensitive', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [
      rule({ url: '/only-post', method: 'POST' }),
      rule({ url: '/any', method: 'ANY' }),
    ]);
    expect(isMocked(await doFetch(page, '/only-post'))).toBe(false);
    expect(isMocked(await doFetch(page, '/only-post', { method: 'POST' }))).toBe(true);
    expect(isMocked(await doFetch(page, '/only-post', { method: 'post' }))).toBe(true);
    expect(isMocked(await doFetch(page, '/any'))).toBe(true);
    expect(isMocked(await doFetch(page, '/any', { method: 'DELETE' }))).toBe(true);
  });

  test('the first matching rule in list order wins', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [
      rule({ url: '/api/users', response: { body: 'specific' } }),
      rule({ url: '/api/*', response: { body: 'generic' } }),
    ]);
    expect((await doFetch(page, '/api/users')).text).toBe('specific');
    expect((await doFetch(page, '/api/other')).text).toBe('generic');
  });

  test('a #fragment does not affect matching', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [rule({ url: '/mocked' })]);
    expect(isMocked(await doFetch(page, '/mocked#section'))).toBe(true);
  });

  test('regex metacharacters in a pattern are literal', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [rule({ url: '/a.b+c(1)' })]);
    expect(isMocked(await doFetch(page, '/a.b+c(1)'))).toBe(true);
    expect(isMocked(await doFetch(page, '/aXb+c(1)'))).toBe(false);
  });

  test('works with a Request object and with a URL object', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [rule({ url: '/mocked', response: { body: 'ok' } })]);
    const viaRequest = await page.evaluate(() => fetch(new Request('/mocked')).then((r) => r.text()));
    const viaUrl = await page.evaluate(() => fetch(new URL('/mocked', location.href)).then((r) => r.text()));
    expect(viaRequest).toBe('ok');
    expect(viaUrl).toBe('ok');
  });

  test('emits a MOCK_EVENT with the absolute URL, method and status', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [
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

test.describe('engine: faithful fetch responses', () => {
  test('status, statusText, ok, headers and body', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [
      rule({ url: '/mocked', response: { status: 404, headers: [{ name: 'X-A', value: '1' }], body: 'nope' } }),
    ]);
    const out = await page.evaluate(async () => {
      const r = await fetch('/mocked');
      return { status: r.status, ok: r.ok, statusText: r.statusText, xa: r.headers.get('x-a'), text: await r.text() };
    });
    expect(out).toEqual({ status: 404, ok: false, statusText: 'Not Found', xa: '1', text: 'nope' });
  });

  test('Content-Type: the user header wins, otherwise JSON bodies get application/json', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [
      rule({ url: '/json', response: { body: '{"a":1}' } }),
      rule({ url: '/text', response: { body: 'Created!' } }),
      rule({ url: '/override', response: { body: '{"a":1}', headers: [{ name: 'content-type', value: 'text/html' }] } }),
      rule({ url: '/empty', response: { body: '' } }),
    ]);
    const ct = (path) => page.evaluate((p) => fetch(p).then((r) => r.headers.get('content-type')), path);
    expect(await ct('/json')).toBe('application/json');
    expect(await ct('/text')).toBe('text/plain;charset=UTF-8');
    expect(await ct('/override')).toBe('text/html');
    expect(await ct('/empty')).toBe('text/plain;charset=UTF-8');
  });

  test('response.url is the absolute request URL (spec assumption 5)', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [rule({ url: '/mocked' })]);
    const url = await page.evaluate(() => fetch('/mocked?x=1#frag').then((r) => r.url));
    expect(url).toBe(server.origin + '/mocked?x=1');
  });

  for (const status of [204, 205, 304]) {
    test(`status ${status} is delivered without a body even if the rule has one`, async ({ context, server, serviceWorker }) => {
      const page = await openWithRules({ context, server, serviceWorker }, [rule({ url: '/mocked', response: { status, body: 'ignored' } })]);
      const out = await page.evaluate(async () => {
        const r = await fetch('/mocked');
        return { status: r.status, text: await r.text() };
      });
      expect(out).toEqual({ status, text: '' });
    });
  }

  test('delay postpones the response', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [rule({ url: '/mocked', response: { delay: 300 } })]);
    const elapsed = await page.evaluate(async () => {
      const t0 = performance.now();
      await fetch('/mocked');
      return performance.now() - t0;
    });
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });

  test('a mocked fetch can be aborted during its delay, like a real one', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [rule({ url: '/mocked', response: { delay: 1000 } })]);
    const out = await page.evaluate(async () => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 50);
      const t0 = performance.now();
      const name = await fetch('/mocked', { signal: ac.signal }).then(() => 'resolved', (e) => e.name);
      return { name, elapsed: performance.now() - t0 };
    });
    expect(out.name).toBe('AbortError');
    expect(out.elapsed).toBeLessThan(500);
  });

  test('an already-aborted signal rejects immediately and the abort reason is preserved', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [rule({ url: '/mocked' })]);
    const out = await page.evaluate(async () => {
      const a = await fetch('/mocked', { signal: AbortSignal.abort() }).then(() => 'resolved', (e) => e.name);
      const ac = new AbortController();
      ac.abort('boom');
      const b = await fetch(new Request('/mocked', { signal: ac.signal })).then(() => 'resolved', (e) => e);
      return [a, b];
    });
    expect(out).toEqual(['AbortError', 'boom']);
  });

  test('a rule the browser would reject (status 700) is skipped and the request passes through', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [rule({ url: '/bad', response: { status: 700 } })]);
    expect(isMocked(await doFetch(page, '/bad'))).toBe(false);
  });

  test('non-matching requests reach the server untouched (method, body, Request objects)', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, [rule({ url: '/mocked' })]);
    const statuses = await page.evaluate(async () => {
      const a = await fetch('/api/upload', { method: 'POST', body: 'payload', headers: { 'x-t': '1' } });
      const b = await fetch(new Request('/api/req-body', { method: 'PUT', body: 'abc' }));
      return [a.status, b.status];
    });
    expect(statuses).toEqual([200, 200]);
    expect(server.requests).toEqual(expect.arrayContaining(['POST /api/upload', 'PUT /api/req-body']));
  });

  test('the patched fetch keeps the native name and length', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules({ context, server, serviceWorker }, []);
    expect(await page.evaluate(() => [fetch.name, fetch.length])).toEqual(['fetch', 1]);
  });

  const CASES = [
    { status: 200, ct: 'application/json', body: '{"a":1}' },
    { status: 201, ct: 'text/plain', body: 'created' },
    { status: 204, ct: 'text/plain', body: '' },
    { status: 400, ct: 'application/json', body: '{"e":"bad"}' },
    { status: 404, ct: 'text/html', body: '<p>nope</p>' },
    { status: 500, ct: 'application/json', body: '{"e":1}' },
    { status: 503, ct: 'text/plain', body: '' },
  ];

  test('conformance: a mocked response looks like the real one for common cases', async ({ context, server, serviceWorker }) => {
    const page = await openWithRules(
      { context, server, serviceWorker },
      CASES.map((c, i) =>
        rule({
          url: `/mocked/${i}`,
          response: {
            status: c.status,
            body: c.body,
            headers: [{ name: 'Content-Type', value: c.ct }, { name: 'X-A', value: '1' }],
          },
        }),
      ),
    );
    const observe = (url) =>
      page.evaluate(async (u) => {
        const res = await fetch(u);
        const copy = res.clone();
        const text = await res.text();
        const bytes = (await copy.arrayBuffer()).byteLength;
        return {
          status: res.status,
          ok: res.ok,
          statusText: res.statusText,
          redirected: res.redirected,
          contentType: res.headers.get('content-type'),
          xa: res.headers.get('x-a'),
          text,
          bytes,
        };
      }, url);

    for (const [i, c] of CASES.entries()) {
      const q = `status=${c.status}&h=${encodeURIComponent('content-type:' + c.ct)}&h=${encodeURIComponent('x-a:1')}&body=${encodeURIComponent(c.body)}`;
      const real = await observe(`/reflect?${q}`);
      const mocked = await observe(`/mocked/${i}`);
      expect(mocked, `status ${c.status}`).toEqual(real);
    }
  });
});
