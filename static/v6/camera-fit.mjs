const finite = value => typeof value === 'number' && Number.isFinite(value);

export function fitSphereCamera(options = {}) {
  if (!options || typeof options !== 'object') throw new RangeError('options must be an object');
  const {
    center = [0, 0, 0],
    radius,
    aspect,
    fov = 42,
    pitch = Math.atan2(3.1, 9.4),
    fill = .70,
    padding = .08,
    minDistance = 1,
  } = options;
  if (!Array.isArray(center) || center.length !== 3 || !center.every(finite)) throw new RangeError('center must be a finite 3D point');
  if (!finite(radius) || radius < 0) throw new RangeError('radius must be finite and nonnegative');
  if (!finite(aspect) || aspect <= 0) throw new RangeError('aspect must be finite and positive');
  if (!finite(fov) || fov <= 0 || fov >= 180) throw new RangeError('fov must be between 0 and 180');
  if (!finite(pitch) || Math.abs(pitch) >= Math.PI / 2) throw new RangeError('pitch must be finite and less than pi/2 in magnitude');
  if (!finite(fill) || fill <= 0 || fill > 1) throw new RangeError('fill must be in (0, 1]');
  if (!finite(padding) || padding < 0) throw new RangeError('padding must be finite and nonnegative');
  if (!finite(minDistance) || minDistance <= 0) throw new RangeError('minDistance must be finite and positive');

  const radiusWithPadding = radius + padding;
  const tanV = Math.tan(fov * Math.PI / 360);
  const tanLimit = Math.min(tanV, tanV * aspect) * fill;
  const distance = Math.max(minDistance, radiusWithPadding * Math.sqrt(1 + 1 / (tanLimit * tanLimit)));
  const position = [
    center[0],
    center[1] + Math.sin(pitch) * distance,
    center[2] + Math.cos(pitch) * distance,
  ];
  if (!finite(distance) || !position.every(finite)) throw new RangeError('sphere fit is outside the finite numeric range');
  return { target: [...center], position, distance };
}

export function fitCamera(options = {}) {
  if (!options || typeof options !== 'object') throw new RangeError('options must be an object');
  const {
    bounds,
    aspect,
    fov = 42,
    pitch = Math.atan2(3.1, 9.4),
    fill = .70,
    padding = .08,
    minDistance = 1,
  } = options;
  if (!bounds || typeof bounds !== 'object') throw new RangeError('bounds must be an object');
  if (!finite(aspect) || aspect <= 0) throw new RangeError('aspect must be finite and positive');
  if (!finite(fov) || fov <= 0 || fov >= 180) throw new RangeError('fov must be between 0 and 180');
  if (!finite(pitch) || Math.abs(pitch) >= Math.PI / 2) throw new RangeError('pitch must be finite and less than pi/2 in magnitude');
  if (!finite(fill) || fill <= 0 || fill > 1) throw new RangeError('fill must be in (0, 1]');
  if (!finite(padding) || padding < 0) throw new RangeError('padding must be finite and nonnegative');
  if (!finite(minDistance)) throw new RangeError('minDistance must be finite');

  const { min, max } = bounds;
  const isPoint = point => Array.isArray(point) && point.length === 3 && point.every(finite);
  if (!isPoint(min) || !isPoint(max)) throw new RangeError('bounds min and max must be finite 3D points');
  for (let axis = 0; axis < 3; axis++) {
    if (min[axis] > max[axis]) throw new RangeError('bounds min must not exceed max');
  }

  const target = min.map((value, axis) => value / 2 + max[axis] / 2);
  const tanV = Math.tan(fov * Math.PI / 360);
  const tanH = tanV * aspect;
  const sinPitch = Math.sin(pitch), cosPitch = Math.cos(pitch);
  let distance = minDistance;

  for (let x = 0; x < 2; x++) {
    for (let y = 0; y < 2; y++) {
      for (let z = 0; z < 2; z++) {
        const dx = (x ? max[0] + padding : min[0] - padding) - target[0];
        const dy = (y ? max[1] + padding : min[1] - padding) - target[1];
        const dz = (z ? max[2] + padding : min[2] - padding) - target[2];
        const u = dx;
        const v = cosPitch * dy - sinPitch * dz;
        const toward = sinPitch * dy + cosPitch * dz;
        const required = Math.max(
          toward + Math.abs(u) / (tanH * fill),
          toward + Math.abs(v) / (tanV * fill),
          toward + .1,
        );
        if (![dx, dy, dz, u, v, toward, required].every(finite)) {
          throw new RangeError('bounds produce a non-finite camera distance');
        }
        distance = Math.max(distance, required);
      }
    }
  }

  const position = [
    target[0],
    target[1] + sinPitch * distance,
    target[2] + cosPitch * distance,
  ];
  if (!position.every(finite) || !finite(distance)) {
    throw new RangeError('camera fit is outside the finite numeric range');
  }
  return { target, position, distance };
}
