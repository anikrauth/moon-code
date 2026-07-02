# Grep/Glob Search Tools — Design

Date: 2026-07-02
Status: Approved

## Problem

The agent has no first-class search: finding code means `run_command` with `grep`/`find` — permission-gated, shell-quoting-fragile, unbounded output, and easy to point outside the workspace.

## Goal

`grep_search` and `glob_search` tools: pure-JS, workspace-contained by construction, read-only (no permission prompt), bounded output, ergonomic for the model.

## Design

### 1. `src/main/searchTools.ts` — pure functions (no Electron imports)

Constants:

```ts
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'release', 'coverage', '.superpowers']);
const MAX_MATCHES = 200;
const MAX_LINE_CHARS = 200;
const MAX_FILE_BYTES = 1024 * 1024;   // grep skips bigger files
const BINARY_SNIFF_BYTES = 8192;      // NUL byte in first chunk -> skip
```

- `globToRegex(pattern)` — glob → anchored RegExp: `**/` matches any depth (including zero), `**` any chars incl. `/`, `*` any chars within a segment, `?` one non-`/` char; all other chars regex-escaped. Matching is against `/`-separated relative paths.
- `walkWorkspace(root, subdir = '.')` — iterative/recursive `readdir withFileTypes`; skips entries in `IGNORED_DIRS` and ALL symlinks (escape + cycle safety); returns relative (to root) `/`-separated file paths. Missing subdir → empty result.
- `globSearch({ workspace, pattern })` → string. Walk, filter by `globToRegex(pattern)`, sort by mtime desc, cap `MAX_MATCHES` with `\n[... N more matches not shown]`. No matches → `No files match <pattern>.`
- `grepSearch({ workspace, pattern, path, filePattern, caseSensitive })` → string.
  - Compile `new RegExp(pattern, caseSensitive ? '' : 'i')`; invalid → `Error: invalid regex: <message>`.
  - `path` (default `'.'`) resolved via the same prefix-containment rule as the file tools; escape → `Error: path escapes the workspace: <path>`.
  - Optional `filePattern` filters relative paths via `globToRegex`.
  - Per candidate file: `stat.size > MAX_FILE_BYTES` → skip; NUL byte in first `BINARY_SNIFF_BYTES` → skip.
  - Match lines → `relpath:lineNo: <line.trim() sliced to MAX_LINE_CHARS>`; stop at `MAX_MATCHES`, append `[... additional matches truncated]` if the cap hit.
  - No matches → `No matches found.`

### 2. Tools in `agent.ts` (`makeTools`)

Both read-only — NO `requestPermission` call; standard `emit tool_call` / `emit tool_result` pattern.

- `glob_search`: `inputSchema { pattern: string }` — description: find files by glob pattern (`src/**/*.ts`), newest first; prefer over `run_command find`.
- `grep_search`: `inputSchema { pattern: string, path?: string|null, filePattern?: string|null, caseSensitive?: boolean|null }` (optional fields `.nullable()`, matching read_file's paging params) — description: regex search file contents; results `path:line: text`; prefer over `run_command grep`.

Subagents inherit both (shared `makeTools`).

### 3. Renderer

One-word change: `ToolActivity`'s arg-preview precedence gains `pattern` (`args.command ?? args.filePath ?? args.dirPath ?? args.task ?? args.pattern`). Everything else flows through the existing timeline.

### 4. System prompt

Add one custom rule line: 'Use grep_search and glob_search to find code instead of running grep or find through run_command.'

## Error handling

- Invalid regex / escaping path → error strings to the model (existing single-artifact pattern; renderer ambers on `Error:` prefix).
- FS errors on individual files during a walk are skipped silently (deleted-during-walk races must not fail the search); a top-level failure returns `Error: search failed: <message>`.

## Testing

`test/search-tools.test.js` — direct unit tests on the compiled module (temp fixture trees, `t.after` cleanup):

1. `globToRegex`: `*.ts` doesn't cross `/`; `src/**/*.ts` matches nested; `?` single char; literal dots escaped.
2. `globSearch`: finds nested files; mtime desc order; cap at 200 with marker; no matches message.
3. `grepSearch`: basic match format `path:line: text`; case-insensitive default, `caseSensitive: true` respected; `filePattern` filter; `path` subdir restriction; `../` path → escape error; invalid regex → error string.
4. Ignores: match planted inside `node_modules/` and `.git/` never appears; symlink to an outside dir with a matching file never followed; NUL-byte binary file skipped; >1MB file skipped.
5. Long line trimmed to 200 chars; match cap honored with truncation marker.

Plus 2 harness tests in the same file (fake-SSE): model calls `glob_search` then `grep_search` through `handlePrompt`; assert tool results and that NO `permission_request`-style callback fired (permission stub records calls, must stay empty).

Existing 45 tests keep passing.

## Out of scope

- .gitignore parsing (fixed ignore list only); ripgrep; content-search ranking; multiline regex; search UI.
