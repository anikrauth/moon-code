// Orchestrates a single agent attempt: sets up a temp workspace from the
// task's fixture (and/or setup.js), forks task-worker.js to run the agent
// against it in isolation, and collects the result. Never throws out of
// runAttempt — failures become a failed-attempt record instead.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');

const WORKER_PATH = path.join(__dirname, 'task-worker.js');

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

// Creates a fresh temp workspace and populates it from the task's
// fixture/ directory and/or setup.js (setup.js is required and invoked
// with the workspace path, letting tasks build things fixture-copy alone
// can't, e.g. git history).
function prepareWorkspace(taskDir) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-eval-ws-'));
  const fixtureDir = path.join(taskDir, 'fixture');
  if (fs.existsSync(fixtureDir)) {
    copyRecursive(fixtureDir, workspace);
  }
  const setupPath = path.join(taskDir, 'setup.js');
  if (fs.existsSync(setupPath)) {
    delete require.cache[require.resolve(setupPath)];
    const setup = require(setupPath);
    if (typeof setup === 'function') {
      setup(workspace);
    } else if (setup && typeof setup.setup === 'function') {
      setup.setup(workspace);
    }
  }
  return workspace;
}

// Forks task-worker.js in an isolated HOME (keeps ~/.moon memory/skills out
// of eval runs — memoryStore resolves ~/.moon via os.homedir()) with piped
// stdio (kills the TTY status line). Enforces task.timeoutMs as a
// wall-clock kill via child.kill().
function runAttempt({ taskDir, task, variant, model, settingsEnv }) {
  return new Promise((resolve) => {
    const workspace = prepareWorkspace(taskDir);
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-eval-home-'));

    const settings = {
      apiKey: (settingsEnv && settingsEnv.apiKey) || 'dummy-key',
      baseUrl: settingsEnv && settingsEnv.baseUrl,
      model,
    };
    const usageHint = { promptVariant: variant };

    const timeoutMs = (task && task.timeoutMs) || 180000;
    let settled = false;
    let child;
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, workspace });
    };

    try {
      child = fork(WORKER_PATH, [], {
        cwd: workspace,
        env: { ...process.env, HOME: fakeHome },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
    } catch (err) {
      finish({
        events: [],
        finalText: '',
        metrics: { wallTimeMs: 0, toolCallCount: 0, toolErrorCount: 0, permissionLog: [], questionLog: [] },
        pass: false,
        notes: `failed to fork worker: ${err && err.message ? err.message : String(err)}`,
        crashed: true,
      });
      return;
    }

    timer = setTimeout(() => {
      if (settled) return;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({
        events: [],
        finalText: '',
        metrics: { wallTimeMs: timeoutMs, toolCallCount: 0, toolErrorCount: 0, permissionLog: [], questionLog: [] },
        pass: false,
        notes: 'timeout',
        timedOut: true,
      });
    }, timeoutMs);

    child.on('message', (msg) => {
      if (settled) return;
      if (msg && msg.ok) {
        finish({ events: msg.events, finalText: msg.finalText, metrics: msg.metrics });
      } else {
        finish({
          events: [],
          finalText: '',
          metrics: { wallTimeMs: 0, toolCallCount: 0, toolErrorCount: 0, permissionLog: [], questionLog: [] },
          pass: false,
          notes: `worker error: ${(msg && msg.error) || 'unknown'}`,
          crashed: true,
        });
      }
    });

    child.on('error', (err) => {
      finish({
        events: [],
        finalText: '',
        metrics: { wallTimeMs: 0, toolCallCount: 0, toolErrorCount: 0, permissionLog: [], questionLog: [] },
        pass: false,
        notes: `worker process error: ${err && err.message ? err.message : String(err)}`,
        crashed: true,
      });
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      finish({
        events: [],
        finalText: '',
        metrics: { wallTimeMs: 0, toolCallCount: 0, toolErrorCount: 0, permissionLog: [], questionLog: [] },
        pass: false,
        notes: `worker exited unexpectedly (code=${code}, signal=${signal})`,
        crashed: true,
      });
    });

    child.send({
      workspace,
      prompt: task.prompt,
      task,
      settings,
      usageHint,
    });
  });
}

module.exports = { runAttempt, prepareWorkspace, copyRecursive };
