/* global L */
// Leaflet helpers: base layers, route line with direction arrows, annotation markers.
import { bearingAt, cumulative, haversine, pointAt, slice } from '../core/geo.js';
import { markerHtml, markerSize, UI } from './icons.js';
import { titleOf } from '../core/model.js';
import { settings } from './util.js';

// crossOrigin: tiles are fetched in CORS mode so the service worker can cache them
// without opaque-response quota padding.
const BASES = {
  osm: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 20, maxNativeZoom: 19, crossOrigin: true,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }),
  sat: () => L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, maxNativeZoom: 19, crossOrigin: true, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, maxNativeZoom: 19, opacity: 0.9, crossOrigin: true,
    }),
  ]),
};

export function createMap(el, { center = [52.2333, 0.1357], zoom = 14 } = {}) {
  const map = L.map(el, { zoomControl: false, attributionControl: true, tap: true }).setView(center, zoom);
  L.control.zoom({ position: 'topright' }).addTo(map);
  map.attributionControl.setPrefix('');
  let current = settings.get('base', 'osm');
  if (!BASES[current]) current = 'osm';
  let layer = BASES[current]().addTo(map);
  map.setBase = (key) => {
    if (!BASES[key]) return;
    map.removeLayer(layer);
    layer = BASES[key]().addTo(map);
    current = key;
    settings.set('base', key);
    map.fire('basechange', { key });
  };
  map.getBase = () => current;
  // base-layer toggle button
  const Toggle = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const b = L.DomUtil.create('button', 'map-btn');
      b.type = 'button';
      b.title = '切换地图/卫星图';
      const label = () => { b.innerHTML = `${UI.layers}<span>${current === 'osm' ? '卫星' : '地图'}</span>`; };
      label();
      L.DomEvent.disableClickPropagation(b);
      b.addEventListener('click', () => { map.setBase(current === 'osm' ? 'sat' : 'osm'); label(); });
      return b;
    },
  });
  new Toggle().addTo(map);
  return map;
}

/** Route polyline with white casing, start/finish markers and direction chevrons. */
export class RouteLayer {
  constructor(map, { onClick } = {}) {
    this.map = map;
    this.onClick = onClick;
    this.group = L.layerGroup().addTo(map);
    this.arrowGroup = L.layerGroup().addTo(map);
    this.geom = [];
    this.cum = [0];
    map.on('zoomend', () => this.drawArrows());
  }

  set(geometry) {
    this.geom = geometry || [];
    this.cum = cumulative(this.geom);
    this.group.clearLayers();
    if (this.geom.length < 2) { this.arrowGroup.clearLayers(); return; }
    L.polyline(this.geom, { color: '#ffffff', weight: 11, opacity: 0.95, interactive: false }).addTo(this.group);
    const line = L.polyline(this.geom, { color: '#1e6fd9', weight: 6, opacity: 0.95 }).addTo(this.group);
    if (this.onClick) line.on('click', (e) => { L.DomEvent.stop(e); this.onClick(e.latlng, e.originalEvent); });
    const a = this.geom[0], b = this.geom[this.geom.length - 1];
    const loop = haversine(a, b) < 60;
    const se = (cls, txt) => L.divIcon({ className: '', html: `<div class="se ${cls}">${txt}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
    L.marker(a, { icon: se('start', loop ? '起终' : '起'), interactive: false, zIndexOffset: -500 }).addTo(this.group);
    if (!loop) L.marker(b, { icon: se('end', '终'), interactive: false, zIndexOffset: -500 }).addTo(this.group);
    this.drawArrows();
  }

  drawArrows() {
    this.arrowGroup.clearLayers();
    const total = this.cum[this.cum.length - 1] || 0;
    if (total < 50) return;
    const z = this.map.getZoom();
    if (z < 13) return;
    const spacing = Math.max(60, 180 * 2 ** (16 - z));
    for (let at = spacing / 2; at < total; at += spacing) {
      const p = pointAt(this.geom, this.cum, at);
      const b = bearingAt(this.geom, this.cum, at, 6);
      const icon = L.divIcon({
        className: '',
        html: `<svg class="arrow-ic" viewBox="0 0 24 24" style="transform:rotate(${b.toFixed(0)}deg)"><path d="M5 16l7-7 7 7" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        iconSize: [14, 14], iconAnchor: [7, 7],
      });
      L.marker(p, { icon, interactive: false, keyboard: false, zIndexOffset: -1000 }).addTo(this.arrowGroup);
    }
  }

  bounds() { return this.geom.length ? L.latLngBounds(this.geom) : null; }

  /** Orange overlay for the stretch of route around the selected point (null clears). */
  highlight(fromAt, toAt) {
    if (this.hl) { this.map.removeLayer(this.hl); this.hl = null; }
    const total = this.cum[this.cum.length - 1] || 0;
    if (fromAt == null || this.geom.length < 2) return;
    const a = Math.max(0, fromAt), b = Math.min(total, toAt);
    const seg = slice(this.geom, this.cum, a, b);
    if (seg.length < 2) return;
    const brg = bearingAt(this.geom, this.cum, b - 3, 4);
    const head = L.divIcon({
      className: '',
      html: `<svg viewBox="0 0 24 24" width="22" height="22" style="transform:rotate(${brg.toFixed(0)}deg);filter:drop-shadow(0 0 1.5px #fff)"><path d="M4 18L12 4l8 14-8-4z" fill="#ff6f00" stroke="#fff" stroke-width="1.5"/></svg>`,
      iconSize: [22, 22], iconAnchor: [11, 11],
    });
    this.hl = L.layerGroup([
      L.polyline(seg, { color: '#ffffff', weight: 13, opacity: 1, interactive: false }),
      L.polyline(seg, { color: '#ff6f00', weight: 7, opacity: 1, interactive: false }),
      L.marker(seg[seg.length - 1], { icon: head, interactive: false, zIndexOffset: 1500 }),
    ]).addTo(this.map);
  }
}

/** Annotation markers. */
export class AnnotationLayer {
  constructor(map, { onSelect, draggable = false, onDragEnd } = {}) {
    this.map = map;
    this.onSelect = onSelect;
    this.draggable = draggable;
    this.onDragEnd = onDragEnd;
    this.group = L.layerGroup().addTo(map);
    this.markers = new Map();
    this.selectedId = null;
  }

  set(list, { visible = () => true } = {}) {
    this.group.clearLayers();
    this.markers.clear();
    this.list = list;
    for (const a of list) {
      if (!visible(a) || a.lat == null) continue;
      const m = L.marker([a.lat, a.lng], {
        icon: this.icon(a, a.id === this.selectedId),
        draggable: this.draggable,
        keyboard: false,
        title: titleOf(a),
        zIndexOffset: (a.level || 1) * 100 + (a.id === this.selectedId ? 2000 : 0),
        riseOnHover: true,
      });
      m.on('click', (e) => { L.DomEvent.stop(e); this.onSelect?.(a.id); });
      if (this.draggable) m.on('dragend', () => this.onDragEnd?.(a.id, m.getLatLng()));
      m.addTo(this.group);
      this.markers.set(a.id, { m, a });
    }
  }

  icon(a, selected) {
    const s = markerSize(a);
    return L.divIcon({ className: '', html: markerHtml(a, { selected }), iconSize: [s, s], iconAnchor: [s / 2, s / 2] });
  }

  select(id) {
    const prev = this.markers.get(this.selectedId);
    if (prev) { prev.m.setIcon(this.icon(prev.a, false)); prev.m.setZIndexOffset((prev.a.level || 1) * 100); }
    this.selectedId = id;
    const cur = this.markers.get(id);
    if (cur) { cur.m.setIcon(this.icon(cur.a, true)); cur.m.setZIndexOffset(3000); }
  }
}

/** Orange "car" marker that follows the video (editor) or review position. */
export class CarMarker {
  constructor(map) { this.map = map; this.m = null; }
  set(p, brg = 0) {
    if (!p) { this.hide(); return; }
    const html = `<div class="car" style="transform:rotate(${Math.round(brg)}deg)"><svg viewBox="0 0 24 24"><path d="M12 2.5l7 18.5-7-4.2-7 4.2z" fill="currentColor"/></svg></div>`;
    if (!this.m) this.m = L.marker(p, { icon: L.divIcon({ className: '', html, iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false, zIndexOffset: 5000 }).addTo(this.map);
    else { this.m.setLatLng(p); this.m.setIcon(L.divIcon({ className: '', html, iconSize: [26, 26], iconAnchor: [13, 13] })); }
  }
  hide() { if (this.m) { this.map.removeLayer(this.m); this.m = null; } }
}
