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
                if (entry.endsWith('.md') && isFile(path.join(workspace, rel))) found.push(rel);
            }
        } else if (isFile(path.join(workspace, source))) {
            found.push(source);
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
