// @ts-nocheck
import { memoryStore } from '../memory/memoryStore';

const MEMORY_FILE = 'MOON.md';

// Load both instruction layers (global ~/.moon/MOON.md + project MOON.md, with
// @imports resolved) plus the learned-fact index for prompt injection.
export function loadMemory(workspace: string): { global: string; project: string; catalog: { name: string; description: string; scope: string }[] } {
    try {
        const { global, project } = memoryStore.loadInstructions(workspace);
        return { global, project, catalog: memoryStore.buildMemoryCatalog(workspace) };
    } catch {
        return { global: '', project: '', catalog: [] };
    }
}

export function buildSystemPrompt({ workspace, globalMemory, projectMemory, memoryCatalog, skillsText, usageHint }: any): string {
    return `You are Moon Code, an advanced coding agentic IDE for Mac. You have full access to the user's workspace at ${workspace}. You must use tools to accomplish the user's requests autonomously. Do NOT wait for the user if you can figure it out. Answer concisely. Use grep_search and glob_search to find code instead of running grep or find through run_command.
${globalMemory ? `\nUSER INSTRUCTIONS (global, from ~/.moon/MOON.md — apply to every project):\n${globalMemory}\n` : ''}
${projectMemory ? `\nPROJECT INSTRUCTIONS (from ${MEMORY_FILE} in the workspace root — follow these):\n${projectMemory}\n` : ''}
${memoryCatalog.length ? `\nMEMORY (facts you saved earlier — call read_memory to load a fact's full detail before relying on it; call write_memory to persist durable new facts):\n${memoryCatalog.map((f) => `- ${f.name} [${f.scope}] — ${f.description}`).join('\n')}\n` : ''}
${skillsText ? `\n${skillsText}\n` : ''}
${usageHint?.skillContent ? `\nACTIVE SKILL — the user explicitly invoked a skill. Follow these instructions for this task:\n${usageHint.skillContent}\n` : ''}
For any task that takes more than one step, call set_progress at the start with the goal and an ordered checklist, then call it again as steps move to done — keep exactly one step active. Skip it for trivial one-step requests.
Format answers in GitHub-flavored Markdown (headings, lists, fenced code blocks with language tags).
When structured data would read better as a widget — tables, file listings, side-by-side comparisons, small dashboards — call the render_ui tool instead of writing a markdown table, then continue in normal markdown. Never paste raw JSON UI specs into your prose.`;
}
