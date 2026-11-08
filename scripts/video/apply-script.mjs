// Pin a video transcript (data/scripts.data.mjs) onto a built route:
//  - resolve each anchored line to a manoeuvre on the route → (video time, distance) pairs
//  - map every line's time to a position, treating STOP entries as time spent standing still
//  - produce route.timeAnchors (video sync) and route.script (what to say, where)
//
// SCRIPTS[videoId] is a list of lines, cleaned up by hand from the captions or transcript
// (music, chatter and the instructor's commentary removed, misheard road names fixed):
//   [m:ss, 'S' | 'E', text, anchor?]   S = the sat-nav, E = the examiner
//   [m:ss, 'GO']                       the car moves off from the test centre
//   [m:ss, 'STOP', seconds]            the car stands still (pull-up, parking exercise)
// anchor = the manoeuvre the line refers to, which pins the video time to the map:
//   'Road Name' next turn onto that road   'RB' next roundabout (incl. mini)   'A10' a road ref
//   'OFF' / 'IN' next slip road off / on    'FORK'   'L' / 'R' next left / right turn   'END'
//   '|300y' / '|1.2mi' = said that far before it ("After 300 yards, …");
//   '|+6' = the car reaches it that many seconds after the line (default +4 for the sat-nav's
//   final prompt, +10 for a slip road, 0 for "After …" prompts)
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const YARD = 0.9144, MILE = 1609.344;
const tsec = (s) => { const [m, x] = s.split(':').map(Number); return m * 60 + x; };
const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim();

export async function loadGeo(root) {
  return import(pathToFileURL(join(root, 'app/js/core/geo.js')).href);
}

function events(route) {
  const r = route.route;
  const total = r.steps.length ? Math.max(...r.steps.map((s) => s.at)) : 0;
  const ev = [];
  for (const s of r.steps) {
    if (['depart', 'arrive', 'notification', 'exit roundabout', 'exit rotary'].includes(s.type)) continue;
    ev.push({ kind: 'step', at: s.at, type: s.type, mod: s.mod || '', name: s.name || '', ref: s.ref || '' });
  }
  for (const a of route.annotations || []) {
    if (a.type === 'roundabout' && a.rb) ev.push({ kind: 'rb', at: a.rb.fromAt ?? a.at });
  }
  ev.sort((a, b) => a.at - b.at);
  return { ev, total };
}

function matches(e, sel) {
  if (sel === 'RB') return e.kind === 'rb';
  if (e.kind !== 'step') return false;
  if (sel === 'OFF') return e.type === 'off ramp';
  if (sel === 'IN') return e.type === 'on ramp';
  if (sel === 'FORK') return e.type === 'fork';
  if (sel === 'L' || sel === 'R') {
    return ['turn', 'end of road', 'continue', 'new name', 'fork'].includes(e.type) && e.mod.includes(sel === 'L' ? 'left' : 'right');
  }
  const n = norm(sel);
  return norm(e.name) === n || e.ref.split(';').map(norm).includes(n);
}

/** Parse 'Name|300y' / 'RB|1.2mi' / 'R|+4' into {sel, back (m), dt (s)}. */
function parseAnchor(spec, who) {
  const [sel, ...mods] = spec.split('|');
  let back = 0, dt = null;
  for (const m of mods) {
    let x;
    if ((x = m.match(/^([\d.]+)y$/))) back = +x[1] * YARD;
    else if ((x = m.match(/^([\d.]+)mi$/))) back = +x[1] * MILE;
    else if ((x = m.match(/^\+(\d+)$/))) dt = +x[1];
  }
  // the sat-nav's final prompt comes ~4 s before a town junction, ~10 s before a slip road at speed
  if (dt == null) dt = back ? 0 : sel === 'OFF' ? 10 : who === 'S' ? 4 : 5;
  return { sel, back, dt };
}

export function applyScript(route, lines, geo, log = () => {}) {
  const { cumulative, pointAt } = geo;
  const geom = route.route.geometry;
  const cum = cumulative(geom);
  const total = cum[cum.length - 1];
  const { ev } = events(route);

  // 1. anchors
  const anchors = [];
  const stops = [];
  // search window: after an "After 300 yards" prompt the same manoeuvre is still ahead;
  // after a final prompt the car has reached it, so the next match must lie beyond it
  let from = -1, past = -Infinity;
  for (const ln of lines) {
    const t = tsec(ln[0]);
    if (ln[1] === 'GO') { anchors.push({ t, at: 0, why: 'GO' }); continue; }
    if (ln[1] === 'STOP') { stops.push({ t, dur: ln[2] }); continue; }
    if (!ln[3]) continue;
    const { sel, back, dt } = parseAnchor(ln[3], ln[1]);
    let at;
    if (sel === 'END') at = total;
    else {
      const e = ev.find((x) => x.at >= from && x.at > past && matches(x, sel));
      if (!e) { log(`  ✗ ${ln[0]} ${ln[3]}: no match after ${Math.round(Math.max(from, past))} m`); continue; }
      at = Math.max(0, e.at - back);
      if (back) from = at - 2; else { past = e.at + 1; from = e.at + 1; }
    }
    anchors.push({ t: t + dt, at, why: `${ln[0]} ${ln[3]}` });
  }
  anchors.sort((a, b) => a.t - b.t);
  // keep anchors moving forward in both time and distance
  const clean = [];
  for (const a of anchors) {
    const p = clean[clean.length - 1];
    if (p && (a.at < p.at - 1 || a.t <= p.t)) { log(`  ✗ dropped ${a.why} (t ${a.t}, ${Math.round(a.at)} m) after ${p.why} (t ${p.t}, ${Math.round(p.at)} m)`); continue; }
    clean.push(a);
  }

  // 2. time → position, standing still during stops
  const moving = (t) => t - stops.reduce((s, x) => s + Math.max(0, Math.min(t - x.t, x.dur)), 0);
  const pts = clean.map((a) => ({ tau: moving(a.t), at: a.at }));
  const atOf = (t) => {
    const tau = moving(t);
    if (!pts.length || tau <= pts[0].tau) return pts[0]?.at ?? 0;
    for (let i = 1; i < pts.length; i++) {
      if (tau <= pts[i].tau) {
        const a = pts[i - 1], b = pts[i];
        return b.tau > a.tau ? a.at + ((tau - a.tau) / (b.tau - a.tau)) * (b.at - a.at) : b.at;
      }
    }
    return pts[pts.length - 1].at;
  };
  const stopAt = (t) => stops.find((s) => t > s.t + 1 && t < s.t + s.dur + 2);

  // 3. video-sync anchors for the app (strictly increasing in both)
  const ta = [...clean.map((a) => ({ t: a.t, at: a.at }))];
  for (const s of stops) { const at = atOf(s.t); ta.push({ t: s.t, at }, { t: s.t + s.dur, at: at + 0.5 }); }
  ta.sort((a, b) => a.t - b.t);
  const timeAnchors = [];
  for (const a of ta) {
    const p = timeAnchors[timeAnchors.length - 1];
    if (p && (a.at <= p.at || a.t <= p.t)) continue;
    timeAnchors.push(a);
  }

  // 4. the script itself
  const script = [];
  for (const ln of lines) {
    if (ln[1] !== 'S' && ln[1] !== 'E') continue;
    const t = tsec(ln[0]);
    const at = Math.max(0, Math.min(total, atOf(t)));
    const p = pointAt(geom, cum, at);
    // said while standing still: remember for how long the car had been standing
    const s = stopAt(t);
    script.push({ t, who: ln[1] === 'S' ? 'satnav' : 'examiner', text: ln[2], at: Math.round(at), lat: +p[0].toFixed(6), lng: +p[1].toFixed(6), ...(s ? { wait: true, waitFor: Math.max(2, Math.round(t - s.t)) } : {}) });
  }
  route.timeAnchors = timeAnchors.map((a) => { const p = pointAt(geom, cum, a.at); return { t: Math.round(a.t), lat: +p[0].toFixed(6), lng: +p[1].toFixed(6) }; });
  route.script = script;
  return { anchors: clean, stops, timeAnchors, script };
}
