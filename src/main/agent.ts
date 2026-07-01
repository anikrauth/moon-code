// @ts-nocheck
import { streamText, tool, stepCountIs } from 'ai';
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
const MEMORY_FILE = 'MOON.md';
const MEMORY_CHAR_LIMIT = 12000;

async function loadProjectMemory(workspace: string): Promise<string> {
    try {
        const content = await fs.promises.readFile(path.join(workspace, MEMORY_FILE), 'utf-8');
        return content.trim().slice(0, MEMORY_CHAR_LIMIT);
    } catch {
        return '';
    }
}

export async function handlePrompt(
    prompt: string,
    workspace: string,
    settings: any,
    history: any[] | undefined,
    onEvent: (event: any) => void,
    requestPermission: (name: string, args: any) => Promise<boolean>,
) {
    try {
        const denied = (name: string) => {
            const res = 'User denied permission for this action.';
            onEvent({ type: 'tool_result', name, result: res });
            return res;
        };

        const tools = {
            run_command: tool({
                description: 'Execute a bash command in the current workspace.',
                inputSchema: z.object({
                    command: z.string().describe('The command line string to execute.'),
                }),
                execute: async ({ command }) => {
                    onEvent({ type: 'tool_call', name: 'run_command', arguments: JSON.stringify({ command }) });
                    if (!await requestPermission('run_command', { command })) return denied('run_command');
                    try {
                        const { stdout, stderr } = await execAsync(command, { cwd: workspace, timeout: 60000 });
                        const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
                        const finalOut = output.trim() ? output : 'Command executed successfully (no output).';
                        onEvent({ type: 'tool_result', name: 'run_command', result: finalOut });
                        return finalOut;
                    } catch (e: any) {
                        onEvent({ type: 'tool_result', name: 'run_command', result: `Error: ${e.message}` });
                        return `Error: ${e.message}`;
                    }
                }
            }),
            read_file: tool({
                description: 'Read the contents of a file.',
                inputSchema: z.object({
                    filePath: z.string().describe('Path to the file, relative to workspace.'),
                }),
                execute: async ({ filePath }) => {
                    onEvent({ type: 'tool_call', name: 'read_file', arguments: JSON.stringify({ filePath }) });
                    try {
                        const absPath = path.join(workspace, filePath);
                        const content = await fs.promises.readFile(absPath, 'utf-8');
                        onEvent({ type: 'tool_result', name: 'read_file', result: content });
                        return content;
                    } catch (e: any) {
                        const errMsg = `Error reading file: ${e.message}`;
                        onEvent({ type: 'tool_result', name: 'read_file', result: errMsg });
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
                    onEvent({ type: 'tool_call', name: 'write_file', arguments: JSON.stringify({ filePath }) });
                    if (!await requestPermission('write_file', { filePath })) return denied('write_file');
                    try {
                        const absPath = path.join(workspace, filePath);
                        await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
                        await fs.promises.writeFile(absPath, content, 'utf-8');
                        const res = `Successfully wrote to ${filePath}`;
                        onEvent({ type: 'tool_result', name: 'write_file', result: res });
                        return res;
                    } catch (e: any) {
                        const errMsg = `Error writing file: ${e.message}`;
                        onEvent({ type: 'tool_result', name: 'write_file', result: errMsg });
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
                    onEvent({ type: 'tool_call', name: 'edit_file', arguments: JSON.stringify({ filePath }) });
                    if (!await requestPermission('edit_file', { filePath, oldString, newString })) return denied('edit_file');
                    try {
                        const absPath = path.join(workspace, filePath);
                        const content = await fs.promises.readFile(absPath, 'utf-8');
                        const occurrences = content.split(oldString).length - 1;
                        if (occurrences === 0) {
                            const res = 'Error: oldString not found in file. Read the file and use the exact text, including whitespace.';
                            onEvent({ type: 'tool_result', name: 'edit_file', result: res });
                            return res;
                        }
                        if (occurrences > 1) {
                            const res = `Error: oldString matches ${occurrences} locations. Include more surrounding context to make it unique.`;
                            onEvent({ type: 'tool_result', name: 'edit_file', result: res });
                            return res;
                        }
                        await fs.promises.writeFile(absPath, content.replace(oldString, newString), 'utf-8');
                        const res = `Successfully edited ${filePath}`;
                        onEvent({ type: 'tool_result', name: 'edit_file', result: res });
                        return res;
                    } catch (e: any) {
                        const errMsg = `Error editing file: ${e.message}`;
                        onEvent({ type: 'tool_result', name: 'edit_file', result: errMsg });
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
                    onEvent({ type: 'tool_call', name: 'list_dir', arguments: JSON.stringify({ dirPath }) });
                    try {
                        const absPath = path.join(workspace, dirPath);
                        const items = await fs.promises.readdir(absPath);
                        const res = items.length > 0 ? items.join('\n') : 'Directory is empty.';
                        onEvent({ type: 'tool_result', name: 'list_dir', result: res });
                        return res;
                    } catch (e: any) {
                        const errMsg = `Error listing directory: ${e.message}`;
                        onEvent({ type: 'tool_result', name: 'list_dir', result: errMsg });
                        return errMsg;
                    }
                }
            })
        };

        const customOpenAI = createOpenAI({
            apiKey: settings.apiKey,
            baseURL: settings.baseUrl || undefined,
        });

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

        const userMsg = { role: 'user', content: prompt };
        const result = streamText({
            model: customOpenAI.chat(settings.model || 'gpt-4o'),
            system: systemPrompt,
            messages: [...(history ?? []), userMsg],
            tools: tools,
            stopWhen: stepCountIs(10),
        });

        for await (const part of result.fullStream) {
            if (part.type === 'text-delta') {
                onEvent({ type: 'message', content: part.text });
            } else if (part.type === 'error') {
                throw part.error instanceof Error ? part.error : new Error(String(part.error));
            }
        }

        const responseMessages = await result.responseMessages;
        let newHistory = [...(history ?? []), userMsg, ...responseMessages];
        if (newHistory.length > MAX_HISTORY) {
            let cutIndex = newHistory.length - MAX_HISTORY;
            while (cutIndex < newHistory.length && newHistory[cutIndex].role === 'tool') {
                cutIndex++;
            }
            newHistory = newHistory.slice(cutIndex);
        }

        onEvent({ type: 'done', history: newHistory });
    } catch (error: any) {
        onEvent({ type: 'error', content: error.message });
        onEvent({ type: 'done' });
    }
}
