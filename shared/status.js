// Shared by the service worker and (Plan 2) the popup. Pure, except drawIcon (needs OffscreenCanvas).

// ── Badge ──────────────────────────────────────────────────────────────────
// Priority: mocking off > issues on this tab > mocked count > nothing.
export function computeBadge({ globalEnabled, mocked = 0, issues = 0 }) {
  if (!globalEnabled) return { text: 'OFF', bg: '#4b5563', color: '#ffffff', title: 'API Mock — Off' };
  if (issues > 0) {
    return { text: '!', bg: '#ef4444', color: '#ffffff', title: `API Mock — ${issues} issue${issues === 1 ? '' : 's'} on this tab` };
  }
  if (mocked > 0) {
    return {
      text: mocked > 99 ? '99+' : String(mocked),
      bg: '#10b981',
      color: '#06281c',
      title: `API Mock — Active · ${mocked} mocked on this tab`,
    };
  }
  return { text: '', bg: '#10b981', color: '#06281c', title: 'API Mock — Active' };
}

// ── Icon ───────────────────────────────────────────────────────────────────
// A rounded square with a ">" glyph, drawn at runtime (no PNG assets).
export function drawIcon(size, active) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const r = size * 0.22;

  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.arcTo(size, 0, size, r, r);
  ctx.lineTo(size, size - r);
  ctx.arcTo(size, size, size - r, size, r);
  ctx.lineTo(r, size);
  ctx.arcTo(0, size, 0, size - r, r);
  ctx.lineTo(0, r);
  ctx.arcTo(0, 0, r, 0, r);
  ctx.closePath();
  ctx.fillStyle = active ? '#f59e0b' : '#4b5563';
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(size * 0.3, size * 0.27);
  ctx.lineTo(size * 0.68, size * 0.5);
  ctx.lineTo(size * 0.3, size * 0.73);
  ctx.strokeStyle = active ? '#1c1917' : '#9ca3af';
  ctx.lineWidth = size * 0.115;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  return ctx.getImageData(0, 0, size, size);
}
