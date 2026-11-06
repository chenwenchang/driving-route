// Inline SVG glyphs (24×24, currentColor) for annotation types + UI icons.
import { TYPES } from '../core/model.js';

const S = (inner, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${inner}</svg>`;

export const GLYPH = {
  speed: S('<circle cx="12" cy="12" r="8"/><path d="M12 12l4-3"/>'),
  roundabout: S('<path d="M12 4.5a7.5 7.5 0 1 1-6.9 4.6"/><path d="M4.2 4.6l.9 4.5 4.4-1.1"/>'),
  cycle: S('<circle cx="6" cy="16" r="3.6"/><circle cx="18" cy="16" r="3.6"/><path d="M6 16l4.5-7h5L18 16M10.5 9L12 16h2M14 6h2.5"/>'),
  box: S('<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 4l16 16M20 4L4 20M12 4l8 8M4 12l8 8M12 20l8-8M4 12l8-8"/>', 'stroke-width="1.6"'),
  lane: S('<path d="M7 21V9l-3 3M7 9l3 3M17 21V5M14 8l3-3 3 3"/>'),
  crossing: S('<path d="M5 4v16M9.7 4v16M14.3 4v16M19 4v16"/>', 'stroke-width="2.6"'),
  junction: S('<path d="M12 21V11M4 11h16"/><circle cx="12" cy="5" r="1.6" fill="currentColor"/>'),
  bus: S('<rect x="5" y="3.5" width="14" height="15" rx="2.5"/><path d="M5 11h14M8 18.5v2M16 18.5v2"/><circle cx="8.5" cy="15" r=".9" fill="currentColor"/><circle cx="15.5" cy="15" r=".9" fill="currentColor"/>'),
  hazard: S('<path d="M12 3.5l9 16H3z"/><path d="M12 10v4.2"/><circle cx="12" cy="17" r=".9" fill="currentColor"/>'),
  note: S('<path d="M6 3.5h9l3 3v14H6z"/><path d="M9 11h6M9 15h6"/>'),
  signals: S('<rect x="8" y="2.5" width="8" height="19" rx="3"/><circle cx="12" cy="7" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="17" r="1.5" fill="currentColor"/>'),
  stop: S('<path d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z"/><path d="M8 12h8" stroke-width="3"/>'),
  calming: S('<path d="M2.5 18h19"/><path d="M5.5 18c1.8-6 11.2-6 13 0"/>'),
  school: S('<circle cx="8.5" cy="6" r="2"/><circle cx="15.5" cy="7.5" r="1.7"/><path d="M8.5 9v6l-2 5M8.5 15l2 5M15.5 10v5l-1.5 4.5M15.5 15l1.5 4.5M6 11.5l5-1"/>'),
  narrow: S('<path d="M8 20V5M5 8l3-3 3 3M16 4v15M13 16l3 3 3-3"/>'),
  merge: S('<path d="M7 21v-6c0-3 5-4 5-8V3M17 21v-6c0-3-5-4-5-8"/><path d="M9 6l3-3 3 3"/>'),
  rail: S('<path d="M5 5l14 14M19 5L5 19"/><path d="M3 9h3M18 15h3"/>'),
  manoeuvre: `<svg viewBox="0 0 24 24"><text x="12" y="17.5" text-anchor="middle" font-size="17" font-weight="800" fill="currentColor" font-family="system-ui, sans-serif">P</text></svg>`,
  mistake: S('<path d="M6 6l12 12M18 6L6 18"/>', 'stroke-width="3"'),
};

export const UI = {
  back: S('<path d="M15 5l-7 7 7 7"/>'),
  close: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  play: S('<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>'),
  pause: S('<path d="M8 4.5v15M16 4.5v15" stroke-width="3.2"/>'),
  prev: S('<path d="M15 5l-7 7 7 7"/>'),
  next: S('<path d="M9 5l7 7-7 7"/>'),
  eye: S('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  street: S('<circle cx="12" cy="5" r="2.2"/><path d="M12 8v6M9 21l3-7 3 7M8.5 11h7"/>'),
  video: S('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor"/>'),
  nav: S('<path d="M3.5 11L21 3l-8 17.5-2-7.5z"/>'),
  download: S('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  upload: S('<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>'),
  gear: S('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
  map: S('<path d="M9 4L3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>'),
  layers: S('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
  target: S('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  fit: S('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  install: S('<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M12 7v7M9 11l3 3 3-3"/>'),
  edit: S('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  trash: S('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  camera: S('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  check: S('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  car: S('<path d="M5 14l1.5-5h11L19 14v4H5z" fill="currentColor"/>'),
  list: S('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1" fill="currentColor"/><circle cx="3.5" cy="12" r="1" fill="currentColor"/><circle cx="3.5" cy="18" r="1" fill="currentColor"/>'),
  book: S('<path d="M4 4.5h6a2 2 0 0 1 2 2V20a2 2 0 0 0-2-2H4zM20 4.5h-6a2 2 0 0 0-2 2V20a2 2 0 0 1 2-2h6z"/>'),
};

export const glyph = (type) => GLYPH[type] || GLYPH.note;
export const typeColor = (type) => (TYPES[type] || TYPES.note).color;

/** HTML for an annotation marker (map + lists). */
export function markerHtml(a, { selected = false } = {}) {
  const lvl = a.level || 1;
  const cls = ['mk', `l${lvl}`];
  if (a.auto && !a.confirmed) cls.push('unconfirmed');
  if (selected) cls.push('sel');
  const c = typeColor(a.type);
  if (a.type === 'speed' && a.speed) return `<div class="${cls.join(' ')} mk-speed">${a.speed}</div>`;
  if (a.type === 'roundabout') {
    cls.push('mk-rb');
    const no = a.rb?.exit ? `<span class="no">${a.rb.exit}</span>` : '';
    return `<div class="mk-wrap"><div class="${cls.join(' ')}">${glyph('roundabout')}</div>${no}</div>`;
  }
  if (a.type === 'box') cls.push('mk-box');
  if (a.type === 'stop') cls.push('mk-stop');
  if (a.type === 'mistake') cls.push('mk-mistake');
  return `<div class="${cls.join(' ')}" style="--c:${c}">${glyph(a.type)}</div>`;
}

export function markerSize(a) {
  const lvl = a.level || 1;
  return lvl === 1 && a.type !== 'roundabout' ? 22 : 30;
}
