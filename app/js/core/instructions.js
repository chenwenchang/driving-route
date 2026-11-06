// Examiner-style turn-by-turn instructions (English, as heard on test) + Chinese.
import { ordinalEn, ordinalZh } from './roundabout.js';

const RB = new Set(['roundabout', 'rotary', 'roundabout turn']);

const MOD_ZH = {
  left: '左转', right: '右转', 'slight left': '稍向左', 'slight right': '稍向右',
  'sharp left': '急左转', 'sharp right': '急右转', straight: '直行', uturn: '掉头',
};
const MOD_EN = {
  left: 'turn left', right: 'turn right', 'slight left': 'bear left', 'slight right': 'bear right',
  'sharp left': 'turn sharp left', 'sharp right': 'turn sharp right', straight: 'go straight on', uturn: 'turn around',
};
export const ARROW = {
  left: '←', right: '→', 'slight left': '↖', 'slight right': '↗', 'sharp left': '↙', 'sharp right': '↘',
  straight: '↑', uturn: '↶', roundabout: '⟳', depart: '●', arrive: '◎', merge: '⤴',
};

const onto = (s) => (s.name || s.ref ? (s.name || s.ref) : '');

export function buildInstructions(route) {
  const r = route.route;
  if (!r?.steps) return [];
  const rbs = (route.annotations || []).filter((a) => a.type === 'roundabout' && a.rb);
  const list = [];
  const used = new Set();
  for (const s of r.steps) {
    const road = onto(s);
    let en = '', zh = '', icon = ARROW[s.mod] || '↑';
    if (s.type === 'exit roundabout' || s.type === 'exit rotary' || s.type === 'notification') continue;
    if ((s.type === 'new name' || s.type === 'continue') && (!s.mod || s.mod === 'straight')) continue;
    if (s.type === 'depart') { en = 'Drive out of the test centre when ready.'; zh = '从考场出发'; icon = ARROW.depart; }
    else if (s.type === 'arrive') { en = 'Pull up / return to the test centre.'; zh = '到达终点'; icon = ARROW.arrive; }
    else if (RB.has(s.type)) {
      const a = rbs.find((x) => Math.abs(x.at - s.at) < 40);
      if (a) used.add(a);
      const n = a?.rb?.exit || s.exit || 1;
      const mini = a?.rb?.kind === 'mini';
      en = `At the ${mini ? 'mini-' : ''}roundabout, take the ${ordinalEn(n)} exit${road ? ` (${road})` : ''}.`;
      zh = `${mini ? '小环岛' : '环岛'}${ordinalZh(n)}出口${road ? ` → ${road}` : ''}`;
      icon = ARROW.roundabout;
    } else if (s.type === 'end of road') {
      en = `At the end of the road, ${MOD_EN[s.mod] || 'turn'}${road ? ` (${road})` : ''}.`;
      zh = `路尽头${MOD_ZH[s.mod] || '转弯'}${road ? ` → ${road}` : ''}`;
    } else if (s.type === 'fork') {
      const side = /left/.test(s.mod) ? 'left' : 'right';
      en = `Keep ${side}${road ? ` (${road})` : ''}.`;
      zh = `岔路靠${side === 'left' ? '左' : '右'}${road ? ` → ${road}` : ''}`;
    } else if (s.type === 'merge') {
      en = `Merge${road ? ` onto ${road}` : ''}.`; zh = `汇入${road ? ` ${road}` : ''}`; icon = ARROW.merge;
    } else if (s.type === 'on ramp') {
      en = `Take the slip road${road ? ` onto ${road}` : ''}.`; zh = `从匝道驶入${road ? ` ${road}` : ''}`; icon = ARROW.merge;
    } else if (s.type === 'off ramp') {
      en = 'Take the slip road to leave.'; zh = '从匝道驶出';
    } else {
      en = `${cap(MOD_EN[s.mod] || 'continue')}${road ? ` onto ${road}` : ''}.`;
      zh = `${MOD_ZH[s.mod] || '继续'}${road ? ` → ${road}` : ''}`;
    }
    list.push({ at: s.at, en, zh, icon, road, type: s.type, mod: s.mod, loc: s.loc });
  }
  // mini-roundabouts (OSM) without an OSRM roundabout step
  for (const a of rbs) {
    if (used.has(a) || list.some((x) => x.icon === ARROW.roundabout && Math.abs(x.at - a.at) < 40)) continue;
    const n = a.rb.exit || 1;
    const mini = a.rb.kind === 'mini';
    list.push({
      at: a.at, icon: ARROW.roundabout, road: a.rb.toRoad || '', type: 'roundabout', mod: '', loc: [a.lat, a.lng],
      en: `At the ${mini ? 'mini-' : ''}roundabout, take the ${ordinalEn(n)} exit.`,
      zh: `${mini ? '小环岛' : '环岛'}${ordinalZh(n)}出口`,
    });
  }
  list.sort((a, b) => a.at - b.at);
  return list;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
