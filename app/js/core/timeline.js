// Video time <-> distance-along-route mapping, anchored on waypoints that have
// a video timestamp. Linear interpolation by distance between anchors.
import { cumulative } from './geo.js';

export function buildTimeline(route, cum = null) {
  const r = route.route;
  const wps = route.waypoints || [];
  if (!r?.geometry?.length || !wps.length) return emptyTimeline();
  cum = cum || cumulative(r.geometry);
  const last = r.geometry.length - 1;
  const anchors = [];
  wps.forEach((w, k) => {
    if (w.t == null || !isFinite(w.t)) return;
    const idx = k < (r.legStarts?.length || 0) ? r.legStarts[k] : k === wps.length - 1 ? last : null;
    if (idx == null) return;
    anchors.push({ at: cum[Math.min(idx, last)], t: w.t });
  });
  // keep anchors strictly increasing in both distance and time
  anchors.sort((a, b) => a.at - b.at);
  const clean = [];
  for (const a of anchors) {
    const p = clean[clean.length - 1];
    if (!p || (a.at > p.at && a.t > p.t)) clean.push(a);
  }
  if (!clean.length) return emptyTimeline();

  const total = cum[cum.length - 1];
  return {
    anchors: clean,
    /** distance → video time (null outside anchored range unless extrapolate) */
    timeAt(at) {
      if (clean.length === 1) return Math.abs(at - clean[0].at) < 1 ? clean[0].t : null;
      if (at < clean[0].at || at > clean[clean.length - 1].at) return null;
      for (let k = 1; k < clean.length; k++) {
        const a = clean[k - 1], b = clean[k];
        if (at <= b.at) return a.t + ((at - a.at) / (b.at - a.at)) * (b.t - a.t);
      }
      return null;
    },
    /** video time → distance (clamped to anchored range) */
    atTime(t) {
      if (clean.length === 1) return clean[0].at;
      if (t <= clean[0].t) return clean[0].at;
      if (t >= clean[clean.length - 1].t) return Math.min(total, clean[clean.length - 1].at);
      for (let k = 1; k < clean.length; k++) {
        const a = clean[k - 1], b = clean[k];
        if (t <= b.t) return a.at + ((t - a.t) / (b.t - a.t)) * (b.at - a.at);
      }
      return null;
    },
    covers(t) { return clean.length > 1 && t >= clean[0].t - 5 && t <= clean[clean.length - 1].t + 5; },
  };
}

function emptyTimeline() {
  return { anchors: [], timeAt: () => null, atTime: () => null, covers: () => false };
}
