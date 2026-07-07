// Prompt variant dispatch (Feature 15 Task 2): baseline must stay
// byte-identical to the pre-variant prompt (frozen in test/fixtures/
// baseline-prompt-*.snapshot.txt, generated from the original builder),
// while the v2 variant adds the new behavior sections + env context.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildSystemPrompt, buildSystemPromptBaseline, buildSystemPromptV2 } = require('../dist/main/features/agent/systemPrompt.js');

const FULL_SNAPSHOT = fs.readFileSync(path.join(__dirname, 'fixtures', 'baseline-prompt-full.snapshot.txt'), 'utf8');
const MINIMAL_SNAPSHOT = fs.readFileSync(path.join(__dirname, 'fixtures', 'baseline-prompt-minimal.snapshot.txt'), 'utf8');

// Must stay in sync with the fixed inputs the snapshots were generated from.
function fullOpts(extra = {}) {
  return {
    workspace: '/tmp/fixed-workspace',
    scratchDir: '/tmp/fixed-workspace/.moon/scratch',
    plansDir: '/tmp/fixed-workspace/.moon/plans',
    globalMemory: 'Always use TypeScript strict mode.',
    projectMemory: 'Run tests with npm test.',
    memoryCatalog: [
      { name: 'api-base-url', description: 'The staging API base URL', scope: 'project' },
      { name: 'editor-pref', description: 'User prefers 4-space indent', scope: 'global' },
    ],
    skillsText: 'AVAILABLE SKILLS:\n- structured-investigation: bug-fix methodology',
    usageHint: { skillContent: 'Follow the release checklist exactly.' },
    previousState: 'Goal: ship feature X\n- [done] step 1\n- [active] step 2',
    ...extra,
  };
}

function minimalOpts(extra = {}) {
  return {
    workspace: '/tmp/fixed-workspace',
    scratchDir: '/tmp/fixed-workspace/.moon/scratch',
    plansDir: '/tmp/fixed-workspace/.moon/plans',
    globalMemory: '',
    projectMemory: '',
    memoryCatalog: [],
    skillsText: '',
    usageHint: undefined,
    previousState: null,
    ...extra,
  };
}

const ENV_BLOCK = 'ENVIRONMENT:\n- Workspace: /tmp/fixed-workspace\n- Platform: testos 0.0.0\n- Date: 2026-01-01\n- Model: mock-model';
const V2_MARKERS = ['COMMUNICATION:', 'VERIFICATION:', 'AUTONOMY:', 'CODE STYLE:', 'SAFETY:'];

test('baseline output is byte-identical to the frozen snapshot (full + minimal opts)', () => {
  assert.strictEqual(buildSystemPrompt(fullOpts()), FULL_SNAPSHOT);
  assert.strictEqual(buildSystemPrompt(minimalOpts()), MINIMAL_SNAPSHOT);
});

test('explicit "baseline" variant matches the snapshot and ignores envContext', () => {
  const opts = fullOpts({
    usageHint: { skillContent: 'Follow the release checklist exactly.', promptVariant: 'baseline' },
    envContext: ENV_BLOCK,
  });
  assert.strictEqual(buildSystemPrompt(opts), FULL_SNAPSHOT);
  assert.ok(!buildSystemPrompt(opts).includes('ENVIRONMENT:'));
});

test('baseline keeps legacy sentinels and has none of the v2 section markers', () => {
  const out = buildSystemPrompt(fullOpts());
  assert.ok(out.includes('You are Moon Code, an advanced coding agentic IDE for Mac.'));
  assert.ok(out.includes('MEMORY DISCIPLINE: proactively maintain memory with write_memory'));
  assert.ok(out.includes('For any task that takes more than one step, call set_progress'));
  assert.ok(out.includes('Format answers in GitHub-flavored Markdown'));
  for (const marker of V2_MARKERS) {
    assert.ok(!out.includes(`\n${marker}`) && !out.startsWith(marker), `baseline must not contain section "${marker}"`);
  }
});

test('v2 contains all five new section markers', () => {
  const out = buildSystemPrompt(fullOpts({ usageHint: { promptVariant: 'v2' } }));
  for (const marker of V2_MARKERS) {
    assert.ok(out.includes(`\n${marker}`), `v2 must contain section "${marker}"`);
  }
  // Spot-check verbatim wording from the brief.
  assert.ok(out.includes('Lead your final message with the outcome'));
  assert.ok(out.includes('Never state that something works, passes, or is fixed unless you ran the relevant command this turn'));
  assert.ok(out.includes('Never end your turn on a promise of work'));
  assert.ok(out.includes('never write comments that narrate the change you just made'));
  assert.ok(out.includes('Never combine a destructive command with unrelated commands in one shell invocation.'));
});

test('v2 preserves all dynamic blocks (memory, catalog, previous state, skills, bug-fix trigger, active skill)', () => {
  const out = buildSystemPrompt(fullOpts({
    usageHint: { skillContent: 'Follow the release checklist exactly.', promptVariant: 'v2' },
  }));
  assert.ok(out.includes('USER INSTRUCTIONS (global, from ~/.moon/MOON.md'));
  assert.ok(out.includes('Always use TypeScript strict mode.'));
  assert.ok(out.includes('PROJECT INSTRUCTIONS (from MOON.md in the workspace root'));
  assert.ok(out.includes('Run tests with npm test.'));
  assert.ok(out.includes('MEMORY (facts you saved earlier'));
  assert.ok(out.includes('- api-base-url [project] — The staging API base URL'));
  assert.ok(out.includes('MEMORY DISCIPLINE: proactively maintain memory with write_memory'));
  assert.ok(out.includes('PREVIOUS SESSION STATE'));
  assert.ok(out.includes('- [active] step 2'));
  assert.ok(out.includes('AVAILABLE SKILLS:\n- structured-investigation: bug-fix methodology'));
  assert.ok(out.includes('BUG-FIX TRIGGER'));
  assert.ok(out.includes('ACTIVE SKILL — the user explicitly invoked a skill'));
  assert.ok(out.includes('Follow the release checklist exactly.'));
  assert.ok(out.includes('For any task that takes more than one step, call set_progress'));
  assert.ok(out.includes('Format answers in GitHub-flavored Markdown'));
  assert.ok(out.includes('render_ui'));
});

test('v2 renders the envContext block; new sections sit before the memory blocks', () => {
  const out = buildSystemPrompt(fullOpts({
    usageHint: { promptVariant: 'v2' },
    envContext: ENV_BLOCK,
  }));
  assert.ok(out.includes(ENV_BLOCK));
  assert.ok(out.indexOf('COMMUNICATION:') < out.indexOf('USER INSTRUCTIONS'), 'sections precede memory blocks');
  assert.ok(out.indexOf('You are Moon Code') < out.indexOf('COMMUNICATION:'), 'identity paragraph comes first');
});

test('v2 omits the env block cleanly when envContext is empty', () => {
  const out = buildSystemPrompt(fullOpts({ usageHint: { promptVariant: 'v2' }, envContext: '' }));
  assert.ok(!out.includes('ENVIRONMENT:'));
});

test('end-to-end: promptVariant "v2" via handlePrompt reaches the model with sections + env block', async (t) => {
  const os = require('os');
  const { execFileSync } = require('child_process');
  const { startServer, textChunks, baseUrlOf } = require('./helpers/fake-openai');
  const { handlePrompt } = require('../dist/main/features/agent/index.js');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-variant-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: ws });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: ws });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: ws });
  fs.writeFileSync(path.join(ws, 'a.txt'), 'x\n');
  execFileSync('git', ['add', '-A'], { cwd: ws });
  execFileSync('git', ['commit', '-q', '-m', 'seed commit'], { cwd: ws });
  const server = await startServer(() => textChunks('ok'));
  t.after(() => server.close());
  const run = (usageHint) => new Promise((resolve) => {
    handlePrompt('go', ws, { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { if (e.type === 'done') resolve(); }, async () => true,
      undefined, undefined, undefined, usageHint);
  });
  await run({ promptVariant: 'v2' });
  const sysV2 = server.requests[0].messages.find((m) => m.role === 'system').content;
  for (const marker of V2_MARKERS) assert.ok(sysV2.includes(`\n${marker}`), `live v2 prompt has "${marker}"`);
  // This repo is a git workspace, so the best-effort env block should carry
  // the ENVIRONMENT header, the model, and git lines.
  assert.ok(sysV2.includes('ENVIRONMENT:'));
  assert.ok(sysV2.includes('- Model: mock'));
  assert.ok(sysV2.includes('- Git branch: '));
  assert.ok(sysV2.includes('seed commit'));
  await run(undefined);
  const sysBase = server.requests[1].messages.find((m) => m.role === 'system').content;
  assert.ok(!sysBase.includes('ENVIRONMENT:'), 'baseline never renders env context');
  assert.ok(!sysBase.includes('\nVERIFICATION:'), 'baseline has no v2 sections');
});

test('dispatch: unset -> baseline, "baseline" -> baseline, "v2" -> v2', () => {
  const base = minimalOpts();
  assert.strictEqual(buildSystemPrompt(base), buildSystemPromptBaseline(base));
  const explicitBase = minimalOpts({ usageHint: { promptVariant: 'baseline' } });
  assert.strictEqual(buildSystemPrompt(explicitBase), buildSystemPromptBaseline(explicitBase));
  const v2 = minimalOpts({ usageHint: { promptVariant: 'v2' }, envContext: ENV_BLOCK });
  assert.strictEqual(buildSystemPrompt(v2), buildSystemPromptV2(v2));
  assert.notStrictEqual(buildSystemPrompt(v2), buildSystemPromptBaseline(v2));
});
