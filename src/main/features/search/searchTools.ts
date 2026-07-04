// @ts-nocheck
import * as fs from 'fs';
import * as path from 'path';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'release', 'coverage', '.superpowers']);
const MAX_MATCHES = 200;
const MAX_LINE_CHARS = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

export function globToRegex(pattern) {
    let re = '';
    let i = 0;
    while (i < pattern.length) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 3; }
                else { re += '.*'; i += 2; }
            } else {
                re += '[^/]*'; i += 1;
            }
        } else if (c === '?') {
            re += '[^/]'; i += 1;
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&'); i += 1;
        }
    }
    return new RegExp(`^${re}$`);
}

// Returns workspace-relative '/'-separated file paths under subdir,
// or null when subdir escapes the workspace. Symlinks are never followed.
function walkWorkspace(root, subdir = '.') {
    const rootAbs = path.resolve(root);
    const startAbs = path.resolve(rootAbs, subdir);
    if (startAbs !== rootAbs && !startAbs.startsWith(rootAbs + path.sep)) return null;
    let realRoot, realStart;
    try {
        realRoot = fs.realpathSync(rootAbs);
        realStart = fs.realpathSync(startAbs);
    } catch {
        return []; // start doesn't exist -> nothing to search
    }
    if (realStart !== realRoot && !realStart.startsWith(realRoot + path.sep)) return null;
    const results = [];
    function walk(dirAbs) {
        let entries;
        try {
            entries = fs.readdirSync(dirAbs, { withFileTypes: true });
        } catch {
            return; // unreadable/missing dir: contribute nothing
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const abs = path.join(dirAbs, entry.name);
            if (entry.isDirectory()) {
                if (IGNORED_DIRS.has(entry.name)) continue;
                walk(abs);
            } else if (entry.isFile()) {
                results.push(path.relative(realRoot, abs).split(path.sep).join('/'));
            }
        }
    }
    walk(realStart);
    return results;
}

export function globSearch({ workspace, pattern }) {
    try {
        const regex = globToRegex(pattern);
        const matches = (walkWorkspace(workspace) ?? []).filter((f) => regex.test(f));
        if (matches.length === 0) return `No files match ${pattern}.`;
        const withTimes = matches.map((f) => {
            let mtime = 0;
            try { mtime = fs.statSync(path.join(workspace, f)).mtimeMs; } catch { /* raced delete */ }
            return { f, mtime };
        });
        withTimes.sort((a, b) => b.mtime - a.mtime);
        let out = withTimes.slice(0, MAX_MATCHES).map((x) => x.f).join('\n');
        if (withTimes.length > MAX_MATCHES) out += `\n[... ${withTimes.length - MAX_MATCHES} more matches not shown]`;
        return out;
    } catch (e) {
        return `Error: search failed: ${e.message}`;
    }
}

export function grepSearch({ workspace, pattern, path: searchPath, filePattern, caseSensitive }) {
    let regex;
    try {
        regex = new RegExp(pattern, caseSensitive ? '' : 'i');
    } catch (e) {
        return `Error: invalid regex: ${e.message}`;
    }
    try {
        const files = walkWorkspace(workspace, searchPath ?? '.');
        if (files === null) return `Error: path escapes the workspace: ${searchPath}`;
        const fileRegex = filePattern ? globToRegex(filePattern) : null;
        const lines = [];
        let truncated = false;
        outer: for (const rel of files) {
            if (fileRegex && !fileRegex.test(rel)) continue;
            const abs = path.join(workspace, rel);
            let stat;
            try { stat = fs.statSync(abs); } catch { continue; }
            if (stat.size > MAX_FILE_BYTES) continue;
            let content;
            try { content = fs.readFileSync(abs); } catch { continue; }
            if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue;
            const fileLines = content.toString('utf-8').split('\n');
            for (let n = 0; n < fileLines.length; n++) {
                if (regex.test(fileLines[n])) {
                    lines.push(`${rel}:${n + 1}: ${fileLines[n].trim().slice(0, MAX_LINE_CHARS)}`);
                    if (lines.length >= MAX_MATCHES) { truncated = true; break outer; }
                }
            }
        }
        if (lines.length === 0) return 'No matches found.';
        return lines.join('\n') + (truncated ? '\n[... additional matches truncated]' : '');
    } catch (e) {
        return `Error: search failed: ${e.message}`;
    }
}
