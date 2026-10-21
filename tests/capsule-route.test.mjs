import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../static/vendor/three.module.js';
import { capsuleScaleProgress } from '../static/v6/capsule-presentation.mjs';
import { capsuleRouteSegments } from '../static/v6/capsule-route.mjs';

const target = [0, .65 / .95, 3 / .95];
const representativeStarts = [
  [0, -.35, 0], [0, .78, 0], [0, 1.65, 0],
  [-.9, .65, .2], [.9, .65, .2], [0, .6, 1], [0, .6, -1],
];

function sphereStarts() {
  return Array.from({ length: 16 }, (_, index) => {
    const y = 1 - 2 * (index + .5) / 16;
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    const radial = Math.sqrt(1 - y * y) * 1.2;
    return [radial * Math.cos(angle), .78 + y * 1.2, radial * Math.sin(angle)];
  });
}

function makeCurvePath(segments, transform = point => new THREE.Vector3(...point)) {
  const path = new THREE.CurvePath();
  const curves = segments.map(segment => {
    const points = segment.points.map(transform);
    const curve = segment.type === 'line'
      ? new THREE.LineCurve3(points[0], points[1])
      : new THREE.CubicBezierCurve3(...points);
    path.add(curve);
    return curve;
  });
  return { path, curves, lengths: curves.map(curve => curve.getLength()) };
}

function normalizedDirection(vector) { return vector.clone().normalize(); }

test('capsule outlet route connects bowl samples to the local front target without re-entry', () => {
  const starts = [...representativeStarts, ...sphereStarts()];
  const machineGroup = new THREE.Group();
  machineGroup.scale.setScalar(.95);
  machineGroup.updateMatrixWorld(true);

  for (const start of starts) {
    const originalStart = [...start], originalTarget = [...target];
    const route = capsuleRouteSegments(start, target);
    assert.equal(route.exitAfterSegment, 1);
    assert.deepEqual(start, originalStart);
    assert.deepEqual(target, originalTarget);
    assert.deepEqual(route.segments.map(segment => segment.type), ['cubic', 'line', 'cubic']);
    for (const segment of route.segments) {
      assert.ok(segment.points.every(point => point.length === 3 && point.every(Number.isFinite)));
    }
    const all = route.segments;
    assert.ok(new THREE.Vector3(...all[0].points[0]).distanceTo(new THREE.Vector3(...start)) < 1e-12);
    assert.ok(new THREE.Vector3(...all[2].points.at(-1)).distanceTo(new THREE.Vector3(...target)) < 1e-12);
    assert.ok(new THREE.Vector3(...all[0].points.at(-1)).distanceTo(new THREE.Vector3(...all[1].points[0])) < 1e-12);
    assert.ok(new THREE.Vector3(...all[1].points.at(-1)).distanceTo(new THREE.Vector3(...all[2].points[0])) < 1e-12);

    const local = makeCurvePath(route.segments);
    const totalLength = local.lengths.reduce((sum, length) => sum + length, 0);
    const exitProgress = local.lengths[0] + local.lengths[1];
    const exitRatio = exitProgress / totalLength;
    assert.ok(exitRatio > 0 && exitRatio < 1);

    const firstEnd = all[0].points[3], firstHandle = all[0].points[2];
    const lineStart = all[1].points[0], lineEnd = all[1].points[1];
    const nextStart = all[2].points[0], nextHandle = all[2].points[1];
    const firstTangent = normalizedDirection(new THREE.Vector3(...firstEnd).sub(new THREE.Vector3(...firstHandle)));
    const lineTangent = normalizedDirection(new THREE.Vector3(...lineEnd).sub(new THREE.Vector3(...lineStart)));
    const nextTangent = normalizedDirection(new THREE.Vector3(...nextHandle).sub(new THREE.Vector3(...nextStart)));
    assert.ok(firstTangent.dot(lineTangent) > .999999, 'bowl curve should enter the straight outlet in the same direction');
    assert.ok(lineTangent.dot(nextTangent) > .999999, 'outlet should enter the front curve in the same direction');

    for (let sample = 0; sample <= 1000; sample++) {
      const progress = sample / 1000;
      const point = local.path.getPoint(progress);
      assert.ok([point.x, point.y, point.z].every(Number.isFinite));
      const scale = capsuleScaleProgress(progress, exitRatio);
      if (progress <= exitRatio) assert.equal(scale, 0, 'capsule must stay at original size until it clears the exit');
      if (progress > exitRatio) assert.ok(scale > 0);
      if (progress >= exitRatio) assert.ok(point.z >= 1.82 - 1e-8, 'front route must not return into the outlet');
    }
    assert.equal(capsuleScaleProgress(1, exitRatio), 1);

    const world = makeCurvePath(route.segments, point => machineGroup.localToWorld(new THREE.Vector3(...point)));
    const worldExitRatio = (world.lengths[0] + world.lengths[1]) / world.lengths.reduce((sum, length) => sum + length, 0);
    assert.ok(Math.abs(worldExitRatio - exitRatio) < 1e-12, 'uniform machine scale preserves the exit arc ratio');
  }
});

test('straight outlet keeps the capsule and clasp inside the black opening', () => {
  const extent = .26 + .0275;
  const opening = { minY: -2.025, maxY: -1.375 };
  for (const start of [...representativeStarts, ...sphereStarts()]) {
    const route = capsuleRouteSegments(start, target);
    const { path, lengths } = makeCurvePath(route.segments);
    const totalLength = lengths.reduce((sum, length) => sum + length, 0);
    const lineStartProgress = lengths[0] / totalLength;
    const lineEndProgress = (lengths[0] + lengths[1]) / totalLength;
    for (let i = 0; i <= 200; i++) {
      const z = 1.1 + (1.75 - 1.1) * i / 200;
      const progress = (lengths[0] + (z - .55)) / totalLength;
      assert.ok(progress >= lineStartProgress && progress <= lineEndProgress);
      const point = path.getPoint(progress);
      assert.ok(Math.abs(point.z - z) < 1e-9);
      assert.ok(point.y - extent >= opening.minY, `lower capsule/clasp edge at y=${point.y - extent}`);
      assert.ok(point.y + extent <= opening.maxY, `upper capsule/clasp edge at y=${point.y + extent}`);
    }
  }
});

test('capsule route validates finite points and target clearance without mutating inputs', () => {
  const start = [0, .78, 0], destination = [...target];
  const route = capsuleRouteSegments(start, destination);
  assert.deepEqual(start, [0, .78, 0]);
  assert.deepEqual(destination, target);
  assert.notStrictEqual(route.segments[0].points[0], start);
  assert.notStrictEqual(route.segments[2].points.at(-1), destination);

  for (const [from, to] of [
    [null, destination], [[0, 1], destination], [[0, NaN, 0], destination],
    [new Array(3), destination],
    [[0, 0, 0], null], [[0, 0, 0], [0, 0, 2.28]], [[0, 0, 0], [0, -1.700001, 3]],
    [[0, 0, 0], [0, 0, Infinity]],
  ]) assert.throws(() => capsuleRouteSegments(from, to), RangeError);
});
