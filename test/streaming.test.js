const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/features/agent/index.js');

function runTurn(server, { history, permission = async () => true, workspace = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const events = [];
    handlePrompt('hello', workspace,
      { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, history,
      (e) => { events.push(e); if (e.type === 'done') resolve(events); },
      permission);
  });
}
module.exports = { runTurn };

test('streams text deltas as separate message events', async (t) => {
  const server = await startServer(() => textChunks('Hel', 'lo.'));
  t.after(() => server.close());
  const events = await runTurn(server);
  const deltas = events.filter(e => e.type === 'message').map(e => e.content);
  assert.deepStrictEqual(deltas, ['Hel', 'lo.']);
  assert.ok(events.find(e => e.type === 'done').history.length >= 2);
});

test('all events tagged agent main; permission receives agent id', async (t) => {
  const { toolCallChunk, chunk } = require('./helpers/fake-openai');
  const permArgs = [];
  const server = await startServer((body) =>
    body.messages.some(m => m.role === 'tool')
      ? textChunks('done')
      : [toolCallChunk('run_command', { command: 'echo hi' }), chunk({}, 'tool_calls')]);
  t.after(() => server.close());
  const events = await runTurn(server, { permission: async (name, args, agentId) => { permArgs.push([name, agentId]); return true; } });
  for (const e of events.filter(e => e.type !== 'done')) assert.strictEqual(e.agent, 'main');
  assert.deepStrictEqual(permArgs, [['run_command', 'main']]);
});
