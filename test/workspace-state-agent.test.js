const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/features/agent/index.js');
const { saveWorkspaceState, loadWorkspaceState } = require('../dist/main/features/workspace/workspaceState.js');

function setupWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moon-state-agent-ws-'));
}

function run(server, ws, { prompt = 'go', history, meta } = {}) {
  return new Promise((resolve) => {
    const events = [];
    handlePrompt(prompt, ws, { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, history,
      (e) => { events.push(e); if (e.type === 'done') resolve(events); },
      async () => true, undefined, undefined, undefined, meta, undefined);
  });
}

const sysOf = (req) => req.messages.find((m) => m.role === 'system').content;

test('seeded state + empty history injects PREVIOUS SESSION STATE; non-empty history does not', async (t) => {
  const ws = setupWs();
  saveWorkspaceState(ws, { sessionId: 's-old', goal: 'finish the parser', steps: [{ id: '1', text: 'tokenize', status: 'active' }] });
  const server = await startServer(() => textChunks('ok'));
  t.after(() => server.close());

  await run(server, ws);
  const sys1 = sysOf(server.requests[0]);
  assert.ok(sys1.includes('PREVIOUS SESSION STATE'));
  assert.ok(sys1.includes('finish the parser'));
  assert.ok(sys1.includes('[>] tokenize'));

  await run(server, ws, { history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'sure' }] });
  const sys2 = sysOf(server.requests[1]);
  assert.ok(!sys2.includes('PREVIOUS SESSION STATE'), 'no injection mid-conversation');
});

test('MEMORY DISCIPLINE block is always present in the system prompt', async (t) => {
  const ws = setupWs();
  const server = await startServer(() => textChunks('ok'));
  t.after(() => server.close());
  await run(server, ws);
  const sys = sysOf(server.requests[0]);
  assert.ok(sys.includes('MEMORY DISCIPLINE'));
  assert.ok(sys.includes('delete_memory'));
});

test('set_progress writes goal/steps into .moon/state.json', async (t) => {
  const ws = setupWs();
  const server = await startServer((body) => {
    const hasTool = body.messages.some((m) => m.role === 'tool');
    if (!hasTool) return [toolCallChunk('set_progress', { goal: 'ship feature', steps: [{ id: '1', text: 'build', status: 'active' }] }), chunk({}, 'tool_calls')];
    return textChunks('done');
  });
  t.after(() => server.close());
  await run(server, ws, { meta: { sessionId: 's-live' } });
  const state = loadWorkspaceState(ws);
  assert.strictEqual(state.goal, 'ship feature');
  assert.strictEqual(state.steps[0].text, 'build');
  assert.strictEqual(state.sessionId, 's-live');
  assert.ok(state.progressUpdatedAt);
});

test('plain text turn records lastPrompt but preserves an existing goal', async (t) => {
  const ws = setupWs();
  saveWorkspaceState(ws, { goal: 'existing goal', steps: [{ id: '1', text: 'a', status: 'pending' }] });
  const server = await startServer(() => textChunks('ok'));
  t.after(() => server.close());
  await run(server, ws, { prompt: 'what does this repo do?' });
  const state = loadWorkspaceState(ws);
  assert.strictEqual(state.lastPrompt, 'what does this repo do?');
  assert.strictEqual(state.goal, 'existing goal');
});
