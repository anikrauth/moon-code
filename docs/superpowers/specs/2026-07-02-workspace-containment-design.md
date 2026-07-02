# Workspace Path Containment — Design

Date: 2026-07-02
Status: Approved

## Problem

File tools resolve paths with `path.join(workspace, filePath)`. A relative path with `../` segments (or an absolute path) escapes the workspace: `read_file('../../.ssh/id_rsa')`, `write_file('/tmp/x', ...)`. The model controls these arguments; prompt-injected content can steer them.

## Goal

`read_file`, `write_file`, `edit_file`, `list_dir` refuse any path that resolves outside the selected workspace. Rejected before the permission prompt fires.

## Design

All in `src/main/agent.ts`.

### Helper

```ts
function resolveInWorkspace(workspace, relPath) {
    const root = path.resolve(workspace);
    const abs = path.resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return abs;
}
```

- `path.resolve(root, relPath)` normalizes `..` chains and treats absolute `relPath` as-is, so both escape classes fail the prefix check.
- `abs === root` allows `list_dir('.')`.

### Tool guards

Each of the four file tools replaces its `const absPath = path.join(workspace, ...)` with:

```ts
const absPath = resolveInWorkspace(workspace, filePath /* or dirPath */);
if (!absPath) {
    const errMsg = `Error: path escapes the workspace: ${filePath}`;
    emit({ type: 'tool_result', name: '<tool>', result: errMsg });
    return errMsg;
}
```

Placement:
- `read_file` / `list_dir`: at the top of the existing `try`.
- `write_file` / `edit_file`: BEFORE the `requestPermission` call — a rejected path must not raise a permission dialog.

The error string goes to both the model and the renderer (existing single-artifact pattern; renders amber via the `Error:` prefix).

## Documented limitation (not in scope)

This is a guardrail for the file tools, not a sandbox: `run_command` executes arbitrary shell with the user's privileges and can touch any path; symlinks inside the workspace that point outside are followed. Full isolation (containers, seatbelt) is explicitly out of scope.

## Testing

`test/containment.test.js` (fake-SSE harness, temp workspaces, `t.after` cleanup):

1. `read_file('../escape.txt')` where the file exists one level above → error string; content not returned.
2. `read_file('/etc/hosts')` (absolute) → error string.
3. `write_file('../evil.txt')` → error string; file NOT created outside; NO permission request observed (permission stub records calls).
4. `edit_file('../escape.txt', ...)` → error string; outside file unchanged; no permission request.
5. `list_dir('..')` → error string; `list_dir('.')` still works.
6. Legit inner paths still work: `write_file('nested/dir/file.txt')` creates it; `read_file('a/../inside.txt')` reads a workspace file.
7. Existing 28 tests keep passing.
