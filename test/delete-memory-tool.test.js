const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/features/agent/index.js');
const { memoryStore } = require('../dist/main/features/memory/memoryStore.js');

function setupWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moon-delmem-ws-'));
}

function run(server, ws, requestPermission = async () => true) {
  return new Promise((resolve) => {
    const events = [];
    handlePrompt('go', ws, { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(events); },
      requestPermission);
  });
}

function deleteToolServer(name) {
  return (body) => {
    const hasToolResult = body.messages.some((m) => m.role === 'tool');
    if (!hasToolResult) return [toolCallChunk('delete_memory', { name, scope: 'project' }), chunk({}, 'tool_calls')];
    return textChunks('done');
  };
}

const resultOf = (events) => events.find((e) => e.type === 'tool_result' && e.name === 'delete_memory');

test('delete_memory removes the fact file and index entry via tool call', async (t) => {
  const ws = setupWs();
  memoryStore.writeFact('project', ws, { name: 'doomed-fact', description: 'd', body: 'b' });
  const server = await startServer(deleteToolServer('doomed-fact'));
  t.after(() => server.close());
  const permissions = [];
  const events = await run(server, ws, async (toolName, args) => { permissions.push({ toolName, args }); return true; });
  assert.ok(permissions.some((p) => p.toolName === 'delete_memory'), 'permission requested');
  assert.match(resultOf(events).result, /Deleted memory "doomed-fact" \(project\)/);
  assert.ok(!fs.existsSync(path.join(ws, '.moon', 'memory', 'doomed-fact.md')));
  assert.deepStrictEqual(memoryStore.listFacts('project', ws), []);
});

test('denied permission leaves the fact intact', async (t) => {
  const ws = setupWs();
  memoryStore.writeFact('project', ws, { name: 'survivor', description: 'd', body: 'b' });
  const server = await startServer(deleteToolServer('survivor'));
  t.after(() => server.close());
  const events = await run(server, ws, async (toolName) => toolName !== 'delete_memory');
  assert.match(resultOf(events).result, /denied/i);
  assert.ok(fs.existsSync(path.join(ws, '.moon', 'memory', 'survivor.md')));
});

test('unknown fact name returns a helpful error and the turn completes', async (t) => {
  const ws = setupWs();
  const server = await startServer(deleteToolServer('nonexistent'));
  t.after(() => server.close());
  const events = await run(server, ws);
  assert.match(resultOf(events).result, /no memory fact named "nonexistent"/);
  assert.ok(events.find((e) => e.type === 'done'));
});
