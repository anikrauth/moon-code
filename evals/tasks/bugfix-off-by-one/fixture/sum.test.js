const test = require('node:test');
const assert = require('node:assert');
const { sumFirstN } = require('./sum.js');

test('sums the first n elements only', () => {
  assert.strictEqual(sumFirstN([1, 2, 3, 4, 5], 3), 6);
});

test('returns 0 for n = 0', () => {
  assert.strictEqual(sumFirstN([1, 2, 3], 0), 0);
});
