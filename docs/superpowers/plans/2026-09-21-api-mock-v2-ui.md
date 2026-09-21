# API Mock v2 — UI Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the user interface of "API Mock v2" on top of the finished core: the DevTools panel "API Mock" (rules list, editor, log), the toolbar popup (quick control with a per-tab status strip), and an end-to-end test that creates a rule through the UI and sees it mock a real page.

**Architecture:** Panel and popup are plain ES-module pages. They **read** `state`, `hits`, `log:<tabId>` and `tab:<tabId>` straight from `chrome.storage` and re-render on `storage.onChanged`; every **write** is a message to the service worker (`SAVE_RULE`, `DELETE_RULE`, `REORDER`, `SET_GLOBAL`, `CLEAR_LOG`). DOM is built with a tiny `h()` helper (never `innerHTML`), styled by one shared token stylesheet (visual style B).

**Tech Stack:** Vanilla JS ES modules, CSS custom properties, no build step; tests with `@playwright/test` driving real Chromium (already set up by Plan 1).

**Spec:** [`../specs/2026-09-21-api-mock-v2-ui-design.md`](../specs/2026-09-21-api-mock-v2-ui-design.md) (visual style, states, strings, accessibility) and [`../specs/2026-09-21-api-mock-v2-design.md`](../specs/2026-09-21-api-mock-v2-design.md) (section 6 contracts). Mockups: `docs/superpowers/ui/*.html`.

**Prerequisite:** Plan 1 (`2026-09-21-api-mock-v2-core.md`) is complete and `npm test` passes.

## Global Constraints

Copied from the specs. Every task's requirements implicitly include this section.

- **Visual style B** (UI doc section 2): `--bg #1a1d27`, `--surface #21253a`, `--input #181b28`, `--code #141720`, `--bd #2e3350`, `--bd-soft #252840`, `--tx #e2e4f0`, `--mu #8a8fb0`, `--ac #f59e0b`, `--ac-tx #1a1d27`, `--ok #10b981`, `--warn #f59e0b`, `--err #ef4444`, `--err-text #f87171` (small error text). Method colors: GET `#10b981`, POST `#f59e0b`, PUT `#3b82f6`, PATCH `#8b5cf6`, DELETE `#ef4444`, HEAD `#06b6d4`, OPTIONS `#9ca3af`, ANY `--mu`. Labels: DELETE → `DEL`, OPTIONS → `OPT`. `system-ui` 13px; monospace 11.5px for code, URLs, method badges, statuses; field labels 10.5px uppercase, letter-spacing 0.04em. Radius 6px (controls). Popup width 380px.
- **UI strings are English** and exactly as in the UI doc (`No rules yet`, `+ Add rule`, `✓ Saved`, `● Not saved — fix N errors`, `URL is required`, `Must be 200–599`, `Must be 0–60000`, …).
- **No `innerHTML`, `outerHTML` assignment or `insertAdjacentHTML` with any data.** Rule names, URLs and log entries are untrusted; build DOM with `shared/dom.js#h` and text nodes.
- Reads from storage, writes only via service-worker messages. The UI never writes `state` directly.
- Permissions stay `storage` only. The manifest gains only `devtools_page`.
- Accessibility: switches are `<button role="switch" aria-checked>`; visible focus ring (2px `--ac`, offset 1px); interactive elements at least 24px high; colour is never the only signal.
- Auto-save debounce **700 ms**. Log shows at most 200 entries (the service worker caps it). The popup search box appears only when there are **more than 5** rules.
- Test hook: panel and popup accept `?tabId=<id>` to target a tab. In real DevTools the panel uses `chrome.devtools.inspectedWindow.tabId`; the real popup uses the active tab.
- Git: commit after each task with the repo-local identity that is already configured. **Never push**; the user pushes.

## File Structure

```
manifest.json               # Task 1: + "devtools_page"
devtools.html, devtools.js  # Task 1: registers the "API Mock" DevTools panel
shared/
  rule.js                   # Task 1: + methodLabel()
  status.js                 # Task 1: + computePopupStatus()
  dom.js                    # Task 1: h(), clear()
  store.js                  # Task 1: readAll(), subscribe(), send()
  ui.css                    # Task 1: tokens + shared components
popup/popup.html, popup.css, popup.js       # Task 2 (replaces the Plan 1 placeholder)
panel/panel.html, panel.css, panel.js       # Task 3 shell + list; Tasks 4–6 extend
panel/editor.js                             # Tasks 4–5
panel/log.js                                # Task 6
test/
  helpers.js                                # Task 1: + tabIdOf(), openPageWithTab()
  ui-foundation.spec.js                     # Task 1
  popup.spec.js                             # Task 2
  panel-list.spec.js                        # Task 3
  panel-editor.spec.js                      # Task 4
  panel-actions.spec.js                     # Task 5
  panel-log.spec.js                         # Task 6
  e2e-ui.spec.js                            # Task 7
```

## Spec assumption verified by this plan

| # | Assumption | Verified in |
|---|---|---|
| 4 | Panel and popup can read `storage.session` and receive `onChanged` from it | Task 1 (store test), Task 6 (log) |

If it fails, stop and report; do not work around it.

---

### Task 1: Shared UI foundation and DevTools panel registration

**Files:**
- Create: `shared/dom.js`, `shared/store.js`, `shared/ui.css`, `devtools.html`, `devtools.js`, `panel/panel.html` (shell), `test/ui-foundation.spec.js`
- Modify: `shared/rule.js` (add `methodLabel`), `shared/status.js` (add `computePopupStatus`), `manifest.json`, `test/helpers.js`

**Interfaces:**
- Consumes: `defaultState()` from `shared/rule.js`; the service-worker messages of Plan 1.
- Produces (used by every later task):
  - `shared/dom.js`: `h(tag, props?, ...children) → HTMLElement`. `props`: `class`, `dataset` (object), `on<event>` functions, DOM properties (`value`, `checked`, `disabled`, `title`, `type`, `placeholder`, `hidden`, …) and anything else as an attribute (`aria-*`, `role`). `undefined`, `null` and `false` props/children are skipped; arrays are flattened; strings become text nodes (HTML is never interpreted). `clear(el) → el` empties an element.
  - `shared/store.js`: `readAll(tabId | null) → { state, hits, log, tab }` (`state` defaults to `defaultState()`, `hits` to `{}`, `log` to `[]`, `tab` to `{ mocked: 0, issues: 0 }`); `subscribe(tabId | null, onChange) → unsubscribe` (fires on changes of `state` or `hits` in `local`, and of `log:<tabId>` or `tab:<tabId>` in `session`); `send(message) → Promise<response>` (`chrome.runtime.sendMessage`).
  - `shared/rule.js`: `methodLabel(method) → string` (`DELETE` → `DEL`, `OPTIONS` → `OPT`, others unchanged).
  - `shared/status.js`: `computePopupStatus({ globalEnabled, reachable, issues?, mocked?, ruleCount? }) → { kind: 'ok' | 'off' | 'warn', title, detail }`, first matching condition wins: off → not reachable → issues → no rules → active.
  - `shared/ui.css`: the token variables and the shared classes `.mth` (method badge, add the method name as a second class), `.tg` (switch; `.on`), `.hit`, `.btn` (`.pri`, `.danger`), `.sp`, `.mu`, `.hidden`.
  - `test/helpers.js`: `tabIdOf(serviceWorker) → Promise<number | null>` and `openPageWithTab(context, server, serviceWorker, path?) → Promise<{ page, tabId }>` (opens a real page with the bridge and waits until the service worker knows its tab).
  - `devtools.html` loads `devtools.js`, which registers the panel `API Mock` → `panel/panel.html` only when `chrome.devtools.panels` exists.

- [ ] **Step 1: Add the helpers to `test/helpers.js`**

Before `module.exports`, add:

```js
/** The id of the (single) tab the service worker keeps counters for. */
async function tabIdOf(serviceWorker) {
  const s = await serviceWorker.evaluate(() => chrome.storage.session.get(null));
  const key = Object.keys(s).find((k) => k.startsWith('tab:'));
  return key ? Number(key.slice(4)) : null;
}

/** Opens a real page (with the bridge) and waits until the service worker has registered its tab. */
async function openPageWithTab(context, server, serviceWorker, path = '/') {
  const page = await context.newPage();
  await page.goto(server.origin + path);
  let tabId = null;
  for (let i = 0; i < 50 && tabId === null; i++) {
    tabId = await tabIdOf(serviceWorker);
    if (tabId === null) await page.waitForTimeout(100);
  }
  return { page, tabId };
}
```

and change the export to:

```js
module.exports = { rule, setState, pushRules, openExtensionPage, tabIdOf, openPageWithTab };
```

- [ ] **Step 2: Write the failing test `test/ui-foundation.spec.js`**

```js
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx playwright test test/ui-foundation.spec.js`
Expected: FAIL — no `devtools_page`, `devtools.html` is missing, and the new modules do not exist.

- [ ] **Step 4: Add `methodLabel` to `shared/rule.js`**

Append below the `// ── Helpers ──` functions (before `// ── Headers`):

```js
const SHORT_METHOD = { DELETE: 'DEL', OPTIONS: 'OPT' };
export function methodLabel(method) {
  return SHORT_METHOD[method] || method;
}
```

- [ ] **Step 5: Add `computePopupStatus` to `shared/status.js`**

Append:

```js
// ── Popup status strip ─────────────────────────────────────────────────────
// First matching condition wins: off → not reachable → issues → no rules → active.
export function computePopupStatus({ globalEnabled, reachable, issues = 0, mocked = 0, ruleCount = 0 }) {
  if (!globalEnabled) return { kind: 'off', title: 'Off', detail: 'requests go straight to the network' };
  if (!reachable) {
    return {
      kind: 'warn',
      title: 'Not active on this tab yet',
      detail: 'This tab was opened before the extension started — reload it to begin mocking. Not available on chrome:// pages or the Chrome Web Store.',
    };
  }
  if (issues > 0) {
    return {
      kind: 'warn',
      title: `${issues} issue${issues === 1 ? '' : 's'} on this tab`,
      detail: 'Something went wrong on this tab. Details: DevTools → API Mock → Log. Reloading the page often helps.',
    };
  }
  if (ruleCount === 0) return { kind: 'ok', title: 'Active', detail: 'no rules yet' };
  return { kind: 'ok', title: 'Active', detail: mocked > 0 ? `${mocked} mocked on this tab` : 'nothing mocked on this tab yet' };
}
```

- [ ] **Step 6: Create `shared/dom.js`**

```js
// Tiny DOM helper. Text is always inserted as text nodes: HTML in data is never interpreted.

/** h('div', { class: 'row', onclick }, child, 'text', [more]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key !== 'style' && key !== 'list' && key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}
```

- [ ] **Step 7: Create `shared/store.js`**

```js
// Reads extension state straight from storage and re-notifies on change. Writes go through the service worker.
import { defaultState } from './rule.js';

export async function readAll(tabId) {
  const keys = tabId == null ? [] : [`log:${tabId}`, `tab:${tabId}`];
  const [local, session] = await Promise.all([
    chrome.storage.local.get(['state', 'hits']),
    keys.length ? chrome.storage.session.get(keys) : {},
  ]);
  return {
    state: local.state || defaultState(),
    hits: local.hits || {},
    log: (keys.length && session[keys[0]]) || [],
    tab: (keys.length && session[keys[1]]) || { mocked: 0, issues: 0 },
  };
}

/** Calls onChange when state, hits or this tab's log/counters change. Returns an unsubscribe function. */
export function subscribe(tabId, onChange) {
  const listener = (changes, area) => {
    if (area === 'local' && ('state' in changes || 'hits' in changes)) onChange();
    else if (area === 'session' && tabId != null && (`log:${tabId}` in changes || `tab:${tabId}` in changes)) onChange();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export const send = (message) => chrome.runtime.sendMessage(message);
```

- [ ] **Step 8: Create `shared/ui.css`**

```css
/* Tokens and shared components for the panel and the popup (UI doc, visual style B). */
:root {
  --bg: #1a1d27; --surface: #21253a; --input: #181b28; --code: #141720;
  --bd: #2e3350; --bd-soft: #252840; --tx: #e2e4f0; --mu: #8a8fb0;
  --ac: #f59e0b; --ac-tx: #1a1d27; --ok: #10b981; --warn: #f59e0b; --err: #ef4444; --err-text: #f87171;
  --tg-off: #2e3350; --r: 6px;
  --get: #10b981; --post: #f59e0b; --put: #3b82f6; --patch: #8b5cf6; --delete: #ef4444; --head: #06b6d4; --options: #9ca3af; --any: #8a8fb0;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: var(--bg); color: var(--tx); font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; }
.mono, pre, textarea, .mth, .ur, .u, .t { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; }
button { font: inherit; color: inherit; cursor: pointer; }
:focus-visible { outline: 2px solid var(--ac); outline-offset: 1px; }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-thumb { background: var(--bd); border-radius: 4px; }
.sp { flex: 1; }
.mu { color: var(--mu); }
.hidden { display: none !important; }

/* Method badge: <span class="mth GET">GET</span> */
.mth { flex: none; min-width: 40px; text-align: center; font-size: 9.5px; font-weight: 700; letter-spacing: 0.03em; padding: 3px 0; border-radius: 3px; color: var(--c, var(--mu)); background: color-mix(in srgb, var(--c, var(--mu)) 15%, transparent); }
.mth.GET { --c: var(--get); } .mth.POST { --c: var(--post); } .mth.PUT { --c: var(--put); } .mth.PATCH { --c: var(--patch); }
.mth.DELETE { --c: var(--delete); } .mth.HEAD { --c: var(--head); } .mth.OPTIONS { --c: var(--options); } .mth.ANY { --c: var(--any); }

/* Switch: <button class="tg on" role="switch" aria-checked="true"> */
.tg { position: relative; flex: none; width: 28px; height: 16px; border: 0; border-radius: 9px; background: var(--tg-off); }
.tg::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; }
.tg.on { background: var(--ac); }
.tg.on::after { left: 14px; }

.hit { min-width: 20px; text-align: center; font-size: 10px; padding: 1px 5px; border-radius: 9px; background: var(--bd-soft); color: var(--mu); }
.btn { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; background: transparent; border: 1px solid var(--bd); border-radius: var(--r); font-size: 11px; }
.btn.pri { background: var(--ac); border-color: transparent; color: var(--ac-tx); font-weight: 600; }
.btn.danger { color: var(--err-text); border-color: color-mix(in srgb, var(--err) 40%, transparent); }
```

- [ ] **Step 9: Create `devtools.html` and `devtools.js`, a panel shell, and update `manifest.json`**

`devtools.html`:
```html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>API Mock devtools</title></head>
  <body><script src="devtools.js"></script></body>
</html>
```

`devtools.js`:
```js
// Registers the panel. chrome.devtools exists only inside a DevTools window.
if (chrome.devtools && chrome.devtools.panels) {
  chrome.devtools.panels.create('API Mock', '', 'panel/panel.html');
}
```

`panel/panel.html` (shell; Task 3 replaces it):
```html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>API Mock</title><link rel="stylesheet" href="../shared/ui.css" /></head>
  <body><div id="app">API Mock</div></body>
</html>
```

In `manifest.json` add, next to `"background"`:
```json
  "devtools_page": "devtools.html",
```

- [ ] **Step 10: Run to verify it passes**

Run: `npx playwright test test/ui-foundation.spec.js`
Expected: PASS. If a `storage.session` read or `onChanged` assertion fails, **spec assumption 4 is wrong**: stop and report.

- [ ] **Step 11: Commit**

```bash
git add manifest.json devtools.html devtools.js panel shared test
git commit -m "feat(ui): shared DOM/store helpers, tokens, popup status logic and devtools registration"
```

---

### Task 2: Popup — quick control with a per-tab status strip

**Files:**
- Replace: `popup/popup.html` (the Plan 1 placeholder)
- Create: `popup/popup.css`, `popup/popup.js`, `test/popup.spec.js`
- Modify: `test/helpers.js` (default page of `openExtensionPage`)

**Interfaces:**
- Consumes: `h`, `clear` (`shared/dom.js`), `readAll`, `subscribe`, `send` (`shared/store.js`), `computePopupStatus` (`shared/status.js`), `methodLabel` (`shared/rule.js`); service-worker messages `SAVE_RULE` (a rule's switch sends the whole rule with `enabled` flipped) and `SET_GLOBAL`; the bridge's `PING`.
- Produces (selectors the tests below rely on): `.head` (with the global switch `.head .tg`), `.status` (class `ok`, `off` or `warn`), `.search` (with an `input`), `.list` (`.dim` when mocking is off) containing `.row` (`.off` when the rule is disabled; children `.mth`, `.nm`, `.ur`, `.hit`, `.tg`), `.none`, `.foot`.
- Behaviour (UI doc section 4): the status strip follows `computePopupStatus`; the search box appears only with more than 5 rules; with no rules the list shows the "open DevTools" hint and the footer reminds that mocked requests do not appear in the Network tab. The popup checks the tab once, at open, by sending `PING` to frame 0; no answer means "Not active on this tab yet". Test hook: `?tabId=<id>` targets that tab instead of the active one.

- [ ] **Step 1: Make generic-page tests independent of the real popup**

In `test/helpers.js` change the default of `openExtensionPage` so it opens a neutral extension page:

```js
async function openExtensionPage(context, extensionId, pagePath = 'devtools.html') {
```

- [ ] **Step 2: Write the failing test `test/popup.spec.js`**

```js
const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage, openPageWithTab } = require('./helpers');

const RULES = () => [
  rule({ id: 'a', name: 'Users list', method: 'GET', url: '/api/users*' }),
  rule({ id: 'b', name: 'Login', method: 'POST', url: '/api/login' }),
  rule({ id: 'c', name: 'Orders', method: 'GET', url: 'https://shop.dev/api/orders/*', enabled: false }),
  rule({ id: 'd', name: 'Delete user', method: 'DELETE', url: '/api/users/*' }),
];

async function openPopup(context, extensionId, tabId) {
  return openExtensionPage(context, extensionId, `popup/popup.html?tabId=${tabId}`);
}
const stored = (sw) => sw.evaluate(() => chrome.storage.local.get('state').then((r) => r.state));

test.describe('popup', () => {
  test('active: lists rules with method labels, hits and disabled styling; follows mocked requests live', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    await serviceWorker.evaluate(() => chrome.storage.local.set({ hits: { a: 3 } }));
    const { page, tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);

    await expect(popup.locator('.status')).toHaveClass(/\bok\b/);
    await expect(popup.locator('.status')).toContainText('Active · nothing mocked on this tab yet');
    await expect(popup.locator('.row')).toHaveCount(4);
    await expect(popup.locator('.row').nth(0).locator('.nm')).toHaveText('Users list');
    await expect(popup.locator('.row').nth(0).locator('.hit')).toHaveText('3');
    await expect(popup.locator('.row').nth(3).locator('.mth')).toHaveText('DEL');
    await expect(popup.locator('.row').nth(2)).toHaveClass(/\boff\b/);
    await expect(popup.locator('.foot')).toContainText('Edit rules: DevTools → API Mock tab');
    await expect(popup.locator('.search')).toBeHidden();

    await page.evaluate(() => fetch('/api/users'));
    await expect(popup.locator('.status')).toContainText('Active · 1 mocked on this tab');
  });

  test('off: dimmed list, grey status and an unchecked global switch', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { globalEnabled: false, rules: RULES() });
    const { tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    await expect(popup.locator('.status')).toHaveClass(/\boff\b/);
    await expect(popup.locator('.status')).toContainText('Off · requests go straight to the network');
    await expect(popup.locator('.list')).toHaveClass(/\bdim\b/);
    await expect(popup.locator('.head .tg')).toHaveAttribute('aria-checked', 'false');
  });

  test('issue: an engine error shows a warning with the count', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const { page, tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    await page.evaluate(() => window.postMessage({ type: '__API_MOCK__/ENGINE_ERROR', message: 'boom', ruleId: 'a' }, '*'));
    await expect(popup.locator('.status')).toHaveClass(/\bwarn\b/);
    await expect(popup.locator('.status')).toContainText('1 issue on this tab');
  });

  test('a tab without an engine says it is not active yet', async ({ context, extensionId, serviceWorker }) => {
    await setState(serviceWorker, { rules: RULES() });
    const other = await openExtensionPage(context, extensionId); // extension pages have no content scripts
    const otherId = await other.evaluate(() => chrome.tabs.getCurrent().then((t) => t.id));
    const popup = await openPopup(context, extensionId, otherId);
    await expect(popup.locator('.status')).toHaveClass(/\bwarn\b/);
    await expect(popup.locator('.status')).toContainText('Not active on this tab yet');
  });

  test('empty: no rules shows the DevTools hint and the Network-tab reminder', async ({ context, server, serviceWorker, extensionId }) => {
    const { tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    await expect(popup.locator('.status')).toContainText('Active · no rules yet');
    await expect(popup.locator('.none')).toContainText('No rules yet.');
    await expect(popup.locator('.none')).toContainText('+ Add rule');
    await expect(popup.locator('.foot')).toHaveText("Mocked requests won't appear in the Network tab.");
  });

  test('the search box appears only with more than 5 rules and filters by name or URL', async ({ context, server, serviceWorker, extensionId }) => {
    const five = RULES().concat(rule({ id: 'e', name: 'Extra', url: '/extra' })); // 5 rules
    await setState(serviceWorker, { rules: five });
    const { tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    await expect(popup.locator('.row')).toHaveCount(5);
    await expect(popup.locator('.search')).toBeHidden();

    await setState(serviceWorker, { rules: five.concat(rule({ id: 'f', name: 'Sixth', url: '/sixth' })) });
    await expect(popup.locator('.search')).toBeVisible();
    await popup.locator('.search input').fill('login');
    await expect(popup.locator('.row')).toHaveCount(1);
    await expect(popup.locator('.row .nm')).toHaveText('Login');
    await popup.locator('.search input').fill('shop.dev');
    await expect(popup.locator('.row .nm')).toHaveText('Orders');
    await popup.locator('.search input').fill('zzz');
    await expect(popup.locator('.none')).toHaveText('No rules match "zzz".');
    await popup.locator('.search input').fill('');
    await expect(popup.locator('.row')).toHaveCount(6);
  });

  test('a rule switch enables or disables that rule', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const { tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    const first = popup.locator('.row').nth(0);
    await first.locator('.tg').click();
    await expect(first).toHaveClass(/\boff\b/);
    await expect(first.locator('.tg')).toHaveAttribute('aria-checked', 'false');
    expect((await stored(serviceWorker)).rules.find((r) => r.id === 'a').enabled).toBe(false);
  });

  test('the global switch turns mocking off and on', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const { tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    await popup.locator('.head .tg').click();
    await expect(popup.locator('.status')).toContainText('Off · requests go straight to the network');
    expect((await stored(serviceWorker)).globalEnabled).toBe(false);
    await popup.locator('.head .tg').click();
    await expect(popup.locator('.status')).toContainText('Active');
    expect((await stored(serviceWorker)).globalEnabled).toBe(true);
  });

  test('rule names are text, never HTML', async ({ context, server, serviceWorker, extensionId }) => {
    const evil = '<img src=x onerror="window.__xss=1">';
    await setState(serviceWorker, { rules: [rule({ id: 'x', name: evil, url: '/x' })] });
    const { tabId } = await openPageWithTab(context, server, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    await expect(popup.locator('.row .nm')).toHaveText(evil);
    expect(await popup.evaluate(() => window.__xss)).toBeUndefined();
    expect(await popup.locator('.row img').count()).toBe(0);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx playwright test test/popup.spec.js`
Expected: FAIL — the popup is still the Plan 1 placeholder (no `.status`, no rows).

- [ ] **Step 4: Create `popup/popup.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>API Mock</title>
    <link rel="stylesheet" href="../shared/ui.css" />
    <link rel="stylesheet" href="popup.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `popup/popup.css`**

```css
html, body { width: 380px; }
#app { overflow: hidden; }

.head { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 12px; background: var(--surface); border-bottom: 1px solid var(--bd); }
.head .logo { width: 20px; height: 20px; color: var(--ac); flex: none; }
.head.off .logo { color: #6b7280; }
.head .t { font-weight: 600; }
.head .lbl { font-size: 11px; color: var(--mu); }
.head .tg { width: 32px; height: 18px; border-radius: 10px; }
.head .tg::after { width: 14px; height: 14px; }
.head .tg.on::after { left: 16px; }

.status { display: flex; align-items: flex-start; gap: 9px; padding: 9px 12px; font-size: 12px; border-bottom: 1px solid var(--bd-soft); }
.status .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; }
.status small { display: block; margin-top: 2px; font-size: 11px; line-height: 1.45; color: var(--mu); }
.status.ok { background: color-mix(in srgb, var(--ok) 9%, transparent); }
.status.ok .dot { background: var(--ok); }
.status.off { background: var(--bd-soft); }
.status.off .dot { background: #6b7280; }
.status.warn { background: color-mix(in srgb, var(--warn) 11%, transparent); }
.status.warn .dot { background: var(--warn); }

.search { padding: 8px 12px; border-bottom: 1px solid var(--bd-soft); }
.search input { width: 100%; height: 26px; padding: 0 8px; background: var(--input); color: var(--tx); border: 1px solid var(--bd); border-radius: var(--r); }

.list { max-height: 340px; overflow: auto; }
.list.dim { opacity: 0.5; }
.row { display: flex; align-items: center; gap: 8px; height: 46px; padding: 0 12px; border-bottom: 1px solid var(--bd-soft); }
.row.off .txt, .row.off .mth { opacity: 0.4; }
.txt { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.nm { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ur { font-size: 10.5px; color: var(--mu); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.none { padding: 26px 20px; text-align: center; color: var(--mu); font-size: 12px; }
.none b, .foot b { color: var(--tx); }

.foot { padding: 9px 12px; font-size: 11.5px; color: var(--mu); background: var(--surface); border-top: 1px solid var(--bd); }
```

- [ ] **Step 6: Create `popup/popup.js`**

```js
import { h, clear } from '../shared/dom.js';
import { readAll, subscribe, send } from '../shared/store.js';
import { computePopupStatus } from '../shared/status.js';
import { methodLabel } from '../shared/rule.js';

const SEARCH_MIN_RULES = 6; // the search box appears when there are more than 5 rules
const params = new URLSearchParams(location.search); // test hook: ?tabId=<id> overrides the active tab

let tabId = null;
let reachable = false;
let query = '';
let seq = 0;

// ── Tab and liveness ───────────────────────────────────────────────────────
async function resolveTabId() {
  if (params.has('tabId')) return Number(params.get('tabId'));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

// The bridge answers PING only in tabs where the extension's content scripts run.
async function ping(id) {
  if (id == null) return false;
  try {
    const res = await chrome.tabs.sendMessage(id, { type: 'PING' }, { frameId: 0 });
    return Boolean(res && res.ok);
  } catch (_) {
    return false;
  }
}

// ── View pieces ────────────────────────────────────────────────────────────
const SVG = 'http://www.w3.org/2000/svg';
function logo() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.classList.add('logo');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M8 9l3 3-3 3M13 15h3M3 5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5z');
  svg.append(path);
  return svg;
}

function toggle(on, label, onClick) {
  return h('button', {
    class: 'tg' + (on ? ' on' : ''),
    type: 'button',
    role: 'switch',
    'aria-checked': String(on),
    'aria-label': label,
    onclick: onClick,
  });
}

function ruleRow(rule, hits) {
  return h(
    'div',
    { class: 'row' + (rule.enabled ? '' : ' off') },
    h('span', { class: `mth ${rule.method}` }, methodLabel(rule.method)),
    h('span', { class: 'txt' }, h('span', { class: 'nm' }, rule.name), h('span', { class: 'ur', title: rule.url }, rule.url)),
    h('span', { class: 'hit', title: 'Times matched' }, String(hits[rule.id] || 0)),
    toggle(rule.enabled, `Enable ${rule.name}`, () => send({ type: 'SAVE_RULE', rule: { ...rule, enabled: !rule.enabled } })),
  );
}

const els = {
  head: h('div', { class: 'head' }),
  status: h('div', { class: 'status' }),
  search: h(
    'div',
    { class: 'search hidden' },
    h('input', {
      type: 'search',
      placeholder: 'Search rules…',
      'aria-label': 'Search rules',
      oninput: (e) => {
        query = e.target.value;
        update();
      },
    }),
  ),
  list: h('div', { class: 'list' }),
  foot: h('div', { class: 'foot' }),
};

function render({ state, hits, tab }) {
  const status = computePopupStatus({
    globalEnabled: state.globalEnabled,
    reachable,
    issues: tab.issues,
    mocked: tab.mocked,
    ruleCount: state.rules.length,
  });

  els.head.classList.toggle('off', !state.globalEnabled);
  clear(els.head).append(
    logo(),
    h('span', { class: 't' }, 'API Mock'),
    h('span', { class: 'sp' }),
    h('span', { class: 'lbl' }, 'Mocking'),
    toggle(state.globalEnabled, 'Mocking', () => send({ type: 'SET_GLOBAL', enabled: !state.globalEnabled })),
  );

  els.status.className = `status ${status.kind}`;
  clear(els.status).append(
    h('span', { class: 'dot' }),
    status.kind === 'warn'
      ? h('div', {}, h('b', {}, status.title), h('small', {}, status.detail))
      : h('div', {}, h('b', {}, status.title), ` · ${status.detail}`),
  );

  const searchable = state.rules.length >= SEARCH_MIN_RULES;
  els.search.classList.toggle('hidden', !searchable);
  const q = searchable ? query.trim().toLowerCase() : '';
  const rules = q ? state.rules.filter((r) => `${r.name} ${r.url}`.toLowerCase().includes(q)) : state.rules;

  els.list.classList.toggle('dim', !state.globalEnabled);
  clear(els.list);
  if (rules.length) {
    els.list.append(...rules.map((r) => ruleRow(r, hits)));
  } else if (state.rules.length === 0) {
    els.list.append(
      h('div', { class: 'none' }, 'No rules yet.', h('br'), 'Open DevTools (F12) → ', h('b', {}, 'API Mock'), ' → ', h('b', {}, '+ Add rule'), '.'),
    );
  } else {
    els.list.append(h('div', { class: 'none' }, `No rules match "${query.trim()}".`));
  }

  clear(els.foot).append(
    state.rules.length === 0
      ? "Mocked requests won't appear in the Network tab."
      : ['Edit rules: DevTools → ', h('b', {}, 'API Mock'), ' tab'],
  );
}

// "Latest read wins": a slow, older read never overwrites a newer render.
async function update() {
  const mine = ++seq;
  const data = await readAll(tabId);
  if (mine === seq) render(data);
}

async function init() {
  document.getElementById('app').append(els.head, els.status, els.search, els.list, els.foot);
  tabId = await resolveTabId();
  reachable = await ping(tabId);
  await update();
  subscribe(tabId, update);
}

init();
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx playwright test test/popup.spec.js test/ui-foundation.spec.js`
Expected: PASS.

- [ ] **Step 8: Run the whole suite** (the default-page change and the real popup must not disturb Plan 1's tests)

Run: `npx playwright test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add popup test/popup.spec.js test/helpers.js
git commit -m "feat(popup): status strip, rule switches, search and empty states"
```

---

### Task 3: Panel shell and rules list

**Files:**
- Replace: `panel/panel.html` (the Task 1 shell)
- Create: `panel/panel.css`, `panel/panel.js`, `panel/ui.js`, `test/panel-list.spec.js`
- Modify: `shared/dom.js` (add `logoSvg`, `toggleSwitch`), `popup/popup.js` (use them)

**Interfaces:**
- Consumes: `h`, `clear` (`shared/dom.js`), `readAll`, `subscribe`, `send` (`shared/store.js`), `methodLabel`, `defaultName`, `newRule` (`shared/rule.js`); service-worker messages `SAVE_RULE` and `SET_GLOBAL`.
- Produces (Tasks 4–6 build on these):
  - `shared/dom.js`: `logoSvg() → SVGElement` (the ">" mark, `currentColor`), `toggleSwitch(on, label, onClick) → HTMLButtonElement` (`<button class="tg [on]" role="switch" aria-checked>`).
  - `panel/ui.js`: `ui = { tabId, selectedId, query, drafts: Map<id, Rule>, unsaved: Set<id> }` (UI-only state, mutated in place, never persisted), `onUiChange(fn)`, `uiChanged()`. `drafts` holds new rules that are not saved yet; `unsaved` holds ids of saved rules that have pending invalid edits.
  - `panel/panel.js` DOM (selectors used by tests): `.bar` (`.ttl`, `.search`, `.add`, the global switch `.bar .tg`), `.main` containing `.empty`, `.list` (`.row` with `.sel`, `.off`, `data-id`, `role="option"`), and `.editor-slot` (Task 4 fills it). `#log-slot` is an empty container that Task 6 fills.
  - Row pill: a draft shows **Not applied**, a saved rule with pending invalid edits shows **Unsaved edits** (both instead of the hit count); the rule switch is not shown for drafts.
  - `?tabId=<id>` selects the tab; otherwise `chrome.devtools.inspectedWindow.tabId` (real DevTools).
- Behaviour (UI doc section 3): with no rules and no drafts the panel shows the empty state, including the Network-tab reminder; otherwise the first rule is selected automatically; the list is a keyboard-navigable listbox (↑/↓ move the selection, Enter or Space selects); `+ Add rule` creates a draft that is **not** stored.

- [ ] **Step 1: Write the failing test `test/panel-list.spec.js`**

```js
const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage } = require('./helpers');

const RULES = () => [
  rule({ id: 'a', name: 'Users list', method: 'GET', url: '/api/users*' }),
  rule({ id: 'b', name: 'Login', method: 'POST', url: '/api/login' }),
  rule({ id: 'c', name: 'Orders', method: 'GET', url: 'https://shop.dev/api/orders/*', enabled: false }),
  rule({ id: 'd', name: 'Delete user', method: 'DELETE', url: '/api/users/*' }),
];
const openPanel = (context, extensionId) => openExtensionPage(context, extensionId, 'panel/panel.html');
const stored = (sw) => sw.evaluate(() => chrome.storage.local.get('state').then((r) => r.state));

test.describe('panel: rules list', () => {
  test('renders rules with method labels, URLs and hits; selects the first; dims disabled rules', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    await serviceWorker.evaluate(() => chrome.storage.local.set({ hits: { a: 3 } }));
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('.list .row')).toHaveCount(4);
    const first = panel.locator('.row').nth(0);
    await expect(first.locator('.nm')).toHaveText('Users list');
    await expect(first.locator('.ur')).toHaveText('/api/users*');
    await expect(first.locator('.hit')).toHaveText('3');
    await expect(first).toHaveClass(/\bsel\b/);
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('.row').nth(3).locator('.mth')).toHaveText('DEL');
    await expect(panel.locator('.row').nth(2)).toHaveClass(/\boff\b/);
    await expect(panel.locator('.empty')).toBeHidden();
  });

  test('empty state: explains that mocked requests do not show in the Network tab', async ({ context, extensionId }) => {
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('.empty')).toBeVisible();
    await expect(panel.locator('.empty h4')).toHaveText('No rules yet');
    await expect(panel.locator('.empty .hint')).toContainText("won't appear in the Network tab");
    await expect(panel.locator('.empty .btn.pri')).toHaveText('+ Add your first rule');
    await expect(panel.locator('.list')).toBeHidden();
    await expect(panel.locator('.bar .ttl')).toHaveText('API Mock');
  });

  test('clicking or using the arrow keys selects a rule', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const panel = await openPanel(context, extensionId);
    await panel.locator('.row').nth(1).click();
    await expect(panel.locator('.row').nth(1)).toHaveClass(/\bsel\b/);
    await expect(panel.locator('.row.sel')).toHaveCount(1);

    await panel.locator('.row').nth(1).focus();
    await panel.keyboard.press('ArrowDown');
    await expect(panel.locator('.row').nth(2)).toHaveClass(/\bsel\b/);
    await panel.keyboard.press('ArrowUp');
    await panel.keyboard.press('ArrowUp');
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/);
  });

  test('a rule switch toggles that rule without changing the selection', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const panel = await openPanel(context, extensionId);
    await panel.locator('.row').nth(1).locator('.tg').click();
    await expect(panel.locator('.row').nth(1)).toHaveClass(/\boff\b/);
    expect((await stored(serviceWorker)).rules.find((r) => r.id === 'b').enabled).toBe(false);
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/); // still the first rule
  });

  test('the global switch turns mocking off and on', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const panel = await openPanel(context, extensionId);
    const sw = panel.locator('.bar .tg');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect((await stored(serviceWorker)).globalEnabled).toBe(false);
  });

  test('search filters by name or URL', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const panel = await openPanel(context, extensionId);
    await panel.locator('.bar .search').fill('shop.dev');
    await expect(panel.locator('.row')).toHaveCount(1);
    await expect(panel.locator('.row .nm')).toHaveText('Orders');
    await panel.locator('.bar .search').fill('zzz');
    await expect(panel.locator('.no-match')).toHaveText('No rules match "zzz".');
    await panel.locator('.bar .search').fill('');
    await expect(panel.locator('.row')).toHaveCount(4);
  });

  test('+ Add rule creates a draft on top that is selected but not stored', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const panel = await openPanel(context, extensionId);
    await panel.locator('.bar .add').click();
    const draft = panel.locator('.row').nth(0);
    await expect(draft).toHaveClass(/\bsel\b/);
    await expect(draft.locator('.nm')).toHaveText('New rule');
    await expect(draft.locator('.ur')).toHaveText('(no URL yet)');
    await expect(draft.locator('.draft')).toHaveText('Not applied');
    await expect(draft.locator('.tg')).toHaveCount(0);
    await expect(panel.locator('.row')).toHaveCount(5);
    expect((await stored(serviceWorker)).rules).toHaveLength(4);
  });

  test('+ Add your first rule leaves the empty state with a draft', async ({ context, extensionId }) => {
    const panel = await openPanel(context, extensionId);
    await panel.locator('.empty .btn.pri').click();
    await expect(panel.locator('.empty')).toBeHidden();
    await expect(panel.locator('.row')).toHaveCount(1);
    await expect(panel.locator('.row .draft')).toHaveText('Not applied');
  });

  test('follows storage changes made elsewhere', async ({ context, serviceWorker, extensionId }) => {
    await setState(serviceWorker, { rules: RULES() });
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('.row')).toHaveCount(4);
    await setState(serviceWorker, { rules: RULES().slice(0, 2) });
    await expect(panel.locator('.row')).toHaveCount(2);
  });

  test('rule names are text, never HTML', async ({ context, serviceWorker, extensionId }) => {
    const evil = '<img src=x onerror="window.__xss=1">';
    await setState(serviceWorker, { rules: [rule({ id: 'x', name: evil, url: '/x' })] });
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('.row .nm')).toHaveText(evil);
    expect(await panel.evaluate(() => window.__xss)).toBeUndefined();
    expect(await panel.locator('.row img').count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test test/panel-list.spec.js`
Expected: FAIL — the panel is still the Task 1 shell.

- [ ] **Step 3: Share the logo and the switch through `shared/dom.js`**

Append to `shared/dom.js`:

```js
const SVG_NS = 'http://www.w3.org/2000/svg';

/** The extension's mark (a ">" in a rounded square), coloured by currentColor. */
export function logoSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.classList.add('logo');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M8 9l3 3-3 3M13 15h3M3 5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5z');
  svg.append(path);
  return svg;
}

/** A switch: <button class="tg on" role="switch" aria-checked="true">. */
export function toggleSwitch(on, label, onClick) {
  return h('button', {
    class: 'tg' + (on ? ' on' : ''),
    type: 'button',
    role: 'switch',
    'aria-checked': String(on),
    'aria-label': label,
    onclick: onClick,
  });
}
```

In `popup/popup.js`: change the first import line to `import { h, clear, logoSvg, toggleSwitch } from '../shared/dom.js';`, delete the local `SVG` constant and the local `logo()` and `toggle()` functions, and rename their call sites (`logo()` → `logoSvg()`, `toggle(` → `toggleSwitch(`). Run `npx playwright test test/popup.spec.js` — it must still pass.

- [ ] **Step 4: Create `panel/ui.js`**

```js
// UI-only state shared by the panel modules. Mutated in place, never persisted.
export const ui = {
  tabId: null, // tab whose log is shown
  selectedId: null, // rule open in the editor
  query: '', // list search text
  drafts: new Map(), // id -> Rule that is not saved yet (new rules that are still invalid)
  unsaved: new Set(), // ids of saved rules with pending invalid edits
};

const listeners = new Set();
export const onUiChange = (fn) => listeners.add(fn);
export const uiChanged = () => listeners.forEach((fn) => fn());
```

- [ ] **Step 5: Create `panel/panel.html` and `panel/panel.css`**

`panel/panel.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>API Mock</title>
    <link rel="stylesheet" href="../shared/ui.css" />
    <link rel="stylesheet" href="panel.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="panel.js"></script>
  </body>
</html>
```

`panel/panel.css`:
```css
html, body { height: 100%; overflow: hidden; }
#app { display: flex; flex-direction: column; height: 100vh; }

.bar { display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 10px; background: var(--surface); border-bottom: 1px solid var(--bd); flex: none; }
.bar .ttl { font-weight: 600; }
.bar .search { width: 200px; height: 24px; padding: 0 8px; background: var(--input); color: var(--tx); border: 1px solid var(--bd); border-radius: var(--r); font-size: 12px; }
.bar .switch { display: flex; align-items: center; gap: 8px; }

.main { display: flex; flex: 1; min-height: 0; }
.list { flex: none; width: 270px; border-right: 1px solid var(--bd); overflow: auto; }
.row { display: flex; align-items: center; gap: 8px; height: 48px; padding: 0 10px; border-bottom: 1px solid var(--bd-soft); cursor: pointer; }
.row.sel { background: var(--surface); box-shadow: inset 2px 0 0 var(--ac); }
.row.off .txt, .row.off .mth { opacity: 0.4; }
.txt { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.nm { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ur { font-size: 10.5px; color: var(--mu); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.draft { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 9px; color: var(--err-text); background: color-mix(in srgb, var(--err) 15%, transparent); white-space: nowrap; }
.no-match { padding: 16px 12px; color: var(--mu); font-size: 12px; }

.editor-slot { flex: 1; min-width: 0; overflow: auto; }
.placeholder { padding: 24px; color: var(--mu); }

.empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 18px 24px; text-align: center; }
.empty svg { width: 38px; height: 38px; color: var(--mu); opacity: 0.5; }
.empty h4 { font-size: 14px; font-weight: 600; }
.empty p { color: var(--mu); max-width: 440px; }
.hint { max-width: 470px; padding: 8px 12px; border: 1px solid color-mix(in srgb, var(--ac) 30%, transparent); background: color-mix(in srgb, var(--ac) 8%, transparent); border-radius: var(--r); font-size: 12px; }
.btn.big { height: 32px; padding: 0 18px; font-size: 12px; }
```

- [ ] **Step 6: Create `panel/panel.js`**

```js
import { h, clear, logoSvg, toggleSwitch } from '../shared/dom.js';
import { readAll, subscribe, send } from '../shared/store.js';
import { methodLabel, defaultName, newRule } from '../shared/rule.js';
import { ui, onUiChange, uiChanged } from './ui.js';

let data = null; // last read of storage
let seq = 0;
let focusSelected = false; // restore keyboard focus after a re-render caused by arrow keys

function resolveTabId() {
  const fromUrl = new URLSearchParams(location.search).get('tabId'); // test hook
  if (fromUrl !== null) return Number(fromUrl);
  return chrome.devtools && chrome.devtools.inspectedWindow ? chrome.devtools.inspectedWindow.tabId : null;
}

// ── Actions ────────────────────────────────────────────────────────────────
function select(id) {
  ui.selectedId = id;
  uiChanged();
}

function addRule() {
  const draft = newRule({ name: '', url: '' });
  ui.drafts.set(draft.id, draft);
  ui.selectedId = draft.id;
  uiChanged();
}

function onRowKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const rows = [...els.list.querySelectorAll('.row')];
    const next = rows[rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      focusSelected = true;
      select(next.dataset.id);
    }
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    select(e.currentTarget.dataset.id);
  }
}

// ── View ───────────────────────────────────────────────────────────────────
const els = {
  globalSlot: h('div', { class: 'switch' }),
  empty: h(
    'div',
    { class: 'empty hidden' },
    logoSvg(),
    h('h4', {}, 'No rules yet'),
    h('p', {}, 'Add a rule to answer matching ', h('span', { class: 'mono' }, 'fetch'), ' / ', h('span', { class: 'mono' }, 'XHR'), ' requests with your own response.'),
    h('div', { class: 'hint' }, 'Mocked requests are answered inside the page, so they ', h('b', {}, "won't appear in the Network tab"), '. Watch them in the Log below.'),
    h('button', { class: 'btn pri big', type: 'button', onclick: addRule }, '+ Add your first rule'),
  ),
  list: h('div', { class: 'list', role: 'listbox', 'aria-label': 'Rules' }),
  editorSlot: h('div', { class: 'editor-slot' }),
  logSlot: h('div', { id: 'log-slot' }),
};

function ruleRow(rule, hits, isDraft) {
  const selected = rule.id === ui.selectedId;
  const pill = isDraft ? 'Not applied' : ui.unsaved.has(rule.id) ? 'Unsaved edits' : null;
  return h(
    'div',
    {
      class: 'row' + (rule.enabled ? '' : ' off') + (selected ? ' sel' : ''),
      role: 'option',
      tabindex: 0,
      'aria-selected': String(selected),
      dataset: { id: rule.id },
      onclick: () => select(rule.id),
      onkeydown: onRowKey,
    },
    h('span', { class: `mth ${rule.method}` }, methodLabel(rule.method)),
    h('span', { class: 'txt' }, h('span', { class: 'nm' }, rule.name || defaultName(rule.url)), h('span', { class: 'ur', title: rule.url }, rule.url || '(no URL yet)')),
    pill ? h('span', { class: 'draft' }, pill) : h('span', { class: 'hit', title: 'Times matched' }, String(hits[rule.id] || 0)),
    isDraft
      ? null
      : toggleSwitch(rule.enabled, `Enable ${rule.name}`, (e) => {
          e.stopPropagation(); // switching a rule must not select it
          send({ type: 'SAVE_RULE', rule: { ...rule, enabled: !rule.enabled } });
        }),
  );
}

function render() {
  if (!data) return;
  const { state, hits } = data;
  // A draft that has just been stored is already in state.rules: show it once.
  const drafts = [...ui.drafts.values()].filter((d) => !state.rules.some((r) => r.id === d.id));
  const all = [...drafts, ...state.rules];
  const isEmpty = all.length === 0;

  els.empty.classList.toggle('hidden', !isEmpty);
  els.list.classList.toggle('hidden', isEmpty);
  els.editorSlot.classList.toggle('hidden', isEmpty);

  if (!all.some((r) => r.id === ui.selectedId)) ui.selectedId = all.length ? all[0].id : null;

  clear(els.globalSlot).append(
    h('span', { class: 'mu' }, 'Mocking'),
    toggleSwitch(state.globalEnabled, 'Mocking', () => send({ type: 'SET_GLOBAL', enabled: !state.globalEnabled })),
  );

  const q = ui.query.trim().toLowerCase();
  const rows = q ? all.filter((r) => `${r.name} ${r.url}`.toLowerCase().includes(q)) : all;
  clear(els.list);
  if (rows.length) els.list.append(...rows.map((r) => ruleRow(r, hits, drafts.includes(r))));
  else els.list.append(h('div', { class: 'no-match' }, `No rules match "${ui.query.trim()}".`));

  if (focusSelected) {
    focusSelected = false;
    const row = els.list.querySelector('.row.sel');
    if (row) row.focus();
  }

  if (!ui.selectedId && !isEmpty) {
    clear(els.editorSlot).append(h('div', { class: 'placeholder' }, 'Select a rule to edit.'));
  }
}

// "Latest read wins": a slow, older read never overwrites a newer render.
async function update() {
  const mine = ++seq;
  const fresh = await readAll(ui.tabId);
  if (mine !== seq) return;
  data = fresh;
  render();
}

async function init() {
  ui.tabId = resolveTabId();
  const bar = h(
    'div',
    { class: 'bar' },
    h('span', { class: 'ttl' }, 'API Mock'),
    h('input', {
      class: 'search',
      type: 'search',
      placeholder: 'Search rules…',
      'aria-label': 'Search rules',
      oninput: (e) => {
        ui.query = e.target.value;
        uiChanged();
      },
    }),
    h('button', { class: 'btn pri add', type: 'button', onclick: addRule }, '+ Add rule'),
    h('span', { class: 'sp' }),
    els.globalSlot,
  );
  const main = h('div', { class: 'main' }, els.empty, els.list, els.editorSlot);
  document.getElementById('app').append(bar, main, els.logSlot);

  onUiChange(render);
  await update();
  subscribe(ui.tabId, update);
}

init();
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx playwright test test/panel-list.spec.js test/popup.spec.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add panel shared popup test/panel-list.spec.js
git commit -m "feat(panel): shell, rules list with selection, drafts, search and empty state"
```

---

### Task 4: Panel editor — fields, validation, auto-save, drafts

**Files:**
- Create: `panel/editor.js`, `test/panel-editor.spec.js`
- Modify: `panel/panel.js`, `panel/panel.css`, `shared/rule.js` (add `deepExpand`, `formatJson`)

**Interfaces:**
- Consumes: `h`, `clear` (`shared/dom.js`); `send` (`shared/store.js`); `METHODS`, `validateRule`, `parseHeaders`, `stringifyHeaders`, `isJson` (`shared/rule.js`); `ui`, `uiChanged` (`panel/ui.js`); service-worker message `SAVE_RULE`.
- Produces:
  - `shared/rule.js`: `deepExpand(value)` (recursively parses JSON-looking string values), `formatJson(text) → { ok: boolean, text }` (pretty-prints with 2 spaces; `ok: false` and the text unchanged when it is not valid JSON).
  - `panel/editor.js`: `mountEditor(container, rule, api)` with `api = { latest(id), refresh(): Promise<void> }` — `latest(id)` returns the newest stored rule or draft; `refresh()` re-reads storage and re-renders the panel (used after a save so the panel knows the stored rule before the draft is dropped). Mounting flushes and replaces the previous editor. `unmountEditor()` flushes a pending valid save and discards pending invalid edits of a saved rule (a draft keeps its values in `ui.drafts`).
  - Editor DOM (selectors for tests): `.editor` with `.ed-top` (`input.name`, `.saved`), `select.method`, `input.url`, `input.status`, `input.delay`, `textarea.headers`, `textarea.body`, `button.format`, `.note`, and one `.fmsg[data-for="url|status|delay|headers"]` under each validated field; an invalid field also gets class `err`.
- Behaviour (UI doc section 3):
  - Auto-save 700 ms after the last edit **only when the form is valid**; invalid edits are never saved and never sent to the engine. Errors show after the first edit (a fresh draft shows none until touched).
  - Indicator: `Saving…` while the message is in flight, `✓ Saved` for 2 s, then blank; `● Not saved — fix N error(s)` (`1 error`, `2 errors`) for as long as the form is invalid.
  - A saved rule with invalid edits gets the pill **Unsaved edits** (its stored version keeps applying); a new rule that is not valid yet keeps **Not applied**. Once saved, the draft is removed and the pill disappears.
  - Body note: `✓ Valid JSON`; `Not JSON — sent as text/plain` (only `Not JSON` when a Content-Type header exists); nothing for an empty body.
  - At save time `enabled` is taken from the latest stored rule, so a switch flipped in the popup meanwhile is never reverted.
  - Empty name → the service worker derives it from the URL.

- [ ] **Step 1: Write the failing test `test/panel-editor.spec.js`**

```js
const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage } = require('./helpers');

const seed = () =>
  rule({
    id: 'a', name: 'Users list', method: 'GET', url: '/api/users*',
    response: {
      status: 500, delay: 800, body: '{\n  "error": "Internal Server Error"\n}',
      headers: [{ name: 'Content-Type', value: 'application/json' }, { name: 'X-Mock', value: '1' }],
    },
  });
const other = () => rule({ id: 'b', name: 'Login', method: 'POST', url: '/api/login' });

async function openEditor(context, extensionId, serviceWorker, rules = [seed(), other()]) {
  await setState(serviceWorker, { rules });
  const panel = await openExtensionPage(context, extensionId, 'panel/panel.html');
  await panel.locator('.editor').waitFor();
  return panel;
}
const stored = (sw) => sw.evaluate(() => chrome.storage.local.get('state').then((r) => r.state));
const savedRule = async (sw, id) => (await stored(sw)).rules.find((r) => r.id === id);

test.describe('shared/rule.js JSON helpers', () => {
  test('deepExpand and formatJson', async ({ context, extensionId }) => {
    const ext = await openExtensionPage(context, extensionId);
    const out = await ext.evaluate(async () => {
      const { formatJson } = await import('/shared/rule.js');
      return {
        nested: formatJson('{"a":"{\\"b\\":[1,\\"{\\\\\\"c\\\\\\":2}\\"]}","d":"plain"}'),
        invalid: formatJson('{oops'),
        scalar: formatJson('123'),
      };
    });
    expect(out.nested.ok).toBe(true);
    expect(JSON.parse(out.nested.text)).toEqual({ a: { b: [1, { c: 2 }] }, d: 'plain' });
    expect(out.nested.text).toContain('\n  "a": {');
    expect(out.invalid).toEqual({ ok: false, text: '{oops' });
    expect(out.scalar).toEqual({ ok: true, text: '123' });
  });
});

test.describe('panel: editor', () => {
  test('shows the selected rule in its fields', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await expect(panel.locator('.editor .name')).toHaveValue('Users list');
    await expect(panel.locator('.editor .method')).toHaveValue('GET');
    await expect(panel.locator('.editor .url')).toHaveValue('/api/users*');
    await expect(panel.locator('.editor .status')).toHaveValue('500');
    await expect(panel.locator('.editor .delay')).toHaveValue('800');
    await expect(panel.locator('.editor .headers')).toHaveValue('Content-Type: application/json\nX-Mock: 1');
    await expect(panel.locator('.editor .body')).toHaveValue('{\n  "error": "Internal Server Error"\n}');
    await expect(panel.locator('.editor .note')).toHaveText('✓ Valid JSON');
    await expect(panel.locator('.editor .saved')).toHaveText('');
  });

  test('auto-saves a valid edit after the debounce and shows Saved', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .body').fill('{"ok":true}');
    await expect.poll(async () => (await savedRule(serviceWorker, 'a')).response.body).toBe('{"ok":true}');
    await expect(panel.locator('.editor .saved')).toHaveText('✓ Saved');
    await expect(panel.locator('.editor .saved')).toHaveText('', { timeout: 5000 }); // hides after about 2 s
  });

  test('a burst of typing produces a single save', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.evaluate(() => {
      window.__saves = 0;
      chrome.storage.onChanged.addListener((c, area) => {
        if (area === 'local' && c.state) window.__saves += 1;
      });
    });
    await panel.locator('.editor .body').pressSequentially('abc', { delay: 100 });
    await expect.poll(async () => (await savedRule(serviceWorker, 'a')).response.body).toContain('abc');
    await panel.waitForTimeout(1200);
    expect(await panel.evaluate(() => window.__saves)).toBe(1);
  });

  test('invalid values are flagged in place, never saved, and marked Unsaved edits', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .url').fill('');
    await panel.locator('.editor .status').fill('700');
    await panel.locator('.editor .delay').fill('70000');
    await panel.locator('.editor .headers').fill('not a header');

    await expect(panel.locator('.fmsg[data-for="url"]')).toHaveText('URL is required');
    await expect(panel.locator('.fmsg[data-for="status"]')).toHaveText('Must be 200–599');
    await expect(panel.locator('.fmsg[data-for="delay"]')).toHaveText('Must be 0–60000');
    await expect(panel.locator('.fmsg[data-for="headers"]')).toHaveText('Line 1: invalid header name');
    await expect(panel.locator('.editor .url')).toHaveClass(/\berr\b/);
    await expect(panel.locator('.editor .saved')).toHaveText('● Not saved — fix 4 errors');
    await expect(panel.locator('.row').nth(0).locator('.draft')).toHaveText('Unsaved edits');

    await panel.waitForTimeout(1000); // longer than the debounce
    expect((await savedRule(serviceWorker, 'a')).url).toBe('/api/users*'); // the stored rule is untouched
  });

  test('fixing the errors saves and clears the marks', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .status').fill('700');
    await expect(panel.locator('.editor .saved')).toHaveText('● Not saved — fix 1 error');
    await panel.locator('.editor .status').fill('404');
    await expect.poll(async () => (await savedRule(serviceWorker, 'a')).response.status).toBe(404);
    await expect(panel.locator('.fmsg[data-for="status"]')).toHaveText('');
    await expect(panel.locator('.editor .status')).not.toHaveClass(/\berr\b/);
    await expect(panel.locator('.row').nth(0).locator('.draft')).toHaveCount(0);
  });

  test('a new rule stays a draft until it is valid, then it is stored on top', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.bar .add').click();
    await expect(panel.locator('.editor .url')).toHaveValue('');
    await expect(panel.locator('.fmsg[data-for="url"]')).toHaveText(''); // no errors before the first edit
    await panel.locator('.editor .name').fill('Fresh');
    await expect(panel.locator('.fmsg[data-for="url"]')).toHaveText('URL is required');
    await expect(panel.locator('.row').nth(0).locator('.draft')).toHaveText('Not applied');
    expect((await stored(serviceWorker)).rules).toHaveLength(2);

    await panel.locator('.editor .url').fill('/fresh');
    await expect.poll(async () => (await stored(serviceWorker)).rules.length).toBe(3);
    const rules = (await stored(serviceWorker)).rules;
    expect(rules[0]).toMatchObject({ name: 'Fresh', url: '/fresh', method: 'GET' });
    await expect(panel.locator('.row').nth(0).locator('.draft')).toHaveCount(0);
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/);
    await expect(panel.locator('.editor .name')).toHaveValue('Fresh');
  });

  test('method, name and headers are saved in their stored form', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .method').selectOption('POST');
    await panel.locator('.editor .name').fill('Renamed');
    await panel.locator('.editor .headers').fill('A: 1\nB: two');
    await expect.poll(async () => (await savedRule(serviceWorker, 'a')).method).toBe('POST');
    const r = await savedRule(serviceWorker, 'a');
    expect(r.name).toBe('Renamed');
    expect(r.response.headers).toEqual([{ name: 'A', value: '1' }, { name: 'B', value: 'two' }]);
    await expect(panel.locator('.row').nth(0).locator('.nm')).toHaveText('Renamed');
  });

  test('an empty name falls back to the name derived from the URL', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .name').fill('');
    await expect.poll(async () => (await savedRule(serviceWorker, 'a')).name).toBe('users');
  });

  test('the body note follows the content', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .body').fill('Created!');
    await expect(panel.locator('.editor .note')).toHaveText('Not JSON'); // the rule has a Content-Type header
    await panel.locator('.editor .headers').fill('X-Mock: 1');
    await expect(panel.locator('.editor .note')).toHaveText('Not JSON — sent as text/plain');
    await panel.locator('.editor .body').fill('');
    await expect(panel.locator('.editor .note')).toHaveText('');
    await panel.locator('.editor .body').fill('[1]');
    await expect(panel.locator('.editor .note')).toHaveText('✓ Valid JSON');
  });

  test('Format JSON pretty-prints and expands nested JSON strings; invalid JSON is left alone', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .body').fill('{"a":"{\\"b\\":1}"}');
    await panel.locator('.editor .format').click();
    await expect(panel.locator('.editor .body')).toHaveValue('{\n  "a": {\n    "b": 1\n  }\n}');
    await panel.locator('.editor .body').fill('{oops');
    await panel.locator('.editor .format').click();
    await expect(panel.locator('.editor .body')).toHaveValue('{oops');
  });

  test('switching rules flushes a pending save', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .body').fill('quick');
    await panel.locator('.row').nth(1).click(); // well before the 700 ms debounce
    await expect.poll(async () => (await savedRule(serviceWorker, 'a')).response.body).toBe('quick');
    await expect(panel.locator('.editor .name')).toHaveValue('Login');
  });

  test('leaving a rule discards its invalid edits', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.editor .url').fill('');
    await expect(panel.locator('.row').nth(0).locator('.draft')).toHaveText('Unsaved edits');
    await panel.locator('.row').nth(1).click();
    await expect(panel.locator('.row').nth(0).locator('.draft')).toHaveCount(0);
    await panel.locator('.row').nth(0).click();
    await expect(panel.locator('.editor .url')).toHaveValue('/api/users*');
  });

  test('a draft keeps its values while you look at another rule', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    await panel.locator('.bar .add').click();
    await panel.locator('.editor .name').fill('Half done');
    await panel.locator('.row').nth(1).click(); // another rule
    await panel.locator('.row').nth(0).click(); // back to the draft
    await expect(panel.locator('.editor .name')).toHaveValue('Half done');
    await expect(panel.locator('.row').nth(0).locator('.draft')).toHaveText('Not applied');
  });

  test('never reverts an enabled/disabled switch flipped elsewhere', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openEditor(context, extensionId, serviceWorker);
    const ext = await openExtensionPage(context, extensionId);
    const current = await savedRule(serviceWorker, 'a');
    await ext.evaluate((r) => chrome.runtime.sendMessage({ type: 'SAVE_RULE', rule: r }), { ...current, enabled: false });
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\boff\b/);
    await panel.locator('.editor .body').fill('after');
    await expect.poll(async () => (await savedRule(serviceWorker, 'a')).response.body).toBe('after');
    expect((await savedRule(serviceWorker, 'a')).enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test test/panel-editor.spec.js`
Expected: FAIL — `/shared/rule.js` has no `formatJson`, and the panel shows no `.editor`.

- [ ] **Step 3: Add the JSON helpers to `shared/rule.js`**

Append after `isJson`:

```js
// Recursively parses string values that look like JSON objects or arrays ("un-stringifies" nested JSON).
export function deepExpand(value) {
  if (typeof value === 'string') {
    const t = value.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return deepExpand(JSON.parse(t));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(deepExpand);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepExpand(v)]));
  }
  return value;
}

// Pretty-prints JSON (2 spaces) after expanding nested JSON strings; leaves invalid JSON unchanged.
export function formatJson(text) {
  try {
    return { ok: true, text: JSON.stringify(deepExpand(JSON.parse(text)), null, 2) };
  } catch {
    return { ok: false, text };
  }
}
```

- [ ] **Step 4: Create `panel/editor.js`**

```js
import { h, clear } from '../shared/dom.js';
import { send } from '../shared/store.js';
import { METHODS, validateRule, parseHeaders, stringifyHeaders, isJson, formatJson } from '../shared/rule.js';
import { ui, uiChanged } from './ui.js';

const AUTOSAVE_MS = 700;
const SAVED_VISIBLE_MS = 2000;

let current = null; // controller of the mounted editor

export function unmountEditor() {
  if (current) current.destroy();
  current = null;
}

/**
 * Mounts the editor for `rule` into `container`.
 * `api.latest(id)` returns the newest stored rule or draft; `api.refresh()` re-reads storage and re-renders.
 */
export function mountEditor(container, rule, api) {
  unmountEditor();
  const id = rule.id;
  const form = {
    name: rule.name,
    method: rule.method,
    url: rule.url,
    status: String(rule.response.status),
    delay: String(rule.response.delay),
    headers: stringifyHeaders(rule.response.headers),
    body: rule.response.body,
  };
  let touched = false; // errors are shown only after the first edit
  let errors = {};
  let saveTimer = 0;
  let savedTimer = 0;
  let destroyed = false;

  // ── Form → rule ──────────────────────────────────────────────────────────
  const wholeNumber = (text) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN);

  function evaluate(base) {
    const parsed = parseHeaders(form.headers);
    const candidate = {
      id,
      enabled: base.enabled,
      name: form.name,
      method: form.method,
      url: form.url,
      response: {
        status: wholeNumber(form.status),
        headers: parsed.headers,
        body: form.body,
        delay: form.delay.trim() === '' ? 0 : wholeNumber(form.delay),
      },
    };
    const found = validateRule(candidate).errors;
    if (parsed.error) found.headers = parsed.error;
    return { candidate, errors: found, headersOk: !parsed.error };
  }

  // ── Elements ─────────────────────────────────────────────────────────────
  const onEdit = () => handleEdit();
  const nameInput = h('input', { class: 'name', value: form.name, placeholder: 'Rule name', 'aria-label': 'Rule name', oninput: (e) => { form.name = e.target.value; onEdit(); } });
  const saved = h('span', { class: 'saved' });
  const methodSelect = h('select', { class: 'method ' + form.method, 'aria-label': 'HTTP method', onchange: (e) => { form.method = e.target.value; methodSelect.className = 'method ' + form.method; onEdit(); } }, METHODS.map((m) => h('option', { value: m }, m)));
  methodSelect.value = form.method;
  const urlInput = h('input', { class: 'url mono', value: form.url, placeholder: 'https://api.example.com/users  or  /api/users*', spellcheck: false, 'aria-label': 'URL pattern', oninput: (e) => { form.url = e.target.value; onEdit(); } });
  const statusInput = h('input', { class: 'status mono', value: form.status, inputmode: 'numeric', 'aria-label': 'Status code', oninput: (e) => { form.status = e.target.value; onEdit(); } });
  const delayInput = h('input', { class: 'delay mono', value: form.delay, inputmode: 'numeric', 'aria-label': 'Delay in milliseconds', oninput: (e) => { form.delay = e.target.value; onEdit(); } });
  const headersArea = h('textarea', { class: 'headers', rows: 2, spellcheck: false, value: form.headers, placeholder: 'Key: Value   (one per line)', 'aria-label': 'Response headers', oninput: (e) => { form.headers = e.target.value; onEdit(); } });
  const bodyArea = h('textarea', { class: 'body', spellcheck: false, value: form.body, 'aria-label': 'Response body', oninput: (e) => { form.body = e.target.value; onEdit(); } });
  const note = h('span', { class: 'note' });
  const formatBtn = h('button', { class: 'btn format', type: 'button', onclick: () => {
    const out = formatJson(form.body);
    if (!out.ok) return;
    form.body = out.text;
    bodyArea.value = out.text;
    onEdit();
  } }, 'Format JSON');

  const msg = (name) => h('span', { class: 'fmsg', dataset: { for: name } });
  const msgs = { url: msg('url'), status: msg('status'), delay: msg('delay'), headers: msg('headers') };
  const controls = { url: urlInput, status: statusInput, delay: delayInput, headers: headersArea };

  const el = h(
    'div',
    { class: 'editor' },
    h('div', { class: 'ed-top' }, nameInput, saved, h('span', { class: 'sp' })),
    h('div', { class: 'line' }, methodSelect, h('div', { class: 'fld grow' }, urlInput, msgs.url)),
    h('div', { class: 'line' },
      h('div', { class: 'fld' }, 'Status', statusInput, msgs.status),
      h('div', { class: 'fld' }, 'Delay (ms)', delayInput, msgs.delay)),
    h('div', { class: 'fld' }, 'Headers', headersArea, msgs.headers),
    h('div', { class: 'fld grow' }, h('div', { class: 'lbl-row' }, 'Body', h('span', { class: 'sp' }), formatBtn, note), bodyArea),
  );
  clear(container).append(el);

  // ── Feedback ─────────────────────────────────────────────────────────────
  function paintErrors() {
    for (const field of Object.keys(msgs)) {
      const text = touched ? errors[field] || '' : '';
      msgs[field].textContent = text;
      controls[field].classList.toggle('err', Boolean(text));
    }
  }

  function paintNote() {
    const hasContentType = parseHeaders(form.headers).headers.some((x) => x.name.toLowerCase() === 'content-type');
    note.className = 'note';
    if (!form.body.trim()) note.textContent = '';
    else if (isJson(form.body)) {
      note.textContent = '✓ Valid JSON';
      note.classList.add('ok');
    } else note.textContent = hasContentType ? 'Not JSON' : 'Not JSON — sent as text/plain';
  }

  function setIndicator(kind) {
    clearTimeout(savedTimer);
    saved.className = 'saved';
    if (kind === 'saving') {
      saved.classList.add('mu');
      saved.textContent = 'Saving…';
    } else if (kind === 'saved') {
      saved.textContent = '✓ Saved';
      savedTimer = setTimeout(() => setIndicator('idle'), SAVED_VISIBLE_MS);
    } else if (kind === 'error') {
      const n = Object.keys(errors).length;
      saved.classList.add('bad');
      saved.textContent = `● Not saved — fix ${n} error${n === 1 ? '' : 's'}`;
    } else saved.textContent = '';
  }

  // ── Editing and saving ───────────────────────────────────────────────────
  const wholeOr = (value, fallback) => (Number.isInteger(value) ? value : fallback);

  function handleEdit() {
    touched = true;
    const base = api.latest(id);
    if (!base) return; // deleted elsewhere
    const out = evaluate(base);
    errors = out.errors;
    paintErrors();
    paintNote();
    const invalid = Object.keys(errors).length > 0;

    if (ui.drafts.has(id)) {
      // Keep the draft in sync so it survives switching to another rule.
      ui.drafts.set(id, {
        ...base,
        name: form.name,
        method: form.method,
        url: form.url,
        response: {
          status: wholeOr(out.candidate.response.status, base.response.status),
          delay: wholeOr(out.candidate.response.delay, base.response.delay),
          headers: out.headersOk ? out.candidate.response.headers : base.response.headers,
          body: form.body,
        },
      });
    } else if (invalid) ui.unsaved.add(id);
    else ui.unsaved.delete(id);

    clearTimeout(saveTimer);
    if (invalid) setIndicator('error');
    else {
      setIndicator('idle');
      saveTimer = setTimeout(save, AUTOSAVE_MS);
    }
    uiChanged();
  }

  async function save() {
    saveTimer = 0;
    const base = api.latest(id);
    if (!base) return;
    const out = evaluate(base);
    if (Object.keys(out.errors).length) return;
    if (!destroyed) setIndicator('saving');
    const res = await send({ type: 'SAVE_RULE', rule: out.candidate });
    if (res && res.ok) {
      await api.refresh(); // the panel now knows the stored rule, so the draft can go without a flicker
      ui.drafts.delete(id);
      ui.unsaved.delete(id);
      if (!destroyed) setIndicator('saved');
    } else if (!destroyed) {
      errors = (res && res.errors) || { url: 'Could not save' };
      paintErrors();
      setIndicator('error');
    }
    uiChanged();
  }

  paintNote();

  current = {
    destroy() {
      destroyed = true;
      clearTimeout(savedTimer);
      if (saveTimer) {
        clearTimeout(saveTimer);
        save(); // flush a pending valid save; the form is valid, otherwise no timer was set
      } else if (!ui.drafts.has(id) && ui.unsaved.delete(id)) {
        uiChanged(); // invalid edits of a saved rule are discarded
      }
    },
  };
}
```

- [ ] **Step 5: Wire the editor into `panel/panel.js`**

Add the import:

```js
import { mountEditor, unmountEditor } from './editor.js';
```

Add, next to the other module-level variables:

```js
let mountedId = null; // rule currently open in the editor
const latest = (id) => ui.drafts.get(id) || (data && data.state.rules.find((r) => r.id === id)) || null;
const editorApi = { latest, refresh: () => update() };
```

Replace the last block of `render()` (the `if (!ui.selectedId && !isEmpty) { … }` placeholder) with:

```js
  const selected = all.find((r) => r.id === ui.selectedId) || null;
  if (!selected) {
    unmountEditor();
    mountedId = null;
    if (!isEmpty) clear(els.editorSlot).append(h('div', { class: 'placeholder' }, 'Select a rule to edit.'));
  } else if (ui.selectedId !== mountedId) {
    mountedId = ui.selectedId;
    mountEditor(els.editorSlot, selected, editorApi);
  }
```

- [ ] **Step 6: Append the editor styles to `panel/panel.css`**

```css
.editor-slot { display: flex; flex-direction: column; }
.editor { flex: 1; display: flex; flex-direction: column; gap: 9px; padding: 10px 12px; min-height: 0; }
.ed-top { display: flex; align-items: center; gap: 10px; }
.saved { font-size: 10.5px; color: var(--ok); }
.saved.mu { color: var(--mu); }
.saved.bad { color: var(--err-text); }
.line { display: flex; gap: 8px; align-items: flex-start; }

.editor input, .editor select, .editor textarea { background: var(--input); color: var(--tx); border: 1px solid var(--bd); border-radius: var(--r); font-size: 12px; }
.editor input, .editor select { height: 26px; padding: 0 8px; }
.editor textarea { padding: 6px 8px; font-size: 11.5px; line-height: 1.5; resize: vertical; background: var(--code); white-space: pre; }
.editor input.name { font-size: 13px; font-weight: 600; background: transparent; border-color: transparent; padding: 2px 6px; margin-left: -6px; min-width: 120px; }
.editor input.name:hover, .editor input.name:focus { border-color: var(--bd); background: var(--input); }
.editor .method { width: 92px; font-weight: 700; color: var(--c, var(--tx)); }
.editor .method.GET { --c: var(--get); } .editor .method.POST { --c: var(--post); } .editor .method.PUT { --c: var(--put); }
.editor .method.PATCH { --c: var(--patch); } .editor .method.DELETE { --c: var(--delete); } .editor .method.HEAD { --c: var(--head); }
.editor .method.OPTIONS { --c: var(--options); } .editor .method.ANY { --c: var(--any); }
.editor .url { width: 100%; }
.editor .status, .editor .delay { width: 76px; }
.editor .err { border-color: var(--err); box-shadow: 0 0 0 1px color-mix(in srgb, var(--err) 40%, transparent); }

.fld { display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; color: var(--mu); text-transform: uppercase; letter-spacing: 0.04em; }
.fld.grow { flex: 1; min-width: 0; min-height: 0; }
.fmsg { color: var(--err-text); font-size: 10.5px; text-transform: none; letter-spacing: 0; }
.fmsg:empty { display: none; }
.lbl-row { display: flex; align-items: center; gap: 8px; }
.note { font-size: 10.5px; color: var(--mu); text-transform: none; letter-spacing: 0; }
.note.ok { color: var(--ok); }
.editor .body { flex: 1; min-height: 120px; }
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx playwright test test/panel-editor.spec.js test/panel-list.spec.js`
Expected: PASS. (If the "saved" indicator assertions are flaky on a slow machine, raise the `expect` timeout for that assertion, not the debounce.)

- [ ] **Step 8: Commit**

```bash
git add panel shared test/panel-editor.spec.js
git commit -m "feat(panel): editor with validation, debounced auto-save, drafts and JSON formatting"
```

---

### Task 5: Rule actions — ⋮ menu (duplicate, reorder, delete with confirmation)

**Files:**
- Create: `panel/menu.js`, `test/panel-actions.spec.js`
- Modify: `panel/editor.js`, `panel/panel.js`, `panel/panel.css`

**Interfaces:**
- Consumes: `h` (`shared/dom.js`), `send` (`shared/store.js`), `defaultName` (`shared/rule.js`), `ui`, `uiChanged` (`panel/ui.js`); service-worker messages `SAVE_RULE`, `REORDER`, `DELETE_RULE`; the editor `api` from Task 4, which gains `rules()` (the stored rules in list order).
- Produces:
  - `panel/menu.js`: `ruleMenu(id, api) → HTMLElement` (a `.menu-wrap` with `button.kebab` and, while open, a `.menu[role="menu"]` of `button.item[role="menuitem"]`: `Duplicate`, `Move up`, `Move down`, `Delete` — or `Discard draft` for a draft), and `confirmDelete(name) → Promise<boolean>` (a `.overlay > .dialog[role="dialog"]` with the text `Delete rule "<name>"?` and the buttons `Cancel` and `Delete`).
  - `mountEditor` appends the menu at the end of `.ed-top`.
- Behaviour: **Duplicate** saves a copy named `<name> copy` on top of the list and selects it. **Move up / Move down** send `REORDER`; the selection follows the rule; both are disabled at the edges and for drafts. **Delete** asks first (Cancel or Escape keeps the rule), then the panel selects the first remaining rule (or shows the empty state). A **draft** is discarded at once, without confirmation. The menu closes on Escape (focus returns to `⋮`), on an outside click and after any action; ↑/↓ move between its items. Actions apply to the *stored* rule, not to unsaved form edits.

- [ ] **Step 1: Write the failing test `test/panel-actions.spec.js`**

```js
const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage } = require('./helpers');

const RULES = () => [
  rule({ id: 'a', name: 'Users list', method: 'GET', url: '/api/users*' }),
  rule({ id: 'b', name: 'Login', method: 'POST', url: '/api/login' }),
  rule({ id: 'c', name: 'Orders', method: 'GET', url: '/api/orders' }),
];
async function openPanel(context, extensionId, serviceWorker, rules = RULES()) {
  await setState(serviceWorker, { rules });
  const panel = await openExtensionPage(context, extensionId, 'panel/panel.html');
  await panel.locator('.editor').waitFor();
  return panel;
}
const stored = (sw) => sw.evaluate(() => chrome.storage.local.get('state').then((r) => r.state));
const menuItem = (panel, name) => panel.getByRole('menuitem', { name, exact: true });

test.describe('panel: ⋮ menu', () => {
  test('opens with the four actions and closes on Escape (focus returns) or an outside click', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.kebab').click();
    await expect(panel.locator('.menu [role="menuitem"]')).toHaveText(['Duplicate', 'Move up', 'Move down', 'Delete']);
    await expect(panel.locator('.kebab')).toHaveAttribute('aria-expanded', 'true');
    await panel.keyboard.press('Escape');
    await expect(panel.locator('.menu')).toHaveCount(0);
    await expect(panel.locator('.kebab')).toBeFocused();

    await panel.locator('.kebab').click();
    await panel.locator('.bar .ttl').click();
    await expect(panel.locator('.menu')).toHaveCount(0);
  });

  test('arrow keys move between enabled items', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.kebab').click(); // first rule: "Move up" is disabled
    await expect(menuItem(panel, 'Duplicate')).toBeFocused();
    await panel.keyboard.press('ArrowDown');
    await expect(menuItem(panel, 'Move down')).toBeFocused(); // skipped the disabled "Move up"
    await panel.keyboard.press('ArrowUp');
    await expect(menuItem(panel, 'Duplicate')).toBeFocused();
  });

  test('Move up is disabled for the first rule and Move down for the last', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.kebab').click();
    await expect(menuItem(panel, 'Move up')).toBeDisabled();
    await expect(menuItem(panel, 'Move down')).toBeEnabled();
    await panel.keyboard.press('Escape');
    await panel.locator('.row').nth(2).click();
    await panel.locator('.kebab').click();
    await expect(menuItem(panel, 'Move up')).toBeEnabled();
    await expect(menuItem(panel, 'Move down')).toBeDisabled();
  });

  test('Duplicate stores a copy on top and selects it', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.kebab').click();
    await menuItem(panel, 'Duplicate').click();
    await expect.poll(async () => (await stored(serviceWorker)).rules.map((r) => r.name)).toEqual(['Users list copy', 'Users list', 'Login', 'Orders']);
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/);
    await expect(panel.locator('.editor .name')).toHaveValue('Users list copy');
    const [copy, original] = (await stored(serviceWorker)).rules;
    expect(copy.id).not.toBe(original.id);
    expect(copy.url).toBe(original.url);
  });

  test('Move down and Move up reorder the rules and the selection follows the rule', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.kebab').click();
    await menuItem(panel, 'Move down').click();
    await expect.poll(async () => (await stored(serviceWorker)).rules.map((r) => r.id)).toEqual(['b', 'a', 'c']);
    await expect(panel.locator('.row .nm')).toHaveText(['Login', 'Users list', 'Orders']);
    await expect(panel.locator('.row').nth(1)).toHaveClass(/\bsel\b/);
    await expect(panel.locator('.editor .name')).toHaveValue('Users list');

    await panel.locator('.kebab').click();
    await menuItem(panel, 'Move up').click();
    await expect.poll(async () => (await stored(serviceWorker)).rules.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/);
  });

  test('Delete asks for confirmation; Cancel and Escape keep the rule', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.kebab').click();
    await menuItem(panel, 'Delete').click();
    await expect(panel.locator('.dialog p')).toHaveText('Delete rule "Users list"?');
    await panel.locator('.dialog .btn', { hasText: 'Cancel' }).click();
    await expect(panel.locator('.dialog')).toHaveCount(0);

    await panel.locator('.kebab').click();
    await menuItem(panel, 'Delete').click();
    await panel.keyboard.press('Escape');
    await expect(panel.locator('.dialog')).toHaveCount(0);
    expect((await stored(serviceWorker)).rules).toHaveLength(3);
  });

  test('confirming Delete removes the rule and selects the first remaining one', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.kebab').click();
    await menuItem(panel, 'Delete').click();
    await panel.locator('.dialog .btn.danger').click();
    await expect.poll(async () => (await stored(serviceWorker)).rules.map((r) => r.id)).toEqual(['b', 'c']);
    await expect(panel.locator('.dialog')).toHaveCount(0);
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/);
    await expect(panel.locator('.editor .name')).toHaveValue('Login');
  });

  test('deleting the last rule shows the empty state', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker, [RULES()[0]]);
    await panel.locator('.kebab').click();
    await menuItem(panel, 'Delete').click();
    await panel.locator('.dialog .btn.danger').click();
    await expect(panel.locator('.empty')).toBeVisible();
    await expect(panel.locator('.editor')).toHaveCount(0);
  });

  test('a draft can only be discarded, at once and without confirmation', async ({ context, serviceWorker, extensionId }) => {
    const panel = await openPanel(context, extensionId, serviceWorker);
    await panel.locator('.bar .add').click();
    await expect(panel.locator('.row')).toHaveCount(4);
    await panel.locator('.kebab').click();
    await expect(menuItem(panel, 'Duplicate')).toBeDisabled();
    await expect(menuItem(panel, 'Move up')).toBeDisabled();
    await expect(menuItem(panel, 'Move down')).toBeDisabled();
    await menuItem(panel, 'Discard draft').click();
    await expect(panel.locator('.dialog')).toHaveCount(0);
    await expect(panel.locator('.row')).toHaveCount(3);
    await expect(panel.locator('.row').nth(0)).toHaveClass(/\bsel\b/);
    expect((await stored(serviceWorker)).rules).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test test/panel-actions.spec.js`
Expected: FAIL — there is no `.kebab` button yet.

- [ ] **Step 3: Create `panel/menu.js`**

```js
import { h } from '../shared/dom.js';
import { send } from '../shared/store.js';
import { defaultName } from '../shared/rule.js';
import { ui, uiChanged } from './ui.js';

// ── Delete confirmation ────────────────────────────────────────────────────
export function confirmDelete(name) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const finish = (answer) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (previous && previous.focus) previous.focus();
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    };
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, 'Cancel');
    const confirm = h('button', { class: 'btn danger', type: 'button', onclick: () => finish(true) }, 'Delete');
    const overlay = h(
      'div',
      { class: 'overlay' },
      h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Confirm delete' },
        h('p', {}, `Delete rule "${name}"?`),
        h('div', { class: 'actions' }, cancel, confirm)),
    );
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    cancel.focus();
  });
}

// ── The ⋮ menu of the editor header ────────────────────────────────────────
export function ruleMenu(id, api) {
  let menu = null;
  const button = h('button', {
    class: 'kebab',
    type: 'button',
    'aria-label': 'Rule actions',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    onclick: () => (menu ? close() : open()),
  }, '⋮');
  const wrap = h('div', { class: 'menu-wrap' }, button);

  function close() {
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    if (menu) {
      menu.remove();
      menu = null;
    }
    button.setAttribute('aria-expanded', 'false');
  }

  function onOutside(e) {
    if (!wrap.isConnected || !wrap.contains(e.target)) close();
  }

  function onKey(e) {
    if (!wrap.isConnected) {
      close();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      button.focus();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && menu) {
      e.preventDefault();
      const items = [...menu.querySelectorAll('.item:not(:disabled)')];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  }

  const item = (label, onClick, disabled) =>
    h('button', { class: 'item', type: 'button', role: 'menuitem', disabled, onclick: () => { close(); onClick(); } }, label);

  function open() {
    const rules = api.rules();
    const index = rules.findIndex((r) => r.id === id);
    const isDraft = index < 0; // not stored yet
    menu = h(
      'div',
      { class: 'menu', role: 'menu' },
      item('Duplicate', duplicate, isDraft),
      item('Move up', () => move('up'), isDraft || index === 0),
      item('Move down', () => move('down'), isDraft || index === rules.length - 1),
      isDraft ? item('Discard draft', discard, false) : item('Delete', remove, false),
    );
    wrap.append(menu);
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    const first = menu.querySelector('.item:not(:disabled)');
    if (first) first.focus();
  }

  async function duplicate() {
    const rule = api.latest(id);
    if (!rule) return;
    const res = await send({ type: 'SAVE_RULE', rule: { ...rule, id: undefined, name: `${rule.name || defaultName(rule.url)} copy` } });
    if (!res || !res.ok) return;
    await api.refresh();
    ui.selectedId = res.rule.id;
    uiChanged();
  }

  async function move(dir) {
    await send({ type: 'REORDER', id, dir });
    await api.refresh();
  }

  async function remove() {
    const rule = api.latest(id);
    const name = (rule && (rule.name || defaultName(rule.url))) || 'this rule';
    if (!(await confirmDelete(name))) return;
    await send({ type: 'DELETE_RULE', id });
    await api.refresh();
  }

  function discard() {
    ui.drafts.delete(id);
    ui.unsaved.delete(id);
    uiChanged();
  }

  return wrap;
}
```

- [ ] **Step 4: Wire the menu into the editor and the panel**

In `panel/editor.js` add the import:

```js
import { ruleMenu } from './menu.js';
```

and change the header line of the `el` element to:

```js
    h('div', { class: 'ed-top' }, nameInput, saved, h('span', { class: 'sp' }), ruleMenu(id, api)),
```

In `panel/panel.js` extend the editor API:

```js
const editorApi = { latest, refresh: () => update(), rules: () => (data ? data.state.rules : []) };
```

- [ ] **Step 5: Append the styles to `panel/panel.css`**

```css
.menu-wrap { position: relative; }
.kebab { width: 26px; height: 26px; background: transparent; border: 1px solid transparent; border-radius: var(--r); color: var(--mu); font-size: 16px; line-height: 1; }
.kebab:hover, .kebab[aria-expanded='true'] { border-color: var(--bd); color: var(--tx); }
.menu { position: absolute; right: 0; top: 30px; z-index: 10; min-width: 160px; padding: 4px; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--bd); border-radius: var(--r); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); }
.menu .item { text-align: left; padding: 6px 10px; background: transparent; border: 0; border-radius: 4px; font-size: 12px; }
.menu .item:hover:not(:disabled), .menu .item:focus-visible { background: var(--bd-soft); }
.menu .item:disabled { color: var(--mu); opacity: 0.5; cursor: default; }

.overlay { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; background: rgba(10, 12, 20, 0.6); }
.dialog { width: 320px; padding: 16px; background: var(--surface); border: 1px solid var(--bd); border-radius: 10px; }
.dialog p { margin-bottom: 14px; }
.dialog .actions { display: flex; justify-content: flex-end; gap: 8px; }
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx playwright test test/panel-actions.spec.js test/panel-editor.spec.js test/panel-list.spec.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add panel test/panel-actions.spec.js
git commit -m "feat(panel): rule menu with duplicate, reorder, delete confirmation and draft discard"
```

---

### Task 6: Panel log — live entries, filters, clear

**Files:**
- Create: `panel/log.js`, `test/panel-log.spec.js`
- Modify: `panel/panel.js`, `panel/panel.css`

**Interfaces:**
- Consumes: the `log` array that `readAll(ui.tabId)` returns (`LogEntry[]` written by the service worker in Plan 1), `send({ type: 'CLEAR_LOG', tabId })`, `h`, `clear`, `methodLabel`, `METHODS`.
- Produces: `panel/log.js#renderLog(slot, { log, tabId })` — renders `.log` into `#log-slot`; keeps the chosen filter between renders; sticks to the bottom while the user has not scrolled up.
- DOM (selectors for tests): `.log` → `.log-h` (`b` "Log", `.mu` `· this tab · N`, three `button.chip[aria-pressed]` — `All`, `Mocked N`, `Issues N` — and `button.btn.clear`) and `.log-list` with one `.lr` per entry; `.lr.none` for the empty message.
- Rows (UI doc section 3): a mocked request shows time (local `HH:MM:SS`), method label, path and query (full URL in the tooltip), `→ rule name`, a status pill (2xx `good`, 3xx `info`, 4xx `warn`, 5xx `bad`) and `N ms`. `unavailable` shows `!` + `rules-unavailable` + `Rules didn't load in time — request passed through to the network`. `error` shows `×` + `engine-error` + `Rule "<name>": couldn't build the response — request passed through` (or `Engine error — request passed through` without a rule; the raw message is the tooltip). Empty log: `No mocked requests on this tab yet.`; empty filter: `Nothing to show for this filter.`; no tab (panel opened outside DevTools without `?tabId`): `Open this panel from DevTools to see the log of the inspected tab.` and Clear is disabled.
- Untrusted data: everything in the log came from a web page; it is rendered as text only, and an unknown method never becomes a CSS class.

- [ ] **Step 1: Write the failing test `test/panel-log.spec.js`**

```js
const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage, openPageWithTab } = require('./helpers');

const post = (page, message) => page.evaluate((m) => window.postMessage(m, '*'), message);

async function openLog(context, server, serviceWorker, extensionId, rules = []) {
  await setState(serviceWorker, { rules });
  const { page, tabId } = await openPageWithTab(context, server, serviceWorker);
  const panel = await openExtensionPage(context, extensionId, `panel/panel.html?tabId=${tabId}`);
  await panel.locator('.log').waitFor();
  return { page, panel, tabId };
}

test.describe('panel: log', () => {
  test('starts empty', async ({ context, server, serviceWorker, extensionId }) => {
    const { panel } = await openLog(context, server, serviceWorker, extensionId);
    await expect(panel.locator('.log-h')).toContainText('this tab · 0');
    await expect(panel.locator('.lr.none')).toHaveText('No mocked requests on this tab yet.');
    await expect(panel.locator('.btn.clear')).toBeDisabled();
  });

  test('shows mocked requests as they happen (spec assumption 4: storage.session onChanged reaches the panel)', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, panel } = await openLog(context, server, serviceWorker, extensionId, [
      rule({ id: 'r1', name: 'Users list', url: '/mocked', response: { status: 500, delay: 5 } }),
    ]);
    await page.evaluate(() => fetch('/mocked?page=2'));
    await expect(panel.locator('.log-list .lr')).toHaveCount(1);
    const row = panel.locator('.log-list .lr').nth(0);
    await expect(row.locator('.t')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
    await expect(row.locator('.mth')).toHaveText('GET');
    await expect(row.locator('.u')).toHaveText('/mocked?page=2');
    await expect(row).toHaveAttribute('title', server.origin + '/mocked?page=2');
    await expect(row).toContainText('→ Users list');
    await expect(row.locator('.st')).toHaveText('500');
    await expect(row.locator('.st')).toHaveClass(/\bbad\b/);
    await expect(row).toContainText('5 ms');
    await expect(panel.locator('.log-h')).toContainText('this tab · 1');
  });

  test('status pills follow the status class', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, panel } = await openLog(context, server, serviceWorker, extensionId, [
      rule({ id: 'a', url: '/s200', response: { status: 200 } }),
      rule({ id: 'b', url: '/s302', response: { status: 302 } }),
      rule({ id: 'c', url: '/s404', response: { status: 404 } }),
    ]);
    for (const p of ['/s200', '/s302', '/s404']) await page.evaluate((u) => fetch(u), p);
    await expect(panel.locator('.log-list .st')).toHaveCount(3);
    await expect(panel.locator('.log-list .st')).toHaveClass([/\bgood\b/, /\binfo\b/, /\bwarn\b/]);
  });

  test('issues are listed with an explanation; the filter chips count and filter', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, panel } = await openLog(context, server, serviceWorker, extensionId, [
      rule({ id: 'r1', name: 'Orders', url: '/mocked' }),
    ]);
    await page.evaluate(() => fetch('/mocked'));
    await post(page, { type: '__API_MOCK__/RULES_UNAVAILABLE' });
    await post(page, { type: '__API_MOCK__/ENGINE_ERROR', message: 'boom', ruleId: 'r1' });
    await post(page, { type: '__API_MOCK__/ENGINE_ERROR', message: 'other' });
    await expect(panel.locator('.log-list .lr')).toHaveCount(4);

    await expect(panel.locator('.lr.warn')).toContainText("rules-unavailable");
    await expect(panel.locator('.lr.warn')).toContainText("Rules didn't load in time — request passed through to the network");
    await expect(panel.locator('.lr.fail').nth(0)).toContainText('engine-error');
    await expect(panel.locator('.lr.fail').nth(0)).toContainText('Rule "Orders": couldn\'t build the response — request passed through');
    await expect(panel.locator('.lr.fail').nth(0)).toHaveAttribute('title', 'boom');
    await expect(panel.locator('.lr.fail').nth(1)).toContainText('Engine error — request passed through');

    await expect(panel.locator('.chip')).toHaveText(['All', 'Mocked 1', 'Issues 3']);
    await expect(panel.locator('.chip').nth(0)).toHaveAttribute('aria-pressed', 'true');
    await panel.locator('.chip', { hasText: 'Issues' }).click();
    await expect(panel.locator('.log-list .lr')).toHaveCount(3);
    await expect(panel.locator('.chip', { hasText: 'Issues' })).toHaveAttribute('aria-pressed', 'true');
    await panel.locator('.chip', { hasText: 'Mocked' }).click();
    await expect(panel.locator('.log-list .lr')).toHaveCount(1);
    await panel.locator('.chip', { hasText: 'All' }).click();
    await expect(panel.locator('.log-list .lr')).toHaveCount(4);
  });

  test('an empty filter says so', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, panel } = await openLog(context, server, serviceWorker, extensionId, [rule({ url: '/mocked' })]);
    await page.evaluate(() => fetch('/mocked'));
    await expect(panel.locator('.log-list .lr')).toHaveCount(1);
    await panel.locator('.chip', { hasText: 'Issues' }).click();
    await expect(panel.locator('.lr.none')).toHaveText('Nothing to show for this filter.');
  });

  test('Clear empties the log', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, panel, tabId } = await openLog(context, server, serviceWorker, extensionId, [rule({ url: '/mocked' })]);
    await page.evaluate(() => fetch('/mocked'));
    await expect(panel.locator('.log-list .lr')).toHaveCount(1);
    await panel.locator('.btn.clear').click();
    await expect(panel.locator('.lr.none')).toHaveText('No mocked requests on this tab yet.');
    await expect.poll(() => serviceWorker.evaluate((id) => chrome.storage.session.get(`log:${id}`).then((r) => r[`log:${id}`]), tabId)).toEqual([]);
  });

  test('new entries scroll into view unless the user scrolled up', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, panel } = await openLog(context, server, serviceWorker, extensionId);
    const forge = (n, from) =>
      page.evaluate(([count, start]) => {
        for (let i = 0; i < count; i++) {
          window.postMessage({ type: '__API_MOCK__/MOCK_EVENT', ruleId: 'none', url: `/n/${start + i}`, method: 'GET', status: 200 }, '*');
        }
      }, [n, from]);
    const geometry = () => panel.locator('.log-list').evaluate((el) => ({ top: el.scrollTop, gap: el.scrollHeight - el.clientHeight - el.scrollTop, scrolls: el.scrollHeight > el.clientHeight }));

    await forge(30, 0);
    await expect(panel.locator('.log-list .lr')).toHaveCount(30);
    await expect.poll(async () => (await geometry()).gap).toBeLessThan(6); // stuck to the bottom
    expect((await geometry()).scrolls).toBe(true);

    await panel.locator('.log-list').evaluate((el) => { el.scrollTop = 0; });
    await forge(3, 30);
    await expect(panel.locator('.log-list .lr')).toHaveCount(33);
    expect((await geometry()).top).toBe(0); // the view did not jump
  });

  test('without a tab the panel explains itself and Clear is disabled', async ({ context, extensionId }) => {
    const panel = await openExtensionPage(context, extensionId, 'panel/panel.html');
    await expect(panel.locator('.lr.none')).toHaveText('Open this panel from DevTools to see the log of the inspected tab.');
    await expect(panel.locator('.btn.clear')).toBeDisabled();
  });

  test('log content is text, and an unknown method is never used as a class', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, panel } = await openLog(context, server, serviceWorker, extensionId);
    await post(page, { type: '__API_MOCK__/MOCK_EVENT', ruleId: 'x', url: '/<img src=x onerror="window.__xss=1">', method: 'NOT A METHOD', status: 200 });
    await expect(panel.locator('.log-list .lr')).toHaveCount(1);
    expect(await panel.evaluate(() => window.__xss)).toBeUndefined();
    expect(await panel.locator('.log-list img').count()).toBe(0);
    await expect(panel.locator('.log-list .mth')).toHaveClass(/\bANY\b/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test test/panel-log.spec.js`
Expected: FAIL — `#log-slot` is empty, there is no `.log`.

- [ ] **Step 3: Create `panel/log.js`**

```js
import { h, clear } from '../shared/dom.js';
import { send } from '../shared/store.js';
import { METHODS, methodLabel } from '../shared/rule.js';

let filter = 'all'; // all | mocked | issues
let lastData = null;

const isMock = (e) => e.kind === 'mock';
const timeOf = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });
const statusClass = (s) => (s >= 500 ? 'bad' : s >= 400 ? 'warn' : s >= 300 ? 'info' : 'good');

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch (_) {
    return String(url);
  }
}

function entryRow(e) {
  const time = h('span', { class: 't' }, timeOf(e.ts));
  if (e.kind === 'mock') {
    const method = METHODS.includes(e.method) ? e.method : 'ANY'; // never trust page data as a class name
    return h(
      'div',
      { class: 'lr', title: e.url },
      time,
      h('span', { class: `mth ${method}` }, methodLabel(e.method)),
      h('span', { class: 'u' }, pathOf(e.url)),
      e.ruleName ? h('span', { class: 'mu' }, `→ ${e.ruleName}`) : null,
      h('span', { class: 'sp' }),
      h('span', { class: `st ${statusClass(e.status)}` }, String(e.status)),
      e.delay !== undefined ? h('span', { class: 'mu' }, `${e.delay} ms`) : null,
    );
  }
  if (e.kind === 'unavailable') {
    return h(
      'div',
      { class: 'lr warn' },
      time,
      h('span', { class: 'ic' }, '!'),
      h('span', { class: 'u' }, 'rules-unavailable'),
      h('span', { class: 'why' }, "Rules didn't load in time — request passed through to the network"),
    );
  }
  const why = e.ruleName
    ? `Rule "${e.ruleName}": couldn't build the response — request passed through`
    : 'Engine error — request passed through';
  return h(
    'div',
    { class: 'lr fail', title: e.message },
    time,
    h('span', { class: 'ic' }, '×'),
    h('span', { class: 'u' }, 'engine-error'),
    h('span', { class: 'why' }, why),
  );
}

/** Renders the log of one tab into `slot`. `data = { log, tabId }`. */
export function renderLog(slot, data) {
  lastData = data;
  const { log, tabId } = data;

  // Stick to the bottom unless the user scrolled up.
  const previous = slot.querySelector('.log-list');
  const stick = !previous || previous.scrollTop + previous.clientHeight >= previous.scrollHeight - 4;
  const previousTop = previous ? previous.scrollTop : 0;

  const mocked = log.filter(isMock).length;
  const issues = log.length - mocked;
  const shown = filter === 'mocked' ? log.filter(isMock) : filter === 'issues' ? log.filter((e) => !isMock(e)) : log;

  const chip = (key, label) =>
    h('button', { class: 'chip', type: 'button', 'aria-pressed': String(filter === key), onclick: () => { filter = key; renderLog(slot, lastData); } }, label);

  const list = h('div', { class: 'log-list' });
  if (tabId == null) list.append(h('div', { class: 'lr none' }, 'Open this panel from DevTools to see the log of the inspected tab.'));
  else if (!shown.length) list.append(h('div', { class: 'lr none' }, log.length ? 'Nothing to show for this filter.' : 'No mocked requests on this tab yet.'));
  else list.append(...shown.map(entryRow));

  clear(slot).append(
    h(
      'div',
      { class: 'log' },
      h(
        'div',
        { class: 'log-h' },
        h('b', {}, 'Log'),
        h('span', { class: 'mu' }, `· this tab · ${log.length}`),
        chip('all', 'All'),
        chip('mocked', `Mocked ${mocked}`),
        chip('issues', `Issues ${issues}`),
        h('span', { class: 'sp' }),
        h('button', { class: 'btn clear', type: 'button', disabled: tabId == null || log.length === 0, onclick: () => send({ type: 'CLEAR_LOG', tabId }) }, 'Clear'),
      ),
      list,
    ),
  );
  list.scrollTop = stick ? list.scrollHeight : previousTop;
}
```

- [ ] **Step 4: Render the log from `panel/panel.js`**

Add the import:

```js
import { renderLog } from './log.js';
```

At the end of `render()` (after the editor mounting block) add:

```js
  renderLog(els.logSlot, { log: data.log, tabId: ui.tabId });
```

- [ ] **Step 5: Append the log styles to `panel/panel.css`**

```css
.log { flex: none; height: 118px; display: flex; flex-direction: column; border-top: 1px solid var(--bd); background: var(--bg); }
.log-h { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; flex: none; background: var(--surface); border-bottom: 1px solid var(--bd-soft); }
.chip { font-size: 10.5px; padding: 2px 9px; border-radius: 9px; border: 1px solid var(--bd); background: transparent; color: var(--mu); }
.chip[aria-pressed='true'] { background: var(--surface); color: var(--tx); border-color: var(--ac); }
.log-list { flex: 1; overflow: auto; }

.lr { display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 4px 10px; border-bottom: 1px solid var(--bd-soft); }
.lr.none { justify-content: center; min-height: 44px; color: var(--mu); }
.lr .t { flex: none; color: var(--mu); font-size: 10.5px; }
.lr .u { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lr .mth { min-width: 36px; padding: 2px 0; }
.lr .why { color: var(--mu); font-size: 11px; }
.lr.warn { color: var(--warn); }
.lr.fail { color: var(--err-text); }
.ic { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; font-weight: 700; font-size: 10px; }
.lr.warn .ic { background: color-mix(in srgb, var(--warn) 20%, transparent); }
.lr.fail .ic { background: color-mix(in srgb, var(--err) 20%, transparent); }

.st { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; font-weight: 700; padding: 1px 6px; border-radius: 9px; }
.st.good { color: var(--ok); background: color-mix(in srgb, var(--ok) 15%, transparent); }
.st.info { color: var(--put); background: color-mix(in srgb, var(--put) 15%, transparent); }
.st.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 15%, transparent); }
.st.bad { color: var(--err-text); background: color-mix(in srgb, var(--err) 15%, transparent); }
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx playwright test test/panel-log.spec.js` and then `npx playwright test`
Expected: PASS for the whole suite. If the first test fails on the live update, **spec assumption 4 is wrong** (`storage.session.onChanged` does not reach the panel): stop and report.

- [ ] **Step 7: Commit**

```bash
git add panel test/panel-log.spec.js
git commit -m "feat(panel): live per-tab log with filters, clear and stick-to-bottom scrolling"
```

---

### Task 7: End-to-end through the UI, documentation and manual checks

**Files:**
- Create: `test/e2e-ui.spec.js`
- Modify: `README.md`, `CLAUDE.md`, `MEMORY.md`

**Interfaces:**
- Consumes: everything from Plan 1 and Tasks 1–6 (panel, popup, service worker, engine, bridge, badge).
- Produces: the UI smoke test required by the spec (design spec section 10, test 7) and up-to-date repository documentation.

- [ ] **Step 1: Write the end-to-end test `test/e2e-ui.spec.js`**

```js
const { test, expect } = require('./fixtures');
const { rule, setState, openExtensionPage, openPageWithTab } = require('./helpers');

const badgeText = (sw, tabId) => sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
const fetchSummary = (page, url) => page.evaluate(async (u) => {
  const r = await fetch(u);
  return { status: r.status, text: await r.text() };
}, url);
const isReal = (res) => res.text.includes('"source":"server"');

async function openAll({ context, server, serviceWorker, extensionId }) {
  server.requests.length = 0;
  const { page, tabId } = await openPageWithTab(context, server, serviceWorker);
  const panel = await openExtensionPage(context, extensionId, `panel/panel.html?tabId=${tabId}`);
  const popup = await openExtensionPage(context, extensionId, `popup/popup.html?tabId=${tabId}`);
  return { page, tabId, panel, popup };
}

test.describe('end to end through the UI', () => {
  test('a rule created in the panel mocks the page, and shows up in the log, hits, popup and badge', async ({ context, server, serviceWorker, extensionId }) => {
    const { page, tabId, panel, popup } = await openAll({ context, server, serviceWorker, extensionId });

    // 1. Create the rule in the panel.
    await expect(panel.locator('.empty')).toBeVisible();
    await panel.locator('.empty .btn.pri').click();
    await panel.locator('.editor .name').fill('Users');
    await panel.locator('.editor .url').fill('/api/users*');
    await panel.locator('.editor .status').fill('500');
    await panel.locator('.editor .body').fill('{"error":"boom"}');
    await expect(panel.locator('.row .draft')).toHaveCount(0, { timeout: 5000 }); // saved
    await expect(panel.locator('.row .nm')).toHaveText('Users');

    // 2. The page is answered by the mock (the bridge pushes the new rule).
    await expect.poll(() => fetchSummary(page, '/api/users?page=1')).toEqual({ status: 500, text: '{"error":"boom"}' });
    server.requests.length = 0;
    await fetchSummary(page, '/api/users');
    expect(server.requests.some((r) => r.includes('/api/users'))).toBe(false);

    // 3. The log, the hit count, the popup and the badge all reflect it.
    await expect(panel.locator('.log-list .lr').last()).toContainText('→ Users');
    await expect(panel.locator('.log-list .lr').last().locator('.st')).toHaveText('500');
    await expect(panel.locator('.row .hit')).not.toHaveText('0', { timeout: 6000 }); // hits are flushed about 1 s later
    await expect(popup.locator('.status')).toContainText('mocked on this tab');
    await expect.poll(() => badgeText(serviceWorker, tabId)).toMatch(/^\d+$/);
  });

  test('switches in the popup and the panel stop and resume mocking; deleting the rule empties everything', async ({ context, server, serviceWorker, extensionId }) => {
    await setState(serviceWorker, {
      rules: [rule({ id: 'a', name: 'Users', url: '/api/users*', response: { status: 500, body: '{"error":"boom"}' } })],
    });
    const { page, tabId, panel, popup } = await openAll({ context, server, serviceWorker, extensionId });
    await expect.poll(() => fetchSummary(page, '/api/users')).toMatchObject({ status: 500 });

    // The rule switch in the popup.
    await popup.locator('.row').nth(0).locator('.tg').click();
    await expect.poll(async () => isReal(await fetchSummary(page, '/api/users'))).toBe(true);
    await popup.locator('.row').nth(0).locator('.tg').click();
    await expect.poll(async () => (await fetchSummary(page, '/api/users')).status).toBe(500);

    // The global switch in the panel.
    await panel.locator('.bar .tg').click();
    await expect.poll(async () => isReal(await fetchSummary(page, '/api/users'))).toBe(true);
    await expect(popup.locator('.status')).toContainText('Off · requests go straight to the network');
    await expect.poll(() => badgeText(serviceWorker, tabId)).toBe('OFF');
    await panel.locator('.bar .tg').click();
    await expect.poll(async () => (await fetchSummary(page, '/api/users')).status).toBe(500);

    // Delete the rule from the panel.
    await panel.locator('.kebab').click();
    await panel.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await panel.locator('.dialog .btn.danger').click();
    await expect(panel.locator('.empty')).toBeVisible();
    await expect(popup.locator('.status')).toContainText('Active · no rules yet');
    await expect.poll(async () => isReal(await fetchSummary(page, '/api/users'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the end-to-end test and the whole suite**

Run: `npx playwright test test/e2e-ui.spec.js` and then `npx playwright test`
Expected: PASS. A failure here after Tasks 1–6 pass individually points to an integration problem between the panel's writes, the bridge's `storage.onChanged` push and the service worker's counters: debug it with `npm run test:headed` and fix the cause; do not weaken the assertions.

- [ ] **Step 3: Update `README.md`**

Replace the status block-quote near the top with:

```markdown
> Status: the core (engine, bridge, service worker) and the UI (DevTools panel, popup) are implemented.
```

Add this section after "Install (developer mode)":

````markdown
## Using it

1. Open DevTools (F12) on the page you are working on and select the **API Mock** tab.
2. Click **+ Add rule**. Fill in the URL pattern (see below), method, status, delay, headers and body. Rules save automatically; a red *Not applied* / *Unsaved edits* label means the last edit is invalid and is not in use yet.
3. Reload nothing: matching `fetch`/`XHR` calls on the page are answered right away. Mocked requests do **not** appear in the Network tab — watch the **Log** at the bottom of the panel instead.
4. The toolbar icon opens a small control: the global on/off switch, a per-rule switch, and a status line for the current tab. The badge shows how many requests were mocked on the tab (`!` when something went wrong, `OFF` when mocking is off).
````

Keep "Try it without a UI" but retitle it "Seeding a rule from the service worker console (debugging)".

- [ ] **Step 4: Update `CLAUDE.md`**

Add this section after "Architecture":

````markdown
## UI (panel and popup)

- Plain ES-module pages, no build. The DevTools panel is `panel/panel.html` (registered by `devtools.js`); the popup is `popup/popup.html`.
- **Reads** come straight from `chrome.storage` (`shared/store.js#readAll`, re-run on `subscribe`); **writes** are service-worker messages (`SAVE_RULE`, `DELETE_RULE`, `REORDER`, `SET_GLOBAL`, `CLEAR_LOG`). The UI never writes `state`.
- `shared/dom.js#h()` builds DOM. **Never** use `innerHTML` with data: rule names, URLs and log entries are untrusted.
- Panel modules: `panel.js` (bar, list, wiring), `editor.js` (form, validation, 700 ms auto-save, drafts), `menu.js` (⋮ menu, delete dialog), `log.js` (log view), `ui.js` (UI-only state: selection, search, drafts). Drafts (new rules that are not valid yet) live only in memory; after a save the panel calls `api.refresh()` before dropping the draft.
- Test hooks: `panel/panel.html?tabId=<id>` and `popup/popup.html?tabId=<id>` target a tab; in real DevTools the panel uses `chrome.devtools.inspectedWindow.tabId`. `openExtensionPage()` in tests opens `devtools.html` by default (a neutral extension page).
- Styling: tokens and shared components in `shared/ui.css` (visual style B, see the UI design doc).
````

- [ ] **Step 5: Record the results in `MEMORY.md`**

Append under "Spec assumptions": `- **2026-09-21** — 4. Panel and popup read \`storage.session\` and receive \`onChanged\` from it: <result>` (replace `<result>` with `verified` or `FAILED: <what happened>` from the test run; do not leave the marker).

Append under "Key decisions":

```markdown
- **2026-09-21** — After a draft is saved the panel must `refresh()` (re-read storage) **before** dropping the draft: otherwise a render with stale data does not find the rule, resets the selection to the first rule and remounts the editor. `render()` also de-duplicates a draft that is already stored.
- **2026-09-21** — The popup checks whether a tab has an engine by sending `PING` to frame 0 once, when it opens; inferring it from `PAGE_START` was wrong for tabs that navigate to `chrome://` pages.
- **2026-09-21** — `openExtensionPage()` defaults to `devtools.html`, a neutral page, so tests that only need "some extension page" are not affected by the real popup's activity.
```

- [ ] **Step 6: Manual checks (Playwright cannot drive the real DevTools window)**

In a normal Chrome window with the unpacked extension loaded:

1. Open DevTools on a normal page: an **API Mock** tab is present and shows the empty state with the Network-tab reminder.
2. Add a rule, trigger a matching request from the page: the row appears in the panel's **Log**; open DevTools on a **second** tab and confirm its log is independent.
3. DevTools with the **light** theme: the panel stays dark (accepted in the UI design).
4. The toolbar popup opens 380 px wide, shows the right status on a normal page, and shows **Not active on this tab yet** on `chrome://extensions`.
5. Keyboard: Tab reaches every control, the focus ring is visible, Space/Enter toggles switches, ↑/↓ move through the rules list and the ⋮ menu.
6. Reload the extension while a panel is open: the page under test keeps working (a stale panel may stop updating; that is fine).

Record the outcome of each check as one dated line in `MEMORY.md` under "Technical discoveries".

- [ ] **Step 7: Commit**

```bash
git add test/e2e-ui.spec.js README.md CLAUDE.md MEMORY.md
git commit -m "test(ui): end-to-end flows through the panel and popup; update the docs"
```

## Self-review of this plan against the specs

- **UI design doc section 2 (style):** tokens and shared components in `shared/ui.css` (Task 1); panel and popup CSS reuse them (Tasks 2–6). The mockups' sizes (row heights, widths, 118 px log) are applied in the CSS.
- **Section 3 (panel):** bar, list, drafts and pills (Task 3); editor, save indicator, validation wording, body note, Format JSON, pills **Not applied** / **Unsaved edits** (Task 4); ⋮ menu, delete confirmation, drafts discarded without confirmation (Task 5); log rows, chips, clear, scrolling, empty messages (Task 6); the empty state with the Network-tab reminder (Task 3).
- **Section 4 (popup):** status logic and its five states, `PING`, search above 5 rules, footers (Tasks 1–2). Global and per-rule switches (Task 2, and end to end in Task 7).
- **Section 5 (icon and badge):** implemented in Plan 1 (Task 10); asserted end to end in Task 7.
- **Section 6–8 (strings, accessibility, mockup differences):** strings are asserted verbatim in the tests; `role="switch"`, focus ring, keyboard navigation (Tasks 1, 3, 5); the mockup differences called out in the UI doc are implemented as the doc says (chips always visible, `--err-text`, popup search).
- **Design spec section 6 (contracts) and 10 (tests 7–8):** panel and popup read storage and write via messages (Tasks 1–6); the UI smoke test is Task 7; the popup/badge test is Task 2 and Plan 1 Task 10.
- **Known deviations to confirm with the user:** (1) the body note shows only `Not JSON` when a Content-Type header exists, instead of always `Not JSON — sent as text/plain`; (2) the log shows path and query with the full URL in the tooltip, not the host; (3) leaving a rule discards its invalid edits (drafts are kept in memory only).
