// @ts-nocheck
// Claude-Code-style memory for Moon Code. Two instruction layers (global
// ~/.moon/MOON.md + project <workspace>/MOON.md) with recursive @imports, plus
// an auto-learned fact store (MEMORY.md index + one <name>.md per fact) that the
// agent recalls across sessions. Modeled on sessionStore.ts (atomic writes) and
// skillScanner.ts (frontmatter parse).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MEMORY_CHAR_LIMIT = 12000;   // per instruction layer, matches agent.ts
const IMPORT_TOTAL_LIMIT = 40000;  // hard cap on total inlined @import bytes
const MAX_IMPORT_DEPTH = 5;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;   // fact / import-safe names
const INDEX_HEADER = '# Memory Index\n\n';
const INDEX_LINE = /^-\s+\*\*([a-z0-9][a-z0-9-]*)\*\*:\s*(.*)$/;

export function createMemoryStore({ homeDir = os.homedir() } = {}) {
    const globalRoot = path.join(homeDir, '.moon');
    const globalInstructionFile = path.join(globalRoot, 'MOON.md');

    const projectInstructionFile = (workspace) => path.join(workspace, 'MOON.md');
    const memoryDir = (scope, workspace) =>
        scope === 'global' ? path.join(globalRoot, 'memory') : path.join(workspace, '.moon', 'memory');
    const indexFile = (scope, workspace) => path.join(memoryDir(scope, workspace), 'MEMORY.md');
    const factFile = (scope, workspace, name) => path.join(memoryDir(scope, workspace), `${name}.md`);

    function atomicWrite(file, data) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, data, 'utf-8');
        fs.renameSync(tmp, file);
    }

    function readText(file) {
        try { return fs.readFileSync(file, 'utf-8'); } catch { return ''; }
    }

    // Replace @path tokens with the referenced file's contents. Recursive with a
    // depth cap, cycle guard (by resolved absolute path), and a total-size cap.
    // A missing file is left as the literal @token (Claude Code behavior).
    // Cycle-safety note (re-verified, not a bug): `seen.add(abs)` below runs
    // *before* the recursive resolveImports() call on that same file's
    // contents, so a circular @import chain (A -> B -> A) is already
    // correctly guarded — the second visit to A hits `seen.has(abs)` and
    // returns the literal token instead of recursing forever.
    function resolveImports(text, baseDir, depth, seen, budget) {
        if (!text || depth > MAX_IMPORT_DEPTH) return text;
        return text.replace(/(^|\s)@([^\s]+)/g, (match, lead, ref) => {
            if (budget.left <= 0) return match;
            let target = ref;
            if (target.startsWith('~/')) target = path.join(homeDir, target.slice(2));
            const lexical = path.isAbsolute(target) ? target : path.resolve(baseDir, target);
            // Key the cycle guard on the realpath: a symlinked alias of an
            // already-imported file must count as the same file, otherwise
            // A -> A-link -> A only stops at the depth cap.
            let abs;
            try { abs = fs.realpathSync(lexical); } catch { return match; }
            if (seen.has(abs)) return match; // cycle
            let content;
            try { content = fs.readFileSync(abs, 'utf-8'); } catch { return match; }
            seen.add(abs);
            content = resolveImports(content, path.dirname(abs), depth + 1, seen, budget);
            const slice = content.slice(0, budget.left);
            budget.left -= slice.length;
            return `${lead}${slice}`;
        });
    }

    function loadInstruction(file, baseDir) {
        const raw = readText(file);
        if (!raw) return '';
        let self;
        try { self = fs.realpathSync(file); } catch { self = path.resolve(file); }
        const resolved = resolveImports(raw, baseDir, 0, new Set([self]), { left: IMPORT_TOTAL_LIMIT });
        return resolved.trim().slice(0, MEMORY_CHAR_LIMIT);
    }

    function listFacts(scope, workspace) {
        const raw = readText(indexFile(scope, workspace));
        const out = [];
        for (const line of raw.split('\n')) {
            const m = INDEX_LINE.exec(line.trim());
            if (m) out.push({ name: m[1], description: m[2].trim(), scope });
        }
        return out;
    }

    function writeIndex(scope, workspace, facts) {
        const body = facts
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((f) => `- **${f.name}**: ${f.description}`)
            .join('\n');
        atomicWrite(indexFile(scope, workspace), `${INDEX_HEADER}${body}\n`);
    }

    return {
        loadInstructions(workspace) {
            return {
                global: loadInstruction(globalInstructionFile, globalRoot),
                project: workspace ? loadInstruction(projectInstructionFile(workspace), workspace) : '',
            };
        },

        buildMemoryCatalog(workspace) {
            return [...listFacts('global', workspace), ...(workspace ? listFacts('project', workspace) : [])];
        },

        listFacts,

        readFact(scope, workspace, name) {
            if (!NAME_RE.test(name)) return null;
            const scopes = scope ? [scope] : ['project', 'global'];
            for (const s of scopes) {
                if (s === 'project' && !workspace) continue;
                const content = readText(factFile(s, workspace, name));
                if (content) return content;
            }
            return null;
        },

        writeFact(scope, workspace, { name, description, body, type }) {
            if (!NAME_RE.test(name)) throw new Error(`invalid memory name "${name}" (use kebab-case)`);
            if (scope === 'project' && !workspace) throw new Error('project memory needs a workspace');
            const content = `---\nname: ${name}\ndescription: ${(description ?? '').replace(/\n/g, ' ')}\ntype: ${type || 'fact'}\nupdated: ${new Date().toISOString()}\n---\n\n${body ?? ''}\n`;
            atomicWrite(factFile(scope, workspace, name), content);
            const facts = listFacts(scope, workspace).filter((f) => f.name !== name);
            facts.push({ name, description: (description ?? '').replace(/\n/g, ' ').trim(), scope });
            writeIndex(scope, workspace, facts);
            return name;
        },

        deleteFact(scope, workspace, name) {
            if (!NAME_RE.test(name)) return null;
            const scopes = scope ? [scope] : ['project', 'global'];
            for (const s of scopes) {
                if (s === 'project' && !workspace) continue;
                const inIndex = listFacts(s, workspace).some((f) => f.name === name);
                let hadFile = false;
                try { fs.unlinkSync(factFile(s, workspace, name)); hadFile = true; } catch { /* no fact file */ }
                // Rewrite the index even when the file was already gone, so a
                // dangling index entry still gets cleaned up.
                if (hadFile || inIndex) {
                    writeIndex(s, workspace, listFacts(s, workspace).filter((f) => f.name !== name));
                    return s;
                }
            }
            return null;
        },

        appendInstruction(scope, workspace, text) {
            const clean = (text ?? '').trim();
            if (!clean) throw new Error('empty memory');
            if (scope === 'project' && !workspace) throw new Error('project memory needs a workspace');
            const file = scope === 'global' ? globalInstructionFile : projectInstructionFile(workspace);
            const existing = readText(file);
            const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
            atomicWrite(file, `${existing}${prefix}- ${clean}\n`);
            return file;
        },

        instructionPath(scope, workspace) {
            return scope === 'global' ? globalInstructionFile : projectInstructionFile(workspace);
        },
    };
}

export const memoryStore = createMemoryStore();
