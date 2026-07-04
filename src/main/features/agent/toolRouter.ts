// @ts-nocheck
import { tool, jsonSchema } from 'ai';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

import { parseRenderUiSpec } from '../../../shared/lib/renderUiSpec';
import { globSearch, grepSearch } from '../search/searchTools';
import { computeLineDiff } from '../diff/diffStats';
import { buildInvocableCatalog } from '../skills/skillScanner';
import { installSkillPackage } from '../skills/skillInstaller';
import { memoryStore } from '../memory/memoryStore';
// Circular with agentLoop.ts: spawn_agent's execute() calls runAgentLoop to
// drive a subagent turn, and agentLoop.ts's handlePrompt calls makeTools to
// build the main agent's tools. Both references are only used inside
// callbacks invoked well after module load, so the cycle resolves fine at
// runtime — do not hoist either call to module-evaluation time.
import { runAgentLoop } from './agentLoop';

const TOOL_OUTPUT_CHAR_LIMIT = 30000;
const READ_DEFAULT_LINES = 2000;
const READ_CHAR_LIMIT = 50000;
const LIST_DIR_MAX_ENTRIES = 500;

/* Hand-written instead of catalog.prompt(): the generated prompt is ~14 KB of
   state/bindings/actions machinery this static catalog never uses. Keep this
   in sync with src/shared/uiCatalog.ts. */
const RENDER_UI_DESCRIPTION = `Render a rich UI widget inline in the chat. Use for tabular data, file listings, structured comparisons, or small dashboards — anywhere a widget communicates better than markdown prose.
The "spec" input is SpecStream JSONL: one RFC-6902 JSON Patch op per line, building /root then /elements. Example:
{"op":"add","path":"/root","value":"main"}
{"op":"add","path":"/elements/main","value":{"type":"Stack","props":{},"children":["title","tbl"]}}
{"op":"add","path":"/elements/title","value":{"type":"Text","props":{"content":"Files"},"children":[]}}
{"op":"add","path":"/elements/tbl","value":{"type":"Table","props":{"headers":["Name","Size"],"rows":[["a.ts","1 KB"]]},"children":[]}}
Available components (props):
- Stack {} — vertical container; always the root; child element ids go in "children"
- Text {content: string} — one paragraph
- List {items: string[], ordered: boolean|null}
- Table {headers: string[], rows: string[][]} — every row must match headers length
- CodeBlock {code: string, language: string|null}
Rules: every element needs "type", "props", "children" ([] when empty). Do not invent component types. If the tool returns an error, fix the spec and call it again.`;

export function truncateOutput(text, limit = TOOL_OUTPUT_CHAR_LIMIT) {
    if (text.length <= limit) return text;
    const head = Math.floor(limit * 0.8);
    const tail = Math.floor(limit * 0.1);
    const removed = text.length - head - tail;
    return `${text.slice(0, head)}\n[... truncated ${removed} chars ...]\n${text.slice(-tail)}`;
}

export function resolveInWorkspace(workspace, relPath) {
    const root = path.resolve(workspace);
    const abs = path.resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    // Lexical check alone is not enough: a symlink inside the workspace can
    // point anywhere on disk. Realpath the deepest existing ancestor (the
    // target itself may not exist yet, e.g. write_file creating it) and
    // re-check containment against the realpath'd root — same defense as
    // realPathWithinWorkspace() in workspaceInit.ts, extended to not-yet-
    // existing paths.
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch { return null; }
    let probe = abs;
    let suffix = '';
    for (;;) {
        let real;
        try { real = fs.realpathSync(probe); } catch {
            const parent = path.dirname(probe);
            if (parent === probe) return null;
            suffix = suffix ? path.join(path.basename(probe), suffix) : path.basename(probe);
            probe = parent;
            continue;
        }
        const resolved = suffix ? path.join(real, suffix) : real;
        if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) return null;
        return abs;
    }
}

export function makeTools({ workspace, onEvent, requestPermission, requestQuestion, agentId, includeSpawn, settings, spawnState, abortSignal, extraTools, limits, skillsCatalog }) {
    const emit = (e) => onEvent({ agent: agentId, ...e });
    const denied = (name) => {
        const res = 'User denied permission for this action.';
        emit({ type: 'tool_result', name, result: res });
        return res;
    };
    const tools: any = {
        run_command: tool({
            description: 'Execute a bash command in the current workspace.',
            inputSchema: z.object({
                command: z.string().describe('The command line string to execute.'),
            }),
            execute: async ({ command }) => {
                emit({ type: 'tool_call', name: 'run_command', arguments: JSON.stringify({ command }) });
                if (!await requestPermission('run_command', { command }, agentId)) return denied('run_command');
                try {
                    const { stdout, stderr } = await execAsync(command, { cwd: workspace, timeout: 60000, signal: abortSignal });
                    const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
                    const finalOut = output.trim() ? truncateOutput(output) : 'Command executed successfully (no output).';
                    emit({ type: 'tool_result', name: 'run_command', result: finalOut });
                    return finalOut;
                } catch (e: any) {
                    const errMsg = truncateOutput(`Error: ${e.message}`);
                    emit({ type: 'tool_result', name: 'run_command', result: errMsg });
                    return errMsg;
                }
            }
        }),
        read_file: tool({
            description: 'Read the contents of a file.',
            inputSchema: z.object({
                filePath: z.string().describe('Path to the file, relative to workspace.'),
                offset: z.number().int().min(1).nullable().optional().describe('1-based line number to start reading from. Default 1.'),
                limit: z.number().int().min(1).nullable().optional().describe('Maximum number of lines to return. Default 2000.'),
            }),
            execute: async ({ filePath, offset, limit }) => {
                emit({ type: 'tool_call', name: 'read_file', arguments: JSON.stringify({ filePath, offset, limit }) });
                try {
                    const absPath = resolveInWorkspace(workspace, filePath);
                    if (!absPath) {
                        const errMsg = `Error: path escapes the workspace: ${filePath}`;
                        emit({ type: 'tool_result', name: 'read_file', result: errMsg });
                        return errMsg;
                    }
                    const content = await fs.promises.readFile(absPath, 'utf-8');
                    const lines = content.split('\n');
                    const total = lines.length;
                    const start = (offset ?? 1) - 1;
                    if (start >= total) {
                        const errMsg = `Error: offset ${offset} is beyond end of file (${total} lines).`;
                        emit({ type: 'tool_result', name: 'read_file', result: errMsg });
                        return errMsg;
                    }
                    const window = lines.slice(start, start + (limit ?? READ_DEFAULT_LINES));
                    let text = window.join('\n');
                    let charCut = false;
                    if (text.length > READ_CHAR_LIMIT) {
                        text = text.slice(0, READ_CHAR_LIMIT);
                        charCut = true;
                    }
                    const lastLine = charCut ? Math.max(start + 1, start + text.split('\n').length - 1) : start + window.length;
                    if (start > 0 || lastLine < total || charCut) {
                        text += `\n[showing lines ${start + 1}–${lastLine} of ${total} total — call again with offset/limit for more]`;
                    }
                    emit({ type: 'tool_result', name: 'read_file', result: text });
                    return text;
                } catch (e: any) {
                    const errMsg = `Error reading file: ${e.message}`;
                    emit({ type: 'tool_result', name: 'read_file', result: errMsg });
                    return errMsg;
                }
            }
        }),
        write_file: tool({
            description: 'Create a new file with the given content (creates parent directories). For modifying an existing file, use edit_file instead.',
            inputSchema: z.object({
                filePath: z.string().describe('Path to the file, relative to workspace.'),
                content: z.string().describe('The full content to write into the file.'),
            }),
            execute: async ({ filePath, content }) => {
                emit({ type: 'tool_call', name: 'write_file', arguments: JSON.stringify({ filePath }) });
                const absPath = resolveInWorkspace(workspace, filePath);
                if (!absPath) {
                    const errMsg = `Error: path escapes the workspace: ${filePath}`;
                    emit({ type: 'tool_result', name: 'write_file', result: errMsg });
                    return errMsg;
                }
                if (!await requestPermission('write_file', { filePath }, agentId)) return denied('write_file');
                try {
                    let oldContent = null;
                    try { oldContent = await fs.promises.readFile(absPath, 'utf-8'); } catch { /* new file */ }
                    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
                    await fs.promises.writeFile(absPath, content, 'utf-8');
                    const res = `Successfully wrote to ${filePath}`;
                    const { adds, dels } = computeLineDiff(oldContent, content);
                    emit({ type: 'tool_result', name: 'write_file', result: res,
                        fileChange: { path: filePath, adds, dels, kind: oldContent == null ? 'create' : 'update' } });
                    return res;
                } catch (e: any) {
                    const errMsg = `Error writing file: ${e.message}`;
                    emit({ type: 'tool_result', name: 'write_file', result: errMsg });
                    return errMsg;
                }
            }
        }),
        edit_file: tool({
            description: 'Edit an existing file by replacing an exact string match. oldString must appear exactly once in the file — include enough surrounding lines to make it unique.',
            inputSchema: z.object({
                filePath: z.string().describe('Path to the file, relative to workspace.'),
                oldString: z.string().describe('Exact existing text to replace, including whitespace and indentation.'),
                newString: z.string().describe('The replacement text.'),
            }),
            execute: async ({ filePath, oldString, newString }) => {
                emit({ type: 'tool_call', name: 'edit_file', arguments: JSON.stringify({ filePath }) });
                const absPath = resolveInWorkspace(workspace, filePath);
                if (!absPath) {
                    const errMsg = `Error: path escapes the workspace: ${filePath}`;
                    emit({ type: 'tool_result', name: 'edit_file', result: errMsg });
                    return errMsg;
                }
                if (!await requestPermission('edit_file', { filePath, oldString, newString }, agentId)) return denied('edit_file');
                try {
                    const content = await fs.promises.readFile(absPath, 'utf-8');
                    const occurrences = content.split(oldString).length - 1;
                    if (occurrences === 0) {
                        const res = 'Error: oldString not found in file. Read the file and use the exact text, including whitespace.';
                        emit({ type: 'tool_result', name: 'edit_file', result: res });
                        return res;
                    }
                    if (occurrences > 1) {
                        const res = `Error: oldString matches ${occurrences} locations. Include more surrounding context to make it unique.`;
                        emit({ type: 'tool_result', name: 'edit_file', result: res });
                        return res;
                    }
                    await fs.promises.writeFile(absPath, content.replace(oldString, newString), 'utf-8');
                    const res = `Successfully edited ${filePath}`;
                    const { adds, dels } = computeLineDiff(oldString, newString);
                    emit({ type: 'tool_result', name: 'edit_file', result: res,
                        fileChange: { path: filePath, adds, dels, kind: 'update' } });
                    return res;
                } catch (e: any) {
                    const errMsg = `Error editing file: ${e.message}`;
                    emit({ type: 'tool_result', name: 'edit_file', result: errMsg });
                    return errMsg;
                }
            }
        }),
        list_dir: tool({
            description: 'List files and directories in a path.',
            inputSchema: z.object({
                dirPath: z.string().describe('Path to the directory, relative to workspace. Use "." for root.'),
            }),
            execute: async ({ dirPath }) => {
                emit({ type: 'tool_call', name: 'list_dir', arguments: JSON.stringify({ dirPath }) });
                try {
                    const absPath = resolveInWorkspace(workspace, dirPath);
                    if (!absPath) {
                        const errMsg = `Error: path escapes the workspace: ${dirPath}`;
                        emit({ type: 'tool_result', name: 'list_dir', result: errMsg });
                        return errMsg;
                    }
                    const items = await fs.promises.readdir(absPath);
                    let res;
                    if (items.length === 0) res = 'Directory is empty.';
                    else if (items.length > LIST_DIR_MAX_ENTRIES) {
                        res = `${items.slice(0, LIST_DIR_MAX_ENTRIES).join('\n')}\n[... ${items.length - LIST_DIR_MAX_ENTRIES} more entries not shown]`;
                    } else res = items.join('\n');
                    emit({ type: 'tool_result', name: 'list_dir', result: res });
                    return res;
                } catch (e: any) {
                    const errMsg = `Error listing directory: ${e.message}`;
                    emit({ type: 'tool_result', name: 'list_dir', result: errMsg });
                    return errMsg;
                }
            }
        }),
        glob_search: tool({
            description: 'Find files by glob pattern (e.g. "src/**/*.ts") matched against workspace-relative paths, newest first. Prefer this over run_command with find.',
            inputSchema: z.object({
                pattern: z.string().describe('Glob pattern. Supports **, *, and ?.'),
            }),
            execute: async ({ pattern }) => {
                emit({ type: 'tool_call', name: 'glob_search', arguments: JSON.stringify({ pattern }) });
                const res = truncateOutput(globSearch({ workspace, pattern }));
                emit({ type: 'tool_result', name: 'glob_search', result: res });
                return res;
            }
        }),
        grep_search: tool({
            description: 'Search file contents with a regular expression. Returns matches as "path:line: text". Prefer this over run_command with grep.',
            inputSchema: z.object({
                pattern: z.string().describe('Regular expression to search for. Case-insensitive unless caseSensitive is true.'),
                path: z.string().nullable().optional().describe('Directory to search, relative to workspace. Default ".".'),
                filePattern: z.string().nullable().optional().describe('Glob filter for file paths, e.g. "**/*.ts".'),
                caseSensitive: z.boolean().nullable().optional().describe('Match case exactly. Default false.'),
            }),
            execute: async ({ pattern, path: searchPath, filePattern, caseSensitive }) => {
                emit({ type: 'tool_call', name: 'grep_search', arguments: JSON.stringify({ pattern, path: searchPath, filePattern, caseSensitive }) });
                const res = truncateOutput(grepSearch({
                    workspace, pattern,
                    path: searchPath ?? undefined,
                    filePattern: filePattern ?? undefined,
                    caseSensitive: !!caseSensitive,
                }));
                emit({ type: 'tool_result', name: 'grep_search', result: res });
                return res;
            }
        })
    };
    if (skillsCatalog && skillsCatalog.length > 0) {
        tools.skill = tool({
            description: 'Load the full instructions for one of the AVAILABLE SKILLS listed in the system prompt. Call this before starting work that matches a skill\'s description — it returns the skill\'s complete procedure, which you must then follow for the rest of the task.',
            inputSchema: z.object({
                skill_id: z.string().describe('The exact id of the skill to load, as listed in AVAILABLE SKILLS.'),
            }),
            execute: async ({ skill_id }) => {
                emit({ type: 'tool_call', name: 'skill', arguments: JSON.stringify({ skill_id }) });
                const found = skillsCatalog.find((s) => s.id === skill_id);
                const res = found
                    ? found.content
                    : `Error: no skill named "${skill_id}". Available: ${skillsCatalog.map((s) => s.id).join(', ')}`;
                emit({ type: 'tool_result', name: 'skill', result: res });
                return res;
            }
        });
    }
    tools.install_skill = tool({
        description: 'Install a skill from the open agent-skills ecosystem (skills.sh) by package spec, e.g. "vercel-labs/agent-skills@react-best-practices" or "owner/repo". Runs non-interactively and makes the skill available immediately — prefer this over run_command with npx. The skill\'s full instructions are returned so you can start using it right away.',
        inputSchema: z.object({
            package: z.string().describe('The skill package spec: "owner/repo" or "owner/repo@skill".'),
        }),
        execute: async ({ package: pkg }) => {
            emit({ type: 'tool_call', name: 'install_skill', arguments: JSON.stringify({ package: pkg }) });
            // Downloads and runs third-party code — gate behind the same
            // permission prompt as run_command.
            if (!await requestPermission('install_skill', { package: pkg }, agentId)) return denied('install_skill');
            const result = await installSkillPackage(pkg, workspace, { signal: abortSignal });
            if (!result.success) {
                const errMsg = truncateOutput(`Error: ${result.error}`);
                emit({ type: 'tool_result', name: 'install_skill', result: errMsg });
                return errMsg;
            }
            // Refresh the live catalog in place so the `skill` tool can load the
            // new skill later in this same turn (both tools share this array).
            try {
                const { skillsCatalog: fresh } = buildInvocableCatalog(workspace);
                if (Array.isArray(skillsCatalog)) { skillsCatalog.length = 0; skillsCatalog.push(...fresh); }
            } catch { /* refresh is best-effort; content is returned below regardless */ }
            const skill = result.skill;
            emit({ type: 'skill_installed', id: skill?.id ?? null, location: '~/.agents/skills' });
            const res = skill
                ? `Installed "${skill.id}" to ~/.agents/skills (shared ecosystem store — available now, no restart needed).\n\n--- ${skill.id} instructions ---\n${skill.content}`
                : `Installed ${pkg} to ~/.agents/skills. It is now available via the skill tool.`;
            const out = truncateOutput(res);
            emit({ type: 'tool_result', name: 'install_skill', result: out });
            return out;
        }
    });
    tools.read_memory = tool({
        description: 'Load the full saved detail of a fact listed under MEMORY in the system prompt. Call this before relying on a remembered fact — the index only shows a one-line summary.',
        inputSchema: z.object({
            name: z.string().describe('The fact name exactly as listed under MEMORY.'),
            scope: z.enum(['project', 'global']).nullable().optional().describe('Where to look. Omit to search project then global.'),
        }),
        execute: async ({ name, scope }) => {
            emit({ type: 'tool_call', name: 'read_memory', arguments: JSON.stringify({ name }) });
            const res = memoryStore.readFact(scope ?? null, workspace, name) ?? `Error: no memory fact named "${name}".`;
            emit({ type: 'tool_result', name: 'read_memory', result: res });
            return res;
        }
    });
    tools.write_memory = tool({
        description: 'Persist a durable fact to memory so it survives across sessions and future chats. Use for stable facts, user preferences, decisions, or project context worth recalling later — NOT transient conversation detail. Reuse an existing name to update it.',
        inputSchema: z.object({
            name: z.string().describe('Short kebab-case id, e.g. "api-base-url".'),
            description: z.string().describe('One-line summary shown in the MEMORY index.'),
            body: z.string().describe('The fact content to store.'),
            scope: z.enum(['project', 'global']).nullable().optional().describe('"project" (this workspace, default) or "global" (all projects).'),
        }),
        execute: async ({ name, description, body, scope }) => {
            const useScope = scope ?? 'project';
            emit({ type: 'tool_call', name: 'write_memory', arguments: JSON.stringify({ name, scope: useScope }) });
            if (!await requestPermission('write_memory', { name, scope: useScope }, agentId)) return denied('write_memory');
            try {
                memoryStore.writeFact(useScope, workspace, { name, description, body });
                const res = `Saved memory "${name}" (${useScope}).`;
                emit({ type: 'tool_result', name: 'write_memory', result: res });
                return res;
            } catch (e: any) {
                const errMsg = `Error saving memory: ${e.message}`;
                emit({ type: 'tool_result', name: 'write_memory', result: errMsg });
                return errMsg;
            }
        }
    });
    if (includeSpawn) {
        // Main agent only: subagents report plain text back to the orchestrator,
        // so a widget rendered from a subagent would appear out of context.
        tools.render_ui = tool({
            description: RENDER_UI_DESCRIPTION,
            inputSchema: z.object({
                spec: z.string().describe('SpecStream JSONL, one JSON Patch op per line.'),
            }),
            execute: async ({ spec }) => {
                emit({ type: 'tool_call', name: 'render_ui', arguments: JSON.stringify({ spec }) });
                const parsed = parseRenderUiSpec(spec);
                const res = parsed.ok
                    ? 'Widget rendered in the chat. Do not repeat its contents in prose; continue after it if needed.'
                    : `Error: invalid UI spec — ${parsed.error}\nFix the issues and call render_ui again.`;
                emit({ type: 'tool_result', name: 'render_ui', result: res });
                return res;
            }
        });
        tools.set_progress = tool({
            description: 'Track your plan for the current task so the user can follow along in the Progress panel. Call this at the START of any multi-step task with the goal and an ordered checklist of steps, then call it again whenever a step changes status. Keep exactly one step "active" at a time; mark finished steps "done". Reuse the exact same `id` for a given checklist item across every call — never reuse an id for a different step. For trivial one-step requests, skip it.',
            inputSchema: z.object({
                goal: z.string().min(1).describe('One-line description of what the user asked for.'),
                steps: z.array(z.object({
                    id: z.string().min(1).optional().describe('Stable id for this step, e.g. "1", "2" — keep it identical across calls when only this step\'s status changes.'),
                    text: z.string().min(1).describe('Short imperative step description.'),
                    status: z.enum(['pending', 'active', 'done']).describe('pending = not started, active = in progress now, done = finished.'),
                })).min(1).max(30).describe('Ordered checklist. Exactly one step should be "active".'),
            }),
            execute: async ({ goal, steps }) => {
                // Bug #12: fall back to a positional id for any step the model
                // left blank/duplicated, so the renderer always has a stable,
                // unique key to diff against even if the model doesn't comply
                // with the "reuse the same id" instruction above.
                const seenIds = new Set<string>();
                const normalizedSteps = steps.map((s: any, i: number) => {
                    let id = typeof s.id === 'string' && s.id.trim() ? s.id : `step-${i}`;
                    if (seenIds.has(id)) id = `step-${i}`;
                    seenIds.add(id);
                    return { ...s, id };
                });
                // No tool_call/tool_result events — progress drives a side panel,
                // not the transcript, so it stays out of the chat chip stream.
                emit({ type: 'progress', goal, steps: normalizedSteps });
                return 'Progress updated.';
            }
        });
        tools.ask_user = tool({
            description: 'Ask the user a clarifying question before proceeding, when a request is genuinely ambiguous (e.g. more than one plausible way to change a calculation/formula). Give 2-4 concrete, labeled options describing what each would do. Call this BEFORE editing any code affected by the ambiguity — do not guess and fix it up after. Not for routine confirmations; use only when the interpretations would produce meaningfully different results.',
            inputSchema: z.object({
                question: z.string().min(1).describe('The question to ask, including what you found in the code that makes it ambiguous.'),
                options: z.array(z.object({
                    label: z.string().min(1).describe('Short option title, e.g. "New Payable formula".'),
                    description: z.string().min(1).describe('One sentence explaining what choosing this option means.'),
                })).min(2).max(4).describe('Concrete, mutually exclusive interpretations for the user to pick from.'),
            }),
            execute: async ({ question, options }) => {
                emit({ type: 'tool_call', name: 'ask_user', arguments: JSON.stringify({ question, options }) });
                if (!requestQuestion) {
                    const res = 'No user-question channel available — proceed with your best judgment and state the assumption you made.';
                    emit({ type: 'tool_result', name: 'ask_user', result: res });
                    return res;
                }
                const answer = await requestQuestion(question, options, agentId);
                const res = answer ? `User chose: ${answer}` : 'User skipped the question — proceed with your best judgment and state the assumption you made.';
                emit({ type: 'tool_result', name: 'ask_user', result: res });
                return res;
            }
        });
        tools.spawn_agent = tool({
            description: 'Delegate a self-contained task to a parallel subagent with its own tool access. The subagent cannot ask you questions — include all needed context in the task. Returns its plain-text findings. You may call spawn_agent multiple times in one step to run tasks in parallel.',
            inputSchema: z.object({
                task: z.string().describe('Complete, self-contained task description with all necessary context.'),
            }),
            execute: async ({ task }) => {
                const subId = `sub-${++spawnState.counter}`;
                emit({ type: 'tool_call', name: 'spawn_agent', arguments: JSON.stringify({ task }) });
                const subSystemPrompt = `You are a Moon Code subagent working autonomously in the workspace at ${workspace}. Complete the following task using your tools, then reply with concise plain-text findings. Do not ask questions; do not output JSON UI specs.
${spawnState.globalMemory ? `\nUSER INSTRUCTIONS (global, from ~/.moon/MOON.md — apply to every project):\n${spawnState.globalMemory}\n` : ''}
${spawnState.projectMemory ? `\nPROJECT INSTRUCTIONS (from MOON.md in the workspace root — follow these):\n${spawnState.projectMemory}\n` : ''}
${(spawnState.memoryCatalog?.length) ? `\nMEMORY (call read_memory to load a fact's detail):\n${spawnState.memoryCatalog.map((f) => `- ${f.name} [${f.scope}] — ${f.description}`).join('\n')}\n` : ''}
${spawnState.skillsText ? `\n${spawnState.skillsText}\n` : ''}`;
                try {
                    const subTools = makeTools({ workspace, onEvent, requestPermission, agentId: subId, includeSpawn: false, settings, spawnState, abortSignal, extraTools, limits, skillsCatalog: spawnState.skillsCatalog });
                    const { text } = await runAgentLoop({
                        prompt: task, workspace, settings, history: [],
                        onEvent, requestPermission, agentId: subId,
                        tools: subTools, systemPrompt: subSystemPrompt, emitText: false, abortSignal, limits,
                    });
                    const res = text?.trim() ? truncateOutput(text) : 'Subagent finished with no output.';
                    onEvent({ type: 'tool_result', name: 'spawn_agent', agent: agentId, result: res });
                    return res;
                } catch (e: any) {
                    const errMsg = `Error: subagent failed: ${e.message}`;
                    onEvent({ type: 'tool_result', name: 'spawn_agent', agent: agentId, result: errMsg });
                    return errMsg;
                }
            }
        });
    }
    if (extraTools) {
        for (const [name, def] of Object.entries(extraTools)) {
            tools[name] = tool({
                description: def.description,
                inputSchema: jsonSchema(def.inputSchema),
                execute: async (args) => {
                    emit({ type: 'tool_call', name, arguments: JSON.stringify(args ?? {}) });
                    if (!await requestPermission(name, args, agentId)) return denied(name);
                    let res;
                    try {
                        res = await def.execute(args);
                    } catch (e) {
                        res = `Error: ${e?.message ?? String(e)}`;
                    }
                    const out = truncateOutput(typeof res === 'string' ? res : JSON.stringify(res));
                    emit({ type: 'tool_result', name, result: out });
                    return out;
                }
            });
        }
    }
    return tools;
}
