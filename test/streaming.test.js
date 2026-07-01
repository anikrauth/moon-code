const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

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

test('streams text deltas as separate message events', async () => {
  const server = await startServer(() => textChunks('Hel', 'lo.'));
  const events = await runTurn(server);
  const deltas = events.filter(e => e.type === 'message').map(e => e.content);
  assert.deepStrictEqual(deltas, ['Hel', 'lo.']);
  assert.ok(events.find(e => e.type === 'done').history.length >= 2);
  server.close();
});
