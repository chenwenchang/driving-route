// Road-snapped routing through waypoints using OSRM (OpenStreetMap road network).
// Public demo servers — light personal use only.
import { cumulative, project, round6 } from './geo.js';

export const OSRM_ENDPOINTS = [
  'https://router.project-osrm.org/route/v1/driving/',
  'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
];

const QS = 'overview=full&geometries=geojson&steps=true&annotations=nodes,distance,duration&continue_straight=true';

/**
 * @param {{lat:number,lng:number}[]} points ordered waypoints (≥2)
 * @returns normalized route object stored in route.route
 */
export async function fetchRoute(points, { signal, fetchImpl = fetch } = {}) {
  if (!points || points.length < 2) throw new Error('至少需要两个途经点');
  const coords = points.map((p) => `${(+p.lng).toFixed(6)},${(+p.lat).toFixed(6)}`).join(';');
  let lastErr;
  for (const ep of OSRM_ENDPOINTS) {
    try {
      const res = await fetchImpl(`${ep}${coords}?${QS}`, { signal });
      if (!res.ok) throw new Error(`路由服务 HTTP ${res.status}`);
      const j = await res.json();
      if (j.code !== 'Ok') throw new Error(`路由失败：${j.code}${j.message ? ' ' + j.message : ''}`);
      return normalizeOsrm(j, ep);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('路由服务不可用');
}

function compactLanes(lanes) {
  if (!Array.isArray(lanes) || !lanes.length) return null;
  return lanes.map((l) => ({ ind: l.indications || [], valid: !!l.valid }));
}

function compactInt(x) {
  return {
    l: [round6(x.location[1]), round6(x.location[0])],
    b: x.bearings || [],
    e: (x.entry || []).map((v) => (v ? 1 : 0)),
    i: x.in ?? null,
    o: x.out ?? null,
    ...(x.lanes ? { lanes: compactLanes(x.lanes) } : {}),
  };
}

/** Convert an OSRM response into the compact structure we store. */
export function normalizeOsrm(j, engine = 'osrm') {
  const r = j.routes[0];
  const geometry = r.geometry.coordinates.map(([lng, lat]) => [round6(lat), round6(lng)]);
  const cum = cumulative(geometry);

  // OSM node ids aligned with geometry vertices; leg start vertex indices.
  let nodes = [];
  const legStarts = [];
  let segs = 0;
  r.legs.forEach((leg, li) => {
    legStarts.push(segs);
    const ns = leg.annotation?.nodes || [];
    nodes.push(...(li === 0 ? ns : ns.slice(1)));
    segs += (leg.annotation?.distance || []).length;
  });
  if (segs + 1 !== geometry.length || nodes.length !== geometry.length) {
    // Unexpected shape — fall back to projecting snapped waypoints.
    nodes = null;
    legStarts.length = 0;
    let from = 0;
    (j.waypoints || []).slice(0, -1).forEach((w) => {
      const p = project(geometry, cum, [w.location[1], w.location[0]], { from });
      legStarts.push(p ? p.index : 0);
      from = p ? p.at : from;
    });
  }

  const steps = [];
  const warnings = [];
  let acc = 0;
  const nLegs = r.legs.length;
  r.legs.forEach((leg, li) => {
    for (const s of leg.steps) {
      const m = s.maneuver;
      const via = (m.type === 'depart' && li > 0) || (m.type === 'arrive' && li < nLegs - 1);
      if (!via) {
        const loc = [round6(m.location[1]), round6(m.location[0])];
        const p = project(geometry, cum, loc, { atHint: acc, from: acc - 80, to: acc + s.distance + 80 });
        const at = p ? p.at : acc;
        const step = {
          type: m.type,
          mod: m.modifier || '',
          exit: m.exit ?? null,
          name: s.name || '',
          ref: s.ref || '',
          rotary: s.rotary_name || '',
          dest: s.destinations || '',
          loc,
          bb: m.bearing_before ?? null,
          ba: m.bearing_after ?? null,
          at: Math.round(at * 10) / 10,
          dist: Math.round(s.distance),
          dur: Math.round(s.duration),
          leg: li,
          ints: (s.intersections || []).map(compactInt),
        };
        const lanes = s.intersections?.[0]?.lanes;
        if (lanes) step.lanes = compactLanes(lanes);
        steps.push(step);
        if (m.modifier === 'uturn' && m.type !== 'depart' && m.type !== 'arrive') {
          warnings.push({ kind: 'uturn', loc, at: step.at, leg: li, msg: '路线在这里掉头，可能是途经点放在了路的另一侧或死路里' });
        }
      }
      acc += s.distance;
    }
  });

  return {
    engine: String(engine).includes('openstreetmap.de') ? 'osrm-fossgis' : 'osrm',
    computedAt: new Date().toISOString(),
    distance: Math.round(r.distance),
    duration: Math.round(r.duration),
    geometry,
    legStarts,
    nodes,
    steps,
    warnings,
  };
}
