// test/session-store.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { setTimeout: delay } = require('node:timers/promises');
const { createSessionStore } = require('../dist/main/sessionStore.js');

const tmpDir = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-sess-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'sessions');
};

const snap = (over = {}) => ({
  title: 'first prompt', workspace: '/tmp/ws',
  messages: [{ id: '1', role: 'user', content: 'first prompt' }],
  history: [{ role: 'user', content: 'first prompt' }],
  ...over,
});

test('save without id creates session, file, and index entry', (t) => {
  const s = createSessionStore({ dir: tmpDir(t) });
  const id = s.saveSession(snap());
  assert.match(id, /^s-/);
  const list = s.listSessions();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, id);
  assert.strictEqual(list[0].title, 'first prompt');
  assert.strictEqual(list[0].workspace, '/tmp/ws');
});

test('update preserves createdAt, bumps updatedAt, re-sorts index', async (t) => {
  const s = createSessionStore({ dir: tmpDir(t) });
  const a = s.saveSession(snap({ title: 'A' }));
  await delay(5);
  const b = s.saveSession(snap({ title: 'B' }));
  const createdA = s.getSession(a).createdAt;
  await delay(5);
  assert.strictEqual(s.saveSession(snap({ id: a, title: 'A2' })), a);
  const after = s.getSession(a);
  assert.strictEqual(after.createdAt, createdA);
  assert.ok(after.updatedAt > createdA);
  const list = s.listSessions();
  assert.deepStrictEqual(list.map((e) => e.id), [a, b]);
  assert.strictEqual(list[0].title, 'A2');
});

test('getSession round-trips messages and history', (t) => {
  const s = createSessionStore({ dir: tmpDir(t) });
  const payload = snap({
    messages: [{ id: '1', role: 'user', content: 'hi' }, { id: '2', role: 'assistant', content: 'yo', toolCalls: [{ name: 'run_command', agent: 'main', arguments: '{"command":"ls"}', result: 'a.txt' }] }],
    history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
  });
  const id = s.saveSession(payload);
  const got = s.getSession(id);
  assert.deepStrictEqual(got.messages, payload.messages);
  assert.deepStrictEqual(got.history, payload.history);
});

test('missing or corrupt session file yields null', (t) => {
  const dir = tmpDir(t);
  const s = createSessionStore({ dir });
  assert.strictEqual(s.getSession('s-nope'), null);
  const id = s.saveSession(snap());
  fs.writeFileSync(path.join(dir, `${id}.json`), '{broken');
  assert.strictEqual(s.getSession(id), null);
});

test('corrupt index yields empty list; next save repairs it', (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), 'not json');
  const s = createSessionStore({ dir });
  assert.deepStrictEqual(s.listSessions(), []);
  const id = s.saveSession(snap());
  assert.strictEqual(s.listSessions()[0].id, id);
});

test('delete removes file and index entry; unknown id is a no-op', (t) => {
  const dir = tmpDir(t);
  const s = createSessionStore({ dir });
  const id = s.saveSession(snap());
  s.deleteSession('s-unknown');
  assert.strictEqual(s.listSessions().length, 1);
  s.deleteSession(id);
  assert.deepStrictEqual(s.listSessions(), []);
  assert.ok(!fs.existsSync(path.join(dir, `${id}.json`)));
});

test('traversal-shaped ids are rejected', (t) => {
  const dir = tmpDir(t);
  const s = createSessionStore({ dir });
  // plant a victim file one level up (sibling of sessions dir, like config.json)
  const victim = path.join(path.dirname(dir), 'config.json');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(victim, '{"secret":true}');
  s.saveSession(snap());
  s.deleteSession('../config');
  assert.ok(fs.existsSync(victim), 'file outside sessions dir untouched');
  assert.strictEqual(s.getSession('../config'), null);
  assert.strictEqual(s.listSessions().length, 1);
});

test('usage snapshot round-trips; absent usage stored as null', (t) => {
  const s = createSessionStore({ dir: tmpDir(t) });
  const usage = {
    context: { lastInputTokens: 1000, lastOutputTokens: 50, contextWindow: 128000, maxOutputTokens: 4096, pct: 0.008, estimated: false },
    session: { inputTokens: 1000, outputTokens: 50, cachedInputTokens: 200, turns: 1 },
  };
  const id = s.saveSession(snap({ usage }));
  assert.deepStrictEqual(s.getSession(id).usage, usage);
  const id2 = s.saveSession(snap());
  assert.strictEqual(s.getSession(id2).usage, null);
});
