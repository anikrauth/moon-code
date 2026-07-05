// @ts-nocheck
// One-shot LLM call that turns a working-tree change summary (from
// gitService.changesSummary) into a commit message. Takes text in and returns
// text out — no git dependency — so tests only need the fake OpenAI server.
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

const MESSAGE_CHAR_CAP = 200;

const SYSTEM =
    'You write git commit messages. Reply with ONLY the commit message: a single imperative subject line under 72 characters. ' +
    'Use conventional-commit style (feat:, fix:, refactor:, docs:, test:, chore:) when the change type is obvious. ' +
    'No quotes, no code fences, no trailing period, no explanation.';

// Models sometimes wrap the message in fences/quotes or add commentary
// despite instructions; keep only a clean first line.
function cleanMessage(text) {
    let s = (text ?? '').trim();
    s = s.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
    const line = s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    return line.replace(/^["'`]+/, '').replace(/["'`]+$/, '').slice(0, MESSAGE_CHAR_CAP).trim();
}

export async function generateCommitMessage(summary, settings, abortSignal) {
    try {
        const customOpenAI = createOpenAI({ apiKey: settings.apiKey, baseURL: settings.baseUrl || undefined });
        const { text } = await generateText({
            model: customOpenAI.chat(settings.model || 'gpt-4o'),
            system: SYSTEM,
            prompt: `Write a commit message for these changes:\n\n${summary}`,
            maxRetries: 1,
            abortSignal,
        });
        const message = cleanMessage(text);
        if (!message) return { ok: false, error: 'Could not generate a commit message.' };
        return { ok: true, message };
    } catch (e) {
        return { ok: false, error: e?.message ?? 'Could not generate a commit message.' };
    }
}
