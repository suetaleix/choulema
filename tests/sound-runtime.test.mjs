import test from 'node:test';
import assert from 'node:assert/strict';
import { createSoundRuntime } from '../static/v6/sound-runtime.mjs';

class FakeParam {
  calls = [];
  setValueAtTime(value, time) { this.calls.push(['set', value, time]); }
  linearRampToValueAtTime(value, time) { this.calls.push(['linear', value, time]); }
  exponentialRampToValueAtTime(value, time) { this.calls.push(['exponential', value, time]); }
}

class FakeOscillator {
  type = '';
  frequency = new FakeParam();
  onended = null;
  stopped = false;
  disconnected = false;
  connect(target) { this.target = target; }
  start(time) { this.startedAt = time; }
  stop(time) { this.stopped = true; this.stoppedAt = time; }
  disconnect() { this.disconnected = true; }
  end() { this.onended?.(); }
}

class FakeGain {
  gain = new FakeParam();
  disconnected = false;
  connect(target) { this.target = target; }
  disconnect() { this.disconnected = true; }
}

class FakeContext {
  currentTime = 1;
  state = 'running';
  destination = {};
  oscillators = [];
  gains = [];
  createOscillator() { const node = new FakeOscillator(); this.oscillators.push(node); return node; }
  createGain() { const node = new FakeGain(); this.gains.push(node); return node; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  advance(ms) { this.currentTime += ms / 1000; }
  endAll() { for (const node of [...this.oscillators]) node.end(); }
}

test('does not construct or resume audio until arm, and play never arms itself', () => {
  let created = 0;
  const runtime = createSoundRuntime(() => { created++; return new FakeContext(); });
  runtime.play('capsule', 1);
  assert.equal(created, 0);
  assert.equal(runtime.arm(), true);
  assert.equal(created, 1);
});

test('drops events while asynchronous resume is pending and only plays a fresh event once running', async () => {
  const context = new FakeContext();
  context.state = 'suspended';
  let resolveResume;
  context.resume = () => new Promise(resolve => { resolveResume = resolve; });
  const runtime = createSoundRuntime(() => context);
  runtime.arm();
  runtime.play('wheel', .5);
  assert.equal(context.oscillators.length, 0);
  context.state = 'running';
  resolveResume();
  await Promise.resolve();
  assert.equal(context.oscillators.length, 0);
  runtime.play('wheel', .5);
  assert.equal(context.oscillators.length, 1);
});

test('drops events when resume rejects, then accepts a fresh event after a later successful arm', async () => {
  const context = new FakeContext();
  context.state = 'suspended';
  let rejectResume;
  context.resume = () => new Promise((_, reject) => { rejectResume = reject; });
  const runtime = createSoundRuntime(() => context);
  runtime.arm();
  runtime.play('wheel', .5);
  assert.equal(context.oscillators.length, 0);
  rejectResume(new Error('resume denied'));
  await Promise.resolve();
  assert.equal(context.oscillators.length, 0);
  context.state = 'running';
  runtime.arm();
  runtime.play('wheel', .5);
  assert.equal(context.oscillators.length, 1);
});

test('supports audio contexts that do not expose a state property', () => {
  const context = new FakeContext();
  delete context.state;
  const runtime = createSoundRuntime(() => context);
  runtime.arm();
  runtime.play('wheel', .5);
  assert.equal(context.oscillators.length, 1);
});

test('schedules scored machine events with attack, pitch, decay, and disconnect on end', () => {
  const context = new FakeContext();
  const runtime = createSoundRuntime(() => context);
  runtime.arm();
  runtime.play('capsule', .8, 'cosmic');
  assert.equal(context.oscillators.length, 2);
  assert.equal(context.gains.length, 2);
  assert.equal(context.oscillators[0].type, 'triangle');
  assert.deepEqual(context.oscillators[0].frequency.calls.map(c => c[0]), ['set', 'exponential']);
  assert.deepEqual(context.gains[0].gain.calls.map(c => c[0]), ['set', 'linear', 'exponential']);
  context.endAll();
  runtime.play('wheel', .6);
  runtime.play('sphere', .7);
  runtime.play('sphere-reveal', 1);
  assert.equal(context.oscillators.length, 6);
  assert.equal(context.oscillators[0].disconnected, true);
  assert.equal(context.gains[0].disconnected, true);
});

test('applies per-event minimum intervals and ignores unknown events', () => {
  const context = new FakeContext();
  const runtime = createSoundRuntime(() => context);
  runtime.arm();
  runtime.play('wheel', .5);
  context.advance(50);
  runtime.play('wheel', .5);
  assert.equal(context.oscillators.length, 1);
  context.advance(30);
  runtime.play('wheel', .5);
  assert.equal(context.oscillators.length, 2);
  runtime.play('not-an-event', 1);
  assert.equal(context.oscillators.length, 2);
});

test('caps active voices at six by stopping and disconnecting the oldest first', () => {
  const context = new FakeContext();
  const runtime = createSoundRuntime(() => context);
  runtime.arm();
  runtime.play('capsule', .5);
  context.advance(150);
  runtime.play('capsule', .5);
  context.advance(150);
  runtime.play('capsule', .5);
  context.advance(150);
  runtime.play('capsule', .5);
  assert.equal(context.oscillators.length, 8);
  assert.equal(context.oscillators[0].stopped, true);
  assert.equal(context.oscillators[0].disconnected, true);
});

test('mute, background, and scene stops clear voices and disarm until a fresh gesture', () => {
  const context = new FakeContext();
  const runtime = createSoundRuntime(() => context);
  runtime.arm();
  runtime.play('capsule', 1);
  runtime.setMuted(true);
  assert.ok(context.oscillators.every(node => node.stopped && node.disconnected));
  context.advance(10);
  runtime.setMuted(false);
  runtime.play('capsule', 1);
  assert.equal(context.oscillators.length, 4);
  runtime.setHidden(true);
  assert.ok(context.oscillators.slice(2).every(node => node.stopped && node.disconnected));
  runtime.setHidden(false);
  const before = context.oscillators.length;
  runtime.play('wheel', 1);
  assert.equal(context.oscillators.length, before);
  runtime.arm();
  runtime.play('wheel', 1);
  assert.equal(context.oscillators.length, before + 1);
  runtime.stop();
  const afterStop = context.oscillators.length;
  runtime.play('sphere', 1);
  assert.equal(context.oscillators.length, afterStop);
  runtime.arm();
  runtime.play('sphere', 1);
  assert.equal(context.oscillators.length, afterStop + 2);
});

test('ten finished draw cycles leave no active voices', () => {
  const context = new FakeContext();
  const runtime = createSoundRuntime(() => context);
  runtime.arm();
  for (let round = 0; round < 10; round++) {
    runtime.play('capsule', .5);
    context.endAll();
    context.advance(150);
  }
  assert.ok(context.oscillators.every(node => node.disconnected));
  runtime.stop();
});

test('audio API errors are contained and do not interrupt caller work', () => {
  const runtime = createSoundRuntime(() => ({
    state: 'running', currentTime: 0, destination: {},
    createOscillator() { throw new Error('audio unavailable'); },
    createGain() { throw new Error('audio unavailable'); },
  }));
  runtime.arm();
  let drawContinued = false;
  try { runtime.play('wheel', 1); drawContinued = true; } catch {}
  assert.equal(drawContinued, true);
  const broken = createSoundRuntime(() => { throw new Error('blocked'); });
  assert.equal(broken.arm(), false);
  assert.doesNotThrow(() => broken.play('capsule', 1));
  const orphanContext = new FakeContext();
  orphanContext.createGain = () => { throw new Error('gain unavailable'); };
  const partial = createSoundRuntime(() => orphanContext);
  partial.arm();
  assert.doesNotThrow(() => partial.play('wheel', 1));
  assert.equal(orphanContext.oscillators[0].disconnected, true);
});

test('reports saved mute and failed unlock truthfully, and retries an interrupted context', async () => {
  const context = new FakeContext(), states = [];
  context.state = 'interrupted';
  context.resume = () => Promise.reject(new Error('unavailable'));
  const runtime = createSoundRuntime(() => context, state => states.push(state));
  runtime.setMuted(true);
  assert.equal(states.at(-1), 'muted');
  runtime.setMuted(false);
  runtime.arm();
  assert.equal(runtime.status(), 'pending');
  assert.equal(await runtime.whenReady(), false);
  assert.equal(states.at(-1), 'unavailable');
  context.resume = () => { context.state = 'running'; return Promise.resolve(); };
  runtime.arm();
  assert.equal(await runtime.whenReady(), true);
  assert.equal(states.at(-1), 'ready');
  assert.equal(runtime.play('capsule-start'), true);
});

test('late audio resume failure cannot overwrite a newer gesture or revive a stopped page', async () => {
  const context = new FakeContext(); context.state = 'suspended';
  let rejectOld;
  context.resume = () => new Promise((_, reject) => { rejectOld = reject; });
  const runtime = createSoundRuntime(() => context);
  runtime.arm(); const oldReady = runtime.whenReady();
  runtime.setHidden(true); runtime.setHidden(false);
  context.state = 'running'; runtime.arm();
  rejectOld(new Error('old attempt'));
  assert.equal(await oldReady, false);
  assert.equal(runtime.status(), 'ready');
  runtime.stop();
  assert.equal(runtime.status(), 'idle');
});

test('page cache restoration can clear hidden state but waits for another draw gesture', () => {
  const context = new FakeContext(), runtime = createSoundRuntime(() => context);
  runtime.arm(); runtime.play('sphere-start');
  runtime.setHidden(true); runtime.setHidden(false);
  const count = context.oscillators.length;
  assert.equal(runtime.status(), 'idle');
  runtime.play('sphere-orbit'); assert.equal(context.oscillators.length, count);
  runtime.arm(); assert.equal(runtime.play('sphere-orbit'), true);
});

test('recreates a closed context and uses an audible output gain bounded below clipping', () => {
  const contexts = [new FakeContext(), new FakeContext()]; let created = 0;
  const runtime = createSoundRuntime(() => contexts[created++]);
  runtime.arm(); contexts[0].state = 'closed'; runtime.arm();
  assert.equal(created, 2);
  runtime.play('capsule-start');
  const peak = contexts[1].gains[0].gain.calls.find(call => call[0] === 'linear')[1];
  assert.equal(peak, 0.018 * 3);
  assert.ok(peak * 6 < 1);
});
