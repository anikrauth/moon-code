// Forked child: runs ONE agent attempt against a task and reports back over
// fork IPC. Never talks to stdout/stdin for control flow (stdio is piped by
// the parent to keep the TTY status line out of eval runs) — all
// communication is via process.send/process.on('message').
//
// Assignment protocol: the parent sends a single IPC message shaped like
// { workspace, prompt, task, settings, usageHint } once the child is ready,
// and the worker replies with exactly one message:
//   { ok: true, events, finalText, metrics }
//   { ok: false, error: <string> }
// (documented here since the brief allows picking either IPC or argv-blob;
// this worker uses IPC so the parent can keep the assignment out of argv
// and ps output).

const { handlePrompt } = require('../../dist/main/features/agent/index.js');

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-rf\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+push\s+--force\b/,
  />\s*\/dev\//,
  /\bmkfs\b/,
  /\bdd\s+if=/,
];

function isDestructiveCommand(command) {
  if (typeof command !== 'string') return false;
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}

// Builds the permission callback per task.json.permissionPolicy. Records
// every request (approved or denied) in order into permissionLog.
function makePermissionFn(policy, permissionLog) {
  return async (name, args, agentId) => {
    const entry = { tool: name, args, agentId };
    if (policy === 'deny-destructive' && name === 'run_command' && isDestructiveCommand(args && args.command)) {
      entry.approved = false;
      permissionLog.push(entry);
      return false;
    }
    entry.approved = true;
    permissionLog.push(entry);
    return true;
  };
}

// Builds the question callback per task.json.questionScript (array of
// answers returned in order). If the agent asks more questions than
// scripted, returns the last scripted answer (or undefined if none) and
// records the overflow.
function makeQuestionFn(questionScript, questionLog) {
  const script = Array.isArray(questionScript) ? questionScript : [];
  let index = 0;
  return async (question, options, agentId) => {
    const overflow = index >= script.length;
    const answer = script.length === 0 ? undefined : script[Math.min(index, script.length - 1)];
    questionLog.push({ question, options, agentId, answer, overflow });
    index += 1;
    return answer;
  };
}

function textOf(event) {
  // Text deltas arrive as cumulative content per streaming.test.js
  // (`onEvent({ type: 'message', ..., content: part.text })` where
  // part.text is the running total) — but to stay robust to either
  // cumulative or incremental delta shapes, finalText is derived as the
  // content of the LAST message event, not a concatenation of all of them.
  return event && event.type === 'message' ? event.content : undefined;
}

async function runOneAttempt(assignment) {
  const { workspace, prompt, task, settings, usageHint } = assignment;
  const events = [];
  const permissionLog = [];
  const questionLog = [];
  let toolCallCount = 0;
  let toolErrorCount = 0;
  let usageTotals = null;
  let lastMessageContent = '';

  const permissionFn = makePermissionFn(task.permissionPolicy, permissionLog);
  const questionFn = makeQuestionFn(task.questionScript, questionLog);

  const start = Date.now();

  const onEvent = (event) => {
    events.push(event);
    if (event.type === 'tool_call') toolCallCount += 1;
    if (event.type === 'tool_result' && typeof event.result === 'string' && event.result.startsWith('Error')) {
      toolErrorCount += 1;
    }
    if (event.type === 'usage' && event.usage) usageTotals = event.usage;
    if (event.type === 'message') {
      const t = textOf(event);
      if (t !== undefined) lastMessageContent = t;
    }
    // Fallback: agentLoop.ts emits a standalone 'usage' event per turn, but
    // also rides the same totals on 'done' as { total, lastStep } — prefer
    // whichever arrives, in case a future change drops the standalone event.
    if (event.type === 'done' && event.usage && event.usage.total) usageTotals = event.usage.total;
  };

  await new Promise((resolve) => {
    handlePrompt(
      prompt,
      workspace,
      settings,
      [],
      (event) => {
        onEvent(event);
        if (event.type === 'done') resolve();
      },
      permissionFn,
      undefined,
      undefined,
      undefined,
      usageHint,
      undefined,
      questionFn,
    );
  });

  const errorEvent = events.find((e) => e.type === 'error');
  const wallTimeMs = Date.now() - start;
  const finalText = lastMessageContent;

  // Surface a truncation note if the agent's own truncation banner made it
  // into the transcript (handlePrompt appends it as a `message` event, not
  // a distinct field on `done` — see the truncatedReason handling in
  // agentLoop.ts).
  const truncatedMessage = events.find((e) => e.type === 'message' && typeof e.content === 'string' && e.content.includes('_[Stopped:'));
  const truncatedReason = truncatedMessage
    ? (truncatedMessage.content.includes('output limit') ? 'output-limit' : 'step-limit')
    : null;

  const metrics = {
    wallTimeMs,
    toolCallCount,
    toolErrorCount,
    usage: usageTotals,
    truncatedReason,
    permissionLog,
    questionLog,
  };
  if (errorEvent) {
    metrics.error = errorEvent.content;
  }

  return { events, finalText, metrics };
}

process.on('message', async (assignment) => {
  try {
    const result = await runOneAttempt(assignment);
    process.send({ ok: true, ...result });
  } catch (err) {
    process.send({ ok: false, error: err && err.stack ? err.stack : String(err) });
  } finally {
    process.exit(0);
  }
});
