// Build route JSON files for YouTube test-route videos (CDI Cambridge so far), with the video's
// own sat-nav and examiner lines as the voice (route.script) and video sync (route.timeAnchors).
//
//   npm run video-routes -- [--only=n,n] [--save] [--pack=<file>]
//     without --save: resolve waypoints, route with OSRM, print a road-by-road summary
//     with --save:    also auto-detect attention points, apply the script, write app/data/routes/cdi-*.json
//     --pack=<file>:  write all cdi-* routes as one route pack (import it in the app)
//
// Adding a video (data/ is not in git: it holds other people's videos' words and your routes):
//   1. data/videos.json: { n, id, published, len (s), desc (the video description's road list) }
//   2. npm run video-text -- <id>   → .cache/transcripts/<id>.txt (captions, or Whisper if none)
//   3. data/scripts.data.mjs: clean the lines into SCRIPTS[id] (format at the top of that file);
//      SCRIPT_SOURCE[id] = 'whisper' when the text came from a transcription
//   4. data/routes.spec.mjs: waypoints along the roads the sat-nav names;
//      new road names → add them in osm-roads.mjs and run it (fills data/osm-cache.json)
//   5. run without --save until the road list matches the sat-nav, then --save and --pack
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const data = join(here, 'data');
const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean).map(Number);
const save = args.includes('--save');
const packFile = (args.find((a) => a.startsWith('--pack=')) || '').slice(7);
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { CENTRE, newRoute, summarize } = await imp('app/js/core/model.js');
const { fetchRoute } = await imp('app/js/core/osrm.js');
const { autoDetect, mergeAuto } = await imp('app/js/core/analyze.js');
const { cumulative, fmtDist, haversine, bearing, project } = await imp('app/js/core/geo.js');
const { buildInstructions } = await imp('app/js/core/instructions.js');
const { makePack } = await imp('app/js/core/exporters.js');
const { ROUTES } = await import(pathToFileURL(join(data, 'routes.spec.mjs')).href + `?t=${Date.now()}`);
const { SCRIPTS, SCRIPT_NOTES = {}, SCRIPT_SOURCE = {} } = await import(pathToFileURL(join(data, 'scripts.data.mjs')).href + `?t=${Date.now()}`);
const { applyScript } = await import(pathToFileURL(join(here, 'apply-script.mjs')).href);
const geo = await imp('app/js/core/geo.js');
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const ways = JSON.parse(readFileSync(join(data, 'osm-cache.json'), 'utf8'));
const videos = JSON.parse(readFileSync(join(data, 'videos.json'), 'utf8'));

const norm = (s) => String(s).toLowerCase().replace(/[’']/g, '');
const DIRS = { N: [315, 45], E: [45, 135], S: [135, 225], W: [225, 315] };
const inDir = (b, d) => { const [a, z] = DIRS[d]; return a > z ? b >= a || b < z : b >= a && b < z; };

/** Nearest point to `near` on the given ways (optionally only segments heading `dir`). */
function nearestOn(cands, near, dir) {
  let best = null;
  for (const w of cands) {
    for (let i = 0; i < w.g.length - 1; i++) {
      if (dir && !inDir(bearing(w.g[i], w.g[i + 1]), dir)) continue;
      const p = project([w.g[i], w.g[i + 1]], [0, haversine(w.g[i], w.g[i + 1])], near);
      if (p && (!best || p.dist < best.dist)) best = { dist: p.dist, point: p.point, way: w };
    }
  }
  return best;
}

function resolve(wp) {
  if (wp.at) return { p: wp.at, how: 'at' };
  if (wp.way) {
    const w = ways.find((x) => x.id === wp.way);
    if (!w) throw new Error(`way ${wp.way} not cached`);
    const cum = cumulative(w.g);
    const target = cum[cum.length - 1] * (wp.frac ?? 0.5);
    const i = Math.max(0, cum.findIndex((c) => c >= target) - 1);
    const t = (target - cum[i]) / Math.max(1e-9, cum[i + 1] - cum[i]);
    return { p: [w.g[i][0] + (w.g[i + 1][0] - w.g[i][0]) * t, w.g[i][1] + (w.g[i + 1][1] - w.g[i][1]) * t], how: `way ${w.id} ${w.name || w.ref}` };
  }
  const cands = ways.filter((w) => (wp.road ? norm(w.name) === norm(wp.road) : true) && (wp.ref ? w.ref.split(';').includes(wp.ref) : true) && (wp.hw ? wp.hw.test(w.hw) : true));
  if (!cands.length) throw new Error(`no ways for ${wp.road || wp.ref}`);
  const best = nearestOn(cands, wp.near, wp.dir);
  if (!best) throw new Error(`nothing near for ${wp.road || wp.ref}`);
  if (best.dist > (wp.maxDist ?? 400)) throw new Error(`${wp.road || wp.ref}: nearest is ${Math.round(best.dist)} m from hint`);
  return { p: best.point, how: `${best.way.name || best.way.ref} (w${best.way.id}, ${Math.round(best.dist)} m from hint)` };
}

const SKIP = new Set(['depart', 'arrive', 'new name', 'notification', 'exit roundabout', 'exit rotary']);
const routesDir = join(root, 'app', 'data', 'routes');

// --rescript: only re-apply SCRIPTS to the saved routes (after editing a script; no OSRM / OSM)
if (args.includes('--rescript')) {
  for (const v of videos) {
    if ((only.length && !only.includes(v.n)) || !SCRIPTS[v.id]) continue;
    const file = join(routesDir, `cdi-${v.id}.json`);
    const route = JSON.parse(readFileSync(file, 'utf8'));
    const out = applyScript(route, SCRIPTS[v.id], geo, (m) => console.log(m));
    writeFileSync(file, JSON.stringify(route));
    console.log(`${v.n} ${v.id}: script ${out.script.length} lines, ${out.script.filter((s) => s.wait).length} said while stopped, ${out.timeAnchors.length} time anchors`);
  }
}

for (const spec of args.includes('--rescript') ? [] : ROUTES) {
  if (only.length && !only.includes(spec.n)) continue;
  const v = videos.find((x) => x.n === spec.n);
  console.log(`\n=== ${spec.n} ${v.id} ${v.published} — ${v.desc}`);
  const waypoints = spec.wps.map((wp, k) => {
    const r = resolve(wp);
    return { id: `w${k + 1}`, lat: +r.p[0].toFixed(6), lng: +r.p[1].toFixed(6), label: wp.label, t: wp.t ?? null, how: r.how };
  });
  for (const w of waypoints) console.log(`  · ${w.label.padEnd(26)} ${w.lat},${w.lng}  t=${w.t ?? '-'}  ← ${w.how}`);
  let r;
  try { r = await fetchRoute(waypoints); } catch (e) { console.log('  OSRM failed:', e.message); continue; }
  console.log(`  route ${fmtDist(r.distance)} · ${Math.round(r.duration / 60)} min · ${r.steps.length} steps · video ${Math.round(v.len / 60)} min`);
  for (const w of r.warnings) console.log(`  ⚠ ${w.msg} @${Math.round(w.at)}`);
  const names = [];
  for (const s of r.steps) {
    if (SKIP.has(s.type) && s.type !== 'exit roundabout') continue;
    const label = `${s.type === 'roundabout' || s.type === 'rotary' ? `RB${s.exit}` : s.type === 'turn' ? s.mod : s.type}→${s.name || s.ref || '·'}`;
    names.push(`${Math.round(s.at)}:${label}`);
  }
  console.log('  ' + names.join(' | '));
  if (!save) continue;

  const route = newRoute(spec.name);
  route.id = `cdi-${v.id}`;
  route.notes = spec.notes;
  route.video = { youtubeId: v.id, url: `https://www.youtube.com/watch?v=${v.id}`, title: `CDI Cambridge · ${v.published}`, start: null };
  route.source = { kind: 'youtube', channel: 'Cambridge Driving Instructors (CDI Cambridge)', published: v.published, description: v.desc, method: 'reconstructed from the video description, route diagram and preview frames' };
  route.waypoints = waypoints.map(({ how, ...w }) => w);
  route.route = r;
  const res = await autoDetect(route);
  if (res.osmError) console.log('  OSM error:', res.osmError);
  if (res.sideRoads) route.route.sideRoads = res.sideRoads;
  route.annotations = mergeAuto(route, res.annotations).annotations;
  const lines = SCRIPTS[v.id];
  if (lines) {
    // the transcript gives far better timing than preview frames: drop the frame-based guesses
    for (const w of route.waypoints) w.t = null;
    const out = applyScript(route, lines, geo, (m) => console.log(m));
    const whisper = SCRIPT_SOURCE[v.id] === 'whisper';
    route.source.method = whisper
      ? 'route checked against the sat-nav directions in the video (speech recognition of the audio); timing from the transcript'
      : 'route checked against the sat-nav directions in the video captions; timing from the captions';
    if (SCRIPT_NOTES[v.id]) route.notes += `\n${SCRIPT_NOTES[v.id]}`;
    route.notes = route.notes.replace(/^根据 CDI Cambridge 视频的简介、片头路线图和预览帧重建：[^\n]*/m, whisper
      ? '这个视频没有字幕：导航和考官的话是用语音识别从视频音频转写的。路线按导航说的路名核对过；视频时间来自转写，误差一般在 10 秒以内。语音播报用的就是视频里导航和考官的原话。'
      : '路线按视频里导航的语音（YouTube 字幕）核对过；视频时间来自字幕，误差一般在 10 秒以内。语音播报用的就是视频里导航和考官的原话。');
    console.log(`  script ${out.script.length} lines · ${out.anchors.length} anchors · ${out.stops.length} stops · time anchors ${out.timeAnchors.length}`);
    console.log('  anchors: ' + out.anchors.map((a) => `${fmtT(a.t)}@${Math.round(a.at)}`).join(' '));
  } else {
    // no voice text yet: run `npm run video-text -- <id>` (it transcribes when there are no captions)
    console.log(`  ⚠ no script for ${v.id}: the app would fall back to generated directions`);
    route.notes += '\n还没有视频原话：视频时间是根据预览画面估的，可能差一两分钟。';
  }
  const rbs = route.annotations.filter((a) => a.type === 'roundabout').map((a) => `${a.rb.kind === 'mini' ? 'mini' : 'RB'}@${a.at} exit ${a.rb.exit}${a.rb.uncertain ? '?' : ''} (${a.rb.fromRoad || '?'}→${a.rb.toRoad || '?'})`);
  console.log(`  annotations ${route.annotations.length}; roundabouts: ${rbs.join(', ')}`);
  console.log('  examiner: ' + buildInstructions(route).filter((s) => s.kind === 'dir').slice(0, 40).map((s) => s.en.replace(/, please\.|\.$/g, '')).join(' / '));
  writeFileSync(join(routesDir, `${route.id}.json`), JSON.stringify(route));
  console.log(`  saved ${route.id}.json`);
  await new Promise((res2) => setTimeout(res2, 1500)); // be gentle with Overpass / OSRM
}

if (save) {
  const summaries = readdirSync(routesDir).filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => summarize(JSON.parse(readFileSync(join(routesDir, f), 'utf8'))));
  writeFileSync(join(routesDir, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), routes: summaries }, null, 1));
  console.log('\nindex.json:', summaries.length, 'routes');
}

if (packFile) {
  // the app lists the last imported route first, so the pack runs from the last video to the first
  const routes = [...videos].sort((a, b) => b.n - a.n)
    .map((v) => { try { return JSON.parse(readFileSync(join(routesDir, `cdi-${v.id}.json`), 'utf8')); } catch { return null; } })
    .filter(Boolean);
  writeFileSync(packFile, JSON.stringify(makePack(routes)));
  console.log(`\npack: ${routes.length} routes → ${packFile} (${routes.filter((r) => r.script?.length).length} with the video's own lines)`);
}
