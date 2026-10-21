import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../static/v6/studio.js', import.meta.url), 'utf8');
const handlerStart = source.indexOf("for(const [id,key,limit]of [['#logoFile','logo',500000]");
const handlerEnd = source.indexOf("\n$('#classSwitch').onclick", handlerStart);
assert.notEqual(handlerStart, -1, 'brand file handlers exist in studio.js');
assert.notEqual(handlerEnd, -1, 'brand handler extraction has an end boundary');
const uploadVersionDeclaration = source.match(/^const brandUploadVersions=.*;$/m)?.[0];
assert.ok(uploadVersionDeclaration, 'brand upload versions are declared in studio.js');
const actualHandlers = source.slice(handlerStart, handlerEnd);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createHarness() {
  const elements = new Map([
    ['#logoFile', { files: [] }],
    ['#backdropFile', { files: [] }],
    ['#clearBrand', {}],
  ]);
  const readers = [];
  const decodes = [];
  const errors = [];
  const toasts = [];
  const renderCalls = [];
  let config = { logo: '', backdrop: '' };
  let dirty = false;
  const context = {
    $: selector => elements.get(selector),
    config,
    dirty,
    guard: action => {
      try {
        return Promise.resolve(action()).catch(error => { errors.push(error.message); });
      } catch (error) {
        errors.push(error.message);
        return Promise.resolve();
      }
    },
    toast: message => toasts.push(message),
    readers,
    decodedImage: value => {
      const gate = deferred();
      decodes.push({ value, ...gate });
      return gate.promise;
    },
    FileReader: class {
      constructor() { readers.push(this); }
      readAsDataURL(file) {
        this.file = file;
      }
    },
    renderBrand: value => renderCalls.push(value),
  };
  vm.runInNewContext(`${uploadVersionDeclaration}\n${actualHandlers}`, context);

  function start(key, name) {
    const input = elements.get(key === 'logo' ? '#logoFile' : '#backdropFile');
    input.files = [{ name, type: 'image/png', size: 64 }];
    const promise = input.onchange();
    const reader = readers.at(-1);
    assert.ok(reader, `FileReader did not start: ${errors.join('; ')}`);
    return {
      promise,
      read: () => { reader.result = `data:${name}`; reader.onload(); },
    };
  }

  return {
    start,
    readers,
    decodes,
    errors,
    toasts,
    renderCalls,
    clear: () => elements.get('#clearBrand').onclick(),
    get config() { return config; },
    set config(value) { config = value; context.config = value; },
    get dirty() { return context.dirty; },
    set dirty(value) { context.dirty = value; },
  };
}

async function until(predicate) {
  for (let i = 0; i < 20 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(predicate(), 'expected async handler stage was reached');
}

test('a delayed upload cannot write into a newly selected config object', async () => {
  const h = createHarness();
  const upload = h.start('logo', 'old-scene-logo');
  upload.read();
  await until(() => h.decodes.length === 1);
  const nextConfig = { logo: '', backdrop: '' };
  h.config = nextConfig;
  h.decodes[0].resolve();
  await upload.promise;
  assert.deepEqual(h.config, { logo: '', backdrop: '' });
  assert.deepEqual(h.toasts, []);
});

test('the later selection of the same image type wins even if it resolves first', async () => {
  const h = createHarness();
  const first = h.start('logo', 'logo-first');
  first.read();
  await until(() => h.decodes.length === 1);
  const second = h.start('logo', 'logo-second');
  second.read();
  await until(() => h.decodes.length === 2);
  h.decodes[1].resolve();
  await second.promise;
  h.decodes[0].resolve();
  await first.promise;
  assert.equal(h.config.logo, 'data:logo-second');
  assert.equal(h.toasts.length, 1);
});

test('logo and backdrop uploads have independent ordering', async () => {
  const h = createHarness();
  const logo = h.start('logo', 'logo-independent');
  const backdrop = h.start('backdrop', 'backdrop-independent');
  logo.read();
  backdrop.read();
  await until(() => h.decodes.length === 2);
  h.decodes[1].resolve();
  await backdrop.promise;
  h.decodes[0].resolve();
  await logo.promise;
  assert.equal(h.config.logo, 'data:logo-independent');
  assert.equal(h.config.backdrop, 'data:backdrop-independent');
  assert.equal(h.toasts.length, 2);
});

test('clearing invalidates both pending image types', async () => {
  const h = createHarness();
  const logo = h.start('logo', 'logo-before-clear');
  const backdrop = h.start('backdrop', 'backdrop-before-clear');
  logo.read();
  backdrop.read();
  await until(() => h.decodes.length === 2);
  await h.clear();
  h.decodes[0].resolve();
  h.decodes[1].resolve();
  await Promise.all([logo.promise, backdrop.promise]);
  assert.deepEqual(h.config, { logo: '', backdrop: '' });
  assert.equal(h.dirty, true);
  assert.deepEqual(h.toasts, []);
  assert.equal(h.renderCalls.at(-1), h.config);
});

test('a delayed failure from an old config does not report an obsolete error', async () => {
  const h = createHarness();
  const upload = h.start('backdrop', 'old-scene-broken-backdrop');
  upload.read();
  await until(() => h.decodes.length === 1);
  h.config = { logo: '', backdrop: '' };
  h.decodes[0].reject(new Error('图片无法加载，请换一张图片'));
  await upload.promise;
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.config, { logo: '', backdrop: '' });
});
