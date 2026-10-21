import { fitCamera } from './camera-fit.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);

/** Fit a sparse point cloud while using its AABB midpoint as the camera target. */
export function fitCameraPoints(options = {}) {
  if (!options || typeof options !== 'object') throw new RangeError('options must be an object');
  const { points, bounds, aspect } = options;
  if (!Array.isArray(points) || points.length === 0) {
    throw new RangeError('points must be a nonempty array');
  }
  for (const point of points) {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(finite)) {
      throw new RangeError('each point must be a finite 3D point');
    }
  }

  // Reuse box and view-option validation, and use its stable center target.
  const validatedFit = fitCamera({ bounds, aspect, ...options });
  const { min, max } = bounds;
  for (const point of points) {
    if (point.some((value, axis) => value < min[axis] || value > max[axis])) {
      throw new RangeError('bounds must contain every point');
    }
  }

  const fov = options.fov ?? 42;
  const pitch = options.pitch ?? Math.atan2(3.1, 9.4);
  const fill = options.fill ?? .70;
  const padding = options.padding ?? .08;
  const minDistance = options.minDistance ?? 1;
  if (!finite(minDistance) || minDistance <= 0) {
    throw new RangeError('minDistance must be finite and positive');
  }

  const tanV = Math.tan(fov * Math.PI / 360);
  const tanH = tanV * aspect;
  const sinPitch = Math.sin(pitch), cosPitch = Math.cos(pitch);
  let distance = minDistance;
  for (const point of points) {
    const dx = point[0] - validatedFit.target[0];
    const dy = point[1] - validatedFit.target[1];
    const dz = point[2] - validatedFit.target[2];
    const u = dx;
    const v = cosPitch * dy - sinPitch * dz;
    const toward = sinPitch * dy + cosPitch * dz;
    const required = Math.max(
      toward + padding + (Math.abs(u) + padding) / (tanH * fill),
      toward + padding + (Math.abs(v) + padding) / (tanV * fill),
      toward + padding + .1,
    );
    if (![dx, dy, dz, u, v, toward, required].every(finite)) {
      throw new RangeError('points produce a non-finite camera distance');
    }
    distance = Math.max(distance, required);
  }

  const position = [
    validatedFit.target[0],
    validatedFit.target[1] + sinPitch * distance,
    validatedFit.target[2] + cosPitch * distance,
  ];
  if (!finite(distance) || !position.every(finite)) {
    throw new RangeError('camera fit is outside the finite numeric range');
  }
  return { target: [...validatedFit.target], position, distance };
}
