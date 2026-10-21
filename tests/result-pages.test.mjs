import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateResults, resultPageSize } from '../static/v6/result-pages.mjs';

test('responsive page size uses the specified width boundary', () => {
  assert.equal(resultPageSize(0), 6);
  assert.equal(resultPageSize(599.99), 6);
  assert.equal(resultPageSize(600), 12);
  assert.equal(resultPageSize(1366), 12);
  for (const width of [-1, NaN, Infinity, -Infinity, '599']) {
    assert.throws(() => resultPageSize(width), RangeError);
  }
});

test('result counts from 1 through 50 paginate without gaps or reordering', () => {
  for (const total of [1, 6, 12, 13, 50]) {
    const source = Array.from({ length: total }, (_, index) => ({ id: index, name: `候选${index}` }));
    const snapshot = source.slice();
    const pages = [];
    for (let page = 0; page < Math.ceil(total / 12); page++) {
      const result = paginateResults(source, page, 12);
      assert.equal(result.page, page);
      assert.equal(result.pageSize, 12);
      assert.equal(result.total, total);
      assert.equal(result.pageCount, Math.ceil(total / 12));
      assert.equal(result.start, page * 12);
      assert.equal(result.end, Math.min((page + 1) * 12, total));
      assert.notEqual(result.items, source, 'a page is a new array');
      pages.push(...result.items);
    }
    assert.deepEqual(pages, source);
    assert.deepEqual(source, snapshot, 'pagination leaves the source array unchanged');
  }
});

test('mobile-sized pages and group pages retain every member and original order', () => {
  const groups = Array.from({ length: 13 }, (_, index) => ({
    number: index + 1,
    members: Array.from({ length: index === 12 ? 9 : 2 }, (_, member) => ({ id: `${index}-${member}` })),
  }));
  const first = paginateResults(groups, 0, resultPageSize(390));
  const last = paginateResults(groups, 99, resultPageSize(390));
  assert.equal(first.items.length, 6);
  assert.equal(first.pageCount, 3);
  assert.equal(last.page, 2);
  assert.equal(last.items.length, 1);
  assert.equal(last.items[0].members.length, 9, 'group members are never sliced by the group paginator');
  assert.deepEqual([...first.items, ...paginateResults(groups, 1, 6).items, ...last.items], groups);
});

test('empty input and invalid page values produce stable metadata', () => {
  assert.deepEqual(paginateResults([]), {
    items: [], page: 0, pageSize: 12, pageCount: 0, total: 0, start: 0, end: 0,
  });
  const source = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(paginateResults(source, -2.8, 2), {
    items: ['a', 'b'], page: 0, pageSize: 2, pageCount: 3, total: 5, start: 0, end: 2,
  });
  assert.deepEqual(paginateResults(source, 1.9, 2), {
    items: ['c', 'd'], page: 1, pageSize: 2, pageCount: 3, total: 5, start: 2, end: 4,
  });
  assert.deepEqual(paginateResults(source, 99, 2).items, ['e']);
  assert.deepEqual(paginateResults(source, NaN, 2).items, ['a', 'b']);
  assert.deepEqual(paginateResults(source, Infinity, 2).items, ['a', 'b']);
});

test('duplicates remain separate and page entries preserve object identity', () => {
  const sameA = { id: 'x', name: '重名' };
  const sameB = { id: 'x', name: '重名' };
  const source = [sameA, sameB, sameA];
  const result = paginateResults(source, 1, 2);
  assert.equal(result.total, 3);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0], sameA);
  assert.deepEqual([...paginateResults(source, 0, 2).items, ...result.items], source);
});

test('invalid collections and page sizes are rejected', () => {
  for (const items of [null, {}, 'abc']) assert.throws(() => paginateResults(items), RangeError);
  for (const pageSize of [0, -1, 1.5, NaN, Infinity, '6']) {
    assert.throws(() => paginateResults([1], 0, pageSize), RangeError);
  }
});
