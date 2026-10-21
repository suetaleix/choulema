import test from 'node:test';
import assert from 'node:assert/strict';
import { SHARED_PROFILE, MACHINE_PROFILES } from '../static/v6/machine-profiles.mjs';
import { damp } from '../static/v6/motion.mjs';
import { sphereLandingPlan, sampleSphereLanding } from '../static/v6/sphere-presentation.mjs';

test('configured sphere startup reaches continuous braking within the designed presentation time', () => {
  const motion = MACHINE_PROFILES.sphere.motion;
  const runSeconds = SHARED_PROFILE.timing.automaticRunMs / 1000;
  for (const fps of [30, 60]) {
    let velocity = 0, angle = 0;
    for (let frame = 0; frame < Math.round(runSeconds * fps); frame++) {
      velocity = damp(velocity, motion.spinSpeed, motion.spinDamping, 1 / fps);
      angle += velocity / fps;
    }
    for (let sector = 0; sector < 24; sector++) {
      const plan = sphereLandingPlan(angle, sector * Math.PI / 12, velocity, motion);
      assert.equal(plan.curve, 'brake', 'a full run must use the continuous deceleration branch');
      assert.ok(Math.abs(sampleSphereLanding(0, plan).velocity - velocity) < 1e-10);
      const total = runSeconds + plan.duration + MACHINE_PROFILES.sphere.timing.revealDelayTailMs / 1000;
      assert.ok(total >= 8.8 - 1e-9 && total <= 10.8, `full sequence took ${total} seconds`);
    }
  }
});
