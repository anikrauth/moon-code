const test = require('node:test');
const assert = require('node:assert');
const { mergeIntervals } = require('./intervals');

test('merges overlapping intervals given in order', () => {
  assert.deepStrictEqual(mergeIntervals([[1, 3], [2, 6], [8, 10]]), [[1, 6], [8, 10]]);
});

test('merges touching intervals', () => {
  assert.deepStrictEqual(mergeIntervals([[1, 3], [3, 5]]), [[1, 5]]);
});

test('merges intervals given out of order', () => {
  assert.deepStrictEqual(mergeIntervals([[8, 10], [1, 3], [2, 6]]), [[1, 6], [8, 10]]);
});

test('handles a single interval', () => {
  assert.deepStrictEqual(mergeIntervals([[5, 7]]), [[5, 7]]);
});
