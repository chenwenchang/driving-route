// Examiner-style voice guidance for rehearsing a UK driving-test route, plus
// optional coaching tips. Pure logic (no DOM): builds the list of things to say
// along the route ("cues") and decides, from the car's progress, what is due.
//
// Phrasing follows the standard directions British driving examiners give
// ("Take the next road on the left, please", "At the roundabout, take the third
// exit"). Road names are never spoken: examiners don't use them.
import { angleDiff, cumulative, haversine, norm360, pointAt, project } from './geo.js';
import { CENTRE, titleOf } from './model.js';
import { glossZh } from './gloss.js';
import { collectIntersections, isLargeRoundabout, ordinalEn, ordinalZh, DIR_ZH } from './roundabout.js';

const SIDE_ZH = { left: '左', right: '右' };
const RB_STEP = new Set(['roundabout', 'rotary', 'roundabout turn']);
const NO_DIRECTION = new Set(['depart', 'arrive', 'exit roundabout', 'exit rotary', 'notification', 'merge']);
const MPH = 0.44704;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isRb = (m) => m.kind === 'rb' || m.kind === 'mini';

export const OPENING = {
  en: "Please follow the road ahead, unless traffic signs direct you otherwise, or I ask you to turn, which I'll do in good time. Move off when you're ready.",
  zh: '沿着路往前开，除非路牌另有指示，或者我让你转弯（我会提前告诉你）。准备好就起步。',
};

// DVSA "show me" questions (asked while driving). Contains public sector information
// licensed under the Open Government Licence v3.0.
export const SHOW_ME = [
  { en: "When it's safe to do so, can you show me how you'd wash and clean the rear windscreen?", zh: 'Show me：演示清洗后挡风玻璃' },
  { en: "When it's safe to do so, can you show me how you'd wash and clean the front windscreen?", zh: 'Show me：演示清洗前挡风玻璃' },
  { en: "When it's safe to do so, can you show me how you'd switch on your dipped headlights?", zh: 'Show me：打开近光灯' },
  { en: "When it's safe to do so, can you show me how you'd set the rear demister?", zh: 'Show me：打开后窗除雾' },
  { en: "When it's safe to do so, can you show me how you'd operate the horn?", zh: 'Show me：按喇叭' },
  { en: "When it's safe to do so, can you show me how you'd demist the front windscreen?", zh: 'Show me：前挡风玻璃除雾' },
  { en: "When it's safe to do so, can you show me how you'd open and close the side window?", zh: 'Show me：打开再关上侧窗' },
];

/** How far before a point each kind of cue is spoken, from the current speed (m/s). */
export const LEAD = {
  turn: (v) => clamp(v * 8, 70, 220), // "in good time": ~8 s
  rb: (v) => clamp(v * 10, 100, 280), // roundabouts need time to pick a lane
  tip: (v) => clamp(v * 5, 40, 150),
  early: (v) => clamp(v * 6, 50, 160), // lower speed limit ahead: slow down before the sign
  late: (v) => clamp(v * 3.5, 30, 70), // blind-spot check right before the turn
  sign: () => 5, // higher limit: only once you reach the sign
};

/* ------------------------------------------------------------------ maneuvers */

const turnSide = (mod) => (/left/.test(mod || '') ? 'left' : /right/.test(mod || '') ? 'right' : null);

function rbRange(a) {
  const from = a.rb?.fromAt ?? a.at;
  const to = a.rb?.toAt ?? from + (a.rb?.kind === 'mini' ? 0 : 30);
  return [from, Math.max(from, to)];
}

/**
 * An OSRM intersection as the driver sees it: angle of every other road relative
 * to straight ahead (negative = left). `ahead`: another road carries straight on.
 */
function junctionShape(x) {
  if (!x || x.i == null || !x.b?.length) return null;
  const straight = norm360(x.b[x.i] + 180);
  const others = [];
  x.b.forEach((b, k) => { if (k !== x.i && k !== x.o) others.push(angleDiff(b, straight)); });
  return { others, ahead: others.some((r) => Math.abs(r) < 40) };
}

/** What kind of direction an OSRM step needs (null = none: the road just carries on). */
function classifyStep(s, j, lightsHere) {
  const side = turnSide(s.mod);
  if (!side) return null; // straight on is covered by "follow the road ahead"; U-turns are routing artefacts
  if (s.type === 'fork') return { kind: 'fork', side };
  if (s.type === 'on ramp') return { kind: 'slipOn', side };
  if (s.type === 'off ramp') return { kind: 'slipOff', side };
  const slight = /slight/.test(s.mod);
  if (s.type === 'continue' || s.type === 'new name') {
    // our road bends at a junction: only worth a word if another road goes straight on
    return !slight && j?.ahead ? { kind: 'follow', side } : null;
  }
  if (slight) {
    // a gentle bend: "keep left" only if another road is also nearly straight ahead
    return j?.others.some((r) => Math.abs(r) < 60) ? { kind: 'fork', side } : null;
  }
  if (lightsHere) return { kind: 'lights', side };
  if (s.type === 'end of road' || (j && !j.ahead)) return { kind: 'end', side };
  return { kind: 'road', side };
}

/** Stable key of a decision point (survives re-routing), for user overrides. */
export const junctionKey = (loc) => (loc ? `j:${(+loc[0]).toFixed(5)},${(+loc[1]).toFixed(5)}` : null);

/** Decision points where an examiner gives a direction, in route order. */
export function buildManeuvers(route, cum = null) {
  const r = route.route;
  if (!r?.geometry?.length) return [];
  cum = cum || cumulative(r.geometry);
  const anns = usable(route);
  const lights = anns.filter((a) => a.type === 'signals').map((a) => a.at);
  const list = [];
  for (const a of anns) {
    if (a.type !== 'roundabout' || !a.rb) continue;
    const [from, to] = rbRange(a);
    list.push({
      kind: a.rb.kind === 'mini' ? 'mini' : 'rb', at: from, end: to, exit: a.rb.exit || 1, dir: a.rb.dir || 'ahead',
      rb: a.rb, ann: a, loc: a.rb.entry || [a.lat, a.lng], road: a.rb.toRoad || '', key: `rb:${a.key || a.id}`,
    });
  }
  const rbs = list.slice();
  const inRb = (at) => rbs.some((m) => at >= m.at - 10 && at <= m.end + 20);
  const steps = r.steps || [];
  steps.forEach((s, k) => {
    if (RB_STEP.has(s.type)) {
      if (rbs.some((m) => Math.abs(m.at - s.at) < 40)) return; // already described by an annotation
      const nx = steps[k + 1];
      const exitStep = nx && /^exit (roundabout|rotary)$/.test(nx.type) ? nx : null;
      const turn = exitStep && s.bb != null && exitStep.ba != null ? angleDiff(exitStep.ba, s.bb) : 0;
      const dir = s.type === 'roundabout turn'
        ? (turnSide(s.mod) || (s.mod === 'uturn' ? 'uturn' : 'ahead'))
        : Math.abs(turn) > 150 ? 'uturn' : turn < -45 ? 'left' : turn > 45 ? 'right' : 'ahead';
      list.push({ kind: s.type === 'roundabout turn' ? 'mini' : 'rb', at: s.at, end: exitStep ? exitStep.at : s.at + 25, exit: s.exit || 1, dir, loc: s.loc, road: s.name || s.ref || '', key: junctionKey(s.loc) });
      return;
    }
    if (NO_DIRECTION.has(s.type) || inRb(s.at)) return;
    const unnamed = !s.name && !s.ref;
    if (unnamed && (s.dist ?? 99) < 40) return; // car-park aisles, service roads
    const prev = steps[k - 1];
    if (unnamed && prev && !prev.name && !prev.ref) return; // driving around inside a car park
    const c = classifyStep(s, junctionShape(s.ints?.[0]), lights.some((x) => x >= s.at - 40 && x <= s.at + 5));
    if (!c) return;
    list.push({ ...c, at: s.at, end: s.at, loc: s.loc, road: s.name || s.ref || '', dest: s.dest || '', key: junctionKey(s.loc) });
  });
  list.sort((a, b) => a.at - b.at);
  // a roundabout annotation and an OSRM turn at the same spot: keep the roundabout
  const out = [];
  for (const m of list) {
    const p = out[out.length - 1];
    if (p && Math.abs(m.at - p.at) < 12 && isRb(m) !== isRb(p)) { if (isRb(m)) out[out.length - 1] = m; continue; }
    out.push(m);
  }
  out.forEach((m, i) => {
    m.id = `m${i}`;
    m.from = i ? out[i - 1].end + 8 : 0; // can't announce before the previous manoeuvre is done
    m.loc = m.loc || pointAt(r.geometry, cum, m.at);
    m.key = m.key || `at:${Math.round(m.at)}`;
  });
  return out;
}

const usable = (route) => (route.annotations || []).filter((a) => a.at != null && !a.offRoute && !a.stale);

/**
 * Side roads along the route, for "next / second road on the left".
 * Prefers the OSM-based list saved by auto-detect (real roads only, with no-entry
 * and private roads marked ambiguous); falls back to OSRM intersections, which
 * also contain service roads and car-park entrances.
 */
export function sideRoadList(r, cum) {
  if (Array.isArray(r.sideRoads)) return { list: r.sideRoads, source: 'osm' };
  const list = [];
  for (const x of collectIntersections(r, cum || cumulative(r.geometry))) {
    if (x.i == null) continue;
    const straight = norm360(x.b[x.i] + 180);
    x.b.forEach((b, k) => {
      if (k === x.i || k === x.o) return;
      const rel = angleDiff(b, straight);
      if (Math.abs(rel) < 25 || Math.abs(rel) > 155) return;
      list.push({ at: Math.round(x.at), side: rel < 0 ? 'left' : 'right', ok: !!x.e[k], ...(x.e[k] ? {} : { amb: true }) });
    });
  }
  return { list, source: 'osrm' };
}

/* -------------------------------------------------------------------- phrases */

const roadOrd = (n) => (n === 0 ? 'next' : ordinalEn(n + 1));
const roadOrdZh = (n) => (n === 0 ? '下一个' : `${ordinalZh(n + 1)}个`);
const speakDest = (d) => String(d).replace(/:/g, ',').replace(/;/g, ' or ');

/** Examiner direction for a manoeuvre. n = roads on that side to pass first. */
export function directionText(m, n = 0, { chain = false } = {}) {
  const s = m.side, sz = SIDE_ZH[s] || '';
  switch (m.kind) {
    case 'road': return { core: `Take the ${roadOrd(n)} road on the ${s}`, zh: `${roadOrdZh(n)}路口${sz}转` };
    case 'end': return { core: `At the end of the road, turn ${s}`, zh: `路尽头${sz}转` };
    case 'lights': return { core: `At the traffic lights, turn ${s}`, zh: `红绿灯路口${sz}转` };
    case 'follow': return { core: `Follow the road round to the ${s}`, zh: `顺着路往${sz}拐` };
    case 'fork': return { core: `Where the road divides, keep ${s}`, zh: `岔路口靠${sz}走` };
    case 'slipOn': return m.dest
      ? { core: `Follow the signs for ${speakDest(m.dest)}`, zh: `跟着 ${m.dest} 的路牌走匝道` }
      : { core: `Take the slip road on the ${s}`, zh: `走${sz}边的匝道` };
    case 'slipOff': return m.dest
      ? { core: `Take the next slip road, signposted ${speakDest(m.dest)}`, zh: `从下一个匝道驶出（${m.dest}）` }
      : { core: `Leave at the next slip road on the ${s}`, zh: '从下一个匝道驶出' };
    case 'rb': {
      const ord = ordinalEn(m.exit);
      const large = isLargeRoundabout(m.rb);
      const zh = large ? `环岛${ordinalZh(m.exit)}出口` : `环岛${ordinalZh(m.exit)}出口（${DIR_ZH[m.dir] || '直行'}）`;
      // "follow the road ahead" only where ahead is obvious: big interchanges get the exit number
      if (m.dir === 'ahead' && !chain && m.exit <= 2 && !large) return { core: `At the roundabout, follow the road ahead. That's the ${ord} exit`, zh, plain: true };
      return { core: `At the roundabout, take the ${ord} exit`, zh };
    }
    case 'mini': {
      const zh = `小环岛${DIR_ZH[m.dir] || ''}（${ordinalZh(m.exit)}出口）`;
      if (m.dir === 'left' || m.dir === 'right') return { core: `At the mini-roundabout, turn ${m.dir}`, zh };
      if (m.dir === 'ahead') return { core: 'At the mini-roundabout, follow the road ahead', zh };
      return { core: `At the mini-roundabout, take the ${ordinalEn(m.exit)} exit`, zh };
    }
    default: return { core: 'Follow the road ahead', zh: '沿路直行' };
  }
}

/** Second half of a chained direction: "…, then the next road on the right". */
function thenText(m, n, prev) {
  const again = prev && prev.kind === m.kind && prev.side === m.side ? ' again' : '';
  const sz = SIDE_ZH[m.side] || '';
  if (m.kind === 'road') return { en: `the ${roadOrd(n)} road on the ${m.side}`, zh: `${roadOrdZh(n)}路口${sz}转` };
  if (m.kind === 'end') return { en: `turn ${m.side}${again} at the end of the road`, zh: `路尽头再${sz}转` };
  if (m.kind === 'lights') return { en: `turn ${m.side}${again} at the traffic lights`, zh: `红绿灯路口${sz}转` };
  if (m.kind === 'rb') return { en: `at the next roundabout, take the ${ordinalEn(m.exit)} exit`, zh: `下一个环岛${ordinalZh(m.exit)}出口` };
  if (m.kind === 'mini') {
    const what = m.dir === 'left' || m.dir === 'right' ? `turn ${m.dir}` : m.dir === 'ahead' ? 'follow the road ahead' : `take the ${ordinalEn(m.exit)} exit`;
    const zh = `下一个小环岛${DIR_ZH[m.dir] || ''}`;
    if (prev?.kind === 'mini' && prev.dir === m.dir) return { en: `${what} again at the next mini-roundabout`, zh };
    return { en: `at the ${prev?.kind === 'mini' ? 'next ' : ''}mini-roundabout, ${what}`, zh };
  }
  const t = directionText(m, n, { chain: true });
  return { en: t.core.charAt(0).toLowerCase() + t.core.slice(1), zh: t.zh };
}

/** Lane advice from OSRM/OSM turn:lanes data, e.g. "Get in the right-hand lane." */
export function laneAdvice(lanes) {
  if (!lanes?.length || lanes.length < 2) return null;
  const valid = lanes.map((l, i) => (l.valid ? i : -1)).filter((i) => i >= 0);
  const n = lanes.length;
  if (!valid.length || valid.length === n) return null;
  if (valid.length === 1) {
    const i = valid[0];
    if (i === 0) return 'Get in the left-hand lane.';
    if (i === n - 1) return 'Get in the right-hand lane.';
    if (n === 3) return 'Get in the middle lane.';
    return `Get in lane ${i + 1} from the left.`;
  }
  if (valid[valid.length - 1] < n - 1 && valid[0] === 0) return 'Use the left-hand lanes.';
  if (valid[0] > 0 && valid[valid.length - 1] === n - 1) return 'Use the right-hand lanes.';
  return 'Follow the lane arrows.';
}

/** Coaching for a roundabout approach (Highway Code Rule 186). */
export function roundaboutCoach(m) {
  const rb = m.rb || {};
  const exit = m.exit || rb.exit || 1;
  const rule = rb.rule || (exit === 1 ? 'first' : m.dir === 'right' || m.dir === 'uturn' ? 'right' : 'intermediate');
  const say = m.ann?.say?.trim();
  if (say) return { en: say, zh: '（自定义提示）' };
  if (isLargeRoundabout(rb)) {
    const ord = ordinalEn(exit);
    const sig = exit > 1 ? 'Signal left after you pass the exit before yours.' : 'Signal left as you approach.';
    const lights = rb.signalised ? 'Watch the traffic lights on the roundabout.' : 'Give way to traffic from the right.';
    return { en: `Follow the lane arrows for the ${ord} exit. ${sig} ${lights}`, zh: `大型立交环岛：按地面箭头选第 ${exit} 出口的车道；${exit > 1 ? `过了第 ${exit - 1} 出口再打左灯` : '进环岛前打左灯'}；${rb.signalised ? '注意环岛内的红绿灯' : '让右侧来车'}` };
  }
  const lane = laneAdvice(rb.lanes) || (rule === 'right' ? 'Right-hand lane.' : 'Left-hand lane.');
  if (m.kind === 'mini') {
    const sig = m.dir === 'left' ? 'Signal left.' : m.dir === 'right' || m.dir === 'uturn' ? 'Signal right.' : 'No signal needed.';
    return { en: `${sig} Give way to traffic from the right.`, zh: `${m.dir === 'left' ? '打左灯' : m.dir === 'ahead' ? '直行不用打灯' : '打右灯'}，让右侧来车` };
  }
  if (rule === 'first') return { en: `${lane} Signal left as you approach. Give way to traffic from the right.`, zh: '走左道，进环岛前打左灯；让右侧来车' };
  if (rule === 'right') return { en: `${lane} Signal right as you approach. Give way to traffic from the right.`, zh: `走右道，进环岛前打右灯；过了第 ${exit - 1} 出口改打左灯；让右侧来车` };
  return { en: `${lane} No signal on approach. Give way to traffic from the right.`, zh: `一般走左道，进环岛前不打灯；过了第 ${exit - 1} 出口打左灯；让右侧来车` };
}

/** Where to say "signal left": as the car passes the exit before ours. */
export function signalLeftPoint(m) {
  const rb = m.rb;
  if (!rb || m.kind !== 'rb' || (m.exit || 1) < 2 || rb.rule === 'first' || !rb.arms?.length) return null;
  const d = (arm) => norm360(arm.s - 180); // clockwise degrees from the entry
  const exitArm = rb.arms.find((a) => a.isExit);
  const prev = rb.arms.find((a) => a.no === m.exit - 1);
  if (!exitArm || !prev || m.end - m.at < 15) return null;
  const f = d(prev) / Math.max(1, d(exitArm));
  if (!(f > 0 && f < 1)) return null;
  return m.at + (m.end - m.at) * f;
}

/** English coaching phrase for an attention point (practice mode). */
export function tipText(a) {
  if (a.say?.trim()) return a.say.trim();
  const t = `${a.title || ''} ${a.note || ''}`;
  switch (a.type) {
    case 'speed':
      if (!a.speed) return null;
      if (!a.prevSpeed) return `It's a ${a.speed} limit here.`;
      return a.speed < a.prevSpeed ? `${a.speed} limit ahead. Check your speed.` : `Speed limit now ${a.speed}.`;
    case 'cycle': return /右转/.test(t) ? 'Watch for cyclists as you turn.' : 'Cycle lane. Check your left mirror and blind spot.';
    case 'box': return "Yellow box junction. Don't enter unless your exit is clear.";
    case 'lane': return laneAdvice(a.lanes) || 'Check the lane markings, and get in lane early.';
    case 'crossing': return a.osm?.crossing === 'zebra' || /斑马|zebra/i.test(t) ? 'Zebra crossing ahead. Look out for pedestrians.' : 'Pedestrian crossing ahead.';
    case 'junction': return 'Junction ahead. Look both ways.';
    case 'bus': return 'Bus lane on the left. Check the times on the sign.';
    case 'hazard': return 'Hazard ahead. Take care.';
    case 'signals': return 'Traffic lights ahead.';
    case 'stop': return 'Stop junction ahead. Stop completely at the line.';
    case 'calming': return 'Speed bumps ahead.';
    case 'school': return 'School ahead. Watch out for children.';
    case 'narrow': return 'Narrow road. Be ready to give way.';
    case 'merge': return /驶出/.test(t) ? 'Signal left, and slow down on the slip road.' : 'Check your right mirror and blind spot, and match the speed of the traffic.';
    case 'rail': return /巴士|bus/i.test(t) ? 'Busway crossing ahead. Check the lights.' : 'Level crossing ahead.';
    case 'mistake': return "Careful here. You've made a mistake here before.";
    default: return null; // notes without an English voice text stay silent
  }
}

/** What the voice says at an annotation by default (placeholder for the editor's voice field). */
export function voicePlaceholder(a) {
  const b = { ...a, say: '' };
  if (a.type === 'manoeuvre') return pullUpText(b).en;
  if (a.type === 'roundabout' && a.rb) return roundaboutCoach({ rb: a.rb, exit: a.rb.exit, dir: a.rb.dir, kind: a.rb.kind === 'mini' ? 'mini' : 'rb' }).en;
  return tipText(b) || '（默认不播报）';
}

/** Examiner request at a manoeuvre point, and what follows once you've stopped. */
export function pullUpText(a) {
  const t = `${a.title || ''} ${a.note || ''}`;
  const custom = a.say?.trim();
  if (/右|right/i.test(t)) {
    return {
      en: custom || "When it's safe, pull up on the right-hand side of the road, please.", zh: '安全时在马路右侧靠边停车',
      goEn: 'Reverse back about two car lengths, then rejoin the traffic when you’re ready.', goZh: '倒车约两个车身，然后安全时重新汇入车流',
    };
  }
  return {
    en: custom || 'Pull up on the left at the next safe place, please.', zh: titleOf(a) === '考试动作' ? '在左边安全的地方靠边停车' : titleOf(a),
    goEn: "Move off when you're ready.", goZh: '准备好就起步',
  };
}

/* ----------------------------------------------------------------------- plan */

/**
 * Everything that can be said on this route.
 * mode 'mock' = examiner only (like the real test); 'practice' adds coaching.
 * tipLevel: minimum annotation level for coaching tips (1 all · 2 key · 3 hot spots).
 */
export function buildCuePlan(route, { mode = 'mock', tipLevel = 2, showMe = true, rand = Math.random, keepMuted = false, source = 'auto' } = {}) {
  const r = route.route;
  if (!r?.geometry?.length || r.geometry.length < 2) return null;
  const geom = r.geometry;
  const cum = cumulative(geom);
  const total = cum[cum.length - 1];
  const anns = usable(route);
  const ms = buildManeuvers(route, cum);
  const sides = sideRoadList(r, cum);
  const lights = anns.filter((a) => a.type === 'signals').map((a) => a.at);
  const voice = route.voice || {}; // user overrides per junction: {say, mute}
  // a route recorded from a video with captions carries what was actually said (route.script)
  const useScript = source !== 'generated' && Array.isArray(route.script) && route.script.length > 0;
  const cues = useScript ? scriptCues(route, geom, cum) : [{ id: 'open', kind: 'open', prio: 0, at: 0, en: OPENING.en, zh: OPENING.zh }];

  const dirs = [];
  for (const m of useScript ? [] : ms) {
    const ov = voice[m.key] || {};
    if (ov.mute && !keepMuted) continue;
    dirs.push({
      id: m.id, kind: 'dir', prio: 0, at: m.at, from: m.from, m, key: m.key,
      custom: ov.say?.trim() || null, muted: !!ov.mute,
      // roads to count before the turn (a no-entry arm right at the junction is part of it)
      cands: m.kind === 'road' ? sides.list.filter((x) => x.side === m.side && x.at >= m.from - 1 && x.at < m.at - (x.ok ? 8 : 25)) : [],
      blocks: m.kind === 'lights' ? lights.filter((x) => x > m.from && x < m.at - 40) : [],
    });
  }
  // manoeuvres close together are given as one instruction ("…, then the next right")
  for (let i = 0; i < dirs.length - 1; i++) {
    const a = dirs[i], b = dirs[i + 1];
    if (a.chainedFrom || a.custom || b.custom || a.muted || b.muted) continue;
    const gap = b.m.at - a.m.end;
    if (gap < (isRb(a.m) && isRb(b.m) ? 90 : 60)) { a.chain = b; b.chainedFrom = a.id; }
  }
  cues.push(...dirs);

  // anything the user wrote as the examiner's own words (both modes)
  for (const a of anns) {
    if (!a.sayAsExaminer || !a.say?.trim() || ['roundabout', 'manoeuvre'].includes(a.type)) continue;
    cues.push({ id: `a:${a.id}`, kind: 'examiner', prio: 0, at: a.at, until: a.at - 3, en: a.say.trim(), zh: titleOf(a) });
  }

  if (mode === 'practice') {
    for (const m of ms) {
      if (!isRb(m)) continue;
      const c = roundaboutCoach(m);
      // after the examiner's direction; with a video script there is no generated direction to follow
      if (useScript) cues.push({ id: `${m.id}:coach`, kind: 'tip', prio: 1, at: m.at, lead: 'early', until: m.at - 3, en: c.en, zh: c.zh });
      else cues.push({ id: `${m.id}:coach`, kind: 'coach', prio: 1, at: m.at, after: m.id, until: m.at - 3, en: c.en, zh: c.zh });
      const sp = signalLeftPoint(m);
      if (sp != null) cues.push({ id: `${m.id}:sig`, kind: 'rbSignal', prio: 0, at: sp, until: sp + 12, en: 'Signal left now.', zh: '现在打左灯，准备出环岛' });
    }
    const onRb = (a) => ms.some((m) => isRb(m) && a.at >= m.at - 5 && a.at <= m.end + 15);
    for (const a of anns) {
      if (['roundabout', 'manoeuvre'].includes(a.type) || a.sayAsExaminer) continue;
      if ((a.level || 1) < tipLevel && !a.say?.trim()) continue;
      if (a.type === 'cycle' && !a.say?.trim() && onRb(a)) continue; // covered by "signal left now"
      const en = tipText(a);
      if (!en) continue;
      const up = a.type === 'speed' && a.prevSpeed && a.speed > a.prevSpeed;
      const lead = up ? 'sign' : a.type === 'speed' ? 'early' : a.type === 'cycle' ? 'late' : 'tip';
      cues.push({ id: `a:${a.id}`, kind: 'tip', prio: 1, at: a.at, lead, until: up ? a.at + 30 : a.at - 3, en, zh: titleOf(a) });
    }
  }

  for (const a of useScript ? [] : anns) { // the video's own words already cover pull-ups and parking
    if (a.type !== 'manoeuvre') continue;
    const t = pullUpText(a);
    cues.push({ id: `a:${a.id}`, kind: 'pullup', prio: 0, at: a.at, until: a.at - 3, en: t.en, zh: t.zh });
    cues.push({ id: `a:${a.id}:go`, kind: 'moveoff', prio: 0, at: a.at, after: `a:${a.id}`, en: t.goEn, zh: t.goZh });
  }

  if (showMe && !useScript) {
    // somewhere quiet (no direction due for the next ≥ 350 m), 20–75 % into the drive
    for (let i = 0; i <= ms.length; i++) {
      const a = i ? ms[i - 1].end : 0, b = i < ms.length ? ms[i].at : total;
      const pos = Math.max(a + 100, total * 0.2);
      if (b - pos >= 350 && pos <= total * 0.75) {
        const q = SHOW_ME[Math.floor(rand() * SHOW_ME.length) % SHOW_ME.length];
        cues.push({ id: 'showme', kind: 'showme', prio: 0, at: pos, until: pos + 400, en: q.en, zh: q.zh });
        break;
      }
    }
  }

  const last = ms[ms.length - 1];
  const nearCentre = haversine(geom[geom.length - 1], [CENTRE.lat, CENTRE.lng]) < 250;
  if (!useScript) {
    cues.push({
      id: 'arrive', kind: 'arrive', prio: 0, at: total, from: last ? last.end + 8 : 0, until: total - 3,
      en: nearCentre ? 'Please drive back into the test centre, and park in one of the bays.' : 'Pull up on the left at the next safe place, please.',
      zh: nearCentre ? '开回考场，停进一个车位' : '在左边安全的地方靠边停车',
    });
    cues.push({
      id: 'end', kind: 'end', prio: 0, at: total,
      en: mode === 'mock' ? "Thank you. That's the end of your test." : "That's the end of the route.",
      zh: mode === 'mock' ? '考试结束' : '路线结束',
    });
  }

  cues.sort((a, b) => a.at - b.at || a.prio - b.prio);
  // where the car stood still in the video (pull-ups, parking): the simulator stops there too
  const stops = [];
  for (const c of cues) {
    if (c.kind !== 'script' || !c.wait) continue;
    const s = stops[stops.length - 1];
    if (s && Math.abs(c.at - s.at) < 30) s.dur = Math.max(s.dur, c.t - s.t0 + 6);
    else stops.push({ at: c.at, t0: c.t, dur: 8 });
  }
  // expected speed (from speed-limit annotations) for previews and the instruction list
  const limits = anns.filter((a) => a.type === 'speed' && a.speed).sort((a, b) => a.at - b.at);
  const vAt = (at) => {
    let mph = 30;
    for (const l of limits) { if (l.at <= at + 1) mph = l.speed; else break; }
    return Math.min(mph, 40) * MPH * 0.9;
  };
  return { cues, maneuvers: ms, total, vAt, sideSource: sides.source, mode, script: useScript, stops: stops.map(({ at, dur }) => ({ at, dur })) };
}

/**
 * Lines from the route's video (sat-nav and examiner), said where they were said.
 * Lines before the car moved off hold the simulator; lines said while standing still
 * (`wait`) are only spoken once the car has stopped there.
 */
function scriptCues(route, geom, cum) {
  const out = [];
  let hint = 0;
  route.script.forEach((s, i) => {
    let at = s.at ?? 0;
    if (s.lat != null) {
      const p = project(geom, cum, [s.lat, s.lng], { atHint: hint, from: hint - 30 });
      if (p && p.dist < 40) at = p.at;
    }
    hint = at;
    out.push({
      id: `s${i}`, kind: 'script', who: s.who === 'satnav' ? 'satnav' : 'examiner', prio: 0, at, t: s.t,
      wait: !!s.wait, hold: at < 5, until: at + 80, en: s.text, zh: s.zh || glossZh(s.text),
    });
  });
  return out;
}

/* --------------------------------------------------------------------- runner */

/** Decides, update by update, which cues are due. One runner per drive. */
export class CueRunner {
  constructor(plan) {
    this.plan = plan;
    this.done = new Set();
    this.spoken = new Set();
    this.stopSince = null;
  }

  /** Skip everything behind `at` (after scrubbing, or when starting mid-route). */
  skipTo(at) {
    for (const c of this.plan.cues) {
      if (c.kind === 'end' || c.kind === 'arrive') continue;
      const ref = c.kind === 'dir' ? c.at - 4 : c.until ?? c.at;
      if (ref < at) this.done.add(c.id);
    }
  }

  /**
   * @param {{at:number, v?:number, t?:number}} s distance along route (m), speed (m/s), clock (s)
   * @returns {{id, kind, prio, at, en, zh}[]} cues to say now, examiner first
   */
  update({ at, v = 0, t = 0 }) {
    if (v < 0.8) { if (this.stopSince == null) this.stopSince = t; } else this.stopSince = null;
    const stopped = this.stopSince == null ? 0 : t - this.stopSince;
    const out = [];
    for (const c of this.plan.cues) {
      if (this.done.has(c.id)) continue;
      if (c.at - at > 600) break; // cues are sorted by position
      const r = this.check(c, at, v, stopped);
      if (r === 'skip') { this.done.add(c.id); continue; }
      if (!r) continue;
      this.done.add(c.id);
      this.spoken.add(c.id);
      out.push({
        id: c.id, kind: c.kind, prio: c.prio, at: c.at, until: c.until ?? null, en: r.en, zh: r.zh,
        ...(c.kind === 'dir' ? { key: c.key, m: c.m, auto: r.auto, custom: !!c.custom, muted: c.muted } : {}),
        ...(c.kind === 'script' ? { who: c.who, t: c.t, hold: c.hold, wait: c.wait } : {}),
      });
    }
    return out.sort((a, b) => a.prio - b.prio);
  }

  check(c, at, v, stopped) {
    const say = { en: c.en, zh: c.zh };
    const waitParent = () => (this.spoken.has(c.after) ? null : this.done.has(c.after) ? 'skip' : false);
    switch (c.kind) {
      case 'open': return at < 150 ? say : 'skip';
      case 'dir': {
        if (c.chainedFrom && this.spoken.has(c.chainedFrom)) return 'skip';
        if (at > c.at - 4) return 'skip';
        if (at < c.from) return false;
        if (at < c.at - (isRb(c.m) ? LEAD.rb(v) : LEAD.turn(v))) return false;
        // wait until roads that would make "next / second road" ambiguous are behind us
        const ahead = c.cands.filter((x) => x.at > at + 2);
        const n = ahead.filter((x) => x.ok).length;
        const amb = ahead.some((x) => !x.ok) || c.blocks.some((x) => x > at + 2);
        if (!c.custom && (n > 1 || amb) && c.at - at > 45) return false;
        const auto = this.dirText(c, n);
        return c.custom ? { en: c.custom, zh: auto.zh, auto: auto.en } : { ...auto, auto: auto.en };
      }
      case 'script':
        if (at > c.until) return 'skip';
        if (at < c.at - 3) return false;
        // said while the car stood still in the video ("When you are ready, drive on"): wait for a stop
        if (c.wait && stopped < 2) return at > c.at + 40 ? 'skip' : false;
        return say;
      case 'coach': {
        const w = waitParent();
        if (w !== null) return w;
        return at < c.until ? say : 'skip';
      }
      case 'tip':
        if (at > c.until) return 'skip';
        return at >= c.at - LEAD[c.lead](v) ? say : false;
      case 'rbSignal':
        if (at > c.until) return 'skip';
        return at >= c.at - 3 ? say : false;
      case 'showme':
        if (at > c.until) return 'skip';
        return at >= c.at ? say : false;
      case 'pullup':
      case 'examiner':
        if (at > c.until) return 'skip';
        return at >= c.at - LEAD.turn(v) ? say : false;
      case 'moveoff': {
        const w = waitParent();
        if (w !== null) return w;
        if (at > c.at + 250) return 'skip';
        return stopped >= 6 ? say : false;
      }
      case 'arrive':
        if (at > c.until) return 'skip';
        if (at < c.from) return false;
        return at >= c.at - LEAD.turn(v) ? say : false;
      case 'end': return at >= c.at - 15 ? say : false;
      default: return 'skip';
    }
  }

  dirText(c, n) {
    const t1 = directionText(c.m, n, { chain: !!c.chain });
    if (!c.chain) return { en: `${t1.core}${t1.plain ? '.' : ', please.'}`, zh: t1.zh };
    const b = c.chain;
    const t2 = thenText(b.m, b.cands.filter((x) => x.ok).length, c.m);
    return { en: `${t1.core}, then ${t2.en}, please.`, zh: `${t1.zh}，然后${t2.zh}` };
  }

  /** The next examiner direction ahead of `at` (for display). */
  nextDirection(at) {
    return this.plan.cues.find((c) => c.kind === 'dir' && c.at > at + 4 && !(c.chainedFrom && this.spoken.has(c.chainedFrom))) || null;
  }
}

/**
 * Dry run along the whole route at the expected speed: what would be said, and where.
 * Used for the instruction list and for tests.
 */
export function transcript(plan, { step = 5 } = {}) {
  const runner = new CueRunner(plan);
  const out = [];
  let t = 0;
  for (let at = 0; ; at += step) {
    const pos = Math.min(at, plan.total);
    const v = pos >= plan.total ? 0 : plan.vAt(pos);
    t += step / Math.max(v, 1);
    for (const s of runner.update({ at: pos, v, t })) out.push({ ...s, sayAt: pos });
    if (pos >= plan.total) break;
  }
  return out;
}

/** Expected speed for simulated driving: speed limit, slowing for turns and roundabouts. */
export function simSpeedAt(plan, at) {
  let v = plan.vAt(at);
  for (const m of plan.maneuvers) {
    if (m.at < at - 1) { if (m.end >= at) v = Math.min(v, isRb(m) ? 6 : 4.5); continue; }
    const d = m.at - at;
    if (d > 300) break;
    const vt = isRb(m) ? 6 : m.kind === 'fork' || m.kind === 'follow' ? 9 : 4.5;
    v = Math.min(v, Math.sqrt(vt * vt + 2 * 1.2 * d));
  }
  if (plan.total - at < 120) v = Math.min(v, Math.sqrt(2 * 1.2 * Math.max(0, plan.total - at)) + 1);
  return Math.max(1.5, v);
}
