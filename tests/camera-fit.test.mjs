import test from 'node:test';
import assert from 'node:assert/strict';
import { fitCamera, fitSphereCamera } from '../static/v6/camera-fit.mjs';
import { SHARED_PROFILE } from '../static/v6/machine-profiles.mjs';

const viewports = [320 / 568, 390 / 844, 1366 / 768, 1920 / 1080];
const bounds = { min: [-2.4, -1.7, -1.2], max: [2.1, 2.8, 1.5] };

function corners(box, padding = 0) {
  return Array.from({ length: 8 }, (_, index) => [
    index & 1 ? box.max[0] + padding : box.min[0] - padding,
    index & 2 ? box.max[1] + padding : box.min[1] - padding,
    index & 4 ? box.max[2] + padding : box.min[2] - padding,
  ]);
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = v => { const length = Math.hypot(...v); return v.map(x => x / length); };
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);

function projectSpherePoint(point, position, target, aspect, fov) {
  const forward = normalize(target.map((v, i) => v - position[i]));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = normalize(cross(right, forward));
  const fromCamera = point.map((v, i) => v - position[i]);
  const depth = dot(fromCamera, forward);
  const tanV = Math.tan(fov * Math.PI / 360);
  return { depth, x: dot(fromCamera, right) / (depth * tanV * aspect), y: dot(fromCamera, up) / (depth * tanV), forward, right, up };
}

function assertProjectedInside(box, fit, aspect, { fov = 42, pitch = Math.atan2(3.1, 9.4), fill = .70, padding = .08 } = {}) {
  const tanV = Math.tan(fov * Math.PI / 360), tanH = tanV * aspect;
  const offset = fit.position.map((v, i) => v - fit.target[i]);
  const distance = Math.hypot(...offset);
  assert.ok(Math.abs(distance - fit.distance) <= 1e-12 * Math.max(1, distance), 'reported distance must match camera position');
  assert.ok(offset[1] > 0 && offset[2] > 0, 'camera must be above target and on its positive Z side');
  const forward = offset.map(v => -v / distance);
  const worldUp = [0, 1, 0];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const normalize = v => { const length = Math.hypot(...v); return v.map(x => x / length); };
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const right = normalize(cross(forward, worldUp));
  const up = normalize(cross(right, forward));
  for (const point of corners(box, padding)) {
    const fromCamera = point.map((v, i) => v - fit.position[i]);
    const horizontal = dot(fromCamera, right);
    const vertical = dot(fromCamera, up);
    const depth = dot(fromCamera, forward);
    assert.ok(depth > 0, `corner must be in front of camera: ${depth}`);
    assert.ok(Math.abs(horizontal / (depth * tanH)) <= fill + 1e-12, 'projected horizontal corner exceeds fill');
    assert.ok(Math.abs(vertical / (depth * tanV)) <= fill + 1e-12, 'projected vertical corner exceeds fill');
  }
}

test('all eight padded corners fit the independent perspective projection at target viewports', () => {
  for (const aspect of viewports) {
    const fit = fitCamera({ bounds, aspect });
    assertProjectedInside(bounds, fit, aspect);
  }
});

test('independent projection honors non-default pitch, fov, fill, and padding', () => {
  const options = { fov: 54, pitch: .48, fill: .82, padding: .13 };
  const aspect = 390 / 844;
  const fit = fitCamera({ bounds, aspect, ...options });
  assertProjectedInside(bounds, fit, aspect, options);
});

test('a foreground result at z=3 is included in the fitted volume', () => {
  const model = { min: [-1.2, -1.4, -1], max: [1.3, 2.1, 1.2] };
  const result = { min: [-.7, -.5, 3], max: [.9, .8, 3.4] };
  const union = {
    min: model.min.map((v, i) => Math.min(v, result.min[i])),
    max: model.max.map((v, i) => Math.max(v, result.max[i])),
  };
  const aspect = 390 / 844;
  const fit = fitCamera({ bounds: union, aspect, fill: .86 });
  assertProjectedInside(union, fit, aspect, { fill: .86 });
  assert.ok(fit.distance > 0);
});

test('non-origin bounds retain the same relative composition after translation', () => {
  const aspect = 1366 / 768;
  const first = fitCamera({ bounds, aspect });
  const offset = [17, -23, 41];
  const moved = {
    min: bounds.min.map((v, i) => v + offset[i]),
    max: bounds.max.map((v, i) => v + offset[i]),
  };
  const second = fitCamera({ bounds: moved, aspect });
  assert.ok(Math.abs(first.distance - second.distance) < 1e-12);
  assert.deepEqual(second.target, first.target.map((v, i) => v + offset[i]));
  second.position.forEach((v, i) => assert.ok(Math.abs(v - (first.position[i] + offset[i])) < 1e-12));
  assertProjectedInside(moved, second, aspect);
});

test('degenerate point bounds and extreme legal aspect ratios stay finite and inside', () => {
  const point = { min: [4, -2, 3], max: [4, -2, 3] };
  const pointFit = fitCamera({ bounds: point, aspect: 1 });
  assert.equal(pointFit.distance, 1);
  assertProjectedInside(point, pointFit, 1);
  for (const aspect of [1e-6, 1e6]) {
    const fit = fitCamera({ bounds, aspect });
    assert.ok(Number.isFinite(fit.distance));
    assertProjectedInside(bounds, fit, aspect);
  }
});

test('portrait fit is never closer than landscape for the same bounds', () => {
  const portrait = fitCamera({ bounds, aspect: 320 / 568 });
  const landscape = fitCamera({ bounds, aspect: 1366 / 768 });
  assert.ok(portrait.distance >= landscape.distance);
});

test('returns new arrays and leaves input bounds untouched', () => {
  const input = structuredClone(bounds);
  const original = structuredClone(input);
  const first = fitCamera({ bounds: input, aspect: 1.2 });
  const second = fitCamera({ bounds: input, aspect: 1.2 });
  assert.deepEqual(input, original);
  assert.notStrictEqual(first.target, input.min);
  assert.notStrictEqual(first.target, second.target);
  assert.notStrictEqual(first.position, second.position);
});

test('rejects malformed bounds and illegal numeric values with RangeError', () => {
  const invalid = [
    [null],
    [{ bounds: null, aspect: 1 }],
    [{ bounds: { min: [0, 0], max: [1, 1, 1] }, aspect: 1 }],
    [{ bounds: { min: [0, 0, 0], max: [1, NaN, 1] }, aspect: 1 }],
    [{ bounds: { min: [2, 0, 0], max: [1, 1, 1] }, aspect: 1 }],
    [{ bounds, aspect: 0 }],
    [{ bounds, aspect: Infinity }],
    [{ bounds, aspect: 1, fov: 0 }],
    [{ bounds, aspect: 1, fov: 180 }],
    [{ bounds, aspect: 1, pitch: Math.PI / 2 }],
    [{ bounds, aspect: 1, pitch: -Math.PI / 2 }],
    [{ bounds, aspect: 1, fill: 0 }],
    [{ bounds, aspect: 1, fill: 1.01 }],
    [{ bounds, aspect: 1, padding: -0.01 }],
    [{ bounds, aspect: 1, minDistance: NaN }],
  ];
  for (const [args] of invalid) assert.throws(() => fitCamera(args), RangeError);
});

test('integrated profile fits real canvas ratios with offset and push envelope inside the viewport', () => {
  const profile = SHARED_PROFILE.camera;
  const actualCanvases = [305 / 300, 320 / 300, 390 / 372, 844 / 304, 862 / 350, 1022 / 350, 1355 / 652, 1576 / 652];
  const capsule = { min: [-1.67, -2.25, -1.67], max: [1.67, 2.46, 1.67] };
  const sphere = { min: [-3.5, -3.5, -3.5], max: [3.5, 3.5, 3.5] };
  const wheel = { min: [-2.8, -1.2, -2.5], max: [2.8, 2.5, 2.5] };
  const foreground = { min: [-.9, -.55, 4.2], max: [.9, .65, 4.6] };
  const union = {
    min: capsule.min.map((v, i) => Math.min(v, foreground.min[i])),
    max: capsule.max.map((v, i) => Math.max(v, foreground.max[i])),
  };
  const cases = [
    { name: 'capsule', bounds: capsule, fill: profile.idleFill },
    { name: 'rotating name sphere', bounds: sphere, fill: profile.idleFill },
    { name: 'wheel', bounds: wheel, fill: profile.idleFill },
    { name: 'foreground result union', bounds: union, fill: profile.resultFill },
  ];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const normalize = v => { const length = Math.hypot(...v); return v.map(x => x / length); };
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const fovTangent = Math.tan(profile.fov * Math.PI / 360);
  for (const aspect of actualCanvases) {
    for (const { name, bounds, fill } of cases) {
      const fit = fitCamera({ bounds, aspect, fov: profile.fov, pitch: profile.pitch, fill, padding: profile.fitPadding });
      for (const reserve of [profile.maxPushDistance, 0]) {
        const distance = fit.distance + reserve;
        const direction = fit.position.map((v, i) => (v - fit.target[i]) / fit.distance);
        const basePosition = fit.target.map((v, i) => v + direction[i] * distance);
        for (const side of [-profile.maxSideOffset, profile.maxSideOffset]) {
          for (const vertical of [-profile.maxVerticalOffset, profile.maxVerticalOffset]) {
            const position = [basePosition[0] + side, basePosition[1] + vertical, basePosition[2]];
            const forward = normalize(fit.target.map((v, i) => v - position[i]));
            const right = normalize(cross(forward, [0, 1, 0]));
            const up = normalize(cross(right, forward));
            for (const point of corners(bounds, profile.fitPadding)) {
              const fromCamera = point.map((v, i) => v - position[i]);
              const depth = dot(fromCamera, forward);
              const ndcX = dot(fromCamera, right) / (depth * fovTangent * aspect);
              const ndcY = dot(fromCamera, up) / (depth * fovTangent);
              assert.ok(depth > 0, `${name}, aspect ${aspect}, reserve ${reserve}: corner is behind camera`);
              assert.ok(Math.abs(ndcX) < 1, `${name}, aspect ${aspect}, reserve ${reserve}, offset ${side}/${vertical}: x=${ndcX}`);
              assert.ok(Math.abs(ndcY) < 1, `${name}, aspect ${aspect}, reserve ${reserve}, offset ${side}/${vertical}: y=${ndcY}`);
            }
          }
        }
      }
    }
  }
});

test('sphere fit projects sampled surface points and analytic tangencies inside four actual canvas ratios', () => {
  const center = [1.7, -2.4, 4.1], radius = 3.5, padding = .08, fov = 42, pitch = Math.atan2(3.1, 9.4), fill = .86;
  const actualCanvases = [305 / 300, 390 / 372, 862 / 350, 1355 / 652];
  for (const aspect of actualCanvases) {
    const fit = fitSphereCamera({ center, radius, aspect, fov, pitch, fill, padding });
    assert.deepEqual(fit.target, center);
    const expected = (radius + padding) * Math.sqrt(1 + 1 / (Math.min(Math.tan(fov * Math.PI / 360), Math.tan(fov * Math.PI / 360) * aspect) * fill) ** 2);
    assert.ok(Math.abs(fit.distance - expected) < 1e-12 * expected);
    const base = projectSpherePoint(center, fit.position, center, aspect, fov);
    const expandedRadius = radius + padding;
    const tangent = expandedRadius * Math.sqrt(fit.distance ** 2 - expandedRadius ** 2) / fit.distance;
    const towardCamera = expandedRadius ** 2 / fit.distance;
    const horizontalTangent = center.map((v, i) => v + base.right[i] * tangent - base.forward[i] * towardCamera);
    const verticalTangent = center.map((v, i) => v + base.up[i] * tangent - base.forward[i] * towardCamera);
    const horizontalProjection = projectSpherePoint(horizontalTangent, fit.position, center, aspect, fov);
    const verticalProjection = projectSpherePoint(verticalTangent, fit.position, center, aspect, fov);
    const expectedLimit = aspect < 1 ? Math.abs(horizontalProjection.x) : Math.abs(verticalProjection.y);
    assert.ok(Math.abs(expectedLimit - fill) < 1e-10, `analytic tangent should meet fill for aspect ${aspect}`);
    assert.ok(Math.abs(horizontalProjection.x) <= fill + 1e-10 && Math.abs(verticalProjection.y) <= fill + 1e-10);

    for (let i = 0; i < 180; i++) {
      const y = 1 - 2 * (i + .5) / 180;
      const angle = i * Math.PI * (3 - Math.sqrt(5));
      const planar = Math.sqrt(1 - y * y);
      const point = center.map((v, axis) => v + expandedRadius * (axis === 0 ? planar * Math.cos(angle) : axis === 1 ? y : planar * Math.sin(angle)));
      const projected = projectSpherePoint(point, fit.position, center, aspect, fov);
      assert.ok(projected.depth > 0 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1,
        `sampled sphere point must be visible at aspect ${aspect}`);
    }

    for (const side of [-.35, .35]) for (const vertical of [-.18, .18]) {
      const position = [fit.position[0] + side, fit.position[1] + vertical, fit.position[2]];
      for (const point of [horizontalTangent, verticalTangent, ...Array.from({ length: 48 }, (_, i) => {
        const y = 1 - 2 * (i + .5) / 48, angle = i * Math.PI * (3 - Math.sqrt(5)), planar = Math.sqrt(1 - y * y);
        return center.map((v, axis) => v + expandedRadius * (axis === 0 ? planar * Math.cos(angle) : axis === 1 ? y : planar * Math.sin(angle)));
      })]) {
        const projected = projectSpherePoint(point, position, center, aspect, fov);
        assert.ok(projected.depth > 0 && Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1,
          `offset camera must retain sphere point at aspect ${aspect}, offset ${side}/${vertical}`);
      }
    }
  }
});

test('sphere fit returns fresh arrays for non-origin centers', () => {
  const center = [14, -7, 2.5];
  const first = fitSphereCamera({ center, radius: 2.2, aspect: 1.1 });
  const second = fitSphereCamera({ center, radius: 2.2, aspect: 1.1 });
  assert.deepEqual(first.target, center);
  assert.notStrictEqual(first.target, center);
  assert.notStrictEqual(first.target, second.target);
  assert.notStrictEqual(first.position, second.position);
});

test('sphere fit rejects invalid geometry and camera parameters with RangeError', () => {
  const invalid = [
    null,
    { center: [0, 1], radius: 1, aspect: 1 },
    { center: [0, NaN, 0], radius: 1, aspect: 1 },
    { radius: -1, aspect: 1 },
    { radius: Infinity, aspect: 1 },
    { radius: 1, aspect: 0 },
    { radius: 1, aspect: 1, fov: 180 },
    { radius: 1, aspect: 1, pitch: Math.PI / 2 },
    { radius: 1, aspect: 1, fill: 0 },
    { radius: 1, aspect: 1, padding: -1 },
    { radius: 1, aspect: 1, minDistance: 0 },
    { radius: 1, aspect: 1, minDistance: Infinity },
  ];
  for (const options of invalid) assert.throws(() => fitSphereCamera(options), RangeError);
});
