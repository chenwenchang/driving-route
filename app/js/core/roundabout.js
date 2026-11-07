// Roundabout analysis: exit number, clock position, lane & signal advice
// (Highway Code Rule 186), and an arm list for drawing a schematic.
//
// UK roundabouts circulate clockwise, so exits are met in clockwise order from
// the entry arm. Arm "screen angle" s: 0 = straight ahead (12 o'clock),
// 90 = right (3 o'clock), 180 = where we came from (6 o'clock), 270 = left.
import { angleDiff, bearing, bearingAt, densify, fitCircle, norm360, pointAt, project, slice } from './geo.js';
import { isRoundaboutSeg } from './osm.js';

const RB_STEP = new Set(['roundabout', 'rotary', 'roundabout turn']);
const EXIT_STEP = new Set(['exit roundabout', 'exit rotary']);

/** All OSRM intersections along the route, with distance-along `at`. */
export function collectIntersections(route, cum) {
  const out = [];
  for (const s of route.steps || []) {
    for (const x of s.ints || []) {
      const p = project(route.geometry, cum, x.l, { atHint: s.at, from: s.at - 40, to: s.at + (s.dist || 0) + 40 });
      if (p && p.dist < 15) out.push({ ...x, at: p.at, stepAt: s.at });
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/** Find roundabout traversals: OSM junction runs, OSRM steps, mini-roundabout nodes. */
export function findRoundabouts(route, cum, { segs = null, miniIdx = [] } = {}) {
  const found = [];
  const geom = route.geometry;
  if (segs) {
    let i = 0;
    while (i < segs.length) {
      if (isRoundaboutSeg(segs[i])) {
        let j = i;
        while (j < segs.length && isRoundaboutSeg(segs[j])) j++;
        found.push({ kind: 'roundabout', fromAt: cum[i], toAt: cum[j], name: segs[i].way.tags.name || '', fromIdx: i, toIdx: j });
        i = j;
      } else i++;
    }
  }
  for (const v of miniIdx) found.push({ kind: 'mini', fromAt: cum[v], toAt: cum[v], name: '', fromIdx: v, toIdx: v });

  const steps = route.steps || [];
  steps.forEach((s, k) => {
    if (!RB_STEP.has(s.type)) return;
    const near = found.find((f) => Math.abs(f.fromAt - s.at) < 30);
    if (near) {
      near.step = s;
      // OSRM's exit maneuver is authoritative for where we leave the circle
      const nx = steps[k + 1];
      if (nx && EXIT_STEP.has(nx.type) && nx.at > near.fromAt + 5 && Math.abs(nx.at - near.toAt) < 60) near.toAt = nx.at;
      if (s.type === 'rotary') near.kind = near.kind === 'mini' ? 'mini' : 'rotary';
      if (!near.name && s.rotary) near.name = s.rotary;
      return;
    }
    const next = steps[k + 1];
    let toAt;
    if (next && EXIT_STEP.has(next.type)) toAt = next.at;
    else {
      const after = (s.ints || []).slice(1);
      const x = after[Math.min(s.exit || 1, after.length) - 1];
      const p = x ? project(geom, cum, x.l, { atHint: s.at, from: s.at, to: s.at + (s.dist || 0) + 20 }) : null;
      toAt = p ? p.at : s.at + 25;
    }
    found.push({ kind: s.type === 'rotary' ? 'rotary' : 'roundabout', fromAt: s.at, toAt, name: s.rotary || '', step: s });
  });
  found.sort((a, b) => a.fromAt - b.fromAt);
  return found;
}

/** Compute exit/arms/clock/advice fields for one roundabout traversal. */
export function describeRoundabout(route, cum, ints, rb, { segs = null, signalAts = [] } = {}) {
  const geom = route.geometry;
  const { fromAt, toAt } = rb;
  const approach = bearingAt(geom, cum, Math.max(0, fromAt - 12), 10);
  const exitBrg = bearingAt(geom, cum, toAt + 12, 10);
  // arms in travel (clockwise) order: {d: clockwise degrees from the entry arm, canExit, isExit}
  let arms = [];
  let method = 'bearing';

  if (rb.kind === 'mini') {
    // single node: side roads leave radially, so their bearings give the layout
    const x = nearest(ints, fromAt, 10);
    if (x && x.i != null) {
      const inB = x.b[x.i];
      arms = x.b
        .map((b, k) => ({ d: norm360(b - inB), canExit: !!x.e[k], isExit: k === x.o, k }))
        .filter((a) => a.k !== x.i)
        .sort((p, q) => p.d - q.d);
    }
    if (!arms.some((a) => a.isExit)) arms = [{ d: norm360(exitBrg - approach - 180), canExit: true, isExit: true }];
  } else {
    // where each side road joins the circle, measured around the fitted centre
    const arc = toAt - fromAt > 10 ? densify(slice(geom, cum, fromAt, toAt), 2) : [];
    const fit = arc.length >= 5 ? fitCircle(arc) : null;
    const good = fit && fit.r > 4 && fit.r < 250 && fit.rms < Math.max(2.5, fit.r * 0.2) && Math.abs(fit.span) > 25;
    const entryPt = pointAt(geom, cum, fromAt);
    const orient = good && fit.span < 0 ? -1 : 1; // UK: clockwise (+)
    const posD = (p) => norm360(orient * (bearing(fit.c, p) - bearing(fit.c, entryPt)));
    const brgD = (b) => norm360(b - approach - 180);
    if (good) method = 'circle';
    for (const x of ints) {
      if (x.at <= fromAt + 2 || x.at >= toAt - 3) continue; // intermediate circle nodes only
      x.b.forEach((b, k) => {
        if (k !== x.i && k !== x.o) arms.push({ d: good ? posD(x.l) : brgD(b), canExit: !!x.e[k], isExit: false });
      });
    }
    const xe = nearest(ints, toAt, 8);
    const exitPt = pointAt(geom, cum, toAt);
    arms.push({ d: good ? posD(exitPt) : brgD(xe && xe.o != null ? xe.b[xe.o] : exitBrg), canExit: true, isExit: true });
    rb.centre = good ? fit.c : null;
    rb.radius = good ? Math.round(fit.r) : null;
  }

  // number exits; keep angles strictly increasing (clockwise) for drawing
  let n = 0, prevD = 0, after = false;
  for (const a of arms) {
    let d = a.d;
    if (d < 1) d = 359;
    if (d <= prevD + 5) d = Math.min(prevD + 8, 354);
    a.d = Math.round(d);
    a.s = Math.round(norm360(180 + d));
    prevD = d;
    if (after) { a.after = true; continue; }
    if (a.canExit) a.no = ++n;
    if (a.isExit) after = true;
  }
  const exitArm = arms.find((a) => a.isExit);
  const counted = exitArm?.no || n || 1;
  const osrmExit = rb.step?.exit || null;
  const exit = rb.kind === 'mini' ? counted : osrmExit || counted;
  const d = exitArm ? exitArm.d : norm360(exitBrg - approach - 180);
  const s = norm360(180 + d);
  const clock = Math.round(s / 30) % 12 || 12;
  const dir = d < 135 ? 'left' : d <= 200 ? 'ahead' : d < 330 ? 'right' : 'uturn';
  const rule = exit === 1 ? 'first' : dir === 'right' || dir === 'uturn' ? 'right' : 'intermediate';

  // lanes at the entry (from OSRM / OSM turn:lanes): closest lane-bearing intersection just before entry
  const laneInt = ints.filter((x) => x.lanes && x.at >= fromAt - 60 && x.at <= fromAt + 3).sort((a, b) => b.at - a.at)[0];
  const lanes = rb.step?.lanes || laneInt?.lanes || null;

  const nameAt = (idx) => (segs && segs[idx] ? segs[idx].way.tags.name || segs[idx].way.tags.ref || '' : '');
  const fromRoad = rb.fromIdx != null ? nameAt(Math.max(0, rb.fromIdx - 1)) : '';
  const toRoad = (rb.toIdx != null ? nameAt(Math.min((segs?.length || 1) - 1, rb.toIdx)) : '') || rb.step?.name || '';

  return {
    kind: rb.kind,
    name: rb.name || '',
    exit,
    counted,
    uncertain: !!(osrmExit && rb.kind !== 'mini' && osrmExit !== counted),
    clock,
    dir,
    rule,
    turn: Math.round(angleDiff(exitBrg, approach)),
    approach: Math.round(approach),
    arms: arms.map(({ s: sa, canExit, isExit, no, after: af }) => ({ s: sa, ...(canExit ? {} : { noEntry: true }), ...(isExit ? { isExit: true } : {}), ...(no ? { no } : {}), ...(af ? { after: true } : {}) })),
    lanes,
    signalised: signalAts.some((a) => a >= fromAt - 35 && a <= toAt + 5),
    fromRoad,
    toRoad,
    method,
    ...(rb.centre ? { centre: rb.centre.map((v) => Math.round(v * 1e6) / 1e6), radius: rb.radius } : {}),
    entry: pointAt(geom, cum, fromAt).map((v) => Math.round(v * 1e6) / 1e6),
    exitPt: pointAt(geom, cum, toAt).map((v) => Math.round(v * 1e6) / 1e6),
    fromAt: Math.round(fromAt),
    toAt: Math.round(toAt),
  };
}

function nearest(ints, at, tol) {
  let best = null;
  for (const x of ints) {
    const d = Math.abs(x.at - at);
    if (d <= tol && (!best || d < Math.abs(best.at - at))) best = x;
  }
  return best;
}

// ---------- human-readable advice ----------
const ORD_ZH = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const ORD_EN = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
export const DIR_ZH = { left: '左转', ahead: '直行', right: '右转', uturn: '掉头' };
export const ordinalEn = (n) => ORD_EN[n] || `${n}th`;
export const ordinalZh = (n) => (ORD_ZH[n] ? `第${ORD_ZH[n]}` : `第${n}`);

/** Lane summary: "共 3 道，走左数第 1 道" etc. */
export function lanesText(lanes) {
  if (!lanes?.length || lanes.length < 2) return '';
  const valid = lanes.map((l, i) => (l.valid ? i + 1 : 0)).filter(Boolean);
  if (!valid.length || valid.length === lanes.length) return '';
  const n = lanes.length;
  let which;
  if (valid.length === 1) which = valid[0] === 1 ? '最左道' : valid[0] === n ? '最右道' : `左数第 ${valid[0]} 道`;
  else which = `左数第 ${valid.join('、')} 道`;
  return `地图车道数据：共 ${n} 道，可走${which}`;
}

/**
 * Big multi-lane interchange (e.g. the A14 junctions at Histon, Milton, Quy): the slip
 * roads leave at odd angles, so the clock rule says little — the lane arrows decide.
 */
export function isLargeRoundabout(rb) {
  if (!rb || rb.kind === 'mini') return false;
  return rb.kind === 'rotary' || (rb.radius ?? 0) > 45 || /interchange|gyratory/i.test(rb.name || '') || ((rb.toAt ?? 0) - (rb.fromAt ?? 0)) > 150;
}

export function roundaboutAdvice(rb) {
  const n = rb.exit;
  const large = isLargeRoundabout(rb);
  const kindZh = rb.kind === 'mini' ? '小环岛' : large ? '大型立交环岛' : '环岛';
  const head = large ? `${kindZh} · ${ordinalZh(n)}出口` : `${kindZh}${ordinalZh(n)}出口 · 约 ${rb.clock} 点钟方向（${DIR_ZH[rb.dir]}）`;
  const clockLine = large ? `${ordinalZh(n)}出口 · 按路牌和地面箭头选车道` : `约 ${rb.clock} 点钟方向 · ${DIR_ZH[rb.dir]}${rb.rule === 'right' ? ' · 走右道' : ' · 走左道'}`;
  const prev = n > 1 ? `经过第 ${n - 1} 出口后` : '';
  const lines = [];
  if (large) {
    lines.push(`多车道立交环岛：提前看蓝色路牌和地面箭头，选去第 ${n} 出口的车道；环岛内沿车道线走，不要随意变道。${n > 1 ? `${prev}打左灯` : '进环岛前打左灯'}，看左镜和左后盲区再驶出。`);
  } else if (rb.rule === 'first') {
    lines.push('走左车道进入，进环岛前打左灯；环岛内靠左行驶，左灯一直打到驶出。');
  } else if (rb.rule === 'right') {
    lines.push(`走右车道进入，进环岛前打右灯；环岛内保持在右道（内侧）。${prev}改打左灯，看左镜和左后盲区，然后驶出。`);
  } else {
    lines.push(`一般走左车道（以地面箭头和路牌为准），进环岛前不用打灯；${prev}打左灯驶出。`);
  }
  if (rb.kind === 'mini') lines.push('小环岛的打灯规则相同，但空间很小：不要压中间的白色圆圈；几个方向同时到达时，看清楚再判断谁先走。');
  if (rb.signalised) lines.push('入口有红绿灯：按灯通行，看清每条车道的箭头。');
  const lt = lanesText(rb.lanes);
  if (lt) lines.push(lt + '（以现场标线为准）。');
  lines.push('进入前看右侧来车，环岛内的车优先；有空档就果断进入。');
  if (rb.uncertain) lines.push(`⚠ 出口计数存疑（路网数据 ${rb.counted} vs 路由 ${n}），请对照视频确认。`);

  const signalEn = large
    ? `Follow the lane arrows for exit ${n}; ${n > 1 ? `after passing exit ${n - 1}, ` : ''}signal left to exit.`
    : rb.rule === 'first'
    ? 'Left lane, signal left on approach, keep signalling left to exit.'
    : rb.rule === 'right'
      ? `Right lane, signal right on approach; after passing exit ${n - 1}, signal left to exit.`
      : `Usually left lane (follow markings), no signal on approach; ${n > 1 ? `after passing exit ${n - 1}, ` : ''}signal left to exit.`;
  const en = `At the ${rb.kind === 'mini' ? 'mini-' : ''}roundabout, take the ${ordinalEn(n)} exit${rb.toRoad ? ` (${rb.toRoad})` : ''}. ${signalEn}`;
  return { head, clockLine, lines, en };
}
