import { h, clear, logoSvg, toggleSwitch } from '../shared/dom.js';
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
function ruleRow(rule, hits) {
  return h(
    'div',
    { class: 'row' + (rule.enabled ? '' : ' off') },
    h('span', { class: `mth ${rule.method}` }, methodLabel(rule.method)),
    h('span', { class: 'txt' }, h('span', { class: 'nm' }, rule.name), h('span', { class: 'ur', title: rule.url }, rule.url)),
    h('span', { class: 'hit', title: 'Times matched' }, String(hits[rule.id] || 0)),
    toggleSwitch(rule.enabled, `Enable ${rule.name}`, () => send({ type: 'SAVE_RULE', rule: { ...rule, enabled: !rule.enabled } })),
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
    logoSvg(),
    h('span', { class: 't' }, 'API Mock'),
    h('span', { class: 'sp' }),
    h('span', { class: 'lbl' }, 'Mocking'),
    toggleSwitch(state.globalEnabled, 'Mocking', () => send({ type: 'SET_GLOBAL', enabled: !state.globalEnabled })),
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
    ...(state.rules.length === 0
      ? ["Mocked requests won't appear in the Network tab."]
      : ['Edit rules: DevTools → ', h('b', {}, 'API Mock'), ' tab']),
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
