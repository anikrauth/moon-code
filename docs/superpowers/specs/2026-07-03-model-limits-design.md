# Model Limits (context window, output caps, usage, capabilities) — Design

Date: 2026-07-03
Status: Approved

## Problem

- Compaction threshold is hardcoded (`HISTORY_TOKEN_BUDGET = 40000`, chars/4 estimate) in `src/main/agent.ts` — identical for an 8k llama and a 1M gpt-4.1.
- Real token usage from API responses is never read; the app has no idea how full the context window is.
- No max-output-tokens cap is sent per model.
- No UI: no context indicator, no near-limit warning, no `/usage`.
- No per-model capability knowledge (tool calling, vision) — UI offers features some models can't do.

## Goal

Claude Code-style model limits: per-model context window drives a visible context meter and the auto-compaction threshold; per-model max output tokens are enforced; session token usage (and cost where pricing is known) is tracked; unsupported UI affordances are gated. Surfaces: persistent chip in the input toolbar, warning banner ≥80%, `/usage` + `/context` slash commands.

## Pinned API facts (verified against installed ai@7.0.11 types)

- `LanguageModelUsage = { inputTokens, inputTokenDetails: { noCacheTokens, cacheReadTokens, cacheWriteTokens }, outputTokens, outputTokenDetails: { textTokens, reasoningTokens }, totalTokens }` — all `number | undefined`. No top-level `cachedInputTokens`; cached input is `inputTokenDetails.cacheReadTokens`.
- `fullStream` emits `{ type: 'finish-step', usage }` per model call and `{ type: 'finish', totalUsage }` summed across steps.
- `streamText` accepts `maxOutputTokens`. `@ai-sdk/openai` sends `stream_options: {include_usage: true}` and maps `prompt_tokens_details.cached_tokens → cacheReadTokens`.
- Context fullness must come from the **last `finish-step`** usage (prompt size of the final call), not `finish.totalUsage` (sums input across tool-loop steps — overcounts vs the window). Total usage drives session accounting only.

## Architecture

### 1. `src/shared/modelLimits.ts` (new, shared main + renderer)

```ts
type ModelLimits = {
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: { tools: boolean; vision: boolean };
  pricing?: { inPerMTok: number; outPerMTok: number; cachedInPerMTok?: number };
};
export const FALLBACK_LIMITS: ModelLimits; // 128000 / 4096, tools:true, vision:false
export function resolveLimits(modelId?, overrides?: { contextWindow?; maxOutputTokens? }): ModelLimits;
```

Ordered `{ match: RegExp, limits }` array, first match wins, matched against lowercased model id (substring — provider-prefixed ids like `anthropic/claude-3-opus` hit). Specific before general (gpt-4o-mini before gpt-4o, llama-3.1 before llama-3…). Families: gpt-4o/4o-mini, gpt-4.1, o3/o4, gpt-4-turbo/4, claude 3/3.5/3.7/4, glm-4/glm-4v, deepseek chat/r1, llama-3 vs 3.1+, gemini 1.5/2.x, qwen. Pricing only where confident (OpenAI, Anthropic, DeepSeek) — cost display is conditional on it. Overrides win when positive finite numbers.

### 2. Profile overrides

Profiles gain optional `contextWindow`, `maxOutputTokens` (not secret — pass through `getRedacted` untouched). `resolveSettings` returns them alongside apiKey/model/baseUrl, so `resolveLimits(settings.model, settings)` works directly. Settings form gets an "Advanced (optional)" pair of number inputs with resolved defaults as placeholders. Escape hatch for table drift and unknown models.

### 3. agent.ts

- `runAgentLoop` gains `limits`: passes `maxOutputTokens` to `streamText`; captures `finish-step` (last step) and `finish` (total) usage; emits per turn:
  `{ type: 'usage', agent, usage, lastStep, limits: { contextWindow, maxOutputTokens }, contextPct }` with numbers normalized (`?? 0`, cacheReadTokens → cachedInputTokens). Emitted for subagents too (session accounting); renderer keys context % off `agent === 'main'`.
- `compactHistory` threshold derived from limits: `reserve = min(maxOutputTokens, 25% window)`, `budget = 0.75 × (contextWindow − reserve)`; prompt tokens = real `lastInputTokens` (from previous turn, passed via usage hint) when available, else `chars/4 + 4000` system-overhead estimate. `MAX_HISTORY` count trigger unchanged; fixed 40k budget deleted. Convergence: cut floor `Math.max(2, …)` unchanged; `lastInputTokens` consulted only for the trigger, never re-checked post-compaction within a turn — cannot loop.
- `handlePrompt` gains trailing `usageHint?: { lastInputTokens?: number }` (appended last — existing call sites/tests unaffected); `done` event carries `usage` for session persistence.

### 4. IPC

`agent:prompt` and preload `sendPrompt` gain trailing `meta` arg (`{ lastInputTokens? }`). New `usage` event flows over existing `agent:event` channel. `agent:compact` unchanged.

### 5. Renderer

- State: `sessionUsage` (cumulative in/out/cached, turns) + `contextInfo` (last-turn tokens, limits, pct, `estimated` flag). Once-registered listener → functional updates + `sessionUsageRef` mirror (same pattern as `sessionSnapshotRef`).
- Context chip in RichInput toolbar right (`▮ 37% · 74k/200k`), color: secondary → warning ≥70% → danger ≥90%. Falls back to chars/4 estimate (`estimated: true`, shown with `~`) when provider reports no usage.
- Warning banner above input at ≥80% (not while typing): "Context NN% full…" + **Compact now** button calling the extracted `compactNow()` (shared with `/compact`); post-compaction contextInfo resets to estimate so the banner clears and stale real tokens can't re-trigger compaction.
- `/usage`: local note — model + resolved limits (override marker), context used, last-turn in/out/cached, session cumulative, est. cost when pricing known. `/context`: context-focused subset.
- Capability gating: `!capabilities.tools` → MCP button disabled with tooltip; `!capabilities.vision` → paperclip disabled with tooltip (attach is a placeholder today — disable only).
- Sessions: `usage` field added to session snapshot (sessionStore destructure) and restored on select; reset on new chat.

## Degradation

Third-party OpenAI-compat endpoints (GLM, Cloudflare, OpenRouter) may omit streaming usage or `prompt_tokens_details`: everything falls back to the chars/4 estimate path, indicator shows `~`, compaction uses estimates — never blocks a turn.

## Testing

node:test against compiled dist, reusing the fake OpenAI SSE harness:

- `test/model-limits.test.js`: table resolution per family, ordering, provider-prefixed ids, fallback, override precedence, garbage-override rejection.
- `test/usage.test.js`: usage chunk → one `usage` event (normalized fields, cached tokens, contextPct, limits), `done` carries usage; multi-step tool turn — total sums steps, lastStep is final call only; `max_tokens` present in request (override + fallback); provider omits usage → no crash.
- `test/compaction.test.js`: threshold now window-derived (existing huge-message tests updated with explicit small `contextWindow`); real `lastInputTokens` hint over budget triggers compaction on short history; huge window doesn't compact.
- `test/config-store.test.js`: overrides round-trip upsert → redacted → resolveSettings; edit preserves.
- `test/session-store.test.js`: usage round-trips.

## Out of scope

- Provider rate-limit / quota headers (429 budget windows).
- Building real file-attach/vision input.
- Live token counting mid-stream (indicator updates per turn).
- Editable pricing/limits catalog UI beyond the two profile override fields.
