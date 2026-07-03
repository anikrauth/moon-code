# Model Limits Implementation Plan

> Spec: `docs/superpowers/specs/2026-07-03-model-limits-design.md`

**Goal:** Per-model context window drives context meter + compaction threshold; max output tokens enforced; session usage tracked (+cost when pricing known); capability gating; UI = toolbar chip, ≥80% banner, `/usage` + `/context`.

**Verified API (ai@7.0.11):** usage on `finish-step` (`part.usage`) and `finish` (`part.totalUsage`); shape `{inputTokens, outputTokens, totalTokens, inputTokenDetails.{cacheReadTokens,…}}` all optional; `streamText({ maxOutputTokens })`.

## Global constraints

- `// @ts-nocheck` header convention on all source files.
- Context % from LAST `finish-step` usage; `finish.totalUsage` only for session accounting.
- `handlePrompt` new param appended LAST (`usageHint`) — existing tests keep passing untouched signatures.
- All numbers normalized `?? 0` in one place (`norm()` in agent.ts).
- Renderer agent-event listener registers once — functional setState / refs only.
- `npm test` = `tsc -p tsconfig.main.json && node --test test/*.test.js` (dist-based; `src/shared/**` already in tsconfig.main include).

### Task 1: `src/shared/modelLimits.ts` + tests (TDD)
- [ ] `test/model-limits.test.js`: per-family resolution, ordering (gpt-4o-mini ≠ gpt-4o), prefixed ids (`anthropic/claude-3-opus`, `@cf/meta/llama-3-8b-instruct`), unknown → FALLBACK_LIMITS (128k/4096, tools:true, vision:false), overrides win, garbage overrides (0/NaN/negative) ignored.
- [ ] Implement ordered regex table + `resolveLimits(modelId, overrides?)`.
- [ ] `npm test` green. Commit.

### Task 2: profile overrides (configStore + settings form)
- [ ] configStore `upsertProfile`: persist `contextWindow`/`maxOutputTokens` via positive-finite-or-null coercion; `resolveSettings` returns them.
- [ ] config-store tests: round-trip, redacted passthrough, edit-preserves.
- [ ] App.tsx profile form: "Advanced (optional)" number inputs, placeholders = resolved defaults for typed model; seed on edit; coerce on save.
- [ ] `npm test` + `npx tsc --noEmit` green. Commit.

### Task 3: agent.ts — usage capture, maxOutputTokens, window-derived compaction
- [ ] `runAgentLoop`: accept `limits`; pass `maxOutputTokens`; capture `finish-step`/`finish`; emit `usage` event (norm'd, with limits + contextPct); return usage.
- [ ] `compactHistory(history, settings, onEvent, abortSignal, force, limits, lastInputTokens?)`: `reserve = min(maxOut, 25% window)`, `budget = 0.75 × (window − reserve)`, prompt tokens = real lastInputTokens || chars/4 + 4000 overhead. Delete `HISTORY_TOKEN_BUDGET`. Update convergence comment.
- [ ] `handlePrompt(..., usageHint?)`: resolve limits once, thread to compaction + main/subagent loops; `done` event carries `usage`.
- [ ] Fix the two existing huge-message compaction tests (explicit small `contextWindow` in settings).
- [ ] `npm test` green. Commit.

### Task 4: IPC threading
- [ ] main.ts `agent:prompt`: accept 5th `meta` arg → `handlePrompt(..., meta)`.
- [ ] preload `sendPrompt(prompt, workspace, profileId, history, meta)`.
- [ ] `npm test` green. Commit.

### Task 5: renderer — chip, banner, /usage + /context, gating, persistence
- [ ] App.tsx state `sessionUsage` (+ ref mirror) and `contextInfo`; `usage` branch in listener (accumulate all agents; contextInfo from main lastStep); `done` folds usage into session snapshot payload.
- [ ] sessionStore: persist/restore `usage`; restore on session select (estimate fallback), reset on new chat.
- [ ] Send path passes `{ lastInputTokens }` only when not estimated.
- [ ] Extract `compactNow()` from `/compact`; post-compact reset contextInfo to estimate.
- [ ] RichInput: context chip (right of toolbar, `~`-prefixed when estimated, warn ≥70%, danger ≥90%); `capabilities` prop gates MCP button + paperclip with tooltips. CSS `.ri-context-chip`.
- [ ] Banner ≥80% && !isTyping above input with Compact now.
- [ ] `/usage` + `/context` commands (auto-listed in /help).
- [ ] `npx tsc --noEmit && npx vite build` green. Commit.

### Task 6: backend tests for usage/limits
- [ ] fake-openai helper: optional `usage` on chunk + `textChunksWithUsage`.
- [ ] `test/usage.test.js`: normalized usage event + done usage; multi-step total vs lastStep; `max_tokens` override/fallback in request body; missing usage → no crash.
- [ ] compaction tests: window-override trigger/no-trigger; lastInputTokens hint triggers on short history.
- [ ] session-store test: usage round-trip.
- [ ] `npm test` fully green. Commit.

## Risks
1. Providers omitting usage → estimate path must always work (`estimated: true`).
2. Stale lastInputTokens post-compact → renderer resets to estimate, sends undefined.
3. Table drift → overrides are the escape hatch.
4. Renderer once-listener staleness → refs.
