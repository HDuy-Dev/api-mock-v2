import { h } from '../shared/dom.js';
import { send } from '../shared/store.js';
import { defaultName } from '../shared/rule.js';
import { ui, uiChanged } from './ui.js';

// ── Delete confirmation ────────────────────────────────────────────────────
export function confirmDelete(name) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const finish = (answer) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (previous && previous.focus) previous.focus();
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    };
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, 'Cancel');
    const confirm = h('button', { class: 'btn danger', type: 'button', onclick: () => finish(true) }, 'Delete');
    const overlay = h(
      'div',
      { class: 'overlay' },
      h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Confirm delete' },
        h('p', {}, `Delete rule "${name}"?`),
        h('div', { class: 'actions' }, cancel, confirm)),
    );
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    cancel.focus();
  });
}

// ── The ⋮ menu of the editor header ────────────────────────────────────────
export function ruleMenu(id, api) {
  let menu = null;
  const button = h('button', {
    class: 'kebab',
    type: 'button',
    'aria-label': 'Rule actions',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    onclick: () => (menu ? close() : open()),
  }, '⋮');
  const wrap = h('div', { class: 'menu-wrap' }, button);

  function close() {
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    if (menu) {
      menu.remove();
      menu = null;
    }
    button.setAttribute('aria-expanded', 'false');
  }

  function onOutside(e) {
    if (!wrap.isConnected || !wrap.contains(e.target)) close();
  }

  function onKey(e) {
    if (!wrap.isConnected) {
      close();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      button.focus();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && menu) {
      e.preventDefault();
      const items = [...menu.querySelectorAll('.item:not(:disabled)')];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  }

  const item = (label, onClick, disabled) =>
    h('button', { class: 'item', type: 'button', role: 'menuitem', disabled, onclick: () => { close(); onClick(); } }, label);

  function open() {
    const rules = api.rules();
    const index = rules.findIndex((r) => r.id === id);
    const isDraft = index < 0; // not stored yet
    menu = h(
      'div',
      { class: 'menu', role: 'menu' },
      item('Duplicate', duplicate, isDraft),
      item('Move up', () => move('up'), isDraft || index === 0),
      item('Move down', () => move('down'), isDraft || index === rules.length - 1),
      isDraft ? item('Discard draft', discard, false) : item('Delete', remove, false),
    );
    wrap.append(menu);
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    const first = menu.querySelector('.item:not(:disabled)');
    if (first) first.focus();
  }

  async function duplicate() {
    const rule = api.latest(id);
    if (!rule) return;
    const res = await send({ type: 'SAVE_RULE', rule: { ...rule, id: undefined, name: `${rule.name || defaultName(rule.url)} copy` } });
    if (!res || !res.ok) return;
    await api.refresh();
    ui.selectedId = res.rule.id;
    uiChanged();
  }

  async function move(dir) {
    await send({ type: 'REORDER', id, dir });
    await api.refresh();
  }

  async function remove() {
    const rule = api.latest(id);
    const name = (rule && (rule.name || defaultName(rule.url))) || 'this rule';
    if (!(await confirmDelete(name))) return;
    await send({ type: 'DELETE_RULE', id });
    await api.refresh();
  }

  function discard() {
    ui.drafts.delete(id);
    ui.unsaved.delete(id);
    uiChanged();
  }

  return wrap;
}
