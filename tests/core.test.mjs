import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cumulative, haversine, bearing, project, pointAt, fitCircle, densify, parseTime, fmtTime } from '../app/js/core/geo.js';
import { parseMaxspeed } from '../app/js/core/osm.js';
import { describeRoundabout, collectIntersections, findRoundabouts, roundaboutAdvice, lanesText } from '../app/js/core/roundabout.js';
import { googleMapsParts, toGPX, toKML, parsePack, makePack } from '../app/js/core/exporters.js';
import { buildTimeline } from '../app/js/core/timeline.js';
import { parseYouTubeId, parseYouTubeStart } from '../app/js/core/model.js';
import { mergeAuto } from '../app/js/core/analyze.js';

// local metres → [lat, lng] around Cambridge
const LAT0 = 52.2, LNG0 = 0.13, M = 111195;
const P = (x, y) => [LAT0 + y / M, LNG0 + x / (M * Math.cos((LAT0 * Math.PI) / 180))];
const onCircle = (deg, r = 20) => P(r * Math.sin((deg * Math.PI) / 180), r * Math.cos((deg * Math.PI) / 180));

/**
 * Synthetic 4-arm roundabout (radius 20 m) entered from the south heading north.
 * UK: clockwise, so exits are W (1st), N (2nd), E (3rd).
 */
function roundaboutRoute(exitDeg, exitNo) {
  const geom = [P(0, -80), P(0, -50), P(0, -20)];
  for (let d = 190; d <= exitDeg; d += 10) geom.push(onCircle(d));
  const out = [Math.sin((exitDeg * Math.PI) / 180), Math.cos((exitDeg * Math.PI) / 180)];
  geom.push(P(out[0] * 40, out[1] * 40), P(out[0] * 70, out[1] * 70));
  const cum = cumulative(geom);
  const atOf = (pt) => project(geom, cum, pt).at;
  const ints = [
    { l: onCircle(180), b: [90, 180, 270], e: [0, 0, 1], i: 1, o: 2 }, // entry (south)
  ];
  const sides = { 270: [180, 0, 270], 360: [270, 0, 90], 90: [0, 180, 90] };
  for (const d of [270, 360, 90].map((x) => x)) {
    const dd = d === 360 ? 360 : d === 90 ? 450 : d;
    if (dd > exitDeg) break;
    if (dd === exitDeg) {
      // exit node: in = upstream circle, out = radial exit road, side = circle continuation
      const tang = (dd + 90) % 360; // clockwise travel direction at this point
      ints.push({ l: onCircle(dd), b: [(tang + 180) % 360, dd % 360, tang], e: [0, 1, 1], i: 0, o: 1 });
    } else {
      const tang = (dd + 90) % 360;
      ints.push({ l: onCircle(dd), b: [(tang + 180) % 360, tang, dd % 360], e: [0, 1, 1], i: 0, o: 1 });
    }
  }
  void sides;
  const steps = [
    { type: 'depart', mod: '', at: 0, loc: geom[0], ints: [] },
    { type: 'roundabout', mod: 'slight left', exit: exitNo, at: atOf(onCircle(180)), loc: onCircle(180), ints: ints.slice(0, -1), dist: 100 },
    { type: 'exit roundabout', mod: 'straight', exit: exitNo, at: atOf(onCircle(exitDeg)), loc: onCircle(exitDeg), ints: ints.slice(-1), dist: 50 },
  ];
  return { route: { geometry: geom, steps, legStarts: [0], nodes: null }, cum };
}

test('geo basics', () => {
  const a = [52.2, 0.13], b = [52.201, 0.13];
  assert.ok(Math.abs(haversine(a, b) - 111.2) < 0.5);
  assert.ok(Math.abs(bearing(a, b)) < 0.01);
  const geom = [P(0, 0), P(100, 0), P(100, 100)];
  const cum = cumulative(geom);
  const p = project(geom, cum, P(50, 5));
  assert.ok(Math.abs(p.at - 50) < 0.5 && Math.abs(p.dist - 5) < 0.5);
  const q = pointAt(geom, cum, 150);
  assert.ok(haversine(q, P(100, 50)) < 0.5);
  assert.equal(parseTime('1:23'), 83);
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(fmtTime(3723), '1:02:03');
});

test('circle fit recovers centre, radius and clockwise sweep', () => {
  const arc = densify([180, 200, 220, 240, 260, 280].map((d) => onCircle(d, 25)), 2);
  const fit = fitCircle(arc);
  assert.ok(Math.abs(fit.r - 25) < 0.5, `r=${fit.r}`);
  assert.ok(haversine(fit.c, P(0, 0)) < 0.5);
  assert.ok(fit.span > 90 && fit.span < 110, `span=${fit.span}`);
});

test('maxspeed parsing (UK)', () => {
  assert.equal(parseMaxspeed('20 mph'), 20);
  assert.equal(parseMaxspeed('GB:nsl_single'), 60);
  assert.equal(parseMaxspeed('GB:nsl_dual'), 70);
  assert.equal(parseMaxspeed('48'), 30); // km/h default
  assert.equal(parseMaxspeed('signals'), null);
});

for (const [exitDeg, exitNo, clock, dir, rule] of [
  [270, 1, 9, 'left', 'first'],
  [360, 2, 12, 'ahead', 'intermediate'],
  [450, 3, 3, 'right', 'right'],
]) {
  test(`roundabout exit ${exitNo} → ${clock} o'clock, ${dir}`, () => {
    const { route, cum } = roundaboutRoute(exitDeg, exitNo);
    const ints = collectIntersections(route, cum);
    const found = findRoundabouts(route, cum, {});
    assert.equal(found.length, 1);
    const rb = describeRoundabout(route, cum, ints, found[0], {});
    assert.equal(rb.exit, exitNo);
    assert.equal(rb.counted, exitNo);
    assert.equal(rb.clock, clock);
    assert.equal(rb.dir, dir);
    assert.equal(rb.rule, rule);
    assert.equal(rb.method, 'circle');
    const adv = roundaboutAdvice(rb);
    assert.ok(adv.en.includes(['', 'first', 'second', 'third'][exitNo]));
    if (rule === 'right') assert.ok(adv.lines[0].includes('右车道'));
    if (rule === 'first') assert.ok(adv.lines[0].includes('打左灯'));
  });
}

test('lanes text', () => {
  assert.equal(lanesText([{ ind: ['left'], valid: true }, { ind: ['straight'], valid: false }]), '地图车道数据：共 2 道，可走最左道');
  assert.equal(lanesText([{ ind: ['left'], valid: true }, { ind: ['right'], valid: true }]), '');
});

test('google maps parts respect waypoint limit and chain', () => {
  const geom = [];
  for (let i = 0; i <= 300; i++) geom.push(P(i * 50, 0)); // 15 km straight
  const cum = cumulative(geom);
  const legStarts = [0];
  for (let k = 1; k < 25; k++) legStarts.push(k * 12);
  const route = { route: { geometry: geom, legStarts, steps: [] } };
  const parts = googleMapsParts(route, { perPart: 9 });
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.waypoints <= 9);
  for (let k = 1; k < parts.length; k++) assert.equal(parts[k].from, parts[k - 1].to);
  assert.equal(parts[parts.length - 1].to, cum[cum.length - 1]);
  assert.ok(parts[0].url.startsWith('https://www.google.com/maps/dir/?api=1&origin='));
});

test('GPX / KML are well-formed-ish and escape text', () => {
  const route = {
    name: 'A & B <test>', notes: '', video: { youtubeId: 'abcdefghijk' },
    route: { geometry: [P(0, 0), P(100, 0)], legStarts: [0], steps: [] },
    annotations: [{ id: 'a1', type: 'box', lat: P(50, 0)[0], lng: P(50, 0)[1], level: 3, title: 'Box & co', note: '<b>', t: 75, bearing: 90 }],
  };
  const gpx = toGPX(route);
  assert.ok(gpx.includes('<wpt') && gpx.includes('<trkpt') && gpx.includes('A &amp; B &lt;test&gt;'));
  assert.ok(!gpx.includes('<b>'));
  const kml = toKML(route);
  assert.ok(kml.includes('<LineString>') && kml.includes('youtu.be/abcdefghijk?t=75'));
  assert.deepEqual(parsePack(makePack([{ schema: 1, id: 'x' }])).length, 1);
});

test('timeline interpolates between timestamped waypoints', () => {
  const geom = [P(0, 0), P(1000, 0), P(2000, 0)];
  const route = { waypoints: [{ t: 100 }, { t: 200 }, { t: 400 }], route: { geometry: geom, legStarts: [0, 1] } };
  const tl = buildTimeline(route);
  assert.ok(Math.abs(tl.timeAt(500) - 150) < 1);
  assert.ok(Math.abs(tl.atTime(300) - 1500) < 2);
  assert.equal(tl.timeAt(-10), null);
});

test('youtube id/start parsing', () => {
  assert.equal(parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeId('https://youtu.be/dQw4w9WgXcQ?t=10'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeStart('https://youtu.be/dQw4w9WgXcQ?t=1m10s'), 70);
});

test('mergeAuto keeps edits, respects dismissals, drops stale unedited autos', () => {
  const route = {
    dismissed: ['k3'],
    annotations: [
      { id: 'm1', type: 'box', auto: false, at: 5 },
      { id: 'a1', key: 'k1', type: 'speed', auto: true, edited: true, title: 'mine', at: 10, lat: 0, lng: 0 },
      { id: 'a2', key: 'k2', type: 'signals', auto: true, at: 20 },
    ],
  };
  const fresh = [
    { key: 'k1', type: 'speed', auto: true, title: 'auto', at: 11, lat: 1, lng: 1 },
    { key: 'k3', type: 'crossing', auto: true, at: 30 },
    { key: 'k4', type: 'crossing', auto: true, at: 40 },
  ];
  const res = mergeAuto(route, fresh);
  const by = Object.fromEntries(res.annotations.map((a) => [a.key || a.id, a]));
  assert.equal(by.k1.title, 'mine');
  assert.equal(by.k1.at, 11);
  assert.ok(!by.k2 && !by.k3 && by.k4 && by.m1);
});
