const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadWorkspaceState, saveWorkspaceState, buildResumeContext } = require('../dist/main/features/workspace/workspaceState.js');

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moon-state-ws-'));
}

test('save/load round trips through .moon/state.json', () => {
  const ws = setup();
  saveWorkspaceState(ws, { sessionId: 's-abc', goal: 'fix the bug', steps: [{ id: '1', text: 'trace', status: 'active' }] });
  const state = loadWorkspaceState(ws);
  assert.strictEqual(state.sessionId, 's-abc');
  assert.strictEqual(state.goal, 'fix the bug');
  assert.strictEqual(state.steps[0].text, 'trace');
  assert.ok(state.updatedAt && state.progressUpdatedAt);
});

test('merge semantics: lastPrompt-only patch preserves goal and does not bump progressUpdatedAt', () => {
  const ws = setup();
  saveWorkspaceState(ws, { goal: 'refactor auth', steps: [{ id: '1', text: 'a', status: 'done' }] });
  const before = loadWorkspaceState(ws).progressUpdatedAt;
  saveWorkspaceState(ws, { sessionId: 's-2', lastPrompt: 'continue please' });
  const state = loadWorkspaceState(ws);
  assert.strictEqual(state.goal, 'refactor auth');
  assert.strictEqual(state.steps.length, 1);
  assert.strictEqual(state.lastPrompt, 'continue please');
  assert.strictEqual(state.progressUpdatedAt, before);
});

test('gitignore gets .moon/state.json exactly once across saves', () => {
  const ws = setup();
  saveWorkspaceState(ws, { goal: 'g' });
  saveWorkspaceState(ws, { lastPrompt: 'p' });
  const gi = fs.readFileSync(path.join(ws, '.gitignore'), 'utf-8');
  assert.strictEqual(gi.split('\n').filter((l) => l.trim() === '.moon/state.json').length, 1);
});

test('loadWorkspaceState returns null on missing, corrupt, or version-mismatched files', () => {
  const ws = setup();
  assert.strictEqual(loadWorkspaceState(ws), null);
  fs.mkdirSync(path.join(ws, '.moon'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.moon', 'state.json'), 'not json', 'utf-8');
  assert.strictEqual(loadWorkspaceState(ws), null);
  fs.writeFileSync(path.join(ws, '.moon', 'state.json'), JSON.stringify({ version: 99, goal: 'x' }), 'utf-8');
  assert.strictEqual(loadWorkspaceState(ws), null);
});

test('buildResumeContext renders checklist marks and metadata', () => {
  const ws = setup();
  saveWorkspaceState(ws, {
    sessionId: 's-xyz', lastPrompt: 'fix totals row',
    goal: 'fix report totals',
    steps: [
      { id: '1', text: 'trace data flow', status: 'done' },
      { id: '2', text: 'fix row creation', status: 'active' },
      { id: '3', text: 'verify', status: 'pending' },
    ],
  });
  const ctx = buildResumeContext(ws);
  assert.match(ctx, /Last session: s-xyz/);
  assert.match(ctx, /Last user request: "fix totals row"/);
  assert.match(ctx, /Goal: fix report totals/);
  assert.match(ctx, /- \[x\] trace data flow/);
  assert.match(ctx, /- \[>\] fix row creation/);
  assert.match(ctx, /- \[ \] verify/);
});

test('buildResumeContext returns null without a goal or when progress is stale', () => {
  const ws = setup();
  assert.strictEqual(buildResumeContext(ws), null);
  saveWorkspaceState(ws, { lastPrompt: 'hello' }); // no goal
  assert.strictEqual(buildResumeContext(ws), null);
  saveWorkspaceState(ws, { goal: 'old work', steps: [] });
  assert.ok(buildResumeContext(ws));
  assert.strictEqual(buildResumeContext(ws, Date.now() + 8 * DAY), null);
});
