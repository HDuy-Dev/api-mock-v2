import { h, clear } from '../shared/dom.js';
import { send } from '../shared/store.js';
import { METHODS, validateRule, parseHeaders, stringifyHeaders, isJson, formatJson } from '../shared/rule.js';
import { ui, uiChanged } from './ui.js';

const AUTOSAVE_MS = 700;
const SAVED_VISIBLE_MS = 2000;

let current = null; // controller of the mounted editor

export function unmountEditor() {
  if (current) current.destroy();
  current = null;
}

/**
 * Mounts the editor for `rule` into `container`.
 * `api.latest(id)` returns the newest stored rule or draft; `api.refresh()` re-reads storage and re-renders.
 */
export function mountEditor(container, rule, api) {
  unmountEditor();
  const id = rule.id;
  const form = {
    name: rule.name,
    method: rule.method,
    url: rule.url,
    status: String(rule.response.status),
    delay: String(rule.response.delay),
    headers: stringifyHeaders(rule.response.headers),
    body: rule.response.body,
  };
  let touched = false; // errors are shown only after the first edit
  let errors = {};
  let saveTimer = 0;
  let savedTimer = 0;
  let destroyed = false;

  // ── Form → rule ──────────────────────────────────────────────────────────
  const wholeNumber = (text) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN);

  function evaluate(base) {
    const parsed = parseHeaders(form.headers);
    const candidate = {
      id,
      enabled: base.enabled,
      name: form.name,
      method: form.method,
      url: form.url,
      response: {
        status: wholeNumber(form.status),
        headers: parsed.headers,
        body: form.body,
        delay: form.delay.trim() === '' ? 0 : wholeNumber(form.delay),
      },
    };
    const found = validateRule(candidate).errors;
    if (parsed.error) found.headers = parsed.error;
    return { candidate, errors: found, headersOk: !parsed.error };
  }

  // ── Elements ─────────────────────────────────────────────────────────────
  const onEdit = () => handleEdit();
  const nameInput = h('input', { class: 'name', value: form.name, placeholder: 'Rule name', 'aria-label': 'Rule name', oninput: (e) => { form.name = e.target.value; onEdit(); } });
  const saved = h('span', { class: 'saved' });
  const methodSelect = h('select', { class: 'method ' + form.method, 'aria-label': 'HTTP method', onchange: (e) => { form.method = e.target.value; methodSelect.className = 'method ' + form.method; onEdit(); } }, METHODS.map((m) => h('option', { value: m }, m)));
  methodSelect.value = form.method;
  const urlInput = h('input', { class: 'url mono', value: form.url, placeholder: 'https://api.example.com/users  or  /api/users*', spellcheck: false, 'aria-label': 'URL pattern', oninput: (e) => { form.url = e.target.value; onEdit(); } });
  const statusInput = h('input', { class: 'status mono', value: form.status, inputmode: 'numeric', 'aria-label': 'Status code', oninput: (e) => { form.status = e.target.value; onEdit(); } });
  const delayInput = h('input', { class: 'delay mono', value: form.delay, inputmode: 'numeric', 'aria-label': 'Delay in milliseconds', oninput: (e) => { form.delay = e.target.value; onEdit(); } });
  const headersArea = h('textarea', { class: 'headers', rows: 2, spellcheck: false, value: form.headers, placeholder: 'Key: Value   (one per line)', 'aria-label': 'Response headers', oninput: (e) => { form.headers = e.target.value; onEdit(); } });
  const bodyArea = h('textarea', { class: 'body', spellcheck: false, value: form.body, 'aria-label': 'Response body', oninput: (e) => { form.body = e.target.value; onEdit(); } });
  const note = h('span', { class: 'note' });
  const formatBtn = h('button', { class: 'btn format', type: 'button', onclick: () => {
    const out = formatJson(form.body);
    if (!out.ok) return;
    form.body = out.text;
    bodyArea.value = out.text;
    onEdit();
  } }, 'Format JSON');

  const msg = (name) => h('span', { class: 'fmsg', dataset: { for: name } });
  const msgs = { url: msg('url'), status: msg('status'), delay: msg('delay'), headers: msg('headers') };
  const controls = { url: urlInput, status: statusInput, delay: delayInput, headers: headersArea };

  const el = h(
    'div',
    { class: 'editor' },
    h('div', { class: 'ed-top' }, nameInput, saved, h('span', { class: 'sp' })),
    h('div', { class: 'line' }, methodSelect, h('div', { class: 'fld grow' }, urlInput, msgs.url)),
    h('div', { class: 'line' },
      h('div', { class: 'fld' }, 'Status', statusInput, msgs.status),
      h('div', { class: 'fld' }, 'Delay (ms)', delayInput, msgs.delay)),
    h('div', { class: 'fld' }, 'Headers', headersArea, msgs.headers),
    h('div', { class: 'fld grow' }, h('div', { class: 'lbl-row' }, 'Body', h('span', { class: 'sp' }), formatBtn, note), bodyArea),
  );
  clear(container).append(el);

  // ── Feedback ─────────────────────────────────────────────────────────────
  function paintErrors() {
    for (const field of Object.keys(msgs)) {
      const text = touched ? errors[field] || '' : '';
      msgs[field].textContent = text;
      controls[field].classList.toggle('err', Boolean(text));
    }
  }

  function paintNote() {
    const hasContentType = parseHeaders(form.headers).headers.some((x) => x.name.toLowerCase() === 'content-type');
    note.className = 'note';
    if (!form.body.trim()) note.textContent = '';
    else if (isJson(form.body)) {
      note.textContent = '✓ Valid JSON';
      note.classList.add('ok');
    } else note.textContent = hasContentType ? 'Not JSON' : 'Not JSON — sent as text/plain';
  }

  function setIndicator(kind) {
    clearTimeout(savedTimer);
    saved.className = 'saved';
    if (kind === 'saving') {
      saved.classList.add('mu');
      saved.textContent = 'Saving…';
    } else if (kind === 'saved') {
      saved.textContent = '✓ Saved';
      savedTimer = setTimeout(() => setIndicator('idle'), SAVED_VISIBLE_MS);
    } else if (kind === 'error') {
      const n = Object.keys(errors).length;
      saved.classList.add('bad');
      saved.textContent = `● Not saved — fix ${n} error${n === 1 ? '' : 's'}`;
    } else saved.textContent = '';
  }

  // ── Editing and saving ───────────────────────────────────────────────────
  const wholeOr = (value, fallback) => (Number.isInteger(value) ? value : fallback);

  function handleEdit() {
    touched = true;
    const base = api.latest(id);
    if (!base) return; // deleted elsewhere
    const out = evaluate(base);
    errors = out.errors;
    paintErrors();
    paintNote();
    const invalid = Object.keys(errors).length > 0;

    if (ui.drafts.has(id)) {
      // Keep the draft in sync so it survives switching to another rule.
      ui.drafts.set(id, {
        ...base,
        name: form.name,
        method: form.method,
        url: form.url,
        response: {
          status: wholeOr(out.candidate.response.status, base.response.status),
          delay: wholeOr(out.candidate.response.delay, base.response.delay),
          headers: out.headersOk ? out.candidate.response.headers : base.response.headers,
          body: form.body,
        },
      });
    } else if (invalid) ui.unsaved.add(id);
    else ui.unsaved.delete(id);

    clearTimeout(saveTimer);
    if (invalid) setIndicator('error');
    else {
      setIndicator('idle');
      saveTimer = setTimeout(save, AUTOSAVE_MS);
    }
    uiChanged();
  }

  async function save() {
    saveTimer = 0;
    const base = api.latest(id);
    if (!base) return;
    const out = evaluate(base);
    if (Object.keys(out.errors).length) return;
    if (!destroyed) setIndicator('saving');
    const res = await send({ type: 'SAVE_RULE', rule: out.candidate });
    if (res && res.ok) {
      await api.refresh(); // the panel now knows the stored rule, so the draft can go without a flicker
      ui.drafts.delete(id);
      ui.unsaved.delete(id);
      if (!destroyed) setIndicator('saved');
    } else if (!destroyed) {
      errors = (res && res.errors) || { url: 'Could not save' };
      paintErrors();
      setIndicator('error');
    }
    uiChanged();
  }

  paintNote();

  current = {
    destroy() {
      destroyed = true;
      clearTimeout(savedTimer);
      if (saveTimer) {
        clearTimeout(saveTimer);
        save(); // flush a pending valid save; the form is valid, otherwise no timer was set
      } else if (!ui.drafts.has(id) && ui.unsaved.delete(id)) {
        uiChanged(); // invalid edits of a saved rule are discarded
      }
    },
  };
}
