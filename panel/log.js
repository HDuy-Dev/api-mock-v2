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

  // A re-render (a mocked request arriving, roughly every 200ms while a page is being mocked, or a
  // filter chip click re-rendering itself) always drops whatever was focused: capture its identity
  // first — the filter key for a chip, or 'clear' for the Clear button — and restore it after.
  const hadFocusKey = slot.contains(document.activeElement) ? document.activeElement.dataset.focusKey : undefined;

  const mocked = log.filter(isMock).length;
  const issues = log.length - mocked;
  const shown = filter === 'mocked' ? log.filter(isMock) : filter === 'issues' ? log.filter((e) => !isMock(e)) : log;

  const chip = (key, label) =>
    h('button', { class: 'chip', type: 'button', dataset: { focusKey: `chip-${key}` }, 'aria-pressed': String(filter === key), onclick: () => { filter = key; renderLog(slot, lastData); } }, label);

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
        h('button', { class: 'btn clear', type: 'button', dataset: { focusKey: 'clear' }, disabled: tabId == null || log.length === 0, onclick: () => send({ type: 'CLEAR_LOG', tabId }) }, 'Clear'),
      ),
      list,
    ),
  );
  list.scrollTop = stick ? list.scrollHeight : previousTop;

  if (hadFocusKey !== undefined) {
    const el = [...slot.querySelectorAll('[data-focus-key]')].find((n) => n.dataset.focusKey === hadFocusKey);
    if (el) el.focus();
  }
}
