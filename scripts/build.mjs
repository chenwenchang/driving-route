// Build the deployable static site (PWA) into dist/.
//
//   node scripts/build.mjs             → app code + the route data that git tracks
//                                        (by default only the demo route; your own routes
//                                        and screenshots stay on this PC — see .gitignore)
//   node scripts/build.mjs --all-data  → also include every local route + screenshot
//                                        (only for a private host!)
//
// Each build stamps the service worker with a content hash, so phones pick up
// the new version and drop stale caches.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from '../app/js/core/model.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'app');
const dist = join(root, 'dist');
const allData = process.argv.includes('--all-data');

/** Files under app/data that git tracks (null if this is not a git checkout). */
function trackedData() {
  try {
    const out = execFileSync('git', ['ls-files', '-z', 'app/data'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new Set(out.split('\0').filter(Boolean).map((p) => join(root, p)));
  } catch { return null; }
}

const tracked = allData ? null : trackedData();
const dataDir = join(app, 'data');
const keepData = (abs) => {
  if (abs.includes(`${sep}trash`)) return false;
  if (allData) return true;
  if (tracked?.size) return tracked.has(abs);
  return abs.endsWith(`${sep}demo-loop.json`); // not a git checkout (or nothing committed yet): demo only
};

rmSync(dist, { recursive: true, force: true });
cpSync(app, dist, {
  recursive: true,
  filter: (src) => {
    if (!src.startsWith(dataDir)) return true;
    if (src === dataDir) return true;
    return statSync(src).isDirectory() ? true : keepData(src);
  },
});

// regenerate the route index for exactly the routes that were published
const routesDir = join(dist, 'data', 'routes');
mkdirSync(routesDir, { recursive: true });
const published = readdirSync(routesDir).filter((f) => f.endsWith('.json') && f !== 'index.json');
const summaries = [];
let strippedImages = 0;
for (const f of published) {
  const file = join(routesDir, f);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  // drop references to screenshots that were not published (avoids broken images)
  for (const a of doc.annotations || []) {
    if (a.image && !a.image.startsWith('data:') && !existsSync(join(dist, a.image))) { delete a.image; strippedImages++; }
  }
  writeFileSync(file, JSON.stringify(doc));
  summaries.push(summarize(doc));
}
summaries.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
writeFileSync(join(routesDir, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), routes: summaries }));

// content hash → service worker version
const hash = createHash('sha1');
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (!p.endsWith(`${sep}sw.js`)) hash.update(relative(dist, p)).update(readFileSync(p));
  }
})(dist);
const version = hash.digest('hex').slice(0, 10);
const swPath = join(dist, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
const stamped = sw.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
if (stamped === sw) throw new Error('sw.js: VERSION constant not found');
writeFileSync(swPath, stamped);

writeFileSync(join(dist, '.nojekyll'), ''); // GitHub Pages: serve files as-is

console.log(`built dist/  ·  version ${version}  ·  ${published.length} route(s): ${published.map((f) => f.replace('.json', '')).join(', ') || '—'}`);
if (strippedImages) console.log(`  (${strippedImages} screenshot reference(s) removed — screenshots were not published)`);
if (allData) console.log('  ⚠ --all-data: every local route and screenshot is included — only deploy this to a private host');
