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

const MAX_STEPS = 50;

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
        history = await compactHistory(history, settings, onEvent, abortSignal, false, limits, usageHint?.lastInputTokens);

        const { global: globalMemory, project: projectMemory, catalog: memoryCatalog } = loadMemory(workspace);
        const scratchDir = ensureScratchDir(workspace);
        const plansDir = ensurePlansDir(workspace);

        const systemPrompt = buildSystemPrompt({ workspace, scratchDir, plansDir, globalMemory, projectMemory, memoryCatalog, skillsText, usageHint });

        const tools = makeTools({
            workspace, onEvent, requestPermission, requestQuestion, agentId: 'main',
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
                prompt, workspace, settings, history, onEvent, requestPermission,
                agentId: 'main', tools, systemPrompt, emitText: true, abortSignal, limits, statusLine,
            });

            const userMsg = { role: 'user', content: prompt };
            const newHistory = [...(history ?? []), userMsg, ...responseMessages];

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
