import { brakeProgress, brakeSpeed } from './motion.mjs';

const TAU = Math.PI * 2;
const MIN_DISTANCE = 1e-9;
const SLOPE_TOLERANCE = 1e-12;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0;
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new RangeError('plan must be an object');
  }
  const { angle, distance, duration, initialSpeed, curve } = plan;
  if (!finite(angle) || !finite(distance) || distance < 0 ||
      !finite(initialSpeed) || initialSpeed < 0) {
    throw new RangeError('plan values must be finite and non-negative');
  }
  if (!['brake', 'hermite', 'snap'].includes(curve)) {
    throw new RangeError('unsupported curve');
  }
  if (curve === 'snap') {
    if (!finite(duration) || duration !== 0) throw new RangeError('snap duration must be zero');
    return;
  }
  if (!positive(duration) || !(distance > 0) || !finite(angle + distance)) {
    throw new RangeError('animated plans need finite positive duration and distance');
  }
  if (curve === 'hermite') {
    const a = initialSpeed * duration / distance;
    if (!finite(a) || a < -SLOPE_TOLERANCE || a > 2 + SLOPE_TOLERANCE) {
      throw new RangeError('hermite start slope is out of range');
    }
  }
}

export function sphereLandingPlan(angle, target, velocity, {
  reduced = false,
  minCoastSeconds = 1.1,
  slowThreshold = 3,
  slowDuration = 1.4,
} = {}) {
  if (!finite(angle) || !finite(target) || !finite(velocity) || velocity < 0) {
    throw new RangeError('angle and target must be finite; velocity must be finite and non-negative');
  }
  if (typeof reduced !== 'boolean' || !positive(minCoastSeconds) ||
      !positive(slowThreshold) || !positive(slowDuration)) {
    throw new RangeError('invalid landing options');
  }

  let distance = ((target - angle) % TAU + TAU) % TAU;
  if (!finite(distance)) throw new RangeError('landing distance must be finite');
  if (reduced) {
    return { angle, distance, duration: 0, initialSpeed: velocity, curve: 'snap' };
  }

  if (velocity >= slowThreshold) {
    const minimumDistance = velocity * minCoastSeconds;
    if (!finite(minimumDistance)) throw new RangeError('coast distance is too large');
    if (distance < minimumDistance) {
      const revolutions = Math.ceil((minimumDistance - distance) / TAU);
      distance += revolutions * TAU;
    }
    const duration = 2 * distance / velocity;
    if (!finite(distance) || !positive(distance) || !positive(duration)) {
      throw new RangeError('braking plan is outside the finite range');
    }
    return { angle, distance, duration, initialSpeed: velocity, curve: 'brake' };
  }

  if (distance < MIN_DISTANCE && velocity > 0) distance += TAU;
  if (distance < MIN_DISTANCE && velocity === 0) {
    return { angle, distance: 0, duration: 0, initialSpeed: 0, curve: 'snap' };
  }
  const duration = velocity > 0
    ? Math.min(slowDuration, 2 * distance / velocity)
    : slowDuration;
  const slope = velocity * duration / distance;
  if (!positive(distance) || !positive(duration) || !finite(slope) ||
      slope < -SLOPE_TOLERANCE || slope > 2 + SLOPE_TOLERANCE) {
    throw new RangeError('slow landing plan is outside the finite range');
  }
  return { angle, distance, duration, initialSpeed: velocity, curve: 'hermite' };
}

export function sampleSphereLanding(elapsedSeconds, plan) {
  if (!finite(elapsedSeconds)) throw new RangeError('elapsed time must be finite');
  validatePlan(plan);
  if (plan.curve === 'snap') {
    return { angle: plan.angle + plan.distance, velocity: 0, done: true };
  }

  const elapsed = Math.max(0, elapsedSeconds);
  const t = Math.min(1, elapsed / plan.duration);
  let progress;
  let speed;
  if (plan.curve === 'brake') {
    progress = brakeProgress(t);
    speed = plan.distance / plan.duration * brakeSpeed(t);
  } else {
    const a = Math.max(0, Math.min(2, plan.initialSpeed * plan.duration / plan.distance));
    progress = (a - 2) * t ** 3 + (3 - 2 * a) * t ** 2 + a * t;
    speed = plan.distance / plan.duration *
      (3 * (a - 2) * t ** 2 + 2 * (3 - 2 * a) * t + a);
  }
  const done = elapsed >= plan.duration;
  return {
    angle: done ? plan.angle + plan.distance : plan.angle + plan.distance * progress,
    velocity: done ? 0 : speed,
    done,
  };
}
