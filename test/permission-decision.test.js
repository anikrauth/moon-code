// test/permission-decision.test.js
// Feature 15 Task 3 review follow-up: the real cache-bypass + don't-cache-
// the-answer logic in registerAgentIpc.ts had zero direct regression
// coverage (test/plan-mode.test.js's forcePrompt test only drives a fake at
// the toolRouter<->callback seam). isAlreadyAllowed/shouldCacheAllow are the
// pure permission-decision core extracted out of requestPermission's
// closure so they can be imported and tested directly, without any
// ipcMain/renderer plumbing.
const test = require('node:test');
const assert = require('node:assert');
const { isAlreadyAllowed, shouldCacheAllow } = require('../dist/main/app/ipc/registerAgentIpc.js');

test('isAlreadyAllowed: forcePrompt makes an already-always-allowed tool still prompt', () => {
  const sessionAllowedTools = new Set(['run_command']);
  // Without forcePrompt, the cache hit short-circuits (no fresh prompt).
  assert.strictEqual(isAlreadyAllowed('run_command', sessionAllowedTools, false), true);
  // With forcePrompt, the cache must be bypassed even though the tool is
  // in sessionAllowedTools — the caller falls through to a fresh prompt.
  assert.strictEqual(isAlreadyAllowed('run_command', sessionAllowedTools, true), false);
});

test('isAlreadyAllowed: a tool never allowed still requires a fresh prompt regardless of forcePrompt', () => {
  const sessionAllowedTools = new Set();
  assert.strictEqual(isAlreadyAllowed('write_file', sessionAllowedTools, false), false);
  assert.strictEqual(isAlreadyAllowed('write_file', sessionAllowedTools, true), false);
});

test('shouldCacheAllow: an "always allow" answer given under forcePrompt is NOT written to the allow set', () => {
  // allow=true, alwaysAllow=true, forcePrompt=true -> must not cache.
  assert.strictEqual(shouldCacheAllow(true, true, true), false);
});

test('shouldCacheAllow: an "always allow" answer given normally (no forcePrompt) IS cached', () => {
  assert.strictEqual(shouldCacheAllow(true, true, false), true);
});

test('shouldCacheAllow: a plain allow-once (alwaysAllow=false) is never cached', () => {
  assert.strictEqual(shouldCacheAllow(true, false, false), false);
});

test('shouldCacheAllow: a denial is never cached, forcePrompt or not', () => {
  assert.strictEqual(shouldCacheAllow(false, true, false), false);
  assert.strictEqual(shouldCacheAllow(false, true, true), false);
});
