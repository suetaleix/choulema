import test from 'node:test';
import assert from 'node:assert/strict';
import { effectBudget } from '../static/v6/effect-budget.mjs';

const keys = ['ambient', 'stars', 'burst', 'trail', 'total'];

test('viewport boundary selects small or desktop envelope and invalid widths default safely', () => {
  assert.deepEqual(effectBudget({ width: 599, machine: 'wheel', phase: 'spin' }), {
    ambient: 64, stars: 0, burst: 24, trail: 28, total: 116,
  });
  assert.deepEqual(effectBudget({ width: 600, machine: 'wheel', phase: 'spin' }), {
    ambient: 160, stars: 0, burst: 48, trail: 28, total: 236,
  });
  const desktopDefault = effectBudget({ machine: 'capsule', phase: 'spin' });
  for (const width of [0, -1, NaN, Infinity, -Infinity, '390']) {
    assert.deepEqual(effectBudget({ width, machine: 'capsule', phase: 'spin' }), desktopDefault);
  }
});

test('only cosmic capsule receives star budgets; phase and machine choose the right envelope', () => {
  assert.deepEqual(effectBudget({ width: 800, cosmic: true, machine: 'capsule', phase: 'idle' }), {
    ambient: 100, stars: 220, burst: 80, trail: 0, total: 400,
  });
  assert.deepEqual(effectBudget({ width: 800, cosmic: true, machine: 'capsule', phase: 'reveal' }), {
    ambient: 400, stars: 220, burst: 80, trail: 0, total: 700,
  });
  for (const machine of ['sphere', 'wheel', 'unknown']) {
    const budget = effectBudget({ width: 800, cosmic: true, machine, phase: 'reveal' });
    assert.equal(budget.stars, 0);
    assert.equal(budget.ambient, 160);
    assert.equal(budget.trail, machine === 'wheel' ? 28 : 0);
  }
  assert.equal(effectBudget({ width: 800, machine: 'capsule', phase: 'unrecognized' }).ambient, 32);
});

test('medium and low scale particle allocations down while wheel trail stays fixed', () => {
  assert.deepEqual(effectBudget({ width: 800, quality: 'medium', machine: 'wheel', phase: 'spin' }), {
    ambient: 96, stars: 0, burst: 28, trail: 28, total: 152,
  });
  assert.deepEqual(effectBudget({ width: 800, quality: 'low', cosmic: true, machine: 'capsule', phase: 'spin' }), {
    ambient: 120, stars: 66, burst: 24, trail: 0, total: 210,
  });
  assert.deepEqual(
    effectBudget({ width: 800, quality: 'other', machine: 'capsule', phase: 'spin' }),
    effectBudget({ width: 800, quality: 'high', machine: 'capsule', phase: 'spin' }),
  );
  for (const quality of ['constructor', 'toString', '__proto__']) {
    assert.deepEqual(
      effectBudget({ width: 800, quality, machine: 'capsule', phase: 'spin' }),
      effectBudget({ width: 800, quality: 'high', machine: 'capsule', phase: 'spin' }),
    );
  }
});

test('only strict reduced true disables every budget category', () => {
  assert.deepEqual(effectBudget({ cosmic: true, machine: 'capsule', phase: 'spin', reduced: true }), {
    ambient: 0, stars: 0, burst: 0, trail: 0, total: 0,
  });
  assert.equal(effectBudget({ reduced: 1 }).ambient, effectBudget().ambient);
});

test('width, quality, machine, theme, phase, and reduced matrix stays integral, nonnegative, and within peak caps', () => {
  for (const width of [320, 599, 600, 800, 1920, NaN]) {
    const small = Number.isFinite(width) && width > 0 && width < 600;
    for (const quality of ['high', 'medium', 'low', 'unknown', 'constructor', 'toString', '__proto__']) {
      for (const machine of ['capsule', 'sphere', 'wheel']) {
        for (const cosmic of [false, true]) {
          for (const phase of ['idle', 'spin', 'reveal', 'other']) {
            for (const reduced of [false, true]) {
              const budget = effectBudget({ width, quality, machine, cosmic, phase, reduced });
              for (const key of keys) {
                assert.ok(Number.isInteger(budget[key]), `${key} must be integer`);
                assert.ok(budget[key] >= 0, `${key} must be non-negative`);
              }
              assert.equal(budget.total, budget.ambient + budget.stars + budget.burst + budget.trail);
              if (reduced) assert.deepEqual(budget, { ambient: 0, stars: 0, burst: 0, trail: 0, total: 0 });
              if (quality === 'high' || quality === 'unknown') {
                const cosmicCapsule = cosmic && machine === 'capsule';
                assert.ok(budget.total <= (cosmicCapsule ? (small ? 350 : 700) : (small ? 120 : 240)));
              }
            }
          }
        }
      }
    }
  }
});
