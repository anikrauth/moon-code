#!/usr/bin/env node
// CLI entry for the eval harness.
//
//   node evals/run.js [--tasks all|id1,id2] [--variants baseline] [--repeats 1] [--concurrency 2] [--model <id>]
//
// Reads settings from env: EVAL_API_KEY (required unless EVAL_BASE_URL
// points at a keyless server, in which case a dummy key is used),
// EVAL_BASE_URL (optional), EVAL_MODEL (CLI --model overrides).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runAttempt } = require('./lib/harness');
const { gradeAttempt } = require('./lib/grade');
const { writeReport } = require('./lib/report');

const TASKS_ROOT = path.join(__dirname, 'tasks');
const REPO_ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = { tasks: 'all', variants: ['baseline'], repeats: 1, concurrency: 2, model: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--tasks') args.tasks = next();
    else if (arg === '--variants') args.variants = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--repeats') args.repeats = parseInt(next(), 10);
    else if (arg === '--concurrency') args.concurrency = parseInt(next(), 10);
    else if (arg === '--model') args.model = next();
  }
  return args;
}

function listAllTaskIds() {
  return fs.readdirSync(TASKS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function loadTask(taskId) {
  const taskDir = path.join(TASKS_ROOT, taskId);
  const taskJsonPath = path.join(taskDir, 'task.json');
  const task = JSON.parse(fs.readFileSync(taskJsonPath, 'utf-8'));
  if (task.timeoutMs === undefined) task.timeoutMs = 180000;
  if (task.permissionPolicy === undefined) task.permissionPolicy = 'allow-all';
  return { taskDir, task };
}

// Runs `fn` over `items` with bounded concurrency, preserving item order in
// the returned results array.
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(concurrency, items.length || 1))).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runOneJob({ taskId, taskDir, task, variant, model, run, settingsEnv }) {
  const label = `[${taskId}] variant=${variant} run=${run}`;
  try {
    const attempt = await runAttempt({ taskDir, task, variant, model, settingsEnv });
    if (attempt.timedOut || attempt.crashed) {
      const row = {
        task: taskId, category: task.category, variant, model, run,
        pass: false, notes: attempt.notes || 'attempt failed', metrics: attempt.metrics,
      };
      console.log(`${label} FAIL (${row.notes})`);
      return row;
    }
    const ctx = {
      workspace: attempt.workspace,
      events: attempt.events,
      finalText: attempt.finalText,
      metrics: attempt.metrics,
      permissionLog: attempt.metrics && attempt.metrics.permissionLog,
    };
    const graded = await gradeAttempt(taskDir, ctx);
    const row = {
      task: taskId, category: task.category, variant, model, run,
      pass: graded.pass, notes: graded.notes, metrics: attempt.metrics,
    };
    console.log(`${label} ${graded.pass ? 'PASS' : 'FAIL'} (${graded.notes})`);
    return row;
  } catch (err) {
    const notes = `harness error: ${err && err.message ? err.message : String(err)}`;
    console.log(`${label} FAIL (${notes})`);
    return {
      task: taskId, category: task.category, variant, model, run,
      pass: false, notes, metrics: {},
    };
  }
}

async function main(argv) {
  const args = parseArgs(argv);

  console.log('Building main process bundle (npm run build:main)...');
  execFileSync('npm', ['run', 'build:main'], { cwd: REPO_ROOT, stdio: 'inherit' });

  const taskIds = args.tasks === 'all' ? listAllTaskIds() : args.tasks.split(',').map((s) => s.trim()).filter(Boolean);
  const model = args.model || process.env.EVAL_MODEL;

  const baseUrl = process.env.EVAL_BASE_URL;
  const apiKey = process.env.EVAL_API_KEY || (baseUrl ? 'dummy-key' : undefined);
  if (!apiKey) {
    console.error('EVAL_API_KEY is required unless EVAL_BASE_URL points at a keyless server.');
    process.exit(1);
  }
  const settingsEnv = { apiKey, baseUrl };

  const jobs = [];
  for (const taskId of taskIds) {
    const { taskDir, task } = loadTask(taskId);
    for (const variant of args.variants) {
      for (let run = 1; run <= args.repeats; run++) {
        jobs.push({ taskId, taskDir, task, variant, model, run, settingsEnv });
      }
    }
  }

  const rows = await mapWithConcurrency(jobs, args.concurrency, runOneJob);

  const { dir, resultsPath, leaderboardPath } = writeReport(rows);
  console.log(`\nWrote results: ${resultsPath}`);
  console.log(`Wrote leaderboard: ${leaderboardPath}`);
  console.log(`Report dir: ${dir}`);

  const byTask = new Map();
  for (const row of rows) {
    if (!byTask.has(row.task)) byTask.set(row.task, []);
    byTask.get(row.task).push(row);
  }
  const zeroPassTasks = [...byTask.entries()].filter(([, taskRows]) => !taskRows.some((r) => r.pass)).map(([taskId]) => taskId);
  if (zeroPassTasks.length > 0) {
    console.error(`\nTasks with zero passes: ${zeroPassTasks.join(', ')}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, parseArgs, listAllTaskIds, loadTask, mapWithConcurrency, runOneJob };
