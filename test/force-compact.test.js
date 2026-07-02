// test/force-compact.test.js
const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, baseUrlOf } = require('./helpers/fake-openai');
const { forceCompact } = require('../dist/main/agent.js');

const smallHistory = (n) => Array.from({ length: n }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));

test('force bypasses the size trigger', async (t) => {
  const server = await startServer((body) => (body.tools ? textChunks('x') : textChunks('FORCED-SUMMARY')));
  t.after(() => server.close());
  const out = await forceCompact(smallHistory(6), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, () => {});
  assert.ok(server.requests.some((b) => !b.tools), 'summarize call fired despite small history');
  assert.match(out[0].content, /^\[Earlier conversation summary\]\nFORCED-SUMMARY/);
  assert.ok(out.length < 6 + 1);
});

test('force with summarize failure falls back without losing history', async (t) => {
  const server = await startServer(() => ({ status: 400 }));
  t.after(() => server.close());
  const out = await forceCompact(smallHistory(6), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, () => {});
  assert.strictEqual(out.length, 6);
});

test('history of 2 or fewer returns unchanged, no request', async (t) => {
  const server = await startServer(() => textChunks('never'));
  t.after(() => server.close());
  const h = smallHistory(2);
  const out = await forceCompact(h, { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, () => {});
  assert.strictEqual(out, h);
  assert.strictEqual(server.requests.length, 0);
});
