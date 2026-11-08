// The examiner's directions for a route, as they would be spoken on a mock test
// (English) with a Chinese gloss — a dry run of the voice guidance in examiner.js.
import { buildCuePlan, CueRunner, transcript } from './examiner.js';
import { cumulative, pointAt } from './geo.js';

export const ARROW = {
  left: '←', right: '→', 'slight left': '↖', 'slight right': '↗', 'sharp left': '↙', 'sharp right': '↘',
  straight: '↑', uturn: '↶', roundabout: '⟳', depart: '●', arrive: '◎', merge: '⤴', pull: 'P', ask: '?',
};

/** Arrow for a sat-nav line from a video ("After 300 yards, turn left" → ←). */
function scriptIcon(text) {
  const t = String(text).toLowerCase();
  if (/destination/.test(t)) return ARROW.arrive;
  if (/roundabout/.test(t)) return ARROW.roundabout;
  if (/take the exit|slip/.test(t)) return ARROW.merge;
  if (/keep left|bear left/.test(t)) return ARROW['slight left'];
  if (/keep right|bear right/.test(t)) return ARROW['slight right'];
  const first = t.match(/\b(left|right)\b/);
  if (first) return ARROW[first[1]];
  return ARROW.straight;
}

function iconFor(s) {
  if (s.kind === 'script') return s.who === 'satnav' ? scriptIcon(s.en) : '考';
  if (s.kind === 'open') return ARROW.depart;
  if (s.kind === 'arrive' || s.kind === 'end') return ARROW.arrive;
  if (s.kind === 'pullup' || s.kind === 'moveoff') return ARROW.pull;
  if (s.kind === 'showme' || s.kind === 'examiner') return ARROW.ask;
  const m = s.m;
  if (!m) return ARROW.straight;
  if (m.kind === 'rb' || m.kind === 'mini') return ARROW.roundabout;
  if (m.kind === 'slipOn' || m.kind === 'slipOff') return ARROW.merge;
  if (m.kind === 'fork') return m.side === 'left' ? ARROW['slight left'] : ARROW['slight right'];
  return ARROW[m.side] || ARROW.straight;
}

/**
 * What the examiner says along the route, in order.
 * keepMuted: also list directions the user muted (for the editor).
 * @returns {{at, sayAt, en, zh, icon, kind, key, auto, custom, muted, road, loc}[]}
 */
export function buildInstructions(route, { keepMuted = false, source = 'auto' } = {}) {
  const plan = buildCuePlan(route, { mode: 'mock', showMe: false, keepMuted, source });
  if (!plan) return [];
  const geom = route.route.geometry;
  const cum = cumulative(geom);
  // a video script is listed as recorded (a dry run would skip lines said while parked)
  const rows = plan.script
    ? plan.cues.filter((c) => c.kind === 'script').map((c) => ({ ...c, sayAt: c.at }))
    : transcript(plan).filter((s) => s.kind !== 'end' && s.kind !== 'moveoff');
  // directions with no room to be said (right after another junction) still get a row
  const said = new Set(rows.map((s) => s.id));
  const runner = new CueRunner(plan);
  for (const c of plan.cues) {
    if (c.kind !== 'dir' || said.has(c.id) || (c.chainedFrom && said.has(c.chainedFrom))) continue;
    const t = runner.dirText(c, 0);
    rows.push({ id: c.id, kind: 'dir', at: c.at, sayAt: null, en: c.custom || t.en, zh: `${t.zh}（离上一个路口太近，不会单独播报）`, key: c.key, m: c.m, auto: t.en, custom: !!c.custom, muted: c.muted, missed: true });
  }
  rows.sort((a, b) => (a.sayAt ?? a.at) - (b.sayAt ?? b.at));
  return rows
    .map((s) => ({
      at: s.at,
      sayAt: s.sayAt ?? null,
      missed: !!s.missed,
      en: s.en,
      zh: s.zh,
      icon: iconFor(s),
      kind: s.kind,
      key: s.key || null,
      auto: s.auto || null,
      custom: !!s.custom,
      muted: !!s.muted,
      road: s.m?.road || '',
      loc: s.m?.loc || pointAt(geom, cum, s.at),
      rb: s.m ? s.m.kind === 'rb' || s.m.kind === 'mini' : s.kind === 'script' && /roundabout/i.test(s.en),
      who: s.who || (s.kind === 'tip' || s.kind === 'coach' ? 'coach' : 'examiner'),
      t: s.t ?? null, // video time, for lines taken from the video
    }));
}
