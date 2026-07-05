// @ts-nocheck
// Harness-maintained per-workspace session state (.moon/state.json): last
// session id, timestamp, active goal + progress checklist. Written by the main
// process automatically (never by the model) so a fresh session can offer
// resume context. Gitignored like .moon/scratch. Atomic writes like sessionStore.
import * as fs from 'fs';
import * as path from 'path';
import { ensureGitignoreEntry } from './scratchDir';

const STATE_VERSION = 1;
const GITIGNORE_ENTRY = '.moon/state.json';
const RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const stateFile = (workspace) => path.join(workspace, '.moon', 'state.json');

export function loadWorkspaceState(workspace) {
    try {
        const parsed = JSON.parse(fs.readFileSync(stateFile(workspace), 'utf-8'));
        return parsed && parsed.version === STATE_VERSION ? parsed : null;
    } catch { return null; }
}

// Merge-write: fields not in `patch` are preserved (a turn without set_progress
// must not clobber the recorded goal/checklist). progressUpdatedAt only moves
// when the goal/steps themselves change, so staleness tracks the *work*, not
// the last time anyone opened the workspace.
export function saveWorkspaceState(workspace, patch) {
    const existing = loadWorkspaceState(workspace) ?? {};
    const next = {
        version: STATE_VERSION,
        sessionId: null, goal: null, steps: null, lastPrompt: null, progressUpdatedAt: null,
        ...existing, ...patch,
        updatedAt: new Date().toISOString(),
    };
    if (patch.goal !== undefined || patch.steps !== undefined) next.progressUpdatedAt = next.updatedAt;
    const file = stateFile(workspace);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    ensureGitignoreEntry(workspace, GITIGNORE_ENTRY);
    return next;
}

// Text block for the system prompt, or null when there is nothing worth resuming.
export function buildResumeContext(workspace, now = Date.now()) {
    const state = loadWorkspaceState(workspace);
    if (!state?.goal || !state.progressUpdatedAt) return null;
    if (now - Date.parse(state.progressUpdatedAt) > RESUME_MAX_AGE_MS) return null;
    const mark = { done: '[x]', active: '[>]', pending: '[ ]' };
    const lines = [
        `Last session: ${state.sessionId ?? 'unsaved'}, last active ${state.updatedAt}`,
        state.lastPrompt ? `Last user request: "${state.lastPrompt}"` : null,
        `Goal: ${state.goal}`,
        ...(Array.isArray(state.steps) && state.steps.length
            ? ['Checklist:', ...state.steps.map((s) => `- ${mark[s.status] ?? '[ ]'} ${s.text}`)] : []),
    ];
    return lines.filter(Boolean).join('\n');
}
