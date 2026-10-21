import test from 'node:test';
import assert from 'node:assert/strict';
import { fitCamera } from '../static/v6/camera-fit.mjs';
import { fitCameraPoints } from '../static/v6/camera-points.mjs';
import { MACHINE_PROFILES, SHARED_PROFILE } from '../static/v6/machine-profiles.mjs';

const aspects = [305 / 300, 390 / 372, 862 / 350, 1355 / 652];
const fov = 42;
const pitch = Math.atan2(3.1, 9.4);
const fill = .70;
const padding = .08;

function tiltedDisk() {
  const radius = 2.6, thickness = .12, tilt = .55;
  const normal = [0, -Math.sin(tilt), Math.cos(tilt)];
  const points = [];
  for (const side of [-1, 1]) {
    for (let index = 0; index < 32; index++) {
      const angle = 2 * Math.PI * index / 32;
      const ring = [
        radius * Math.cos(angle),
        radius * Math.sin(angle) * Math.cos(tilt),
        radius * Math.sin(angle) * Math.sin(tilt),
      ];
      points.push(ring.map((value, axis) => value + side * thickness / 2 * normal[axis]));
    }
  }
  const bounds = {
    min: [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis]))),
    max: [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis]))),
  };
  return { points, bounds };
}

function independentProjection(point, fit, aspect) {
  const subtract = (a, b) => a.map((value, i) => value - b[i]);
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const normalize = vector => {
    const length = Math.hypot(...vector);
    return vector.map(value => value / length);
  };
  const forward = normalize(subtract(fit.target, fit.position));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = normalize(cross(right, forward));
  const fromCamera = subtract(point, fit.position);
  const depth = dot(fromCamera, forward);
  const tanV = Math.tan(fov * Math.PI / 360);
  assert.ok(depth > 0, 'each point must be in front of the camera');
  return [dot(fromCamera, right) / (depth * tanV * aspect), dot(fromCamera, up) / (depth * tanV)];
}

function assertPointsInside(points, fit, aspect) {
  for (const point of points) {
    const [x, y] = independentProjection(point, fit, aspect);
    assert.ok(Math.abs(x) <= fill + 1e-10, `horizontal projection ${x} exceeds fill`);
    assert.ok(Math.abs(y) <= fill + 1e-10, `vertical projection ${y} exceeds fill`);
  }
}

test('tilted disk points fit independent perspective projections and tighter than their AABB', () => {
  const { points, bounds } = tiltedDisk();
  for (const aspect of aspects) {
    const pointFit = fitCameraPoints({ points, bounds, aspect, fov, pitch, fill, padding });
    const boxFit = fitCamera({ bounds, aspect, fov, pitch, fill, padding });
    assertPointsInside(points, pointFit, aspect);
    assert.ok(pointFit.distance < boxFit.distance, `point cloud should fit tighter at aspect ${aspect}`);
  }
});

test('wheel disk profile remains inside the viewport through camera offsets and push', () => {
  const { points, bounds } = tiltedDisk();
  const camera = SHARED_PROFILE.camera;
  const wheelFill = MACHINE_PROFILES.wheel.camera.diskFill;
  for (const aspect of aspects) {
    const fit = fitCameraPoints({
      points, bounds, aspect, fov: camera.fov, pitch: camera.pitch,
      fill: wheelFill, padding: camera.fitPadding,
    });
    const direction = fit.position.map((value, axis) => (value - fit.target[axis]) / fit.distance);
    for (const reserve of [0, camera.maxPushDistance]) {
      for (const side of [-camera.maxSideOffset, camera.maxSideOffset]) {
        for (const vertical of [-camera.maxVerticalOffset, camera.maxVerticalOffset]) {
          const distance = fit.distance + reserve;
          const position = [
            fit.target[0] + direction[0] * distance + side,
            fit.target[1] + direction[1] * distance + vertical,
            fit.target[2] + direction[2] * distance,
          ];
          const shiftedFit = { target: fit.target, position };
          for (const point of points) {
            const [x, y] = independentProjection(point, shiftedFit, aspect);
            assert.ok(Math.abs(x) < 1, `wheel x=${x}, aspect=${aspect}, reserve=${reserve}, offset=${side}/${vertical}`);
            assert.ok(Math.abs(y) < 1, `wheel y=${y}, aspect=${aspect}, reserve=${reserve}, offset=${side}/${vertical}`);
          }
        }
      }
    }
  }
});

test('translation preserves fit distance and moves target and camera by the same offset', () => {
  const { points, bounds } = tiltedDisk();
  const offset = [17, -23, 41];
  const movedPoints = points.map(point => point.map((value, axis) => value + offset[axis]));
  const movedBounds = {
    min: bounds.min.map((value, axis) => value + offset[axis]),
    max: bounds.max.map((value, axis) => value + offset[axis]),
  };
  const aspect = 390 / 372;
  const first = fitCameraPoints({ points, bounds, aspect });
  const moved = fitCameraPoints({ points: movedPoints, bounds: movedBounds, aspect });
  assert.ok(Math.abs(first.distance - moved.distance) < 1e-12);
  assert.deepEqual(moved.target, first.target.map((value, axis) => value + offset[axis]));
  assert.deepEqual(moved.position, first.position.map((value, axis) => value + offset[axis]));
  assertPointsInside(movedPoints, moved, aspect);
});

test('rejects empty, malformed, non-finite, and out-of-bounds points', () => {
  const bounds = { min: [-1, -1, -1], max: [1, 1, 1] };
  for (const points of [[], null, [[0, 0]], [[0, NaN, 0]], [[0, 0, Infinity]], [[1.01, 0, 0]]]) {
    assert.throws(() => fitCameraPoints({ points, bounds, aspect: 1 }), RangeError);
  }
  assert.throws(() => fitCameraPoints({ points: [[0, 0, 0]], bounds, aspect: 0 }), RangeError);
  assert.throws(() => fitCameraPoints({ points: [[0, 0, 0]], bounds, aspect: 1, minDistance: 0 }), RangeError);
});

test('returns independent arrays and does not mutate points or bounds', () => {
  const { points, bounds } = tiltedDisk();
  const originalPoints = structuredClone(points);
  const originalBounds = structuredClone(bounds);
  const first = fitCameraPoints({ points, bounds, aspect: 1 });
  const second = fitCameraPoints({ points, bounds, aspect: 1 });
  assert.deepEqual(points, originalPoints);
  assert.deepEqual(bounds, originalBounds);
  assert.notStrictEqual(first.target, second.target);
  assert.notStrictEqual(first.position, second.position);
});
