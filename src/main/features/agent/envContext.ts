// @ts-nocheck
// Environment-context block for the v2 system-prompt variant (Feature 15 A6).
// Entirely best-effort: git being unavailable, the workspace not being a
// repo, or any other failure just omits the git lines — never throws, never
// blocks a turn on anything beyond a few fast local git invocations.
import * as os from 'os';
import { createGitService } from '../git/gitService';

const RECENT_COMMITS_SHOWN = 5;

export async function buildEnvContext({ workspace, model }: any): Promise<string> {
    const lines = [
        'ENVIRONMENT:',
        `- Workspace: ${workspace}`,
        `- Platform: ${process.platform} ${os.release()}`,
        `- Date: ${new Date().toISOString().slice(0, 10)}`,
        `- Model: ${model}`,
    ];
    try {
        const git = createGitService();
        const snap = await git.snapshot(workspace);
        if (snap.gitAvailable && snap.isRepo && snap.branch) {
            const dirty = snap.files.length;
            lines.push(`- Git branch: ${snap.branch} (${dirty === 0 ? 'clean' : `${dirty} modified/untracked files`})`);
            const commits = await git.recentCommits(workspace, RECENT_COMMITS_SHOWN);
            if (commits.length > 0) {
                lines.push('- Recent commits:');
                for (const c of commits) lines.push(`  ${c}`);
            }
        }
    } catch { /* omit git lines */ }
    return lines.join('\n');
}
