# API Mock v2

A Chrome (Manifest V3, Chrome 111+) extension that answers `fetch` and `XMLHttpRequest` calls with responses you define: status, headers, body and delay. It works inside the page, so it is silent (no console output, no DOM changes) and needs no `debugger` permission.

> Status: the core (engine, bridge, service worker) and the UI (DevTools panel, popup) are implemented.

## Install (developer mode)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Reload the extension card after editing any file.

## Using it

1. Open DevTools (F12) on the page you are working on and select the **API Mock** tab.
2. Click **+ Add rule**. Fill in the URL pattern (see below), method, status, delay, headers and body. Rules save automatically; a red *Not applied* / *Unsaved edits* label means the last edit is invalid and is not in use yet.
3. Reload nothing: matching `fetch`/`XHR` calls on the page are answered right away. Mocked requests do **not** appear in the Network tab — watch the **Log** at the bottom of the panel instead.
4. The toolbar icon opens a small control: the global on/off switch, a per-rule switch, and a status line for the current tab. The badge shows how many requests were mocked on the tab (`!` when something went wrong, `OFF` when mocking is off).

## Seeding a rule from the service worker console (debugging)

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
