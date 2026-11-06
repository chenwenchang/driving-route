// Route data model, annotation type registry and small helpers.
// A route is one JSON document; see PLAN.md §5.

export const SCHEMA = 1;

export const CENTRE = {
  name: 'Cambridge (Brookmount Court)',
  address: 'Units A & B Brookmount Court, Kirkwood Road, Cambridge CB4 2QH',
  lat: 52.23335,
  lng: 0.13572,
};

/**
 * Annotation types. `key` = editor hotkey. Order = order in pickers/filters.
 * level: default importance 1 提示 / 2 注意 / 3 易错
 */
export const TYPES = {
  speed:      { zh: '限速',         en: 'Speed limit',              color: '#d32f2f', key: '1', level: 2 },
  roundabout: { zh: '环岛',         en: 'Roundabout',               color: '#1565c0', key: '2', level: 3 },
  cycle:      { zh: '自行车道/盲区', en: 'Cycle lane – blind spot',   color: '#2e7d32', key: '3', level: 3 },
  box:        { zh: '黄色网格',      en: 'Yellow box junction',      color: '#e0a800', key: '4', level: 3 },
  lane:       { zh: '车道/变道',     en: 'Lane choice / change',     color: '#7b1fa2', key: '5', level: 3 },
  crossing:   { zh: '人行横道',      en: 'Pedestrian crossing',      color: '#37474f', key: '6', level: 2 },
  junction:   { zh: '路口观察',      en: 'Junction observation',     color: '#e65100', key: '7', level: 2 },
  bus:        { zh: '公交车道',      en: 'Bus lane',                 color: '#c2185b', key: '8', level: 2 },
  hazard:     { zh: '危险/注意',     en: 'Hazard',                   color: '#ff6f00', key: '9', level: 2 },
  note:       { zh: '备注',         en: 'Note',                     color: '#546e7a', key: '0', level: 1 },
  signals:    { zh: '红绿灯',        en: 'Traffic lights',           color: '#00897b', level: 1 },
  stop:       { zh: 'STOP 停车线',   en: 'STOP junction',            color: '#b71c1c', level: 3 },
  calming:    { zh: '减速带',        en: 'Traffic calming',          color: '#8d6e63', level: 1 },
  school:     { zh: '学校',         en: 'School',                   color: '#f57c00', level: 2 },
  narrow:     { zh: '窄路/会车',     en: 'Narrow road / meeting',    color: '#6d4c41', level: 2 },
  merge:      { zh: '汇入/驶出',     en: 'Merge / slip road',        color: '#0277bd', level: 2 },
  rail:       { zh: '道口',         en: 'Level / busway crossing',  color: '#455a64', level: 3 },
  manoeuvre:  { zh: '考试动作',      en: 'Manoeuvre',                color: '#283593', level: 2 },
  mistake:    { zh: '我的错误',      en: 'My mistake',               color: '#d50000', level: 3 },
};
export const TYPE_KEYS = Object.keys(TYPES);

export const LEVELS = {
  1: { zh: '提示', color: '#78909c' },
  2: { zh: '注意', color: '#fb8c00' },
  3: { zh: '易错', color: '#e53935' },
};

export const nowIso = () => new Date().toISOString();

export function uid(prefix = 'x') {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newRoute(name = '新路线') {
  const t = nowIso();
  return {
    schema: SCHEMA,
    id: uid('r'),
    name,
    centre: CENTRE.name,
    createdAt: t,
    updatedAt: t,
    video: { youtubeId: '', url: '', title: '', start: null },
    notes: '',
    waypoints: [],
    route: null,
    annotations: [],
    mistakes: [],
  };
}

/** Fill defaults / migrate older documents in place and return it. */
export function normalizeRoute(r) {
  if (!r || typeof r !== 'object') throw new Error('不是有效的路线数据');
  r.schema ??= SCHEMA;
  r.id ??= uid('r');
  r.name ??= '未命名路线';
  r.video ??= { youtubeId: '', url: '', title: '', start: null };
  r.waypoints ??= [];
  r.annotations ??= [];
  r.mistakes ??= [];
  r.notes ??= '';
  for (const a of r.annotations) {
    a.id ??= uid('a');
    if (!TYPES[a.type]) a.type = 'note';
    a.level ??= TYPES[a.type].level;
  }
  return r;
}

export function defaultTitle(a) {
  const T = TYPES[a.type] || TYPES.note;
  if (a.type === 'speed' && a.speed) return a.prevSpeed ? `限速 ${a.prevSpeed} → ${a.speed} mph` : `限速 ${a.speed} mph`;
  if (a.type === 'roundabout' && a.rb?.exit) return `${a.rb.kind === 'mini' ? '小环岛' : '环岛'} 第${a.rb.exit}出口`;
  return T.zh;
}

export const titleOf = (a) => (a.title && a.title.trim()) || defaultTitle(a);

export function summarize(r) {
  const counts = {};
  for (const a of r.annotations || []) counts[a.type] = (counts[a.type] || 0) + 1;
  const thumb = (r.annotations || []).find((a) => a.image && !a.image.startsWith('data:'))?.image || null;
  return {
    id: r.id,
    name: r.name,
    distance: r.route?.distance ?? null,
    duration: r.route?.duration ?? null,
    counts,
    hot: (r.annotations || []).filter((a) => (a.level ?? 1) >= 3).length,
    total: (r.annotations || []).length,
    youtubeId: r.video?.youtubeId || '',
    updatedAt: r.updatedAt || r.createdAt || null,
    demo: !!r.demo,
    thumb,
  };
}

export function parseYouTubeId(input) {
  if (!input) return '';
  const s = String(input).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1, 12);
    if (u.searchParams.get('v')) return u.searchParams.get('v').slice(0, 11);
    const m = u.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/);
    if (m) return m[2];
  } catch { /* not a URL */ }
  const m = s.match(/([\w-]{11})/);
  return m ? m[1] : '';
}

/** Parse "t=1m23s" / "t=83" from a YouTube URL. */
export function parseYouTubeStart(input) {
  try {
    const t = new URL(String(input)).searchParams.get('t');
    if (!t) return null;
    if (/^\d+$/.test(t)) return Number(t);
    const m = t.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : null;
  } catch { return null; }
}

// ---------- outbound links (no API keys needed) ----------
export function streetViewUrl(lat, lng, heading = 0) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lng.toFixed(6)}&heading=${Math.round(heading)}&pitch=0&fov=90`;
}

export function youtubeUrl(id, t) {
  if (!id) return '';
  return t != null && isFinite(t) ? `https://youtu.be/${id}?t=${Math.max(0, Math.floor(t))}` : `https://youtu.be/${id}`;
}

export function mapsPointUrl(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/** Image path stored in a route → URL usable in <img src>. */
export function imageSrc(img) {
  if (!img) return '';
  return img;
}
