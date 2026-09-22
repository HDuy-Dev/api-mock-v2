const { test, expect } = require('./fixtures');
const { rule, pushRules } = require('./helpers');

async function openWithRules({ context, server }, rules) {
  server.requests.length = 0;
  const page = await context.newPage();
  await page.goto(server.origin + '/');
  await pushRules(page, rules);
  return page;
}

// Runs one async XHR in the page and reports everything the page can observe.
const runXhr = (page, { method = 'GET', url, responseType = '' }) =>
  page.evaluate(
    ([m, u, rt]) =>
      new Promise((resolve) => {
        const x = new XMLHttpRequest();
        const events = [];
        for (const t of ['readystatechange', 'loadstart', 'progress', 'load', 'loadend', 'abort', 'error']) {
          x.addEventListener(t, () => events.push(`${t}:${x.readyState}`));
        }
        x.open(m, u);
        if (rt) x.responseType = rt;
        x.onloadend = () => {
          let text;
          try {
            text = x.responseText;
          } catch (e) {
            text = 'THROWS ' + e.name;
          }
          const r = x.response;
          resolve({
            events,
            status: x.status,
            statusText: x.statusText,
            readyState: x.readyState,
            responseURL: x.responseURL,
            text,
            kind: r === null ? 'null' : Object.prototype.toString.call(r),
            json: rt === 'json' ? r : undefined,
            blobSize: r instanceof Blob ? r.size : undefined,
            blobType: r instanceof Blob ? r.type : undefined,
            bytes: r instanceof ArrayBuffer ? r.byteLength : undefined,
            contentType: x.getResponseHeader('content-type'),
            xa: x.getResponseHeader('X-A'),
            all: x.getAllResponseHeaders(),
          });
        };
        x.send();
      }),
    [method, url, responseType],
  );

test.describe('engine: XMLHttpRequest', () => {
  test('a matching request is answered without touching the network', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked' })]);
    const out = await runXhr(page, { url: '/mocked' });
    expect(out).toMatchObject({
      status: 200,
      statusText: 'OK',
      readyState: 4,
      text: '{"mocked":true}',
      responseURL: server.origin + '/mocked',
    });
    expect(server.requests.some((r) => r.includes('/mocked'))).toBe(false);
  });

  test('a non-matching request goes to the server untouched', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked' })]);
    const out = await runXhr(page, { url: '/api/other' });
    expect(out.text).toContain('"source":"server"');
    expect(server.requests).toContain('GET /api/other');
  });

  test('event order matches a real request', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked' })]);
    const out = await runXhr(page, { url: '/mocked' });
    expect(out.events).toEqual([
      'readystatechange:1',
      'loadstart:1',
      'readystatechange:2',
      'readystatechange:3',
      'progress:3',
      'readystatechange:4',
      'load:4',
      'loadend:4',
    ]);
  });

  test('responseType: text, json, arraybuffer and blob', async ({ context, server }) => {
    const body = '{"a":"é"}'; // 10 bytes in UTF-8
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked', response: { body } })]);

    const text = await runXhr(page, { url: '/mocked' });
    expect([text.text, text.kind]).toEqual([body, '[object String]']);

    const json = await runXhr(page, { url: '/mocked', responseType: 'json' });
    expect(json.json).toEqual({ a: 'é' });
    expect(json.text).toBe('THROWS InvalidStateError');

    const buf = await runXhr(page, { url: '/mocked', responseType: 'arraybuffer' });
    expect([buf.kind, buf.bytes]).toEqual(['[object ArrayBuffer]', 10]);

    const blob = await runXhr(page, { url: '/mocked', responseType: 'blob' });
    expect([blob.blobSize, blob.blobType]).toEqual([10, 'application/json']);
  });

  test('response headers are readable, case-insensitively, and only after headers are received', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [
      rule({
        url: '/mocked',
        response: { headers: [{ name: 'X-A', value: '1' }, { name: 'Content-Type', value: 'text/plain' }] },
      }),
    ]);
    const out = await runXhr(page, { url: '/mocked' });
    expect(out.xa).toBe('1');
    expect(out.contentType).toBe('text/plain');
    expect(out.all).toContain('x-a: 1\r\n');
    expect(out.all).toContain('content-type: text/plain\r\n');

    const early = await page.evaluate(() => {
      const x = new XMLHttpRequest();
      x.open('GET', '/mocked');
      x.send();
      return [x.getResponseHeader('x-a'), x.getAllResponseHeaders(), x.readyState, x.status];
    });
    expect(early).toEqual([null, '', 1, 0]);
  });

  test('on* handler properties fire for synthetic events (spec assumption 6)', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked' })]);
    const seen = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const x = new XMLHttpRequest();
          const log = [];
          x.onreadystatechange = () => log.push('rs' + x.readyState);
          x.onload = () => log.push('load');
          x.onloadend = () => resolve(log);
          x.open('GET', '/mocked');
          x.send();
        }),
    );
    expect(seen).toEqual(['rs1', 'rs2', 'rs3', 'rs4', 'load']);
  });

  test('delay: only loadstart fires before it elapses', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked', response: { delay: 300 } })]);
    const out = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const x = new XMLHttpRequest();
          const events = [];
          for (const t of ['readystatechange', 'loadstart', 'loadend']) x.addEventListener(t, () => events.push(`${t}:${x.readyState}`));
          const t0 = performance.now();
          let early;
          x.open('GET', '/mocked');
          x.send();
          setTimeout(() => (early = [...events]), 100);
          x.onloadend = () => resolve({ early, elapsed: performance.now() - t0 });
        }),
    );
    expect(out.early).toEqual(['readystatechange:1', 'loadstart:1']);
    expect(out.elapsed).toBeGreaterThanOrEqual(250);
  });

  test('abort() during the delay cancels the mock', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked', response: { delay: 200 } })]);
    const out = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const x = new XMLHttpRequest();
          const events = [];
          for (const t of ['readystatechange', 'loadstart', 'load', 'loadend', 'abort']) x.addEventListener(t, () => events.push(`${t}:${x.readyState}`));
          x.open('GET', '/mocked');
          x.send();
          setTimeout(() => x.abort(), 50);
          setTimeout(() => resolve({ events, readyState: x.readyState, status: x.status }), 400);
        }),
    );
    expect(out.events).toEqual(['readystatechange:1', 'loadstart:1', 'readystatechange:4', 'abort:4', 'loadend:4']);
    expect(out.readyState).toBe(0);
    expect(out.status).toBe(0);
  });

  test('keeps native identity: instanceof, constants, prototype and upload', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, []);
    const out = await page.evaluate(() => {
      const x = new XMLHttpRequest();
      return {
        instance: x instanceof XMLHttpRequest,
        done: XMLHttpRequest.DONE,
        proto: Object.getPrototypeOf(x) === XMLHttpRequest.prototype,
        sendLength: XMLHttpRequest.prototype.send.length,
        openLength: XMLHttpRequest.prototype.open.length,
        upload: typeof x.upload,
      };
    });
    expect(out).toEqual({ instance: true, done: 4, proto: true, sendLength: 0, openLength: 2, upload: 'object' });
  });

  test('re-opening the same instance for a non-matching URL uses the network again', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked' })]);
    const seq = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const x = new XMLHttpRequest();
          const texts = [];
          x.onloadend = () => {
            texts.push(x.responseText);
            if (texts.length === 1) {
              x.open('GET', '/api/other');
              x.send();
            } else {
              resolve(texts);
            }
          };
          x.open('GET', '/mocked');
          x.send();
        }),
    );
    expect(seq[0]).toBe('{"mocked":true}');
    expect(seq[1]).toContain('"source":"server"');
  });

  test('synchronous XHR returns at once, ignores the delay and fires no events', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked', response: { delay: 500 } })]);
    const out = await page.evaluate(() => {
      const x = new XMLHttpRequest();
      x.open('GET', '/mocked', false);
      const t0 = performance.now();
      x.send();
      return { status: x.status, text: x.responseText, readyState: x.readyState, elapsed: performance.now() - t0 };
    });
    expect(out).toMatchObject({ status: 200, text: '{"mocked":true}', readyState: 4 });
    expect(out.elapsed).toBeLessThan(200);
  });

  test('open(method, url, undefined) is asynchronous, as in browsers', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked' })]);
    const readyState = await page.evaluate(() => {
      const x = new XMLHttpRequest();
      x.open('GET', '/mocked', undefined);
      x.send();
      return x.readyState;
    });
    expect(readyState).toBe(1);
  });

  test('send() twice on a mocked request throws InvalidStateError', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked', response: { delay: 100 } })]);
    const name = await page.evaluate(() => {
      const x = new XMLHttpRequest();
      x.open('GET', '/mocked');
      x.send();
      try {
        x.send();
        return 'no error';
      } catch (e) {
        return e.name;
      }
    });
    expect(name).toBe('InvalidStateError');
  });

  test('emits a MOCK_EVENT for a mocked XHR', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ id: 'x1', url: '/mocked', response: { status: 203 } })]);
    await page.evaluate(() => {
      window.__events = [];
      window.addEventListener('message', (e) => {
        if (e.data && e.data.type === '__API_MOCK__/MOCK_EVENT') window.__events.push(e.data);
      });
    });
    await runXhr(page, { url: '/mocked' });
    const ev = await page.evaluate(() => window.__events[0]);
    expect(ev).toMatchObject({ ruleId: 'x1', method: 'GET', status: 203, url: server.origin + '/mocked' });
  });
});
