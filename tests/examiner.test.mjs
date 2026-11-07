import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cumulative, pointAt } from '../app/js/core/geo.js';
import { buildCuePlan, CueRunner, transcript, simSpeedAt, laneAdvice, tipText, signalLeftPoint, buildManeuvers } from '../app/js/core/examiner.js';
import { buildInstructions } from '../app/js/core/instructions.js';
import { buildSegments } from '../app/js/core/osm.js';
import { detectSideRoads } from '../app/js/core/analyze.js';

// local metres → [lat, lng] (x east, y north), well away from the test centre
const LAT0 = 52.2, LNG0 = 0.13, M = 111195;
const P = (x, y) => [LAT0 + y / M, LNG0 + x / (M * Math.cos((LAT0 * Math.PI) / 180))];

/**
 * East along a road for 300 m, then turns. `turns`: [{at, mod, ahead}] where the
 * route turns at x = at (all turns happen on one straight line for simplicity).
 * ahead: the road also carries straight on at that junction (side road) or not (T).
 */
function straightRoute({ turns = [{ at: 300, mod: 'left', ahead: true }], sideRoads, annotations = [], voice } = {}) {
  const geom = [P(0, 0)];
  for (const t of turns) geom.push(P(t.at, 0));
  geom.push(P(turns[turns.length - 1].at + 250, 0));
  const cum = cumulative(geom);
  const steps = [{ type: 'depart', mod: 'right', at: 0, loc: geom[0], dist: 10, ints: [] }];
  for (const t of turns) {
    const b = t.ahead ? [90, t.mod === 'left' ? 0 : 180, 270] : [t.mod === 'left' ? 0 : 180, 270];
    const out = b.indexOf(t.mod === 'left' ? 0 : 180);
    steps.push({ type: 'turn', mod: t.mod, name: `Road ${t.at}`, ref: '', at: t.at, loc: P(t.at, 0), dist: 200, ints: [{ l: P(t.at, 0), b, e: b.map(() => 1), i: b.indexOf(270), o: out }] });
  }
  steps.push({ type: 'arrive', mod: '', at: cum[cum.length - 1], loc: geom[geom.length - 1], dist: 0, ints: [] });
  return {
    id: 't', name: 't', waypoints: [], annotations, ...(voice ? { voice } : {}),
    route: { geometry: geom, steps, legStarts: [0], nodes: null, ...(sideRoads ? { sideRoads } : {}) },
  };
}

const said = (route, opts) => transcript(buildCuePlan(route, { showMe: false, ...opts }));
const dirs = (route, opts) => said(route, opts).filter((s) => s.kind === 'dir');

test('examiner: next / second road counts only side roads on the same side', () => {
  // expected speed 30 mph → direction ~97 m before the turn; a left road at 250 m is in between
  const r = straightRoute({ sideRoads: [{ at: 150, side: 'left', ok: true }, { at: 250, side: 'left', ok: true }, { at: 260, side: 'right', ok: true }] });
  const d = dirs(r);
  assert.equal(d.length, 1);
  assert.equal(d[0].en, 'Take the second road on the left, please.');
  assert.ok(d[0].sayAt > 150 && d[0].sayAt < 250);
  const r2 = straightRoute({ sideRoads: [{ at: 150, side: 'left', ok: true }, { at: 260, side: 'right', ok: true }] });
  assert.equal(dirs(r2)[0].en, 'Take the next road on the left, please.');
});

test('examiner: waits until a no-entry road is behind before saying "next road"', () => {
  const r = straightRoute({ sideRoads: [{ at: 240, side: 'left', ok: false, amb: true }] });
  const d = dirs(r)[0];
  assert.equal(d.en, 'Take the next road on the left, please.');
  assert.ok(d.sayAt >= 238 && d.sayAt <= 255, `said at ${d.sayAt}`); // not before reaching it
});

test('examiner: end of the road, traffic lights, chained directions', () => {
  assert.equal(dirs(straightRoute({ turns: [{ at: 300, mod: 'right', ahead: false }] }))[0].en, 'At the end of the road, turn right, please.');
  const lights = straightRoute({ annotations: [{ id: 's', type: 'signals', at: 290, lat: 0, lng: 0, level: 1 }] });
  assert.equal(dirs(lights)[0].en, 'At the traffic lights, turn left, please.');
  const two = straightRoute({ turns: [{ at: 300, mod: 'left', ahead: false }, { at: 340, mod: 'right', ahead: true }] });
  const d = dirs(two);
  assert.equal(d.length, 1);
  assert.equal(d[0].en, 'At the end of the road, turn left, then the next road on the right, please.');
});

test('examiner: user overrides replace or mute a direction', () => {
  const base = straightRoute();
  const key = buildManeuvers(base)[0].key;
  const custom = straightRoute({ voice: { [key]: { say: 'Take the next left, please.' } } });
  assert.equal(dirs(custom)[0].en, 'Take the next left, please.');
  const muted = straightRoute({ voice: { [key]: { mute: true } } });
  assert.equal(dirs(muted).length, 0);
  const listed = buildInstructions(muted, { keepMuted: true }).filter((s) => s.kind === 'dir');
  assert.equal(listed.length, 1);
  assert.ok(listed[0].muted);
});

test('examiner: roundabout direction, coaching and "signal left now"', () => {
  const rb = { kind: 'roundabout', exit: 3, dir: 'right', rule: 'right', fromAt: 300, toAt: 360, lanes: null,
    arms: [{ s: 270, no: 1 }, { s: 0, no: 2 }, { s: 90, no: 3, isExit: true }] };
  const route = straightRoute({ turns: [{ at: 300, mod: 'straight', ahead: true }], annotations: [{ id: 'rb', type: 'roundabout', at: 300, lat: 0, lng: 0, level: 3, rb }] });
  const mock = said(route, { mode: 'mock' });
  assert.ok(mock.some((s) => s.en === 'At the roundabout, take the third exit, please.'));
  assert.ok(!mock.some((s) => s.kind === 'coach' || s.kind === 'rbSignal'));
  const practice = said(route, { mode: 'practice' });
  const i = practice.findIndex((s) => s.kind === 'dir');
  assert.equal(practice[i + 1].kind, 'coach');
  assert.match(practice[i + 1].en, /^Right-hand lane\. Signal right/);
  const m = buildManeuvers(route)[0];
  assert.equal(Math.round(signalLeftPoint(m)), 340); // 180° of the 270° traversed
  const sig = practice.find((s) => s.kind === 'rbSignal');
  assert.ok(sig && sig.sayAt >= 335 && sig.sayAt <= 345);
});

test('examiner: big interchanges get the exit number and lane-arrow coaching', () => {
  const rb = { kind: 'rotary', name: 'Histon Interchange', exit: 3, dir: 'ahead', rule: 'intermediate', fromAt: 300, toAt: 520, radius: 72, lanes: null,
    arms: [{ s: 188, no: 1 }, { s: 294, no: 2 }, { s: 359, no: 3, isExit: true }] };
  const route = straightRoute({ turns: [{ at: 300, mod: 'straight', ahead: true }], annotations: [{ id: 'rb', type: 'roundabout', at: 300, lat: 0, lng: 0, level: 3, rb }] });
  const practice = said(route, { mode: 'practice' });
  assert.ok(practice.some((s) => s.en === 'At the roundabout, take the third exit, please.'));
  const coach = practice.find((s) => s.kind === 'coach');
  assert.match(coach.en, /^Follow the lane arrows for the third exit\. Signal left after you pass the exit before yours\./);
  // a small roundabout straight across keeps the examiner's "follow the road ahead"
  const small = straightRoute({ turns: [{ at: 300, mod: 'straight', ahead: true }], annotations: [{ id: 'rb', type: 'roundabout', at: 300, lat: 0, lng: 0, level: 3, rb: { ...rb, kind: 'roundabout', name: '', radius: 18, toAt: 340, exit: 2 } }] });
  assert.ok(said(small).some((s) => s.en === "At the roundabout, follow the road ahead. That's the second exit."));
});

test('examiner: opening, arrival, mid-route start and practice tips', () => {
  const route = straightRoute({ annotations: [{ id: 'sp', type: 'speed', at: 200, speed: 20, prevSpeed: 30, lat: 0, lng: 0, level: 2 }] });
  const all = said(route, { mode: 'practice' });
  assert.equal(all[0].kind, 'open');
  assert.equal(all[all.length - 1].kind, 'end');
  assert.ok(all.some((s) => s.kind === 'arrive' && /Pull up on the left/.test(s.en)));
  const tip = all.find((s) => s.kind === 'tip');
  assert.equal(tip.en, '20 limit ahead. Check your speed.');
  assert.ok(tip.sayAt < 200);
  assert.ok(!said(route, { mode: 'mock' }).some((s) => s.kind === 'tip'));
  // joining mid-route: nothing from behind is replayed
  const runner = new CueRunner(buildCuePlan(route, { showMe: false }));
  runner.skipTo(320);
  const out = runner.update({ at: 320, v: 10, t: 0 });
  assert.ok(!out.some((s) => s.kind === 'open' || s.kind === 'dir'));
});

test('examiner: show-me question on a quiet stretch; simulated speed slows for turns', () => {
  const route = straightRoute({ turns: [{ at: 1500, mod: 'left', ahead: true }] });
  const plan = buildCuePlan(route, { rand: () => 0 });
  const q = plan.cues.find((c) => c.kind === 'showme');
  assert.ok(q && /show me how you'd wash and clean the rear windscreen/.test(q.en));
  assert.ok(simSpeedAt(plan, 1495) < simSpeedAt(plan, 1200));
  assert.ok(simSpeedAt(plan, 1495) < 6);
});

test('examiner: lane and tip wording', () => {
  assert.equal(laneAdvice([{ valid: true }, { valid: false }]), 'Get in the left-hand lane.');
  assert.equal(laneAdvice([{ valid: false }, { valid: false }, { valid: true }]), 'Get in the right-hand lane.');
  assert.equal(laneAdvice([{ valid: false }, { valid: true }, { valid: false }]), 'Get in the middle lane.');
  assert.equal(laneAdvice([{ valid: true }, { valid: true }]), null);
  assert.equal(tipText({ type: 'cycle', title: '右转：横穿自行车道' }), 'Watch for cyclists as you turn.');
  assert.equal(tipText({ type: 'note', say: '  Watch the hidden junction.  ' }), 'Watch the hidden junction.');
  assert.equal(tipText({ type: 'note' }), null);
});

test('side roads from OSM: left/right, one-way entry, service roads ignored', () => {
  const geom = [P(0, 0), P(100, 0), P(200, 0)];
  const r = { geometry: geom, nodes: [1, 2, 3] };
  const way = (id, nodes, tags, g) => [id, { id, nodes, tags, geom: g }];
  const ctx = {
    nodes: new Map(),
    ways: new Map([
      way(100, [1, 2, 3], { highway: 'residential' }, geom),
      way(200, [2, 10], { highway: 'residential', name: 'Side Road' }, [P(100, 0), P(100, 80)]),
      way(300, [11, 2], { highway: 'residential', oneway: 'yes' }, [P(100, -80), P(100, 0)]),
      way(400, [2, 12], { highway: 'service' }, [P(100, 0), P(130, 60)]),
    ]),
  };
  const sides = detectSideRoads(r, ctx, buildSegments(r, ctx));
  assert.equal(sides.length, 2);
  const left = sides.find((s) => s.side === 'left');
  assert.ok(left.ok && left.name === 'Side Road' && left.at === 100);
  const right = sides.find((s) => s.side === 'right');
  assert.ok(!right.ok && right.amb); // one-way towards us: can't turn in
  void pointAt;
});
