- FSD Restructure + Bug Fixes — moon-agent

## Context

Codebase grew organically (skills panel, MCP, git integration, memory, session persistence all bolted onto a flat `src/main`/`src/renderer` split). Result: `App.tsx` is a 974-LOC hub importing every panel directly (star topology), `agent.ts` is a 654-LOC god-file mixing streaming/tool-routing/compaction, and `main.ts` inlines all IPC registration. No domain/feature boundaries exist, making it harder to reason about ownership as the app grows. User wants (1) bugs/gaps found and fixed, (2) restructure toward Feature-Sliced Design (app→pages→widgets→features→entities→shared, each layer only importing from itself or below), (3) general optimization. Two research agents scanned the repo; findings below are verified against actual code (not just described symptoms).

**Build-system constraint that shapes everything**: `vite.config.ts` bundles only `src/renderer` (aliases safe, Vite rewrites them). `tsconfig.main.json` compiles `src/main`+`src/preload`+`src/shared` with plain `tsc`, Node16 resolution, **no bundler** — path aliases would NOT resolve at runtime there. So: alias the renderer only; keep main-process imports relative.

**Test coupling**: every `test/*.test.js` does `require('../dist/main/xxx.js')` against compiled output. Any main-process file move must update matching test require-paths in the same commit, or tests fail with `MODULE_NOT_FOUND`.

**Bug list re-verified against code** — 2 of 10 originally-flagged bugs don't reproduce (gitService "never rejects" — callers already check `.err` everywhere; memoryStore circular-import guard — `seen.add()` already happens before recursion). Report this honestly rather than manufacturing fixes; downgrade those two to test-coverage/comment additions.

## Target FSD structure

```
src/
  shared/
    lib/        modelLimits.ts, markdownBlocks.ts, renderUiSpec.ts
    types/      skillTypes.ts
    config/     uiCatalog.ts, skillMarketplace.ts

  main/
    main.ts                     # stays at this path (package.json#main points here — do not move)
    app/ipc/
      registerConfigIpc.ts registerSessionsIpc.ts registerSkillsIpc.ts
      registerMcpIpc.ts registerAgentIpc.ts registerGitIpc.ts
      registerMemoryIpc.ts registerWorkspaceIpc.ts registerDialogIpc.ts
    features/
      agent/  historyCompaction.ts toolRouter.ts systemPrompt.ts agentLoop.ts index.ts
      git/gitService.ts   mcp/mcpManager.ts   memory/memoryStore.ts
      skills/skillScanner.ts skillInstaller.ts   sessions/sessionStore.ts
      config/configStore.ts   workspace/workspaceInit.ts
      search/searchTools.ts   diff/diffStats.ts   status/statusLine.ts

  renderer/
    app/        index.tsx, App.tsx (slimmed, composition root <150 LOC), AppShell.tsx
    pages/chat/ ChatPage.tsx
    widgets/    top-bar/, task-sidebar/, right-panel/, overlay-modal/
    features/
      chat-input/RichInput.tsx  tool-chips/ToolChips.tsx  skills-panel/SkillsPanel.tsx
      mcp-panel/McpPanel.tsx  settings-panel/SettingsPanel.tsx  usage-panel/UsagePanel.tsx
      permission-request/PermissionRequest.tsx
      chat-session/  useAgentEvents.ts useSessionPersistence.ts useConfigBootstrap.ts
      git-status/useGitStatus.ts   skills-workspace/useSkillsWorkspace.ts
    entities/
      chat-message/  Markdown.tsx parseAssistantContent.ts AssistantContent.tsx UiWidgetBlock.tsx SpecErrorBoundary
      ui-spec/uiRegistry.tsx
```

Renderer panels have zero sideways imports (verified star topology) — moves there are mechanical. Main process is mostly acyclic; main-process "features" = existing IPC domains.

### Splitting App.tsx (974 LOC)
Current responsibilities (verified): modal state, one giant `onAgentEvent` reducer (lines 207-347), config bootstrap + legacy migration, git status handlers, skills-workspace handlers, session persistence (serialized save-chain), chat send, 4 inline components (`SpecErrorBoundary`, `AssistantContent`, `UiWidgetBlock`, `StatusIndicator`), and the JSX tree.
Split into 5 hooks (`useAgentEvents`, `useConfigBootstrap`, `useSessionPersistence`, `useGitStatus`, `useSkillsWorkspace`) colocated by domain, `ChatPage.tsx` (send logic + message list JSX), `AppShell.tsx` (layout frame + modals), leaving `App.tsx` as a thin composition root.
**Preserve verbatim**: the module-level `configLoadStarted` guard in `useConfigBootstrap` (StrictMode double-invoke protection — if this becomes a `useRef` instead, a fixed duplicate-profile-creation bug will silently reappear) and the session save-chain comments (documents a subtle race fix).
Cross-hook coupling to wire explicitly: `refreshGitRef` and `setInvokedSkills` are touched by `useAgentEvents` — pass them in as params rather than inventing shared state.

### Splitting agent.ts (654 LOC)
Verified function boundaries: `historyCompaction.ts` (sliceHistory/compactHistory/forceCompact), `toolRouter.ts` (makeTools — tool schemas/execution/recursive subagent spawn, the largest and riskiest chunk), `systemPrompt.ts` (loadMemory + prompt template extracted verbatim), `agentLoop.ts` (normalizeUsage/runAgentLoop/handlePrompt — also where bug #3 lands), `index.ts` (re-exports `handlePrompt`/`forceCompact`, keeping the public API identical for `main.ts` and tests).
Risk: `makeTools` recursively calls itself for subagent spawn (line 484) — verify via `test/subagents.test.js` immediately after extraction.

## Bugs — confirmed fixes (do NOT move files while fixing; Stage 2 fixes in place, Stage 3/4 relocates)

| # | Sev | File:line | Fix |
|---|-----|-----------|-----|
| 1 | HIGH | main.ts:259 | `mcpManager.connect(id)` loop not awaited/caught at startup → wrap in `await Promise.allSettled(ids.map(id => mcpManager.connect(id).catch(e => console.error(...))))`, must not block window creation |
| 2 | HIGH | main.ts:324 | `agent:prompt` handler's async `handlePrompt(...)` uncaught → add `.catch()` that emits an `error`+`done` event pair; internal try/catch in handlePrompt stays as defense-in-depth |
| 3 | HIGH | agent.ts:~630 | `statusLine.start()` is sync, not a missing await — real issue: it's constructed/started *before* the `try` block that would `stop()` it on throw → move construction+`start()` to be the first two lines inside that `try` |
| 4 | HIGH | skillInstaller.ts:15-20 | `SPEC_RE` regex lets a bare `.` match `[\w.-]+` as a path segment (e.g. `./evil` passes) → tighten regex so segments can't start with `.`, plus explicit `owner === '.' \|\| owner === '..'` reject; add test cases |
| 5 | HIGH | workspaceInit.ts:36-49 | `findAgentConfigs` follows symlinks in fixed config dirs (e.g. `.cursor/rules/`) that could point outside workspace → info disclosure into LLM prompt via memory import → after `path.join`, `fs.realpathSync` + verify resolved path still starts with `path.resolve(workspace)+sep`; skip entries that escape |
| 6 | MED | main.ts:105-109,134-136,182-187 | TOCTOU: `existsSync` then `mkdirSync` not atomic across 3 call sites → replace with `mkdirSync(dir,{recursive:false})` in try/catch on `err.code==='EEXIST'` |
| 7 | MED→doc-only | gitService.ts:16-25 | Re-verified: `run()` never rejects by design, but every caller already checks `.err` explicitly — not a live bug. Add a comment documenting the contract; no behavior change |
| 8 | MED | main.ts:227-235 | `mcp:upsertServer`: disconnect runs before persist; if persist throws, state desyncs → reorder to persist config first, then disconnect/reconnect |
| 9 | MED→hardening | configStore.ts / sessionStore.ts | All current IPC handlers are fully synchronous end-to-end (confirmed) → no live race today. Add `withLock` promise-chain wrapper (mirrors renderer's own `saveChainRef` pattern) as insurance against a future `await`-before-mutate regression, plus a comment |
| 10 | MED→doc-only | memoryStore.ts:44-57 | Re-verified: `seen.add(abs)` already happens before the recursive call — circular imports already correctly guarded. Add a regression test (A→B→A) to lock in behavior; no fix needed |

Be explicit in the PR/summary that #7 and #10 were re-classified from "bug" to "already correct, added test/doc" — don't manufacture changes to hit a count.

## Staged rollout (each stage: buildable, launchable, tests green — separate commits, don't squash)

- **Stage 0**: baseline — run `npm run build` + `npm test` on current tree, confirm green, record state.
- **Stage 1** (low risk): add Vite `resolve.alias` (`@app @pages @widgets @features @entities @shared`) + matching `tsconfig.json` `paths` for editor support only. Move `src/shared/*` into `lib/types/config` subfolders, update relative imports (keep relative in main, alias comes later for renderer). Verify: `tsc --noEmit`, `npm run build:main`, `npm test` (update `test/markdown-blocks.test.js` + `test/render-ui.test.js` require paths — they hit `dist/shared/*.js` directly), full `npm run build` + manual launch smoke test.
- **Stage 2**: fix bugs #1,2,3,4,5,6,8 in current file locations (no moves yet) — isolates bug-fix diff from restructure diff. Investigate #9 by reading actual IPC handler bodies, apply hardening regardless. Add regression tests for #10, negative tests for #4, comment for #7. Verify: `npm run build:main && npm test`, full build, manual smoke test exercising each fix (MCP auto-connect, chat send, rapid-double skill install, MCP edit-with-bad-config).
- **Stage 3** (highest risk): move+split `src/main/` per the target structure. Split `agent.ts` as its own sub-commit (separate from the other 9 pure-moves) given the recursive `makeTools` call. Create `app/ipc/register*Ipc.ts`, slim `main.ts` to bootstrap+wiring only (main.ts itself stays at `src/main/main.ts` — do NOT move it into `app/`, since `package.json#main` points to `dist/main/main.js` and moving it means updating packaging config for zero FSD benefit). **Update every `test/*.test.js` require path in the same commit** — grep all test files for `require('../dist/main` / `require('../dist/shared` first to get the exhaustive list. Verify: `npm run build:main`, `npm test` (watch for `MODULE_NOT_FOUND`), full build + actual `npm run dev` launch (catches runtime-only resolution breaks that `tsc --noEmit` misses), full IPC-domain smoke test, re-run `test/subagents.test.js` specifically.
- **Stage 4**: move+split `src/renderer/`. Pure-move sub-commit first (11 panel files + entities, mechanical since star topology confirmed, switch `../shared` → `@shared/*`). Second sub-commit: actual `App.tsx` split into hooks/ChatPage/AppShell. Update `index.html`'s `<script src="/index.tsx">` → `/app/index.tsx` in the same commit as moving `index.tsx` — this breaks the dev server/build silently otherwise. Verify: `tsc --noEmit`, `npm run dev:vite` alone (check for alias resolution errors in console), full build + launch + click through every modal/flow, particularly re-testing the `useConfigBootstrap` StrictMode guard, `npm test` as regression check (should be unaffected).
- **Stage 5**: cleanup — confirm no stray root-level files remain, sweep remaining relative imports to aliases in renderer only (cosmetic, single commit), update README with new layout, final full verification pass covering everything above in one sitting.

## Verification (every stage)
1. `npx tsc --noEmit -p tsconfig.json` — renderer/shared type+resolution check.
2. `npm run build:main` — real main-process compile, catches Node16 resolution breaks.
3. `npm test` — must be green; distinguish `MODULE_NOT_FOUND` (stale path) from real regression.
4. `npm run build` (full) — validates Vite alias resolution + electron-builder packaging.
5. Manual `npm run dev` launch + smoke test: workspace open, chat send/stream/tool-call render, skill install (disk/marketplace/URL), MCP connect/disconnect/edit, git snapshot/commit/checkout, session save/switch/delete, memory quick-add.
6. Targeted regression: `test/skill-installer.test.js` (#4), `test/memory-store.test.js` (#10), `test/mcp-manager.test.js`/`test/mcp-agent.test.js` (#1, #8), `test/subagents.test.js` (agent.ts split), `test/git-service.test.js` (#7 unchanged behavior).

## Key risk callouts
- `agent.ts` split (Stage 3) is the single highest-risk step — real code split of a 654-LOC file with a recursive tool-spawn call. Isolate as its own commit, diff extracted files against original to confirm only import/export boundaries changed.
- `App.tsx`/`useConfigBootstrap` split (Stage 4) — the module-level `configLoadStarted` guard must stay module-level, not become a `useRef`, or a fixed duplicate-profile bug resurfaces.
- Do not use this restructure to also strip `@ts-nocheck` from `src/main/*.ts` (nearly all files have it) — separate, much larger effort; keep as-is, just relocated.
- Every main-process/shared file move requires updating every `test/*.test.js` `require('../dist/...')` path in the same commit — treat as a hard checklist item.

## Critical files
- [src/main/main.ts](src/main/main.ts)
- [src/main/agent.ts](src/main/agent.ts)
- [src/renderer/App.tsx](src/renderer/App.tsx)
- [vite.config.ts](vite.config.ts)
- [tsconfig.main.json](tsconfig.main.json)

Here is the plan we have to work on
