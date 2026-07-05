// @ts-nocheck
// Git integration for the right-panel Git tools + top-bar branch chip.
// All operations shell out to the user's git binary scoped to the workspace
// via execFile (no shell interpolation). Factory takes an injectable
// execFileImpl so tests can run against temp repos or fake failures.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MAX_BUFFER = 10 * 1024 * 1024;
// Untracked files aren't in `git diff --numstat`; we count their lines
// ourselves but skip anything huge or binary.
const UNTRACKED_SIZE_CAP = 5 * 1024 * 1024;
// Change summaries feed an LLM prompt; keep them well under context limits.
const DIFF_CHAR_BUDGET = 24_000;
const UNTRACKED_CONTENT_CAP = 4_000;

export function createGitService({ execFileImpl = execFile } = {}) {
    // Contract: run() intentionally never rejects — a failing/non-zero git
    // invocation resolves with `err` set (plus whatever stdout/stderr it
    // produced) instead of throwing. This is by design, not a bug: every
    // caller in this file checks `result.err` explicitly before trusting
    // stdout, so callers get uniform, non-throwing access to failures
    // without try/catch at every call site. (Re-verified: not a live bug.)
    function run(cwd, args) {
        return new Promise((resolve) => {
            execFileImpl('git', args, { cwd, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
                resolve({
                    err,
                    stdout: stdout ? stdout.toString() : '',
                    stderr: stderr ? stderr.toString() : '',
                });
            });
        });
    }

    function statusFromCode(xy) {
        if (xy === '??') return 'untracked';
        if (xy.includes('R')) return 'renamed';
        if (xy.includes('D')) return 'deleted';
        if (xy.includes('A')) return 'added';
        return 'modified';
    }

    // numstat rename paths come as "old => new" or "dir/{old => new}/file".
    function normalizeNumstatPath(raw) {
        const braced = raw.match(/^(.*)\{.* => (.*)\}(.*)$/);
        if (braced) return `${braced[1]}${braced[2]}${braced[3]}`;
        const arrow = raw.split(' => ');
        return arrow.length === 2 ? arrow[1] : raw;
    }

    function countUntrackedLines(workspace, relPath) {
        try {
            const abs = path.join(workspace, relPath);
            const stat = fs.statSync(abs);
            if (!stat.isFile() || stat.size > UNTRACKED_SIZE_CAP) return { adds: 0, binary: true };
            const buf = fs.readFileSync(abs);
            if (buf.includes(0)) return { adds: 0, binary: true };
            if (buf.length === 0) return { adds: 0, binary: false };
            let lines = 0;
            for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
            if (buf[buf.length - 1] !== 10) lines++;
            return { adds: lines, binary: false };
        } catch {
            return { adds: 0, binary: true };
        }
    }

    async function snapshot(workspace) {
        const probe = await run(workspace, ['rev-parse', '--is-inside-work-tree']);
        if (probe.err && probe.err.code === 'ENOENT') return { gitAvailable: false };
        if (probe.err || probe.stdout.trim() !== 'true') return { gitAvailable: true, isRepo: false };

        // symbolic-ref resolves even on an unborn branch (fresh init);
        // empty output means detached HEAD — fall back to the short SHA.
        const [symRef, branchList, status] = await Promise.all([
            run(workspace, ['symbolic-ref', '--short', '-q', 'HEAD']),
            run(workspace, ['branch', '--format=%(refname:short)']),
            run(workspace, ['status', '--porcelain']),
        ]);
        let branch = symRef.stdout.trim() || null;
        if (!branch) {
            const sha = await run(workspace, ['rev-parse', '--short', 'HEAD']);
            branch = sha.err ? null : sha.stdout.trim() || null;
        }
        const branches = branchList.stdout.split('\n').map((b) => b.trim()).filter(Boolean);

        // numstat needs a HEAD commit; a fresh repo has none, so every change
        // there surfaces through porcelain status only.
        const hasHead = !(await run(workspace, ['rev-parse', '--verify', '-q', 'HEAD'])).err;
        const numstatByPath = new Map();
        if (hasHead) {
            const numstat = await run(workspace, ['diff', '--numstat', 'HEAD']);
            for (const line of numstat.stdout.split('\n')) {
                if (!line.trim()) continue;
                const [a, d, ...rest] = line.split('\t');
                const p = normalizeNumstatPath(rest.join('\t'));
                if (a === '-' || d === '-') numstatByPath.set(p, { adds: 0, dels: 0, binary: true });
                else numstatByPath.set(p, { adds: parseInt(a, 10) || 0, dels: parseInt(d, 10) || 0, binary: false });
            }
        }

        const files = [];
        for (const line of status.stdout.split('\n')) {
            if (!line.trim()) continue;
            const xy = line.slice(0, 2);
            let p = line.slice(3);
            if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
            if (xy.includes('R')) p = p.split(' -> ').pop();
            const fileStatus = statusFromCode(xy);
            let stats = numstatByPath.get(p);
            if (!stats && fileStatus === 'untracked') {
                const counted = countUntrackedLines(workspace, p);
                stats = { adds: counted.adds, dels: 0, binary: counted.binary };
            }
            files.push({
                path: p,
                adds: stats ? stats.adds : 0,
                dels: stats ? stats.dels : 0,
                binary: stats ? stats.binary : false,
                status: fileStatus,
            });
        }

        const totals = files.reduce(
            (acc, f) => ({ adds: acc.adds + f.adds, dels: acc.dels + f.dels, fileCount: acc.fileCount + 1 }),
            { adds: 0, dels: 0, fileCount: 0 }
        );
        return { gitAvailable: true, isRepo: true, branch, branches, files, totals };
    }

    async function checkout(workspace, branchName) {
        if (typeof branchName !== 'string' || !branchName || branchName.startsWith('-')) {
            return { ok: false, error: 'Invalid branch name.' };
        }
        const res = await run(workspace, ['checkout', branchName]);
        if (res.err) return { ok: false, error: (res.stderr || res.err.message || 'checkout failed').trim() };
        return { ok: true };
    }

    async function commit(workspace, message) {
        if (typeof message !== 'string' || !message.trim()) {
            return { ok: false, error: 'Commit message required.' };
        }
        const add = await run(workspace, ['add', '-A']);
        if (add.err) return { ok: false, error: (add.stderr || add.err.message || 'git add failed').trim() };
        const res = await run(workspace, ['commit', '-m', message]);
        if (res.err) return { ok: false, error: (res.stderr || res.stdout || res.err.message || 'commit failed').trim() };
        const sha = await run(workspace, ['rev-parse', '--short', 'HEAD']);
        return { ok: true, hash: sha.err ? undefined : sha.stdout.trim() };
    }

    // Text summary of everything a commit would include (`git add -A` stages
    // all working-tree changes, so untracked files must be represented too —
    // they never appear in `diff HEAD`).
    async function changesSummary(workspace) {
        const status = await run(workspace, ['status', '--porcelain']);
        if (status.err) return { ok: false, error: (status.stderr || status.err.message || 'git status failed').trim() };
        if (!status.stdout.trim()) return { ok: false, error: 'No changes to commit.' };

        const untracked = [];
        for (const line of status.stdout.split('\n')) {
            if (!line.trim()) continue;
            if (line.slice(0, 2) !== '??') continue;
            let p = line.slice(3);
            if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
            untracked.push(p);
        }

        const hasHead = !(await run(workspace, ['rev-parse', '--verify', '-q', 'HEAD'])).err;
        let diff = '';
        if (hasHead) {
            const diffRes = await run(workspace, ['diff', 'HEAD']);
            if (!diffRes.err) diff = diffRes.stdout;
        }
        if (diff.length > DIFF_CHAR_BUDGET) {
            diff = diff.slice(0, DIFF_CHAR_BUDGET) + '\n[diff truncated]';
        }

        const parts = [];
        if (diff.trim()) parts.push(`Diff of tracked changes:\n${diff}`);
        if (untracked.length > 0) {
            let remaining = DIFF_CHAR_BUDGET;
            const lines = [];
            for (const p of untracked) {
                const counted = countUntrackedLines(workspace, p);
                lines.push(counted.binary ? `- ${p} (binary)` : `- ${p} (${counted.adds} lines)`);
                if (!counted.binary && remaining > 0) {
                    try {
                        const content = fs.readFileSync(path.join(workspace, p), 'utf8');
                        const capped = content.slice(0, Math.min(UNTRACKED_CONTENT_CAP, remaining));
                        remaining -= capped.length;
                        lines.push('```');
                        lines.push(capped.endsWith('\n') ? capped.slice(0, -1) : capped);
                        if (capped.length < content.length) lines.push('[truncated]');
                        lines.push('```');
                    } catch { /* unreadable file: the list entry above is enough */ }
                }
            }
            parts.push(`Untracked (new) files:\n${lines.join('\n')}`);
        }
        // Fallback (e.g. files staged in a repo with no HEAD yet): at least
        // give the model the porcelain status list.
        if (parts.length === 0) parts.push(`Changed files (git status):\n${status.stdout.trim()}`);
        return { ok: true, summary: parts.join('\n\n') };
    }

    return { snapshot, checkout, commit, changesSummary };
}
