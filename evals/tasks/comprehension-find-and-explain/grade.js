// Grader for comprehension-find-and-explain: the agent's final answer text
// must mention the file (util/backoff.js or backoff.js) and the correct
// cap value (2733).
async function grade(ctx) {
  const text = ctx.finalText || '';
  const mentionsFile = /backoff\.js/i.test(text);
  const mentionsValue = /2733/.test(text);
  const pass = mentionsFile && mentionsValue;
  const notes = pass
    ? 'finalText mentions backoff.js and 2733'
    : `missing ${!mentionsFile ? 'file reference' : ''}${!mentionsFile && !mentionsValue ? ' and ' : ''}${!mentionsValue ? 'value 2733' : ''} in finalText: ${text.slice(0, 500)}`;
  return { pass, notes };
}

module.exports = { grade };
