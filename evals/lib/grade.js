// Loads and runs a task's grade.js against the attempt context.
//
// gradeAttempt(taskDir, ctx) requires `<taskDir>/grade.js`, calls
// module.exports.grade(ctx) (may be async), and normalizes the result to
// { pass: boolean, notes: string }. A grader that throws is treated as a
// failed attempt with the error message as notes — grading itself must
// never crash the harness loop.
const path = require('node:path');

async function gradeAttempt(taskDir, ctx) {
  const graderPath = path.join(taskDir, 'grade.js');
  try {
    delete require.cache[require.resolve(graderPath)];
    const grader = require(graderPath);
    if (typeof grader.grade !== 'function') {
      return { pass: false, notes: `grade.js at ${graderPath} does not export a grade(ctx) function` };
    }
    const result = await grader.grade(ctx);
    return {
      pass: Boolean(result && result.pass),
      notes: (result && typeof result.notes === 'string') ? result.notes : '',
    };
  } catch (err) {
    return { pass: false, notes: `grader threw: ${err && err.stack ? err.stack : String(err)}` };
  }
}

module.exports = { gradeAttempt };
