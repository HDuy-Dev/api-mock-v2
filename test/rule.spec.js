const { test, expect } = require('./fixtures');
const { openExtensionPage } = require('./helpers');

test.describe('shared/rule.js', () => {
  let ext;
  test.beforeEach(async ({ context, extensionId }) => {
    ext = await openExtensionPage(context, extensionId);
  });
  const run = (name, ...args) =>
    ext.evaluate(async ([n, a]) => (await import('/shared/rule.js'))[n](...a), [name, args]);

  const valid = () => ({
    id: 'a', enabled: true, name: 'A', method: 'GET', url: '/api/x',
    response: { status: 200, headers: [{ name: 'X-A', value: '1' }], body: '{}', delay: 0 },
  });

  test('defaultState', async () => {
    expect(await run('defaultState')).toEqual({ version: 1, globalEnabled: true, rules: [] });
  });

  test('defaultName uses the last meaningful URL segment', async () => {
    expect(await run('defaultName', '/api/users*')).toBe('users');
    expect(await run('defaultName', 'https://api.example.com/users/*')).toBe('users');
    expect(await run('defaultName', 'https://api.example.com/orders?x=1')).toBe('orders');
    expect(await run('defaultName', '')).toBe('New rule');
    expect(await run('defaultName', '*')).toBe('New rule');
  });

  test('newRule fills defaults and merges a partial response', async () => {
    const r = await run('newRule', { url: '/a', response: { status: 404 } });
    expect(r.url).toBe('/a');
    expect(r.enabled).toBe(true);
    expect(r.method).toBe('GET');
    expect(r.response).toEqual({ status: 404, headers: [], body: '{\n  \n}', delay: 0 });
    expect(typeof r.id).toBe('string');
  });

  test('validateRule accepts a valid rule', async () => {
    expect(await run('validateRule', valid())).toEqual({ ok: true, errors: {} });
  });

  test('validateRule reports each field with the UI wording', async () => {
    const bad = valid();
    bad.url = '   ';
    bad.method = 'FETCH';
    bad.response.status = 700;
    bad.response.delay = -1;
    const { ok, errors } = await run('validateRule', bad);
    expect(ok).toBe(false);
    expect(errors.url).toBe('URL is required');
    expect(errors.method).toBe('Invalid method');
    expect(errors.status).toBe('Must be 200–599');
    expect(errors.delay).toBe('Must be 0–60000');
  });

  test('validateRule enforces boundaries', async () => {
    const at = (patch) => {
      const r = valid();
      Object.assign(r.response, patch);
      return r;
    };
    expect((await run('validateRule', at({ status: 200 }))).ok).toBe(true);
    expect((await run('validateRule', at({ status: 599 }))).ok).toBe(true);
    expect((await run('validateRule', at({ status: 199 }))).errors.status).toBe('Must be 200–599');
    expect((await run('validateRule', at({ status: 200.5 }))).errors.status).toBe('Must be 200–599');
    expect((await run('validateRule', at({ delay: 60000 }))).ok).toBe(true);
    expect((await run('validateRule', at({ delay: 60001 }))).errors.delay).toBe('Must be 0–60000');
    const long = valid();
    long.url = 'x'.repeat(2049);
    expect((await run('validateRule', long)).errors.url).toContain('too long');
  });

  test('validateRule rejects bad headers and non-string body', async () => {
    const r = valid();
    r.response.headers = [{ name: 'Bad Name', value: '1' }];
    r.response.body = 5;
    const { errors } = await run('validateRule', r);
    expect(errors.headers).toBe('Header 1: invalid header');
    expect(errors.body).toBe('Body must be text');
  });

  test('parseHeaders parses Key: Value lines and keeps colons in values', async () => {
    expect(await run('parseHeaders', 'Content-Type: application/json\n\nLocation: http://x/y\n')).toEqual({
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Location', value: 'http://x/y' },
      ],
      error: null,
    });
  });

  test('parseHeaders reports the offending line number', async () => {
    const res = await run('parseHeaders', 'A: 1\nno colon here\nB: 2');
    expect(res.error).toBe('Line 2: invalid header name');
    expect(await run('parseHeaders', ': empty name')).toMatchObject({ error: 'Line 1: invalid header name' });
  });

  test('stringifyHeaders is the inverse of parseHeaders for simple input', async () => {
    const text = 'A: 1\nB: two';
    const parsed = await run('parseHeaders', text);
    expect(await run('stringifyHeaders', parsed.headers)).toBe(text);
  });

  test('isJson', async () => {
    expect(await run('isJson', '{"a":1}')).toBe(true);
    expect(await run('isJson', ' [1, 2] ')).toBe(true);
    expect(await run('isJson', 'Created!')).toBe(false);
    expect(await run('isJson', '')).toBe(false);
    expect(await run('isJson', '   ')).toBe(false);
  });

  test('sanitizeRule keeps known fields, trims the URL and fills id and name', async () => {
    const out = await run('sanitizeRule', {
      enabled: false,
      method: 'POST',
      url: '  /api/users*  ',
      junk: 'x',
      response: { status: 201, headers: [{ name: 'A', value: '1', extra: 1 }], body: 'b', delay: 5, more: 1 },
    });
    expect(out).toEqual({
      id: expect.any(String),
      enabled: false,
      name: 'users',
      method: 'POST',
      url: '/api/users*',
      response: { status: 201, headers: [{ name: 'A', value: '1' }], body: 'b', delay: 5 },
    });
  });
});
