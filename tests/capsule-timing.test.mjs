import test from 'node:test';
import assert from 'node:assert/strict';
import { MACHINE_PROFILES } from '../static/v6/machine-profiles.mjs';
import { capsuleOutSample, capsuleReturnSample } from '../static/v6/capsule-presentation.mjs';

test('configured result and restart waits cover the complete capsule actions', () => {
  const timing = MACHINE_PROFILES.capsule.timing;
  const options = { ...timing, exitProgress: .6 };
  assert.equal(capsuleOutSample(timing.flightMs, options).open, 0,
    'the capsule must finish travelling before the shell opens');
  assert.equal(capsuleOutSample(timing.revealDelayMs, options).done, true,
    'the panel must not precede the completed shell opening');
  const celebration = capsuleOutSample(timing.celebrationMs, options);
  assert.equal(celebration.pathProgress, 1, 'the reveal burst belongs at the settled result');
  assert.ok(celebration.open > 0, 'celebration must wait for the opening');
  const returnOptions = {
    closeMs: timing.returnCloseMs, travelMs: timing.returnTravelMs, exitProgress: .6,
  };
  const closed = capsuleReturnSample(timing.returnCloseMs, returnOptions);
  assert.equal(closed.open, 0);
  assert.equal(closed.pathProgress, 1, 'return travel must wait for the shell to close');
  assert.equal(capsuleReturnSample(timing.returnMs, returnOptions).done, true,
    'the next draw must not interrupt the return');
});
