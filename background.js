// Service worker (ES module). Owns state; never sits on the request path.
import { defaultState, sanitizeRule, validateRule } from './shared/rule.js';
import { computeBadge, drawIcon } from './shared/status.js';

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
    }).then(async (result) => {
      const h = await loadHits();
      if (id in h) {
        delete h[id];
        scheduleHitsFlush();
      }
      return result;
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

  CLEAR_LOG: ({ tabId }) =>
    enqueue(async () => {
      if (!Number.isInteger(tabId)) return;
      const t = await loadTab(tabId);
      t.log = [];
      t.counters.issues = 0;
      markDirty(t);
      await afterTabChange(tabId);
    }).then(() => ({ ok: true })),
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

  const event = EVENTS[msg.type];
  if (event && sender.tab && !isExtensionPage(sender)) {
    const ctx = { tabId: sender.tab.id, frameId: sender.frameId };
    enqueue(() => event(msg, ctx));
  }
  return false;
});

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

// Called after a tab's counters or log changed.
async function afterTabChange(tabId) {
  await applyBadge(tabId, (await readState()).globalEnabled);
}

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
