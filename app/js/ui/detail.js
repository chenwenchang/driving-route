// Annotation detail card (viewer). Pure HTML string builder.
import { TYPES, LEVELS, titleOf, streetViewUrl, youtubeUrl, mapsPointUrl } from '../core/model.js';
import { TIPS, RULES_DISCLAIMER } from '../core/rules.js';
import { roundaboutAdvice, lanesText } from '../core/roundabout.js';
import { fmtDist, fmtTime } from '../core/geo.js';
import { markerHtml, UI } from './icons.js';
import { roundaboutSvg, lanesHtml } from './rbdiagram.js';
import { esc } from './util.js';

export function detailHtml(a, route, { tEst = null, svKey = '' } = {}) {
  const T = TYPES[a.type] || TYPES.note;
  const lvl = a.level || 1;
  const t = a.t ?? tEst;
  const vid = route.video?.youtubeId;
  const tip = TIPS[a.type];
  const parts = [];

  parts.push(`<div class="detail-head">${markerHtml(a)}<div class="grow">
    <h2 class="detail-title">${esc(titleOf(a))}</h2>
    <div class="detail-meta"><span class="badge l${lvl}">${LEVELS[lvl].zh}</span><span>${esc(T.zh)}</span><span>· 起点后 ${fmtDist(a.at)}</span>
      ${a.auto ? `<span class="badge ${a.confirmed ? 'ok' : 'auto'}">${a.confirmed ? '已核对' : '自动识别·待核对'}</span>` : ''}
      ${a.stale ? '<span class="badge l2">路线已变，位置可能不准</span>' : ''}</div>
  </div></div>`);

  if (a.image) parts.push(`<img class="detail-img" src="${esc(a.image)}" alt="视频截图" loading="lazy" data-zoom>`);

  if (a.rb) {
    const adv = roundaboutAdvice(a.rb);
    const roads = a.rb.fromRoad || a.rb.toRoad ? `<div class="small muted">${esc(a.rb.fromRoad || '?')} → ${esc(a.rb.toRoad || '?')}${a.rb.name ? ` · ${esc(a.rb.name)}` : ''}</div>` : '';
    parts.push(`<div class="rb-block">${roundaboutSvg(a.rb)}<div class="advice">
      <div class="advice-head">${esc(adv.clockLine)}</div>${roads}
      <ol>${adv.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>
      <div class="en">${esc(adv.en)}</div>
    </div></div>`);
    if (a.rb.lanes) parts.push(`<div class="row wrap">${lanesHtml(a.rb.lanes)}<span class="small muted">蓝色 = 地图数据里可走的车道</span></div>`);
  } else if (a.lanes) {
    parts.push(`<div class="row wrap">${lanesHtml(a.lanes)}<span class="small muted">${esc(lanesText(a.lanes))}</span></div>`);
  }

  if (a.note) parts.push(`<div class="detail-note">${esc(a.note)}</div>`);

  if (tip?.tips?.length) {
    parts.push(`<details class="tips-box" ${lvl >= 3 ? 'open' : ''}><summary class="small muted">规则要点${tip.rule ? ` · Highway Code ${esc(tip.rule)}` : ''}</summary>
      <ul class="tips">${tip.tips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><div class="rule-ref">${esc(RULES_DISCLAIMER)}</div></details>`);
  }

  const heading = a.bearing || 0;
  if (svKey) {
    parts.push(`<iframe class="sv" title="街景" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade"
      src="https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(svKey)}&location=${a.lat},${a.lng}&heading=${Math.round(heading)}&pitch=0&fov=90"></iframe>`);
  }
  parts.push(`<div class="detail-actions">
    <a class="btn" href="${streetViewUrl(a.lat, a.lng, heading)}" target="_blank" rel="noopener">${UI.street}街景</a>
    ${vid ? `<a class="btn" href="${youtubeUrl(vid, t)}" target="_blank" rel="noopener">${UI.video}视频${t != null ? ` ${a.t == null ? '≈' : ''}${fmtTime(t)}` : ''}</a>` : ''}
    <a class="btn" href="${mapsPointUrl(a.lat, a.lng)}" target="_blank" rel="noopener">${UI.map}Google 地图</a>
  </div>`);

  return `<article class="detail" data-id="${esc(a.id)}">${parts.join('')}</article>`;
}
