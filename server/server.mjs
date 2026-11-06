// Tiny zero-dependency server: serves app/ and persists routes + screenshots
// into app/data so they live on disk (and can be versioned / deployed).
//
//   node server/server.mjs            → http://localhost:5173 (this PC only)
//   node server/server.mjs --lan      → also reachable from your phone on the same Wi-Fi
//                                        (phone gets read-only access; editing stays on this PC)
//   --port 8080                       → choose a port
//   --dir dist --static               → serve another folder as a plain static site (no API),
//                                        e.g. to preview the deployable build
import http from 'node:http';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from '../app/js/core/model.js';

const args = process.argv.slice(2);
const LAN = args.includes('--lan');
const PORT = Number(args[args.indexOf('--port') + 1]) || Number(process.env.PORT) || 5173;
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const STATIC_ONLY = args.includes('--static');
const DIR_ARG = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null;

const ROOT = DIR_ARG ? resolve(DIR_ARG) : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const DATA = join(ROOT, 'data');
const ROUTES = join(DATA, 'routes');
const MEDIA = join(DATA, 'media');
const TRASH = join(DATA, 'trash');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.gpx': 'application/gpx+xml', '.kml': 'application/vnd.google-earth.kml+xml', '.txt': 'text/plain; charset=utf-8',
};

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const FILE_RE = /^[A-Za-z0-9_.-]{1,120}\.(jpe?g|png|webp)$/i;
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('payload too large'), { code: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function buildIndex() {
  await mkdir(ROUTES, { recursive: true });
  const files = (await readdir(ROUTES)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  const routes = [];
  for (const f of files) {
    try { routes.push(summarize(JSON.parse(await readFile(join(ROUTES, f), 'utf8')))); } catch (e) { console.warn('skip', f, e.message); }
  }
  routes.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const index = { generatedAt: new Date().toISOString(), routes };
  await writeFile(join(ROUTES, 'index.json'), JSON.stringify(index, null, 1));
  return index;
}

/** Reject cross-site writes (a page on another site trying to call this API). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && Number(u.port || 80) === PORT;
  } catch { return false; }
}

async function api(req, res, parts) {
  const method = req.method;
  const write = method !== 'GET' && method !== 'HEAD';
  if (write && (!isLoopback(req) || !sameOrigin(req))) return send(res, 403, { error: '只能在本机编辑（手机端只读）' });

  if (parts[0] === 'ping') return send(res, 200, { ok: true, mode: 'server', lan: LAN, writable: isLoopback(req) });

  if (parts[0] === 'routes') {
    const id = parts[1];
    if (!id) return send(res, 200, await buildIndex());
    if (!ID_RE.test(id)) return send(res, 400, { error: 'bad id' });
    const file = join(ROUTES, `${id}.json`);
    if (method === 'GET') {
      try { return send(res, 200, await readFile(file)); } catch { return send(res, 404, { error: 'not found' }); }
    }
    if (method === 'PUT') {
      const buf = await readBody(req, 50 * 1024 * 1024);
      let doc;
      try { doc = JSON.parse(buf.toString('utf8')); } catch { return send(res, 400, { error: 'invalid JSON' }); }
      if (doc.id !== id) return send(res, 400, { error: 'id mismatch' });
      await mkdir(ROUTES, { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(doc));
      await rename(tmp, file);
      await buildIndex();
      return send(res, 200, { ok: true, updatedAt: doc.updatedAt });
    }
    if (method === 'DELETE') {
      await mkdir(TRASH, { recursive: true });
      try { await rename(file, join(TRASH, `${id}-${Date.now()}.json`)); } catch { return send(res, 404, { error: 'not found' }); }
      await buildIndex();
      return send(res, 200, { ok: true, trashed: true });
    }
  }

  if (parts[0] === 'media' && method === 'PUT') {
    const [, rid, name] = parts;
    if (!ID_RE.test(rid || '') || !FILE_RE.test(name || '')) return send(res, 400, { error: 'bad path' });
    const buf = await readBody(req, 15 * 1024 * 1024);
    const dir = join(MEDIA, rid);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), buf);
    return send(res, 200, { ok: true, path: `data/media/${rid}/${name}` });
  }

  return send(res, 404, { error: 'unknown api' });
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(ROOT, rel));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return send(res, 403, 'forbidden', 'text/plain');
  let st;
  try { st = await stat(file); } catch { return send(res, 404, 'not found', 'text/plain'); }
  if (st.isDirectory()) return serveStatic(req, res, pathname.replace(/\/?$/, '/'));
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (STATIC_ONLY) return send(res, 404, { error: 'static mode' });
      return await api(req, res, url.pathname.slice(5).split('/').filter(Boolean));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.code === 413 ? 413 : 500, { error: e.message });
  }
});

server.listen(PORT, HOST, async () => {
  if (STATIC_ONLY) {
    console.log(`\n  静态预览（无保存接口）  →  http://localhost:${PORT}/   目录：${ROOT}\n`);
    return;
  }
  await buildIndex().catch(() => {});
  console.log(`\n  剑桥路考路线助手  →  http://localhost:${PORT}/`);
  console.log(`  路线编辑器        →  http://localhost:${PORT}/editor.html`);
  if (LAN) {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    for (const ip of ips) console.log(`  手机（同一 Wi-Fi） →  http://${ip}:${PORT}/   （只读）`);
  }
  console.log('');
});
