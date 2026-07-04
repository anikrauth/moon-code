// test/mcp-agent.test.js
const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/features/agent/index.js');

test('extraTools: listed, permission-gated, round-trips', { timeout: 15000 }, async (t) => {
  const server = await startServer((body) =>
    body.messages.some((m) => m.role === 'tool')
      ? textChunks('done')
      : [toolCallChunk('mcp__fx__echo', { text: 'hi' }), chunk({}, 'tool_calls')]);
  t.after(() => server.close());
  const extraTools = {
    mcp__fx__echo: {
      description: 'Echo text back',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: async (args) => `echo: ${args.text}`,
    },
  };
  const permCalls = [];
  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', process.cwd(), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); },
      async (name) => { permCalls.push(name); return true; },
      undefined, extraTools);
  });
  const sentTools = server.requests[0].tools.map((x) => x.function.name);
  assert.ok(sentTools.includes('mcp__fx__echo'));
  const sent = server.requests[0].tools.find((x) => x.function.name === 'mcp__fx__echo');
  assert.ok(sent.function.parameters.properties.text);
  assert.deepStrictEqual(permCalls, ['mcp__fx__echo']);
  const result = events.find((e) => e.type === 'tool_result' && e.name === 'mcp__fx__echo');
  assert.strictEqual(result.result, 'echo: hi');
});

test('extraTools execute throw becomes Error string result', { timeout: 15000 }, async (t) => {
  const server = await startServer((body) =>
    body.messages.some((m) => m.role === 'tool')
      ? textChunks('done')
      : [toolCallChunk('mcp__fx__boom', {}), chunk({}, 'tool_calls')]);
  t.after(() => server.close());
  const extraTools = {
    mcp__fx__boom: {
      description: 'Always throws', inputSchema: { type: 'object', properties: {} },
      execute: async () => { throw new Error('server exploded'); },
    },
  };
  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', process.cwd(), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); }, async () => true, undefined, extraTools);
  });
  const result = events.find((e) => e.type === 'tool_result' && e.name === 'mcp__fx__boom');
  assert.strictEqual(result.result, 'Error: server exploded');
  assert.strictEqual(events.filter((e) => e.type === 'error').length, 0);
});
