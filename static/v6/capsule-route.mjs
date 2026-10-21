const finite = value => typeof value === 'number' && Number.isFinite(value);

function point3(value, name) {
  if (!Array.isArray(value) || value.length !== 3 || !finite(value[0]) || !finite(value[1]) || !finite(value[2])) {
    throw new RangeError(`${name} must be a finite 3D point`);
  }
  return [...value];
}

export function capsuleRouteSegments(startLocal, targetLocal) {
  const start = point3(startLocal, 'startLocal');
  const target = point3(targetLocal, 'targetLocal');
  if (target[2] <= 2.28) throw new RangeError('targetLocal.z must exceed 2.28');
  if (target[1] < -1.7) throw new RangeError('targetLocal.y must be at least -1.7');

  const outletStart = [0, -1.7, .55];
  const outletEnd = [0, -1.7, 1.82];
  return {
    segments: [
      { type: 'cubic', points: [start, [0, -.35, 0], [0, -1.7, .05], [...outletStart]] },
      { type: 'line', points: [[...outletStart], [...outletEnd]] },
      { type: 'cubic', points: [[...outletEnd], [0, -1.7, 2.10], [target[0], target[1] - .12, target[2] - .18], target] },
    ],
    exitAfterSegment: 1,
  };
}
