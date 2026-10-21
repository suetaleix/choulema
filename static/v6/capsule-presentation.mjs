import { smooth } from './motion.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = value => Math.max(0, Math.min(1, value));

function requireOptions(options, name) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new RangeError(`${name} options must be an object`);
  }
}

function requireFinite(value, name) {
  if (!finite(value)) throw new RangeError(`${name} must be finite`);
}

function requirePositive(value, name) {
  requireFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function requireUnit(value, name) {
  requireFinite(value, name);
  if (value < 0 || value > 1) throw new RangeError(`${name} must be in [0, 1]`);
}

function requireExitProgress(value) {
  requireFinite(value, 'exitProgress');
  if (value <= 0 || value >= 1) throw new RangeError('exitProgress must be in (0, 1)');
}

export function capsuleScaleProgress(pathProgress, exitProgress) {
  requireFinite(pathProgress, 'pathProgress');
  requireExitProgress(exitProgress);
  return smooth(clamp((pathProgress - exitProgress) / (1 - exitProgress)));
}

export function capsuleOutSample(elapsedMs, options = {}) {
  requireFinite(elapsedMs, 'elapsedMs');
  requireOptions(options, 'capsuleOutSample');
  const { flightMs, openDelayMs, openMs, exitProgress, settleLift = 0 } = options;
  requirePositive(flightMs, 'flightMs');
  requireFinite(openDelayMs, 'openDelayMs');
  if (openDelayMs < flightMs) throw new RangeError('openDelayMs must not precede flightMs');
  requirePositive(openMs, 'openMs');
  requireExitProgress(exitProgress);
  requireFinite(settleLift, 'settleLift');
  if (settleLift < 0) throw new RangeError('settleLift must be nonnegative');

  const pathProgress = smooth(clamp(elapsedMs / flightMs));
  const scaleProgress = capsuleScaleProgress(pathProgress, exitProgress);
  const open = smooth(clamp((elapsedMs - openDelayMs) / openMs));
  let settleY = 0;
  if (elapsedMs > flightMs && elapsedMs < openDelayMs) {
    const phase = (elapsedMs - flightMs) / (openDelayMs - flightMs);
    settleY = settleLift * Math.sin(Math.PI * phase) ** 2;
  }
  return {
    pathProgress,
    scaleProgress,
    open,
    settleY,
    done: elapsedMs >= openDelayMs + openMs,
  };
}

export function capsuleReturnSample(elapsedMs, options = {}) {
  requireFinite(elapsedMs, 'elapsedMs');
  requireOptions(options, 'capsuleReturnSample');
  const { closeMs, travelMs, exitProgress, startProgress = 1, startOpen = 1 } = options;
  requirePositive(closeMs, 'closeMs');
  requirePositive(travelMs, 'travelMs');
  requireExitProgress(exitProgress);
  requireUnit(startProgress, 'startProgress');
  requireUnit(startOpen, 'startOpen');

  const returnProgress = smooth(clamp((elapsedMs - closeMs) / travelMs));
  const pathProgress = startProgress * (1 - returnProgress);
  const scaleProgress = capsuleScaleProgress(pathProgress, exitProgress);
  const open = startOpen * (1 - smooth(clamp(elapsedMs / closeMs)));
  return {
    pathProgress,
    scaleProgress,
    open,
    returnProgress,
    done: elapsedMs >= closeMs + travelMs,
  };
}
