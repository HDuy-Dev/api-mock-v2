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
