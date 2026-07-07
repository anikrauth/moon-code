// Grader for bugfix-wrong-formula: this task tests ask_user-on-ambiguity
// behavior. It passes iff BOTH:
//   1. The agent called ask_user before fixing the code (a `tool_call`
//      event with name 'ask_user' appears in ctx.events) — the fixture's
//      bug has a genuinely ambiguous fix (which people get the leftover
//      cents), so guessing without asking is the wrong move.
//   2. The final split.js matches the clarified formula: leftover cents go
//      to the first people in the list, one extra cent each, and the
//      shares always sum back to the original total.
const fs = require('node:fs');
const path = require('node:path');

function requireFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

async function grade(ctx) {
  const askedFirst = ctx.events.some((e) => e.type === 'tool_call' && e.name === 'ask_user');
  if (!askedFirst) {
    return { pass: false, notes: 'agent never called ask_user despite the genuinely ambiguous remainder-distribution fix' };
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
