// @ts-nocheck
import { streamText, tool, stepCountIs, generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// In a real app, this should be set securely via UI or local config file.
// For now, we assume process.env.OPENAI_API_KEY is set or passed in.
import * as dotenv from 'dotenv';
dotenv.config();

import { catalog } from '../shared/uiCatalog';

const MAX_HISTORY = 20;
const KEEP_RECENT = 8;
const HISTORY_TOKEN_BUDGET = 40000;
const estimateTokens = (s) => Math.ceil(s.length / 4);
const historyTokens = (history) => history.reduce((sum, m) =>
    sum + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')), 0);
const TRANSCRIPT_CHAR_LIMIT = 30000;
const MEMORY_FILE = 'MOON.md';
const MEMORY_CHAR_LIMIT = 12000;
const TOOL_OUTPUT_CHAR_LIMIT = 30000;
const READ_DEFAULT_LINES = 2000;
const READ_CHAR_LIMIT = 50000;
const LIST_DIR_MAX_ENTRIES = 500;
const MAX_STEPS = 50;

function truncateOutput(text, limit = TOOL_OUTPUT_CHAR_LIMIT) {
    if (text.length <= limit) return text;
    const head = Math.floor(limit * 0.8);
    const tail = Math.floor(limit * 0.1);
    const removed = text.length - head - tail;
    return `${text.slice(0, head)}\n[... truncated ${removed} chars ...]\n${text.slice(-tail)}`;
}

function resolveInWorkspace(workspace, relPath) {
    const root = path.resolve(workspace);
    const abs = path.resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return abs;
}

function sliceHistory(history) {
    let cutIndex = Math.max(0, history.length - MAX_HISTORY);
    while (cutIndex < history.length && history[cutIndex].role === 'tool') cutIndex++;
    return history.slice(cutIndex);
}

// Known limitation: the kept KEEP_RECENT tail is not itself token-bounded, so a
// tail of large capped tool results can exceed HISTORY_TOKEN_BUDGET and re-trigger
// compaction on consecutive turns. The Math.max(2, ...) cut floor guarantees at
// least two messages are summarized per pass, so this converges and never loops.
async function compactHistory(history, settings, onEvent) {
    if (!history || (history.length <= MAX_HISTORY && historyTokens(history) <= HISTORY_TOKEN_BUDGET)) return history;
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
        });
        return [{ role: 'user', content: `[Earlier conversation summary]\n${text}` }, ...recent];
    } catch {
        return sliceHistory(history);
    } finally {
        onEvent({ type: 'status', agent: 'main', content: null });
    }
}

async function loadProjectMemory(workspace: string): Promise<string> {
    try {
        const content = await fs.promises.readFile(path.join(workspace, MEMORY_FILE), 'utf-8');
        return content.trim().slice(0, MEMORY_CHAR_LIMIT);
    } catch {
        return '';
    }
}

function makeTools({ workspace, onEvent, requestPermission, agentId, includeSpawn, settings, spawnState, abortSignal }) {
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
                    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
                    await fs.promises.writeFile(absPath, content, 'utf-8');
                    const res = `Successfully wrote to ${filePath}`;
                    emit({ type: 'tool_result', name: 'write_file', result: res });
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
                    emit({ type: 'tool_result', name: 'edit_file', result: res });
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
        })
    };
    if (includeSpawn) {
        tools.spawn_agent = tool({
            description: 'Delegate a self-contained task to a parallel subagent with its own tool access. The subagent cannot ask you questions — include all needed context in the task. Returns its plain-text findings. You may call spawn_agent multiple times in one step to run tasks in parallel.',
            inputSchema: z.object({
                task: z.string().describe('Complete, self-contained task description with all necessary context.'),
            }),
            execute: async ({ task }) => {
                const subId = `sub-${++spawnState.counter}`;
                emit({ type: 'tool_call', name: 'spawn_agent', arguments: JSON.stringify({ task }) });
                const subSystemPrompt = `You are a Moon Agent subagent working autonomously in the workspace at ${workspace}. Complete the following task using your tools, then reply with concise plain-text findings. Do not ask questions; do not output JSON UI specs.
${spawnState.projectMemory ? `\nPROJECT INSTRUCTIONS (from MOON.md in the workspace root — follow these):\n${spawnState.projectMemory}\n` : ''}`;
                try {
                    const subTools = makeTools({ workspace, onEvent, requestPermission, agentId: subId, includeSpawn: false, settings, spawnState, abortSignal });
                    const { text } = await runAgentLoop({
                        prompt: task, workspace, settings, history: [],
                        onEvent, requestPermission, agentId: subId,
                        tools: subTools, systemPrompt: subSystemPrompt, emitText: false, abortSignal,
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
    return tools;
}

async function runAgentLoop({ prompt, workspace, settings, history, onEvent, requestPermission, agentId, tools, systemPrompt, emitText, abortSignal }) {
    const customOpenAI = createOpenAI({
        apiKey: settings.apiKey,
        baseURL: settings.baseUrl || undefined,
    });
    const userMsg = { role: 'user', content: prompt };
    const result = streamText({
        model: customOpenAI.chat(settings.model || 'gpt-4o'),
        system: systemPrompt,
        messages: [...(history ?? []), userMsg],
        tools,
        abortSignal,
        stopWhen: stepCountIs(MAX_STEPS),
    });

    for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
            if (emitText) onEvent({ type: 'message', agent: agentId, content: part.text });
        } else if (part.type === 'error') {
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
    }

    return { text: await result.text, responseMessages: await result.responseMessages };
}

export async function handlePrompt(
    prompt: string,
    workspace: string,
    settings: any,
    history: any[] | undefined,
    onEvent: (event: any) => void,
    requestPermission: (name: string, args: any, agentId: string) => Promise<boolean>,
    abortSignal?: AbortSignal,
) {
    try {
        history = await compactHistory(history, settings, onEvent);

        const projectMemory = await loadProjectMemory(workspace);

        const systemPrompt = `You are Moon Agent, an advanced coding agentic IDE for Mac. You have full access to the user's workspace at ${workspace}. You must use tools to accomplish the user's requests autonomously. Do NOT wait for the user if you can figure it out. Answer concisely.
${projectMemory ? `\nPROJECT INSTRUCTIONS (from ${MEMORY_FILE} in the workspace root — follow these):\n${projectMemory}\n` : ''}
${catalog.prompt({
            system: 'Your final answer to the user must be valid UI spec JSONL (SpecStream format), not plain prose.',
            customRules: [
                'Always wrap your entire response in a single root Stack element, even for a one-sentence answer.',
                'Use Table for any tabular or file-listing data instead of describing it in prose.',
                'Use CodeBlock for command output, code snippets, or file contents.',
                'Use List for enumerated points or suggestions.',
                'Use Text for everything else.',
            ],
            mode: 'standalone',
        })}`;

        const tools = makeTools({
            workspace, onEvent, requestPermission, agentId: 'main',
            includeSpawn: true, settings, spawnState: { counter: 0, projectMemory }, abortSignal,
        });

        const { responseMessages } = await runAgentLoop({
            prompt, workspace, settings, history, onEvent, requestPermission,
            agentId: 'main', tools, systemPrompt, emitText: true, abortSignal,
        });

        const userMsg = { role: 'user', content: prompt };
        const newHistory = [...(history ?? []), userMsg, ...responseMessages];

        onEvent({ type: 'done', history: newHistory });
    } catch (error: any) {
        const cancelled = abortSignal?.aborted;
        onEvent({ type: 'error', agent: 'main', content: cancelled ? 'Cancelled.' : error.message });
        onEvent({ type: 'done' });
    }
}
