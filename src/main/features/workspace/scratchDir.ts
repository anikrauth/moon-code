// @ts-nocheck
// Workspace-local scratch space for ad-hoc agent output (scan reports, working
// notes, throwaway scripts) that the user hasn't asked to keep — sibling to
// .moon/memory and .moon/skills, but gitignored so it never gets committed.
import * as fs from 'fs';
import * as path from 'path';

const GITIGNORE_ENTRY = '.moon/scratch/';

// Idempotent: appends `entry` to the workspace .gitignore unless an exact line
// already exists. Shared by scratchDir and workspaceState.
export function ensureGitignoreEntry(workspace, entry) {
    const gitignorePath = path.join(workspace, '.gitignore');
    let existing = '';
    try { existing = fs.readFileSync(gitignorePath, 'utf-8'); } catch { /* no .gitignore yet */ }
    if (existing.split('\n').some((line) => line.trim() === entry)) return;
    const sep = existing.length && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gitignorePath, `${existing}${sep}${entry}\n`, 'utf-8');
}

// Idempotent: safe to call every turn. Returns the absolute scratch dir path.
export function ensureScratchDir(workspace) {
    const dir = path.join(workspace, '.moon', 'scratch');
    fs.mkdirSync(dir, { recursive: true });
    ensureGitignoreEntry(workspace, GITIGNORE_ENTRY);
    return dir;
}
