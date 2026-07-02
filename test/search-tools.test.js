const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { globToRegex, globSearch, grepSearch } = require('../dist/main/searchTools.js');

function fixture(t, files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-search-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return ws;
}

test('globToRegex semantics', () => {
  assert.ok(globToRegex('*.ts').test('a.ts'));
  assert.ok(!globToRegex('*.ts').test('src/a.ts'));       // * does not cross /
  assert.ok(globToRegex('src/**/*.ts').test('src/a.ts')); // ** matches zero depth
  assert.ok(globToRegex('src/**/*.ts').test('src/x/y/a.ts'));
  assert.ok(globToRegex('a?.js').test('ab.js'));
  assert.ok(!globToRegex('a?.js').test('a/x.js'));
  assert.ok(!globToRegex('a.ts').test('axts'));            // dot is literal
});

test('globSearch finds nested files newest-first and reports none', (t) => {
  const ws = fixture(t, { 'src/a.ts': '', 'src/deep/b.ts': '', 'c.js': '' });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(ws, 'src/a.ts'), old, old);
  const out = globSearch({ workspace: ws, pattern: 'src/**/*.ts' });
  assert.deepStrictEqual(out.split('\n'), ['src/deep/b.ts', 'src/a.ts']); // newest first
  assert.strictEqual(globSearch({ workspace: ws, pattern: '*.py' }), 'No files match *.py.');
});

test('globSearch caps at 200 with marker', (t) => {
  const files = {};
  for (let i = 0; i < 210; i++) files[`f${String(i).padStart(3, '0')}.txt`] = '';
  const ws = fixture(t, files);
  const out = globSearch({ workspace: ws, pattern: '*.txt' });
  const lines = out.split('\n');
  assert.strictEqual(lines.length, 201);
  assert.match(lines[200], /^\[\.\.\. 10 more matches not shown\]$/);
});

test('grepSearch match format, case handling, filePattern, subdir path', (t) => {
  const ws = fixture(t, {
    'src/app.ts': 'const Foo = 1;\nconst bar = 2;\n',
    'src/lib/util.ts': 'export function foo() {}\n',
    'docs/readme.md': 'foo in docs\n',
  });
  const all = grepSearch({ workspace: ws, pattern: 'foo' });
  assert.ok(all.includes('src/app.ts:1: const Foo = 1;'));       // case-insensitive default
  assert.ok(all.includes('src/lib/util.ts:1: export function foo() {}'));
  assert.ok(all.includes('docs/readme.md:1: foo in docs'));
  const cs = grepSearch({ workspace: ws, pattern: 'foo', caseSensitive: true });
  assert.ok(!cs.includes('src/app.ts:1:'));
  const filtered = grepSearch({ workspace: ws, pattern: 'foo', filePattern: '**/*.ts' });
  assert.ok(!filtered.includes('docs/readme.md'));
  const scoped = grepSearch({ workspace: ws, pattern: 'foo', path: 'docs' });
  assert.strictEqual(scoped, 'docs/readme.md:1: foo in docs');
});

test('grepSearch error strings', (t) => {
  const ws = fixture(t, { 'a.txt': 'x' });
  assert.match(grepSearch({ workspace: ws, pattern: '(' }), /^Error: invalid regex: /);
  assert.strictEqual(grepSearch({ workspace: ws, pattern: 'x', path: '../outside' }), 'Error: path escapes the workspace: ../outside');
  assert.strictEqual(grepSearch({ workspace: ws, pattern: 'zzz-nothing' }), 'No matches found.');
});

test('ignored dirs, symlinks, binary, oversize are skipped', (t) => {
  const ws = fixture(t, {
    'node_modules/pkg/index.js': 'NEEDLE\n',
    '.git/config': 'NEEDLE\n',
    'src/real.js': 'NEEDLE\n',
  });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.js'), 'NEEDLE\n');
  fs.symlinkSync(outside, path.join(ws, 'linked'));
  fs.writeFileSync(path.join(ws, 'blob.bin'), Buffer.concat([Buffer.from('NEEDLE'), Buffer.from([0]), Buffer.from('x')]));
  fs.writeFileSync(path.join(ws, 'huge.txt'), 'NEEDLE\n' + 'x'.repeat(1024 * 1024 + 10));
  const out = grepSearch({ workspace: ws, pattern: 'NEEDLE' });
  assert.strictEqual(out, 'src/real.js:1: NEEDLE');
  const globOut = globSearch({ workspace: ws, pattern: '**/*.js' });
  assert.ok(!globOut.includes('node_modules'));
  assert.ok(!globOut.includes('linked'));
});

test('grepSearch path through a symlinked dir cannot escape the workspace', (t) => {
  const ws = fixture(t, { 'inside.txt': 'clean\n' });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-outside2-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET_TOKEN\n');
  fs.symlinkSync(outside, path.join(ws, 'linked'));
  const out = grepSearch({ workspace: ws, pattern: 'SECRET_TOKEN', path: 'linked' });
  assert.ok(!out.includes('SECRET_TOKEN'), `escaped: ${out}`);
  assert.ok(out === 'Error: path escapes the workspace: linked' || out === 'No matches found.');
});

test('grepSearch trims long lines and caps matches', (t) => {
  const ws = fixture(t, {
    'long.txt': '  ' + 'y'.repeat(500) + 'NEEDLE\n',
    'many.txt': Array.from({ length: 250 }, (_, i) => `NEEDLE ${i}`).join('\n'),
  });
  const out = grepSearch({ workspace: ws, pattern: 'NEEDLE' });
  const longLine = out.split('\n').find((l) => l.startsWith('long.txt'));
  assert.ok(longLine.length <= 'long.txt:1: '.length + 200);
  const matchLines = out.split('\n').filter((l) => /:\d+: /.test(l));
  assert.strictEqual(matchLines.length, 200);
  assert.match(out, /\[\.\.\. additional matches truncated\]$/);
});

const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

async function runTool(t, workspace, call, permCalls) {
  const server = await startServer((body) =>
    body.messages.some((m) => m.role === 'tool')
      ? textChunks('done')
      : [toolCallChunk(call.name, call.args), chunk({}, 'tool_calls')]);
  t.after(() => server.close());
  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', workspace, { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); },
      async (name) => { permCalls.push(name); return true; });
  });
  return events.find((e) => e.type === 'tool_result' && e.name === call.name).result;
}

test('glob_search tool: end-to-end, no permission prompt', async (t) => {
  const ws = fixture(t, { 'src/target.ts': '', 'other.md': '' });
  const permCalls = [];
  const result = await runTool(t, ws, { name: 'glob_search', args: { pattern: '**/*.ts' } }, permCalls);
  assert.strictEqual(result, 'src/target.ts');
  assert.deepStrictEqual(permCalls, []);
});

test('grep_search tool: end-to-end, no permission prompt', async (t) => {
  const ws = fixture(t, { 'src/app.ts': 'const needle = 42;\n' });
  const permCalls = [];
  const result = await runTool(t, ws, { name: 'grep_search', args: { pattern: 'needle' } }, permCalls);
  assert.strictEqual(result, 'src/app.ts:1: const needle = 42;');
  assert.deepStrictEqual(permCalls, []);
});
