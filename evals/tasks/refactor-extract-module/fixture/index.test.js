const test = require('node:test');
const assert = require('node:assert');
const { formatTitle } = require('./index.js');

test('truncates long titles and appends an ellipsis', () => {
  const { display } = formatTitle('a very long title that needs truncating', 10);
  assert.strictEqual(display, 'a very lo…');
});

test('leaves short titles untouched', () => {
  const { display } = formatTitle('short', 10);
  assert.strictEqual(display, 'short');
});

test('produces a URL-safe slug', () => {
  const { slug } = formatTitle('Hello, World! 2024', 100);
  assert.strictEqual(slug, 'hello-world-2024');
});
