// Geometry helpers. Points are [lat, lng] arrays (Leaflet order) unless noted.
// Pure functions — usable in the browser and in Node tests.

const R = 6371008.8; // mean Earth radius (m)
const RAD = Math.PI / 180;
const M_PER_DEG = R * RAD; // metres per degree of latitude

export const norm360 = (a) => ((a % 360) + 360) % 360;

/** Signed smallest difference `to - from` in degrees, range (-180, 180]. */
export function angleDiff(to, from) {
  let d = norm360(to - from);
  if (d > 180) d -= 360;
  return d;
}

export function haversine(a, b) {
  const dLat = (b[0] - a[0]) * RAD;
  const dLng = (b[1] - a[1]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing a → b, degrees clockwise from north [0, 360). */
export function bearing(a, b) {
  const f1 = a[0] * RAD, f2 = b[0] * RAD, dl = (b[1] - a[1]) * RAD;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return norm360(Math.atan2(y, x) / RAD);
}

/** Point reached from p travelling `dist` metres on `brg` (good enough for < 1 km). */
export function offset(p, brg, dist) {
  const dy = Math.cos(brg * RAD) * dist;
  const dx = Math.sin(brg * RAD) * dist;
  return [p[0] + dy / M_PER_DEG, p[1] + dx / (M_PER_DEG * Math.cos(p[0] * RAD))];
}

/** Cumulative distance (m) at every vertex of a polyline. */
export function cumulative(geom) {
  const cum = new Array(geom.length).fill(0);
  for (let i = 1; i < geom.length; i++) cum[i] = cum[i - 1] + haversine(geom[i - 1], geom[i]);
  return cum;
}

/** Index of the segment containing distance `at` (binary search). */
export function segmentIndexAt(cum, at) {
  if (at <= 0) return 0;
  const last = cum.length - 2;
  if (at >= cum[cum.length - 1]) return Math.max(0, last);
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= at) lo = mid; else hi = mid;
  }
  return Math.min(lo, last);
}

/** Point at distance `at` along the polyline. */
export function pointAt(geom, cum, at) {
  if (!geom.length) return null;
  if (geom.length === 1) return geom[0].slice();
  const i = segmentIndexAt(cum, at);
  const segLen = cum[i + 1] - cum[i];
  const t = segLen > 0 ? Math.min(1, Math.max(0, (at - cum[i]) / segLen)) : 0;
  const a = geom[i], b = geom[i + 1];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Direction of travel around distance `at` (looks `span` m back and ahead). */
export function bearingAt(geom, cum, at, span = 8) {
  const total = cum[cum.length - 1] || 0;
  let a0 = Math.max(0, at - span), a1 = Math.min(total, at + span);
  if (a1 - a0 < 1) { a0 = Math.max(0, a1 - 2); }
  const p0 = pointAt(geom, cum, a0), p1 = pointAt(geom, cum, a1);
  if (!p0 || !p1 || (p0[0] === p1[0] && p0[1] === p1[1])) return 0;
  return bearing(p0, p1);
}

/**
 * Project point p onto the polyline.
 * opts.bearingHint: prefer segments heading roughly this way (handles roads driven twice).
 * opts.atHint: prefer positions close to this distance along the route.
 * opts.from/opts.to: restrict the search to a distance window.
 */
export function project(geom, cum, p, opts = {}) {
  const { bearingHint = null, atHint = null, from = -Infinity, to = Infinity } = opts;
  if (geom.length < 2) return geom.length ? { index: 0, t: 0, dist: haversine(geom[0], p), at: 0, point: geom[0].slice() } : null;
  const kx = Math.cos(p[0] * RAD) * M_PER_DEG, ky = M_PER_DEG;
  let best = null;
  for (let i = 0; i < geom.length - 1; i++) {
    if (cum[i + 1] < from || cum[i] > to) continue;
    const a = geom[i], b = geom[i + 1];
    const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
    const dx = (b[1] - a[1]) * kx, dy = (b[0] - a[0]) * ky;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    const at = cum[i] + t * (cum[i + 1] - cum[i]);
    let score = d;
    if (bearingHint != null && len2 > 0) {
      const segB = norm360(Math.atan2(dx, dy) / RAD);
      if (Math.abs(angleDiff(segB, bearingHint)) > 100) score += 60;
    }
    if (atHint != null) score += Math.abs(at - atHint) * 0.02;
    if (!best || score < best.score) best = { index: i, t, dist: d, at, score };
  }
  if (!best) return null;
  const a = geom[best.index], b = geom[best.index + 1];
  best.point = [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t];
  return best;
}

/** Sub-polyline between two distances. */
export function slice(geom, cum, from, to) {
  if (geom.length < 2 || to <= from) return [];
  const out = [pointAt(geom, cum, from)];
  for (let i = 0; i < geom.length; i++) if (cum[i] > from && cum[i] < to) out.push(geom[i]);
  out.push(pointAt(geom, cum, to));
  return out;
}

/** Douglas–Peucker simplification (tolerance in metres). Returns points. */
export function simplify(geom, tolerance = 2) {
  if (geom.length <= 2) return geom.slice();
  const lat0 = geom[0][0];
  const kx = Math.cos(lat0 * RAD) * M_PER_DEG, ky = M_PER_DEG;
  const xy = geom.map((p) => [p[1] * kx, p[0] * ky]);
  const keep = new Uint8Array(geom.length);
  keep[0] = keep[geom.length - 1] = 1;
  const stack = [[0, geom.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    const [x1, y1] = xy[s], [x2, y2] = xy[e];
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const [x, y] = xy[i];
      let t = len2 > 0 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolerance && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return geom.filter((_, i) => keep[i]);
}

/**
 * Least-squares circle fit (Kåsa) of [lat,lng] points.
 * Returns {c:[lat,lng], r (m), rms (m), span (deg swept, signed: + = clockwise)} or null.
 */
export function fitCircle(points) {
  if (!points || points.length < 3) return null;
  const lat0 = points[0][0], lng0 = points[0][1];
  const kx = Math.cos(lat0 * RAD) * M_PER_DEG, ky = M_PER_DEG;
  const xy = points.map((p) => [(p[1] - lng0) * kx, (p[0] - lat0) * ky]);
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  const n = xy.length;
  for (const [x, y] of xy) {
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
  }
  // Solve [sxx sxy sx; sxy syy sy; sx sy n] [a b c]' = -[sxz syz sz]'
  const A = [[sxx, sxy, sx, -sxz], [sxy, syy, sy, -syz], [sx, sy, n, -sz]];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-9) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let k = col; k < 4; k++) A[r][k] -= f * A[col][k];
    }
  }
  const a = A[0][3] / A[0][0], b = A[1][3] / A[1][1], c = A[2][3] / A[2][2];
  const cx = -a / 2, cy = -b / 2;
  const r2 = cx * cx + cy * cy - c;
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  let ss = 0;
  for (const [x, y] of xy) ss += (Math.hypot(x - cx, y - cy) - r) ** 2;
  // swept angle along the points (bearing from centre, clockwise positive)
  let span = 0;
  let prev = norm360(Math.atan2(xy[0][0] - cx, xy[0][1] - cy) / RAD);
  for (let i = 1; i < n; i++) {
    const cur = norm360(Math.atan2(xy[i][0] - cx, xy[i][1] - cy) / RAD);
    span += angleDiff(cur, prev);
    prev = cur;
  }
  return { c: [lat0 + cy / ky, lng0 + cx / kx], r, rms: Math.sqrt(ss / n), span };
}

/** Resample a polyline every `step` metres (keeps endpoints). */
export function densify(points, step = 3) {
  if (points.length < 2) return points.slice();
  const cum = cumulative(points);
  const total = cum[cum.length - 1];
  const out = [];
  for (let at = 0; at < total; at += step) out.push(pointAt(points, cum, at));
  out.push(points[points.length - 1]);
  return out;
}

export function bbox(points) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of points) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); }
  return [[s, w], [n, e]];
}

export const round6 = (x) => Math.round(x * 1e6) / 1e6;

// ---------- formatting ----------
export function fmtDist(m) {
  if (m == null || !isFinite(m)) return '–';
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} km`;
}

export function fmtDuration(s) {
  if (s == null || !isFinite(s)) return '–';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

/** Video timestamp mm:ss or h:mm:ss */
export function fmtTime(t) {
  if (t == null || !isFinite(t)) return '';
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Parse "1:23", "01:02:03", "83" → seconds */
export function parseTime(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some((x) => !isFinite(x))) return null;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}
