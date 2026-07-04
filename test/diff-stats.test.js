const test = require('node:test');
const assert = require('node:assert');
const { computeLineDiff } = require('../dist/main/diffStats.js');

test('identical content yields no change', () => {
  assert.deepStrictEqual(computeLineDiff('a\nb\nc\n', 'a\nb\nc\n'), { adds: 0, dels: 0 });
});

test('new file (null old) counts all lines as adds', () => {
  assert.deepStrictEqual(computeLineDiff(null, 'x\ny\nz\n'), { adds: 3, dels: 0 });
});

test('empty old string counts all new lines as adds', () => {
  assert.deepStrictEqual(computeLineDiff('', 'x\ny\n'), { adds: 2, dels: 0 });
});

test('emptying a file counts all old lines as dels', () => {
  assert.deepStrictEqual(computeLineDiff('a\nb\nc\n', ''), { adds: 0, dels: 3 });
});

test('pure insertion in the middle', () => {
  assert.deepStrictEqual(computeLineDiff('a\nc\n', 'a\nb\nc\n'), { adds: 1, dels: 0 });
});

test('pure deletion', () => {
  assert.deepStrictEqual(computeLineDiff('a\nb\nc\n', 'a\nc\n'), { adds: 0, dels: 1 });
});

test('single-line replacement is one add and one del', () => {
  assert.deepStrictEqual(computeLineDiff('a\nb\nc\n', 'a\nB\nc\n'), { adds: 1, dels: 1 });
});

test('mixed edit matches git-style numstat', () => {
  // git diff --numstat on this pair reports 2 adds, 1 del
  assert.deepStrictEqual(computeLineDiff('a\nb\nc\n', 'a\nB\nc\nd\n'), { adds: 2, dels: 1 });
});

test('trailing newline does not create phantom line', () => {
  assert.deepStrictEqual(computeLineDiff('a\nb', 'a\nb\n'), { adds: 0, dels: 0 });
});

test('over-cap falls back to coarse line delta', () => {
  const big = Array.from({ length: 2100 }, (_, i) => `l${i}`).join('\n');
  const bigger = big + '\n' + Array.from({ length: 50 }, (_, i) => `x${i}`).join('\n');
  const r = computeLineDiff(big, bigger);
  assert.strictEqual(r.adds, 50);
  assert.strictEqual(r.dels, 0);
});
