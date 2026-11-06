/* global L */
// Mobile-first route viewer: route list → map with attention points, roundabout
// cards, instructions, navigation/export, and a step-through "预习" review mode.
import { Store } from './store.js';
import { TYPES, LEVELS, titleOf, CENTRE } from './core/model.js';
import { cumulative, fmtDist, fmtDuration, project } from './core/geo.js';
import { buildInstructions, ARROW } from './core/instructions.js';
import { buildTimeline } from './core/timeline.js';
import { googleMapsParts, toGPX, toKML, safeFileName } from './core/exporters.js';
import { roundaboutAdvice } from './core/roundabout.js';
import { createMap, RouteLayer, AnnotationLayer } from './ui/mapkit.js';
import { markerHtml, GLYPH, UI } from './ui/icons.js';
import { roundaboutSvg } from './ui/rbdiagram.js';
import { detailHtml } from './ui/detail.js';
import { DriveVoice, Simulator, voiceSettings, saveVoiceSettings } from './ui/drive.js';
import { $, $$, esc, toast, download, settings, lightbox } from './ui/util.js';

applyTheme(settings.get('theme', ''));
$('#logo').innerHTML = GLYPH.roundabout;
$('#btn-import').innerHTML = UI.upload;
$('#btn-settings').innerHTML = UI.gear;
$('#btn-back').innerHTML = UI.back;
$('#btn-fit').innerHTML = UI.fit;
$('#btn-install').innerHTML = `${UI.install}安装到手机`;

const store = await new Store().init();
const S = {
  route: null, cum: [0], timeline: null, instructions: [],
  tab: 'points', filter: { key: true, type: null },
  selected: null, review: false, seq: [],
  map: null, routeLayer: null, annLayer: null,
};
// GPS / simulation state (declared early: onHash() runs before the rest of the module)
const G = { watch: null, marker: null, circle: null, lastAt: null, lastT: null, vEst: null, follow: true, first: true, wake: null, next: null, sim: null };
const drive = new DriveVoice({ caption: $('#caption') });
const isWide = () => matchMedia('(min-width: 900px)').matches;
if (new URLSearchParams(location.search).has('debug')) window.__dbg = { S, G, drive };

// ---------------- navigation ----------------
window.addEventListener('hashchange', onHash);
onHash();

async function onHash() {
  const m = location.hash.match(/^#\/r\/([^/?]+)/);
  if (!m || (S.route && decodeURIComponent(m[1]) !== S.route.id)) { stopLocate(); stopSim(); }
  try {
    if (m) await showRoute(decodeURIComponent(m[1]));
    else await showList();
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'err');
    if (m) location.hash = '#/';
  }
}

function showView(name) {
  $('#view-list').classList.toggle('hidden', name !== 'list');
  $('#view-route').classList.toggle('hidden', name !== 'route');
}

// ---------------- list ----------------
async function showList() {
  showView('list');
  document.title = '路考路线 · Cambridge';
  const list = await store.list();
  const box = $('#route-list');
  if (!list.length) {
    box.innerHTML = '<div class="card empty">还没有路线。用电脑打开编辑器录入，或者导入路线包。</div>';
  } else {
    box.innerHTML = list.map(cardHtml).join('');
  }
  const standalone = matchMedia('(display-mode: standalone)').matches;
  $('#list-hint').innerHTML = `
    <b>怎么用</b>
    <span>· 电脑上打开编辑器（npm start → editor.html），边看 YouTube mock test 视频边录入路线和注意点。</span>
    <span>· 把路线传到手机：编辑器「导出 / 导入」→ 导出路线包，发到手机后在这里点右上角的导入按钮。</span>
    <span>· 练车前点开路线，按"预习 ▶"逐个复习注意点；地图右上角"定位"会显示你在路线上的位置和前方注意点。</span>
    ${standalone ? '' : '<span>· 安装到手机：Chrome 菜单 →「添加到主屏幕 / 安装应用」，之后像 App 一样打开，离线也能用。</span>'}
    <span class="small faint">数据保存在：${esc(store.where)}${store.mode === 'server' && !store.writable ? '（手机只读）' : ''}</span>`;
}

function cardHtml(s) {
  const counts = Object.entries(s.counts || {}).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, n]) => `<span class="rc-chip"><i style="--c:${TYPES[k]?.color || '#999'}"></i>${esc(TYPES[k]?.zh || k)} ${n}</span>`).join('');
  const thumb = s.youtubeId ? `<img class="rc-thumb" alt="" loading="lazy" src="https://i.ytimg.com/vi/${encodeURIComponent(s.youtubeId)}/mqdefault.jpg">` : '';
  return `<a class="route-card card" href="#/r/${encodeURIComponent(s.id)}">
    <div>
      <div class="rc-title">${esc(s.name)} ${s.demo ? '<span class="badge auto">示例</span>' : ''}${s.origin === 'local' ? ' <span class="badge">本机</span>' : ''}</div>
      <div class="rc-meta">${fmtDist(s.distance)} · ${fmtDuration(s.duration)} · ${s.total || 0} 个注意点${s.hot ? ` · 易错 ${s.hot}` : ''}</div>
      <div class="rc-chips">${counts}</div>
    </div>${thumb}</a>`;
}

// ---------------- route view ----------------
function initMap() {
  S.map = createMap($('#map'), { center: [CENTRE.lat, CENTRE.lng], zoom: 14 });
  S.routeLayer = new RouteLayer(S.map);
  S.annLayer = new AnnotationLayer(S.map, { onSelect: (id) => openDetail(id) });
  S.map.on('click', () => { if (S.selected && !S.review) closeDetail(); });
  S.map.on('dragstart', () => { G.follow = false; });
  const DriveButtons = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-btns');
      box.innerHTML = `
        <button class="map-btn" id="btn-locate" type="button" title="显示我的位置和前方注意点（练车时手机固定在支架上，只看不碰）">${UI.target}<span>定位</span></button>
        <button class="map-btn" id="btn-voice" type="button" title="英文考官语音播报（模仿路考）"></button>
        <button class="map-btn" id="btn-sim" type="button" title="模拟行驶：在家沿路线预演，听考官指令">${UI.play}<span>模拟</span></button>`;
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      box.querySelector('#btn-locate').addEventListener('click', toggleLocate);
      box.querySelector('#btn-voice').addEventListener('click', toggleVoice);
      box.querySelector('#btn-sim').addEventListener('click', () => (G.sim ? stopSim() : startSim()));
      return box;
    },
  });
  new DriveButtons().addTo(S.map);
  renderVoiceBtn();
  initSheet();
}

async function showRoute(id) {
  showView('route');
  if (!S.map) initMap();
  if (S.route?.id !== id) {
    S.route = await store.get(id);
    S.cum = cumulative(S.route.route?.geometry || []);
    S.timeline = buildTimeline(S.route, S.cum);
    S.instructions = buildInstructions(S.route);
    drive.setRoute(S.route);
    S.selected = null; S.review = false;
    S.filter = { key: true, type: null };
    S.routeLayer.set(S.route.route?.geometry || []);
  }
  document.title = `${S.route.name} · 路考路线`;
  $('#route-title').textContent = S.route.name;
  const r = S.route.route;
  $('#route-sub').textContent = r ? `${fmtDist(r.distance)} · 约 ${fmtDuration(r.duration)} · ${S.route.annotations.length} 个注意点` : '尚未生成路线';
  S.map.invalidateSize();
  refreshMarkers();
  renderSheet();
  setTimeout(fitRoute, 50);
}

function fitRoute() {
  const b = S.routeLayer.bounds();
  if (!b) return;
  const p = pads();
  S.map.fitBounds(b, { paddingTopLeft: p.tl, paddingBottomRight: p.br, animate: false });
}

function pads() {
  const sheet = $('#sheet');
  if (isWide()) return { tl: [sheet.offsetWidth + 24, 24], br: [56, 24] };
  return { tl: [24, 70], br: [24, sheet.offsetHeight + 16] };
}

function flyTo(latlng, zoom = 17) {
  const p = pads();
  S.map.flyToBounds(L.latLngBounds([latlng, latlng]), { paddingTopLeft: p.tl, paddingBottomRight: p.br, maxZoom: zoom, duration: 0.5 });
}

$('#btn-back').onclick = () => { location.hash = '#/'; };
$('#btn-fit').onclick = fitRoute;

// ---------------- filters ----------------
const all = () => (S.route?.annotations || []).filter((a) => a.lat != null);
function filtered() {
  const f = S.filter;
  if (f.type) return all().filter((a) => a.type === f.type);
  if (f.key) return all().filter((a) => (a.level || 1) >= 2);
  return all();
}
function refreshMarkers() {
  const vis = new Set(filtered());
  if (S.selected) vis.add(all().find((a) => a.id === S.selected));
  S.annLayer.selectedId = S.selected;
  S.annLayer.set(all(), { visible: (a) => vis.has(a) });
}

// ---------------- bottom sheet ----------------
function setSheet(state) {
  const sheet = $('#sheet');
  sheet.dataset.state = state;
  const h = { peek: '128px', half: '52vh', full: 'calc(100% - 64px)' }[state] || '52vh';
  $('#view-route').style.setProperty('--sheet-h', isWide() ? '0px' : h);
}

function initSheet() {
  setSheet('half');
  const handle = $('#sheet-handle');
  const sheet = $('#sheet');
  let startY = 0, startH = 0, dragging = false, moved = false;
  handle.addEventListener('pointerdown', (e) => {
    dragging = true; moved = false; startY = e.clientY; startH = sheet.offsetHeight;
    sheet.classList.add('dragging'); handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 4) moved = true;
    const hgt = Math.max(90, Math.min(window.innerHeight - 56, startH + dy));
    $('#view-route').style.setProperty('--sheet-h', `${hgt}px`);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false; sheet.classList.remove('dragging');
    const hgt = sheet.offsetHeight, vh = window.innerHeight;
    if (!moved) { setSheet(sheet.dataset.state === 'peek' ? 'half' : sheet.dataset.state === 'half' ? 'full' : 'peek'); return; }
    setSheet(hgt < vh * 0.3 ? 'peek' : hgt < vh * 0.72 ? 'half' : 'full');
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  $('#sheet-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    S.tab = b.dataset.tab; S.selected = null; S.review = false;
    S.annLayer.select(null);
    S.routeLayer.highlight(null);
    refreshMarkers();
    renderSheet();
    if ($('#sheet').dataset.state === 'peek') setSheet('half');
  });
  $('#btn-review').onclick = startReview;
  window.addEventListener('resize', () => setSheet($('#sheet').dataset.state));
  document.addEventListener('keydown', (e) => {
    if ($('#view-route').classList.contains('hidden') || !S.selected) return;
    if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'Escape') closeDetail();
  });
}

function renderSheet() {
  $$('#sheet-tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab && !S.selected)));
  const body = $('#sheet-body');
  body.scrollTop = 0;
  if (S.selected) return renderDetail();
  if (S.tab === 'points') body.innerHTML = pointsHtml();
  else if (S.tab === 'rbs') body.innerHTML = rbsHtml();
  else if (S.tab === 'steps') body.innerHTML = stepsHtml();
  else body.innerHTML = navHtml();
  bindSheetBody();
}

function pointsHtml() {
  const list = all();
  const counts = {};
  for (const a of list) counts[a.type] = (counts[a.type] || 0) + 1;
  const keyN = list.filter((a) => (a.level || 1) >= 2).length;
  const f = S.filter;
  const chips = [
    `<button class="chip" data-f="key" aria-pressed="${f.key && !f.type}">重点 ${keyN}</button>`,
    `<button class="chip" data-f="all" aria-pressed="${!f.key && !f.type}">全部 ${list.length}</button>`,
    ...Object.keys(TYPES).filter((k) => counts[k]).map((k) => `<button class="chip" data-f="t:${k}" aria-pressed="${f.type === k}" style="--c:${TYPES[k].color}"><span class="dot"></span>${esc(TYPES[k].zh)} ${counts[k]}</button>`),
  ].join('');
  const items = filtered();
  const note = S.route.notes ? `<div class="route-note">${esc(S.route.notes)}</div>` : '';
  return `${note}<div class="chips">${chips}</div>
    <div class="pt-list">${items.map(ptHtml).join('') || '<div class="empty">没有符合条件的注意点</div>'}</div>`;
}

function ptHtml(a) {
  const T = TYPES[a.type] || TYPES.note;
  const sub = a.rb ? roundaboutAdvice(a.rb).lines[0] : a.note || T.zh;
  return `<button class="pt" data-id="${esc(a.id)}"><span class="pt-ic">${markerHtml(a)}</span>
    <span style="min-width:0"><b>${esc(titleOf(a))}</b><small>${esc(sub)}</small></span><span class="pt-at">${fmtDist(a.at)}</span></button>`;
}

function rbsHtml() {
  const rbs = all().filter((a) => a.type === 'roundabout' && a.rb);
  if (!rbs.length) return '<div class="empty">这条路线没有环岛</div>';
  return rbs.map((a) => {
    const adv = roundaboutAdvice(a.rb);
    return `<button class="rb-card" data-id="${esc(a.id)}">${roundaboutSvg(a.rb, { size: 84 })}<span>
      <b>${esc(adv.head)}</b><small>${esc((a.rb.fromRoad || '?') + ' → ' + (a.rb.toRoad || '?'))}</small><small>${esc(adv.lines[0])}</small></span></button>`;
  }).join('');
}

function stepsHtml() {
  if (!S.instructions.length) return '<div class="empty">没有路线指令</div>';
  const vs = voiceSettings();
  const hint = `<div class="voice-hint">
    <b>英文考官语音（模仿路考）</b>
    <span>下面是考官会说的话。点 ${UI.speaker} 试听；地图右上角打开「语音」，再点「定位」就会在合适的位置播报。在家可以点「模拟」沿路线预演。</span>
    <span class="small muted">当前：${vs.mode === 'practice' ? '练习模式（考官指令 + 英文提示）' : '模拟考试模式（只有考官指令）'} · 在设置里切换</span></div>`;
  return `${hint}<div class="steps">${S.instructions.map((s, i) => `<div class="step ${s.icon === ARROW.roundabout ? 'rb' : ''}" data-step="${i}" role="button" tabindex="0">
    <span class="ic">${esc(s.icon)}</span><span style="min-width:0"><b lang="en-GB">${esc(s.en)}</b><small>${esc(s.zh)}${s.road ? ` · ${esc(s.road)}` : ''}</small></span>
    <span class="d">${fmtDist(s.at)}</span><button class="btn icon ghost say" type="button" data-say="${i}" title="试听" aria-label="试听">${UI.speaker}</button></div>`).join('')}</div>`;
}

function navHtml() {
  const r = S.route;
  if (!r.route) return '<div class="empty">还没有生成路线</div>';
  const pw = googleMapsParts(r, { mode: 'waypoints' });
  const pt = googleMapsParts(r, { mode: 'turns' });
  const partBtns = (parts) => parts.map((p) => `<a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener">${UI.nav}第 ${p.index} 段 · ${fmtDist(p.from)}–${fmtDist(p.to)}</a>`).join('');
  return `<div class="nav-opts">
    <div class="opt"><h4>Google Maps 导航（分 ${pw.length} 段）</h4>
      <p>Google 地图一个链接最多带 9 个途经点，所以路线拆成几段：开完一段再点下一段。途经点会被放在每个路口后约 35 米处，引导 Google 走同一条路。</p>
      <div class="parts">${partBtns(pw)}</div>
      ${pt.length !== pw.length ? `<details><summary class="small muted">精确模式：按每个转弯设途经点（${pt.length} 段）</summary><div class="parts">${partBtns(pt)}</div></details>` : ''}
    </div>
    <div class="opt"><h4>OsmAnd：严格沿轨迹导航 + 语音播报注意点（推荐）</h4>
      <p>下载 GPX，用 OsmAnd 打开并导入为轨迹，然后选「沿轨迹导航（Follow track）」。在导航语音设置里打开 GPX 航点播报，接近注意点时会读出名称（不同版本的菜单位置略有不同）。</p>
      <div class="row wrap"><button class="btn" data-act="gpx">${UI.download}下载 GPX</button><span class="small muted">航点语言：${settings.get('gpxLang', 'zh') === 'en' ? 'English' : '中文'}（可在设置里改）</span></div>
    </div>
    <div class="opt"><h4>Google My Maps：在 Google 地图里看所有标注</h4>
      <p>电脑打开 mymaps.google.com，新建地图，选「导入」并上传 KML。之后在手机 Google 地图 App 的「已保存 → 地图」里打开。导航时一般不会显示这些标注，适合事先熟悉位置。</p>
      <button class="btn" data-act="kml">${UI.download}下载 KML</button>
    </div>
    <div class="opt"><h4>路线包</h4><p>包含截图的完整备份；在另一台设备的首页点「导入」即可。</p>
      <button class="btn" data-act="pack">${UI.download}下载路线包</button>
    </div>
  </div>`;
}

function bindSheetBody() {
  const body = $('#sheet-body');
  body.onpointerdown = body.onpointerup = null; // swipe navigation only applies to the detail view
  body.onclick = async (e) => {
    const chip = e.target.closest('[data-f]');
    if (chip) {
      const v = chip.dataset.f;
      if (v === 'key') S.filter = { key: true, type: null };
      else if (v === 'all') S.filter = { key: false, type: null };
      else { const t = v.slice(2); S.filter = { key: S.filter.key, type: S.filter.type === t ? null : t }; }
      refreshMarkers();
      renderSheet();
      return;
    }
    const pt = e.target.closest('[data-id]');
    if (pt && !e.target.closest('.detail')) return openDetail(pt.dataset.id);
    const say = e.target.closest('[data-say]');
    if (say) {
      const s = S.instructions[+say.dataset.say];
      if (s) drive.sayNow(s.en, s.zh);
      return;
    }
    const st = e.target.closest('[data-step]');
    if (st) {
      const s = S.instructions[+st.dataset.step];
      if (s?.loc) flyTo(s.loc, 17);
      if (!isWide()) setSheet('peek');
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act) await doExport(act);
  };
}

async function doExport(act) {
  const r = S.route;
  const base = safeFileName(r.name);
  try {
    if (act === 'gpx') download(`${base}.gpx`, toGPX(r, { lang: settings.get('gpxLang', 'zh') }), 'application/gpx+xml');
    else if (act === 'kml') download(`${base}.kml`, toKML(r), 'application/vnd.google-earth.kml+xml');
    else if (act === 'pack') download(`${base}.route.json`, JSON.stringify(await store.exportPack([r.id])), 'application/json');
  } catch (e) { toast(e.message, 'err'); }
}

// ---------------- detail & review ----------------
function openDetail(id, { fly = true } = {}) {
  const a = all().find((x) => x.id === id);
  if (!a) return;
  S.selected = id;
  const seq = filtered();
  S.seq = seq.includes(a) ? seq : all();
  S.annLayer.select(id);
  refreshMarkers();
  renderSheet();
  if (a.rb) S.routeLayer.highlight(a.rb.fromAt - 45, a.rb.toAt + 35);
  else S.routeLayer.highlight(a.at - 60, a.at + 30);
  if (!isWide() && $('#sheet').dataset.state === 'peek') setSheet('half');
  if (fly) flyTo(a.rb?.centre || [a.lat, a.lng], a.type === 'roundabout' ? 18 : 17);
}

function closeDetail() {
  S.selected = null; S.review = false;
  S.annLayer.select(null);
  S.routeLayer.highlight(null);
  refreshMarkers();
  renderSheet();
}

function step(d) {
  const i = S.seq.findIndex((a) => a.id === S.selected);
  const n = S.seq[i + d];
  if (n) openDetail(n.id);
  else if (d > 0 && S.review) { toast('预习完成 🎉', 'ok'); closeDetail(); }
}

function startReview() {
  if (!all().length) return toast('这条路线还没有注意点');
  S.filter = { key: true, type: null };
  S.review = true;
  S.tab = 'points';
  const seq = filtered();
  const first = (seq.length ? seq : all())[0];
  openDetail(first.id);
}

function renderDetail() {
  const a = all().find((x) => x.id === S.selected);
  if (!a) { S.selected = null; return renderSheet(); }
  const i = S.seq.indexOf(a), n = S.seq.length;
  const tEst = a.t == null ? S.timeline?.timeAt(a.at) : null;
  const top = `<div class="detail-top">
    <button class="btn sm ghost" data-close>${UI.back}${S.review ? '退出预习' : '返回列表'}</button>
    <div class="progress" title="${i + 1}/${n}"><i style="width:${n ? ((i + 1) / n) * 100 : 0}%"></i></div>
    <span class="small muted">${i + 1}/${n}</span></div>`;
  const nav = `<div class="detail-nav">
    <button class="btn lg" data-nav="-1" ${i <= 0 ? 'disabled' : ''}>${UI.prev}上一个</button>
    <button class="btn lg primary" data-nav="1">${i >= n - 1 ? (S.review ? '完成' : '最后一个') : '下一个'}${UI.next}</button></div>`;
  const body = $('#sheet-body');
  body.innerHTML = top + detailHtml(a, S.route, { tEst, svKey: settings.get('svKey', '') }) + nav;
  body.onclick = (e) => {
    if (e.target.closest('[data-close]')) return closeDetail();
    const nv = e.target.closest('[data-nav]');
    if (nv && !nv.disabled) return step(+nv.dataset.nav);
    const img = e.target.closest('[data-zoom]');
    if (img) lightbox(img.src);
  };
  // swipe left/right to move between points
  let x0 = null, y0 = null;
  body.onpointerdown = (e) => { if (e.pointerType !== 'mouse') { x0 = e.clientX; y0 = e.clientY; } };
  body.onpointerup = (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  };
}

// ---------------- import / settings ----------------
$('#btn-import').onclick = () => $('#file-import').click();
$('#file-import').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const routes = await store.importPack(JSON.parse(await f.text()));
    toast(`已导入 ${routes.length} 条路线`, 'ok');
    S.route = null;
    showList();
  } catch (err) { toast(`导入失败：${err.message}`, 'err'); }
};

$('#btn-settings').onclick = () => {
  $('#set-theme').value = settings.get('theme', '');
  $('#set-gpx').value = settings.get('gpxLang', 'zh');
  $('#set-svkey').value = settings.get('svKey', '');
  $('#set-where').textContent = `路线保存在：${store.where}。${store.mode === 'server' ? '当前连接着电脑上的本地服务器。' : ''}`;
  fillVoiceSettings();
  $('#dlg-settings').showModal();
};

// voice settings (English examiner)
function fillVoiceSettings() {
  const v = voiceSettings();
  $('#set-vmode').value = v.mode;
  $('#set-vtips').value = String(v.tips);
  $('#set-vrate').value = String(v.rate);
  $('#set-vshowme').checked = !!v.showMe;
  $('#set-vchime').checked = !!v.chime;
  $('#set-vtips').closest('.field').classList.toggle('hidden', v.mode !== 'practice');
  fillVoices();
}
function fillVoices() {
  const sel = $('#set-voice');
  const voices = drive.speaker.voices();
  const cur = drive.speaker.voice();
  sel.innerHTML = voices.length
    ? voices.map((x) => `<option value="${esc(x.voiceURI)}" ${cur && x.voiceURI === cur.voiceURI ? 'selected' : ''}>${esc(x.name)} (${esc(x.lang)})${x.localService ? '' : ' · 联网'}</option>`).join('')
    : '<option value="">（没有英文语音：只显示字幕）</option>';
  const gb = voices.some((x) => /^en[-_]gb/i.test(x.lang));
  $('#set-vinfo').textContent = !drive.speaker.supported
    ? '这个浏览器不支持语音合成，只能显示字幕。'
    : !voices.length ? '没找到英文语音。Android：系统设置 → 文字转语音 → 安装英语（英国）语音包。'
      : gb ? '' : '没有英式英语语音，用的是其他英语口音。Android 可以在「文字转语音」里下载英语（英国）。';
}
drive.speaker.onVoices = () => { if ($('#dlg-settings').open) fillVoices(); };
function onVoiceSetting(patch) {
  saveVoiceSettings(patch);
  drive.rebuild();
  fillVoiceSettings();
  if (S.tab === 'steps' && !S.selected && S.route) renderSheet();
}
$('#set-vmode').onchange = (e) => onVoiceSetting({ mode: e.target.value });
$('#set-vtips').onchange = (e) => onVoiceSetting({ tips: +e.target.value });
$('#set-vrate').onchange = (e) => onVoiceSetting({ rate: +e.target.value });
$('#set-vshowme').onchange = (e) => onVoiceSetting({ showMe: e.target.checked });
$('#set-vchime').onchange = (e) => onVoiceSetting({ chime: e.target.checked });
$('#set-voice').onchange = (e) => onVoiceSetting({ voiceURI: e.target.value });
$('#set-vtest').onclick = () => drive.sayNow('At the roundabout, take the third exit, please.', '环岛第三出口');
$('#dlg-settings').addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target.id === 'dlg-settings') $('#dlg-settings').close(); });
$('#set-theme').onchange = (e) => { settings.set('theme', e.target.value); applyTheme(e.target.value); };
$('#set-gpx').onchange = (e) => settings.set('gpxLang', e.target.value);
$('#set-svkey').onchange = (e) => settings.set('svKey', e.target.value.trim());
$('#set-clear').onclick = async () => {
  if (!confirm('删除这个浏览器里导入/保存的所有路线？（电脑上的文件不受影响）')) return;
  indexedDB.deleteDatabase('driving-route');
  toast('已清除，正在刷新…');
  setTimeout(() => location.reload(), 600);
};

function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// ---------------- my location (GPS) & drive mode ----------------
function toggleLocate() { if (G.watch == null) startLocate(); else stopLocate(); }

function startLocate() {
  if (!('geolocation' in navigator)) return toast('这个浏览器不支持定位', 'err');
  if (!window.isSecureContext) return toast('定位需要 HTTPS：请用部署后的网址打开', 'err', 5000);
  stopSim();
  drive.speaker.unlock(); // still inside the tap: lets the examiner speak later
  drive.begin();
  G.first = true; G.lastAt = null; G.lastT = null; G.vEst = null; G.follow = true;
  G.watch = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
  keepAwake(true);
  setBanner(`<b>正在定位…</b><small>第一次使用会询问定位权限${drive.on ? '' : ' · 点「语音」可以打开英文考官播报'}</small>`);
  $('#btn-locate')?.classList.add('on');
}

function stopLocate() {
  if (G.watch == null) return;
  navigator.geolocation.clearWatch(G.watch);
  G.watch = null; G.next = null;
  drive.end();
  removeCar();
  keepAwake(false);
  setBanner(null);
  $('#btn-locate')?.classList.remove('on');
}

function showCar(p, accuracy) {
  if (!G.marker) {
    G.circle = L.circle(p, { radius: accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(S.map);
    G.marker = L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 6000 }).addTo(S.map);
  } else {
    G.marker.setLatLng(p);
    G.circle.setLatLng(p).setRadius(accuracy);
  }
  if (G.first) { G.first = false; flyTo(p, 17); }
  else if (G.follow && !S.selected && !S.map.getBounds().pad(-0.25).contains(p)) S.map.panTo(p);
}

function removeCar() {
  if (G.marker) { G.marker.remove(); G.marker = null; }
  if (G.circle) { G.circle.remove(); G.circle = null; }
}

function onPosition(pos) {
  const { latitude, longitude, accuracy, heading, speed } = pos.coords;
  const p = [latitude, longitude];
  showCar(p, accuracy);
  updateProgress(p, heading, speed, accuracy);
}

function onPositionError(err) {
  const msg = { 1: '没有定位权限：在浏览器设置里允许本网站使用位置', 2: '暂时拿不到位置（GPS 信号弱？）', 3: '定位超时，继续尝试中…' }[err.code] || err.message;
  setBanner(`<b>${esc(msg)}</b>`, true);
  if (err.code === 1) stopLocate();
}

/**
 * Where am I on the route, what is the next attention point, and what should the
 * examiner say now? `sim` = state from the simulated drive (position known exactly).
 */
function updateProgress(p, heading, speed, accuracy, sim = null) {
  const g = S.route?.route?.geometry;
  if (!g?.length) return;
  const now = sim ? sim.t : performance.now() / 1000;
  let at;
  if (sim) at = sim.at;
  else {
    const opts = {};
    if (heading != null && !Number.isNaN(heading) && speed > 2) opts.bearingHint = heading;
    if (G.lastAt != null) opts.atHint = G.lastAt; // routes often pass the same road twice
    const pr = project(g, S.cum, p, opts);
    const tol = Math.max(45, Math.min(120, (accuracy || 0) * 1.5));
    if (!pr || pr.dist > tol) {
      G.next = null;
      drive.offRoute();
      setBanner(`<b>不在这条路线上</b><small>离路线约 ${fmtDist(pr?.dist ?? 0)}${accuracy > 50 ? ` · 定位精度 ±${Math.round(accuracy)} m` : ''}</small>`, true);
      return;
    }
    at = pr.at;
  }
  // speed: from GPS when the phone reports it, else from progress along the route
  let v = sim ? sim.v : speed;
  if (!sim && (v == null || Number.isNaN(v))) {
    const raw = G.lastAt != null && G.lastT != null && now > G.lastT ? Math.max(0, (at - G.lastAt) / (now - G.lastT)) : 0;
    G.vEst = G.vEst == null ? raw : G.vEst * 0.6 + raw * 0.4;
    v = G.vEst;
  }
  const jump = sim ? sim.jump : G.lastAt != null && Math.abs(at - G.lastAt) > 300;
  G.lastAt = at; G.lastT = now;
  drive.progress({ at, v: v || 0, t: now, jump });

  const total = S.cum[S.cum.length - 1];
  const ahead = all().filter((a) => (a.level || 1) >= 2 && (a.at ?? 0) > at + 5).sort((x, y) => x.at - y.at);
  G.next = ahead[0] || null;
  const head = G.next ? `前方 ${fmtDist(G.next.at - at)}：${esc(titleOf(G.next))}` : '前方没有注意点了';
  const then = ahead[1] ? `再往后 ${fmtDist(ahead[1].at - at)}：${esc(titleOf(ahead[1]))}` : '';
  setBanner(`<b>${head}</b><small>${sim ? '模拟 · ' : ''}起点后 ${fmtDist(at)} / 全程 ${fmtDist(total)}${then ? ` · ${then}` : ''}</small>`);
}

function setBanner(html, off = false) {
  const b = $('#gps-banner');
  b.classList.toggle('hidden', !html);
  b.classList.toggle('off', off);
  b.innerHTML = html || '';
}
$('#gps-banner').onclick = () => { if (G.next) openDetail(G.next.id); };

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) G.wake = await navigator.wakeLock.request('screen');
    else if (!on) { await G.wake?.release(); G.wake = null; }
  } catch { /* not supported / denied */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (G.watch != null || G.sim)) keepAwake(true); });

// ---------------- voice ----------------
function toggleVoice() {
  drive.setOn(!drive.on); // inside the tap: unlocks speech on mobile browsers
  renderVoiceBtn();
  if (!drive.on) return toast('语音已关闭');
  if (!drive.speaker.supported) toast('这个浏览器不支持语音合成，只显示字幕', 'err', 4000);
  else if (!drive.active) toast('英文考官语音已打开：点「定位」开始练车，或点「模拟」在家预演', 'ok', 4500);
  else toast('英文考官语音已打开', 'ok');
}

function renderVoiceBtn() {
  const b = $('#btn-voice');
  if (!b) return;
  b.classList.toggle('on', drive.on);
  b.innerHTML = `${drive.on ? UI.speaker : UI.speakerOff}<span>语音</span>`;
}

// ---------------- simulated drive (rehearse the route at home) ----------------
function startSim() {
  const g = S.route?.route?.geometry;
  if (!g?.length) return toast('这条路线还没有生成', 'err');
  stopLocate();
  drive.speaker.unlock();
  const plan = drive.begin();
  if (!plan) return;
  if (S.selected) closeDetail();
  G.first = true; G.follow = true; G.lastAt = null; G.lastT = null;
  G.sim = new Simulator({ plan, geometry: g, onTick: onSimTick, onEnd: renderSimBar, busy: () => drive.busy() });
  $('#sim-bar').classList.remove('hidden');
  $('#btn-sim')?.classList.add('on');
  keepAwake(true);
  if (!isWide()) setSheet('peek');
  if (!drive.on) toast('「语音」是关着的：现在只显示位置。点「语音」听考官指令。', '', 4500);
  G.sim.play();
}

function stopSim() {
  if (!G.sim) return;
  G.sim.pause();
  G.sim = null;
  drive.end();
  removeCar();
  keepAwake(false);
  setBanner(null);
  $('#sim-bar').classList.add('hidden');
  $('#btn-sim')?.classList.remove('on');
}

function onSimTick(s) {
  if (!G.sim) return;
  showCar(s.p, 6);
  updateProgress(s.p, s.heading, s.v, 6, s);
  renderSimBar();
}

function renderSimBar() {
  const sim = G.sim;
  if (!sim) return;
  const play = $('#sim-play');
  play.innerHTML = sim.playing ? UI.pause : UI.play;
  play.setAttribute('aria-label', sim.playing ? '暂停' : '继续');
  $('#sim-speed').textContent = `${sim.mult}×`;
  const r = $('#sim-pos');
  r.max = String(Math.round(sim.total));
  if (document.activeElement !== r) r.value = String(Math.round(sim.at));
  const state = sim.playing ? ` · ${Math.round(sim.v * 2.237)} mph` : ' · 已暂停';
  $('#sim-info').textContent = `${fmtDist(sim.at)} / ${fmtDist(sim.total)}${state}`;
}
$('#sim-play').onclick = () => {
  if (!G.sim) return;
  if (G.sim.playing) G.sim.pause(); else { drive.speaker.unlock(); G.sim.play(); }
  renderSimBar();
};
$('#sim-speed').onclick = () => {
  if (!G.sim) return;
  const steps = [1, 2, 4, 8];
  G.sim.setMult(steps[(steps.indexOf(G.sim.mult) + 1) % steps.length]);
  renderSimBar();
};
$('#sim-pos').oninput = (e) => { if (G.sim) { G.follow = true; G.sim.seek(+e.target.value); } };
$('#sim-close').onclick = stopSim;

// ---------------- install & offline ----------------
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('#btn-install').classList.remove('hidden');
});
$('#btn-install').onclick = async () => {
  if (!installEvt) return;
  installEvt.prompt();
  const { outcome } = await installEvt.userChoice;
  installEvt = null;
  $('#btn-install').classList.add('hidden');
  if (outcome === 'accepted') toast('已安装到桌面', 'ok');
};
window.addEventListener('appinstalled', () => $('#btn-install').classList.add('hidden'));

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    toast(hadController ? '已更新到最新版本' : '已缓存：没有网络时也能打开', 'ok');
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
void LEVELS;
