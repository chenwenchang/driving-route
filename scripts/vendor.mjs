// Copy third-party browser libraries from node_modules into app/vendor so the
// app runs without a build step and works offline / inside an APK.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'leaflet', 'dist');
const dst = join(root, 'app', 'vendor', 'leaflet');

if (!existsSync(src)) {
  console.error('leaflet not installed — run `npm install` first');
  process.exit(1);
}
mkdirSync(dst, { recursive: true });
for (const f of ['leaflet.js', 'leaflet.css']) cpSync(join(src, f), join(dst, f));
cpSync(join(src, 'images'), join(dst, 'images'), { recursive: true });
console.log('vendored leaflet ->', dst);
