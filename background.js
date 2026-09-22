// Service worker (ES module). Owns state; never sits on the request path.
import { defaultState, sanitizeRule, validateRule } from './shared/rule.js';

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
  return false;
});
