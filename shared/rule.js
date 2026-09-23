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

const SHORT_METHOD = { DELETE: 'DEL', OPTIONS: 'OPT' };
export function methodLabel(method) {
  return SHORT_METHOD[method] || method;
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
