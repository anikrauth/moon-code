// @ts-nocheck
// First-open bootstrap for a workspace. When the user selects a workspace that
// has no .moon folder yet, create the folder with its necessary files and seed
// the project instruction file (<workspace>/MOON.md) with @import references to
// any coding-agent configs already in the repo (CLAUDE.md, AGENTS.md,
// .cursorrules, ...). memoryStore.ts inlines those @tokens at prompt time, so
// the references stay in sync with their source files instead of copying them.
import * as fs from 'fs';
import * as path from 'path';

const INDEX_HEADER = '# Memory Index\n\n'; // matches memoryStore.ts

// Relative paths probed inside the workspace, in the order they should appear
// in MOON.md. Entries ending in '/' are directories scanned for *.md files.
const AGENT_CONFIG_SOURCES = [
    'CLAUDE.md',
    '.claude/CLAUDE.md',
    'AGENTS.md',
    'GEMINI.md',
    '.cursorrules',
    '.cursor/rules/',
    '.windsurfrules',
    '.github/copilot-instructions.md',
    '.commandcode/taste/taste.md',
];

function isFile(p) {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Resolve symlinks and verify the real path still lives inside the workspace.
// Fixed config dirs like .cursor/rules/ can contain a symlink pointing outside
// the workspace (e.g. to ~/.ssh or another project) — following it would leak
// arbitrary filesystem contents into the LLM prompt via the @import mechanism.
// Returns null for anything that escapes (or doesn't resolve at all).
function realPathWithinWorkspace(workspace, absPath) {
    let real;
    let root;
    try {
        real = fs.realpathSync(absPath);
        // Resolve the workspace root itself too: on macOS the system temp dir
        // (and other paths) live under a symlink (/var -> /private/var), so
        // comparing a realpath'd file against a merely path.resolve'd root
        // would spuriously reject every legitimate file in the workspace.
        root = fs.realpathSync(workspace);
    } catch { return null; }
    if (real !== root && !real.startsWith(root + path.sep)) return null;
    return real;
}

function atomicWrite(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, file);
}

// Find existing agent-config files in the workspace, as relative paths.
function findAgentConfigs(workspace) {
    const found = [];
    for (const source of AGENT_CONFIG_SOURCES) {
        if (source.endsWith('/')) {
            let entries;
            try { entries = fs.readdirSync(path.join(workspace, source)); } catch { continue; }
            for (const entry of entries.sort()) {
                const rel = source + entry;
                const abs = path.join(workspace, rel);
                if (entry.endsWith('.md') && isFile(abs) && realPathWithinWorkspace(workspace, abs)) found.push(rel);
            }
        } else {
            const abs = path.join(workspace, source);
            if (isFile(abs) && realPathWithinWorkspace(workspace, abs)) found.push(source);
        }
    }
    return found;
}

function moonMdContent(sources) {
    const lines = [
        '# MOON.md',
        '',
        '<!-- Project instructions for Moon Code. @path lines below are inlined',
        '     at prompt time from the referenced files (see memoryStore.ts). -->',
        '',
    ];
    if (sources.length) {
        lines.push('## Imported agent configs', '');
        for (const rel of sources) lines.push(`@${rel}`);
        lines.push('');
    }
    return lines.join('\n');
}

// Idempotent: a workspace with an existing .moon folder is left untouched.
export function initWorkspace(workspace) {
    if (!workspace) return { created: false, sources: [] };
    const moonDir = path.join(workspace, '.moon');
    if (fs.existsSync(moonDir)) return { created: false, sources: [] };

    const sources = findAgentConfigs(workspace);

    fs.mkdirSync(path.join(moonDir, 'skills'), { recursive: true });
    atomicWrite(path.join(moonDir, 'memory', 'MEMORY.md'), INDEX_HEADER);

    const moonMd = path.join(workspace, 'MOON.md');
    if (!fs.existsSync(moonMd)) {
        atomicWrite(moonMd, moonMdContent(sources));
    }

    return { created: true, sources };
}
