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

  function compileRule(rule) {
    const pattern = String(rule.url);
    const pathOnly = pattern.startsWith('/');
    const hasQuery = pattern.includes('?');
    const re = wildcardToRegExp(pattern);
    const method = String(rule.method).toUpperCase();
    return {
      id: rule.id,
      response: compileResponse(rule.response),
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
