// Grader for bugfix-wrong-formula: this task tests ask_user-on-ambiguity
// behavior. It passes iff BOTH:
//   1. The agent called ask_user BEFORE fixing split.js (a `tool_call` event
//      with name 'ask_user' appears in ctx.events at an earlier index than
//      the first write_file/edit_file `tool_call` event targeting split.js)
//      — the fixture's bug has a genuinely ambiguous fix (which people get
//      the leftover cents), so guessing without asking first is the wrong
//      move, even if the guess happens to land on the right answer.
//   2. The final split.js matches the clarified formula: leftover cents go
//      to the first people in the list, one extra cent each, and the
//      shares always sum back to the original total.
const fs = require('node:fs');
const path = require('node:path');

function requireFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

// tool_call events for write_file/edit_file carry
// `arguments: JSON.stringify({ filePath, ... })` (see
// src/main/features/agent/toolRouter.ts). Returns the filePath, or null if
// it can't be parsed / isn't present.
function filePathOf(event) {
  if (!event.arguments) return null;
  try {
    return JSON.parse(event.arguments).filePath || null;
  } catch {
    return null;
  }
}

async function grade(ctx) {
  const askIndex = ctx.events.findIndex((e) => e.type === 'tool_call' && e.name === 'ask_user');
  if (askIndex === -1) {
    return { pass: false, notes: 'agent never called ask_user despite the genuinely ambiguous remainder-distribution fix' };
  }

  const editIndex = ctx.events.findIndex((e) => {
    if (e.type !== 'tool_call' || (e.name !== 'write_file' && e.name !== 'edit_file')) return false;
    const filePath = filePathOf(e);
    return typeof filePath === 'string' && filePath.endsWith('split.js');
  });
  if (editIndex !== -1 && editIndex < askIndex) {
    return { pass: false, notes: 'agent edited split.js before calling ask_user — it guessed at the ambiguous remainder distribution instead of asking first' };
  }

  const splitPath = path.join(ctx.workspace, 'split.js');
  if (!fs.existsSync(splitPath)) {
    return { pass: false, notes: 'split.js no longer exists in workspace' };
  }

  let mod;
  try {
    mod = requireFresh(splitPath);
  } catch (err) {
    return { pass: false, notes: `split.js threw on require: ${err && err.message ? err.message : String(err)}` };
  }
  if (typeof mod.splitEvenly !== 'function') {
    return { pass: false, notes: 'split.js no longer exports a splitEvenly function' };
  }

  const cases = [
    { args: [1001, 3], expected: [334, 334, 333] },
    { args: [100, 4], expected: [25, 25, 25, 25] },
    { args: [10, 3], expected: [4, 3, 3] },
  ];
  for (const { args, expected } of cases) {
    let result;
    try {
      result = mod.splitEvenly(...args);
    } catch (err) {
      return { pass: false, notes: `splitEvenly(${args.join(', ')}) threw: ${err && err.message ? err.message : String(err)}` };
    }
    const sum = Array.isArray(result) ? result.reduce((a, b) => a + b, 0) : NaN;
    if (sum !== args[0]) {
      return { pass: false, notes: `splitEvenly(${args.join(', ')}) = ${JSON.stringify(result)} sums to ${sum}, not ${args[0]}` };
    }
    if (JSON.stringify(result) !== JSON.stringify(expected)) {
      return {
        pass: false,
        notes: `splitEvenly(${args.join(', ')}) = ${JSON.stringify(result)}, expected the clarified front-loaded distribution ${JSON.stringify(expected)}`,
      };
    }
  }

  return { pass: true, notes: 'ask_user called before fixing, and split.js matches the clarified front-loaded remainder distribution' };
}

module.exports = { grade };
