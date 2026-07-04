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
  // Bug #12: execute() backfills a stable positional id for any step the
  // model didn't supply one for, so the emitted steps carry ids even though
  // the fixture above (mimicking an older/non-compliant model) doesn't.
  assert.deepStrictEqual(progress[0].steps, steps.map((s, i) => ({ ...s, id: `step-${i}` })));

  // No transcript chips for progress.
  assert.strictEqual(events.filter((e) => e.type === 'tool_call' && e.name === 'set_progress').length, 0);
  assert.strictEqual(events.filter((e) => e.type === 'tool_result' && e.name === 'set_progress').length, 0);
});

test('set_progress preserves a model-supplied stable id', async (t) => {
  const steps = [{ id: 'read-file', text: 'read the file', status: 'active' }];
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
  assert.strictEqual(progress[0].steps[0].id, 'read-file');
});

test('set_progress de-dupes a duplicated id with a positional fallback', async (t) => {
  const steps = [
    { id: 'x', text: 'first', status: 'done' },
    { id: 'x', text: 'second', status: 'active' },
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
  const ids = progress[0].steps.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, 2, 'ids must be unique');
  assert.strictEqual(ids[0], 'x');
  assert.strictEqual(ids[1], 'step-1');
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
