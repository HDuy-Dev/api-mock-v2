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
