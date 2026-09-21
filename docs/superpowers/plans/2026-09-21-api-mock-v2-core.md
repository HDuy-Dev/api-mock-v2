# API Mock v2 — Core Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the mocking pipeline of the Chrome MV3 extension "API Mock v2": an in-page engine that answers matching `fetch`/`XMLHttpRequest` calls with user-defined responses, the bridge that feeds it, and the service worker that owns state, log, counters and badge. No UI yet: rules are seeded through `chrome.storage.local`.

**Architecture:** `engine.js` (MAIN world) patches `fetch` and `XMLHttpRequest.prototype` and matches rules synchronously from an in-memory copy. `bridge.js` (ISOLATED world) pushes enabled rules from storage into the engine and forwards sanitized engine events to `background.js` (ES-module service worker), which owns state, hits, per-tab log and counters, icon and badge. Everything is verified end-to-end with Playwright driving real Chromium with the unpacked extension.

**Tech Stack:** Vanilla JS (no build step, no bundler), Chrome MV3, `@playwright/test` (Chromium only), Node 18+ for the test tooling.

**Spec:** [`../specs/2026-09-21-api-mock-v2-design.md`](../specs/2026-09-21-api-mock-v2-design.md) (architecture, data model, engine, security, tests) and [`../specs/2026-09-21-api-mock-v2-ui-design.md`](../specs/2026-09-21-api-mock-v2-ui-design.md) (badge and tooltip rules, section 5). Plan 2 (`2026-09-21-api-mock-v2-ui.md`) builds the panel and popup on top of this plan's result.

## Global Constraints

Copied from the spec. Every task's requirements implicitly include this section.

- Chrome Manifest V3, `minimum_chrome_version: "111"`; the engine is a content script with `world: "MAIN"`, `run_at: "document_start"`, `all_frames: true`.
- Permissions: `storage` only. Do **not** add `tabs` or `host_permissions`. If a test proves one is required, stop, report it, and change the spec before changing the manifest.
- No build step, no bundler, vanilla JS. `engine.js` and `bridge.js` are classic scripts (no `import`/`export`). `background.js` is an ES module (`"type": "module"`). `shared/` is used only by the service worker, popup and panel.
- Flat structure; inside files use banner comments `// ── Section ──`.
- The engine is **silent**: no `console.*`, no DOM changes, and no enumerable globals (the only marker allowed on `window` is a non-enumerable `Symbol.for('api-mock-v2.engine')` install guard). It is **fail-open**: any internal error lets the request run natively. It never rebuilds a `Request` from the `fetch` input.
- Engine ↔ bridge messages use `window.postMessage` with `type` starting with `__API_MOCK__/`. The engine's `RULES` listener is the first `message` listener on `window` and calls `stopImmediatePropagation()` for `RULES`.
- Storage keys: `state` and `hits` in `storage.local`; `log:<tabId>` and `tab:<tabId>` in `storage.session`.
- Rule limits: `status` integer 200–599; `delay` integer 0–60000 ms; `url` non-empty, at most 2048 characters; header names match `^[!#$%&'*+.^_`|~0-9A-Za-z-]+$`.
- Startup: the engine holds requests for at most 1 second waiting for the first `RULES`, then fails open and reports `RULES_UNAVAILABLE`. Synchronous XHR never waits.
- Log: at most 200 entries per tab, oldest dropped first. Hits are flushed with a ~1 s debounce, log and counters with a ~200 ms debounce.
- Tests run in **Chromium via Playwright** (`channel: 'chromium'`), never Google Chrome (it ignores `--load-extension`).
- UI strings are English.
- Git: commit after each task using the repo-local identity that is already configured. **Never push**; the user pushes.

## File Structure

```
api-mock-v2/
├── manifest.json               # Task 1
├── engine.js                   # Tasks 3–6   MAIN world: patch fetch/XHR
├── bridge.js                   # Task 7      ISOLATED: storage ⇄ engine, events → service worker, PING
├── background.js               # Tasks 8–10  service worker (ES module)
├── shared/
│   ├── rule.js                 # Task 2      schema, validate, headers, helpers
│   └── status.js               # Task 10     computeBadge (Plan 2 adds computePopupStatus)
├── popup/popup.html            # Task 1      placeholder; Plan 2 replaces it
├── package.json                # Task 1
├── playwright.config.js        # Task 1
└── test/
    ├── server.js               # Task 1      local HTTP server with a /reflect endpoint
    ├── fixtures.js             # Task 1      Chromium + extension fixtures
    ├── helpers.js              # Task 1      rule(), setState(), pushRules(), openExtensionPage()
    ├── smoke.spec.js           # Task 1
    ├── rule.spec.js            # Task 2
    ├── engine-fetch.spec.js    # Tasks 3–4
    ├── engine-xhr.spec.js      # Task 5
    ├── engine-safety.spec.js   # Task 6
    ├── bridge.spec.js          # Task 7
    ├── sw-state.spec.js        # Task 8
    ├── sw-events.spec.js       # Task 9
    └── badge.spec.js           # Task 10
```

## Spec assumptions verified by this plan

The spec (section 11) lists assumptions that were never tested. Each is checked by a test below; **if one fails, stop and report — do not work around it silently.**

| # | Assumption | Verified in |
|---|---|---|
| 1 | Only `storage` is needed; `sender.tab.id`, `tabs.onRemoved`, `tabs.query` work without `tabs` | Tasks 1, 7, 9 |
| 2 | First listener + `stopImmediatePropagation()` hides `RULES` from page scripts | Task 6 |
| 3 | Engine is ready before the page's first script; bridge → engine channel works at `document_start` | Task 7 |
| 5 | `Object.defineProperty(response, 'url', …)` works | Task 3 |
| 6 | Synthetic XHR events fire `on*` handler properties | Task 5 |
| 7 | Chrome 111+ supports `world: "MAIN"` | Task 1 |
| 8 | `tabs.sendMessage` to a tab and `setBadgeTextColor` work without `tabs` | Tasks 7, 10 |

(Assumption 4, `storage.session` in panel/popup, belongs to Plan 2.)

---

### Task 1: Scaffold, test harness and smoke tests

**Files:**
- Create: `package.json`, `playwright.config.js`, `manifest.json`, `engine.js`, `bridge.js`, `background.js`, `popup/popup.html`
- Create: `test/server.js`, `test/fixtures.js`, `test/helpers.js`, `test/smoke.spec.js`
- Modify: `.gitignore`

**Interfaces:**
- Produces (used by every later test):
  - `test/fixtures.js` exports `{ test, expect }`. `test` adds fixtures `server` (`{ origin: string, requests: string[], close(): Promise<void> }`), `context` (persistent Chromium context with the extension), `serviceWorker` (Playwright `Worker`), `extensionId` (string).
  - `test/helpers.js` exports `rule(overrides?) → Rule`, `setState(serviceWorker, { globalEnabled?, rules? }) → Promise<void>`, `pushRules(page, rules) → Promise<void>` (posts `RULES` straight to the engine, bypassing the bridge), `openExtensionPage(context, extensionId, path?) → Promise<Page>`.
  - `test/server.js`: `GET /` (blank page), `GET /startup-race.html` (fires `fetch('/mocked-early')` from an inline `<script>` in `<head>` and stores the promise in `window.__early`), `GET /reflect?status=&h=name:value&body=` (returns exactly that), any other path returns `{"source":"server",…}` with header `x-source: server`. Every request is appended to `server.requests` as `"METHOD /path?query"`.

- [ ] **Step 1: Create `package.json` and install**

```json
{
  "name": "api-mock-v2",
  "private": true,
  "version": "0.1.0",
  "description": "Chrome MV3 extension that answers fetch/XHR requests with user-defined responses",
  "scripts": {
    "test": "playwright test",
    "test:headed": "HEADED=1 playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0"
  }
}
```

Run:
```bash
npm install
npx playwright install chromium
```
Expected: `node_modules/` created; Chromium downloaded.

- [ ] **Step 2: Append to `.gitignore`**

The file currently contains `.superpowers/`. Make it:
```
.superpowers/
node_modules/
test-results/
playwright-report/
```

- [ ] **Step 3: Create `playwright.config.js`**

```js
// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test',
  testMatch: /.*\.spec\.js/,
  timeout: 30_000,
  workers: 1, // every test launches its own Chromium profile; keep resource use predictable
  fullyParallel: false,
  reporter: [['list']],
});
```

- [ ] **Step 4: Create `test/server.js`**

```js
const http = require('node:http');

const STARTUP_RACE_HTML = `<!doctype html>
<html><head><title>startup race</title>
<script>
  // Runs before any other page script; must already be answered by the mock.
  window.__early = fetch('/mocked-early').then((r) => r.text()).catch((e) => 'ERR ' + e);
</script></head><body>ok</body></html>`;

function send(res, status, headers, body) {
  const nullBody = status === 204 || status === 205 || status === 304;
  res.writeHead(status, { 'access-control-allow-origin': '*', ...headers });
  res.end(nullBody ? undefined : body);
}

function startServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(`${req.method} ${url.pathname}${url.search}`);

    if (url.pathname === '/') {
      return send(res, 200, { 'content-type': 'text/html' }, '<!doctype html><title>test</title><body>ok</body>');
    }
    if (url.pathname === '/startup-race.html') {
      return send(res, 200, { 'content-type': 'text/html' }, STARTUP_RACE_HTML);
    }
    if (url.pathname === '/reflect') {
      // Returns exactly what the query asks for: ?status=418&h=x-a:1&h=content-type:text/plain&body=hi
      const status = Number(url.searchParams.get('status') || 200);
      const headers = {};
      for (const h of url.searchParams.getAll('h')) {
        const i = h.indexOf(':');
        headers[h.slice(0, i)] = h.slice(i + 1);
      }
      return send(res, status, headers, url.searchParams.get('body') ?? '');
    }
    return send(
      res,
      200,
      { 'content-type': 'application/json', 'x-source': 'server' },
      JSON.stringify({ source: 'server', method: req.method, path: url.pathname, query: url.search }),
    );
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => {
          server.closeAllConnections?.();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

module.exports = { startServer };
```

- [ ] **Step 5: Create `test/fixtures.js`**

```js
const { test: base, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./server');

const EXTENSION_PATH = path.resolve(__dirname, '..');

const test = base.extend({
  server: [
    async ({}, use) => {
      const s = await startServer();
      await use(s);
      await s.close();
    },
    { scope: 'worker' },
  ],

  // A fresh profile per test: no state leaks between tests.
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-mock-v2-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium', // new headless mode, required for extensions
      headless: !process.env.HEADED,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
});

module.exports = { test, expect };
```

- [ ] **Step 6: Create `test/helpers.js`**

```js
let seq = 0;

/** Builds a valid Rule; override any field. `response` is merged, not replaced. */
function rule(overrides = {}) {
  seq += 1;
  const { response, ...rest } = overrides;
  return {
    id: `r${seq}`,
    enabled: true,
    name: `Rule ${seq}`,
    method: 'ANY',
    url: '/mocked',
    ...rest,
    response: { status: 200, headers: [], body: '{"mocked":true}', delay: 0, ...(response || {}) },
  };
}

/** Writes the extension state through the service worker (the bridge then pushes it to pages). */
async function setState(serviceWorker, { globalEnabled = true, rules = [] } = {}) {
  await serviceWorker.evaluate((state) => chrome.storage.local.set({ state }), { version: 1, globalEnabled, rules });
}

/** Engine-only tests: post RULES straight into the page, bypassing bridge and storage. */
async function pushRules(page, rules) {
  const payload = rules.map(({ id, method, url, response }) => ({ id, method, url, response }));
  await page.evaluate(async (r) => {
    window.postMessage({ type: '__API_MOCK__/RULES', rules: r }, '*');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }, payload);
}

async function openExtensionPage(context, extensionId, pagePath = 'popup/popup.html') {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${pagePath}`);
  return page;
}

module.exports = { rule, setState, pushRules, openExtensionPage };
```

- [ ] **Step 7: Write the failing smoke test `test/smoke.spec.js`**

```js
const { test, expect } = require('./fixtures');
const { openExtensionPage } = require('./helpers');

test('extension loads with a running service worker and the minimal manifest', async ({ extensionId, serviceWorker }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(['storage']);
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.minimum_chrome_version).toBe('111');
});

test('engine content script runs in the MAIN world of a plain http page (spec assumptions 1 and 7)', async ({ context, server }) => {
  const page = await context.newPage();
  await page.goto(server.origin + '/');
  expect(await page.evaluate(() => window.__ENGINE_STUB__)).toBe(true);
});

test('bridge content script (ISOLATED world) can message extension pages', async ({ context, server, extensionId }) => {
  const ext = await openExtensionPage(context, extensionId);
  await ext.evaluate(() => {
    window.__msgs = [];
    chrome.runtime.onMessage.addListener((msg) => {
      window.__msgs.push(msg);
    });
  });
  const page = await context.newPage();
  await page.goto(server.origin + '/');
  await expect.poll(() => ext.evaluate(() => window.__msgs.map((m) => m.type))).toContain('BRIDGE_STUB');
});
```

- [ ] **Step 8: Run to verify it fails**

Run: `npx playwright test test/smoke.spec.js`
Expected: FAIL — the extension has no `manifest.json` yet, so no service worker appears (timeout waiting for `serviceworker`).

- [ ] **Step 9: Create the extension skeleton**

`manifest.json`:
```json
{
  "manifest_version": 3,
  "name": "API Mock v2",
  "version": "0.1.0",
  "description": "Intercept fetch/XHR and answer with your own response.",
  "minimum_chrome_version": "111",
  "permissions": ["storage"],
  "action": { "default_popup": "popup/popup.html", "default_title": "API Mock" },
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    { "matches": ["<all_urls>"], "js": ["engine.js"], "run_at": "document_start", "world": "MAIN", "all_frames": true },
    { "matches": ["<all_urls>"], "js": ["bridge.js"], "run_at": "document_start", "all_frames": true }
  ]
}
```

`engine.js` (temporary stub, replaced in Task 3):
```js
window.__ENGINE_STUB__ = true;
```

`bridge.js` (temporary stub, replaced in Task 7):
```js
chrome.runtime.sendMessage({ type: 'BRIDGE_STUB' }).catch(() => {});
```

`background.js` (grows in Tasks 8–10):
```js
// Service worker. Filled in by Tasks 8–10.
export {};
```

`popup/popup.html` (placeholder; Plan 2 replaces it, tests use it as a generic extension page):
```html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>API Mock</title></head>
  <body><p>API Mock</p></body>
</html>
```

- [ ] **Step 10: Run to verify it passes**

Run: `npx playwright test test/smoke.spec.js`
Expected: PASS (3 tests). If test 2 fails, **assumption 1 or 7 is wrong**: stop and report.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold extension, e2e harness and smoke tests"
```

---

### Task 2: `shared/rule.js` — schema, validation, header parsing

**Files:**
- Create: `shared/rule.js`
- Test: `test/rule.spec.js`

**Interfaces:**
- Consumes: `openExtensionPage` (Task 1).
- Produces (ES module `shared/rule.js`, used by `background.js` in Tasks 8–9 and by Plan 2):
  - `METHODS: string[]`, `LIMITS: { urlMax, statusMin, statusMax, delayMax }`
  - `uid(): string`
  - `defaultState(): { version: 1, globalEnabled: true, rules: [] }`
  - `defaultName(url: string): string`
  - `newRule(overrides?): Rule` — `Rule = { id, enabled, name, method, url, response: { status, headers: {name,value}[], body, delay } }`
  - `validateRule(rule): { ok: boolean, errors: { method?, url?, status?, delay?, body?, headers?, response?, rule? } }` (error strings exactly as in the UI doc: `URL is required`, `Must be 200–599`, `Must be 0–60000`)
  - `sanitizeRule(rule): Rule` — call only on a valid rule; keeps known fields only, trims URL, fills `id` and `name`
  - `parseHeaders(text): { headers: {name,value}[], error: string | null }` (`Line N: invalid header name`)
  - `stringifyHeaders(headers): string`
  - `isJson(text): boolean`

- [ ] **Step 1: Write the failing test `test/rule.spec.js`**

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test test/rule.spec.js`
Expected: FAIL — importing `/shared/rule.js` fails (file missing).

- [ ] **Step 3: Implement `shared/rule.js`**

```js
// Shared by the service worker, popup and panel. Pure functions, no chrome.* calls.

// ── Constants ──────────────────────────────────────────────────────────────
export const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const LIMITS = { urlMax: 2048, statusMin: 200, statusMax: 599, delayMax: 60000 };
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// ── Helpers ────────────────────────────────────────────────────────────────
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function defaultState() {
  return { version: 1, globalEnabled: true, rules: [] };
}

export function defaultName(url) {
  const path = String(url || '').split(/[?#]/)[0];
  const segments = path.split('/').filter((s) => s && s !== '*');
  const last = (segments.pop() || '').replace(/\*+$/, '');
  return last || 'New rule';
}

export function newRule(overrides = {}) {
  return {
    id: uid(),
    enabled: true,
    name: '',
    method: 'GET',
    url: '',
    ...overrides,
    response: { status: 200, headers: [], body: '{\n  \n}', delay: 0, ...(overrides.response || {}) },
  };
}

export function isJson(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// ── Headers ("Key: Value" lines ⇄ [{ name, value }]) ───────────────────────
export function parseHeaders(text) {
  const headers = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon).trim() : '';
    if (!name || !HEADER_NAME_RE.test(name)) return { headers, error: `Line ${i + 1}: invalid header name` };
    headers.push({ name, value: line.slice(colon + 1).trim() });
  }
  return { headers, error: null };
}

export function stringifyHeaders(headers) {
  return (headers || []).map((h) => `${h.name}: ${h.value}`).join('\n');
}

// ── Validation ─────────────────────────────────────────────────────────────
export function validateRule(rule) {
  const errors = {};
  if (!rule || typeof rule !== 'object') return { ok: false, errors: { rule: 'Invalid rule' } };

  if (!METHODS.includes(rule.method)) errors.method = 'Invalid method';

  const url = typeof rule.url === 'string' ? rule.url.trim() : '';
  if (!url) errors.url = 'URL is required';
  else if (url.length > LIMITS.urlMax) errors.url = `URL is too long (max ${LIMITS.urlMax})`;

  const r = rule.response;
  if (!r || typeof r !== 'object') {
    errors.response = 'Invalid response';
    return { ok: false, errors };
  }
  if (!Number.isInteger(r.status) || r.status < LIMITS.statusMin || r.status > LIMITS.statusMax) errors.status = 'Must be 200–599';
  if (!Number.isInteger(r.delay) || r.delay < 0 || r.delay > LIMITS.delayMax) errors.delay = 'Must be 0–60000';
  if (typeof r.body !== 'string') errors.body = 'Body must be text';
  if (!Array.isArray(r.headers)) {
    errors.headers = 'Invalid headers';
  } else {
    const bad = r.headers.findIndex(
      (h) => !h || typeof h.name !== 'string' || !HEADER_NAME_RE.test(h.name) || typeof h.value !== 'string',
    );
    if (bad >= 0) errors.headers = `Header ${bad + 1}: invalid header`;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

// Call only on a rule that passed validateRule.
export function sanitizeRule(rule) {
  const url = rule.url.trim();
  return {
    id: rule.id || uid(),
    enabled: rule.enabled !== false,
    name: String(rule.name || '').trim() || defaultName(url),
    method: rule.method,
    url,
    response: {
      status: rule.response.status,
      headers: rule.response.headers.map((h) => ({ name: h.name, value: h.value })),
      body: rule.response.body,
      delay: rule.response.delay,
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx playwright test test/rule.spec.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/rule.js test/rule.spec.js
git commit -m "feat: add shared rule schema, validation and header parsing"
```

---

### Task 3: Engine core — rule intake, URL matching, basic `fetch` mock

**Files:**
- Replace: `engine.js` (the Task 1 stub)
- Create: `test/engine-fetch.spec.js`
- Modify: `test/smoke.spec.js` (test 2 stops relying on the stub marker)

**Interfaces:**
- Consumes: `rule()`, `pushRules()` (Task 1).
- Produces (message contract that the bridge in Task 7 and every later engine task rely on):
  - **In:** `window.postMessage({ type: '__API_MOCK__/RULES', rules: EngineRule[] }, '*')`, where `EngineRule = { id, method, url, response: { status, headers: {name,value}[], body, delay } }`.
  - **Out:** `window.postMessage({ type: '__API_MOCK__/MOCK_EVENT', ruleId, url, method, status, ts }, '*')` — `url` is the absolute URL without fragment, `method` upper-case.
  - Inside `engine.js` (later tasks edit these by name): `NS`, `state = { rules, rulesLoaded }`, `emit(kind, data)`, `normalizeUrl(input)`, `requestInfo(rawUrl, method)`, `compileRule(rule)`, `matchRequest(info)`, `loadRules(rawRules)`, `fetchInfo(input, init)`, `mockFetch(rule, info)`, and the patched `window.fetch`.
- Matching semantics (spec 4.2): `*` = any characters, other regex characters are literal; a pattern without `?` is compared against the URL without its query, with `?` against the full URL; a pattern starting with `/` compares only the path (plus query if the pattern has `?`) on **any origin**; the first matching rule in list order wins; `method: 'ANY'` matches every method.

- [ ] **Step 1: Write the failing test `test/engine-fetch.spec.js`**

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test test/engine-fetch.spec.js`
Expected: FAIL — the engine is still the Task 1 stub, so `fetch('/mocked')` reaches the real server (mocked assertions fail).

- [ ] **Step 3: Implement `engine.js`**

```js
// Runs in the page's MAIN world at document_start. Classic script: no import/export.
// Silent (no console, no DOM), fail-open, and it exposes nothing on `window`
// except a non-enumerable install guard.
(() => {
  'use strict';

  // ── Setup ────────────────────────────────────────────────────────────────
  const GUARD = Symbol.for('api-mock-v2.engine');
  if (Object.prototype.hasOwnProperty.call(window, GUARD)) return;
  Object.defineProperty(window, GUARD, { value: true });

  const NS = '__API_MOCK__/';
  const nativeFetch = window.fetch;
  const state = { rules: [], rulesLoaded: false };

  // ── Reporting ────────────────────────────────────────────────────────────
  function emit(kind, data) {
    try {
      window.postMessage({ type: NS + kind, ts: Date.now(), ...data }, '*');
    } catch (_) {
      // Reporting must never break the page.
    }
  }

  // ── Rules: normalize, compile, match ─────────────────────────────────────
  function normalizeUrl(input) {
    const u = new URL(String(input), document.baseURI);
    u.hash = '';
    return u;
  }

  function wildcardToRegExp(pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$');
  }

  function requestInfo(rawUrl, method) {
    const u = normalizeUrl(rawUrl);
    return {
      method: String(method || 'GET').toUpperCase(),
      href: u.href,
      hrefNoQuery: u.href.split('?')[0],
      pathname: u.pathname,
      search: u.search,
    };
  }

  function compileRule(rule) {
    const pattern = String(rule.url);
    const pathOnly = pattern.startsWith('/');
    const hasQuery = pattern.includes('?');
    const re = wildcardToRegExp(pattern);
    const method = String(rule.method).toUpperCase();
    return {
      id: rule.id,
      response: rule.response,
      test(info) {
        if (method !== 'ANY' && method !== info.method) return false;
        const target = pathOnly
          ? hasQuery ? info.pathname + info.search : info.pathname
          : hasQuery ? info.href : info.hrefNoQuery;
        return re.test(target);
      },
    };
  }

  function matchRequest(info) {
    for (const r of state.rules) if (r.test(info)) return r;
    return null;
  }

  function loadRules(rawRules) {
    const compiled = [];
    for (const r of Array.isArray(rawRules) ? rawRules : []) {
      try {
        compiled.push(compileRule(r));
      } catch (_) {
        // A rule that cannot be compiled is skipped (Task 6 adds ENGINE_ERROR reporting).
      }
    }
    state.rules = compiled;
    state.rulesLoaded = true;
  }

  // ── Intake: RULES pushed by the bridge ───────────────────────────────────
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.type !== NS + 'RULES') return;
    loadRules(d.rules);
  });

  // ── fetch ────────────────────────────────────────────────────────────────
  function fetchInfo(input, init) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const rawUrl = isRequest ? input.url : String(input);
    const method = (init && init.method) || (isRequest ? input.method : 'GET');
    return requestInfo(rawUrl, method);
  }

  function mockFetch(rule, info) {
    emit('MOCK_EVENT', { ruleId: rule.id, url: info.href, method: info.method, status: rule.response.status });
    return Promise.resolve(new Response(rule.response.body, { status: rule.response.status }));
  }

  // Declared as an object method so `fetch.name === 'fetch'` and `fetch.length === 1`, like the native one.
  window.fetch = {
    fetch: function fetch(input) {
      const init = arguments[1];
      let rule = null;
      let info = null;
      try {
        info = fetchInfo(input, init);
        rule = matchRequest(info);
      } catch (_) {
        rule = null;
      }
      if (!rule) return Reflect.apply(nativeFetch, this, arguments);
      return mockFetch(rule, info);
    },
  }.fetch;
})();
```

- [ ] **Step 4: Update `test/smoke.spec.js` test 2**

Change the first line to `const { openExtensionPage, rule, pushRules } = require('./helpers');` and replace the second test with:

```js
test('engine content script runs in the MAIN world of a plain http page (spec assumptions 1 and 7)', async ({ context, server }) => {
  const page = await context.newPage();
  await page.goto(server.origin + '/');
  await pushRules(page, [rule({ url: '/mocked' })]);
  expect(await page.evaluate(() => fetch('/mocked').then((r) => r.text()))).toBe('{"mocked":true}');
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx playwright test test/engine-fetch.spec.js test/smoke.spec.js`
Expected: PASS (12 + 3 tests).

- [ ] **Step 6: Commit**

```bash
git add engine.js test/engine-fetch.spec.js test/smoke.spec.js
git commit -m "feat(engine): rule intake, URL matching and basic fetch mocking"
```

---

### Task 4: Engine — faithful `fetch` responses

**Files:**
- Modify: `engine.js`
- Modify: `test/engine-fetch.spec.js` (append a new `describe`)

**Interfaces:**
- Consumes: Task 3's `compileRule`, `fetchInfo`, `mockFetch`, `emit`, the `RULES` contract.
- Produces (used by Task 5 and Task 6):
  - `compileRule(rule)` now returns `{ id, response: CompiledResponse, test }` with `CompiledResponse = { status, statusText, body: string | null, headers: [name, value][], delay }`. `body` is `null` for status 204/205/304. If the browser would reject the response (for example `status: 700`), `compileRule` throws and `loadRules` skips the rule.
  - `buildResponse(compiled, url): Response` — sets `Response.url` to `url`.
  - `fetchInfo(input, init)` now also returns `signal` (from `init.signal` or the `Request`).
- Known, accepted difference: a constructed `Response` has `type === 'default'` (a real same-origin one has `'basic'`). The conformance test does not compare `type`.

- [ ] **Step 1: Append the failing tests to `test/engine-fetch.spec.js`**

```js
test.describe('engine: faithful fetch responses', () => {
  test('status, statusText, ok, headers and body', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [
      rule({ url: '/mocked', response: { status: 404, headers: [{ name: 'X-A', value: '1' }], body: 'nope' } }),
    ]);
    const out = await page.evaluate(async () => {
      const r = await fetch('/mocked');
      return { status: r.status, ok: r.ok, statusText: r.statusText, xa: r.headers.get('x-a'), text: await r.text() };
    });
    expect(out).toEqual({ status: 404, ok: false, statusText: 'Not Found', xa: '1', text: 'nope' });
  });

  test('Content-Type: the user header wins, otherwise JSON bodies get application/json', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [
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

  test('response.url is the absolute request URL (spec assumption 5)', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked' })]);
    const url = await page.evaluate(() => fetch('/mocked?x=1#frag').then((r) => r.url));
    expect(url).toBe(server.origin + '/mocked?x=1');
  });

  for (const status of [204, 205, 304]) {
    test(`status ${status} is delivered without a body even if the rule has one`, async ({ context, server }) => {
      const page = await openWithRules({ context, server }, [rule({ url: '/mocked', response: { status, body: 'ignored' } })]);
      const out = await page.evaluate(async () => {
        const r = await fetch('/mocked');
        return { status: r.status, text: await r.text() };
      });
      expect(out).toEqual({ status, text: '' });
    });
  }

  test('delay postpones the response', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked', response: { delay: 300 } })]);
    const elapsed = await page.evaluate(async () => {
      const t0 = performance.now();
      await fetch('/mocked');
      return performance.now() - t0;
    });
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });

  test('a mocked fetch can be aborted during its delay, like a real one', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked', response: { delay: 1000 } })]);
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

  test('an already-aborted signal rejects immediately and the abort reason is preserved', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked' })]);
    const out = await page.evaluate(async () => {
      const a = await fetch('/mocked', { signal: AbortSignal.abort() }).then(() => 'resolved', (e) => e.name);
      const ac = new AbortController();
      ac.abort('boom');
      const b = await fetch(new Request('/mocked', { signal: ac.signal })).then(() => 'resolved', (e) => e);
      return [a, b];
    });
    expect(out).toEqual(['AbortError', 'boom']);
  });

  test('a rule the browser would reject (status 700) is skipped and the request passes through', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/bad', response: { status: 700 } })]);
    expect(isMocked(await doFetch(page, '/bad'))).toBe(false);
  });

  test('non-matching requests reach the server untouched (method, body, Request objects)', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, [rule({ url: '/mocked' })]);
    const statuses = await page.evaluate(async () => {
      const a = await fetch('/api/upload', { method: 'POST', body: 'payload', headers: { 'x-t': '1' } });
      const b = await fetch(new Request('/api/req-body', { method: 'PUT', body: 'abc' }));
      return [a.status, b.status];
    });
    expect(statuses).toEqual([200, 200]);
    expect(server.requests).toEqual(expect.arrayContaining(['POST /api/upload', 'PUT /api/req-body']));
  });

  test('the patched fetch keeps the native name and length', async ({ context, server }) => {
    const page = await openWithRules({ context, server }, []);
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

  test('conformance: a mocked response looks like the real one for common cases', async ({ context, server }) => {
    const page = await openWithRules(
      { context, server },
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test test/engine-fetch.spec.js -g "faithful"`
Expected: FAIL — statusText is `''`, no Content-Type inference, `url` is `''`, 204 with a body throws, delay and abort are ignored.

- [ ] **Step 3: Modify `engine.js` — response building**

Insert this block directly above `function compileRule(rule) {`:

```js
  // ── Responses ────────────────────────────────────────────────────────────
  const STATUS_TEXT = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found',
    304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
    500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
  };
  const NULL_BODY_STATUS = new Set([204, 205, 304]);

  function isJsonText(text) {
    if (typeof text !== 'string' || !text.trim()) return false;
    try {
      JSON.parse(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  function buildResponse(c, url) {
    const headers = new Headers();
    for (const [name, value] of c.headers) headers.append(name, value);
    const res = new Response(c.body, { status: c.status, statusText: c.statusText, headers });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  }

  // Precomputed once per rule. Throws if the browser would reject the response.
  function compileResponse(res) {
    const pairs = (res.headers || []).map((h) => [h.name, h.value]);
    const hasContentType = pairs.some(([name]) => name.toLowerCase() === 'content-type');
    if (!hasContentType && isJsonText(res.body)) pairs.push(['Content-Type', 'application/json']);
    const compiled = {
      status: res.status,
      statusText: STATUS_TEXT[res.status] || '',
      body: NULL_BODY_STATUS.has(res.status) ? null : String(res.body),
      headers: pairs,
      delay: Math.max(0, Number(res.delay) || 0),
    };
    buildResponse(compiled, 'http://validate.invalid/');
    return compiled;
  }

```

In `compileRule`, change `response: rule.response,` to:

```js
      response: compileResponse(rule.response),
```

- [ ] **Step 4: Modify `engine.js` — fetch info, delay and abort**

Replace the whole `fetchInfo` and `mockFetch` functions with:

```js
  function fetchInfo(input, init) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const rawUrl = isRequest ? input.url : String(input);
    const method = (init && init.method) || (isRequest ? input.method : 'GET');
    const signal = (init && init.signal) || (isRequest ? input.signal : undefined);
    return { ...requestInfo(rawUrl, method), signal };
  }

  function abortReason(signal) {
    return signal.reason !== undefined ? signal.reason : new DOMException('The user aborted a request.', 'AbortError');
  }

  function mockFetch(rule, info) {
    emit('MOCK_EVENT', { ruleId: rule.id, url: info.href, method: info.method, status: rule.response.status });
    const { signal } = info;
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      let timer = 0;
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(buildResponse(rule.response, info.href));
      }, rule.response.delay);
    });
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx playwright test test/engine-fetch.spec.js`
Expected: PASS (Task 3 tests and the new ones). If the conformance test fails, read the diff it prints: a real difference between mocked and real is a bug in `buildResponse`/`compileResponse`, not a reason to loosen the test (the only accepted difference is `Response.type`, which the test does not compare).

- [ ] **Step 6: Commit**

```bash
git add engine.js test/engine-fetch.spec.js
git commit -m "feat(engine): faithful fetch responses with delay, abort and content-type rules"
```

---

### Task 5: Engine — `XMLHttpRequest`

**Files:**
- Modify: `engine.js` (insert a new section before the final `})();`)
- Create: `test/engine-xhr.spec.js`

**Interfaces:**
- Consumes (Tasks 3–4): `requestInfo`, `matchRequest`, `emit`, and the compiled rule `{ id, response: { status, statusText, body, headers: [name, value][], delay }, test }`.
- Produces (edited again by Task 6): `xhrRequests` and `xhrMocks` (`WeakMap`s), `startMock(xhr, rule, info, isAsync)`, `advance(xhr, m)`, `abortMock(xhr, m)`, `fire(xhr, type, loaded, total)`, and the patched `XMLHttpRequest.prototype.open/send/abort/getResponseHeader/getAllResponseHeaders` plus six patched getters.
- Behaviour (spec section 5): patch the **prototype**, never replace the class. A matching request still calls native `open()` but never native `send()`. Async event order after `send()`: `loadstart` → (delay) → `readyState` 2 → 3 → `progress` → 4 → `load` → `loadend`. `responseType` text/json/arraybuffer/blob is honoured (`document` is not supported and yields `null`). `abort()` during the delay cancels the mock and fires `readystatechange(4)`, `abort`, `loadend`, then `readyState` goes back to 0. Synchronous XHR returns at once, ignores the delay and fires no events.

- [ ] **Step 1: Write the failing test `test/engine-xhr.spec.js`**

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test test/engine-xhr.spec.js`
Expected: FAIL — the native `XMLHttpRequest` reaches the server, so mocked assertions fail.

- [ ] **Step 3: Insert the XHR section in `engine.js`**

Insert immediately before the final `})();`:

```js
  // ── XMLHttpRequest ───────────────────────────────────────────────────────
  // Patched on the prototype so identity (instanceof, constants, prototype chain) stays native.
  // A matching request still calls native open() but never native send().
  const xhrProto = XMLHttpRequest.prototype;
  const nativeXhr = {
    open: xhrProto.open,
    send: xhrProto.send,
    abort: xhrProto.abort,
    getResponseHeader: xhrProto.getResponseHeader,
    getAllResponseHeaders: xhrProto.getAllResponseHeaders,
  };
  const nativeGetters = {};
  for (const key of ['readyState', 'status', 'statusText', 'response', 'responseText', 'responseURL']) {
    nativeGetters[key] = Object.getOwnPropertyDescriptor(xhrProto, key).get;
  }
  const xhrRequests = new WeakMap(); // xhr -> { method, rawUrl, isAsync }
  const xhrMocks = new WeakMap(); // xhr -> mock state (in progress or finished)

  function fire(xhr, type, loaded = 0, total = 0) {
    try {
      const event =
        type === 'readystatechange'
          ? new Event(type)
          : new ProgressEvent(type, { lengthComputable: total > 0, loaded, total });
      xhr.dispatchEvent(event);
    } catch (_) {
      // A throwing page handler must not break the engine.
    }
  }

  function startMock(xhr, rule, info, isAsync) {
    const c = rule.response;
    const headers = new Map();
    for (const [name, value] of c.headers) {
      const key = name.toLowerCase();
      headers.set(key, headers.has(key) ? headers.get(key) + ', ' + value : value);
    }
    const m = {
      rule,
      url: info.href,
      headers,
      responseType: xhr.responseType,
      readyState: 1,
      aborted: false,
      done: false,
      timer: 0,
      cache: undefined,
      size: new TextEncoder().encode(c.body ?? '').length,
    };
    xhrMocks.set(xhr, m);
    emit('MOCK_EVENT', { ruleId: rule.id, url: info.href, method: info.method, status: c.status });
    if (!isAsync) {
      m.readyState = 4;
      m.done = true;
      return;
    }
    fire(xhr, 'loadstart');
    m.timer = setTimeout(() => advance(xhr, m), c.delay);
  }

  function advance(xhr, m) {
    m.readyState = 2;
    fire(xhr, 'readystatechange');
    m.readyState = 3;
    fire(xhr, 'readystatechange');
    fire(xhr, 'progress', m.size, m.size);
    m.readyState = 4;
    m.done = true;
    fire(xhr, 'readystatechange');
    fire(xhr, 'load', m.size, m.size);
    fire(xhr, 'loadend', m.size, m.size);
  }

  function abortMock(xhr, m) {
    if (m.aborted) return;
    clearTimeout(m.timer);
    if (m.done) {
      // Aborting a finished request just resets it.
      m.aborted = true;
      m.readyState = 0;
      return;
    }
    m.aborted = true;
    m.readyState = 4;
    fire(xhr, 'readystatechange');
    fire(xhr, 'abort');
    fire(xhr, 'loadend');
    m.readyState = 0;
  }

  function mockResponse(m) {
    const text = m.rule.response.body ?? '';
    const isText = m.responseType === '' || m.responseType === 'text';
    if (m.readyState !== 4 || m.aborted) return isText ? '' : null;
    if (m.cache === undefined) {
      if (isText) {
        m.cache = text;
      } else if (m.responseType === 'json') {
        try {
          m.cache = JSON.parse(text);
        } catch (_) {
          m.cache = null;
        }
      } else if (m.responseType === 'arraybuffer') {
        m.cache = new TextEncoder().encode(text).buffer;
      } else if (m.responseType === 'blob') {
        m.cache = new Blob([text], { type: m.headers.get('content-type') || '' });
      } else {
        m.cache = null; // 'document' is not supported
      }
    }
    return m.cache;
  }

  const headersVisible = (m) => m.readyState >= 2 && !m.aborted;

  function defineGetter(key, mocked) {
    Object.defineProperty(xhrProto, key, {
      configurable: true,
      enumerable: true,
      get() {
        const m = xhrMocks.get(this);
        return m ? mocked(m) : nativeGetters[key].call(this);
      },
    });
  }
  defineGetter('readyState', (m) => m.readyState);
  defineGetter('status', (m) => (headersVisible(m) ? m.rule.response.status : 0));
  defineGetter('statusText', (m) => (headersVisible(m) ? m.rule.response.statusText : ''));
  defineGetter('responseURL', (m) => (headersVisible(m) ? m.url : ''));
  defineGetter('response', (m) => mockResponse(m));
  defineGetter('responseText', (m) => {
    if (m.responseType !== '' && m.responseType !== 'text') {
      throw new DOMException(
        `Failed to read the 'responseText' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'text' (was '${m.responseType}').`,
        'InvalidStateError',
      );
    }
    return m.readyState === 4 && !m.aborted ? (m.rule.response.body ?? '') : '';
  });

  const patchedXhr = {
    open(method, url) {
      try {
        const previous = xhrMocks.get(this);
        if (previous) {
          clearTimeout(previous.timer);
          xhrMocks.delete(this);
        }
        xhrRequests.set(this, {
          method: String(method).toUpperCase(),
          rawUrl: String(url),
          isAsync: arguments.length < 3 || arguments[2] === undefined || !!arguments[2],
        });
      } catch (_) {
        // Fall through to the native open().
      }
      return Reflect.apply(nativeXhr.open, this, arguments);
    },
    send() {
      const req = xhrRequests.get(this);
      let rule = null;
      let info = null;
      try {
        if (req) {
          info = requestInfo(req.rawUrl, req.method);
          rule = matchRequest(info);
        }
      } catch (_) {
        rule = null;
      }
      if (!rule) return Reflect.apply(nativeXhr.send, this, arguments);
      if (xhrMocks.has(this)) {
        throw new DOMException("Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED.", 'InvalidStateError');
      }
      startMock(this, rule, info, req.isAsync);
      return undefined;
    },
    abort() {
      const m = xhrMocks.get(this);
      if (!m) return Reflect.apply(nativeXhr.abort, this, arguments);
      abortMock(this, m);
      return undefined;
    },
    getResponseHeader(name) {
      const m = xhrMocks.get(this);
      if (!m) return Reflect.apply(nativeXhr.getResponseHeader, this, arguments);
      if (!headersVisible(m)) return null;
      const value = m.headers.get(String(name).toLowerCase());
      return value === undefined ? null : value;
    },
    getAllResponseHeaders() {
      const m = xhrMocks.get(this);
      if (!m) return Reflect.apply(nativeXhr.getAllResponseHeaders, this, arguments);
      if (!headersVisible(m)) return '';
      let out = '';
      for (const [key, value] of m.headers) out += `${key}: ${value}\r\n`;
      return out;
    },
  };
  xhrProto.open = patchedXhr.open;
  xhrProto.send = patchedXhr.send;
  xhrProto.abort = patchedXhr.abort;
  xhrProto.getResponseHeader = patchedXhr.getResponseHeader;
  xhrProto.getAllResponseHeaders = patchedXhr.getAllResponseHeaders;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx playwright test test/engine-xhr.spec.js test/engine-fetch.spec.js`
Expected: PASS. If the "on* handler properties" test fails, **spec assumption 6 is wrong**: stop and report.

- [ ] **Step 5: Commit**

```bash
git add engine.js test/engine-xhr.spec.js
git commit -m "feat(engine): mock XMLHttpRequest by patching the prototype"
```

---

### Task 6: Engine — startup gate, fail-open, silence, privacy

**Files:**
- Modify: `engine.js`
- Modify: `test/fixtures.js` (add the `enginePage` fixture)
- Create: `test/engine-safety.spec.js`

**Interfaces:**
- Consumes: everything in `engine.js` from Tasks 3–5.
- Produces:
  - Fixture `enginePage`: a plain Chromium page **without the extension** where only `engine.js` is injected at document start (`context.addInitScript`). There is no bridge, so the test decides exactly when `RULES` arrive. All gate/fail-open tests use it, which keeps them valid after Task 7 adds the bridge.
  - Engine events `__API_MOCK__/RULES_UNAVAILABLE` (no payload besides `ts`) and `__API_MOCK__/ENGINE_ERROR { message, ruleId }` (`ruleId` may be `null`; `message` is at most 300 characters).
  - Engine internals: `gate`, `gateOpen()`, `reportUnavailable()`, `reportError(error, ruleId?)`, `requestInfo()` now returns `null` for a URL the browser cannot parse (the native call then reports it), `mockFetch(rule, info, fallback)`, `abortDeferred(xhr)`.
- Behaviour (spec sections 3, 5, 7, 9): requests wait at most 1 s for the first `RULES`, then fail open and report `RULES_UNAVAILABLE` once; a synchronous XHR never waits; a rule that cannot be compiled is skipped and reported; an error while building a mock falls back to the native call and is reported; the engine prints nothing and touches no DOM; `RULES` is invisible to page scripts (spec assumption 2).

- [ ] **Step 1: Add the `enginePage` fixture to `test/fixtures.js`**

Inside `base.extend({ ... })`, after the `extensionId` fixture, add:

```js
  // A plain Chromium page (no extension) with only engine.js injected at document start.
  // No bridge: the test controls exactly when RULES arrive.
  enginePage: async ({ browser }, use) => {
    const context = await browser.newContext();
    await context.addInitScript({ path: path.join(EXTENSION_PATH, 'engine.js') });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
```

- [ ] **Step 2: Write the failing test `test/engine-safety.spec.js`**

```js
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx playwright test test/engine-safety.spec.js`
Expected: FAIL — there is no gate (held requests pass through), no `ENGINE_ERROR`/`RULES_UNAVAILABLE`, engine faults reject instead of falling back, and page listeners see `RULES`.

- [ ] **Step 4: Modify `engine.js` — state, reporting and the startup gate**

In `// ── Setup ──`, change the state line to:

```js
  const state = { rules: [], rulesLoaded: false, gaveUp: false };
```

Replace the whole `// ── Reporting ──` section with:

```js
  // ── Reporting ────────────────────────────────────────────────────────────
  function emit(kind, data) {
    try {
      window.postMessage({ type: NS + kind, ts: Date.now(), ...data }, '*');
    } catch (_) {
      // Reporting must never break the page.
    }
  }

  function reportError(error, ruleId) {
    emit('ENGINE_ERROR', { message: String((error && error.message) || error).slice(0, 300), ruleId: ruleId || null });
  }

  // ── Startup gate ─────────────────────────────────────────────────────────
  // Until the first RULES arrive, requests wait (at most GATE_MS); then the engine fails open.
  const GATE_MS = 1000;
  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  let unavailableReported = false;
  const gateOpen = () => state.rulesLoaded || state.gaveUp;

  function reportUnavailable() {
    if (unavailableReported) return;
    unavailableReported = true;
    emit('RULES_UNAVAILABLE');
  }

  const gateTimer = setTimeout(() => {
    if (state.rulesLoaded) return;
    state.gaveUp = true;
    reportUnavailable();
    openGate();
  }, GATE_MS);
```

- [ ] **Step 5: Modify `engine.js` — URL parsing, rule loading and the private intake listener**

Replace `requestInfo` with:

```js
  function requestInfo(rawUrl, method) {
    let u;
    try {
      u = normalizeUrl(rawUrl);
    } catch (_) {
      return null; // an invalid URL is reported by the browser itself
    }
    return {
      method: String(method || 'GET').toUpperCase(),
      href: u.href,
      hrefNoQuery: u.href.split('?')[0],
      pathname: u.pathname,
      search: u.search,
    };
  }
```

Replace `loadRules` and the intake listener with:

```js
  function loadRules(rawRules) {
    const compiled = [];
    for (const r of Array.isArray(rawRules) ? rawRules : []) {
      try {
        compiled.push(compileRule(r));
      } catch (e) {
        reportError(e, r && r.id);
      }
    }
    state.rules = compiled;
    state.rulesLoaded = true;
    clearTimeout(gateTimer);
    openGate();
  }

  // ── Intake: RULES pushed by the bridge ───────────────────────────────────
  // Registered first, in the capture phase, and it stops propagation: page scripts registered
  // later cannot observe the rules.
  window.addEventListener(
    'message',
    (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.type !== NS + 'RULES') return;
      ev.stopImmediatePropagation();
      loadRules(d.rules);
    },
    true,
  );
```

- [ ] **Step 6: Modify `engine.js` — fetch with gate and fallback**

Replace `fetchInfo`, `mockFetch` and the `window.fetch = …` assignment (everything from `function fetchInfo` to the end of the `// ── fetch ──` section) with:

```js
  function fetchInfo(input, init) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const rawUrl = isRequest ? input.url : String(input);
    const method = (init && init.method) || (isRequest ? input.method : 'GET');
    const signal = (init && init.signal) || (isRequest ? input.signal : undefined);
    const info = requestInfo(rawUrl, method);
    return info && { ...info, signal };
  }

  function abortReason(signal) {
    return signal.reason !== undefined ? signal.reason : new DOMException('The user aborted a request.', 'AbortError');
  }

  function mockFetch(rule, info, fallback) {
    emit('MOCK_EVENT', { ruleId: rule.id, url: info.href, method: info.method, status: rule.response.status });
    const { signal } = info;
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      let timer = 0;
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        try {
          resolve(buildResponse(rule.response, info.href));
        } catch (e) {
          reportError(e, rule.id);
          resolve(fallback());
        }
      }, rule.response.delay);
    });
  }

  // Declared as an object method so `fetch.name === 'fetch'` and `fetch.length === 1`, like the native one.
  const patchedFetch = {
    fetch: function fetch(input) {
      const self = this;
      const args = arguments;
      if (!gateOpen()) return gate.then(() => Reflect.apply(patchedFetch, self, args));
      const fallback = () => Reflect.apply(nativeFetch, self, args);
      let rule = null;
      let info = null;
      try {
        info = fetchInfo(input, args[1]);
        rule = info ? matchRequest(info) : null;
      } catch (e) {
        reportError(e);
        return fallback();
      }
      if (!rule) return fallback();
      return mockFetch(rule, info, fallback);
    },
  }.fetch;
  window.fetch = patchedFetch;
```

- [ ] **Step 7: Modify `engine.js` — XHR gate, fallback and deferred abort**

Add this function right after `abortMock`:

```js
  // An XHR aborted while it was still waiting for the first RULES.
  function abortDeferred(xhr) {
    const m = {
      rule: { response: { status: 0, statusText: '', body: '', headers: [] } },
      url: '',
      headers: new Map(),
      responseType: xhr.responseType,
      readyState: 1,
      aborted: false,
      done: false,
      timer: 0,
      cache: undefined,
      size: 0,
    };
    xhrMocks.set(xhr, m);
    abortMock(xhr, m);
  }
```

In `patchedXhr`, replace the `open`, `send` and `abort` methods with:

```js
    open(method, url) {
      try {
        const previous = xhrMocks.get(this);
        if (previous) {
          clearTimeout(previous.timer);
          xhrMocks.delete(this);
        }
        xhrRequests.set(this, {
          method: String(method).toUpperCase(),
          rawUrl: String(url),
          isAsync: arguments.length < 3 || arguments[2] === undefined || !!arguments[2],
          deferred: false,
          cancelled: false,
        });
      } catch (_) {
        // Fall through to the native open().
      }
      return Reflect.apply(nativeXhr.open, this, arguments);
    },
    send() {
      const req = xhrRequests.get(this);
      if (req && req.cancelled) return undefined; // aborted while waiting for the first RULES
      if (!gateOpen()) {
        if (!req || !req.isAsync) {
          reportUnavailable(); // a synchronous XHR cannot wait
          return Reflect.apply(nativeXhr.send, this, arguments);
        }
        req.deferred = true;
        const self = this;
        const args = arguments;
        gate.then(() => {
          req.deferred = false;
          try {
            Reflect.apply(patchedXhr.send, self, args);
          } catch (_) {
            // The page re-opened or aborted the request in the meantime.
          }
        });
        return undefined;
      }
      let rule = null;
      let info = null;
      try {
        if (req) {
          info = requestInfo(req.rawUrl, req.method);
          rule = info ? matchRequest(info) : null;
        }
      } catch (e) {
        reportError(e);
      }
      if (!rule) return Reflect.apply(nativeXhr.send, this, arguments);
      if (xhrMocks.has(this)) {
        throw new DOMException("Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED.", 'InvalidStateError');
      }
      try {
        startMock(this, rule, info, req.isAsync);
      } catch (e) {
        xhrMocks.delete(this);
        reportError(e, rule.id);
        return Reflect.apply(nativeXhr.send, this, arguments);
      }
      return undefined;
    },
    abort() {
      const req = xhrRequests.get(this);
      if (req && req.deferred) {
        req.deferred = false;
        req.cancelled = true;
        abortDeferred(this);
        return undefined;
      }
      const m = xhrMocks.get(this);
      if (!m) return Reflect.apply(nativeXhr.abort, this, arguments);
      abortMock(this, m);
      return undefined;
    },
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx playwright test test/engine-safety.spec.js test/engine-fetch.spec.js test/engine-xhr.spec.js test/smoke.spec.js`
Expected: PASS. If the privacy test fails, **spec assumption 2 is wrong** (a listener still sees `RULES`): stop and report — the spec's privacy section needs a different mechanism.

- [ ] **Step 9: Commit**

```bash
git add engine.js test/fixtures.js test/engine-safety.spec.js
git commit -m "feat(engine): startup gate, fail-open error handling, silence and private RULES intake"
```

---

### Task 7: Bridge — storage → engine, engine events → service worker, PING

**Files:**
- Replace: `bridge.js` (the Task 1 stub)
- Modify: `test/server.js` (add `/frame-parent.html`), `test/smoke.spec.js` (test 3)
- Create: `test/bridge.spec.js`

**Interfaces:**
- Consumes: the engine contract from Tasks 3 and 6 (`RULES` in; `MOCK_EVENT`, `RULES_UNAVAILABLE`, `ENGINE_ERROR` out), `setState()`, `openExtensionPage()` (Task 1).
- Produces (Task 9 builds the service-worker side on exactly this):
  - Pushes `{ type: '__API_MOCK__/RULES', rules }` into every frame at start and on every change of `storage.local.state`. `rules` contains **only enabled rules** as `{ id, method, url, response }` (no `name`, no `enabled`); it is `[]` when `globalEnabled === false` or no state exists.
  - Sends to the service worker with `chrome.runtime.sendMessage` (Chrome adds `sender.tab.id` and `sender.frameId`):
    - `{ type: 'PAGE_START' }` — top frame only, once per document
    - `{ type: 'MOCK_EVENT', ruleId: string (≤64), url: string (≤2048), method: string (≤16, upper-case), status: integer 200–599 }`
    - `{ type: 'RULES_UNAVAILABLE' }`
    - `{ type: 'ENGINE_ERROR', message: string (≤300), ruleId: string | null }`
  - The bridge adds no timestamp (the service worker stamps events; page data is untrusted). Events that fail validation are dropped; at most 50 events per second per frame are forwarded.
  - Answers `chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId: 0 })` with `{ ok: true }` and nothing else.

- [ ] **Step 1: Add a page with an iframe to `test/server.js`**

Inside the request handler, after the `/startup-race.html` branch, add:

```js
    if (url.pathname === '/frame-parent.html') {
      return send(res, 200, { 'content-type': 'text/html' }, '<!doctype html><title>parent</title><iframe src="/"></iframe>');
    }
```

- [ ] **Step 2: Update smoke test 3 in `test/smoke.spec.js`**

Rename it and change the last assertion:

```js
test('bridge content script (ISOLATED world) reports PAGE_START to extension pages', async ({ context, server, extensionId }) => {
  const ext = await openExtensionPage(context, extensionId);
  await ext.evaluate(() => {
    window.__msgs = [];
    chrome.runtime.onMessage.addListener((msg) => {
      window.__msgs.push(msg);
    });
  });
  const page = await context.newPage();
  await page.goto(server.origin + '/');
  await expect.poll(() => ext.evaluate(() => window.__msgs.map((m) => m.type))).toContain('PAGE_START');
});
```

- [ ] **Step 3: Write the failing test `test/bridge.spec.js`**

```js
const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage } = require('./helpers');

// An extension page that records every runtime message (plus the sender) sent by content scripts.
async function collector(context, extensionId) {
  const ext = await openExtensionPage(context, extensionId);
  await ext.evaluate(() => {
    window.__msgs = [];
    chrome.runtime.onMessage.addListener((msg, sender) => {
      window.__msgs.push({ msg, tabId: sender.tab && sender.tab.id, frameId: sender.frameId });
    });
  });
  return { ext, msgs: () => ext.evaluate(() => window.__msgs) };
}

const fetchText = (page, url) => page.evaluate((u) => fetch(u).then((r) => r.text()), url);

test.describe('bridge: rules', () => {
  test('applies rules seeded in storage, with no help from the test', async ({ context, server, serviceWorker }) => {
    await setState(serviceWorker, { rules: [rule({ url: '/mocked', response: { body: 'from-storage' } })] });
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    expect(await fetchText(page, '/mocked')).toBe('from-storage');
  });

  test('startup race: the first script of the page is already answered by the mock (spec assumption 3)', async ({ context, server, serviceWorker }) => {
    await setState(serviceWorker, { rules: [rule({ url: '/mocked-early', response: { body: 'early-ok' } })] });
    const page = await context.newPage();
    await page.goto(server.origin + '/startup-race.html');
    expect(await page.evaluate(() => window.__early)).toBe('early-ok');
  });

  test('live update: a storage change applies without reloading the page', async ({ context, server, serviceWorker }) => {
    await setState(serviceWorker, { rules: [rule({ id: 'a', url: '/mocked', response: { body: 'A' } })] });
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    expect(await fetchText(page, '/mocked')).toBe('A');
    await setState(serviceWorker, { rules: [rule({ id: 'a', url: '/mocked', response: { body: 'B' } })] });
    await expect.poll(() => fetchText(page, '/mocked')).toBe('B');
  });

  test('disabled rules and a global switch-off are not applied', async ({ context, server, serviceWorker }) => {
    const page = await context.newPage();
    await page.goto(server.origin + '/');

    await setState(serviceWorker, { rules: [rule({ url: '/mocked', enabled: false })] });
    await expect.poll(() => fetchText(page, '/mocked')).toContain('"source":"server"');

    await setState(serviceWorker, { globalEnabled: false, rules: [rule({ url: '/mocked', response: { body: 'on' } })] });
    await expect.poll(() => fetchText(page, '/mocked')).toContain('"source":"server"');

    await setState(serviceWorker, { globalEnabled: true, rules: [rule({ url: '/mocked', response: { body: 'on' } })] });
    await expect.poll(() => fetchText(page, '/mocked')).toBe('on');
  });

  test('the page cannot observe rules or rule names, only metadata-only events', async ({ context, server, serviceWorker }) => {
    await setState(serviceWorker, { rules: [rule({ name: 'Secret name', url: '/mocked', response: { body: 'secret-body' } })] });
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    await page.evaluate(() => {
      window.__seen = [];
      window.addEventListener('message', (e) => window.__seen.push(JSON.stringify(e.data)));
      window.addEventListener('message', (e) => window.__seen.push(JSON.stringify(e.data)), true);
    });
    // Force a fresh RULES push, then make the page issue mocked requests.
    await setState(serviceWorker, { rules: [rule({ name: 'Another secret', url: '/mocked', response: { body: 'secret-body-2' } })] });
    await expect.poll(() => fetchText(page, '/mocked')).toBe('secret-body-2');
    const seen = (await page.evaluate(() => window.__seen)).join('\n');
    expect(seen).not.toContain('__API_MOCK__/RULES"');
    expect(seen).not.toMatch(/secret/i);
    expect(seen).toContain('MOCK_EVENT');
  });
});

test.describe('bridge: events to the service worker', () => {
  test('forwards MOCK_EVENT with only ruleId, url, method and status, and a sender tab id (spec assumption 1)', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: [rule({ id: 'ev1', url: '/mocked', response: { status: 202 } })] });
    const { msgs } = await collector(context, extensionId);
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    await fetchText(page, '/mocked?a=1');
    await expect.poll(async () => (await msgs()).some((m) => m.msg.type === 'MOCK_EVENT')).toBe(true);
    const ev = (await msgs()).find((m) => m.msg.type === 'MOCK_EVENT');
    expect(ev.msg).toEqual({ type: 'MOCK_EVENT', ruleId: 'ev1', url: server.origin + '/mocked?a=1', method: 'GET', status: 202 });
    expect(typeof ev.tabId).toBe('number');
    expect(ev.frameId).toBe(0);
  });

  test('forged events from the page are validated and clipped', async ({ context, server, extensionId }) => {
    const { msgs } = await collector(context, extensionId);
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    await page.evaluate(() => {
      const post = (m) => window.postMessage(m, '*');
      post({ type: '__API_MOCK__/MOCK_EVENT', ruleId: 5, url: 'x', method: 'GET', status: 200 }); // ruleId not a string
      post({ type: '__API_MOCK__/MOCK_EVENT', ruleId: 'r', url: 'x', method: 'GET', status: 'abc' }); // status not an integer
      post({ type: '__API_MOCK__/MOCK_EVENT', ruleId: 'r', url: 'u'.repeat(5000), method: 'g'.repeat(50), status: 200 });
      post({ type: '__API_MOCK__/ENGINE_ERROR', message: 'm'.repeat(1000) });
      post({ type: '__API_MOCK__/SOMETHING_ELSE' });
    });
    await expect.poll(async () => (await msgs()).filter((m) => ['MOCK_EVENT', 'ENGINE_ERROR'].includes(m.msg.type)).length).toBe(2);
    const all = (await msgs()).map((m) => m.msg);
    const mock = all.find((m) => m.type === 'MOCK_EVENT');
    expect(mock.url).toHaveLength(2048);
    expect(mock.method).toBe('G'.repeat(16));
    const err = all.find((m) => m.type === 'ENGINE_ERROR');
    expect(err.message).toHaveLength(300);
    expect(err.ruleId).toBeNull();
    expect(all.filter((m) => m.type === 'MOCK_EVENT')).toHaveLength(1);
  });

  test('a flood of events is rate limited', async ({ context, server, extensionId }) => {
    const { msgs } = await collector(context, extensionId);
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    await page.evaluate(() => {
      for (let i = 0; i < 200; i++) {
        window.postMessage({ type: '__API_MOCK__/MOCK_EVENT', ruleId: 'r', url: '/x', method: 'GET', status: 200 }, '*');
      }
    });
    await page.waitForTimeout(300);
    const n = (await msgs()).filter((m) => m.msg.type === 'MOCK_EVENT').length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(50);
  });

  test('PAGE_START comes from the top frame only', async ({ context, server, extensionId }) => {
    const { msgs } = await collector(context, extensionId);
    const page = await context.newPage();
    await page.goto(server.origin + '/frame-parent.html');
    await expect.poll(async () => (await msgs()).filter((m) => m.msg.type === 'PAGE_START').length).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(300); // give the iframe time to start too
    const starts = (await msgs()).filter((m) => m.msg.type === 'PAGE_START');
    expect(starts).toHaveLength(1);
    expect(starts[0].frameId).toBe(0);
  });
});

test.describe('bridge: PING (spec assumptions 1 and 8)', () => {
  test('a tab with the bridge answers PING; a tab without it does not', async ({ context, server, extensionId }) => {
    const { ext, msgs } = await collector(context, extensionId);
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    await expect.poll(async () => (await msgs()).some((m) => m.msg.type === 'PAGE_START')).toBe(true);
    const tabId = (await msgs()).find((m) => m.msg.type === 'PAGE_START').tabId;

    const ping = (id) =>
      ext.evaluate(
        (t) => chrome.tabs.sendMessage(t, { type: 'PING' }, { frameId: 0 }).then((r) => r, () => 'no receiver'),
        id,
      );
    expect(await ping(tabId)).toEqual({ ok: true });

    // An extension page has no content scripts, so it stands in for a tab without an engine.
    const other = await openExtensionPage(context, extensionId, 'popup/popup.html?other');
    const otherId = await other.evaluate(() => chrome.tabs.getCurrent().then((t) => t.id));
    expect(await ping(otherId)).toBe('no receiver');
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx playwright test test/bridge.spec.js test/smoke.spec.js`
Expected: FAIL — the bridge is still the Task 1 stub (no rules are pushed, no `PAGE_START`, no `PING` answer).

- [ ] **Step 5: Implement `bridge.js`**

```js
// Runs in the ISOLATED world at document_start, in every frame. Classic script: no import/export.
// The only place that talks to both the page (window.postMessage) and the extension (chrome.*).
(() => {
  'use strict';

  // ── Setup ────────────────────────────────────────────────────────────────
  const NS = '__API_MOCK__/';
  const MAX_EVENTS_PER_SECOND = 50;
  let alive = true; // false once the extension was reloaded or updated under this page

  function send(message) {
    if (!alive) return;
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        alive = false;
        return;
      }
      chrome.runtime.sendMessage(message).catch(() => {
        if (!chrome.runtime || !chrome.runtime.id) alive = false;
      });
    } catch (_) {
      alive = false;
    }
  }

  // ── Rules → engine ───────────────────────────────────────────────────────
  // Only what the engine needs: enabled rules, no names. Nothing at all while mocking is off.
  function engineRules(state) {
    if (!state || state.globalEnabled === false || !Array.isArray(state.rules)) return [];
    return state.rules
      .filter((r) => r && r.enabled)
      .map((r) => ({ id: r.id, method: r.method, url: r.url, response: r.response }));
  }

  function pushRules(state) {
    window.postMessage({ type: NS + 'RULES', rules: engineRules(state) }, '*');
  }

  chrome.storage.local
    .get('state')
    .then((res) => pushRules(res.state))
    .catch(() => {
      alive = false;
    });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.state) pushRules(changes.state.newValue);
  });

  // ── Engine events → service worker ───────────────────────────────────────
  // Everything that comes from the page is untrusted: validate, clip, rate limit.
  const clip = (value, max) => String(value).slice(0, max);

  function sanitize(kind, d) {
    if (kind === 'MOCK_EVENT') {
      if (typeof d.ruleId !== 'string' || typeof d.url !== 'string' || typeof d.method !== 'string') return null;
      if (!Number.isInteger(d.status) || d.status < 200 || d.status > 599) return null;
      return {
        type: 'MOCK_EVENT',
        ruleId: clip(d.ruleId, 64),
        url: clip(d.url, 2048),
        method: clip(d.method, 16).toUpperCase(),
        status: d.status,
      };
    }
    if (kind === 'ENGINE_ERROR') {
      return {
        type: 'ENGINE_ERROR',
        message: clip(typeof d.message === 'string' ? d.message : 'Engine error', 300),
        ruleId: typeof d.ruleId === 'string' ? clip(d.ruleId, 64) : null,
      };
    }
    if (kind === 'RULES_UNAVAILABLE') return { type: 'RULES_UNAVAILABLE' };
    return null;
  }

  let windowStart = 0;
  let count = 0;
  function withinRateLimit() {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    return count <= MAX_EVENTS_PER_SECOND;
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || typeof d.type !== 'string' || !d.type.startsWith(NS)) return;
    const message = sanitize(d.type.slice(NS.length), d);
    if (message && withinRateLimit()) send(message);
  });

  // ── Page lifecycle and liveness check ────────────────────────────────────
  if (window === window.top) send({ type: 'PAGE_START' });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'PING') sendResponse({ ok: true });
    return false;
  });
})();
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx playwright test`
Expected: PASS for the whole suite so far. If the PING test fails on `tabs.sendMessage` or `sender.tab.id`, **spec assumptions 1/8 are wrong** (a `tabs` permission would be needed): stop and report.

- [ ] **Step 7: Commit**

```bash
git add bridge.js test/server.js test/smoke.spec.js test/bridge.spec.js
git commit -m "feat(bridge): push enabled rules to the engine, forward sanitized events, answer PING"
```

---

### Task 8: Service worker — state ownership (`SAVE_RULE`, `DELETE_RULE`, `REORDER`, `SET_GLOBAL`)

**Files:**
- Replace: `background.js` (the Task 1 stub)
- Create: `test/sw-state.spec.js`

**Interfaces:**
- Consumes: `shared/rule.js` (Task 2): `defaultState`, `validateRule`, `sanitizeRule`.
- Produces (Plan 2's popup and panel send exactly these; Task 9 extends the same listener):
  - `chrome.runtime.sendMessage({ type: 'SAVE_RULE', rule })` → `{ ok: true, rule }` (the sanitized rule) or `{ ok: false, errors }`. A rule without `id` gets one; an existing `id` is replaced **in place**; a new rule goes to the **top** of the list.
  - `{ type: 'DELETE_RULE', id }` → `{ ok: true, removed: number }`
  - `{ type: 'REORDER', id, dir: 'up' | 'down' }` → `{ ok: true, moved: boolean }` (no-op at the edges)
  - `{ type: 'SET_GLOBAL', enabled: boolean }` → `{ ok: true }`
  - Anything else with a `type` from this table is refused with `{ ok: false, error: 'Not allowed' }` unless the sender is an extension page (`sender.url` starts with `chrome.runtime.getURL('')`).
  - Internal: `withState(mutator)` serialises every read-modify-write of `storage.local.state` (a single writer); `readState()`; the `MANAGEMENT` table; `isExtensionPage(sender)`.
- Storage: `state = { version: 1, globalEnabled, rules }` under key `state`. A missing `state` reads as `defaultState()` (`globalEnabled: true`).

- [ ] **Step 1: Write the failing test `test/sw-state.spec.js`**

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test test/sw-state.spec.js`
Expected: FAIL — `background.js` has no message listener, so `sendMessage` resolves `undefined` (or rejects) and `res.ok` is missing.

- [ ] **Step 3: Implement `background.js`**

```js
// Service worker (ES module). Owns state; never sits on the request path.
import { defaultState, sanitizeRule, validateRule } from './shared/rule.js';

const STATE_KEY = 'state';

// ── State (single writer) ──────────────────────────────────────────────────
// Every read-modify-write runs through this queue, so concurrent messages never interleave.
let queue = Promise.resolve();

async function readState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return stored[STATE_KEY] || defaultState();
}

// `mutator(state)` returns `{ state?, result }`; a returned `state` is persisted.
function withState(mutator) {
  const run = queue.then(async () => {
    const out = await mutator(await readState());
    if (out.state) await chrome.storage.local.set({ [STATE_KEY]: out.state });
    return out.result;
  });
  queue = run.catch(() => {});
  return run;
}

// ── Management messages (extension pages only) ─────────────────────────────
const MANAGEMENT = {
  SAVE_RULE: ({ rule }) =>
    withState((state) => {
      const check = validateRule(rule);
      if (!check.ok) return { result: { ok: false, errors: check.errors } };
      const clean = sanitizeRule(rule);
      const i = state.rules.findIndex((r) => r.id === clean.id);
      if (i >= 0) state.rules[i] = clean;
      else state.rules.unshift(clean);
      return { state, result: { ok: true, rule: clean } };
    }),

  DELETE_RULE: ({ id }) =>
    withState((state) => {
      const before = state.rules.length;
      state.rules = state.rules.filter((r) => r.id !== id);
      return { state, result: { ok: true, removed: before - state.rules.length } };
    }),

  REORDER: ({ id, dir }) =>
    withState((state) => {
      const i = state.rules.findIndex((r) => r.id === id);
      const j = dir === 'up' ? i - 1 : dir === 'down' ? i + 1 : -1;
      if (i < 0 || j < 0 || j >= state.rules.length) return { result: { ok: true, moved: false } };
      [state.rules[i], state.rules[j]] = [state.rules[j], state.rules[i]];
      return { state, result: { ok: true, moved: true } };
    }),

  SET_GLOBAL: ({ enabled }) =>
    withState((state) => {
      state.globalEnabled = enabled === true;
      return { state, result: { ok: true } };
    }),
};

const isExtensionPage = (sender) =>
  typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

// ── Message routing ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg.type !== 'string') return false;
  const management = MANAGEMENT[msg.type];
  if (management) {
    if (!isExtensionPage(sender)) {
      respond({ ok: false, error: 'Not allowed' });
      return false;
    }
    management(msg).then(respond, (e) => respond({ ok: false, error: String((e && e.message) || e) }));
    return true; // keep the channel open for the async response
  }
  return false;
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx playwright test test/sw-state.spec.js test/bridge.spec.js`
Expected: PASS (the bridge tests still pass: the service worker now has a listener that ignores their events).

- [ ] **Step 5: Commit**

```bash
git add background.js test/sw-state.spec.js
git commit -m "feat(sw): own rule state behind a single-writer queue with validated messages"
```

---

### Task 9: Service worker — per-tab log, counters, hits, cleanup

**Files:**
- Modify: `background.js`
- Create: `test/sw-events.spec.js`

**Interfaces:**
- Consumes: bridge messages from Task 7 (`PAGE_START`, `MOCK_EVENT`, `RULES_UNAVAILABLE`, `ENGINE_ERROR`; Chrome supplies `sender.tab.id` and `sender.frameId`), and `readState`, `MANAGEMENT`, `isExtensionPage` from Task 8.
- Produces (Plan 2's popup and panel read these straight from storage and re-render on `storage.onChanged`):
  - `storage.session` → `log:<tabId>`: `LogEntry[]`, at most 200, oldest dropped first. `LogEntry = { ts, kind: 'mock' | 'unavailable' | 'error', method?, url?, ruleId?, ruleName?, status?, delay?, message? }`. The service worker stamps `ts` (page data is untrusted) and resolves `ruleName`/`delay` from the current state.
  - `storage.session` → `tab:<tabId>`: `{ mocked: number, issues: number }`. `MOCK_EVENT` increments `mocked`; `RULES_UNAVAILABLE` and `ENGINE_ERROR` increment `issues`; `PAGE_START` from the top frame resets both to 0.
  - `storage.local` → `hits`: `Record<ruleId, number>`, flushed about 1 s after a change. Only events for a rule that still exists are counted.
  - New management message `{ type: 'CLEAR_LOG', tabId }` → `{ ok: true }`: empties the tab's log and sets `issues` to 0 (`mocked` is untouched). `DELETE_RULE` now also removes the rule's hit count.
  - Events are accepted only from content scripts (`sender.tab` present and the sender is not an extension page).
  - Internal: `enqueue(fn)`, `loadTab(tabId)`, `markDirty(t)`, `flushNow()`, `addLog(t, entry)`, `loadHits()`, `scheduleHitsFlush()`, the `EVENTS` table, and the hook `afterTabChange(tabId)` — an empty async function here that Task 10 fills in to refresh the badge.
- Debounce: log and counters about 200 ms, hits about 1 s. An abrupt worker shutdown can lose the last few entries; that is accepted (spec section 9).

- [ ] **Step 1: Write the failing test `test/sw-events.spec.js`**

```js
const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage } = require('./helpers');

const session = (sw) => sw.evaluate(() => chrome.storage.session.get(null));
const localKey = (sw, key) => sw.evaluate((k) => chrome.storage.local.get(k).then((r) => r[k]), key);
const post = (page, message) => page.evaluate((m) => window.postMessage(m, '*'), message);
const fetchText = (page, url) => page.evaluate((u) => fetch(u).then((r) => r.text()), url);

// The log and counters of the single open tab.
async function tabData(sw) {
  const s = await session(sw);
  const lk = Object.keys(s).find((k) => k.startsWith('log:'));
  const tk = Object.keys(s).find((k) => k.startsWith('tab:'));
  return { log: lk ? s[lk] : [], counters: tk ? s[tk] : null, tabId: tk ? Number(tk.slice(4)) : null };
}

async function openMocked({ context, server, serviceWorker }, rules) {
  await setState(serviceWorker, { rules });
  const page = await context.newPage();
  await page.goto(server.origin + '/');
  return page;
}

test.describe('service worker: log, counters and hits', () => {
  test('logs a mocked request with the rule name and delay, and counts it', async ({ context, server, serviceWorker }) => {
    const page = await openMocked({ context, server, serviceWorker }, [
      rule({ id: 'r1', name: 'Users list', url: '/mocked', response: { status: 500, delay: 5 } }),
    ]);
    await fetchText(page, '/mocked');
    await expect.poll(async () => (await tabData(serviceWorker)).log.length).toBe(1);
    const { log, counters } = await tabData(serviceWorker);
    expect(log[0]).toMatchObject({
      kind: 'mock', method: 'GET', url: server.origin + '/mocked', ruleId: 'r1', ruleName: 'Users list', status: 500, delay: 5,
    });
    expect(typeof log[0].ts).toBe('number');
    expect(counters).toEqual({ mocked: 1, issues: 0 });
  });

  test('counts hits and flushes them to storage.local about a second later', async ({ context, server, serviceWorker }) => {
    const page = await openMocked({ context, server, serviceWorker }, [rule({ id: 'r1', url: '/mocked' })]);
    for (let i = 0; i < 3; i++) await fetchText(page, '/mocked');
    await expect.poll(async () => (await localKey(serviceWorker, 'hits'))?.r1, { timeout: 5000 }).toBe(3);
  });

  test('hit counting never rewrites the rule state (so it never triggers a RULES push)', async ({ context, server, serviceWorker, extensionId }) => {
    const page = await openMocked({ context, server, serviceWorker }, [rule({ id: 'r1', url: '/mocked' })]);
    const ext = await openExtensionPage(context, extensionId);
    await ext.evaluate(() => {
      window.__changed = [];
      chrome.storage.onChanged.addListener((changes, area) => window.__changed.push(`${area}:${Object.keys(changes).join(',')}`));
    });
    for (let i = 0; i < 3; i++) await fetchText(page, '/mocked');
    await expect.poll(() => ext.evaluate(() => window.__changed), { timeout: 5000 }).toContain('local:hits');
    expect((await ext.evaluate(() => window.__changed)).filter((c) => c.includes('state'))).toEqual([]);
  });

  test('a top-frame load resets the counters; the log survives navigation', async ({ context, server, serviceWorker }) => {
    const page = await openMocked({ context, server, serviceWorker }, [rule({ id: 'r1', url: '/mocked' })]);
    await fetchText(page, '/mocked');
    await fetchText(page, '/mocked');
    await expect.poll(async () => (await tabData(serviceWorker)).counters).toEqual({ mocked: 2, issues: 0 });
    await page.reload();
    await expect.poll(async () => (await tabData(serviceWorker)).counters).toEqual({ mocked: 0, issues: 0 });
    expect((await tabData(serviceWorker)).log).toHaveLength(2);
  });

  test('RULES_UNAVAILABLE and ENGINE_ERROR count as issues and are logged', async ({ context, server, serviceWorker }) => {
    const page = await openMocked({ context, server, serviceWorker }, [rule({ id: 'r1', name: 'Orders', url: '/mocked' })]);
    await post(page, { type: '__API_MOCK__/RULES_UNAVAILABLE' });
    await post(page, { type: '__API_MOCK__/ENGINE_ERROR', message: 'boom', ruleId: 'r1' });
    await expect.poll(async () => (await tabData(serviceWorker)).log.length).toBe(2);
    const { log, counters } = await tabData(serviceWorker);
    expect(log[0]).toMatchObject({ kind: 'unavailable' });
    expect(log[1]).toMatchObject({ kind: 'error', ruleId: 'r1', ruleName: 'Orders', message: 'boom' });
    expect(counters).toEqual({ mocked: 0, issues: 2 });
  });

  test('CLEAR_LOG empties the log and resets issues but not the mocked count', async ({ context, server, serviceWorker, extensionId }) => {
    const page = await openMocked({ context, server, serviceWorker }, [rule({ id: 'r1', url: '/mocked' })]);
    await fetchText(page, '/mocked');
    await post(page, { type: '__API_MOCK__/RULES_UNAVAILABLE' });
    await expect.poll(async () => (await tabData(serviceWorker)).counters).toEqual({ mocked: 1, issues: 1 });
    const { tabId } = await tabData(serviceWorker);
    const ext = await openExtensionPage(context, extensionId);
    expect(await ext.evaluate((id) => chrome.runtime.sendMessage({ type: 'CLEAR_LOG', tabId: id }), tabId)).toEqual({ ok: true });
    await expect.poll(async () => (await tabData(serviceWorker)).log).toEqual([]);
    expect((await tabData(serviceWorker)).counters).toEqual({ mocked: 1, issues: 0 });
  });

  test('keeps only the last 200 log entries', async ({ context, server, serviceWorker }) => {
    test.setTimeout(45_000);
    const page = await openMocked({ context, server, serviceWorker }, []);
    // 5 batches of 50 events, one rate-limit window apart (the bridge forwards at most 50 per second).
    for (let batch = 0; batch < 5; batch++) {
      await page.evaluate((b) => {
        for (let i = 0; i < 50; i++) {
          window.postMessage({ type: '__API_MOCK__/MOCK_EVENT', ruleId: 'none', url: `/n/${b * 50 + i}`, method: 'GET', status: 200 }, '*');
        }
      }, batch);
      await page.waitForTimeout(1100);
    }
    await expect.poll(async () => (await tabData(serviceWorker)).log.length, { timeout: 5000 }).toBe(200);
    const { log } = await tabData(serviceWorker);
    expect(log[0].url).toBe('/n/50');
    expect(log[199].url).toBe('/n/249');
  });

  test('removes a closed tab\'s data (spec assumption 1: tabs.onRemoved works without the tabs permission)', async ({ context, server, serviceWorker }) => {
    const page = await openMocked({ context, server, serviceWorker }, []);
    await expect.poll(async () => (await tabData(serviceWorker)).counters).not.toBeNull();
    await page.close();
    await expect.poll(async () => Object.keys(await session(serviceWorker)).filter((k) => /^(log|tab):/.test(k))).toEqual([]);
  });

  test('ignores events sent by extension pages', async ({ context, extensionId, serviceWorker }) => {
    const ext = await openExtensionPage(context, extensionId);
    await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'MOCK_EVENT', ruleId: 'r', url: '/x', method: 'GET', status: 200 }).catch(() => {}));
    await ext.waitForTimeout(500);
    expect(Object.keys(await session(serviceWorker)).filter((k) => /^(log|tab):/.test(k))).toEqual([]);
  });

  test('DELETE_RULE drops the rule\'s hit count', async ({ context, server, serviceWorker, extensionId }) => {
    const page = await openMocked({ context, server, serviceWorker }, [rule({ id: 'r1', url: '/mocked' })]);
    await fetchText(page, '/mocked');
    await expect.poll(async () => (await localKey(serviceWorker, 'hits'))?.r1, { timeout: 5000 }).toBe(1);
    const ext = await openExtensionPage(context, extensionId);
    await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'DELETE_RULE', id: 'r1' }));
    await expect.poll(async () => (await localKey(serviceWorker, 'hits')) || {}, { timeout: 5000 }).not.toHaveProperty('r1');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test test/sw-events.spec.js`
Expected: FAIL — the service worker ignores all events (`log` stays empty, `counters` is `null`).

- [ ] **Step 3: Add the log, counter and hit code to `background.js`**

Append this block at the end of the file:

```js
// ── Per-tab log and counters ───────────────────────────────────────────────
const LOG_MAX = 200;
const SESSION_FLUSH_MS = 200;
const HITS_FLUSH_MS = 1000;

const tabs = new Map(); // tabId -> { log, counters: { mocked, issues }, dirty }
let flushTimer = 0;

// Events are processed one at a time, so a tab is never loaded twice concurrently.
let eventQueue = Promise.resolve();
function enqueue(fn) {
  eventQueue = eventQueue.then(fn).catch(() => {});
  return eventQueue;
}

async function loadTab(tabId) {
  let t = tabs.get(tabId);
  if (t) return t;
  const keys = [`log:${tabId}`, `tab:${tabId}`];
  const stored = await chrome.storage.session.get(keys); // survives a worker restart
  t = { log: stored[keys[0]] || [], counters: stored[keys[1]] || { mocked: 0, issues: 0 }, dirty: false };
  tabs.set(tabId, t);
  return t;
}

function markDirty(t) {
  t.dirty = true;
  if (!flushTimer) flushTimer = setTimeout(flushNow, SESSION_FLUSH_MS);
}

async function flushNow() {
  flushTimer = 0;
  const items = {};
  for (const [tabId, t] of tabs) {
    if (!t.dirty) continue;
    t.dirty = false;
    items[`log:${tabId}`] = t.log;
    items[`tab:${tabId}`] = t.counters;
  }
  if (Object.keys(items).length) await chrome.storage.session.set(items);
}

function addLog(t, entry) {
  t.log.push({ ts: Date.now(), ...entry });
  if (t.log.length > LOG_MAX) t.log.splice(0, t.log.length - LOG_MAX);
}

// Called after a tab's counters or log changed. Task 10 refreshes the badge here.
async function afterTabChange(_tabId) {}

// ── Hits ───────────────────────────────────────────────────────────────────
let hits = null; // Record<ruleId, number>, loaded lazily
let hitsTimer = 0;

async function loadHits() {
  if (!hits) hits = (await chrome.storage.local.get('hits')).hits || {};
  return hits;
}

function scheduleHitsFlush() {
  if (hitsTimer) return;
  hitsTimer = setTimeout(async () => {
    hitsTimer = 0;
    await chrome.storage.local.set({ hits });
  }, HITS_FLUSH_MS);
}

// ── Events from the bridge (content scripts only) ──────────────────────────
const ruleById = async (id) => (await readState()).rules.find((r) => r.id === id);

const EVENTS = {
  PAGE_START: async (_msg, { tabId, frameId }) => {
    if (frameId !== 0) return;
    const t = await loadTab(tabId);
    t.counters = { mocked: 0, issues: 0 };
    markDirty(t);
    await afterTabChange(tabId);
  },

  MOCK_EVENT: async (msg, { tabId }) => {
    const rule = await ruleById(msg.ruleId);
    const t = await loadTab(tabId);
    t.counters.mocked += 1;
    addLog(t, {
      kind: 'mock',
      method: msg.method,
      url: msg.url,
      ruleId: msg.ruleId,
      ruleName: rule && rule.name,
      status: msg.status,
      delay: rule && rule.response.delay,
    });
    markDirty(t);
    if (rule) {
      const h = await loadHits();
      h[rule.id] = (h[rule.id] || 0) + 1;
      scheduleHitsFlush();
    }
    await afterTabChange(tabId);
  },

  RULES_UNAVAILABLE: async (_msg, { tabId }) => {
    const t = await loadTab(tabId);
    t.counters.issues += 1;
    addLog(t, { kind: 'unavailable' });
    markDirty(t);
    await afterTabChange(tabId);
  },

  ENGINE_ERROR: async (msg, { tabId }) => {
    const rule = msg.ruleId ? await ruleById(msg.ruleId) : undefined;
    const t = await loadTab(tabId);
    t.counters.issues += 1;
    addLog(t, { kind: 'error', ruleId: msg.ruleId || undefined, ruleName: rule && rule.name, message: msg.message });
    markDirty(t);
    await afterTabChange(tabId);
  },
};

// ── Cleanup ────────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(async () => {
    tabs.delete(tabId);
    await chrome.storage.session.remove([`log:${tabId}`, `tab:${tabId}`]);
  });
});
```

- [ ] **Step 4: Update `MANAGEMENT` and the routing listener in `background.js`**

Replace the `DELETE_RULE` entry of `MANAGEMENT` with:

```js
  DELETE_RULE: ({ id }) =>
    withState((state) => {
      const before = state.rules.length;
      state.rules = state.rules.filter((r) => r.id !== id);
      return { state, result: { ok: true, removed: before - state.rules.length } };
    }).then(async (result) => {
      const h = await loadHits();
      if (id in h) {
        delete h[id];
        scheduleHitsFlush();
      }
      return result;
    }),
```

Add a `CLEAR_LOG` entry to `MANAGEMENT` (after `SET_GLOBAL`):

```js
  CLEAR_LOG: ({ tabId }) =>
    enqueue(async () => {
      if (!Number.isInteger(tabId)) return;
      const t = await loadTab(tabId);
      t.log = [];
      t.counters.issues = 0;
      markDirty(t);
      await afterTabChange(tabId);
    }).then(() => ({ ok: true })),
```

Replace the routing listener with:

```js
// ── Message routing ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg.type !== 'string') return false;

  const management = MANAGEMENT[msg.type];
  if (management) {
    if (!isExtensionPage(sender)) {
      respond({ ok: false, error: 'Not allowed' });
      return false;
    }
    management(msg).then(respond, (e) => respond({ ok: false, error: String((e && e.message) || e) }));
    return true; // keep the channel open for the async response
  }

  const event = EVENTS[msg.type];
  if (event && sender.tab && !isExtensionPage(sender)) {
    const ctx = { tabId: sender.tab.id, frameId: sender.frameId };
    enqueue(() => event(msg, ctx));
  }
  return false;
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx playwright test test/sw-events.spec.js test/sw-state.spec.js test/bridge.spec.js`
Expected: PASS. If the "tab closes" test fails, **spec assumption 1 is wrong** (`tabs.onRemoved` needs a permission): stop and report.

- [ ] **Step 6: Commit**

```bash
git add background.js test/sw-events.spec.js
git commit -m "feat(sw): per-tab log and counters, debounced hits, cleanup on tab close"
```

---

### Task 10: Toolbar icon, per-tab badge and tooltip

**Files:**
- Create: `shared/status.js`, `test/badge.spec.js`
- Modify: `background.js`

**Interfaces:**
- Consumes: `tabs`, `loadTab`, `enqueue`, `readState` and the `afterTabChange(tabId)` hook (Task 9).
- Produces (Plan 2's popup imports the same file and adds `computePopupStatus`):
  - `shared/status.js` exports `computeBadge({ globalEnabled, mocked?, issues? }) → { text, bg, color, title }` and `drawIcon(size, active) → ImageData`.
  - Badge priority (UI doc section 5): `OFF` (mocking off) > `!` (issues on this tab) > mocked count (`99+` above 99) > no badge.

    | State | text | bg | text color | title |
    |---|---|---|---|---|
    | off | `OFF` | `#4b5563` | `#ffffff` | `API Mock — Off` |
    | issues | `!` | `#ef4444` | `#ffffff` | `API Mock — N issue(s) on this tab` (`1 issue`, `2 issues`) |
    | mocked | count | `#10b981` | `#06281c` | `API Mock — Active · N mocked on this tab` |
    | none | empty | `#10b981` | `#06281c` | `API Mock — Active` |
  - Icon: amber `#f59e0b` with glyph `#1c1917` when on; grey `#4b5563` with glyph `#9ca3af` when off.
  - The service worker refreshes badges after every tab change, and everything (icon, global badge/title, all tabs) on install, on startup and whenever `globalEnabled` flips.
- Global fallback for tabs without an engine: global badge `OFF` (or empty) and title `API Mock — Off` / `API Mock — Active`.

- [ ] **Step 1: Write the failing test `test/badge.spec.js`**

```js
const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage } = require('./helpers');

const post = (page, message) => page.evaluate((m) => window.postMessage(m, '*'), message);
const fetchText = (page, url) => page.evaluate((u) => fetch(u).then((r) => r.text()), url);

test.describe('shared/status.js', () => {
  let ext;
  test.beforeEach(async ({ context, extensionId }) => {
    ext = await openExtensionPage(context, extensionId);
  });
  const run = (name, ...args) => ext.evaluate(async ([n, a]) => (await import('/shared/status.js'))[n](...a), [name, args]);

  test('computeBadge: priority OFF > ! > count > none', async () => {
    expect(await run('computeBadge', { globalEnabled: false, mocked: 5, issues: 2 })).toEqual({
      text: 'OFF', bg: '#4b5563', color: '#ffffff', title: 'API Mock — Off',
    });
    expect(await run('computeBadge', { globalEnabled: true, mocked: 5, issues: 1 })).toEqual({
      text: '!', bg: '#ef4444', color: '#ffffff', title: 'API Mock — 1 issue on this tab',
    });
    expect((await run('computeBadge', { globalEnabled: true, mocked: 0, issues: 2 })).title).toBe('API Mock — 2 issues on this tab');
    expect(await run('computeBadge', { globalEnabled: true, mocked: 3, issues: 0 })).toEqual({
      text: '3', bg: '#10b981', color: '#06281c', title: 'API Mock — Active · 3 mocked on this tab',
    });
    expect((await run('computeBadge', { globalEnabled: true, mocked: 150, issues: 0 })).text).toBe('99+');
    expect(await run('computeBadge', { globalEnabled: true })).toEqual({
      text: '', bg: '#10b981', color: '#06281c', title: 'API Mock — Active',
    });
  });

  test('drawIcon paints the amber (on) or grey (off) background', async () => {
    const pixel = (active) =>
      ext.evaluate(async (a) => {
        const { drawIcon } = await import('/shared/status.js');
        const img = drawIcon(16, a);
        const i = (8 * 16 + 2) * 4; // x = 2, y = 8: inside the rounded square, away from the glyph
        return Array.from(img.data.slice(i, i + 4));
      }, active);
    expect(await pixel(true)).toEqual([245, 158, 11, 255]);
    expect(await pixel(false)).toEqual([75, 85, 99, 255]);
  });
});

test.describe('service worker: badge and tooltip (spec assumption 8)', () => {
  const tabIdOf = async (sw) => {
    const s = await sw.evaluate(() => chrome.storage.session.get(null));
    const k = Object.keys(s).find((key) => key.startsWith('tab:'));
    return k ? Number(k.slice(4)) : null;
  };
  const badge = (sw, tabId) =>
    sw.evaluate(async (id) => ({
      text: await chrome.action.getBadgeText({ tabId: id }),
      bg: await chrome.action.getBadgeBackgroundColor({ tabId: id }),
      color: await chrome.action.getBadgeTextColor({ tabId: id }),
      title: await chrome.action.getTitle({ tabId: id }),
    }), tabId);

  test('follows mocked requests, issues, the global switch, clearing and reloading', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: [rule({ id: 'r1', url: '/mocked' })] });
    const ext = await openExtensionPage(context, extensionId);
    const send = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    const page = await context.newPage();
    await page.goto(server.origin + '/');
    await expect.poll(() => tabIdOf(serviceWorker)).not.toBeNull();
    const tabId = await tabIdOf(serviceWorker);

    await expect.poll(async () => (await badge(serviceWorker, tabId)).title).toBe('API Mock — Active');
    expect((await badge(serviceWorker, tabId)).text).toBe('');

    await fetchText(page, '/mocked');
    await expect.poll(async () => (await badge(serviceWorker, tabId)).text).toBe('1');
    expect(await badge(serviceWorker, tabId)).toEqual({
      text: '1', bg: [16, 185, 129, 255], color: [6, 40, 28, 255], title: 'API Mock — Active · 1 mocked on this tab',
    });

    await post(page, { type: '__API_MOCK__/ENGINE_ERROR', message: 'boom', ruleId: 'r1' });
    await expect.poll(async () => (await badge(serviceWorker, tabId)).text).toBe('!');
    expect((await badge(serviceWorker, tabId)).bg).toEqual([239, 68, 68, 255]);

    await send({ type: 'SET_GLOBAL', enabled: false });
    await expect.poll(async () => (await badge(serviceWorker, tabId)).text).toBe('OFF');
    expect(await badge(serviceWorker, tabId)).toMatchObject({ bg: [75, 85, 99, 255], title: 'API Mock — Off' });
    // The global badge (used by tabs without an engine) follows too.
    expect(await serviceWorker.evaluate(() => chrome.action.getBadgeText({}))).toBe('OFF');

    await send({ type: 'SET_GLOBAL', enabled: true });
    await expect.poll(async () => (await badge(serviceWorker, tabId)).text).toBe('!');
    expect(await serviceWorker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');

    await send({ type: 'CLEAR_LOG', tabId });
    await expect.poll(async () => (await badge(serviceWorker, tabId)).text).toBe('1');

    await page.reload();
    await expect.poll(async () => (await badge(serviceWorker, tabId)).text).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test test/badge.spec.js`
Expected: FAIL — `/shared/status.js` does not exist and the service worker sets no badge.

- [ ] **Step 3: Create `shared/status.js`**

```js
// Shared by the service worker and (Plan 2) the popup. Pure, except drawIcon (needs OffscreenCanvas).

// ── Badge ──────────────────────────────────────────────────────────────────
// Priority: mocking off > issues on this tab > mocked count > nothing.
export function computeBadge({ globalEnabled, mocked = 0, issues = 0 }) {
  if (!globalEnabled) return { text: 'OFF', bg: '#4b5563', color: '#ffffff', title: 'API Mock — Off' };
  if (issues > 0) {
    return { text: '!', bg: '#ef4444', color: '#ffffff', title: `API Mock — ${issues} issue${issues === 1 ? '' : 's'} on this tab` };
  }
  if (mocked > 0) {
    return {
      text: mocked > 99 ? '99+' : String(mocked),
      bg: '#10b981',
      color: '#06281c',
      title: `API Mock — Active · ${mocked} mocked on this tab`,
    };
  }
  return { text: '', bg: '#10b981', color: '#06281c', title: 'API Mock — Active' };
}

// ── Icon ───────────────────────────────────────────────────────────────────
// A rounded square with a ">" glyph, drawn at runtime (no PNG assets).
export function drawIcon(size, active) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const r = size * 0.22;

  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.arcTo(size, 0, size, r, r);
  ctx.lineTo(size, size - r);
  ctx.arcTo(size, size, size - r, size, r);
  ctx.lineTo(r, size);
  ctx.arcTo(0, size, 0, size - r, r);
  ctx.lineTo(0, r);
  ctx.arcTo(0, 0, r, 0, r);
  ctx.closePath();
  ctx.fillStyle = active ? '#f59e0b' : '#4b5563';
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(size * 0.3, size * 0.27);
  ctx.lineTo(size * 0.68, size * 0.5);
  ctx.lineTo(size * 0.3, size * 0.73);
  ctx.strokeStyle = active ? '#1c1917' : '#9ca3af';
  ctx.lineWidth = size * 0.115;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  return ctx.getImageData(0, 0, size, size);
}
```

- [ ] **Step 4: Wire icon and badge into `background.js`**

Add to the top of the file, below the existing import:

```js
import { computeBadge, drawIcon } from './shared/status.js';
```

Replace the `afterTabChange` stub from Task 9 (`async function afterTabChange(_tabId) {}`) with:

```js
// Called after a tab's counters or log changed.
async function afterTabChange(tabId) {
  await applyBadge(tabId, (await readState()).globalEnabled);
}
```

Append at the end of the file:

```js
// ── Icon and badge ─────────────────────────────────────────────────────────
async function updateIcon(enabled) {
  await chrome.action.setIcon({
    imageData: {
      16: drawIcon(16, enabled),
      32: drawIcon(32, enabled),
      48: drawIcon(48, enabled),
      128: drawIcon(128, enabled),
    },
  });
}

async function applyBadge(tabId, globalEnabled) {
  const t = await loadTab(tabId);
  const b = computeBadge({ globalEnabled, ...t.counters });
  await chrome.action.setBadgeText({ tabId, text: b.text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: b.bg });
  await chrome.action.setBadgeTextColor({ tabId, color: b.color });
  await chrome.action.setTitle({ tabId, title: b.title });
}

// Icon, the global badge/title (what tabs without an engine show) and every open tab.
async function refreshAll() {
  const { globalEnabled } = await readState();
  await updateIcon(globalEnabled);
  await chrome.action.setBadgeText({ text: globalEnabled ? '' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: '#4b5563' });
  await chrome.action.setTitle({ title: globalEnabled ? 'API Mock — Active' : 'API Mock — Off' });
  const all = await chrome.tabs.query({});
  await Promise.all(all.filter((tab) => tab.id !== undefined).map((tab) => applyBadge(tab.id, globalEnabled)));
}

chrome.runtime.onInstalled.addListener(() => enqueue(refreshAll));
chrome.runtime.onStartup.addListener(() => enqueue(refreshAll));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.state) return;
  const was = changes.state.oldValue ? changes.state.oldValue.globalEnabled !== false : true;
  const now = changes.state.newValue ? changes.state.newValue.globalEnabled !== false : true;
  if (was !== now) enqueue(refreshAll);
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx playwright test`
Expected: PASS for the whole suite. If `getBadgeTextColor` is missing or `tabs.query({})` throws, **spec assumption 8 is wrong**: stop and report.

- [ ] **Step 6: Commit**

```bash
git add shared/status.js background.js test/badge.spec.js
git commit -m "feat(sw): per-tab badge, tooltip and runtime-drawn icon"
```

---

### Task 11: Documentation, verification record and manual checks

**Files:**
- Create: `README.md`, `CLAUDE.md`, `MEMORY.md`

**Interfaces:**
- Consumes: the whole suite from Tasks 1–10.
- Produces: repo documentation that Plan 2 extends, and the recorded outcome of every spec assumption.

- [ ] **Step 1: Run the whole suite and record the result**

Run: `npx playwright test`
Expected: all tests PASS. Note the total number of tests; it goes into `MEMORY.md` below.

- [ ] **Step 2: Create `README.md`**

````markdown
# API Mock v2

A Chrome (Manifest V3, Chrome 111+) extension that answers `fetch` and `XMLHttpRequest` calls with responses you define: status, headers, body and delay. It works inside the page, so it is silent (no console output, no DOM changes) and needs no `debugger` permission.

> Status: the core is done (engine, bridge, service worker). The panel and popup UI are planned in `docs/superpowers/plans/2026-09-21-api-mock-v2-ui.md`.

## Install (developer mode)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Reload the extension card after editing any file.

## Try it without a UI

Open the extension's service worker console (`chrome://extensions` → API Mock v2 → *service worker*) and run:

```js
chrome.storage.local.set({ state: { version: 1, globalEnabled: true, rules: [{
  id: 'demo', enabled: true, name: 'Demo', method: 'ANY', url: '/api/demo',
  response: { status: 200, headers: [], body: '{"hello":"world"}', delay: 0 },
}] } });
```

Then, on any page, `fetch('/api/demo').then(r => r.json())` returns `{ hello: 'world' }`.

## URL patterns

| Pattern | Matches |
|---|---|
| `https://api.example.com/users` | that URL, with or without a query string |
| `https://api.example.com/*` | any path under that origin |
| `/api/users*` | that path on **any** origin, including relative `fetch('/api/users')` |
| `/search?q=*` | includes the query string in the comparison |

`*` matches any characters; everything else is literal. The first matching rule in the list wins. Method `ANY` matches all methods.

## Known limitations (accepted)

- Only `fetch` and `XMLHttpRequest` on the page's main thread. `<img>`, `<script>`, `<link>`, iframe navigation, `sendBeacon`, WebSocket, EventSource and requests made from Workers are not intercepted.
- Mocked requests do not appear in the DevTools Network tab (no real request is made). They are listed in the extension's own log.
- Tabs opened before the extension was installed or updated need a reload.

## Tests

```bash
npm install
npx playwright install chromium
npm test            # headless
npm run test:headed # watch the browser
```

Tests drive real Chromium with the unpacked extension. Google Chrome cannot be used: it ignores `--load-extension`.

## Layout

```
manifest.json   engine.js (MAIN world)   bridge.js (ISOLATED world)   background.js (service worker)
shared/         rule.js (schema, validation)   status.js (badge, icon)
test/           Playwright specs, local test server, fixtures
docs/superpowers/   specs/ (design), plans/ (implementation plans), ui/ (mockups)
```
````

- [ ] **Step 3: Create `CLAUDE.md`**

````markdown
# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

"API Mock v2": a Chrome MV3 extension that answers `fetch`/`XMLHttpRequest` calls with user-defined responses. Vanilla JS, no build step, no bundler. Design: `docs/superpowers/specs/`. Plans: `docs/superpowers/plans/`.

## Commands

- `npm install && npx playwright install chromium` (first time)
- `npm test` — whole e2e suite; `npx playwright test test/engine-fetch.spec.js` for one file; `npm run test:headed` to watch.
- Manual loop: `chrome://extensions` → Load unpacked → this folder; reload the card after edits. Service worker logs live behind the card's "service worker" link, not the page console.

## Architecture (trace a change across all three contexts)

```
Page (MAIN)          ISOLATED             Service worker
engine.js   ◀─RULES─ bridge.js  ◀─storage─ background.js
   └──events────────▶   └──runtime.sendMessage──▶   log · counters · hits · badge
```

- **engine.js** — classic script, MAIN world. Patches `fetch` and `XMLHttpRequest.prototype`; matches rules synchronously from memory; silent; fail-open; first (capture) `message` listener hides `RULES` from the page.
- **bridge.js** — classic script, ISOLATED. Pushes enabled rules (no names) to the engine; forwards sanitized events; answers `PING`. Everything from the page is untrusted.
- **background.js** — ES module service worker. Single writer of `storage.local.state` (`withState`); per-tab `log:<id>`/`tab:<id>` in `storage.session`; `hits` in `storage.local`; icon and badge.
- **shared/** — ES modules for the service worker, popup and panel only. `engine.js` and `bridge.js` cannot import anything.
- Message contract: engine ↔ bridge use `window.postMessage` with `type` prefix `__API_MOCK__/`; bridge → worker and UI → worker use `chrome.runtime.sendMessage` (see the table in the design spec, section 3).

## Conventions

- Flat layout; banner comments `// ── Section ──` inside files.
- Permissions stay at `storage` only. Do not add `tabs` or `host_permissions` without changing the spec first.
- The engine never logs and never touches the DOM. Do not add `console.*` to `engine.js`.
- Tests use `enginePage` (engine only, no extension) for gate/fail-open behaviour and the `context` fixture (real extension) for everything else.
- Never push; the user pushes. Commit identity is repo-local.

## Project memory

`MEMORY.md` records non-obvious findings and decisions. Read it at the start of a session; append a dated entry when you learn something a diff would not show.
````

- [ ] **Step 4: Create `MEMORY.md` and record the assumption results**

Create the file with this content, then replace each `<result>` marker **with the real outcome** taken from the test run (`verified` or `FAILED: <what happened>`). Do not leave any `<result>` in the committed file.

````markdown
# MEMORY.md

Running log of non-obvious technical findings and decisions. Append dated entries (one or two sentences plus the reason). Not a changelog.

## Technical discoveries

- **2026-09-21** — Real Google Chrome (branded) ignores `--load-extension`, so extension e2e tests must run in Playwright's Chromium (`channel: 'chromium'`). Found in the old API Mock Master project and reused here.

## Spec assumptions (design spec section 11), checked by the Core plan

- **2026-09-21** — 1. `storage` is the only permission needed; `sender.tab.id`, `tabs.onRemoved`, `tabs.query` work without `tabs`: <result>
- **2026-09-21** — 2. First capture listener + `stopImmediatePropagation()` hides `RULES` from page scripts: <result>
- **2026-09-21** — 3. Engine is ready before the page's first script; bridge → engine channel works at `document_start`: <result>
- **2026-09-21** — 5. `Object.defineProperty(response, 'url', …)` works on a constructed `Response`: <result>
- **2026-09-21** — 6. Synthetic XHR events fire `on*` handler properties: <result>
- **2026-09-21** — 7. `world: "MAIN"` content scripts work on Chrome 111+ (tested on the installed Chromium): <result>
- **2026-09-21** — 8. `tabs.sendMessage` to a tab and `setBadgeTextColor` work without `tabs`: <result>

## Key decisions

- **2026-09-21** — The engine's `RULES` listener uses the capture phase: at the target, capture listeners run before bubble listeners, so a bubble-phase engine listener could not hide the message from a page's capture listener.
- **2026-09-21** — Gate, fail-open and privacy tests use a plain Chromium page with only `engine.js` injected (`enginePage`): with the real bridge present, `RULES` arrive within milliseconds and the startup gate could never be observed.
- **2026-09-21** — A `MOCK_EVENT` is emitted when a rule matches, before the delay, as the spec says. If building the response then fails, an `ENGINE_ERROR` follows for the same request (rare; accepted).
````

- [ ] **Step 5: Manual checks (Playwright cannot verify these)**

Load the unpacked extension in a normal Chrome window and check:

1. The toolbar icon is amber; after `chrome.storage.local.set({ state: { version: 1, globalEnabled: false, rules: [] } })` in the service worker console it turns grey and the badge shows `OFF`.
2. With the demo rule from the README active, `fetch('/api/demo')` on any page returns the mock, and the badge on that tab shows `1`.
3. `chrome://extensions` → API Mock v2 → *Errors*: no errors are listed.
4. Open `chrome://serviceworker-internals`, stop the extension's worker, then trigger another mocked request: the badge and the counters (`chrome.storage.session.get(null)` in the service worker console) keep their values.

Write the outcome of each check as one dated line in `MEMORY.md` under "Technical discoveries".

- [ ] **Step 6: Commit**

```bash
git add README.md CLAUDE.md MEMORY.md
git commit -m "docs: add README, CLAUDE.md and the verification record for the core"
```

## Self-review of this plan against the spec

- **Spec sections 3–5, 7 (architecture, data model, engine, security):** Tasks 2–9. Engine matching (Task 3), faithful fetch (4), XHR (5), gate/fail-open/silence/privacy (6), bridge with sanitising and rate limit (7), single-writer state (8), log/counters/hits/cleanup (9).
- **Spec section 6.3 (icon and badge) and UI doc section 5:** Task 10. The panel and popup (spec 6.1, 6.2, 6.4 and the UI doc) are Plan 2.
- **Spec section 9 (error handling):** engine and bridge behaviour in Tasks 6–7; service worker validation `{ ok: false, errors }` in Task 8; debounce loss accepted in Task 9. The `version` guard for a newer schema is not implemented (there is only version 1); it is deferred until a version 2 exists.
- **Spec section 10 tests 1–6 and 8:** conformance (Task 4), URL matching (3), startup race (7), fail-open and silence (6), live update and hits not rewriting state (7, 9), privacy (6, 7), popup/badge (10; the popup half is in Plan 2). Test 7 (UI smoke) is Plan 2.
- **Spec section 11 (assumptions):** each is verified by a named test (table at the top).
