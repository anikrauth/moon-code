const test = require('node:test');
const assert = require('node:assert');
const { resolveLimits, FALLBACK_LIMITS } = require('../dist/shared/modelLimits.js');

test('fallback for unknown model and missing id', () => {
    assert.deepStrictEqual(resolveLimits('totally-unknown-model'), FALLBACK_LIMITS);
    assert.deepStrictEqual(resolveLimits(undefined), FALLBACK_LIMITS);
    assert.strictEqual(FALLBACK_LIMITS.contextWindow, 128000);
    assert.strictEqual(FALLBACK_LIMITS.maxOutputTokens, 4096);
    assert.strictEqual(FALLBACK_LIMITS.capabilities.tools, true);
    assert.strictEqual(FALLBACK_LIMITS.capabilities.vision, false);
});

test('specific ids win over general ones (ordering)', () => {
    const mini = resolveLimits('gpt-4o-mini');
    const full = resolveLimits('gpt-4o');
    assert.notStrictEqual(mini.pricing?.inPerMTok, full.pricing?.inPerMTok);
    assert.strictEqual(mini.contextWindow, 128000);
    assert.strictEqual(full.contextWindow, 128000);
    // llama-3.1 gets 128k, plain llama-3 stays at 8k
    assert.strictEqual(resolveLimits('llama-3.1-70b-instruct').contextWindow, 128000);
    assert.strictEqual(resolveLimits('llama-3-8b-instruct').contextWindow, 8192);
});

test('per-family resolution', () => {
    assert.strictEqual(resolveLimits('gpt-4.1').contextWindow, 1000000);
    assert.strictEqual(resolveLimits('o3-mini').contextWindow, 200000);
    assert.strictEqual(resolveLimits('claude-3-opus-20240229').contextWindow, 200000);
    assert.strictEqual(resolveLimits('claude-3-5-sonnet-20241022').maxOutputTokens, 8192);
    assert.strictEqual(resolveLimits('claude-sonnet-4-20250514').maxOutputTokens, 64000);
    assert.strictEqual(resolveLimits('glm-4-plus').contextWindow, 128000);
    assert.strictEqual(resolveLimits('deepseek-chat').contextWindow, 65536);
    assert.strictEqual(resolveLimits('gemini-1.5-pro').contextWindow, 1000000);
    assert.strictEqual(resolveLimits('qwen2.5-72b-instruct').contextWindow, 32768);
});

test('provider-prefixed ids match (openrouter / cloudflare style)', () => {
    assert.strictEqual(resolveLimits('anthropic/claude-3-opus').contextWindow, 200000);
    assert.strictEqual(resolveLimits('@cf/meta/llama-3-8b-instruct').contextWindow, 8192);
    assert.strictEqual(resolveLimits('openai/gpt-4o').capabilities.vision, true);
});

test('capabilities: vision and tools flags', () => {
    assert.strictEqual(resolveLimits('gpt-4o').capabilities.vision, true);
    assert.strictEqual(resolveLimits('gpt-4o').capabilities.tools, true);
    assert.strictEqual(resolveLimits('llama-3-8b-instruct').capabilities.vision, false);
    assert.strictEqual(resolveLimits('glm-4v').capabilities.vision, true);
    assert.strictEqual(resolveLimits('claude-3-5-sonnet').capabilities.vision, true);
});

test('overrides win over table and fallback', () => {
    const l = resolveLimits('gpt-4o', { contextWindow: 32000, maxOutputTokens: 512 });
    assert.strictEqual(l.contextWindow, 32000);
    assert.strictEqual(l.maxOutputTokens, 512);
    // capabilities/pricing still come from the table
    assert.strictEqual(l.capabilities.vision, true);
    const u = resolveLimits('unknown-model', { contextWindow: 9000 });
    assert.strictEqual(u.contextWindow, 9000);
    assert.strictEqual(u.maxOutputTokens, FALLBACK_LIMITS.maxOutputTokens);
});

test('garbage overrides ignored', () => {
    for (const bad of [0, -5, NaN, Infinity, 'big', null, undefined]) {
        const l = resolveLimits('gpt-4o', { contextWindow: bad, maxOutputTokens: bad });
        assert.strictEqual(l.contextWindow, 128000, `contextWindow with ${String(bad)}`);
        assert.strictEqual(l.maxOutputTokens, 16384, `maxOutputTokens with ${String(bad)}`);
    }
});

test('pricing present only where confident', () => {
    assert.ok(resolveLimits('gpt-4o').pricing);
    assert.ok(resolveLimits('claude-3-5-sonnet').pricing);
    assert.ok(resolveLimits('deepseek-chat').pricing);
    assert.strictEqual(resolveLimits('glm-4-plus').pricing, undefined);
    assert.strictEqual(resolveLimits('totally-unknown-model').pricing, undefined);
});

test('resolveLimits never mutates shared table entries', () => {
    const a = resolveLimits('gpt-4o', { contextWindow: 1 });
    assert.strictEqual(a.contextWindow, 1);
    const b = resolveLimits('gpt-4o');
    assert.strictEqual(b.contextWindow, 128000);
});
