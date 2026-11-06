// Small DOM helpers shared by the viewer and the editor.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

let toastBox;
export function toast(msg, kind = '', ms = 2600) {
  if (!toastBox) { toastBox = document.createElement('div'); toastBox.className = 'toasts'; document.body.append(toastBox); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  toastBox.append(el);
  setTimeout(() => el.remove(), ms);
}

export function download(filename, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function debounce(fn, ms) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.flush = (...args) => { clearTimeout(t); fn(...args); };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** localStorage-backed settings (never throws). */
export const settings = {
  get(key, dflt) {
    try { const v = localStorage.getItem(`dr.${key}`); return v == null ? dflt : JSON.parse(v); } catch { return dflt; }
  },
  set(key, val) {
    try { localStorage.setItem(`dr.${key}`, JSON.stringify(val)); } catch { /* storage unavailable */ }
  },
};

export function lightbox(src) {
  const el = h(`<div class="lightbox" role="dialog" aria-label="大图"><img alt="" src="${esc(src)}"></div>`);
  el.addEventListener('click', () => el.remove());
  document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { el.remove(); document.removeEventListener('keydown', onKey); } });
  document.body.append(el);
}

export function blobToDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}

/** Downscale an image blob/canvas to JPEG (max width) for compact storage. */
export async function toJpeg(src, maxW = 1280, quality = 0.78) {
  let bmp = src;
  if (src instanceof Blob) bmp = await createImageBitmap(src);
  const w0 = bmp.width || bmp.videoWidth, h0 = bmp.height || bmp.videoHeight;
  const scale = Math.min(1, maxW / w0);
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * scale);
  c.height = Math.round(h0 * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
}

export const isTyping = (e) => {
  const t = e.target;
  return t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
};
