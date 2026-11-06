// Storage: local server (files on disk) when available, otherwise IndexedDB in
// this browser. Static deployments read data/routes/*.json read-only.
import { normalizeRoute, nowIso, summarize } from './core/model.js';
import { makePack, parsePack } from './core/exporters.js';
import { blobToDataURL } from './ui/util.js';

const DB_NAME = 'driving-route';
let dbPromise;

function db() {
  dbPromise ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('routes')) r.result.createObjectStore('routes', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbPromise;
}

async function idb(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('routes', mode);
    const req = fn(t.objectStore('routes'));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

const newer = (a, b) => (String(a.updatedAt || '') >= String(b.updatedAt || '') ? a : b);

export class Store {
  constructor() {
    this.mode = 'static'; // 'server' | 'static'
    this.writable = false; // can write files on the server
  }

  async init() {
    try {
      const r = await fetch('api/ping', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        if (j.ok) { this.mode = 'server'; this.writable = !!j.writable; }
      }
    } catch { /* static hosting / offline */ }
    return this;
  }

  get where() { return this.writable ? '本机文件（app/data）' : '此浏览器（IndexedDB）'; }

  async fileIndex() {
    try {
      const url = this.mode === 'server' ? 'api/routes' : 'data/routes/index.json';
      const r = await fetch(url, { cache: 'no-cache' });
      if (r.ok) return (await r.json()).routes || [];
    } catch { /* none */ }
    return [];
  }

  async list() {
    const out = new Map();
    for (const s of await this.fileIndex()) out.set(s.id, { ...s, origin: 'file' });
    let locals = [];
    try { locals = await idb('readonly', (s) => s.getAll()); } catch { /* IndexedDB unavailable */ }
    for (const r of locals || []) {
      const s = { ...summarize(r), origin: 'local' };
      const f = out.get(s.id);
      out.set(s.id, f ? { ...newer(s, f), origin: newer(s, f) === s ? 'local' : 'file' } : s);
    }
    return [...out.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  async get(id) {
    let local = null, file = null;
    try { local = await idb('readonly', (s) => s.get(id)); } catch { /* none */ }
    try {
      const url = this.mode === 'server' ? `api/routes/${encodeURIComponent(id)}` : `data/routes/${encodeURIComponent(id)}.json`;
      const r = await fetch(url, { cache: 'no-cache' });
      if (r.ok) file = await r.json();
    } catch { /* offline */ }
    const doc = local && file ? newer(local, file) : local || file;
    if (!doc) throw new Error('找不到这条路线');
    return normalizeRoute(doc);
  }

  async save(route) {
    route.updatedAt = nowIso();
    if (this.writable) {
      const r = await fetch(`api/routes/${encodeURIComponent(route.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(route),
      });
      if (!r.ok) throw new Error(`保存失败（HTTP ${r.status}）`);
      // a stale local copy would shadow the file — drop it
      try { await idb('readwrite', (s) => s.delete(route.id)); } catch { /* none */ }
      return 'file';
    }
    await idb('readwrite', (s) => s.put(JSON.parse(JSON.stringify(route))));
    return 'local';
  }

  async remove(id) {
    if (this.writable) await fetch(`api/routes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    try { await idb('readwrite', (s) => s.delete(id)); } catch { /* none */ }
  }

  /** Store a screenshot; returns the value to put in annotation.image */
  async saveImage(routeId, blob, name) {
    if (this.writable) {
      const r = await fetch(`api/media/${encodeURIComponent(routeId)}/${encodeURIComponent(name)}`, { method: 'PUT', body: blob });
      if (!r.ok) throw new Error(`图片保存失败（HTTP ${r.status}）`);
      return (await r.json()).path;
    }
    return blobToDataURL(blob);
  }

  /** Self-contained pack (images inlined) for backup / transfer to the phone. */
  async exportPack(ids) {
    const routes = [];
    for (const id of ids) {
      const r = JSON.parse(JSON.stringify(await this.get(id)));
      for (const a of r.annotations) {
        if (a.image && !a.image.startsWith('data:')) {
          try { a.image = await blobToDataURL(await (await fetch(a.image)).blob()); } catch { /* keep path */ }
        }
      }
      routes.push(r);
    }
    return makePack(routes);
  }

  async importPack(obj) {
    const routes = parsePack(obj).map(normalizeRoute);
    for (const r of routes) {
      if (this.writable) {
        for (const a of r.annotations) {
          if (a.image?.startsWith('data:')) {
            const blob = await (await fetch(a.image)).blob();
            a.image = await this.saveImage(r.id, blob, `${a.id}.jpg`);
          }
        }
      }
      await this.save(r);
    }
    return routes;
  }
}
