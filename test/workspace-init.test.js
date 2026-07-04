const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initWorkspace } = require('../dist/main/workspaceInit.js');
const { createMemoryStore } = require('../dist/main/memoryStore.js');

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-init-home-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-init-ws-'));
  return { home, ws };
}

test('fresh workspace with no configs gets .moon scaffolding and a bare MOON.md', () => {
  const { ws } = setup();
  const res = initWorkspace(ws);
  assert.strictEqual(res.created, true);
  assert.deepStrictEqual(res.sources, []);
  assert.ok(fs.statSync(path.join(ws, '.moon', 'skills')).isDirectory());
  assert.match(fs.readFileSync(path.join(ws, '.moon', 'memory', 'MEMORY.md'), 'utf-8'), /^# Memory Index/);
  const moonMd = fs.readFileSync(path.join(ws, 'MOON.md'), 'utf-8');
  assert.match(moonMd, /# MOON\.md/);
  assert.doesNotMatch(moonMd, /Imported agent configs/);
});

test('found agent configs become @import lines that memoryStore inlines', () => {
  const { home, ws } = setup();
  fs.writeFileSync(path.join(ws, 'CLAUDE.md'), 'claude-rule-alpha\n');
  fs.writeFileSync(path.join(ws, '.cursorrules'), 'cursor-rule-beta\n');
  fs.mkdirSync(path.join(ws, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.cursor', 'rules', 'style.md'), 'cursor-style-gamma\n');

  const res = initWorkspace(ws);
  assert.strictEqual(res.created, true);
  assert.deepStrictEqual(res.sources, ['CLAUDE.md', '.cursorrules', '.cursor/rules/style.md']);
  const moonMd = fs.readFileSync(path.join(ws, 'MOON.md'), 'utf-8');
  assert.match(moonMd, /@CLAUDE\.md/);
  assert.match(moonMd, /@\.cursorrules/);
  assert.match(moonMd, /@\.cursor\/rules\/style\.md/);

  // End-to-end: the project instruction layer actually inlines the sources.
  const store = createMemoryStore({ homeDir: home });
  const { project } = store.loadInstructions(ws);
  assert.match(project, /claude-rule-alpha/);
  assert.match(project, /cursor-rule-beta/);
  assert.match(project, /cursor-style-gamma/);
});

test('existing .moon folder makes init a no-op', () => {
  const { ws } = setup();
  fs.mkdirSync(path.join(ws, '.moon', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.moon', 'memory', 'MEMORY.md'), '# Memory Index\n\n- **kept**: existing fact\n');
  fs.writeFileSync(path.join(ws, 'CLAUDE.md'), 'should-not-be-imported\n');

  const res = initWorkspace(ws);
  assert.strictEqual(res.created, false);
  assert.deepStrictEqual(res.sources, []);
  // Existing files untouched, MOON.md not created.
  assert.match(fs.readFileSync(path.join(ws, '.moon', 'memory', 'MEMORY.md'), 'utf-8'), /existing fact/);
  assert.strictEqual(fs.existsSync(path.join(ws, 'MOON.md')), false);
});

test('existing MOON.md is left untouched while .moon is still created', () => {
  const { ws } = setup();
  fs.writeFileSync(path.join(ws, 'MOON.md'), 'user-authored instructions\n');
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'agents-rule\n');

  const res = initWorkspace(ws);
  assert.strictEqual(res.created, true);
  assert.deepStrictEqual(res.sources, ['AGENTS.md']);
  assert.strictEqual(fs.readFileSync(path.join(ws, 'MOON.md'), 'utf-8'), 'user-authored instructions\n');
  assert.ok(fs.statSync(path.join(ws, '.moon', 'skills')).isDirectory());
});

test('missing or empty workspace is a safe no-op', () => {
  assert.deepStrictEqual(initWorkspace(''), { created: false, sources: [] });
  assert.deepStrictEqual(initWorkspace(null), { created: false, sources: [] });
});
