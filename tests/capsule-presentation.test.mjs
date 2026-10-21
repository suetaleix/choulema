import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capsuleOutSample,
  capsuleReturnSample,
  capsuleScaleProgress,
} from '../static/v6/capsule-presentation.mjs';

const out = { flightMs: 1000, openDelayMs: 1200, openMs: 400, exitProgress: .7, settleLift: .035 };

test('scale waits for the exit threshold and stays bounded and monotone afterward', () => {
  for (const progress of [-2, 0, .2, .69, .7]) assert.equal(capsuleScaleProgress(progress, .7), 0);
  const samples = [.71, .76, .82, .9, .97, 1, 1.4].map(progress => capsuleScaleProgress(progress, .7));
  assert.ok(samples[0] > 0, 'scale should begin after crossing the exit');
  assert.ok(samples.every(value => value >= 0 && value <= 1));
  for (let index = 1; index < samples.length; index++) assert.ok(samples[index] >= samples[index - 1]);
  assert.equal(capsuleScaleProgress(2, .7), 1);
});

test('outbound route is monotone; exit enlargement precedes settling, then opening', () => {
  const times = [0, 150, 300, 500, 600, 620, 900, 1000, 1050, 1100, 1190, 1200, 1280, 1599, 1600, 1800];
  const samples = times.map(time => capsuleOutSample(time, out));
  for (let index = 1; index < samples.length; index++) {
    assert.ok(samples[index].pathProgress >= samples[index - 1].pathProgress);
    assert.ok(samples[index].scaleProgress >= samples[index - 1].scaleProgress);
    assert.ok(samples[index].open >= samples[index - 1].open);
  }
  assert.equal(samples[0].pathProgress, 0);
  assert.equal(samples[0].scaleProgress, 0);
  assert.equal(samples[4].scaleProgress, 0, 'capsule has not cleared the exit at 60% time progress');
  assert.ok(samples[5].scaleProgress > 0, 'capsule may enlarge only after it clears the exit');
  assert.ok(samples.slice(0, 11).every(sample => sample.open === 0), 'shell stays closed until the stop delay');
  assert.ok(samples[8].settleY > 0, 'a settled capsule gets a small lift while waiting to open');
  assert.ok(samples[8].settleY <= out.settleLift);
  assert.equal(samples[7].settleY, 0);
  assert.equal(samples[11].settleY, 0);
  assert.equal(samples[11].open, 0);
  assert.ok(samples[12].open > 0 && samples[12].open < 1);
  assert.equal(samples[13].done, false);
  assert.equal(samples[14].done, true);
  assert.equal(samples[14].open, 1);
  assert.equal(samples[14].pathProgress, 1);
  assert.deepEqual(samples[15], samples[14]);
});

test('settle bump has zero endpoints and near-zero endpoint velocity', () => {
  const h = .1;
  const start = capsuleOutSample(out.flightMs, out).settleY;
  const justAfterStart = capsuleOutSample(out.flightMs + h, out).settleY;
  const justBeforeEnd = capsuleOutSample(out.openDelayMs - h, out).settleY;
  const end = capsuleOutSample(out.openDelayMs, out).settleY;
  assert.equal(start, 0);
  assert.equal(end, 0);
  assert.ok(Math.abs((justAfterStart - start) / h) < 1e-5);
  assert.ok(Math.abs((end - justBeforeEnd) / h) < 1e-5);
  assert.ok(capsuleOutSample((out.flightMs + out.openDelayMs) / 2, out).settleY > justAfterStart);
});

test('negative and sparse outbound times still yield the stable final pose', () => {
  const before = capsuleOutSample(-500, out);
  assert.equal(before.pathProgress, 0);
  assert.equal(before.scaleProgress, 0);
  assert.equal(before.open, 0);
  assert.equal(before.done, false);
  const skipped = capsuleOutSample(out.openDelayMs + out.openMs + 5000, out);
  assert.equal(skipped.pathProgress, 1);
  assert.equal(skipped.scaleProgress, 1);
  assert.equal(skipped.open, 1);
  assert.equal(skipped.done, true);
  assert.deepEqual(capsuleOutSample(out.openDelayMs + out.openMs + 6000, out), skipped);
});

test('return closes before moving and retracts through the exit before losing scale', () => {
  const options = { closeMs: 220, travelMs: 650, exitProgress: .5, startProgress: .8, startOpen: .8 };
  const samples = [0, 80, 219, 220, 220 + 650 * .25, 220 + 650 * .5, 220 + 650 * .75, 870, 1200]
    .map(time => capsuleReturnSample(time, options));
  assert.ok(samples.slice(0, 3).every(sample => sample.pathProgress === options.startProgress));
  assert.ok(samples.slice(0, 3).every(sample => sample.scaleProgress === samples[0].scaleProgress));
  assert.ok(samples[0].open === options.startOpen && samples[1].open < samples[0].open && samples[2].open > 0);
  assert.equal(samples[3].open, 0, 'shell must be closed before return travel begins');
  assert.equal(samples[3].pathProgress, options.startProgress);
  assert.ok(samples[4].pathProgress < samples[3].pathProgress);
  assert.ok(samples[4].scaleProgress > 0, 'scale remains while the capsule is beyond the exit');
  assert.equal(samples[5].pathProgress, options.startProgress * .5);
  assert.equal(samples[5].scaleProgress, 0, 'scale has retracted at the exit threshold');
  assert.equal(samples[6].scaleProgress, 0);
  assert.ok(samples[6].pathProgress < samples[5].pathProgress);
  assert.equal(samples[7].done, true);
  assert.equal(samples[7].pathProgress, 0);
  assert.equal(samples[7].open, 0);
  assert.deepEqual(samples[8], samples[7], 'late frames retain the final returned pose');
});

test('return preserves caller-supplied mid-flight starting pose without a jump', () => {
  const options = { closeMs: 200, travelMs: 500, exitProgress: .4, startProgress: .65, startOpen: .35 };
  const first = capsuleReturnSample(0, options);
  const before = capsuleReturnSample(-1, options);
  assert.equal(first.pathProgress, options.startProgress);
  assert.equal(first.open, options.startOpen);
  assert.equal(first.returnProgress, 0);
  assert.equal(first.pathProgress, before.pathProgress);
  assert.equal(first.scaleProgress, before.scaleProgress);
  assert.equal(first.open, before.open);
});

test('rejects non-finite values and invalid timing or progress ranges', () => {
  assert.throws(() => capsuleScaleProgress(NaN, .5), RangeError);
  assert.throws(() => capsuleScaleProgress(.5, 0), RangeError);
  assert.throws(() => capsuleScaleProgress(.5, 1), RangeError);
  assert.throws(() => capsuleOutSample(Infinity, out), RangeError);
  assert.throws(() => capsuleOutSample(0, { ...out, flightMs: 0 }), RangeError);
  assert.throws(() => capsuleOutSample(0, { ...out, openDelayMs: 999 }), RangeError);
  assert.throws(() => capsuleOutSample(0, { ...out, openMs: NaN }), RangeError);
  assert.throws(() => capsuleOutSample(0, { ...out, settleLift: -1 }), RangeError);
  assert.throws(() => capsuleReturnSample(0, { closeMs: 0, travelMs: 1, exitProgress: .5 }), RangeError);
  assert.throws(() => capsuleReturnSample(0, { closeMs: 1, travelMs: Infinity, exitProgress: .5 }), RangeError);
  assert.throws(() => capsuleReturnSample(0, { closeMs: 1, travelMs: 1, exitProgress: .5, startProgress: 1.1 }), RangeError);
  assert.throws(() => capsuleReturnSample(0, { closeMs: 1, travelMs: 1, exitProgress: .5, startOpen: NaN }), RangeError);
});

test('sampling leaves parameter objects untouched', () => {
  const outbound = Object.freeze({ ...out });
  const returning = Object.freeze({ closeMs: 220, travelMs: 650, exitProgress: .5, startProgress: .8, startOpen: .8 });
  capsuleOutSample(1100, outbound);
  capsuleReturnSample(440, returning);
  assert.equal(outbound.flightMs, 1000);
  assert.equal(returning.startProgress, .8);
});
