// Build the demo route (NOT a real test route — just a loop near the test centre
// that exercises roundabouts, speed-limit changes, cycle lanes, etc.).
// Usage: node scripts/make-demo.mjs   → writes app/data/routes/demo-loop.json + index.json
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CENTRE, newRoute, summarize } from '../app/js/core/model.js';
import { fetchRoute } from '../app/js/core/osrm.js';
import { autoDetect, mergeAuto } from '../app/js/core/analyze.js';
import { fmtDist } from '../app/js/core/geo.js';
import { roundaboutAdvice } from '../app/js/core/roundabout.js';
import { readdirSync, readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routesDir = join(root, 'app', 'data', 'routes');

const wps = [
  [CENTRE.lat, CENTRE.lng, '考场'],
  [52.23461, 0.13270, 'Kings Hedges Rd 向西'],
  [52.22097, 0.11199, 'Histon Rd 向南'],
  [52.21891, 0.12260, 'Gilbert Rd 向东'],
  [52.21533, 0.12558, 'Milton Rd 向南'],
  [52.21294, 0.13633, 'Elizabeth Way'],
  [52.22468, 0.14061, 'Milton Rd 向北'],
  [52.22916, 0.14294, 'Kings Hedges Rd 向西'],
  [CENTRE.lat, CENTRE.lng, '回到考场'],
];

const route = newRoute('示例环线（演示用，非真实考试路线）');
route.id = 'demo-loop';
route.demo = true;
route.notes = '这条路线是为了演示功能自动生成的：沿途注意点全部来自 OpenStreetMap 自动识别，未经视频核对。请用"编辑器"从 mock test 视频录入真实路线。';
route.waypoints = wps.map(([lat, lng, label], i) => ({ id: `w${i + 1}`, lat, lng, label, t: null }));

route.route = await fetchRoute(route.waypoints);
console.log('route', fmtDist(route.route.distance), Math.round(route.route.duration / 60), 'min,', route.route.geometry.length, 'pts,', route.route.steps.length, 'steps');
for (const w of route.route.warnings) console.log('  ⚠', w.msg, w.at);

const res = await autoDetect(route);
if (res.osmError) console.log('OSM error:', res.osmError);
if (res.sideRoads) {
  route.route.sideRoads = res.sideRoads;
  console.log('side roads:', res.sideRoads.length, '(', res.sideRoads.filter((s) => s.ok).length, 'ok )');
}
const merged = mergeAuto(route, res.annotations);
route.annotations = merged.annotations;
console.log('annotations:', route.annotations.length, 'added', merged.added);
const byType = {};
for (const a of route.annotations) byType[a.type] = (byType[a.type] || 0) + 1;
console.log(byType);
for (const a of route.annotations.filter((x) => ['roundabout', 'speed', 'cycle', 'lane', 'bus', 'rail', 'stop'].includes(x.type))) {
  let extra = '';
  if (a.rb) { const adv = roundaboutAdvice(a.rb); extra = `${adv.head} | ${a.rb.kind} counted=${a.rb.counted} turn=${a.rb.turn} arms=${a.rb.arms.map((x) => `${x.s}${x.no ? '#' + x.no : ''}${x.noEntry ? 'x' : ''}${x.isExit ? '*' : ''}`).join(' ')} lanes=${a.rb.lanes ? a.rb.lanes.length : 0} sig=${a.rb.signalised} ${a.rb.method}${a.rb.radius ? ' r=' + a.rb.radius : ''} ${a.rb.fromRoad}→${a.rb.toRoad}`; }
  console.log(`  ${String(a.at).padStart(6)}m ${a.type.padEnd(10)} L${a.level} ${a.title || ''} ${a.speed ? a.speed + 'mph' : ''} ${extra}`);
}

mkdirSync(routesDir, { recursive: true });
writeFileSync(join(routesDir, `${route.id}.json`), JSON.stringify(route));
// rebuild index
const summaries = readdirSync(routesDir).filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => summarize(JSON.parse(readFileSync(join(routesDir, f), 'utf8'))));
writeFileSync(join(routesDir, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), routes: summaries }, null, 1));
console.log('wrote', join(routesDir, `${route.id}.json`));
