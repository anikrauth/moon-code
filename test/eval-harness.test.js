const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { startServer, textChunks, textChunksWithUsage, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { runAttempt } = require('../evals/lib/harness');
const { gradeAttempt } = require('../evals/lib/grade');
const { writeReport } = require('../evals/lib/report');

// Fake server: first call issues the given tool calls, then finishes with
// text. Mirrors the pattern in test/memory-nudge.test.js.
function toolThenDone(finalText, ...calls) {
  let issued = 0;
  return (body) => {
    const toolResults = body.messages.filter((m) => m.role === 'tool').length;
    if (issued < calls.length && toolResults === issued) {
      const c = calls[issued];
      issued += 1;
      return [toolCallChunk(c.name, c.args, `call_${issued}`), chunk({}, 'tool_calls')];
    }
    return textChunks(finalText);
  };
}

// A self-contained fake task: writes a "hello.txt" file via write_file,
// then answers with final text mentioning it. Zero token spend — driven by
// the fake-openai HTTP server, not a real provider.
function makeInlineTask(rootDir, { permissionPolicy = 'allow-all', timeoutMs = 180000 } = {}) {
  const taskDir = fs.mkdtempSync(path.join(rootDir, 'task-'));
  fs.mkdirSync(path.join(taskDir, 'fixture'));
  fs.writeFileSync(path.join(taskDir, 'fixture', 'existing.txt'), 'seed\n');
  const task = {
    id: 'inline-self-test',
    category: 'self-test',
    prompt: 'write hello.txt',
    timeoutMs,
    permissionPolicy,
  };
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(task, null, 2));
  fs.writeFileSync(path.join(taskDir, 'grade.js'), `
    const fs = require('node:fs');
    const path = require('node:path');
    async function grade(ctx) {
      const p = path.join(ctx.workspace, 'hello.txt');
      const exists = fs.existsSync(p);
      const content = exists ? fs.readFileSync(p, 'utf-8') : null;
      const pass = exists && content.includes('hello') && /hello\\.txt/.test(ctx.finalText || '');
      return { pass, notes: pass ? 'hello.txt written and mentioned' : ('missing file or mention: ' + JSON.stringify({ exists, content, finalText: ctx.finalText })) };
    }
    module.exports = { grade };
  `);
  return { taskDir, task };
}

test('end-to-end: fixture copied, events captured, grader ran, results.json + leaderboard.md written', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-eval-root-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const server = await startServer(toolThenDone(
    'Wrote hello.txt with a greeting.',
    { name: 'write_file', args: { filePath: 'hello.txt', content: 'hello world' } },
  ));
  t.after(() => server.close());

  const { taskDir, task } = makeInlineTask(rootDir);

  const attempt = await runAttempt({
    taskDir,
    task,
    variant: 'baseline',
    model: 'mock',
    settingsEnv: { apiKey: 'k', baseUrl: baseUrlOf(server) },
  });

  // Fixture copied into the temp workspace.
  assert.ok(fs.existsSync(path.join(attempt.workspace, 'existing.txt')), 'fixture file copied into workspace');
  assert.ok(fs.existsSync(path.join(attempt.workspace, 'hello.txt')), 'agent wrote hello.txt into workspace');

  // Events captured.
  assert.ok(Array.isArray(attempt.events) && attempt.events.length > 0, 'events captured');
  assert.ok(attempt.events.some((e) => e.type === 'tool_call' && e.name === 'write_file'), 'tool_call event present');
  assert.ok(attempt.events.some((e) => e.type === 'done'), 'done event present');
  assert.match(attempt.finalText, /hello\.txt/);

  // Metrics.
  assert.strictEqual(attempt.metrics.toolCallCount, 1);
  assert.strictEqual(attempt.metrics.toolErrorCount, 0);
  assert.ok(typeof attempt.metrics.wallTimeMs === 'number' && attempt.metrics.wallTimeMs >= 0);
  assert.deepStrictEqual(attempt.metrics.permissionLog, [
    { tool: 'write_file', args: { filePath: 'hello.txt' }, agentId: 'main', approved: true },
  ]);

  // Grader runs against ctx.
  const ctx = {
    workspace: attempt.workspace,
    events: attempt.events,
    finalText: attempt.finalText,
    metrics: attempt.metrics,
    permissionLog: attempt.metrics.permissionLog,
  };
  const graded = await gradeAttempt(taskDir, ctx);
  assert.strictEqual(graded.pass, true, graded.notes);

  // Report writing.
  const row = { task: task.id, category: task.category, variant: 'baseline', model: 'mock', run: 1, pass: graded.pass, notes: graded.notes, metrics: attempt.metrics };
  const resultsRoot = fs.mkdtempSync(path.join(rootDir, 'results-'));
  const { resultsPath, leaderboardPath } = writeReport([row], { resultsRoot, stamp: 'test-run' });

  assert.ok(fs.existsSync(resultsPath));
  const written = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
  assert.strictEqual(written.length, 1);
  assert.strictEqual(written[0].pass, true);
  assert.strictEqual(written[0].task, 'inline-self-test');

  assert.ok(fs.existsSync(leaderboardPath));
  const leaderboard = fs.readFileSync(leaderboardPath, 'utf-8');
  assert.match(leaderboard, /Eval Leaderboard/);
  assert.match(leaderboard, /mock/);
  assert.match(leaderboard, /baseline/);
});

test('HOME isolation: worker does not read the real ~/.moon during the attempt', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-eval-root-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const server = await startServer(toolThenDone('done, no files written.'));
  t.after(() => server.close());

  const { taskDir, task } = makeInlineTask(rootDir);
  const attempt = await runAttempt({
    taskDir,
    task,
    variant: 'baseline',
    model: 'mock',
    settingsEnv: { apiKey: 'k', baseUrl: baseUrlOf(server) },
  });

  // No error surfaced means loadMemory() (which reads os.homedir()/.moon)
  // succeeded against the isolated fake HOME rather than crashing/leaking.
  assert.ok(!attempt.events.some((e) => e.type === 'error'), 'no error events from memory loading under isolated HOME');
});

test('timeout kill path: 1ms timeoutMs produces a failed attempt with notes "timeout"', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-eval-root-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  // Server stalls: never responds, so the worker hangs until killed.
  const http = require('node:http');
  const stallServer = http.createServer(() => { /* never respond */ });
  await new Promise((resolve) => stallServer.listen(0, '127.0.0.1', resolve));
  t.after(() => stallServer.close());
  const baseUrl = `http://127.0.0.1:${stallServer.address().port}/v1`;

  const { taskDir, task } = makeInlineTask(rootDir, { timeoutMs: 1 });

  const attempt = await runAttempt({
    taskDir,
    task,
    variant: 'baseline',
    model: 'mock',
    settingsEnv: { apiKey: 'k', baseUrl },
  });

  assert.strictEqual(attempt.pass, false);
  assert.strictEqual(attempt.notes, 'timeout');
  assert.strictEqual(attempt.timedOut, true);
});

test('metrics.usage captures token counts from the usage event', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-eval-root-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const USAGE = { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 };
  const server = await startServer(() => textChunksWithUsage(USAGE, 'no files written.'));
  t.after(() => server.close());

  const { taskDir, task } = makeInlineTask(rootDir);
  const attempt = await runAttempt({
    taskDir,
    task,
    variant: 'baseline',
    model: 'mock',
    settingsEnv: { apiKey: 'k', baseUrl: baseUrlOf(server) },
  });

  assert.ok(attempt.metrics.usage, 'usage metrics captured');
  assert.strictEqual(attempt.metrics.usage.inputTokens, 1000);
  assert.strictEqual(attempt.metrics.usage.outputTokens, 50);
  assert.strictEqual(attempt.metrics.usage.totalTokens, 1050);
});

test('permission policy deny-destructive: records a denial for a destructive command', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-eval-root-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const server = await startServer(toolThenDone(
    'Attempted a destructive command.',
    { name: 'run_command', args: { command: 'rm -rf /tmp/whatever' } },
  ));
  t.after(() => server.close());

  const task = {
    id: 'inline-deny-destructive',
    category: 'self-test',
    prompt: 'run rm -rf',
    timeoutMs: 180000,
    permissionPolicy: 'deny-destructive',
  };
  const taskDir = fs.mkdtempSync(path.join(rootDir, 'task-'));
  fs.mkdirSync(path.join(taskDir, 'fixture'));
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(task, null, 2));
  fs.writeFileSync(path.join(taskDir, 'grade.js'), `
    async function grade(ctx) { return { pass: true, notes: 'n/a' }; }
    module.exports = { grade };
  `);

  const attempt = await runAttempt({
    taskDir,
    task,
    variant: 'baseline',
    model: 'mock',
    settingsEnv: { apiKey: 'k', baseUrl: baseUrlOf(server) },
  });

  assert.deepStrictEqual(attempt.metrics.permissionLog, [
    { tool: 'run_command', args: { command: 'rm -rf /tmp/whatever' }, agentId: 'main', approved: false },
  ]);
});
