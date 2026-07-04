// @ts-nocheck
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { resolveLimits } from '../../../shared/lib/modelLimits';

const MAX_HISTORY = 20;
const KEEP_RECENT = 8;
// Rough allowance for the system prompt + tool schemas when only a chars/4
// estimate of the history is available (no real usage reported yet).
const SYSTEM_OVERHEAD_EST = 4000;
const TRANSCRIPT_CHAR_LIMIT = 30000;

export const estimateTokens = (s) => Math.ceil(s.length / 4);
const historyTokens = (history) => history.reduce((sum, m) =>
    sum + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')), 0);

export function sliceHistory(history) {
    let cutIndex = Math.max(0, history.length - MAX_HISTORY);
    while (cutIndex < history.length && history[cutIndex].role === 'tool') cutIndex++;
    return history.slice(cutIndex);
}

// The token budget is derived from the model's context window: reserve room for
// the response (capped at a quarter of the window so huge-output models don't eat
// it), then compact once the estimated prompt exceeds 75% of what remains.
// Known limitation: the kept KEEP_RECENT tail is not itself token-bounded, so a
// tail of large capped tool results can exceed the budget and re-trigger
// compaction on consecutive turns. The Math.max(2, ...) cut floor guarantees at
// least two messages are summarized per pass, so this converges and never loops.
// lastInputTokens (real usage observed on the previous turn) is only consulted
// for the trigger and never re-checked after compaction within a turn, so a
// stale value cannot cause a loop either.
export async function compactHistory(history, settings, onEvent, abortSignal, force = false, limits, lastInputTokens) {
    if (!history || history.length <= 2) return history;
    limits = limits ?? resolveLimits(settings?.model, settings);
    const reserve = Math.min(limits.maxOutputTokens, Math.floor(limits.contextWindow * 0.25));
    const budget = Math.floor(0.75 * (limits.contextWindow - reserve));
    const promptTokens = (Number.isFinite(lastInputTokens) && lastInputTokens > 0)
        ? lastInputTokens
        : historyTokens(history) + SYSTEM_OVERHEAD_EST;
    if (!force && history.length <= MAX_HISTORY && promptTokens <= budget) return history;
    let cut = Math.max(2, history.length - KEEP_RECENT);
    while (cut < history.length && history[cut].role === 'tool') cut++;
    const old = history.slice(0, cut);
    const recent = history.slice(cut);
    try {
        onEvent({ type: 'status', agent: 'main', content: 'Compacting history…' });
        const transcript = old.map(m =>
            `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
        ).join('\n').slice(-TRANSCRIPT_CHAR_LIMIT);
        const customOpenAI = createOpenAI({ apiKey: settings.apiKey, baseURL: settings.baseUrl || undefined });
        const { text } = await generateText({
            model: customOpenAI.chat(settings.model || 'gpt-4o'),
            system: 'Summarize the conversation compactly. Preserve file paths, decisions made, code changes, and unresolved tasks.',
            prompt: `Conversation to summarize:\n${transcript}`,
            maxRetries: 1,
            abortSignal,
        });
        return [{ role: 'user', content: `[Earlier conversation summary]\n${text}` }, ...recent];
    } catch {
        return sliceHistory(history);
    } finally {
        onEvent({ type: 'status', agent: 'main', content: null });
    }
}

export async function forceCompact(history, settings, onEvent) {
    return compactHistory(history, settings, onEvent, undefined, true);
}
