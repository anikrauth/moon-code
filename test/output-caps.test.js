// test/output-caps.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

function mkWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-caps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Drives one turn: first model step issues `call`, second returns text.
async function runTool(t, workspace, call) {
  const server = await startServer((body) =>
    body.messages.some((m) => m.role === 'tool')
      ? textChunks('done')
      : [toolCallChunk(call.name, call.args), chunk({}, 'tool_calls')]);
  t.after(() => server.close());
  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', workspace, { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); }, async () => true);
  });
  return events.find((e) => e.type === 'tool_result' && e.name === call.name).result;
}

test('read_file caps large files with paging marker', async (t) => {
  const ws = mkWorkspace(t);
  fs.writeFileSync(path.join(ws, 'big.txt'), Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n'));
  const result = await runTool(t, ws, { name: 'read_file', args: { filePath: 'big.txt' } });
  assert.ok(result.includes('line 1\n'));
  assert.ok(!result.includes('line 3000\n'));
  assert.match(result, /\[showing lines 1–2000 of 5000 total — call again with offset\/limit for more\]$/);
});

test('read_file offset/limit returns exact window', async (t) => {
  const ws = mkWorkspace(t);
  fs.writeFileSync(path.join(ws, 'big.txt'), Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n'));
  const result = await runTool(t, ws, { name: 'read_file', args: { filePath: 'big.txt', offset: 4990, limit: 5 } });
  assert.ok(result.startsWith('line 4990'));
  assert.ok(result.includes('line 4994'));
  assert.ok(!result.includes('line 4995'));
  assert.match(result, /\[showing lines 4990–4994 of 5000 total/);
});

test('read_file out-of-range offset returns error string', async (t) => {
  const ws = mkWorkspace(t);
  fs.writeFileSync(path.join(ws, 'small.txt'), 'a\nb\nc');
  const result = await runTool(t, ws, { name: 'read_file', args: { filePath: 'small.txt', offset: 100 } });
  assert.strictEqual(result, 'Error: offset 100 is beyond end of file (3 lines).');
});

test('small read_file passes through unmarked', async (t) => {
  const ws = mkWorkspace(t);
  fs.writeFileSync(path.join(ws, 'small.txt'), 'hello\nworld');
  const result = await runTool(t, ws, { name: 'read_file', args: { filePath: 'small.txt' } });
  assert.strictEqual(result, 'hello\nworld');
});

test('run_command output over 30k chars is middle-truncated', async (t) => {
  const ws = mkWorkspace(t);
  const cmd = `node -e "process.stdout.write('A'.repeat(40000) + 'MIDDLE' + 'B'.repeat(40000))"`;
  const result = await runTool(t, ws, { name: 'run_command', args: { command: cmd } });
  assert.ok(result.length < 31000);
  assert.ok(result.startsWith('AAAA'));
  assert.ok(result.endsWith('BBBB'));
  assert.ok(!result.includes('MIDDLE'));
  assert.match(result, /\[\.\.\. truncated \d+ chars \.\.\.\]/);
});

test('small run_command output passes through byte-identical', async (t) => {
  const ws = mkWorkspace(t);
  const result = await runTool(t, ws, { name: 'run_command', args: { command: 'echo hello' } });
  assert.strictEqual(result, 'hello\n');
});

test('read_file char cap counts only fully shown lines in marker', async (t) => {
  const ws = mkWorkspace(t);
  // 3 lines x 30k chars: default window is all 3 lines (90k chars) -> cut at 50k lands mid line 2
  fs.writeFileSync(path.join(ws, 'wide.txt'), ['L1' + 'a'.repeat(30000), 'L2' + 'b'.repeat(30000), 'L3' + 'c'.repeat(30000)].join('\n'));
  const result = await runTool(t, ws, { name: 'read_file', args: { filePath: 'wide.txt' } });
  assert.match(result, /\[showing lines 1–1 of 3 total/);
  assert.ok(result.length <= 50000 + 100); // capped + marker overhead
});

test('run_command failure output is capped', async (t) => {
  const ws = mkWorkspace(t);
  // Uses console.error + exitCode (not process.exit) so the write flushes fully
  // before the process exits — process.exit() can truncate an in-flight stderr
  // write, which would make this test flaky/false-negative.
  const cmd = `node -e "console.error('E'.repeat(80000)); process.exitCode = 1;"`;
  const result = await runTool(t, ws, { name: 'run_command', args: { command: cmd } });
  assert.ok(result.startsWith('Error:'));
  assert.ok(result.length < 31000);
  assert.match(result, /\[\.\.\. truncated \d+ chars \.\.\.\]/);
});

test('single giant line yields sane paging marker', async (t) => {
  const ws = mkWorkspace(t);
  fs.writeFileSync(path.join(ws, 'minified.js'), 'x'.repeat(120000));
  const result = await runTool(t, ws, { name: 'read_file', args: { filePath: 'minified.js' } });
  assert.match(result, /\[showing lines 1–1 of 1 total/);
});

test('list_dir caps entries at 500', async (t) => {
  const ws = mkWorkspace(t);
  for (let i = 0; i < 510; i++) fs.writeFileSync(path.join(ws, `f${String(i).padStart(3, '0')}.txt`), '');
  const result = await runTool(t, ws, { name: 'list_dir', args: { dirPath: '.' } });
  assert.strictEqual(result.split('\n').length, 501); // 500 entries + marker line
  assert.match(result, /\[\.\.\. 10 more entries not shown\]$/);
});
