const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const voice = (wave, fromHz, toHz, durationMs, gain, attackMs) => ({
  wave, fromHz, toHz, durationMs, gain, attackMs,
});

const score = (minIntervalMs, voices) => ({ minIntervalMs, voices });

const EVENTS = {
  'capsule-start': () => score(0, [voice('triangle', 92, 118, 190, 0.018, 28)]),
  'capsule-mix': (e) => score(140, [
    voice('triangle', 210 + 35 * e, 165 + 35 * e, 75, 0.009 + 0.006 * e, 5),
    voice('sine', 470 + 90 * e, 390 + 90 * e, 54, 0.004 + 0.003 * e, 3),
  ]),
  'capsule-exit': () => score(0, [voice('sine', 250, 390, 145, 0.017, 12)]),
  'capsule-open': () => score(0, [voice('triangle', 330, 520, 170, 0.018, 10)]),
  'capsule-return': () => score(0, [voice('sine', 390, 220, 150, 0.016, 12)]),
  'wheel-start': () => score(0, [voice('triangle', 125, 190, 170, 0.016, 18)]),
  'wheel-tick': (e) => score(75, [voice('square', 920 + 230 * e, 760 + 190 * e, 24, 0.008 + 0.005 * e, 2)]),
  'wheel-land': () => score(0, [voice('sine', 260, 205, 125, 0.018, 8)]),
  'wheel-reveal': () => score(0, [voice('triangle', 370, 610, 155, 0.018, 10)]),
  'wheel-return': () => score(0, [voice('sine', 340, 190, 145, 0.015, 12)]),
  'sphere-start': () => score(0, [voice('sine', 220, 260, 190, 0.014, 30)]),
  'sphere-orbit': (e) => score(450, [
    voice('sine', 390 + 100 * e, 430 + 100 * e, 85, 0.008 + 0.004 * e, 15),
    voice('triangle', 585 + 120 * e, 640 + 120 * e, 70, 0.004 + 0.002 * e, 18),
  ]),
  'sphere-land': () => score(0, [voice('sine', 310, 270, 130, 0.014, 18)]),
  'sphere-reveal': () => score(0, [voice('sine', 440, 590, 155, 0.016, 15)]),
  'sphere-return': () => score(0, [voice('sine', 330, 215, 145, 0.014, 18)]),
};

const ALIASES = {
  capsule: 'capsule-mix',
  wheel: 'wheel-tick',
  sphere: 'sphere-orbit',
};

/** Return a deterministic, bounded sound description for a machine event. */
export function soundCue(kind, energy = 1, theme = 'classic') {
  const event = Object.hasOwn(ALIASES, kind) ? ALIASES[kind] : kind;
  if (!Object.hasOwn(EVENTS, event)) return null;
  const create = EVENTS[event];

  const numericEnergy = Number.isFinite(energy) ? clamp(energy, 0, 1) : 0;
  const cue = create(numericEnergy);
  if (event === 'capsule-open' && theme === 'cosmic') {
    cue.voices.push(voice('sine', 495, 742.5, 170, 0.004, 14));
  }
  return cue;
}
