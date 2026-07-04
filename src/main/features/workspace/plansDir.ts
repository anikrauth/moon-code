// @ts-nocheck
// Workspace-local home for implementation plans / design docs the user asked
// the agent to save — sibling to .moon/memory and .moon/skills. Unlike
// .moon/scratch, plans are intentional deliverables, so this is NOT
// gitignored: the user should be able to see and commit them like memory.
import * as fs from 'fs';
import * as path from 'path';

// Idempotent: safe to call every turn. Returns the absolute plans dir path.
export function ensurePlansDir(workspace) {
    const dir = path.join(workspace, '.moon', 'plans');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
