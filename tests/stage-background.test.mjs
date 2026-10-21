import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundController, coverTexture } from '../static/v6/stage-background.mjs';

test('portrait and landscape backgrounds cover without stretching or exposed edges', () => {
  for (const [iw, ih, w, h] of [[1600,900,390,844],[600,1200,1920,1080],[1024,768,1366,768]]) {
    const crop = coverTexture(iw,ih,w,h);
    assert.ok(crop.x > 0 && crop.x <= 1 && crop.y > 0 && crop.y <= 1);
    assert.ok(Math.abs(iw*crop.x/(ih*crop.y)-w/h)<1e-10);
    assert.equal(crop.offsetX,(1-crop.x)/2);
    assert.equal(crop.offsetY,(1-crop.y)/2);
  }
});

function harness() {
  const pending = {}, applied = [], disposed = [];
  const controller = createBackgroundController({
    themeTexture: name => name,
    loadTexture: name => new Promise((resolve,reject) => { pending[name] = {resolve,reject}; }),
    apply: texture => applied.push(texture), dispose: texture => disposed.push(texture),
  });
  return {controller,pending,applied,disposed};
}
const tick = () => new Promise(resolve=>setImmediate(resolve));
test('a late uploaded image cannot overwrite a newly selected skin', async () => {
  const h=harness();h.controller.update({backdrop:'old'});
  h.controller.update({theme:'cosmic'});h.pending.old.resolve('old-texture');await tick();
  assert.deepEqual(h.applied,['classic','cosmic']);assert.deepEqual(h.disposed,['old-texture']);
});
test('replacement, failure, and teardown retain the fallback and release custom textures', async () => {
  const h=harness();h.controller.update({backdrop:'first'});h.pending.first.resolve('first-texture');await tick();
  h.controller.update({theme:'cosmic',backdrop:'broken'});h.pending.broken.reject(new Error('decode'));await tick();
  assert.equal(h.applied.at(-1),'cosmic');assert.deepEqual(h.disposed,['first-texture']);
  h.controller.update({backdrop:'pending'});h.controller.dispose();h.pending.pending.resolve('late-texture');await tick();
  assert.deepEqual(h.disposed,['first-texture','late-texture']);
  const count=h.applied.length;h.controller.update({theme:'cosmic'});assert.equal(h.applied.length,count);
});
test('unchanged configuration does not recreate textures or restart an upload', () => {
  const h=harness();h.controller.update({theme:'classic',backdrop:'same'});
  const request=h.pending.same;h.controller.update({theme:'classic',backdrop:'same'});
  assert.equal(h.pending.same,request);assert.deepEqual(h.applied,['classic']);
});
