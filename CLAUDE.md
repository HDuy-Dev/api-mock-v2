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

## UI (panel and popup)

- Plain ES-module pages, no build. The DevTools panel is `panel/panel.html` (registered by `devtools.js`); the popup is `popup/popup.html`.
- **Reads** come straight from `chrome.storage` (`shared/store.js#readAll`, re-run on `subscribe`); **writes** are service-worker messages (`SAVE_RULE`, `DELETE_RULE`, `REORDER`, `SET_GLOBAL`, `CLEAR_LOG`). The UI never writes `state`.
- `shared/dom.js#h()` builds DOM. **Never** use `innerHTML` with data: rule names, URLs and log entries are untrusted.
- Panel modules: `panel.js` (bar, list, wiring), `editor.js` (form, validation, 700 ms auto-save, drafts), `menu.js` (⋮ menu, delete dialog), `log.js` (log view), `ui.js` (UI-only state: selection, search, drafts). Drafts (new rules that are not valid yet) live only in memory; after a save the panel calls `api.refresh()` before dropping the draft.
- Test hooks: `panel/panel.html?tabId=<id>` and `popup/popup.html?tabId=<id>` target a tab; in real DevTools the panel uses `chrome.devtools.inspectedWindow.tabId`. `openExtensionPage()` in tests opens `devtools.html` by default (a neutral extension page).
- Styling: tokens and shared components in `shared/ui.css` (visual style B, see the UI design doc).

## Conventions

- Flat layout; banner comments `// ── Section ──` inside files.
- Permissions stay at `storage` only. Do not add `tabs` or `host_permissions` without changing the spec first.
- The engine never logs and never touches the DOM. Do not add `console.*` to `engine.js`.
- Tests use `enginePage` (engine only, no extension) for gate/fail-open behaviour and the `context` fixture (real extension) for everything else.
- Never push; the user pushes. Commit identity is repo-local.

## Project memory

`MEMORY.md` records non-obvious findings and decisions. Read it at the start of a session; append a dated entry when you learn something a diff would not show.
