import test from 'node:test';
import assert from 'node:assert/strict';
import { sphereLandingPlan, sampleSphereLanding } from '../static/v6/sphere-presentation.mjs';

const tau = Math.PI * 2;
const mod = value => ((value % tau) + tau) % tau;
const angleDistance = (a, b) => Math.abs(((a - b + Math.PI) % tau + tau) % tau - Math.PI);

function sampleAtRate(plan, fps) {
  let sample = sampleSphereLanding(0, plan);
  for (let elapsed = 1 / fps; elapsed < plan.duration; elapsed += 1 / fps) {
    sample = sampleSphereLanding(elapsed, plan);
  }
  return sampleSphereLanding(plan.duration, plan);
}

test('normal 6.4 rad/s plans preserve speed, brake monotonically, and land on the requested angle', () => {
  for (const [angle, target] of [[0, 0], [5.9, .2], [-8.1, 2.4], [2.2, 5.8]]) {
    const plan = sphereLandingPlan(angle, target, 6.4);
    assert.equal(plan.curve, 'brake');
    assert.ok(plan.distance >= 6.4 * 1.1);
    assert.ok(plan.duration >= 2.2 && plan.duration <= 2 * (6.4 * 1.1 + tau) / 6.4);
    const h = 1e-6;
    const initial = sampleSphereLanding(0, plan);
    const shortlyAfter = sampleSphereLanding(h, plan);
    assert.ok(Math.abs((shortlyAfter.angle - initial.angle) / h - 6.4) < 1e-4);
    assert.ok(Math.abs(initial.velocity - 6.4) < 1e-12);
    let previous = initial;
    for (let i = 1; i <= 100; i++) {
      const current = sampleSphereLanding(plan.duration * i / 100, plan);
      assert.ok(current.angle >= previous.angle, 'braking must never reverse');
      assert.ok(current.velocity <= previous.velocity + 1e-10, 'braking speed must not rise');
      previous = current;
    }
    assert.ok(angleDistance(sampleSphereLanding(plan.duration, plan).angle, mod(target)) < 1e-10);
    assert.equal(sampleSphereLanding(plan.duration, plan).velocity, 0);
  }
});

test('low-speed recovery stays bounded and Hermite motion matches its initial speed', () => {
  for (const velocity of [0, .12, 1.4, 2.8]) {
    const target = 1.5;
    const plan = sphereLandingPlan(1.25, target, velocity);
    assert.equal(plan.curve, 'hermite');
    assert.ok(plan.duration > 0 && plan.duration <= 1.4);
    const h = 1e-6;
    const start = sampleSphereLanding(0, plan);
    const next = sampleSphereLanding(h, plan);
    assert.ok(Math.abs((next.angle - start.angle) / h - velocity) < 2e-4);
    assert.ok(Math.abs(start.velocity - velocity) < 1e-12);
    let previous = start;
    for (let i = 1; i <= 100; i++) {
      const current = sampleSphereLanding(plan.duration * i / 100, plan);
      assert.ok(current.angle >= previous.angle, 'recovery must not reverse');
      assert.ok(current.velocity >= -1e-10, 'recovery speed must remain non-negative');
      previous = current;
    }
    const end = sampleSphereLanding(plan.duration, plan);
    assert.ok(angleDistance(end.angle, target) < 1e-10);
    assert.equal(end.velocity, 0);
    assert.equal(end.done, true);
  }
});

test('small positive angles tolerate Hermite slope roundoff without changing motion behavior', () => {
  const reproduced = sphereLandingPlan(.12466999999999999, .33296958828969625, 2.8);
  assert.equal(reproduced.curve, 'hermite');
  for (const angle of [0, .12466999999999999, 1.734]) {
    for (const distance of [1e-9, 1e-8, 1e-7, 1e-6, 1e-4, .01]) {
      const plan = sphereLandingPlan(angle, angle + distance, 2.8);
      assert.equal(plan.curve, 'hermite');
      const start = sampleSphereLanding(0, plan);
      assert.ok(Math.abs(start.velocity - 2.8) < 1e-11);
      let previous = start;
      for (let i = 1; i <= 20; i++) {
        const current = sampleSphereLanding(plan.duration * i / 20, plan);
        assert.ok(current.angle >= previous.angle, 'small-angle recovery must not reverse');
        assert.ok(current.velocity >= -1e-10, 'small-angle speed must remain non-negative');
        previous = current;
      }
      const end = sampleSphereLanding(plan.duration, plan);
      assert.ok(end.done);
      assert.equal(end.velocity, 0);
    }
  }
});

test('zero-distance and reduced-motion plans snap to the final angle', () => {
  const still = sphereLandingPlan(2, 2, 0);
  assert.deepEqual(still, { angle: 2, distance: 0, duration: 0, initialSpeed: 0, curve: 'snap' });
  assert.deepEqual(sampleSphereLanding(0, still), { angle: 2, velocity: 0, done: true });
  const reduced = sphereLandingPlan(6, .2, 6.4, { reduced: true });
  assert.equal(reduced.curve, 'snap');
  assert.equal(reduced.duration, 0);
  assert.ok(angleDistance(sampleSphereLanding(0, reduced).angle, .2) < 1e-10);
});

test('sampling is independent of frame cadence and clamps after completion', () => {
  const plan = sphereLandingPlan(5.7, .4, 6.4);
  const at30 = sampleAtRate(plan, 30);
  const at60 = sampleAtRate(plan, 60);
  assert.deepEqual(at30, at60);
  assert.deepEqual(sampleSphereLanding(plan.duration + 20, plan), at30);
  assert.equal(sampleSphereLanding(-.5, plan).angle, plan.angle);
});

test('invalid parameters and malformed plans are rejected', () => {
  for (const args of [
    [NaN, 0, 1], [0, Infinity, 1], [0, 1, -1], [0, 1, NaN],
    [0, 1, 1, { reduced: 1 }], [0, 1, 1, { minCoastSeconds: 0 }],
    [0, 1, 1, { slowThreshold: Infinity }], [0, 1, 1, { slowDuration: -1 }],
  ]) assert.throws(() => sphereLandingPlan(...args), RangeError);
  for (const elapsed of [NaN, Infinity, -Infinity]) {
    assert.throws(() => sampleSphereLanding(elapsed, sphereLandingPlan(0, 1, 1)), RangeError);
  }
  for (const plan of [
    null,
    { angle: 0, distance: 1, duration: 1, initialSpeed: 1, curve: 'other' },
    { angle: 0, distance: 1, duration: 0, initialSpeed: 1, curve: 'brake' },
    { angle: 0, distance: 0, duration: 1, initialSpeed: 1, curve: 'hermite' },
    { angle: 0, distance: 1, duration: 3, initialSpeed: 1, curve: 'hermite' },
    { angle: 0, distance: 1, duration: 1, initialSpeed: 1, curve: 'snap' },
  ]) assert.throws(() => sampleSphereLanding(0, plan), RangeError);
});
