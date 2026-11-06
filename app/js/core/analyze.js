// Auto-detection of attention points along a route (OSM + OSRM data), and
// merging fresh results with the user's existing annotations.
import { bearingAt, cumulative, pointAt, project, round6, segmentIndexAt } from './geo.js';
import { appliesToDirection, buildSegments, busLeft, crossingKind, cycleLeft, fetchOsmContext, segMaxspeed } from './osm.js';
import { collectIntersections, describeRoundabout, findRoundabouts, lanesText } from './roundabout.js';
import { TYPES, uid } from './model.js';

const NON_TURN = new Set(['depart', 'arrive', 'roundabout', 'rotary', 'roundabout turn', 'exit roundabout', 'exit rotary', 'notification']);

/** Fetch OSM context and detect features. Returns {annotations, osmError, stats}. */
export async function autoDetect(route, opts = {}) {
  const r = route.route;
  if (!r?.geometry?.length) throw new Error('请先生成路线');
  let ctx = null, seg = null, osmError = null;
  try {
    ctx = await fetchOsmContext(r, opts);
    seg = buildSegments(r, ctx);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    osmError = e.message || String(e);
  }
  const annotations = detectFeatures(r, ctx, seg);
  return { annotations, osmError };
}

export function detectFeatures(r, ctx, seg) {
  const geom = r.geometry;
  const cum = cumulative(geom);
  const nodeIds = r.nodes || [];
  const total = cum[cum.length - 1] || 0;
  const out = [];
  const vertexAt = (at) => { const i = segmentIndexAt(cum, at); return at - cum[i] > cum[i + 1] - at ? i + 1 : i; };
  const nodeKey = (at) => nodeIds[vertexAt(at)] ?? Math.round(at);
  const mk = (type, at, extra = {}) => {
    at = Math.max(0, Math.min(total, at));
    const p = pointAt(geom, cum, at);
    out.push({
      type, at: Math.round(at), lat: round6(p[0]), lng: round6(p[1]),
      bearing: Math.round(bearingAt(geom, cum, at)), level: TYPES[type].level,
      auto: true, confirmed: false, title: '', note: '', ...extra,
    });
  };

  // ---------- tagged nodes on the route ----------
  const signalAts = [];
  const miniIdx = [];
  const calm = [];
  if (ctx) {
    for (let i = 0; i < nodeIds.length; i++) {
      const n = ctx.nodes.get(nodeIds[i]);
      const at = cum[i];
      const sIn = seg?.segs[Math.max(0, i - 1)] || null;
      const ws = seg?.nodeWays.get(nodeIds[i]) || [];
      if (n) {
        const t = n.tags;
        if (t.highway === 'mini_roundabout') miniIdx.push(i);
        if (t.highway === 'traffic_signals' || t.crossing === 'traffic_signals') signalAts.push(at);
        const isCrossing = t.highway === 'crossing' || (t.highway === 'traffic_signals' && t.crossing && t.crossing !== 'no');
        if (isCrossing) {
          const k = crossingKind(t);
          if (k === 'zebra') {
            mk('crossing', at, { key: `node:${n.id}`, title: '斑马线', level: 2, note: '有行人在等或正在过必须停车让行；锯齿线区域内不能超车、不能停车。', osm: { crossing: k } });
          } else if (['pelican', 'puffin', 'toucan', 'pegasus', 'signals'].includes(k)) {
            const extra = { pelican: '黄灯闪烁时，有行人要让行，没人才可通过。', puffin: '没有闪黄灯阶段，绿灯也要看行人是否走完。', toucan: '行人和自行车共用的信号灯人行横道。', pegasus: '马匹通行的信号灯人行横道。', signals: '人行横道信号灯。' }[k];
            mk('crossing', at, { key: `node:${n.id}`, title: `信号灯人行横道${k !== 'signals' ? `（${k}）` : ''}`, level: 1, note: extra, osm: { crossing: k } });
          }
        } else if (t.highway === 'traffic_signals' && appliesToDirection(t['traffic_signals:direction'], sIn)) {
          mk('signals', at, { key: `node:${n.id}`, title: '红绿灯' });
        }
        if (t.highway === 'stop' && appliesToDirection(t.direction, sIn)) {
          mk('stop', at, { key: `node:${n.id}`, title: 'STOP 停车线', note: '必须在白线前完全停住（车轮停止），再观察、出路口。' });
        }
        if (t.traffic_calming && t.traffic_calming !== 'no') calm.push({ at, kind: t.traffic_calming, id: n.id });
        if (t.railway === 'level_crossing') {
          mk('rail', at, { key: `node:${n.id}`, title: '铁路道口', note: '看信号灯，红灯闪烁必须停车；不要停在轨道上。' });
        }
      }
      // crossing a busway / guided busway (shares a node with our road)
      const busWay = ws.find((w) => ['bus_guideway', 'busway'].includes(w.tags.highway));
      if (busWay && !['bus_guideway', 'busway'].includes(sIn?.way?.tags?.highway)) {
        mk('rail', at, { key: `bw:${nodeIds[i]}`, title: '巴士专用道路口', level: 2, note: '横穿巴士专用道（剑桥导轨巴士道）：看信号灯和让行标志，不要停在路口中间。' });
      }
    }
  }
  // group traffic calming features into runs
  for (let k = 0; k < calm.length;) {
    let j = k + 1;
    while (j < calm.length && calm[j].at - calm[j - 1].at < 150) j++;
    const group = calm.slice(k, j);
    const kinds = [...new Set(group.map((g) => g.kind))].join(', ');
    mk('calming', group[0].at, { key: `calm:${group[0].id}`, title: group.length > 1 ? `减速带 ×${group.length}` : '减速带', note: `类型：${kinds}${group.length > 1 ? `，约 ${Math.round(group[group.length - 1].at - group[0].at)} m 内` : ''}` });
    k = j;
  }

  // ---------- per-segment: speed limits & bus lanes ----------
  if (seg) {
    const runs = [];
    seg.segs.forEach((s, i) => {
      const v = segMaxspeed(s);
      const last = runs[runs.length - 1];
      if (last && last.v === v) last.to = cum[i + 1];
      else runs.push({ v, from: cum[i], to: cum[i + 1], i });
    });
    const merged = [];
    for (const run of runs) {
      const last = merged[merged.length - 1];
      if (run.v == null) { if (last) last.to = run.to; else merged.push({ ...run }); continue; }
      if (last && last.v == null) { last.v = run.v; last.to = run.to; continue; }
      if (last && last.v === run.v) { last.to = run.to; continue; }
      merged.push({ ...run });
    }
    for (let changed = true; changed;) {
      changed = false;
      for (let k = 1; k < merged.length; k++) {
        const m = merged[k];
        const short = m.to - m.from < 40;
        if (short && k < merged.length - 1 && merged[k - 1].v === merged[k + 1].v) {
          merged[k - 1].to = merged[k + 1].to; merged.splice(k, 2); changed = true; break;
        }
        if (short && k === merged.length - 1) { merged[k - 1].to = m.to; merged.splice(k, 1); changed = true; break; }
      }
    }
    merged.forEach((m, k) => {
      if (m.v == null) return;
      if (k === 0) {
        mk('speed', Math.min(m.from + 10, total), { key: 'speed:start', speed: m.v, level: 1, title: `起步路段限速 ${m.v} mph`, note: '出发后先确认当前限速。' });
        return;
      }
      const prev = merged[k - 1].v;
      if (prev == null || prev === m.v) return;
      const down = m.v < prev;
      mk('speed', m.from, {
        key: `speed:${nodeIds[m.i] ?? Math.round(m.from)}`, speed: m.v, prevSpeed: prev, level: 2,
        note: down ? `进入 ${m.v} mph 路段：提前松油减速，注意限速牌和路口。` : `限速提高到 ${m.v} mph：在安全前提下适当提速，开得过慢会被记 progress。`,
      });
    });

    // bus lanes on the left (runs ≥ 60 m)
    for (let i = 0; i < seg.segs.length;) {
      if (!busLeft(seg.segs[i])) { i++; continue; }
      let j = i;
      while (j < seg.segs.length && busLeft(seg.segs[j])) j++;
      if (cum[j] - cum[i] >= 60) {
        mk('bus', cum[i], { key: `bus:${nodeIds[i] ?? i}`, title: '左侧公交车道', note: `长约 ${Math.round(cum[j] - cum[i])} m。看蓝色标牌上的生效时间，生效期间不要驶入；左转时注意从公交车道上来的自行车。` });
      }
      i = j;
    }
  }

  // ---------- turns: cycle lanes / cycle-track crossings ----------
  const isCycleWay = (w) => w.tags.highway === 'cycleway' || (['path', 'footway'].includes(w.tags.highway) && w.tags.bicycle === 'designated');
  for (const s of r.steps || []) {
    if (NON_TURN.has(s.type)) continue;
    const left = /left/.test(s.mod), right = /right/.test(s.mod);
    if (!left && !right) continue;
    const reasons = [];
    if (seg) {
      if (left) {
        const i0 = segmentIndexAt(cum, Math.max(0, s.at - 40)), i1 = segmentIndexAt(cum, s.at);
        for (let i = i0; i <= i1; i++) if (cycleLeft(seg.segs[i])) { reasons.push('左侧有自行车道'); break; }
      }
      const v0 = vertexAt(Math.max(0, s.at - 3)), v1 = vertexAt(Math.min(total, s.at + 30));
      for (let v = v0; v <= v1; v++) {
        if ((seg.nodeWays.get(nodeIds[v]) || []).some(isCycleWay)) { reasons.push('转弯后横穿自行车道'); break; }
      }
    }
    if (!reasons.length) continue;
    if (left) {
      mk('cycle', s.at, { key: `cycle:${nodeKey(s.at)}`, title: `左转：${reasons.join('，')}`, level: 3, note: '左转前看左后视镜，再回头看左后盲区，让直行的自行车先走（H3）。不要刚超过自行车就左转。' });
    } else {
      mk('cycle', s.at, { key: `cycle:${nodeKey(s.at)}`, title: '右转：横穿自行车道', level: 2, note: '右转时会横穿自行车道：注意从两个方向来的自行车，让行（H3）。' });
    }
  }

  // ---------- steps: merges / slip roads / lane choice ----------
  for (const s of r.steps || []) {
    if (['merge', 'on ramp', 'off ramp'].includes(s.type)) {
      const join = s.type !== 'off ramp';
      mk('merge', s.at, {
        key: `merge:${nodeKey(s.at)}`, title: join ? `汇入${s.name || s.ref ? ' ' + (s.name || s.ref) : ''}` : '从匝道驶出',
        note: join ? '在加速车道上加速到接近主路车速，看右镜和右后盲区，找空档汇入。' : '提前看路牌，打左灯，进入减速车道后再减速。',
      });
    }
    if (!NON_TURN.has(s.type) && s.lanes) {
      const txt = lanesText(s.lanes);
      if (txt) mk('lane', Math.max(0, s.at - 30), { key: `lane:${nodeKey(s.at)}`, title: '车道选择', level: 2, lanes: s.lanes, note: `${txt}。提前看地面箭头，尽早并入正确车道（镜子 → 打灯 → 盲区 → 变道）。` });
    }
  }

  // ---------- roundabouts ----------
  const ints = collectIntersections(r, cum);
  const found = findRoundabouts(r, cum, { segs: seg?.segs || null, miniIdx });
  for (const f of found) {
    const rb = describeRoundabout(r, cum, ints, f, { segs: seg?.segs || null, signalAts });
    const entryVertex = f.fromIdx ?? vertexAt(f.fromAt);
    mk('roundabout', f.fromAt, {
      key: `rb:${nodeIds[entryVertex] ?? Math.round(f.fromAt)}`,
      level: 3, rb, title: '',
      note: '',
    });
  }

  // ---------- tidy: dedupe same-type points within 25 m (except speed) ----------
  out.sort((a, b) => a.at - b.at);
  const kept = [];
  for (const a of out) {
    const dup = kept.find((k) => k.type === a.type && a.type !== 'speed' && Math.abs(k.at - a.at) < 25);
    if (dup) { if ((a.level || 0) > (dup.level || 0)) Object.assign(dup, { ...a, key: dup.key }); continue; }
    kept.push(a);
  }
  return kept;
}

/**
 * Merge freshly detected auto annotations into the route's list.
 * Manual annotations are untouched; edited/confirmed autos keep the user's text;
 * dismissed keys (user deleted an auto point) are not re-added.
 */
export function mergeAuto(route, fresh) {
  const dismissed = new Set(route.dismissed || []);
  const existing = route.annotations || [];
  const byKey = new Map(existing.filter((a) => a.auto && a.key).map((a) => [a.key, a]));
  const result = existing.filter((a) => !a.auto || !a.key);
  let added = 0, updated = 0, removed = 0, kept = 0;
  for (const f of fresh) {
    if (dismissed.has(f.key)) continue;
    const old = byKey.get(f.key);
    if (old) {
      byKey.delete(f.key);
      if (old.edited) {
        result.push({ ...old, lat: f.lat, lng: f.lng, at: f.at, bearing: f.bearing, rb: old.rbEdited ? old.rb : f.rb ?? old.rb, stale: false });
      } else {
        result.push({ ...f, id: old.id, confirmed: !!old.confirmed, image: old.image, t: old.t });
      }
      updated++;
    } else {
      result.push({ ...f, id: uid('a') });
      added++;
    }
  }
  for (const old of byKey.values()) {
    if (old.edited || old.confirmed || old.image) { result.push({ ...old, stale: true }); kept++; }
    else removed++;
  }
  result.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return { annotations: result, added, updated, removed, kept };
}

/** After the route geometry changes, recompute `at`/`bearing` of every annotation. */
export function reproject(route) {
  const r = route.route;
  if (!r?.geometry?.length) return;
  const cum = cumulative(r.geometry);
  for (const a of route.annotations || []) {
    const p = project(r.geometry, cum, [a.lat, a.lng], { bearingHint: a.bearing ?? null, atHint: a.at ?? null });
    if (!p) continue;
    a.at = Math.round(p.at);
    a.offRoute = p.dist > 40;
    if (!a.offRoute) a.bearing = Math.round(bearingAt(r.geometry, cum, p.at));
  }
  route.annotations.sort((x, y) => (x.at ?? 0) - (y.at ?? 0));
}
