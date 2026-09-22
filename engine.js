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
