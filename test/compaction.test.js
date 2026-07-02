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

test('history over MAX_HISTORY is summarized into one message', async () => {
  const server = await startServer((body) =>
    body.tools ? textChunks('answer') : textChunks('THE-SUMMARY'));
  const events = await run(server, longHistory());

  assert.ok(events.some(e => e.type === 'status' && /Compacting/.test(e.content)));
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
  server.close();
});

test('summarize failure falls back to slice, turn still completes', async () => {
  const server = await startServer((body) =>
    body.tools ? textChunks('answer') : { status: 400 });
  const events = await run(server, longHistory());
  const done = events.find(e => e.type === 'done');
  assert.ok(done.history.length > 0);
  assert.strictEqual(events.filter(e => e.type === 'error').length, 0);
  const mainReq = server.requests.find(b => b.tools);
  assert.strictEqual(mainReq.messages.filter(m => m.role !== 'system').length, 21); // sliced 20 + new prompt
  server.close();
});
