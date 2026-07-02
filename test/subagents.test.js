// test/subagents.test.js
const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

test('parallel subagents: gated, tagged, no recursion, results returned', { timeout: 10000 }, async () => {
  const server = await startServer((body) => {
    const isMain = (body.tools ?? []).some(t => t.function.name === 'spawn_agent');
    const hasToolMsg = body.messages.some(m => m.role === 'tool');
    if (isMain && !hasToolMsg) return [
      toolCallChunk('spawn_agent', { task: 'task A' }, 'call_a', 0),
      toolCallChunk('spawn_agent', { task: 'task B' }, 'call_b', 1),
      chunk({}, 'tool_calls'),
    ];
    if (isMain) return textChunks('combined answer');
    // subagent turns: one gated command, then findings
    if (!hasToolMsg) return [toolCallChunk('run_command', { command: 'true' }), chunk({}, 'tool_calls')];
    return textChunks('sub findings');
  });

  // Permission stub resolves only after BOTH subagents have asked.
  // If spawns ran serially, the second request never arrives -> test times out. This proves parallelism.
  const permAgents = [];
  let release; const bothAsked = new Promise(r => release = r);
  const permission = (name, args, agentId) => {
    permAgents.push(agentId);
    if (permAgents.length === 2) release();
    return bothAsked.then(() => true);
  };

  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', process.cwd(), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); }, permission);
  });

  assert.deepStrictEqual(new Set(permAgents), new Set(['sub-1', 'sub-2']));
  const subToolEvents = events.filter(e => e.type === 'tool_call' && e.name === 'run_command');
  assert.deepStrictEqual(new Set(subToolEvents.map(e => e.agent)), new Set(['sub-1', 'sub-2']));
  const spawnResults = events.filter(e => e.type === 'tool_result' && e.name === 'spawn_agent');
  assert.strictEqual(spawnResults.length, 2);
  for (const r of spawnResults) assert.match(r.result, /sub findings/);
  // no recursion: subagent requests must not offer spawn_agent
  const subReqs = server.requests.filter(b => !(b.tools ?? []).some(t => t.function.name === 'spawn_agent'));
  assert.ok(subReqs.length >= 2);
  assert.deepStrictEqual(events.filter(e => e.type === 'message').map(e => e.agent), Array(events.filter(e => e.type === 'message').length).fill('main'));
  server.close();
});

test('subagent failure is contained as error tool result', async () => {
  const server = await startServer((body) => {
    const isMain = (body.tools ?? []).some(t => t.function.name === 'spawn_agent');
    const hasToolMsg = body.messages.some(m => m.role === 'tool');
    if (isMain && !hasToolMsg) return [toolCallChunk('spawn_agent', { task: 'boom' }), chunk({}, 'tool_calls')];
    if (isMain) return textChunks('recovered');
    return { status: 400 }; // subagent model call fails
  });
  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', process.cwd(), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); }, async () => true);
  });
  const r = events.find(e => e.type === 'tool_result' && e.name === 'spawn_agent');
  assert.match(r.result, /^Error: /);
  assert.strictEqual(events.filter(e => e.type === 'error').length, 0); // parent turn survived
  server.close();
});
