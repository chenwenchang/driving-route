// OpenStreetMap context for a route via Overpass: tags of the ways and nodes the
// route runs over. Used to auto-detect speed-limit changes, crossings, bus/cycle
// lanes, roundabouts, etc.

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
});

/** Fetch tagged route nodes + all highway/railway ways touching the route. */
export async function fetchOsmContext(route, { signal, fetchImpl = fetch, onStatus } = {}) {
  const ids = [...new Set((route.nodes || []).filter((n) => Number.isSafeInteger(n) && n > 0))];
  if (!ids.length) throw new Error('路线缺少 OSM 节点数据（请重新计算路线）');
  // ways come with geometry so side roads can be placed left/right of the route
  const q = `[out:json][timeout:90];node(id:${ids.join(',')})->.r;node.r(if:count_tags()>0);out body;way(bn.r)[~"^(highway|railway)$"~"."];out geom;`;
  const body = 'data=' + encodeURIComponent(q);
  let lastErr;
  // first endpoint gets retries on rate-limit (429) / overload (504); mirrors are fallbacks
  const plan = [[OVERPASS_ENDPOINTS[0], 0], [OVERPASS_ENDPOINTS[0], 4000], [OVERPASS_ENDPOINTS[1], 0], [OVERPASS_ENDPOINTS[2], 0], [OVERPASS_ENDPOINTS[0], 12000]];
  for (const [ep, wait] of plan) {
    if (wait) { onStatus?.(`OSM 服务繁忙，${wait / 1000} 秒后重试…`); await sleep(wait, signal); }
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), 60000);
    try {
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
      // browsers send their own User-Agent; Node scripts must identify themselves
      if (typeof window === 'undefined') headers['User-Agent'] = 'driving-route/0.1 (personal study tool)';
      const res = await fetchImpl(ep, { method: 'POST', headers, body, signal: ctl.signal });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      return parseOverpass(await res.json());
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e.name === 'AbortError' ? new Error('Overpass 超时') : e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr || new Error('Overpass 不可用');
}

export function parseOverpass(j) {
  const nodes = new Map();
  const ways = new Map();
  for (const e of j.elements || []) {
    if (e.type === 'node') nodes.set(e.id, { id: e.id, lat: e.lat, lon: e.lon, tags: e.tags || {} });
    else if (e.type === 'way') {
      const geom = Array.isArray(e.geometry) ? e.geometry.map((g) => (g ? [g.lat, g.lon] : null)) : null;
      ways.set(e.id, { id: e.id, nodes: e.nodes || [], tags: e.tags || {}, geom });
    }
  }
  return { nodes, ways };
}

const NON_CAR = new Set(['footway', 'cycleway', 'path', 'pedestrian', 'steps', 'bridleway', 'bus_guideway', 'busway', 'corridor', 'platform']);
const pkey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Map each route segment (vertex i → i+1) to the OSM way it runs on.
 * @returns {{segs: ({way, fwd}|null)[], nodeWays: Map<number, object[]>}}
 */
export function buildSegments(route, ctx) {
  const nodes = route.nodes || [];
  const pair = new Map();
  const nodeWays = new Map();
  for (const w of ctx.ways.values()) {
    w.nodes.forEach((n, k) => {
      let arr = nodeWays.get(n);
      if (!arr) nodeWays.set(n, (arr = []));
      if (!arr.includes(w)) arr.push(w);
      if (k < w.nodes.length - 1) {
        const key = pkey(n, w.nodes[k + 1]);
        let c = pair.get(key);
        if (!c) pair.set(key, (c = []));
        c.push({ w, k });
      }
    });
  }
  const n = route.geometry.length;
  const segs = new Array(Math.max(0, n - 1)).fill(null);
  for (let i = 0; i < n - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    if (a == null || b == null || a === b) continue;
    const c = pair.get(pkey(a, b));
    if (!c?.length) continue;
    const best = c.find((x) => x.w.tags.highway && !NON_CAR.has(x.w.tags.highway)) || c.find((x) => x.w.tags.highway) || c[0];
    segs[i] = { way: best.w, fwd: best.w.nodes[best.k] === a };
  }
  // Fill gaps (virtual start/end points, node ids unknown to Overpass). A gap between
  // two segments of the same way belongs to that way; a gap at a transition between
  // ways is only a guess — it must not extend a roundabout run.
  const known = segs.map(Boolean);
  for (let i = 0; i < segs.length; i++) {
    if (known[i]) continue;
    let p = i - 1; while (p >= 0 && !known[p]) p--;
    let q = i + 1; while (q < segs.length && !known[q]) q++;
    const prev = p >= 0 ? segs[p] : null, next = q < segs.length ? segs[q] : null;
    const rb = (s) => ['roundabout', 'circular'].includes(s?.way?.tags?.junction);
    if (prev && next && (prev.way === next.way || (rb(prev) && rb(next)))) segs[i] = { ...prev };
    else if (prev || next) segs[i] = { ...(prev || next), guess: true };
  }
  return { segs, nodeWays };
}

// ---------- tag interpretation ----------
export function dirTag(tags, key, fwd) {
  return tags[`${key}:${fwd ? 'forward' : 'backward'}`] ?? tags[key];
}

/** maxspeed tag → mph (UK) or null */
export function parseMaxspeed(v) {
  if (v == null) return null;
  let s = String(v).trim().toLowerCase();
  if (s.includes(';')) s = s.split(';')[0].trim();
  if (/^(gb|uk):(nsl_dual|motorway)/.test(s)) return 70;
  if (/^(gb|uk):nsl_single/.test(s) || /^national/.test(s) || s === 'nsl') return 60;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*mph$/);
  if (m) return Math.round(+m[1]);
  m = s.match(/^(\d+(?:\.\d+)?)\s*(km\/h|kmh|kph)?$/);
  if (m) return Math.round(+m[1] / 1.609344);
  return null; // none / signals / walk / variable
}

export function segMaxspeed(seg) {
  return seg ? parseMaxspeed(dirTag(seg.way.tags, 'maxspeed', seg.fwd)) : null;
}

const CYCLE_YES = /^(lane|track|share_busway|separate)$/;
/** Cycle lane/track on the LEFT of the direction of travel. */
export function cycleLeft(seg) {
  if (!seg) return false;
  const t = seg.way.tags;
  const side = seg.fwd ? 'left' : 'right';
  return [t[`cycleway:${side}`], t['cycleway:both'], t.cycleway].some((v) => v && CYCLE_YES.test(v));
}

/** Bus lane on the LEFT of the direction of travel. */
export function busLeft(seg) {
  if (!seg) return false;
  const t = seg.way.tags;
  const side = seg.fwd ? 'left' : 'right';
  const dir = seg.fwd ? 'forward' : 'backward';
  if ([t[`busway:${side}`], t['busway:both'], t.busway].some((v) => v === 'lane')) return true;
  const bl = t[`bus:lanes:${dir}`] || t[`psv:lanes:${dir}`] || (t.oneway === 'yes' ? t['bus:lanes'] || t['psv:lanes'] : null);
  return !!bl && /designated|only/.test(bl.split('|')[0]);
}

export function isRoundaboutSeg(seg) {
  if (!seg || seg.guess) return false;
  const j = seg.way?.tags?.junction;
  return j === 'roundabout' || j === 'circular';
}

export function crossingKind(t) {
  const c = t.crossing || '';
  const ref = t.crossing_ref || '';
  if (ref === 'zebra' || c === 'zebra' || t['crossing:markings'] === 'zebra') return 'zebra';
  if (['pelican', 'puffin', 'toucan', 'pegasus'].includes(ref)) return ref;
  if (['pelican', 'puffin', 'toucan'].includes(c)) return c;
  if (c === 'traffic_signals') return 'signals';
  if (c === 'uncontrolled' || c === 'marked') return 'uncontrolled';
  if (c === 'unmarked' || c === 'no' || c === 'informal') return 'unmarked';
  return 'unknown';
}

/** Does a direction-tagged node (stop sign / signals) apply to our direction? */
export function appliesToDirection(dirValue, seg) {
  if (!dirValue || !seg) return true;
  if (dirValue === 'forward') return seg.fwd;
  if (dirValue === 'backward') return !seg.fwd;
  return true; // both / numeric bearings — keep
}
