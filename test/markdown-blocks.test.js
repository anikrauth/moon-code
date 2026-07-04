const test = require('node:test');
const assert = require('node:assert');
const { splitMarkdownBlocks, closeDanglingFence } = require('../dist/shared/markdownBlocks.js');

const roundTrip = (md) => assert.strictEqual(splitMarkdownBlocks(md).join(''), md);

test('splitMarkdownBlocks round-trips plain paragraphs', () => {
  roundTrip('para one\n\npara two\n\npara three');
  roundTrip('single line no trailing newline');
  roundTrip('trailing newline\n');
  roundTrip('');
});

test('splitMarkdownBlocks keeps fences with blank lines as one block', () => {
  const md = 'intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\noutro';
  roundTrip(md);
  const blocks = splitMarkdownBlocks(md);
  const fenceBlock = blocks.find(b => b.includes('```ts'));
  assert.ok(fenceBlock.includes('const b = 2;'), 'blank line inside fence did not split the block');
});

test('splitMarkdownBlocks round-trips mixed documents', () => {
  roundTrip('# Title\n\n- a\n- b\n\n```bash\necho hi\n\necho bye\n```\n\n| h |\n|---|\n| c |\n\nend\n');
  roundTrip('~~~\ntilde fence\n\nstill inside\n~~~\n\nafter');
});

test('splitMarkdownBlocks round-trips a trailing partial fence', () => {
  roundTrip('text\n\n```py\npartial = tru');
});

test('splitMarkdownBlocks splits paragraphs into separate blocks', () => {
  const blocks = splitMarkdownBlocks('one\n\ntwo\n\nthree');
  assert.strictEqual(blocks.length, 3);
});

test('closeDanglingFence closes an open fence', () => {
  const out = closeDanglingFence('```ts\nconst x = 1;');
  assert.match(out, /```$/);
  // A closed fence count means react-markdown renders it as a code block.
  assert.strictEqual((out.match(/```/g) || []).length, 2);
});

test('closeDanglingFence no-ops on closed content', () => {
  assert.strictEqual(closeDanglingFence('```ts\ndone\n```'), '```ts\ndone\n```');
  assert.strictEqual(closeDanglingFence('plain paragraph'), 'plain paragraph');
});

test('closeDanglingFence strips a trailing half-open marker', () => {
  assert.strictEqual(closeDanglingFence('this is **bold** and **'), 'this is **bold** and ');
  assert.strictEqual(closeDanglingFence('inline `'), 'inline ');
});
