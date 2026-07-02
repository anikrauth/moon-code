# Grep/Glob Search Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First-class `grep_search` and `glob_search` tools — pure JS, workspace-contained, read-only (no permission prompt), bounded output.

**Architecture:** New `src/main/searchTools.ts` (pure functions, no Electron imports) + two tool registrations in `agent.ts`'s `makeTools` + one-word renderer preview addition + a system-prompt sentence.

**Tech Stack:** node:test; `npm test` currently 45 passing → 55 after.

## Global Constraints

- Constants exact: `IGNORED_DIRS = {node_modules, .git, dist, release, coverage, .superpowers}`, `MAX_MATCHES = 200`, `MAX_LINE_CHARS = 200`, `MAX_FILE_BYTES = 1048576`, `BINARY_SNIFF_BYTES = 8192`.
- Symlinks NEVER followed (files or dirs). Walk yields `/`-separated workspace-relative paths.
- Messages exact: `No files match <pattern>.`, `No matches found.`, `Error: invalid regex: <msg>`, `Error: path escapes the workspace: <path>`, `Error: search failed: <msg>`, glob cap marker `[... N more matches not shown]`, grep cap marker `[... additional matches truncated]`.
- Grep line format: `<relpath>:<lineNo>: <line.trim() sliced to 200>`; lineNo 1-based.
- No `requestPermission` call in either tool (read-only).
- `// @ts-nocheck` kept; nullable+optional schema style for optional params (matches read_file's paging params).

---

### Task 1: `searchTools` module + unit tests (TDD)

**Files:**
- Create: `src/main/searchTools.ts`
- Test: `test/search-tools.test.js` (unit tests portion)

**Interfaces:**
- Produces: `globToRegex(pattern) -> RegExp`, `globSearch({workspace, pattern}) -> string`, `grepSearch({workspace, pattern, path?, filePattern?, caseSensitive?}) -> string`. Task 2 consumes the latter two.

- [ ] **Step 1: Write failing tests**

```js
// test/search-tools.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { globToRegex, globSearch, grepSearch } = require('../dist/main/searchTools.js');

function fixture(t, files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-search-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return ws;
}

test('globToRegex semantics', () => {
  assert.ok(globToRegex('*.ts').test('a.ts'));
  assert.ok(!globToRegex('*.ts').test('src/a.ts'));       // * does not cross /
  assert.ok(globToRegex('src/**/*.ts').test('src/a.ts')); // ** matches zero depth
  assert.ok(globToRegex('src/**/*.ts').test('src/x/y/a.ts'));
  assert.ok(globToRegex('a?.js').test('ab.js'));
  assert.ok(!globToRegex('a?.js').test('a/x.js'));
  assert.ok(!globToRegex('a.ts').test('axts'));            // dot is literal
});

test('globSearch finds nested files newest-first and reports none', (t) => {
  const ws = fixture(t, { 'src/a.ts': '', 'src/deep/b.ts': '', 'c.js': '' });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(ws, 'src/a.ts'), old, old);
  const out = globSearch({ workspace: ws, pattern: 'src/**/*.ts' });
  assert.deepStrictEqual(out.split('\n'), ['src/deep/b.ts', 'src/a.ts']); // newest first
  assert.strictEqual(globSearch({ workspace: ws, pattern: '*.py' }), 'No files match *.py.');
});

test('globSearch caps at 200 with marker', (t) => {
  const files = {};
  for (let i = 0; i < 210; i++) files[`f${String(i).padStart(3, '0')}.txt`] = '';
  const ws = fixture(t, files);
  const out = globSearch({ workspace: ws, pattern: '*.txt' });
  const lines = out.split('\n');
  assert.strictEqual(lines.length, 201);
  assert.match(lines[200], /^\[\.\.\. 10 more matches not shown\]$/);
});

test('grepSearch match format, case handling, filePattern, subdir path', (t) => {
  const ws = fixture(t, {
    'src/app.ts': 'const Foo = 1;\nconst bar = 2;\n',
    'src/lib/util.ts': 'export function foo() {}\n',
    'docs/readme.md': 'foo in docs\n',
  });
  const all = grepSearch({ workspace: ws, pattern: 'foo' });
  assert.ok(all.includes('src/app.ts:1: const Foo = 1;'));       // case-insensitive default
  assert.ok(all.includes('src/lib/util.ts:1: export function foo() {}'));
  assert.ok(all.includes('docs/readme.md:1: foo in docs'));
  const cs = grepSearch({ workspace: ws, pattern: 'foo', caseSensitive: true });
  assert.ok(!cs.includes('src/app.ts:1:'));
  const filtered = grepSearch({ workspace: ws, pattern: 'foo', filePattern: '**/*.ts' });
  assert.ok(!filtered.includes('docs/readme.md'));
  const scoped = grepSearch({ workspace: ws, pattern: 'foo', path: 'docs' });
  assert.strictEqual(scoped, 'docs/readme.md:1: foo in docs');
});

test('grepSearch error strings', (t) => {
  const ws = fixture(t, { 'a.txt': 'x' });
  assert.match(grepSearch({ workspace: ws, pattern: '(' }), /^Error: invalid regex: /);
  assert.strictEqual(grepSearch({ workspace: ws, pattern: 'x', path: '../outside' }), 'Error: path escapes the workspace: ../outside');
  assert.strictEqual(grepSearch({ workspace: ws, pattern: 'zzz-nothing' }), 'No matches found.');
});

test('ignored dirs, symlinks, binary, oversize are skipped', (t) => {
  const ws = fixture(t, {
    'node_modules/pkg/index.js': 'NEEDLE\n',
    '.git/config': 'NEEDLE\n',
    'src/real.js': 'NEEDLE\n',
  });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.js'), 'NEEDLE\n');
  fs.symlinkSync(outside, path.join(ws, 'linked'));
  fs.writeFileSync(path.join(ws, 'blob.bin'), Buffer.concat([Buffer.from('NEEDLE'), Buffer.from([0]), Buffer.from('x')]));
  fs.writeFileSync(path.join(ws, 'huge.txt'), 'NEEDLE\n' + 'x'.repeat(1024 * 1024 + 10));
  const out = grepSearch({ workspace: ws, pattern: 'NEEDLE' });
  assert.strictEqual(out, 'src/real.js:1: NEEDLE');
  const globOut = globSearch({ workspace: ws, pattern: '**/*.js' });
  assert.ok(!globOut.includes('node_modules'));
  assert.ok(!globOut.includes('linked'));
});

test('grepSearch trims long lines and caps matches', (t) => {
  const ws = fixture(t, {
    'long.txt': '  ' + 'y'.repeat(500) + 'NEEDLE\n',
    'many.txt': Array.from({ length: 250 }, (_, i) => `NEEDLE ${i}`).join('\n'),
  });
  const out = grepSearch({ workspace: ws, pattern: 'NEEDLE' });
  const longLine = out.split('\n').find((l) => l.startsWith('long.txt'));
  assert.ok(longLine.length <= 'long.txt:1: '.length + 200);
  const matchLines = out.split('\n').filter((l) => /:\d+: /.test(l));
  assert.strictEqual(matchLines.length, 200);
  assert.match(out, /\[\.\.\. additional matches truncated\]$/);
});
```

- [ ] **Step 2: Run to verify failure** — `npm test`: `Cannot find module '../dist/main/searchTools.js'`.

- [ ] **Step 3: Implement `src/main/searchTools.ts`**

```ts
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
                results.push(path.relative(rootAbs, abs).split(path.sep).join('/'));
            }
        }
    }
    walk(startAbs);
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
```

- [ ] **Step 4: Run to verify pass** — `npm test`: 53/53 (45 existing + 8 new).

- [ ] **Step 5: Commit**

```bash
git add src/main/searchTools.ts test/search-tools.test.js
git commit -m "feat: pure-JS grep/glob search functions with workspace containment"
```

---

### Task 2: Tool registration + harness tests + preview + prompt hint

**Files:**
- Modify: `src/main/agent.ts`
- Modify: `src/renderer/App.tsx` (one expression)
- Test: `test/search-tools.test.js` (append harness tests)

**Interfaces:**
- Consumes: `globSearch`/`grepSearch` from Task 1; harness helpers; `handlePrompt`.
- Produces: `glob_search` / `grep_search` tools available to main agent AND subagents.

- [ ] **Step 1: Append failing harness tests**

```js
// appended to test/search-tools.test.js
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

async function runTool(t, workspace, call, permCalls) {
  const server = await startServer((body) =>
    body.messages.some((m) => m.role === 'tool')
      ? textChunks('done')
      : [toolCallChunk(call.name, call.args), chunk({}, 'tool_calls')]);
  t.after(() => server.close());
  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', workspace, { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); },
      async (name) => { permCalls.push(name); return true; });
  });
  return events.find((e) => e.type === 'tool_result' && e.name === call.name).result;
}

test('glob_search tool: end-to-end, no permission prompt', async (t) => {
  const ws = fixture(t, { 'src/target.ts': '', 'other.md': '' });
  const permCalls = [];
  const result = await runTool(t, ws, { name: 'glob_search', args: { pattern: '**/*.ts' } }, permCalls);
  assert.strictEqual(result, 'src/target.ts');
  assert.deepStrictEqual(permCalls, []);
});

test('grep_search tool: end-to-end, no permission prompt', async (t) => {
  const ws = fixture(t, { 'src/app.ts': 'const needle = 42;\n' });
  const permCalls = [];
  const result = await runTool(t, ws, { name: 'grep_search', args: { pattern: 'needle' } }, permCalls);
  assert.strictEqual(result, 'src/app.ts:1: const needle = 42;');
  assert.deepStrictEqual(permCalls, []);
});
```

- [ ] **Step 2: Run to verify failure** — new tests FAIL (unknown tool `glob_search`).

- [ ] **Step 3: Register the tools in `agent.ts`**

Import: `import { globSearch, grepSearch } from './searchTools';`

Inside `makeTools`, after `list_dir` (before the `includeSpawn` block):

```ts
        glob_search: tool({
            description: 'Find files by glob pattern (e.g. "src/**/*.ts") matched against workspace-relative paths, newest first. Prefer this over run_command with find.',
            inputSchema: z.object({
                pattern: z.string().describe('Glob pattern. Supports **, *, and ?.'),
            }),
            execute: async ({ pattern }) => {
                emit({ type: 'tool_call', name: 'glob_search', arguments: JSON.stringify({ pattern }) });
                const res = globSearch({ workspace, pattern });
                emit({ type: 'tool_result', name: 'glob_search', result: res });
                return res;
            }
        }),
        grep_search: tool({
            description: 'Search file contents with a regular expression. Returns matches as "path:line: text". Prefer this over run_command with grep.',
            inputSchema: z.object({
                pattern: z.string().describe('Regular expression to search for. Case-insensitive unless caseSensitive is true.'),
                path: z.string().nullable().optional().describe('Directory to search, relative to workspace. Default ".".'),
                filePattern: z.string().nullable().optional().describe('Glob filter for file paths, e.g. "**/*.ts".'),
                caseSensitive: z.boolean().nullable().optional().describe('Match case exactly. Default false.'),
            }),
            execute: async ({ pattern, path: searchPath, filePattern, caseSensitive }) => {
                emit({ type: 'tool_call', name: 'grep_search', arguments: JSON.stringify({ pattern, path: searchPath, filePattern }) });
                const res = grepSearch({
                    workspace, pattern,
                    path: searchPath ?? undefined,
                    filePattern: filePattern ?? undefined,
                    caseSensitive: !!caseSensitive,
                });
                emit({ type: 'tool_result', name: 'grep_search', result: res });
                return res;
            }
        }),
```

System prompt: in `handlePrompt`'s template, extend the first paragraph's last sentence: `Answer concisely. Use grep_search and glob_search to find code instead of running grep or find through run_command.`

- [ ] **Step 4: Renderer preview**

`App.tsx` `ToolActivity`: `preview = args.command ?? args.filePath ?? args.dirPath ?? args.task ?? args.pattern ?? '';`

- [ ] **Step 5: Verify** — `npm test && npx tsc --noEmit && npx vite build` → 55/55, clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent.ts src/renderer/App.tsx test/search-tools.test.js
git commit -m "feat: register grep_search and glob_search agent tools"
```
