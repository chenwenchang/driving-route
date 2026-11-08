// Short Chinese gloss for the sat-nav / examiner lines from the videos, shown under the
// English subtitle ("After 300 yards, turn left, Northfield Avenue" → "300 码后左转 Northfield Avenue").
// Rule-based: covers the phrases TomTom and examiners actually use; anything else stays English-only.

const ORD = { first: '第一', second: '第二', third: '第三', fourth: '第四', fifth: '第五', next: '下一个' };
const SIDE = { left: '左', right: '右' };
const tail = (road) => {
  const r = String(road || '').replace(/,?\s*please\b,?/gi, '').replace(/^,?\s*(onto|to)\s+/i, '').trim();
  if (!r) return '';
  return ` ${r.replace(/,?\s*towards\s+(.+)$/i, ' 往 $1 方向').replace(/^,\s*/, '').trim()}`;
};

const RULES = [
  [/(?:at the )?second set of traffic lights,? turn (left|right)|turn (left|right) at the second set of traffic lights/i, (m, a, b) => `第二个红绿灯${SIDE[(a || b).toLowerCase()]}转`],
  [/^(?:at the end of the road,? )?turn (left|right)(?:,? please)?(?:,? (?:on|at) the next road)?$/i, (m, s) => (/end of the road/i.test(m) ? `路尽头${SIDE[s]}转` : /next road/i.test(m) ? `下一个路口${SIDE[s]}转` : `${SIDE[s]}转`)],
  [/^at the end of the road,? turn (left|right),? (.+)$/i, (m, s, r) => `路尽头${SIDE[s]}转${tail(r)}`],
  [/^turn (left|right),? (.+)$/i, (m, s, r) => (/next road|test cent/i.test(r) ? `${SIDE[s]}转（${/test cent/i.test(r) ? '进考场' : '下一个路口'}）` : `${SIDE[s]}转${tail(r)}`)],
  [/^(?:go (left|right) on|cross) the roundabout and take the (\w+) exit,?(.*)$/i, (m, s, n, r) => `环岛${ORD[n.toLowerCase()] || n}出口${s ? `（${SIDE[s.toLowerCase()]}转方向）` : '（直行方向）'}${tail(r)}`],
  [/^at the (?:next )?roundabout,? take the (\w+) exit,?(.*)$/i, (m, n, r) => `环岛${ORD[n.toLowerCase()] || n}出口${tail(r.replace(/,? please$/i, ''))}`],
  [/^take the exit,? (\d+),?(.*)$/i, (m, n, r) => `走 ${n} 号出口${tail(r)}`],
  [/^take the exit,? junction (\d+)(.*)$/i, (m, n) => `走 ${n} 号出口`],
  [/^take the exit,?(.*)$/i, (m, r) => `走出口${tail(r)}`],
  [/^keep (left|right)$/i, (m, s) => `靠${SIDE[s.toLowerCase()]}`],
  [/^bear (left|right)(?: onto)?,?(.*)$/i, (m, s, r) => `稍向${SIDE[s.toLowerCase()]}${tail(r)}`],
  [/^go straight on,?(.*)$/i, (m, r) => `直行${tail(r)}`],
  [/^follow (?:the )?(\w+) towards (.+?) for ([\d.]+) miles$/i, (m, a, b, n) => `沿 ${a} 往 ${b} 方向开 ${n} 英里`],
  [/^(?:then )?you have reached your destination(.*)$/i, () => '到达导航目的地'],
  [/^take the (next|second|third) (?:road )?on (?:your|the) (left|right)/i, (m, o, s) => `${ORD[o.toLowerCase()]}${o === 'next' ? '' : '个'}路口${SIDE[s.toLowerCase()]}转`],
  [/^take the next right/i, () => '下一个路口右转'],
  [/^at the traffic lights?,? turn (left|right)(.*)$/i, (m, s, r) => `红绿灯处${SIDE[s.toLowerCase()]}转${tail(r)}`],
  [/pull up on the (left|right)/i, (m, s) => `在${SIDE[s.toLowerCase()]}边安全的地方靠边停车`],
  [/^(?:just )?pull up along here/i, () => '在这里靠边停车'],
  [/stop the car/i, () => '停车'],
  [/(?:when you(?:'re| are) ready,? (?:please )?(?:drive on|drive off|drive|try one|move off)|move off when you(?:'re| are) ready)/i, () => '准备好就继续开'],
  [/^(?:yes,? |just )?follow the (?:road|route) ahead/i, () => '沿路直走'],
  [/follow the barrier/i, () => '沿着栏杆走'],
  [/turn off (?:your|the) engine/i, () => '熄火'],
  [/end of (?:your |the )?independent driving/i, () => '自主驾驶结束，之后听考官指令'],
  [/(?:independent driving|follow the directions? from the (?:navigation|sat ?nav))/i, () => '开始自主驾驶：跟着导航走'],
  [/park alongside|parallel/i, () => '侧方停车：停到前车旁边，再倒进去，两个车身内完成'],
  [/forward bay park/i, () => '车头先进车位停车'],
  [/reverse (?:park|into the bay|in the bay)/i, () => '倒车入库'],
  [/reverse out/i, () => '倒出车位'],
  [/middle lane/i, () => '安全时并到中间车道'],
  [/cycle lane/i, () => '（这次不用管自行车道）'],
  [/^thank you/i, () => '谢谢'],
];

function glossClause(c) {
  let pre = '';
  const after = c.match(/^after ([\d.]+) ?(yards?|yd|y|miles?|mi)\b,?\s*/i);
  if (after) { pre = `${after[1]} ${/^m/i.test(after[2]) ? '英里' : '码'}后`; c = c.slice(after[0].length); }
  for (const [re, f] of RULES) {
    const m = c.match(re);
    if (m) return pre + f(...m);
  }
  return pre;
}

/** Chinese gloss for one line ("A, then B" → "A，然后B"); '' when nothing matches. */
export function glossZh(text) {
  const t = String(text || '').trim().replace(/\.\s*Then,?\s*/gi, ', then ');
  const sentences = t.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const out = [];
  for (const s of sentences) {
    const parts = s.split(/,?\s+then,?\s+/i).map((c) => glossClause(c.replace(/[.!?]+$/, '').trim())).filter(Boolean);
    const joined = [...new Set(parts)].join('，然后');
    if (joined && !out.includes(joined)) out.push(joined);
  }
  return out.join('。');
}
