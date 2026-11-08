// Add the roads named in the video transcripts to data/osm-cache.json (merging by way id), so
// routes.spec.mjs can place waypoints by road name. Add new names to the list and run:
//   node scripts/video/osm-roads.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), 'data');
const names = [
  'Ardglen Road', 'Coles Road', 'Chariot Way', 'Perse Way', 'Perne Road', 'Tavistock Road', 'Warwick Road', 'Carisbrooke Road',
  'Humphries Way', 'Alex Wood Road', 'Mansel Way', 'Ferrars Way', 'Carlton Way', 'Circus Drive', 'High Street', 'Cambridge Road',
  'Gilbert Road', 'Kings Hedges Road', 'Milton Road', 'Arbury Road', 'St Albans Road', 'Roseford Road', 'Histon Road',
  'Lawrence Weaver Road', 'Graham Road', 'Chieftain Way', 'Ring Fort Road', 'Topper Street', 'Neal Drive', 'Akeman Street',
  'Campkin Road', 'Northfield Avenue', 'Kirkwood Road', 'Nuffield Road', 'Green End Road', 'Ditton Lane', 'Thorpe Way',
  'High Ditch Road', 'Horningsea Road', 'Newmarket Road', 'Butt Lane', 'New Road', 'Bridge Road', 'Lovell Road',
  "St Catharine's Road", "St Catharine's Square", 'Howgate Road', 'St Kilda Avenue', 'Fen Road', 'The Sycamores',
];
const re = names.map((n) => n.replace(/'/g, "'?")).join('|');
const q = `[out:json][timeout:180];
(
  way["highway"]["name"~"^(${re})$",i](52.20,0.09,52.26,0.22);
  way["highway"~"^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary)$"](52.20,0.09,52.26,0.22);
);
out tags geom;`;
const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'driving-route/0.1 (personal study tool)' },
  body: 'data=' + encodeURIComponent(q),
});
if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
const j = await res.json();
const file = join(here, 'osm-cache.json');
const old = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(old.map((w) => [w.id, w]));
let added = 0;
for (const e of j.elements) {
  if (e.type !== 'way' || byId.has(e.id)) continue;
  byId.set(e.id, { id: e.id, name: e.tags.name || '', ref: e.tags.ref || '', hw: e.tags.highway, oneway: e.tags.oneway || '', junction: e.tags.junction || '', g: e.geometry.map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)]) });
  added++;
}
writeFileSync(file, JSON.stringify([...byId.values()]));
console.log('added', added, 'total', byId.size);
const ways = [...byId.values()];
for (const n of ['Ardglen Road', 'Coles Road', 'Chariot Way', 'Perse Way', 'Tavistock Road', 'Warwick Road', 'Carisbrooke Road', 'Humphries Way', 'Alex Wood Road', 'Circus Drive', 'Lawrence Weaver Road', 'Graham Road', 'Akeman Street']) {
  const ws = ways.filter((w) => w.name.toLowerCase() === n.toLowerCase());
  if (!ws.length) { console.log(n.padEnd(22), '—'); continue; }
  const pts = ws.flatMap((w) => w.g);
  const lat = pts.map((p) => p[0]), lng = pts.map((p) => p[1]);
  console.log(n.padEnd(22), ws.length, 'lat', Math.min(...lat).toFixed(4) + '..' + Math.max(...lat).toFixed(4), 'lng', Math.min(...lng).toFixed(4) + '..' + Math.max(...lng).toFixed(4), '|', ws.slice(0, 5).map((w) => w.g[0].map((v) => v.toFixed(4)) + '>' + w.g[w.g.length - 1].map((v) => v.toFixed(4)) + (w.oneway ? '(ow)' : '')).join(' '));
}
