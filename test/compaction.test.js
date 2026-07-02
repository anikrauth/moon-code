// test/compaction.test.js
const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

const longHistory = () => Array.from({ length: 25 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));

function run(server, history) {
  return new Promise((resolve) => {
    const events = [];
    handlePrompt('next question', process.cwd(), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' },
      history, (e) => { events.push(e); if (e.type === 'done') resolve(events); }, async () => true);
  });
}

test('history over MAX_HISTORY is summarized into one message', async (t) => {
  const server = await startServer((body) =>
    body.tools ? textChunks('answer') : textChunks('THE-SUMMARY'));
  t.after(() => server.close());
  const events = await run(server, longHistory());

  assert.ok(events.some(e => e.type === 'status' && /Compacting/.test(e.content)));
  const statusEvents = events.filter(e => e.type === 'status');
  assert.strictEqual(statusEvents[statusEvents.length - 1].content, null);
  const summarizeReq = server.requests.find(b => !b.tools);
  assert.ok(summarizeReq, 'summarize call was made');
  const mainReq = server.requests.find(b => b.tools);
  const first = mainReq.messages.filter(m => m.role !== 'system')[0];
  assert.match(first.content, /^\[Earlier conversation summary\]\nTHE-SUMMARY/);
  // summary + last 8 kept + new user prompt
  assert.strictEqual(mainReq.messages.filter(m => m.role !== 'system').length, 10);
  const done = events.find(e => e.type === 'done');
  assert.match(done.history[0].content, /^\[Earlier conversation summary\]/);
  assert.strictEqual(done.history.length, 11); // summary + 8 recent + user + assistant
});

test('summarize failure falls back to slice, turn still completes', async (t) => {
  const server = await startServer((body) =>
    body.tools ? textChunks('answer') : { status: 400 });
  t.after(() => server.close());
  const events = await run(server, longHistory());
  const done = events.find(e => e.type === 'done');
  assert.ok(done.history.length > 0);
  assert.strictEqual(events.filter(e => e.type === 'error').length, 0);
  const statusEvents = events.filter(e => e.type === 'status');
  assert.strictEqual(statusEvents[statusEvents.length - 1].content, null);
  const mainReq = server.requests.find(b => b.tools);
  assert.strictEqual(mainReq.messages.filter(m => m.role !== 'system').length, 21); // sliced 20 + new prompt
});

test('few huge messages trigger token-based compaction', async (t) => {
  const server = await startServer((body) =>
    body.tools ? textChunks('answer') : textChunks('BIG-SUMMARY'));
  t.after(() => server.close());
  const huge = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'x'.repeat(30000) }));
  const events = await run(server, huge);
  const summarizeReq = server.requests.find((b) => !b.tools);
  assert.ok(summarizeReq, 'token budget exceeded -> summarize call made');
  const mainReq = server.requests.find((b) => b.tools);
  const nonSystem = mainReq.messages.filter((m) => m.role !== 'system');
  assert.match(nonSystem[0].content, /^\[Earlier conversation summary\]\nBIG-SUMMARY/);
  assert.strictEqual(events.filter((e) => e.type === 'error').length, 0);
});

test('summarize failure on short huge history falls back without losing conversation', async (t) => {
  const server = await startServer((body) =>
    body.tools ? textChunks('answer') : { status: 400 });
  t.after(() => server.close());
  const huge = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'x'.repeat(30000) }));
  const events = await run(server, huge);
  const done = events.find((e) => e.type === 'done');
  assert.ok(done.history && done.history.length >= 8, 'history preserved via slice fallback');
  assert.strictEqual(events.filter((e) => e.type === 'error').length, 0);
});

test('small short history skips compaction entirely', async (t) => {
  const server = await startServer(() => textChunks('answer'));
  t.after(() => server.close());
  const small = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
  await run(server, small);
  assert.strictEqual(server.requests.length, 1);
  assert.ok(server.requests[0].tools, 'only the main call, no summarize');
});
