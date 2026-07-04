// test/progress-tool.test.js
const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

test('set_progress emits a progress event, no tool_call/tool_result chip', async (t) => {
  const steps = [
    { text: 'read the file', status: 'active' },
    { text: 'apply the fix', status: 'pending' },
  ];
  const server = await startServer((body) => {
    const hasToolMsg = body.messages.some((m) => m.role === 'tool');
    if (!hasToolMsg) return [toolCallChunk('set_progress', { goal: 'Fix the bug', steps }), chunk({}, 'tool_calls')];
    return textChunks('done');
  });
  t.after(() => server.close());

  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', process.cwd(), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); }, async () => true);
  });

  const progress = events.filter((e) => e.type === 'progress');
  assert.strictEqual(progress.length, 1);
  assert.strictEqual(progress[0].goal, 'Fix the bug');
  assert.strictEqual(progress[0].agent, 'main');
  assert.deepStrictEqual(progress[0].steps, steps);

  // No transcript chips for progress.
  assert.strictEqual(events.filter((e) => e.type === 'tool_call' && e.name === 'set_progress').length, 0);
  assert.strictEqual(events.filter((e) => e.type === 'tool_result' && e.name === 'set_progress').length, 0);
});

test('set_progress is not offered to subagents', async (t) => {
  const server = await startServer((body) => {
    const isMain = (body.tools ?? []).some((t) => t.function.name === 'spawn_agent');
    const hasToolMsg = body.messages.some((m) => m.role === 'tool');
    if (isMain && !hasToolMsg) return [toolCallChunk('spawn_agent', { task: 'do it' }), chunk({}, 'tool_calls')];
    if (isMain) return textChunks('combined');
    return textChunks('sub findings');
  });
  t.after(() => server.close());

  await new Promise((resolve) => {
    handlePrompt('go', process.cwd(), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { if (e.type === 'done') resolve(); }, async () => true);
  });

  const mainReqs = server.requests.filter((b) => (b.tools ?? []).some((t) => t.function.name === 'spawn_agent'));
  const subReqs = server.requests.filter((b) => !(b.tools ?? []).some((t) => t.function.name === 'spawn_agent'));
  assert.ok(mainReqs.every((b) => (b.tools ?? []).some((t) => t.function.name === 'set_progress')), 'main gets set_progress');
  assert.ok(subReqs.length >= 1);
  assert.ok(subReqs.every((b) => !(b.tools ?? []).some((t) => t.function.name === 'set_progress')), 'subagents do not');
});
