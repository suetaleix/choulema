import test from 'node:test';
import assert from 'node:assert/strict';
import { landingPlan } from '../static/v6/motion.mjs';
import {
  advanceWheelSpin,
  sampleWheelLanding,
  wheelLandingPlan,
  wheelSettleProgress,
  wheelTick,
} from '../static/v6/wheel-presentation.mjs';

const tau = Math.PI * 2;
const angleDistance = (a, b) => Math.abs(((a - b + Math.PI) % tau + tau) % tau - Math.PI);

test('normal wheel plans preserve legacy distance and duration', () => {
  for (const angle of [-15.7, 0, .25, 5.9, 100, 1000]) {
    for (const target of [-4.2, 0, 1.7, tau * 3 + .4]) {
      for (const velocity of [3, 6.4, 12]) {
        const legacy = landingPlan(angle, target, velocity);
        const plan = wheelLandingPlan(angle, target, velocity);
        assert.equal(plan.curve, 'brake');
        assert.ok(Math.abs(plan.distance - legacy.distance) < 1e-10);
        assert.ok(Math.abs(plan.duration - legacy.duration) < 1e-10);
      }
    }
  }
});

test('all 2, 8, 12, and 48 sector centers land through wrap and multiple turns', () => {
  for (const segments of [2, 8, 12, 48]) {
    for (let index = 0; index < segments; index++) {
      const target = -((index + .5) * tau / segments);
      for (const angle of [-tau * 3 - .02, tau - .03, tau * 7 + .11]) {
        const plan = wheelLandingPlan(angle, target, 12);
        const end = sampleWheelLanding(plan.duration, plan);
        assert.equal(end.done, true);
        assert.equal(end.velocity, 0);
        assert.ok(angleDistance(end.angle, target) < 1e-9);
        assert.ok(plan.distance > 0);
      }
    }
  }
});

test('low-speed Hermite plans start at actual speed, never reverse, and stop at target', () => {
  for (const velocity of [0, .1, 2.9, 3, 12]) {
    for (const [angle, target] of [[1.2, 1.8], [tau - .04, .05], [5.3, -1.1]]) {
      const plan = wheelLandingPlan(angle, target, velocity);
      if (velocity >= 3) assert.equal(plan.curve, 'brake');
      const start = sampleWheelLanding(0, plan);
      assert.ok(Math.abs(start.velocity - velocity) < 1e-12);
      let previous = start;
      for (let i = 1; i <= 120; i++) {
        const current = sampleWheelLanding(plan.duration * i / 120, plan);
        assert.ok(current.angle >= previous.angle - 1e-12);
        assert.ok(current.velocity >= -1e-10);
        previous = current;
      }
      const end = sampleWheelLanding(plan.duration, plan);
      assert.equal(end.done, true);
      assert.equal(end.velocity, 0);
      assert.ok(angleDistance(end.angle, target) < 1e-9);
    }
  }
});

test('reduced wheel reveal snaps directly to the selected angle', () => {
  for (const [angle, target, velocity] of [[0, 0, 12], [tau * 3 + .2, -.4, .1]]) {
    const plan = wheelLandingPlan(angle, target, velocity, true);
    assert.equal(plan.curve, 'snap');
    assert.equal(plan.duration, 0);
    const end = sampleWheelLanding(-1, plan);
    assert.equal(end.done, true);
    assert.equal(end.velocity, 0);
    assert.ok(angleDistance(end.angle, target) < 1e-9);
  }
});

function runSpin(fps, duration) {
  let pose = { angle: .73, velocity: .4 };
  for (let i = 0; i < fps * duration; i++) {
    pose = advanceWheelSpin(pose.angle, pose.velocity, 1 / fps);
  }
  return pose;
}

test('analytic spin integration agrees at 30/60 fps and across split updates', () => {
  const at30 = runSpin(30, 5.2), at60 = runSpin(60, 5.2);
  assert.ok(Math.abs(at30.angle - at60.angle) < 1e-10);
  assert.ok(Math.abs(at30.velocity - at60.velocity) < 1e-12);

  const whole = advanceWheelSpin(2.4, 1.1, 4.8, 12, 1.5);
  const first = advanceWheelSpin(2.4, 1.1, 1.7, 12, 1.5);
  const split = advanceWheelSpin(first.angle, first.velocity, 3.1, 12, 1.5);
  assert.ok(Math.abs(whole.angle - split.angle) < 1e-12);
  assert.ok(Math.abs(whole.velocity - split.velocity) < 1e-12);
  assert.deepEqual(advanceWheelSpin(4, 2, 0), { angle: 4, velocity: 2 });
});

test('wheel ticks are initial-silent, rate-limited, and never replay skipped crossings', () => {
  for (const fps of [30, 60]) {
    let state = { sector: null, lastTick: null }, tickTimes = [], seen = 0;
    for (let frame = 0; frame <= fps * 2; frame++) {
      const now = frame / fps, angle = now * 12;
      const next = wheelTick(angle, 48, now, state);
      if (frame === 0) assert.equal(next.tick, false);
      if (next.tick) {
        tickTimes.push(now);
        assert.ok(now - state.lastTick >= .08 - 1e-12 || state.lastTick === null);
      }
      seen += Math.abs(next.sector - state.sector);
      state = next;
    }
    assert.ok(tickTimes.length > 0);
    for (let i = 1; i < tickTimes.length; i++) {
      assert.ok(tickTimes[i] - tickTimes[i - 1] >= .08 - 1e-12);
    }
    assert.ok(tickTimes.length < seen, 'crossed sectors should not be replayed as a backlog');
  }
});

test('winner settle begins after landing and reaches its resting pose after 0.45 seconds', () => {
  const landing = 2.8;
  assert.equal(wheelSettleProgress(-.1, landing), 0);
  assert.equal(wheelSettleProgress(landing, landing), 0);
  assert.ok(Math.abs(wheelSettleProgress(landing + .225, landing) - .5) < 1e-12);
  assert.equal(wheelSettleProgress(landing + .45, landing), 1);
  assert.equal(wheelSettleProgress(landing, landing, 0), 1);
  assert.equal(wheelSettleProgress(landing - .001, landing, 0), 0);
});

test('wheel helpers reject invalid values and leave supplied state unchanged', () => {
  for (const args of [[NaN, 0, 1], [0, 0, -1], [0, 0, Infinity], [0, 0, 1, 1]]) {
    assert.throws(() => wheelLandingPlan(...args), RangeError);
  }
  assert.throws(() => wheelLandingPlan(0, 1, 1, 1), RangeError);
  for (const args of [[NaN, 0, .1], [0, -1, .1], [0, 0, -1], [0, 0, .1, -1], [0, 0, .1, 12, 0]]) {
    assert.throws(() => advanceWheelSpin(...args), RangeError);
  }
  assert.throws(() => advanceWheelSpin(1e308, 1e308, 1, 0, .1), RangeError);

  const state = { sector: 2, lastTick: .3 };
  assert.throws(() => wheelTick(NaN, 12, 1, state), RangeError);
  assert.throws(() => wheelTick(0, 49, 1, state), RangeError);
  assert.throws(() => wheelTick(0, 12, -1, state), RangeError);
  assert.throws(() => wheelTick(0, 12, 1, { sector: '2', lastTick: null }), RangeError);
  assert.deepEqual(state, { sector: 2, lastTick: .3 });
  assert.throws(() => wheelSettleProgress(Infinity, 1), RangeError);
  assert.throws(() => wheelSettleProgress(0, -1), RangeError);
  assert.throws(() => wheelSettleProgress(0, 1, -1), RangeError);
});
