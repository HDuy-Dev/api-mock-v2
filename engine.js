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
  const nativeStopImmediate = Event.prototype.stopImmediatePropagation;
  const state = { rules: [], rulesLoaded: false, gaveUp: false };

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
      Reflect.apply(nativeStopImmediate, ev, []);
      loadRules(d.rules);
    },
    true,
  );

  // ── fetch ────────────────────────────────────────────────────────────────
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
})();
