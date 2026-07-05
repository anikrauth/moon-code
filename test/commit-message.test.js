const test = require('node:test');
const assert = require('node:assert');
const { generateCommitMessage } = require('../dist/main/features/git/commitMessage.js');
const { startServer, textChunks, baseUrlOf } = require('./helpers/fake-openai.js');

function settingsFor(server) {
  return { apiKey: 'test-key', model: 'mock', baseUrl: baseUrlOf(server) };
}

test('generates a commit message from a change summary', async (t) => {
  const server = await startServer(() => textChunks('feat: add login form'));
  t.after(() => server.close());
  const res = await generateCommitMessage('Diff of tracked changes:\n+login form', settingsFor(server));
  assert.deepStrictEqual(res, { ok: true, message: 'feat: add login form' });
  const body = server.requests[0];
  const userMsg = body.messages.find((m) => m.role === 'user');
  assert.match(userMsg.content, /login form/);
});

test('strips code fences, quotes, and extra lines from model output', async (t) => {
  const server = await startServer(() =>
    textChunks('```\n"fix: correct expiry check"\n\nThis fixes the token bug.\n```'));
  t.after(() => server.close());
  const res = await generateCommitMessage('diff...', settingsFor(server));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.message, 'fix: correct expiry check');
});

test('empty model output returns an error result', async (t) => {
  const server = await startServer(() => textChunks(''));
  t.after(() => server.close());
  const res = await generateCommitMessage('diff...', settingsFor(server));
  assert.strictEqual(res.ok, false);
  assert.ok(res.error);
});

test('provider error returns ok:false without throwing', async (t) => {
  const server = await startServer(() => ({ status: 500 }));
  t.after(() => server.close());
  const res = await generateCommitMessage('diff...', settingsFor(server));
  assert.strictEqual(res.ok, false);
  assert.ok(res.error && res.error.length > 0);
});
