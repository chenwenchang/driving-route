// Exports: Google Maps navigation links (split into parts), GPX (OsmAnd etc.),
// KML (Google My Maps), GeoJSON, and route packs (backup / transfer to phone).
import { cumulative, fmtTime, pointAt, simplify } from './geo.js';
import { TYPES, LEVELS, titleOf, youtubeUrl, streetViewUrl } from './model.js';
import { roundaboutAdvice, lanesText } from './roundabout.js';

const xmlEsc = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const ll6 = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;

/** Plain-text description of an annotation (used by KML/GPX and sharing). */
export function describe(a, route) {
  const T = TYPES[a.type] || TYPES.note;
  const lines = [`[${T.zh}·${LEVELS[a.level || 1]?.zh || ''}] ${titleOf(a)}`];
  if (a.rb) {
    const adv = roundaboutAdvice(a.rb);
    lines.push(adv.head, ...adv.lines, adv.en);
  }
  if (a.lanes) { const t = lanesText(a.lanes); if (t) lines.push(t); }
  if (a.note) lines.push(a.note);
  const vid = route?.video?.youtubeId;
  if (vid && a.t != null) lines.push(`视频 ${fmtTime(a.t)}: ${youtubeUrl(vid, a.t)}`);
  lines.push(`街景: ${streetViewUrl(a.lat, a.lng, a.bearing || 0)}`);
  return lines.join('\n');
}

/** Short phrase for navigation-app voice prompts. */
export function spoken(a, lang = 'zh') {
  if (lang === 'en') {
    if (a.say?.trim()) return a.say.trim();
    if (a.type === 'speed' && a.speed) return `Speed limit ${a.speed}`;
    if (a.type === 'roundabout' && a.rb) {
      const lane = a.rb.rule === 'right' ? 'right lane' : 'left lane';
      return `Roundabout, exit ${a.rb.exit}, ${lane}`;
    }
    if (a.type === 'cycle') return 'Cycle lane, check blind spot';
    return (a.title && /^[\x20-\x7e]+$/.test(a.title)) ? a.title : TYPES[a.type]?.en || 'Attention';
  }
  if (a.type === 'speed' && a.speed) return `限速${a.speed}`;
  if (a.type === 'roundabout' && a.rb) return `环岛第${a.rb.exit}出口，${a.rb.rule === 'right' ? '走右道' : '走左道'}`;
  if (a.type === 'cycle') return /右转/.test(a.title || '') ? '右转注意自行车' : '左转看左后盲区';
  return titleOf(a).slice(0, 24);
}

// ---------------- Google Maps ----------------
/**
 * Split the route into Google-Maps-sized parts (≤ perPart intermediate waypoints each).
 * mode 'waypoints' = the waypoints you clicked (fewer parts);
 * mode 'turns' = every turn / roundabout (most faithful, more parts).
 * Shaping points are moved ~35 m past each junction so Google snaps onto the right road.
 */
export function googleMapsParts(route, { mode = 'waypoints', perPart = 9 } = {}) {
  const r = route.route;
  if (!r?.geometry?.length) return [];
  const geom = r.geometry;
  const cum = cumulative(geom);
  const total = cum[cum.length - 1];
  let ats;
  if (mode === 'turns') {
    ats = (r.steps || [])
      .filter((s) => !['depart', 'arrive', 'exit roundabout', 'exit rotary', 'new name', 'notification'].includes(s.type) && !(s.type === 'continue' && (!s.mod || s.mod === 'straight')))
      .map((s) => s.at);
  } else {
    ats = (r.legStarts || []).slice(1).map((i) => cum[i]);
  }
  ats = ats.map((a) => Math.min(total - 10, a + 35)).filter((a) => a > 30).sort((x, y) => x - y);
  const pts = [0];
  for (const a of ats) if (a - pts[pts.length - 1] > 60) pts.push(a);
  if (total - pts[pts.length - 1] < 40) pts.pop();
  pts.push(total);
  const at2 = (at) => ll6(pointAt(geom, cum, at));
  const parts = [];
  for (let k = 0; k < pts.length - 1;) {
    const end = Math.min(k + perPart + 1, pts.length - 1);
    const wps = pts.slice(k + 1, end);
    let url = `https://www.google.com/maps/dir/?api=1&origin=${at2(pts[k])}&destination=${at2(pts[end])}&travelmode=driving&dir_action=navigate`;
    if (wps.length) url += `&waypoints=${wps.map(at2).join('%7C')}`;
    parts.push({ index: parts.length + 1, from: pts[k], to: pts[end], waypoints: wps.length, url });
    k = end;
  }
  return parts;
}

// ---------------- GPX ----------------
export function toGPX(route, { lang = 'zh', minLevel = 1 } = {}) {
  const r = route.route;
  const name = xmlEsc(route.name);
  const wpts = (route.annotations || [])
    .filter((a) => (a.level || 1) >= minLevel)
    .map((a) => `  <wpt lat="${a.lat.toFixed(6)}" lon="${a.lng.toFixed(6)}">\n    <name>${xmlEsc(spoken(a, lang))}</name>\n    <desc>${xmlEsc(describe(a, route))}</desc>\n    <type>${xmlEsc(TYPES[a.type]?.en || a.type)}</type>\n  </wpt>`)
    .join('\n');
  const trkpts = (r?.geometry || []).map((p) => `      <trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="driving-route" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${name}</name><desc>${xmlEsc(route.notes || '')}</desc></metadata>
${wpts}
  <trk>
    <name>${name}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

// ---------------- KML (Google My Maps) ----------------
const kmlColor = (hex, alpha = 'ff') => {
  const h = hex.replace('#', '');
  return `${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
};

export function toKML(route, { minLevel = 1, imageBase = '' } = {}) {
  const r = route.route;
  const geom = r ? simplify(r.geometry, 1.5) : [];
  const styles = Object.entries(TYPES).map(([k, T]) => `    <Style id="t-${k}"><IconStyle><color>${kmlColor(T.color)}</color><scale>1.1</scale><Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>`).join('\n');
  const pms = (route.annotations || []).filter((a) => (a.level || 1) >= minLevel).map((a) => {
    const T = TYPES[a.type] || TYPES.note;
    const media = imageBase && a.image && !a.image.startsWith('data:') ? `\n        <Data name="gx_media_links"><value>${xmlEsc(imageBase.replace(/\/?$/, '/') + a.image)}</value></Data>` : '';
    return `    <Placemark>
      <name>${xmlEsc(`${T.zh}｜${titleOf(a)}`)}</name>
      <description>${xmlEsc(describe(a, route))}</description>
      <styleUrl>#t-${a.type}</styleUrl>
      <ExtendedData>
        <Data name="类型"><value>${xmlEsc(T.zh)}</value></Data>
        <Data name="重要度"><value>${xmlEsc(LEVELS[a.level || 1]?.zh || '')}</value></Data>${a.t != null ? `\n        <Data name="视频时间"><value>${fmtTime(a.t)}</value></Data>` : ''}${media}
      </ExtendedData>
      <Point><coordinates>${a.lng.toFixed(6)},${a.lat.toFixed(6)},0</coordinates></Point>
    </Placemark>`;
  }).join('\n');
  const line = geom.length ? `    <Placemark>
      <name>${xmlEsc(route.name)}（路线）</name>
      <styleUrl>#route</styleUrl>
      <LineString><tessellate>1</tessellate><coordinates>
${geom.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)},0`).join('\n')}
      </coordinates></LineString>
    </Placemark>` : '';
  const start = geom[0], end = geom[geom.length - 1];
  const se = start ? `    <Placemark><name>起点</name><Point><coordinates>${start[1].toFixed(6)},${start[0].toFixed(6)},0</coordinates></Point></Placemark>
    <Placemark><name>终点</name><Point><coordinates>${end[1].toFixed(6)},${end[0].toFixed(6)},0</coordinates></Point></Placemark>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xmlEsc(route.name)}</name>
    <description>${xmlEsc(route.notes || '')}</description>
    <Style id="route"><LineStyle><color>${kmlColor('#1e6fd9')}</color><width>5</width></LineStyle></Style>
${styles}
${line}
${se}
${pms}
  </Document>
</kml>
`;
}

// ---------------- GeoJSON ----------------
export function toGeoJSON(route) {
  const r = route.route;
  const features = [];
  if (r?.geometry?.length) features.push({ type: 'Feature', properties: { name: route.name, kind: 'route' }, geometry: { type: 'LineString', coordinates: r.geometry.map((p) => [p[1], p[0]]) } });
  for (const a of route.annotations || []) {
    const { lat, lng, image, ...props } = a;
    features.push({ type: 'Feature', properties: { ...props, title: titleOf(a) }, geometry: { type: 'Point', coordinates: [lng, lat] } });
  }
  return { type: 'FeatureCollection', features };
}

// ---------------- route packs ----------------
export const PACK_FORMAT = 'driving-route-pack';

export function makePack(routes) {
  return { format: PACK_FORMAT, version: 1, exportedAt: new Date().toISOString(), routes };
}

export function parsePack(obj) {
  if (obj?.format === PACK_FORMAT && Array.isArray(obj.routes)) return obj.routes;
  if (obj?.schema && obj?.id) return [obj];
  throw new Error('不是路线包或路线文件');
}

export const safeFileName = (s) => String(s || 'route').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'route';
