// Tiny DOM helper. Text is always inserted as text nodes: HTML in data is never interpreted.

/** h('div', { class: 'row', onclick }, child, 'text', [more]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key !== 'style' && key !== 'list' && key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The extension's mark (a ">" in a rounded square), coloured by currentColor. */
export function logoSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.classList.add('logo');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M8 9l3 3-3 3M13 15h3M3 5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5z');
  svg.append(path);
  return svg;
}

/** A switch: <button class="tg on" role="switch" aria-checked="true">. */
export function toggleSwitch(on, label, onClick) {
  return h('button', {
    class: 'tg' + (on ? ' on' : ''),
    type: 'button',
    role: 'switch',
    'aria-checked': String(on),
    'aria-label': label,
    onclick: onClick,
  });
}
