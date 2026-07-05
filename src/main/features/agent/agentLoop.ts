// @ts-nocheck
import { streamText, stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

// In a real app, this should be set securely via UI or local config file.
// For now, we assume process.env.OPENAI_API_KEY is set or passed in.
import * as dotenv from 'dotenv';
dotenv.config();

import { resolveLimits } from '../../../shared/lib/modelLimits';
import { StatusLine } from '../status/statusLine';
import { estimateTokens, compactHistory } from './historyCompaction';
import { loadMemory, buildSystemPrompt } from './systemPrompt';
// Circular with toolRouter.ts: see the note in toolRouter.ts's import of
// runAgentLoop from this file — both sides only reference the other inside
// callbacks invoked after module load, so this resolves fine at runtime.
import { makeTools } from './toolRouter';
import { ensureScratchDir } from '../workspace/scratchDir';
import { ensurePlansDir } from '../workspace/plansDir';
import { saveWorkspaceState, buildResumeContext } from '../workspace/workspaceState';

const MAX_STEPS = 50;

// End-of-turn memory nudge (F4): when a turn changed files but saved nothing to
// memory, ride a user-role <system-reminder> into the next turn's history —
// system-role messages are stripped from history (see runAgentLoop), and the
// renderer round-trips history verbatim, so this is the only durable channel
// to the model's next turn. Consumed nudges are filtered out of the next
// newHistory so they never accumulate.
const MEMORY_NUDGE_MARK = 'Automatic end-of-turn memory check';
const MEMORY_NUDGE = `<system-reminder>${MEMORY_NUDGE_MARK}: you changed files or made decisions last turn without saving anything to memory. If a durable user preference, correction (with the why), or project decision surfaced, persist it now with write_memory — reuse an existing fact's name to update it. If nothing durable surfaced, do not call write_memory and do not mention this reminder.</system-reminder>`;
const isMemoryNudge = (m) => m?.role === 'user' && typeof m?.content === 'string' && m.content.includes(MEMORY_NUDGE_MARK);

// ai@7 usage numbers are all optional and provider-dependent; normalize in one
// place. Returns null when the provider reported nothing usable so callers can
// fall back to estimates instead of trusting zeros.
function normalizeUsage(u) {
    if (!u) return null;
    if (u.inputTokens == null && u.outputTokens == null && u.totalTokens == null) return null;
    const inputTokens = u.inputTokens ?? 0;
    const outputTokens = u.outputTokens ?? 0;
    return {
        inputTokens,
        outputTokens,
        cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
        totalTokens: u.totalTokens ?? (inputTokens + outputTokens),
    };
}

export async function runAgentLoop({ prompt, workspace, settings, history, onEvent, requestPermission, agentId, tools, systemPrompt, emitText, abortSignal, limits, statusLine }: any) {
    const customOpenAI = createOpenAI({
        apiKey: settings.apiKey,
        baseURL: settings.baseUrl || undefined,
    });
    limits = limits ?? resolveLimits(settings?.model, settings);
    const userMsg = { role: 'user', content: prompt };
    // System content belongs in the `system` option, never in `messages` — the
    // provider rejects system-role turns here. Strip any that slipped into
    // history (e.g. from older builds) so a stale message can't break a send.
    const priorMessages = (history ?? []).filter((m: any) => m?.role !== 'system');
    const result = streamText({
        model: customOpenAI.chat(settings.model || 'gpt-4o'),
        system: systemPrompt,
        messages: [...priorMessages, userMsg],
        tools,
        abortSignal,
        maxOutputTokens: limits.maxOutputTokens,
        stopWhen: stepCountIs(MAX_STEPS),
    });

    // Context fullness comes from the LAST step's usage (the prompt size of the
    // final model call); 'finish' totalUsage sums input tokens across all
    // tool-loop steps and only makes sense for session accounting.
    let lastStepUsage = null;
    let turnUsage = null;
    let stepCount = 0;
    let lastFinishReason = null;
    for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
            if (statusLine && part.textDelta) statusLine.addTokens(estimateTokens(part.textDelta));
            if (emitText) onEvent({ type: 'message', agent: agentId, content: part.text });
        } else if (part.type === 'finish-step') {
            lastStepUsage = part.usage;
            lastFinishReason = part.finishReason;
            stepCount += 1;
        } else if (part.type === 'finish') {
            turnUsage = part.totalUsage;
        } else if (part.type === 'error') {
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
    }

    const usage = { total: normalizeUsage(turnUsage), lastStep: normalizeUsage(lastStepUsage) };
    const contextPct = usage.lastStep && limits.contextWindow > 0
        ? Math.min(1, (usage.lastStep.inputTokens + usage.lastStep.outputTokens) / limits.contextWindow)
        : null;
    onEvent({
        type: 'usage', agent: agentId,
        usage: usage.total, lastStep: usage.lastStep,
        limits: { contextWindow: limits.contextWindow, maxOutputTokens: limits.maxOutputTokens },
        contextPct,
    });

    // Bug #11: `stopWhen: stepCountIs(MAX_STEPS)` and `maxOutputTokens` both
    // let the stream finish normally (no 'error' part) when a turn is cut off
    // mid-task — the loop just ends and `done` fires with no indication why,
    // which from the user's side looks like the agent silently gave up.
    // Surface the two truncation cases we can detect here: the last step's
    // finishReason was 'length' (output cap hit), or the loop used every
    // available step while the model still wanted to keep calling tools
    // (finishReason 'tool-calls' at stepCount === MAX_STEPS means stopWhen cut
    // it off, not the model choosing to stop).
    let truncatedReason = null;
    if (lastFinishReason === 'length') truncatedReason = 'output-limit';
    else if (stepCount >= MAX_STEPS && lastFinishReason !== 'stop') truncatedReason = 'step-limit';

    return { text: await result.text, responseMessages: await result.responseMessages, usage, truncatedReason };
}

export async function handlePrompt(
    prompt: string,
    workspace: string,
    settings: any,
    history: any[] | undefined,
    onEvent: (event: any) => void,
    requestPermission: (name: string, args: any, agentId: string) => Promise<boolean>,
    abortSignal?: AbortSignal,
    extraTools?: any,
    skillsText?: string,
    usageHint?: { lastInputTokens?: number; skillContent?: string },
    skillsCatalog?: { id: string; description: string; content: string }[],
    requestQuestion?: (question: string, options: { label: string; description?: string }[], agentId: string) => Promise<string>,
) {
    try {
        const limits = resolveLimits(settings?.model, settings);
        // Capture freshness from the RAW history — compactHistory reassigns it.
        const freshSession = !history || history.length === 0;
        history = await compactHistory(history, settings, onEvent, abortSignal, false, limits, usageHint?.lastInputTokens);

        const { global: globalMemory, project: projectMemory, catalog: memoryCatalog } = loadMemory(workspace);
        const scratchDir = ensureScratchDir(workspace);
        const plansDir = ensurePlansDir(workspace);

        // Workspace state (.moon/state.json) must never fail a turn.
        let previousState = null;
        if (freshSession) {
            try { previousState = buildResumeContext(workspace); } catch { /* best-effort */ }
        }

        const systemPrompt = buildSystemPrompt({ workspace, scratchDir, plansDir, globalMemory, projectMemory, memoryCatalog, skillsText, usageHint, previousState });

        // Single wrap point for main-agent + subagent events: tracks whether
        // this turn edited files / saved memory (end-of-turn nudge), and
        // mirrors the main agent's set_progress into .moon/state.json.
        const sessionId = usageHint?.sessionId ?? null;
        let sawEdit = false;
        let sawMemoryWrite = false;
        const wrappedOnEvent = (e) => {
            if (e?.type === 'tool_call') {
                if (e.name === 'write_file' || e.name === 'edit_file') sawEdit = true;
                if (e.name === 'write_memory') sawMemoryWrite = true;
            }
            if (e?.type === 'progress' && (e.agent ?? 'main') === 'main') {
                try { saveWorkspaceState(workspace, { sessionId, goal: e.goal, steps: e.steps }); } catch { /* never break the turn */ }
            }
            onEvent(e);
        };

        const tools = makeTools({
            workspace, onEvent: wrappedOnEvent, requestPermission, requestQuestion, agentId: 'main',
            includeSpawn: true, settings,
            spawnState: { counter: 0, projectMemory, globalMemory, memoryCatalog, skillsText: skillsText ?? '', skillsCatalog: skillsCatalog ?? [] },
            abortSignal, extraTools, limits, skillsCatalog: skillsCatalog ?? [],
        });

        let statusLine: any = null;
        try {
            // Construct + start inside the try so that if either throws (or
            // anything below throws before completion), the catch/stop logic
            // is guaranteed to run against a statusLine that was actually
            // started — previously this happened before the try, so a throw
            // during construction/start would leave a running status line
            // that never got stopped.
            statusLine = process.stdout.isTTY ? new StatusLine({ onInterrupt: () => abortSignal?.abort?.() }) : null;
            statusLine?.start();

            const { responseMessages, usage, truncatedReason } = await runAgentLoop({
                prompt, workspace, settings, history, onEvent: wrappedOnEvent, requestPermission,
                agentId: 'main', tools, systemPrompt, emitText: true, abortSignal, limits, statusLine,
            });

            const userMsg = { role: 'user', content: prompt };
            // Drop any nudge the model consumed this turn (delivered exactly
            // once), then append a fresh one if this turn earned it.
            const newHistory = [...(history ?? []).filter((m) => !isMemoryNudge(m)), userMsg, ...responseMessages];
            if (sawEdit && !sawMemoryWrite) newHistory.push({ role: 'user', content: MEMORY_NUDGE });
            try { saveWorkspaceState(workspace, { sessionId, lastPrompt: prompt.slice(0, 200) }); } catch { /* never break the turn */ }

            statusLine?.stop();
            // Bug #11: tell the user explicitly when a turn was cut off by the
            // step or output-token cap rather than the model choosing to stop —
            // otherwise the turn just ends with no explanation, which looks
            // like the agent silently died mid-task.
            if (truncatedReason) {
                const note = truncatedReason === 'output-limit'
                    ? '\n\n_[Stopped: reached the output limit for this turn. Ask me to continue.]_'
                    : '\n\n_[Stopped: reached the step limit for this turn. Ask me to continue.]_';
                onEvent({ type: 'message', agent: 'main', content: note });
            }
            onEvent({ type: 'done', history: newHistory, usage });
        } catch (error: any) {
            const cancelled = abortSignal?.aborted;
            statusLine?.stop(cancelled ? 'Interrupted.' : undefined);
            throw error;
        }
    } catch (error: any) {
        const cancelled = abortSignal?.aborted;
        onEvent({ type: 'error', agent: 'main', content: cancelled ? 'Cancelled.' : error.message });
        onEvent({ type: 'done' });
    }
}
