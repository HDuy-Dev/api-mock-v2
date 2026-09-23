import { h, clear, logoSvg, toggleSwitch } from '../shared/dom.js';
import { readAll, subscribe, send } from '../shared/store.js';
import { methodLabel, defaultName, newRule } from '../shared/rule.js';
import { ui, onUiChange, uiChanged } from './ui.js';
import { mountEditor, unmountEditor } from './editor.js';
import { renderLog } from './log.js';

let data = null; // last read of storage
let seq = 0;
let focusSelected = false; // restore keyboard focus after a re-render caused by arrow keys
let mountedId = null; // rule currently open in the editor
const latest = (id) => ui.drafts.get(id) || (data && data.state.rules.find((r) => r.id === id)) || null;
const editorApi = { latest, refresh: () => update(), rules: () => (data ? data.state.rules : []) };

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
  } else if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
    e.preventDefault();
    focusSelected = true;
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
  // Same identity as the row's own dataset.id: lets render() restore focus to the switch
  // specifically (not just the row) when the switch itself is what had focus.
  const sw = isDraft
    ? null
    : toggleSwitch(rule.enabled, `Enable ${rule.name}`, (e) => {
        e.stopPropagation(); // switching a rule must not select it
        send({ type: 'SAVE_RULE', rule: { ...rule, enabled: !rule.enabled } });
      });
  if (sw) sw.dataset.id = rule.id;
  return h(
    'div',
    {
      class: 'row' + (rule.enabled ? '' : ' off') + (selected ? ' sel' : ''),
      role: 'option',
      tabindex: 0,
      'aria-selected': String(selected),
      dataset: { id: rule.id },
      onclick: () => { focusSelected = true; select(rule.id); },
      onkeydown: onRowKey,
    },
    h('span', { class: `mth ${rule.method}` }, methodLabel(rule.method)),
    h('span', { class: 'txt' }, h('span', { class: 'nm' }, rule.name || defaultName(rule.url)), h('span', { class: 'ur', title: rule.url }, rule.url || '(no URL yet)')),
    pill ? h('span', { class: 'draft' }, pill) : h('span', { class: 'hit', title: 'Times matched' }, String(hits[rule.id] || 0)),
    sw,
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

  // A re-render can happen for reasons that have nothing to do with the user (hit counts and log
  // entries flush from the service worker roughly every 1s/200ms while a page is being mocked).
  // Rebuilding the list always drops whatever was focused inside it, so capture its identity first.
  const inList = els.list.contains(document.activeElement);
  const hadFocusId = inList ? document.activeElement.dataset.id : undefined;
  const hadFocusSwitch = inList && document.activeElement.classList.contains('tg');

  clear(els.list);
  if (rows.length) els.list.append(...rows.map((r) => ruleRow(r, hits, drafts.includes(r))));
  else els.list.append(h('div', { class: 'no-match' }, `No rules match "${ui.query.trim()}".`));

  if (focusSelected) {
    // A user action (click, Enter/Space, arrow keys) just changed the selection: focus follows it.
    focusSelected = false;
    const row = els.list.querySelector('.row.sel');
    if (row) row.focus();
  } else if (hadFocusId !== undefined) {
    // No selection change caused this render: keep focus on the same row it was on before —
    // or, if a switch (not the row) had focus, on that same rule's switch.
    const el = [...els.list.querySelectorAll(hadFocusSwitch ? '.tg' : '.row')].find((n) => n.dataset.id === hadFocusId);
    if (el) el.focus();
  }

  const selected = all.find((r) => r.id === ui.selectedId) || null;
  if (!selected) {
    unmountEditor();
    mountedId = null;
    clear(els.editorSlot);
    if (!isEmpty) els.editorSlot.append(h('div', { class: 'placeholder' }, 'Select a rule to edit.'));
  } else if (ui.selectedId !== mountedId) {
    mountedId = ui.selectedId;
    mountEditor(els.editorSlot, selected, editorApi);
  }

  renderLog(els.logSlot, { log: data.log, tabId: ui.tabId });
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
