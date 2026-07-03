// test/usage.test.js — real token usage capture, output caps, usage events
const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, textChunksWithUsage, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

function run(server, { settings = {}, history } = {}) {
  return new Promise((resolve) => {
    const events = [];
    handlePrompt('hello', process.cwd(),
      { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock', ...settings }, history,
      (e) => { events.push(e); if (e.type === 'done') resolve(events); },
      async () => true);
  });
}

const USAGE = {
  prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050,
  prompt_tokens_details: { cached_tokens: 200 },
};

test('usage chunk produces a normalized usage event and rides the done event', async (t) => {
  const server = await startServer(() => textChunksWithUsage(USAGE, 'answer'));
  t.after(() => server.close());
  const events = await run(server);

  const usageEvents = events.filter((e) => e.type === 'usage');
  assert.strictEqual(usageEvents.length, 1);
  const u = usageEvents[0];
  assert.strictEqual(u.agent, 'main');
  assert.strictEqual(u.usage.inputTokens, 1000);
  assert.strictEqual(u.usage.outputTokens, 50);
  assert.strictEqual(u.usage.cachedInputTokens, 200);
  assert.strictEqual(u.usage.totalTokens, 1050);
  assert.strictEqual(u.lastStep.inputTokens, 1000);
  // 'mock' resolves to fallback limits
  assert.strictEqual(u.limits.contextWindow, 128000);
  assert.strictEqual(u.limits.maxOutputTokens, 4096);
  assert.ok(Math.abs(u.contextPct - 1050 / 128000) < 1e-9);

  const done = events.find((e) => e.type === 'done');
  assert.strictEqual(done.usage.total.inputTokens, 1000);
  assert.strictEqual(done.usage.lastStep.outputTokens, 50);
});

test('multi-step tool turn: total sums steps, lastStep is the final call only', async (t) => {
  const step1Usage = { prompt_tokens: 400, completion_tokens: 20, total_tokens: 420 };
  const step2Usage = { prompt_tokens: 700, completion_tokens: 30, total_tokens: 730 };
  const server = await startServer((body) =>
    body.messages.some((m) => m.role === 'tool')
      ? textChunksWithUsage(step2Usage, 'done')
      : [toolCallChunk('run_command', { command: 'echo hi' }), chunk({}, 'tool_calls', step1Usage)]);
  t.after(() => server.close());
  const events = await run(server);

  const u = events.find((e) => e.type === 'usage');
  assert.strictEqual(u.usage.inputTokens, 1100); // 400 + 700 across steps
  assert.strictEqual(u.usage.outputTokens, 50);
  assert.strictEqual(u.lastStep.inputTokens, 700); // final call's prompt only
  assert.ok(Math.abs(u.contextPct - 730 / 128000) < 1e-9, 'context %% from last step, not totals');
});

test('maxOutputTokens override reaches the request; fallback applies otherwise', async (t) => {
  const server = await startServer(() => textChunks('hi'));
  t.after(() => server.close());
  await run(server, { settings: { maxOutputTokens: 1234 } });
  await run(server);
  const capOf = (req) => req.max_tokens ?? req.max_completion_tokens;
  assert.strictEqual(capOf(server.requests[0]), 1234);
  assert.strictEqual(capOf(server.requests[1]), 4096); // fallback for 'mock'
});

test('provider omitting usage: no crash, null usage, turn completes', async (t) => {
  const server = await startServer(() => textChunks('answer'));
  t.after(() => server.close());
  const events = await run(server);
  const u = events.find((e) => e.type === 'usage');
  assert.ok(u, 'usage event still emitted');
  assert.strictEqual(u.usage, null);
  assert.strictEqual(u.lastStep, null);
  assert.strictEqual(u.contextPct, null);
  assert.strictEqual(events.filter((e) => e.type === 'error').length, 0);
  assert.ok(events.find((e) => e.type === 'done'));
});

test('real lastInputTokens hint over budget triggers compaction on short history', async (t) => {
  const server = await startServer((body) =>
    body.tools ? textChunks('answer') : textChunks('HINT-SUMMARY'));
  t.after(() => server.close());
  const shortHistory = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` })); // tiny by chars/4
  const events = await new Promise((resolve) => {
    const evts = [];
    handlePrompt('next', process.cwd(),
      { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, shortHistory,
      (e) => { evts.push(e); if (e.type === 'done') resolve(evts); },
      async () => true, undefined, undefined, undefined,
      { lastInputTokens: 120000 }); // over the ~93k derived budget
  });
  const summarizeReq = server.requests.find((b) => !b.tools);
  assert.ok(summarizeReq, 'hint exceeded budget -> summarize call made');
  assert.strictEqual(events.filter((e) => e.type === 'error').length, 0);
});

test('same short history without a hint does not compact', async (t) => {
  const server = await startServer(() => textChunks('answer'));
  t.after(() => server.close());
  const shortHistory = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
  await run(server, { history: shortHistory });
  assert.strictEqual(server.requests.length, 1);
  assert.ok(server.requests[0].tools, 'only the main call, no summarize');
});
