const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMemoryStore } = require('../dist/main/features/memory/memoryStore.js');

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-mem-home-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-mem-ws-'));
  return { home, ws, store: createMemoryStore({ homeDir: home }) };
}

test('loadInstructions merges global and project layers', () => {
  const { home, ws, store } = setup();
  fs.mkdirSync(path.join(home, '.moon'), { recursive: true });
  fs.writeFileSync(path.join(home, '.moon', 'MOON.md'), 'global rule one\n');
  fs.writeFileSync(path.join(ws, 'MOON.md'), 'project rule one\n');
  const { global, project } = store.loadInstructions(ws);
  assert.match(global, /global rule one/);
  assert.match(project, /project rule one/);
});

test('resolveImports inlines nested @imports with a cycle guard and depth cap', () => {
  const { ws, store } = setup();
  fs.writeFileSync(path.join(ws, 'MOON.md'), 'top\n@a.md\n');
  fs.writeFileSync(path.join(ws, 'a.md'), 'from-a\n@b.md\n');
  fs.writeFileSync(path.join(ws, 'b.md'), 'from-b\n@a.md\n'); // cycle back to a
  const { project } = store.loadInstructions(ws);
  assert.match(project, /from-a/);
  assert.match(project, /from-b/);
  // The cycle (b -> a) must not re-expand a's already-seen contents infinitely;
  // "from-a" appears once (the second @a.md token is left literal).
  assert.strictEqual((project.match(/from-a/g) || []).length, 1);
});

test('resolveImports leaves a missing @import as a literal token', () => {
  const { ws, store } = setup();
  fs.writeFileSync(path.join(ws, 'MOON.md'), 'keep @does-not-exist.md here\n');
  const { project } = store.loadInstructions(ws);
  assert.match(project, /@does-not-exist\.md/);
});

test('writeFact -> index -> readFact round trips and updates in place', () => {
  const { ws, store } = setup();
  store.writeFact('project', ws, { name: 'api-base', description: 'the API base url', body: 'https://api.example.com' });
  const cat = store.buildMemoryCatalog(ws);
  assert.deepStrictEqual(cat.map((f) => `${f.scope}:${f.name}`), ['project:api-base']);
  assert.match(store.readFact('project', ws, 'api-base'), /https:\/\/api\.example\.com/);
  assert.match(store.readFact(null, ws, 'api-base'), /https:\/\/api\.example\.com/); // scope search
  // Update in place keeps one index entry.
  store.writeFact('project', ws, { name: 'api-base', description: 'updated', body: 'https://api2.example.com' });
  assert.strictEqual(store.listFacts('project', ws).length, 1);
  assert.match(store.readFact('project', ws, 'api-base'), /api2/);
});

test('global facts are found via scopeless readFact and appear in the catalog', () => {
  const { ws, store } = setup();
  store.writeFact('global', ws, { name: 'user-name', description: 'who the user is', body: 'Alex' });
  assert.match(store.readFact(null, ws, 'user-name'), /Alex/);
  assert.ok(store.buildMemoryCatalog(ws).some((f) => f.name === 'user-name' && f.scope === 'global'));
});

test('fact names are validated against path traversal', () => {
  const { ws, store } = setup();
  assert.strictEqual(store.readFact('project', ws, '../evil'), null);
  assert.throws(() => store.writeFact('project', ws, { name: '../evil', description: 'x', body: 'y' }));
  assert.throws(() => store.writeFact('project', ws, { name: 'Bad Name', description: 'x', body: 'y' }));
});

test('appendInstruction creates the file then appends bullet lines', () => {
  const { ws, store } = setup();
  store.appendInstruction('project', ws, 'always use tabs');
  store.appendInstruction('project', ws, 'prefer named exports');
  const content = fs.readFileSync(path.join(ws, 'MOON.md'), 'utf-8');
  assert.match(content, /- always use tabs/);
  assert.match(content, /- prefer named exports/);
});
