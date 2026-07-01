// @ts-nocheck
import { generateText, tool, stepCountIs } from 'ai';
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

export async function handlePrompt(prompt: string, workspace: string, settings: any, onEvent: (event: any) => void) {
    try {
        const tools = {
            run_command: tool({
                description: 'Execute a bash command in the current workspace.',
                parameters: z.object({
                    command: z.string().describe('The command line string to execute.'),
                }),
                execute: async ({ command }) => {
                    onEvent({ type: 'tool_call', name: 'run_command', arguments: JSON.stringify({ command }) });
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
                parameters: z.object({
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
                description: 'Write content to a file (creates if not exists).',
                parameters: z.object({
                    filePath: z.string().describe('Path to the file, relative to workspace.'),
                    content: z.string().describe('The full content to write into the file.'),
                }),
                execute: async ({ filePath, content }) => {
                    onEvent({ type: 'tool_call', name: 'write_file', arguments: JSON.stringify({ filePath }) });
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
            list_dir: tool({
                description: 'List files and directories in a path.',
                parameters: z.object({
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

        const { text } = await generateText({
            model: customOpenAI.chat(settings.model || 'gpt-4o'),
            system: `You are Moon Agent, an advanced coding agentic IDE for Mac. You have full access to the user's workspace at ${workspace}. You must use tools to accomplish the user's requests autonomously. Do NOT wait for the user if you can figure it out. Answer concisely.`,
            prompt: prompt,
            tools: tools,
            stopWhen: stepCountIs(10),
        });

        onEvent({ type: 'message', content: text });
        onEvent({ type: 'done' });
    } catch (error: any) {
        onEvent({ type: 'error', content: error.message });
        onEvent({ type: 'done' });
    }
}
