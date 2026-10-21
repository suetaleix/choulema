import test from 'node:test';
import assert from 'node:assert/strict';
import { soundCue } from '../static/v6/sound-score.mjs';

const events = [
  'capsule-start', 'capsule-mix', 'capsule-exit', 'capsule-open', 'capsule-return',
  'wheel-start', 'wheel-tick', 'wheel-land', 'wheel-reveal', 'wheel-return',
  'sphere-start', 'sphere-orbit', 'sphere-land', 'sphere-reveal', 'sphere-return',
];

test('returns bounded deterministic cues for every supported event', () => {
  for (const kind of events) {
    const cue = soundCue(kind);
    assert.ok(cue, kind);
    assert.deepEqual(soundCue(kind), cue, kind);
    assert.ok(cue.minIntervalMs >= 0, kind);
    assert.ok(cue.voices.length > 0, kind);
    assert.ok(cue.voices.reduce((sum, v) => sum + v.gain, 0) <= 0.03, kind);
    for (const v of cue.voices) {
      assert.ok(['sine', 'triangle', 'square'].includes(v.wave), kind);
      assert.ok(v.fromHz > 0 && v.toHz > 0, kind);
      assert.ok(v.durationMs > 0 && v.durationMs <= 350, kind);
      assert.ok(v.attackMs >= 0 && v.attackMs <= v.durationMs, kind);
      assert.ok(v.gain >= 0, kind);
    }
  }
});

test('applies minimum spacing to repeated mechanical events', () => {
  assert.ok(soundCue('capsule-mix').minIntervalMs >= 140);
  assert.ok(soundCue('wheel-tick').minIntervalMs >= 75);
  assert.ok(soundCue('sphere-orbit').minIntervalMs >= 450);
});

test('supports transition aliases with the canonical event score', () => {
  assert.deepEqual(soundCue('capsule'), soundCue('capsule-mix'));
  assert.deepEqual(soundCue('wheel'), soundCue('wheel-tick'));
  assert.deepEqual(soundCue('sphere'), soundCue('sphere-orbit'));
});

test('clamps finite energy and safely treats non-finite energy as zero', () => {
  for (const energy of [0, 1, -20, 20, NaN, Infinity, -Infinity]) {
    const cue = soundCue('capsule-mix', energy);
    assert.ok(cue.voices.reduce((sum, v) => sum + v.gain, 0) <= 0.03);
  }
  assert.deepEqual(soundCue('wheel-tick', NaN), soundCue('wheel-tick', 0));
  assert.deepEqual(soundCue('sphere-orbit', Infinity), soundCue('sphere-orbit', 0));
  assert.deepEqual(soundCue('capsule-mix', -10), soundCue('capsule-mix', 0));
  assert.deepEqual(soundCue('capsule-mix', 10), soundCue('capsule-mix', 1));
});

test('adds only a quiet cosmic harmony to capsule opening', () => {
  const classic = soundCue('capsule-open', 1, 'classic');
  const cosmic = soundCue('capsule-open', 1, 'cosmic');
  assert.equal(cosmic.voices.length, classic.voices.length + 1);
  assert.equal(cosmic.voices.at(-1).wave, 'sine');
  assert.ok(cosmic.voices.at(-1).gain <= 0.005);
  assert.ok(cosmic.voices.reduce((sum, v) => sum + v.gain, 0) <= 0.03);
  assert.deepEqual(soundCue('wheel-tick', 1, 'cosmic'), soundCue('wheel-tick'));
  assert.deepEqual(soundCue('capsule-open', 1, 'unknown'), classic);
});

test('returns fresh objects and leaves input values untouched', () => {
  const input = { energy: 0.4, theme: 'cosmic' };
  const before = structuredClone(input);
  const first = soundCue('capsule-open', input.energy, input.theme);
  const second = soundCue('capsule-open', input.energy, input.theme);
  assert.deepEqual(input, before);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.voices, second.voices);
  assert.notStrictEqual(first.voices[0], second.voices[0]);
  first.voices[0].gain = 0;
  assert.notEqual(second.voices[0].gain, 0);
});

test('returns null for unknown event names', () => {
  assert.equal(soundCue('unknown'), null);
  assert.equal(soundCue('capsule-spin'), null);
});

test('rejects inherited object property names as event names', () => {
  for (const kind of ['toString', 'constructor', '__proto__']) {
    assert.equal(soundCue(kind), null, kind);
  }
});
