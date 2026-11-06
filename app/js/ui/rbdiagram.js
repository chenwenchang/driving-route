// Roundabout schematic (SVG). Entry at the bottom (6 o'clock), clockwise
// circulation (UK), our path in blue, exits numbered in the order you meet them.
// One-way roads that only lead INTO the roundabout are drawn thin with a red bar.
const CX = 100, CY = 100, R_ARM_OUT = 97, R_NO = 78;

const pt = (deg, r) => {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
};
const f = (n) => n.toFixed(1);

export function roundaboutSvg(rb, { size = 200 } = {}) {
  if (!rb) return '';
  const arms = rb.arms || [];
  const exitArm = arms.find((a) => a.isExit);
  const exitS = exitArm ? exitArm.s : (rb.clock % 12) * 30;
  const sweep = (exitS - 180 + 360) % 360 || 360; // clockwise degrees from entry
  const mini = rb.kind === 'mini';
  const ringR = mini ? 24 : 44, islandR = mini ? 9 : 30;
  const road = '#9aa3ad', roadDim = '#cfd4da';

  const armLine = (deg, color, w) => {
    const [x1, y1] = pt(deg, ringR + 2);
    const [x2, y2] = pt(deg, R_ARM_OUT);
    return `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${color}" stroke-width="${w}"/>`;
  };

  let s = `<svg class="rb-svg" viewBox="0 0 200 200" width="${size}" height="${size}" role="img" aria-label="环岛示意图：第${rb.exit}出口，约${rb.clock}点钟方向">`;
  s += '<defs><marker id="rbArrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1e6fd9"/></marker></defs>';
  s += armLine(180, road, 20); // our entry arm
  for (const a of arms) s += armLine(a.s, a.after ? roadDim : road, a.noEntry ? 10 : 17);
  s += `<circle cx="${CX}" cy="${CY}" r="${ringR}" fill="none" stroke="${road}" stroke-width="${mini ? 18 : 22}"/>`;
  s += `<circle cx="${CX}" cy="${CY}" r="${islandR}" fill="${mini ? '#ffffff' : '#a9cb9d'}" stroke="${mini ? '#ffffff' : '#86ad79'}" stroke-width="2"/>`;
  if (!mini) s += `<circle cx="${CX}" cy="${CY}" r="${ringR}" fill="none" stroke="#fff" stroke-width="1.2" stroke-dasharray="4 5" opacity=".9"/>`;

  // our path
  const [ex0, ey0] = pt(180, R_ARM_OUT - 4);
  const [ex1, ey1] = pt(180, ringR);
  const [ax1, ay1] = pt(exitS, ringR);
  const [ox, oy] = pt(exitS, R_ARM_OUT - 3);
  s += `<path d="M${f(ex0)} ${f(ey0)} L${f(ex1)} ${f(ey1)} A${ringR} ${ringR} 0 ${sweep > 180 ? 1 : 0} 1 ${f(ax1)} ${f(ay1)} L${f(ox)} ${f(oy)}" fill="none" stroke="#1e6fd9" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#rbArrow)"/>`;

  // exit numbers and no-entry bars
  for (const a of arms) {
    if (a.no && !a.after) {
      const [nx, ny] = pt(a.s, R_NO);
      const mine = a.isExit;
      s += `<circle cx="${f(nx)}" cy="${f(ny)}" r="10.5" fill="${mine ? '#1e6fd9' : '#ffffff'}" stroke="${mine ? '#ffffff' : '#5f6673'}" stroke-width="2"/>`;
      s += `<text x="${f(nx)}" y="${f(ny + 4.3)}" text-anchor="middle" font-size="12.5" font-weight="800" fill="${mine ? '#ffffff' : '#1a1d23'}" font-family="system-ui,sans-serif">${a.no}</text>`;
    } else if (a.noEntry) {
      const [x1, y1] = pt(a.s - 6, R_NO + 4), [x2, y2] = pt(a.s + 6, R_NO + 4);
      s += `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="#d93025" stroke-width="3.2" stroke-linecap="round"/>`;
    }
  }
  const [enx, eny] = pt(180, R_ARM_OUT - 8);
  s += `<circle cx="${f(enx)}" cy="${f(eny)}" r="7" fill="#188038" stroke="#fff" stroke-width="2"/>`;
  return s + '</svg>';
}

/** Lane arrows (from OSRM lane indications); valid lanes highlighted. */
const LANE_ARROW = { left: '←', 'slight left': '↖', 'sharp left': '↙', straight: '↑', through: '↑', right: '→', 'slight right': '↗', 'sharp right': '↘', uturn: '↶', none: '↑', merge_to_left: '↖', merge_to_right: '↗' };
export function lanesHtml(lanes) {
  if (!lanes?.length) return '';
  return `<div class="lanes" aria-label="车道">${lanes.map((l) => `<div class="lane ${l.valid ? 'ok' : ''}">${(l.ind?.length ? l.ind : ['none']).map((i) => LANE_ARROW[i] || '↑').join('')}</div>`).join('')}</div>`;
}
