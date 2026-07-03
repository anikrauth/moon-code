# Slash Commands + Skills Wiring — Design

Date: 2026-07-02
Status: Approved

## Problems

1. No quick command surface: panel/actions require mouse; no way to force compaction or switch models from the keyboard.
2. Skills are decorative: selections persist (`activeSkillIds` in config) but never reach the agent.

## Design

### 1. Shared skill catalog — `src/shared/skillCatalog.ts`

The mock 10-entry catalog in `SkillsPanel.tsx` is REPLACED by a shared module importable from both renderer and main:

```ts
export const SKILL_CATALOG = [
  { id: 'code-review', name: 'Code Review', category: 'Development',
    description: 'Rigorous review discipline for any code you produce or inspect',
    instructions: 'After writing or modifying code, review it before declaring done: check error handling on every failure path, verify edge cases (empty, null, boundary), and confirm names describe intent. When asked to review code, report findings ordered by severity with file:line references and a concrete fix for each.' },
  { id: 'tdd', name: 'Test-Driven', category: 'Development',
    description: 'Write the failing test before the implementation',
    instructions: 'For every feature or bugfix: write a failing test first, run it to confirm it fails for the expected reason, implement the minimal change to pass, then run the full suite. Never claim work is done without showing test output.' },
  { id: 'debugging', name: 'Systematic Debugging', category: 'Development',
    description: 'Root-cause before fixing',
    instructions: 'When something fails, reproduce it first, read the full error output, and trace the failing value to its origin before proposing any fix. State the root cause explicitly before changing code. Never stack a second fix on an unverified first one.' },
  { id: 'refactor', name: 'Refactoring', category: 'Development',
    description: 'Small, behavior-preserving steps',
    instructions: 'Refactor in small, independently verifiable steps that preserve behavior. Run tests between steps. Never mix refactoring with feature changes in one edit. Preserve public interfaces unless explicitly asked to change them.' },
  { id: 'git-flow', name: 'Git Discipline', category: 'Development',
    description: 'Clean commits, branch hygiene',
    instructions: 'Make small, focused commits with imperative-mood messages describing why, not just what. Check git status and diff before committing. Never commit secrets, build artifacts, or unrelated changes. Work on feature branches, not main, unless told otherwise.' },
  { id: 'docs', name: 'Documentation', category: 'Writing',
    description: 'Document alongside changes',
    instructions: 'When adding or changing functionality, update affected documentation (README, comments explaining non-obvious constraints) in the same change. Write for a reader who has not seen this conversation. Prefer examples over abstract description.' },
  { id: 'planning', name: 'Plan First', category: 'Process',
    description: 'Outline before executing multi-step work',
    instructions: 'For any task needing more than two steps, present a short numbered plan before executing, then follow it, noting deviations. Surface risks and assumptions in the plan rather than discovering them mid-task.' },
  { id: 'concise', name: 'Concise Output', category: 'Process',
    description: 'Terse, high-signal responses',
    instructions: 'Keep responses short: lead with the outcome, cut preamble and restatement, use lists over prose where structure helps. Show only the code that changed, not whole files, unless asked.' },
];
```

`SkillsPanel.tsx` imports from here (its local catalog and `SkillEntry`-with-instructions live here now); ids that were persisted from the old catalog and no longer exist are already silently dropped by the existing restore filter.

### 2. Skills injection (main)

- `main.ts` `agent:prompt`: reads `configStore.getConfig().activeSkillIds`, maps through `SKILL_CATALOG`, builds `skillsText` = `ACTIVE SKILLS — follow these working practices:\n\n<Name>:\n<instructions>\n...` (empty string when none), passes as new trailing param.
- `agent.ts`: `handlePrompt(..., extraTools, skillsText?)` — appended to the system prompt after the MOON.md block. Subagents: `spawnState.skillsText` included in the subagent system prompt the same way.

### 3. Slash command menu (renderer)

- `RichInput` gains `commands: [{name, description, run(arg?)}]` prop. When the input starts with `/`, a popup menu (above the textarea) lists commands whose name starts with the typed prefix (after `/`, up to first space). ↑/↓ move selection, Enter runs the selected command with everything after the first space as `arg` (input cleared, no send), Esc closes (input kept), click runs. Enter falls through to normal send when the menu is closed/no match.
- App registry:

| Command | run |
|---|---|
| `/clear` | `startNewChat()` |
| `/compact` | force compaction (below) |
| `/model <name>` | fuzzy (case-insensitive substring) match against profile names → `setActiveProfile`; no arg or no match → local assistant message listing profile names |
| `/skills` | open skills panel |
| `/sessions` | open sessions panel (refresh list) |
| `/mcp` | open MCP panel (refresh list) |
| `/settings` | open settings modal |
| `/help` | local assistant message listing all commands + descriptions |

- "Local assistant message" = appended to `messages` only (plain text content, no model call, not persisted specially — rides the normal session snapshot).

### 4. `/compact` plumbing

- `agent.ts`: `compactHistory(history, settings, onEvent, abortSignal, force?)` — `force` bypasses the size trigger (still no-ops on empty/short-2 history: requires `history.length > 2`); exported `forceCompact(history, settings, onEvent)` wrapper.
- `main.ts`: `ipcMain.handle('agent:compact', (e, profileId, history))` → resolve settings (null → `{ok:false, error}`), run `forceCompact` with events forwarded to `agent:event` (status messages reuse the existing renderer status line), return `{ok:true, history}`.
- preload: `compactNow(profileId, history)`.
- Renderer `/compact` run: guards (`!isTyping`, active profile with key, `history?.length > 2` else local message explaining); on success: `setHistory(result.history)` + local assistant message `History compacted: N → M messages.`

## Error handling

- `/compact` failure (summarize error) → `forceCompact`'s existing slice fallback still returns history; IPC never rejects (`{ok:false}` on thrown errors) → local message "Compaction failed."
- Unknown `/command` on Enter → falls through as a normal chat message (harmless).

## Testing

- `test/skills-prompt.test.js` (harness): handlePrompt with `skillsText` → system message contains the skill instructions; without → doesn't. Subagent request also carries it (route captures both request bodies).
- `test/force-compact.test.js`: `forceCompact` on a 6-message small history → summarize request fires (force bypasses trigger); summarize 400 → slice fallback returns history, no throw; history of 2 → returned unchanged, no summarize call.
- Renderer menu: convention (tsc + build + manual).

## Out of scope

- Custom user-defined skills; command palette (Cmd+K); command history; args for commands other than `/model`; autocomplete for `/model` arg.
