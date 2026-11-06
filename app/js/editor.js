/* global L */
// Desktop route editor: watch a mock-test video, click the route onto the map,
// drop typed attention points with timestamps and screenshots, auto-detect
// OSM features, export.
import { Store } from './store.js';
import { CENTRE, TYPES, TYPE_KEYS, LEVELS, newRoute, parseYouTubeId, parseYouTubeStart, titleOf, defaultTitle, uid, streetViewUrl } from './core/model.js';
import { bearingAt, cumulative, fmtDist, fmtDuration, fmtTime, parseTime, pointAt, project, round6, norm360 } from './core/geo.js';
import { fetchRoute } from './core/osrm.js';
import { autoDetect, mergeAuto, reproject } from './core/analyze.js';
import { buildTimeline } from './core/timeline.js';
import { buildInstructions, ARROW } from './core/instructions.js';
import { voicePlaceholder } from './core/examiner.js';
import { roundaboutAdvice, lanesText, DIR_ZH } from './core/roundabout.js';
import { googleMapsParts, toGPX, toKML, toGeoJSON, safeFileName } from './core/exporters.js';
import { createMap, RouteLayer, AnnotationLayer, CarMarker } from './ui/mapkit.js';
import { GLYPH, UI, markerHtml } from './ui/icons.js';
import { roundaboutSvg, lanesHtml } from './ui/rbdiagram.js';
import { $, $$, esc, toast, download, debounce, settings, lightbox, toJpeg, isTyping } from './ui/util.js';
import { YouTubeSource, FileSource, TabCapture } from './video.js';

const store = await new Store().init();
const E = {
  route: null, cum: [0], timeline: null,
  mode: 'browse', placeType: null,
  sel: null, // { kind: 'ann' | 'wp', id }
  tab: 'ann', annFilter: 'all',
  video: null, cap: new TabCapture(),
  undo: [], redo: [], dirty: false, routeAbort: null,
};

// ---------------------------------------------------------------- setup
$('#logo').innerHTML = GLYPH.roundabout;
$('#v-play').innerHTML = UI.play;
$('#btn-shot').innerHTML = `${UI.camera}截图 <kbd>C</kbd>`;
$('#type-tools').innerHTML = TYPE_KEYS.filter((k) => k !== 'mistake').map((k) => {
  const T = TYPES[k];
  return `<button class="tool" data-type="${k}" title="${esc(T.zh)} · ${esc(T.en)}${T.key ? `（快捷键 ${T.key}）` : ''}" style="--c:${T.color}"><span class="sw">${GLYPH[k]}</span><span class="lbl">${esc(T.zh)}</span>${T.key ? `<kbd>${T.key}</kbd>` : ''}</button>`;
}).join('');
if (!store.writable) toast('未连接本地服务器：数据只保存在这个浏览器里（建议用 npm start 打开编辑器）', 'err', 7000);

const map = createMap($('#map'), { center: [CENTRE.lat, CENTRE.lng], zoom: 15 });
L.control.scale({ position: 'bottomright', imperial: true, metric: true }).addTo(map);
const routeLayer = new RouteLayer(map, { onClick: onRouteClick });
const annLayer = new AnnotationLayer(map, { onSelect: (id) => select('ann', id, { seek: true }), draggable: true, onDragEnd: onAnnDrag });
const wpLayer = L.layerGroup().addTo(map);
const car = new CarMarker(map);
map.on('click', (e) => onMapClick([e.latlng.lat, e.latlng.lng], e.originalEvent));
if (new URLSearchParams(location.search).has('debug')) window.__dbg = { E, map, store };

// ---------------------------------------------------------------- routes
async function loadRouteList(selectId) {
  const list = await store.list();
  $('#route-select').innerHTML = list.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.demo ? '（示例）' : ''}</option>`).join('') + '<option value="__new">＋ 新建路线…</option>';
  if (selectId) $('#route-select').value = selectId;
  return list;
}

$('#route-select').onchange = async (e) => {
  if (e.target.value === '__new') { e.target.value = E.route?.id || ''; openNewDialog(); return; }
  await openRoute(e.target.value);
};

async function openRoute(id) {
  await flushSave();
  const r = await store.get(id);
  E.route = r; E.undo = []; E.redo = []; E.sel = null;
  settings.set('lastRoute', id);
  history.replaceState(null, '', `?id=${encodeURIComponent(id)}`);
  $('#route-select').value = id;
  $('#route-name').value = r.name;
  $('#btn-preview').href = `./#/r/${encodeURIComponent(r.id)}`;
  $('#video-url').value = r.video?.url || (r.video?.youtubeId ? `https://youtu.be/${r.video.youtubeId}` : '');
  setSaveState('');
  refreshDerived();
  renderAll();
  const b = routeLayer.bounds();
  if (b) map.fitBounds(b, { padding: [30, 30], animate: false }); else map.setView([CENTRE.lat, CENTRE.lng], 16, { animate: false });
  E.video?.destroy(); E.video = null;
  $('#video-box').innerHTML = '<div class="video-empty">先加载视频。<br>支持 YouTube 链接，或电脑上的视频文件。</div>';
  if (r.video?.youtubeId) loadYouTube(r.video.youtubeId, r.video.start ?? 0);
}

function openNewDialog() {
  const d = $('#dlg-new');
  d.querySelector('form').reset();
  d.showModal();
}
$('#btn-new').onclick = openNewDialog;
$('#dlg-new').addEventListener('close', async () => {
  const d = $('#dlg-new');
  if (d.returnValue !== 'ok') return;
  const fd = new FormData(d.querySelector('form'));
  const r = newRoute(String(fd.get('name') || '').trim() || '新路线');
  const url = String(fd.get('url') || '').trim();
  const vid = parseYouTubeId(url);
  if (vid) r.video = { youtubeId: vid, url, title: '', start: parseYouTubeStart(url) };
  r.waypoints = [{ id: uid('w'), lat: CENTRE.lat, lng: CENTRE.lng, t: null, label: '考场' }];
  await store.save(r);
  await loadRouteList(r.id);
  await openRoute(r.id);
  setMode('waypoint');
  toast('已创建。播放视频，车辆出发时点"设为出发时刻"，然后在每个路口点地图。', 'ok', 6000);
});

// ---------------------------------------------------------------- state changes / undo / save
function refreshDerived() {
  E.cum = cumulative(E.route.route?.geometry || []);
  E.timeline = buildTimeline(E.route, E.cum);
}

const snapshot = () => JSON.stringify({
  waypoints: E.route.waypoints, annotations: E.route.annotations, dismissed: E.route.dismissed || [],
  route: E.route.route, video: E.route.video, notes: E.route.notes, voice: E.route.voice || {},
});
function pushUndo() { E.undo.push(snapshot()); if (E.undo.length > 80) E.undo.shift(); E.redo = []; }
function change(fn, { reroute = false } = {}) {
  pushUndo();
  fn();
  if (reroute) scheduleReroute();
  refreshDerived();
  renderAll();
  markDirty();
}
function restore(s) { Object.assign(E.route, JSON.parse(s)); refreshDerived(); renderAll(); markDirty(); }
function undo() { if (!E.undo.length) return toast('没有可撤销的操作'); E.redo.push(snapshot()); restore(E.undo.pop()); }
function redo() { if (!E.redo.length) return; E.undo.push(snapshot()); restore(E.redo.pop()); }

const saveSoon = debounce(doSave, 900);
function markDirty() { E.dirty = true; setSaveState('未保存…'); saveSoon(); }
async function doSave() {
  if (!E.dirty || !E.route) return;
  E.dirty = false;
  setSaveState('保存中…');
  try {
    const where = await store.save(E.route);
    setSaveState(where === 'file' ? '已保存 ✓' : '已保存到浏览器 ✓');
    const opt = $(`#route-select option[value="${CSS.escape(E.route.id)}"]`);
    if (opt) opt.textContent = E.route.name;
  } catch (e) {
    E.dirty = true;
    setSaveState('保存失败', true);
    toast(e.message, 'err');
  }
}
async function flushSave() { saveSoon.cancel(); await doSave(); }
window.addEventListener('beforeunload', (e) => { if (E.dirty) { doSave(); e.preventDefault(); } });
function setSaveState(txt, err = false) { const el = $('#save-state'); el.textContent = txt; el.classList.toggle('err', err); }

// ---------------------------------------------------------------- routing
const scheduleReroute = debounce(reroute, 350);
async function reroute() {
  const wps = E.route.waypoints;
  if (wps.length < 2) { E.route.route = null; refreshDerived(); renderAll(); markDirty(); return; }
  E.routeAbort?.abort();
  const ctl = (E.routeAbort = new AbortController());
  status('路线计算中…');
  try {
    const r = await fetchRoute(wps, { signal: ctl.signal });
    if (ctl.signal.aborted) return;
    E.route.route = r;
    reproject(E.route);
    refreshDerived();
    renderAll();
    markDirty();
    status(null);
    if (r.warnings.length) toast(`⚠ ${r.warnings[0].msg}（见"途经点"标签）`, '', 5000);
  } catch (e) {
    if (e.name === 'AbortError') return;
    status(null);
    toast(`路线计算失败：${e.message}`, 'err');
  }
}

// ---------------------------------------------------------------- map interaction
function onMapClick(ll, ev = {}) {
  if (E.mode === 'waypoint') return addWaypoint(ll, ev.shiftKey);
  if (E.mode === 'place') return placeAnnotation(E.placeType, ll, ev.shiftKey);
  if (E.sel) { E.sel = null; renderAll(); }
}

function onRouteClick(latlng, ev) {
  const ll = [latlng.lat, latlng.lng];
  if (E.mode !== 'browse') return onMapClick(ll, ev);
  const p = project(E.route.route.geometry, E.cum, ll);
  const t = E.timeline.timeAt(p.at);
  if (t != null && E.video) { E.video.seek(t); toast(`跳到视频 ${fmtTime(t)}（起点后 ${fmtDist(p.at)}）`); }
  else toast(`起点后 ${fmtDist(p.at)}。需要至少两个带时间的途经点才能对应到视频时间。`);
}

const currentTime = () => (E.video ? Math.round(E.video.time * 10) / 10 : null);

function addWaypoint(ll, insert) {
  const w = { id: uid('w'), lat: round6(ll[0]), lng: round6(ll[1]), t: currentTime() };
  change(() => {
    const wps = E.route.waypoints;
    const g = E.route.route?.geometry;
    if (insert && g?.length > 1 && wps.length >= 2) {
      const p = project(g, E.cum, ll);
      const legs = E.route.route.legStarts || [];
      let k = 0;
      legs.forEach((start, i) => { if (start <= p.index) k = i; });
      wps.splice(k + 1, 0, w);
    } else wps.push(w);
  }, { reroute: true });
  E.sel = { kind: 'wp', id: w.id };
  renderAll();
}

function deleteWaypoint(id) {
  if (E.sel?.id === id) E.sel = null;
  change(() => { E.route.waypoints = E.route.waypoints.filter((w) => w.id !== id); }, { reroute: true });
}

function snapToRoute(ll) {
  const g = E.route.route?.geometry;
  if (!g?.length || g.length < 2) return { lat: ll[0], lng: ll[1], at: 0, bearing: 0, off: true };
  const p = project(g, E.cum, ll);
  const on = p.dist < 60;
  const pt = on ? p.point : ll;
  return { lat: round6(pt[0]), lng: round6(pt[1]), at: Math.round(p.at), bearing: Math.round(bearingAt(g, E.cum, p.at)), off: !on };
}

function placeAnnotation(type, ll, keepMode) {
  const s = snapToRoute(ll);
  if (type === 'roundabout') {
    const near = E.route.annotations.find((a) => a.type === 'roundabout' && Math.abs((a.at ?? -1e9) - s.at) < 50);
    if (near) {
      select('ann', near.id);
      setMode('browse');
      return toast('这里已经有自动识别的环岛，已选中它：可以直接补充截图、备注，或修改出口/车道。', '', 5000);
    }
  }
  const T = TYPES[type];
  const a = { id: uid('a'), type, lat: s.lat, lng: s.lng, at: s.at, bearing: s.bearing, level: T.level, title: '', note: '', t: currentTime(), auto: false };
  if (type === 'speed') a.speed = speedAround(s.at) ?? 30;
  if (type === 'roundabout') a.rb = synthRb(2, 12);
  change(() => { E.route.annotations.push(a); E.route.annotations.sort(byAt); });
  if (s.off) toast('离路线超过 60 米，标注放在了点击的位置', '', 3500);
  select('ann', a.id);
  if (!keepMode) setMode('browse');
}

const byAt = (x, y) => (x.at ?? 0) - (y.at ?? 0);

function speedAround(at) {
  const prev = E.route.annotations.filter((a) => a.type === 'speed' && a.speed && (a.at ?? 0) <= at).pop();
  return prev ? prev.speed : null;
}

/** Roundabout data for a manually placed roundabout: exits spread evenly up to the chosen clock position. */
function synthRb(exit, clock) {
  const s = (clock % 12) * 30;
  let d = norm360(s - 180);
  if (d < 20) d = 359;
  const arms = [];
  for (let k = 1; k <= exit; k++) arms.push({ s: Math.round(norm360(180 + (d * k) / exit)), no: k, ...(k === exit ? { isExit: true } : {}) });
  const dir = d < 135 ? 'left' : d <= 200 ? 'ahead' : d < 330 ? 'right' : 'uturn';
  const rule = exit === 1 ? 'first' : dir === 'right' || dir === 'uturn' ? 'right' : 'intermediate';
  return { kind: 'roundabout', name: '', exit, counted: exit, clock, dir, rule, arms, lanes: null, signalised: false, fromRoad: '', toRoad: '', manual: true };
}

function onAnnDrag(id, latlng) {
  const a = findAnn(id);
  if (!a) return;
  const s = snapToRoute([latlng.lat, latlng.lng]);
  change(() => { Object.assign(a, { lat: s.lat, lng: s.lng, at: s.at, bearing: s.bearing }); if (a.auto) a.edited = true; E.route.annotations.sort(byAt); });
}

// ---------------------------------------------------------------- selection & modes
const findAnn = (id) => E.route.annotations.find((a) => a.id === id);
const findWp = (id) => E.route.waypoints.find((w) => w.id === id);
const selAnn = () => (E.sel?.kind === 'ann' ? findAnn(E.sel.id) : null);

function select(kind, id, { seek = false } = {}) {
  E.sel = id ? { kind, id } : null;
  if (kind === 'ann') E.tab = 'ann';
  if (kind === 'wp') E.tab = 'wp';
  renderAll();
  const item = kind === 'ann' ? findAnn(id) : findWp(id);
  if (!item) return;
  if (seek && E.video) {
    const t = item.t ?? (kind === 'ann' ? E.timeline.timeAt(item.at) : null);
    if (t != null) E.video.seek(t);
  }
  if (!map.getBounds().pad(-0.1).contains([item.lat, item.lng])) map.panTo([item.lat, item.lng]);
  // bring the edit form (annotations) or the selected row (waypoints) into view
  setTimeout(() => {
    const ed = $('.editor');
    if (ed) ed.scrollIntoView({ block: 'start' });
    else $('.item.sel')?.scrollIntoView({ block: 'nearest' });
  }, 0);
}

function setMode(mode, type = null) {
  E.mode = mode; E.placeType = type;
  $$('.tool[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $$('#type-tools .tool').forEach((b) => b.setAttribute('aria-pressed', String(mode === 'place' && b.dataset.type === type)));
  map.getContainer().classList.toggle('mode-place', mode !== 'browse');
  $('#mode-hint').innerHTML = mode === 'waypoint'
    ? '<b>加途经点</b>：在地图上点车辆<b>驶入的那条路</b>（会记录当前视频时间）。Shift+点击 = 插入到最近的路段；拖动调整；右键删除。'
    : mode === 'place'
      ? `<b>放置「${esc(TYPES[type].zh)}」</b>：点地图（会吸附到路线上，并记录视频时间）。按住 Shift 可连续放置，Esc 取消。`
      : '点标注查看/编辑；点路线跳到视频里对应的时间。';
}
$$('.tool[data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$('#type-tools').onclick = (e) => {
  const b = e.target.closest('[data-type]');
  if (b) setMode(E.mode === 'place' && E.placeType === b.dataset.type ? 'browse' : 'place', b.dataset.type);
};
setMode('browse');

// ---------------------------------------------------------------- rendering
function renderAll() {
  if (!E.route) return;
  routeLayer.set(E.route.route?.geometry || []);
  renderWaypoints();
  annLayer.selectedId = E.sel?.kind === 'ann' ? E.sel.id : null;
  annLayer.set(E.route.annotations);
  $('#cnt-ann').textContent = E.route.annotations.length || '';
  $('#cnt-wp').textContent = E.route.waypoints.length || '';
  renderSide();
}

function renderWaypoints() {
  wpLayer.clearLayers();
  E.route.waypoints.forEach((w, i) => {
    const sel = E.sel?.kind === 'wp' && E.sel.id === w.id;
    const icon = L.divIcon({ className: '', html: `<div class="wp ${w.t != null ? 'timed' : ''} ${sel ? 'sel' : ''}">${i + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
    const m = L.marker([w.lat, w.lng], { icon, draggable: true, zIndexOffset: 4000, keyboard: false, title: `途经点 ${i + 1}${w.t != null ? ` · ${fmtTime(w.t)}` : ''}（右键删除）` });
    m.on('click', (e) => { L.DomEvent.stop(e); select('wp', w.id, { seek: true }); });
    m.on('dragend', () => { const ll = m.getLatLng(); change(() => { w.lat = round6(ll.lat); w.lng = round6(ll.lng); }, { reroute: true }); });
    m.on('contextmenu', (e) => { L.DomEvent.stop(e); deleteWaypoint(w.id); });
    m.addTo(wpLayer);
  });
}

$('#side-tabs').onclick = (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  E.tab = b.dataset.tab;
  renderSide();
};

function renderSide() {
  $$('#side-tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === E.tab)));
  const body = $('#side-body');
  const scroll = body.scrollTop;
  if (E.tab === 'ann') body.innerHTML = (selAnn() ? annEditorHtml(selAnn()) : '') + annListHtml();
  else if (E.tab === 'wp') body.innerHTML = wpHtml();
  else if (E.tab === 'steps') body.innerHTML = stepsHtml();
  else body.innerHTML = infoHtml();
  body.scrollTop = scroll;
}

const ANN_FILTERS = {
  all: ['全部', () => true],
  manual: ['手动', (a) => !a.auto],
  todo: ['待核对', (a) => a.auto && !a.confirmed],
  hot: ['易错', (a) => (a.level || 1) >= 3],
  noimg: ['无截图', (a) => !a.image && (a.level || 1) >= 2],
};

function annListHtml() {
  const list = E.route.annotations;
  if (!list.length) {
    return `<div class="empty small">还没有标注。<br>按数字键选择类型后点地图放置，或者在路线画好后点顶部的"自动识别"。</div>`;
  }
  const f = ANN_FILTERS[E.annFilter] || ANN_FILTERS.all;
  const chips = Object.entries(ANN_FILTERS).map(([k, [label, fn]]) => `<button class="chip" data-af="${k}" aria-pressed="${E.annFilter === k}">${label} ${list.filter(fn).length}</button>`).join('');
  const items = list.filter(f[1]).map((a) => {
    const T = TYPES[a.type] || TYPES.note;
    const flags = [
      a.auto ? `<span class="badge ${a.confirmed ? 'ok' : 'auto'}">${a.confirmed ? '已核对' : '自动'}</span>` : '',
      a.image ? '<span class="badge">图</span>' : '',
      a.stale || a.offRoute ? '<span class="badge l2">偏离</span>' : '',
    ].join('');
    const t = a.t ?? E.timeline.timeAt(a.at);
    return `<div class="item ${E.sel?.id === a.id ? 'sel' : ''}" data-ann="${esc(a.id)}">${markerHtml(a)}
      <div style="min-width:0"><b>${esc(titleOf(a))}</b><small>${esc(T.zh)}${t != null ? ` · ${a.t == null ? '≈' : ''}${fmtTime(t)}` : ''} <span class="flags">${flags}</span></small></div>
      <div class="r">${fmtDist(a.at)}</div></div>`;
  }).join('');
  return `<div class="filter-row">${chips}</div><div class="items">${items || '<div class="empty small">没有符合条件的标注</div>'}</div>`;
}

function annEditorHtml(a) {
  const T = TYPES[a.type] || TYPES.note;
  const typeOpts = TYPE_KEYS.map((k) => `<option value="${k}" ${k === a.type ? 'selected' : ''}>${esc(TYPES[k].zh)}</option>`).join('');
  const lvl = a.level || 1;
  let special = '';
  if (a.type === 'speed') {
    special = `<div class="grid2"><label class="field">限速 (mph)<select data-f="speed">${[10, 20, 30, 40, 50, 60, 70].map((v) => `<option ${v === a.speed ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field">之前的限速<select data-f="prevSpeed"><option value="">—</option>${[10, 20, 30, 40, 50, 60, 70].map((v) => `<option ${v === a.prevSpeed ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>`;
  } else if (a.type === 'roundabout' && a.rb) {
    const adv = roundaboutAdvice(a.rb);
    special = `<div class="rb-block">${roundaboutSvg(a.rb, { size: 120 })}<div class="advice"><b>${esc(adv.clockLine)}</b><ol>${adv.lines.slice(0, 3).map((l) => `<li>${esc(l)}</li>`).join('')}</ol></div></div>
      <div class="grid2"><label class="field">第几出口<input type="number" min="1" max="8" data-f="rb.exit" value="${a.rb.exit}"></label>
      <label class="field">出口钟点方向（12 = 正前方）<input type="number" min="1" max="12" data-f="rb.clock" value="${a.rb.clock}"></label></div>
      ${a.rb.lanes ? `<div class="row">${lanesHtml(a.rb.lanes)}<span class="small muted">地图车道数据</span></div>` : ''}`;
  } else if (a.lanes) {
    special = `<div class="row">${lanesHtml(a.lanes)}<span class="small muted">${esc(lanesText(a.lanes))}</span></div>`;
  }
  const t = a.t;
  const img = a.image
    ? `<img src="${esc(a.image)}" alt="截图" data-a="zoom">`
    : '<span>Ctrl+V 粘贴截图 · 拖入图片 · 按 C 截取视频画面</span>';
  return `<div class="editor" data-editor="${esc(a.id)}">
    <div class="row">${markerHtml(a)}<b class="grow ellipsis">${esc(titleOf(a))}</b><span class="small faint">起点后 ${fmtDist(a.at)}</span><button class="btn sm icon ghost" data-a="close" title="取消选择 (Esc)">✕</button></div>
    ${a.auto ? `<div class="row small"><span class="badge ${a.confirmed ? 'ok' : 'auto'}">${a.confirmed ? '自动识别 · 已核对' : '自动识别（OSM）· 待核对'}</span><span class="grow"></span><button class="btn sm ${a.confirmed ? '' : 'primary'}" data-a="confirm">${a.confirmed ? '取消核对' : '✓ 与视频一致'}</button></div>` : ''}
    <div class="grid2"><label class="field">类型<select data-f="type">${typeOpts}</select></label>
      <div class="field">重要度<div class="seg" data-f="level">${[1, 2, 3].map((v) => `<button data-v="${v}" aria-pressed="${v === lvl}">${LEVELS[v].zh}</button>`).join('')}</div></div></div>
    <label class="field">标题<input type="text" data-f="title" value="${esc(a.title || '')}" placeholder="${esc(defaultTitle(a))}"></label>
    ${special}
    <label class="field">备注（易错点、教练提醒、视频里看到的细节）<textarea data-f="note" rows="3">${esc(a.note || '')}</textarea></label>
    <label class="field">语音（英文，可选；留空用默认）<input type="text" lang="en-GB" data-f="say" value="${esc(a.say || '')}" placeholder="${esc(voicePlaceholder(a))}"></label>
    ${['roundabout', 'manoeuvre'].includes(a.type) ? '' : `<label class="check small"><input type="checkbox" data-f="sayAsExaminer" ${a.sayAsExaminer ? 'checked' : ''}> 这是考官说的话（模拟考试模式也播；不勾选则只在练习模式作为提示）</label>`}
    <div class="row small"><span class="muted">视频时间</span><input type="text" class="mono" style="width:84px" data-f="t" value="${t != null ? fmtTime(t) : ''}" placeholder="mm:ss">
      <button class="btn sm" data-a="t-now" title="T">设为当前</button><button class="btn sm" data-a="t-go" ${t == null ? 'disabled' : ''}>跳转</button></div>
    <div class="img-slot" data-drop>${img}</div>
    <div class="row wrap"><button class="btn sm" data-a="shot">${UI.camera}截图</button><button class="btn sm" data-a="upload">${UI.upload}上传图片</button>
      ${a.image ? `<button class="btn sm" data-a="img-del">删除图片</button>` : ''}
      <span class="grow"></span><a class="btn sm" href="${streetViewUrl(a.lat, a.lng, a.bearing || 0)}" target="_blank" rel="noopener">${UI.street}街景</a>
      <button class="btn sm danger" data-a="del">${UI.trash}删除</button></div>
    ${a.stale ? '<div class="warn-box">路线修改后，这个自动识别点已不在新路线上。确认无用就删除。</div>' : ''}
    ${a.offRoute ? '<div class="warn-box">这个标注离路线超过 40 米，可以拖动它到路线上。</div>' : ''}
  </div>`;
}

function wpHtml() {
  const wps = E.route.waypoints;
  const warns = (E.route.route?.warnings || []).map((w, i) => `<div class="warn-box row">⚠ ${esc(w.msg)}（起点后 ${fmtDist(w.at)}）<span class="grow"></span><button class="btn sm" data-warn="${i}">定位</button></div>`).join('');
  const r = E.route.route;
  const head = `<p class="small muted">途经点按顺序连成路线，自动沿道路吸附。带时间的途经点（蓝色）让地图小车跟着视频走。${r ? `<br>当前路线 ${fmtDist(r.distance)} · 约 ${fmtDuration(r.duration)}` : ''}</p>`;
  const items = wps.map((w, i) => `<div class="item ${E.sel?.id === w.id ? 'sel' : ''}" data-wp="${esc(w.id)}">
      <div class="wp ${w.t != null ? 'timed' : ''}" style="margin:auto">${i + 1}</div>
      <div><b>${esc(w.label || `途经点 ${i + 1}`)}</b><small class="mono">${w.lat.toFixed(5)}, ${w.lng.toFixed(5)}</small></div>
      <div class="row"><input type="text" class="mono" style="width:70px" data-wpt="${esc(w.id)}" value="${w.t != null ? fmtTime(w.t) : ''}" placeholder="时间" title="视频时间 mm:ss">
        <button class="btn sm icon" data-wpnow="${esc(w.id)}" title="设为当前视频时间">⏱</button>
        <button class="btn sm icon danger" data-wpdel="${esc(w.id)}" title="删除">✕</button></div></div>`).join('');
  return head + warns + `<div class="items">${items}</div>`;
}

function stepsHtml() {
  const ins = buildInstructions(E.route, { keepMuted: true });
  if (!ins.length) return '<div class="empty small">路线生成后显示指令</div>';
  const head = `<p class="small muted">考官会说的话（英文语音按这个顺序播报）。可以把自动生成的句子改成视频里考官的原话；不需要的指令点 ${UI.speaker} 静音。</p>`;
  const warn = E.route.route?.sideRoads ? '' : '<div class="warn-box small">还没运行过「自动识别」：判断 "next road / second road" 时会把小路、停车场入口也算进去。运行一次自动识别会准确很多。</div>';
  return head + warn + `<div class="items">${ins.map((s, i) => {
    const t = E.timeline.timeAt(s.at);
    const early = s.sayAt != null && s.at - s.sayAt >= 10 ? `<br>提前 ${fmtDist(s.at - s.sayAt)}` : '';
    const edit = s.key
      ? `<div class="voice-edit"><input type="text" data-voice="${esc(s.key)}" value="${esc(s.custom ? s.en : '')}" placeholder="${esc(s.auto || s.en)}" title="改成视频里考官的原话；留空就用自动生成的句子">
          <button class="btn sm icon ${s.muted ? 'danger' : 'ghost'}" data-vmute="${esc(s.key)}" title="${s.muted ? '已静音，点一下恢复' : '静音这条指令'}">${s.muted ? UI.speakerOff : UI.speaker}</button></div>`
      : `<small><i>${esc(s.en)}</i></small>`;
    return `<div class="item ${s.muted ? 'muted-row' : ''}" data-step="${i}"><div class="wp" style="margin:auto;background:${s.icon === ARROW.roundabout ? '#1565c0' : '#455a64'}">${esc(s.icon)}</div>
      <div style="min-width:0"><b>${esc(s.zh)}${s.road ? ` <span class="faint">· ${esc(s.road)}</span>` : ''}</b>${edit}</div><div class="r">${fmtDist(s.at)}${t != null ? `<br>≈${fmtTime(t)}` : ''}${early}</div></div>`;
  }).join('')}</div>`;
}

/** User override of the examiner's words at one junction: {say?, mute?}. */
function setVoice(key, patch) {
  const all = (E.route.voice ??= {});
  const v = { ...(all[key] || {}), ...patch };
  if (!v.say?.trim()) delete v.say;
  if (!v.mute) delete v.mute;
  if (Object.keys(v).length) all[key] = v; else delete all[key];
}

function infoHtml() {
  const r = E.route;
  const counts = {};
  for (const a of r.annotations) counts[a.type] = (counts[a.type] || 0) + 1;
  return `<div class="info-form">
    <label class="field">YouTube 链接<input type="url" data-info="url" value="${esc(r.video?.url || '')}"></label>
    <label class="field">视频标题 / 频道（备忘）<input type="text" data-info="vtitle" value="${esc(r.video?.title || '')}"></label>
    <label class="field">路线备注（会显示在手机端顶部）<textarea data-info="notes" rows="4">${esc(r.notes || '')}</textarea></label>
    <div class="opt"><h4>统计</h4><p>${r.route ? `${fmtDist(r.route.distance)} · 约 ${fmtDuration(r.route.duration)} · ` : ''}${r.waypoints.length} 个途经点 · ${r.annotations.length} 个标注</p>
      <p>${Object.entries(counts).map(([k, n]) => `${esc(TYPES[k]?.zh || k)} ${n}`).join(' · ')}</p></div>
    <div class="opt"><h4>数据位置</h4><p>${esc(store.where)}${store.writable ? `：app/data/routes/${esc(r.id)}.json` : ''}</p></div>
    <div class="row"><button class="btn sm danger" data-a="del-route">${UI.trash}删除这条路线</button></div>
  </div>`;
}

// ---------------------------------------------------------------- side panel events
const sideBody = $('#side-body');
sideBody.addEventListener('click', async (e) => {
  const af = e.target.closest('[data-af]');
  if (af) { E.annFilter = af.dataset.af; return renderSide(); }
  const act = e.target.closest('[data-a]')?.dataset.a;
  const a = selAnn();
  if (act) {
    if (act === 'close') { E.sel = null; return renderAll(); }
    if (act === 'del' && a) return deleteAnn(a.id);
    if (act === 'confirm' && a) return change(() => { a.confirmed = !a.confirmed; });
    if (act === 't-now' && a) return setSelTimeNow();
    if (act === 't-go' && a && a.t != null) return E.video?.seek(a.t);
    if (act === 'shot') return capture();
    if (act === 'upload') return $('#img-file').click();
    if (act === 'img-del' && a) return change(() => { a.image = null; });
    if (act === 'zoom') return lightbox(e.target.src);
    if (act === 'del-route') return deleteRoute();
  }
  const seg = e.target.closest('.seg[data-f="level"] button');
  if (seg && a) return change(() => { a.level = +seg.dataset.v; if (a.auto) a.edited = true; });
  const annRow = e.target.closest('[data-ann]');
  if (annRow) return select('ann', annRow.dataset.ann, { seek: true });
  const wpdel = e.target.closest('[data-wpdel]');
  if (wpdel) return deleteWaypoint(wpdel.dataset.wpdel);
  const wpnow = e.target.closest('[data-wpnow]');
  if (wpnow) { const w = findWp(wpnow.dataset.wpnow); const t = currentTime(); if (w && t != null) change(() => { w.t = t; }); return; }
  const wpRow = e.target.closest('[data-wp]');
  if (wpRow && !e.target.closest('input')) return select('wp', wpRow.dataset.wp, { seek: true });
  const vm = e.target.closest('[data-vmute]');
  if (vm) {
    const key = vm.dataset.vmute;
    return change(() => setVoice(key, { mute: !E.route.voice?.[key]?.mute }));
  }
  const st = e.target.closest('[data-step]');
  if (st && !e.target.closest('input')) {
    const s = buildInstructions(E.route, { keepMuted: true })[+st.dataset.step];
    if (!s) return;
    map.panTo(s.loc);
    const t = E.timeline.timeAt(s.at);
    if (t != null) E.video?.seek(t);
    return;
  }
  const wn = e.target.closest('[data-warn]');
  if (wn) { const w = E.route.route.warnings[+wn.dataset.warn]; map.setView(w.loc, 18); }
});

// text inputs: live update without re-render (keeps focus); one undo step per field edit
sideBody.addEventListener('focusin', (e) => { if (e.target.matches('[data-f], [data-info], [data-wpt], [data-voice]')) pushUndo(); });
sideBody.addEventListener('input', (e) => {
  const a = selAnn();
  const f = e.target.dataset.f;
  if (a && (f === 'title' || f === 'note' || f === 'say')) { a[f] = e.target.value; if (a.auto) a.edited = true; markDirty(); }
  const info = e.target.dataset.info;
  if (info === 'notes') { E.route.notes = e.target.value; markDirty(); }
  if (info === 'vtitle') { E.route.video.title = e.target.value; markDirty(); }
  const vk = e.target.dataset.voice;
  if (vk) { setVoice(vk, { say: e.target.value }); markDirty(); }
});
sideBody.addEventListener('change', (e) => {
  const a = selAnn();
  const f = e.target.dataset.f;
  if (e.target.dataset.voice) return renderSide(); // a custom line can split a combined instruction
  if (a && f) {
    if (f === 'type') { a.type = e.target.value; a.level = Math.max(a.level || 1, 1); if (a.type === 'roundabout' && !a.rb) a.rb = synthRb(2, 12); if (a.type === 'speed' && !a.speed) a.speed = 30; }
    else if (f === 'speed' || f === 'prevSpeed') a[f] = e.target.value ? +e.target.value : null;
    else if (f === 'sayAsExaminer') a.sayAsExaminer = e.target.checked;
    else if (f === 't') { const t = parseTime(e.target.value); a.t = t; }
    else if (f === 'rb.exit' || f === 'rb.clock') {
      const exit = Math.max(1, Math.min(8, +$('[data-f="rb.exit"]').value || 1));
      const clock = Math.max(1, Math.min(12, +$('[data-f="rb.clock"]').value || 12));
      const keep = a.rb && !a.rb.manual ? { lanes: a.rb.lanes, fromRoad: a.rb.fromRoad, toRoad: a.rb.toRoad, signalised: a.rb.signalised, kind: a.rb.kind, name: a.rb.name, fromAt: a.rb.fromAt, toAt: a.rb.toAt, centre: a.rb.centre } : {};
      a.rb = { ...synthRb(exit, clock), ...keep, manual: true };
      a.rbEdited = true;
    }
    if (a.auto) a.edited = true;
    refreshDerived(); renderAll(); markDirty();
    return;
  }
  const wpt = e.target.dataset.wpt;
  if (wpt) { const w = findWp(wpt); if (w) { w.t = parseTime(e.target.value); refreshDerived(); renderAll(); markDirty(); } return; }
  const info = e.target.dataset.info;
  if (info === 'url') {
    const url = e.target.value.trim();
    E.route.video = { ...E.route.video, url, youtubeId: parseYouTubeId(url) };
    $('#video-url').value = url;
    markDirty();
  }
});

// drag & drop images onto the editor's image slot
sideBody.addEventListener('dragover', (e) => { const s = e.target.closest('[data-drop]'); if (s) { e.preventDefault(); s.classList.add('drag'); } });
sideBody.addEventListener('dragleave', (e) => e.target.closest('[data-drop]')?.classList.remove('drag'));
sideBody.addEventListener('drop', async (e) => {
  const s = e.target.closest('[data-drop]');
  if (!s) return;
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
  if (f && selAnn()) await attachImage(selAnn(), f);
});
$('#img-file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f && selAnn()) await attachImage(selAnn(), f);
};

function deleteAnn(id) {
  const a = findAnn(id);
  if (!a) return;
  change(() => {
    E.route.annotations = E.route.annotations.filter((x) => x.id !== id);
    if (a.auto && a.key) (E.route.dismissed ??= []).push(a.key);
  });
  E.sel = null;
  renderAll();
}

function deleteSelected() {
  if (E.sel?.kind === 'ann') deleteAnn(E.sel.id);
  else if (E.sel?.kind === 'wp') deleteWaypoint(E.sel.id);
}

function setSelTimeNow() {
  const t = currentTime();
  if (t == null) return toast('先加载视频');
  const a = selAnn();
  const w = E.sel?.kind === 'wp' ? findWp(E.sel.id) : null;
  if (a) change(() => { a.t = t; });
  else if (w) change(() => { w.t = t; });
}

function stepAnn(d) {
  const list = E.route.annotations;
  if (!list.length) return;
  const i = list.findIndex((a) => a.id === E.sel?.id);
  const n = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + d))];
  select('ann', n.id, { seek: true });
}

async function deleteRoute() {
  if (!confirm(`删除路线「${E.route.name}」？（服务器模式下会移到 app/data/trash）`)) return;
  await store.remove(E.route.id);
  E.dirty = false;
  const list = await loadRouteList();
  if (list.length) await openRoute(list[0].id);
  else openNewDialog();
}

// ---------------------------------------------------------------- screenshots
async function attachImage(a, blob) {
  try {
    status('保存截图…');
    const jpg = blob.type === 'image/jpeg' && blob.size < 450_000 ? blob : await toJpeg(blob);
    const path = await store.saveImage(E.route.id, jpg, `${a.id}-${Date.now().toString(36)}.jpg`);
    change(() => { a.image = path; if (a.auto) a.edited = true; });
    toast('截图已保存', 'ok', 1500);
  } catch (e) {
    toast(`截图失败：${e.message}`, 'err');
  } finally { status(null); }
}

/** Annotation to receive a capture: the selected one, or a new note at the car's position. */
function targetForCapture() {
  const a = selAnn();
  if (a) return a;
  const at = E.video && E.timeline.covers(E.video.time) ? E.timeline.atTime(E.video.time) : null;
  if (at == null) { toast('先选中一个标注（或先放置一个标注）'); return null; }
  const p = pointAt(E.route.route.geometry, E.cum, at);
  const n = { id: uid('a'), type: 'note', lat: round6(p[0]), lng: round6(p[1]), at: Math.round(at), bearing: Math.round(bearingAt(E.route.route.geometry, E.cum, at)), level: 2, title: '', note: '', t: currentTime(), auto: false };
  change(() => { E.route.annotations.push(n); E.route.annotations.sort(byAt); });
  select('ann', n.id);
  return n;
}

async function capture() {
  if (!E.video) return toast('先加载视频');
  let blob;
  try {
    if (E.video.kind === 'file') blob = await E.video.capture();
    else if (E.cap.active) blob = await E.cap.capture(E.video.frameEl);
    else return toast('YouTube 画面需要先点"开启一键截图"；或用 Win+Shift+S 截图后 Ctrl+V 粘贴', '', 5000);
  } catch (e) { return toast(e.message, 'err', 5000); }
  const a = targetForCapture();
  if (a) await attachImage(a, blob);
}
$('#btn-shot').onclick = capture;

$('#btn-tabcap').onclick = async () => {
  if (E.cap.active) { E.cap.stop(); updateCapBtn(); return; }
  if (!TabCapture.supported()) return toast('这个浏览器不支持标签页共享，请用 Chrome / Edge', 'err');
  try {
    await E.cap.start();
    toast('已开启：按 C 或点"截图"即可截取视频画面', 'ok', 4000);
  } catch { toast('没有开启（已取消）'); }
  updateCapBtn();
};
function updateCapBtn() {
  const b = $('#btn-tabcap');
  b.classList.toggle('on', E.cap.active);
  b.textContent = E.cap.active ? '一键截图：已开启' : '开启一键截图';
}
setInterval(updateCapBtn, 3000);

document.addEventListener('paste', async (e) => {
  if (isTyping(e) && !e.clipboardData?.files?.length) return;
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (!f) return;
  e.preventDefault();
  const a = targetForCapture();
  if (a) await attachImage(a, f);
});

// ---------------------------------------------------------------- video
async function loadYouTube(id, start) {
  E.video?.destroy();
  E.video = new YouTubeSource($('#video-box'), { onError: (m) => toast(m, 'err', 7000), onState: updatePlayBtn });
  try { await E.video.load(id, start || 0); } catch (e) { toast(e.message, 'err'); }
  E.video.setRate(+$('#v-rate').value);
}

$('#btn-load-yt').onclick = () => {
  const url = $('#video-url').value.trim();
  const id = parseYouTubeId(url);
  if (!id) return toast('无法识别 YouTube 链接', 'err');
  const start = parseYouTubeStart(url);
  change(() => { E.route.video = { ...E.route.video, youtubeId: id, url }; });
  loadYouTube(id, start ?? E.route.video.start ?? 0);
};
$('#video-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-load-yt').click(); });

$('#video-file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  E.video?.destroy();
  E.video = new FileSource($('#video-box'), { onState: updatePlayBtn });
  await E.video.load(f);
  E.video.setRate(+$('#v-rate').value);
  toast('本地视频：按 C 可直接截图', 'ok');
};

function updatePlayBtn() { $('#v-play').innerHTML = E.video?.playing ? UI.pause : UI.play; }
const seekBy = (d) => { if (E.video) E.video.seek(E.video.time + d); };
$('#v-play').onclick = () => E.video?.toggle();
$('#v-back').onclick = () => seekBy(-5);
$('#v-fwd').onclick = () => seekBy(5);
$('#v-rate').onchange = (e) => E.video?.setRate(+e.target.value);

$('#btn-start-time').onclick = () => {
  const t = currentTime();
  if (t == null) return toast('先加载视频，播放到车辆出发的时刻');
  const w = E.route.waypoints[0];
  change(() => { E.route.video.start = t; if (w) w.t = t; });
  toast(`出发时刻 = ${fmtTime(t)}`, 'ok');
};
$('#btn-back-centre').onclick = () => {
  const w = { id: uid('w'), lat: CENTRE.lat, lng: CENTRE.lng, t: currentTime(), label: '回到考场' };
  change(() => { E.route.waypoints.push(w); }, { reroute: true });
};

// car marker follows the video
let lastFollow = 0;
setInterval(() => {
  if (!E.video || !E.route) return;
  const t = E.video.time;
  $('#v-time').textContent = fmtTime(t);
  updatePlayBtn();
  if (!E.timeline.covers(t)) { car.hide(); return; }
  const at = E.timeline.atTime(t);
  const g = E.route.route.geometry;
  const p = pointAt(g, E.cum, at);
  car.set(p, bearingAt(g, E.cum, at));
  if ($('#v-follow').checked && E.video.playing && Date.now() - lastFollow > 1500 && !map.getBounds().pad(-0.25).contains(p)) {
    lastFollow = Date.now();
    map.panTo(p, { animate: true, duration: 0.6 });
  }
}, 250);

// ---------------------------------------------------------------- top bar
$('#route-name').addEventListener('input', (e) => { E.route.name = e.target.value; markDirty(); });

$('#btn-auto').onclick = async () => {
  if (!E.route.route) return toast('先添加途经点生成路线', 'err');
  const btn = $('#btn-auto');
  btn.disabled = true;
  status('正在从 OpenStreetMap 识别注意点…（通常 5–30 秒）');
  try {
    const res = await autoDetect(E.route, { onStatus: status });
    let m;
    change(() => {
      m = mergeAuto(E.route, res.annotations);
      E.route.annotations = m.annotations;
      if (res.sideRoads) E.route.route.sideRoads = res.sideRoads; // for "next / second road on the left"
    });
    if (res.osmError) toast(`OSM 数据获取失败（${res.osmError}），只识别了环岛和车道。稍后可以再试一次。`, 'err', 7000);
    toast(`自动识别完成：新增 ${m.added}，更新 ${m.updated}，移除 ${m.removed}${m.kept ? `，保留 ${m.kept} 个已编辑的旧点` : ''}`, 'ok', 5000);
    E.annFilter = 'todo';
    E.tab = 'ann';
    renderSide();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    status(null);
  }
};

$('#btn-help').onclick = () => $('#dlg-help').showModal();
$$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === d) d.close(); }));

$('#btn-export').onclick = () => {
  const parts = E.route.route ? googleMapsParts(E.route, { mode: 'waypoints' }) : [];
  $('#gm-links').innerHTML = parts.length
    ? parts.map((p) => `<div class="row"><a href="${esc(p.url)}" target="_blank" rel="noopener">第 ${p.index} 段（${fmtDist(p.from)}–${fmtDist(p.to)}，${p.waypoints} 个途经点）</a></div>`).join('')
    : '<span class="muted">先生成路线</span>';
  $('#dlg-export').showModal();
};
$('#dlg-export').addEventListener('click', async (e) => {
  const x = e.target.closest('[data-x]')?.dataset.x;
  if (!x) return;
  await flushSave();
  const r = E.route;
  const base = safeFileName(r.name);
  try {
    if (x === 'pack') download(`${base}.route.json`, JSON.stringify(await store.exportPack([r.id])), 'application/json');
    if (x === 'pack-all') { const ids = (await store.list()).map((s) => s.id); download(`driving-routes-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await store.exportPack(ids)), 'application/json'); }
    if (x === 'gpx') download(`${base}.gpx`, toGPX(r, { lang: settings.get('gpxLang', 'zh') }), 'application/gpx+xml');
    if (x === 'kml') download(`${base}.kml`, toKML(r), 'application/vnd.google-earth.kml+xml');
    if (x === 'geojson') download(`${base}.geojson`, JSON.stringify(toGeoJSON(r)), 'application/geo+json');
  } catch (err) { toast(err.message, 'err'); }
});
$('#pack-file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const routes = await store.importPack(JSON.parse(await f.text()));
    await loadRouteList(E.route?.id);
    toast(`已导入 ${routes.length} 条路线`, 'ok');
  } catch (err) { toast(`导入失败：${err.message}`, 'err'); }
};

// ---------------------------------------------------------------- geocoder (Nominatim, on Enter only)
$('#geo-q').addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') { $('#geo-results').classList.add('hidden'); return; }
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (!q) return;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=gb&viewbox=-0.05,52.35,0.35,52.12&bounded=1&q=${encodeURIComponent(q)}`;
    const list = await (await fetch(url, { headers: { 'Accept-Language': 'en' } })).json();
    const box = $('#geo-results');
    box.innerHTML = list.length ? list.map((x) => `<button data-ll="${x.lat},${x.lon}">${esc(x.display_name.split(',').slice(0, 3).join(','))}</button>`).join('') : '<button disabled>没有找到</button>';
    box.classList.remove('hidden');
  } catch { toast('搜索失败', 'err'); }
});
$('#geo-results').onclick = (e) => {
  const b = e.target.closest('[data-ll]');
  if (!b) return;
  map.setView(b.dataset.ll.split(',').map(Number), 17);
  $('#geo-results').classList.add('hidden');
};

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', (e) => {
  if (isTyping(e)) { if (e.key === 'Escape') e.target.blur(); return; }
  if (document.querySelector('dialog[open]')) return;
  const k = e.key;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && k.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod && k.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
  if (mod && k.toLowerCase() === 's') { e.preventDefault(); return flushSave(); }
  if (mod || e.altKey) return;
  if (k === ' ') { e.preventDefault(); E.video?.toggle(); }
  else if (k === 'ArrowLeft') { e.preventDefault(); seekBy(e.shiftKey ? -1 : -5); }
  else if (k === 'ArrowRight') { e.preventDefault(); seekBy(e.shiftKey ? 1 : 5); }
  else if (k === 'w' || k === 'W') setMode(E.mode === 'waypoint' ? 'browse' : 'waypoint');
  else if (k === 'Escape') { setMode('browse'); if (E.sel) { E.sel = null; renderAll(); } }
  else if (/^[0-9]$/.test(k)) { const type = TYPE_KEYS.find((t) => TYPES[t].key === k); if (type) setMode('place', type); }
  else if (k === 'Delete' || k === 'Backspace') deleteSelected();
  else if (k === 'c' || k === 'C') capture();
  else if (k === 't' || k === 'T') setSelTimeNow();
  else if (k === '[' || k === ']') stepAnn(k === ']' ? 1 : -1);
});

function status(msg) {
  const el = $('#map-status');
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

// ---------------------------------------------------------------- start
const list = await loadRouteList();
let startId = new URLSearchParams(location.search).get('id') || settings.get('lastRoute', null);
if (!list.some((s) => s.id === startId)) startId = (list.find((s) => !s.demo) || list[0])?.id;
if (startId) await openRoute(startId);
else openNewDialog();
void DIR_ZH;
