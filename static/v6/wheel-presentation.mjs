import { smooth } from './motion.mjs';
import { sampleSphereLanding, sphereLandingPlan } from './sphere-presentation.mjs';

const TAU = Math.PI * 2;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function wheelLandingPlan(angle, target, velocity, reduced = false) {
  if (typeof reduced !== 'boolean') throw new RangeError('reduced must be boolean');
  return sphereLandingPlan(angle, target, velocity, {
    reduced,
    minCoastSeconds: 1.2,
    slowThreshold: 3,
    slowDuration: 1.4,
  });
}

export function sampleWheelLanding(elapsedSeconds, plan) {
  return sampleSphereLanding(elapsedSeconds, plan);
}

export function advanceWheelSpin(angle, velocity, dt, target = 12, rate = 1.5) {
  if (!finite(angle) || !finite(velocity) || velocity < 0 ||
      !finite(dt) || dt < 0 || !finite(target) || target < 0 ||
      !finite(rate) || rate <= 0) {
    throw new RangeError('spin values must be finite and non-negative, with positive rate');
  }
  if (dt === 0) return { angle, velocity };

  const decay = Math.exp(-rate * dt);
  const nextVelocity = target + (velocity - target) * decay;
  const angularChange = target * dt +
    (velocity - target) * (-Math.expm1(-rate * dt)) / rate;
  const nextAngle = angle + angularChange;
  if (!finite(nextVelocity) || !finite(nextAngle)) {
    throw new RangeError('spin result must remain finite');
  }
  return { angle: nextAngle, velocity: nextVelocity };
}

export function wheelTick(angle, segments, now, state = { sector: null, lastTick: null }, interval = .08) {
  if (!finite(angle) || !Number.isInteger(segments) || segments < 2 || segments > 48 ||
      !finite(now) || now < 0 || !finite(interval) || interval <= 0 ||
      !state || typeof state !== 'object' || Array.isArray(state) ||
      !(state.sector === null || Number.isInteger(state.sector)) ||
      !(state.lastTick === null || (finite(state.lastTick) && state.lastTick >= 0))) {
    throw new RangeError('invalid wheel tick input');
  }

  const sector = Math.floor(angle / (TAU / segments));
  const tick = state.sector !== null && sector !== state.sector &&
    (state.lastTick === null || now - state.lastTick >= interval);
  return {
    sector,
    lastTick: tick ? now : state.lastTick,
    tick,
  };
}

export function wheelSettleProgress(elapsed, landingDuration, settleDuration = .45) {
  if (!finite(elapsed) || !finite(landingDuration) || landingDuration < 0 ||
      !finite(settleDuration) || settleDuration < 0) {
    throw new RangeError('settle timing values must be finite and durations non-negative');
  }
  if (settleDuration === 0) return elapsed >= landingDuration ? 1 : 0;
  return smooth((elapsed - landingDuration) / settleDuration);
}
