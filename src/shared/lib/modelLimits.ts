// @ts-nocheck
// Per-model limits: context window, output cap, capabilities, pricing.
// Matched by substring regex against the lowercased model id so provider-prefixed
// ids ("anthropic/claude-3-opus", "@cf/meta/llama-3-8b-instruct") resolve too.
// Order matters: specific entries before general ones — first match wins.
// Profile-level overrides (Settings → Advanced) beat the table; the table beats
// the fallback. Prices are USD per million tokens and only listed where we are
// confident; absence of pricing just hides cost display.

export const FALLBACK_LIMITS = Object.freeze({
    contextWindow: 128000,
    maxOutputTokens: 4096,
    capabilities: Object.freeze({ tools: true, vision: false }),
});

const T = (contextWindow, maxOutputTokens, { tools = true, vision = false, pricing } = {}) =>
    ({ contextWindow, maxOutputTokens, capabilities: { tools, vision }, pricing });

const MODEL_TABLE = [
    // OpenAI
    { match: /gpt-4o-mini/, limits: T(128000, 16384, { vision: true, pricing: { inPerMTok: 0.15, outPerMTok: 0.6, cachedInPerMTok: 0.075 } }) },
    { match: /gpt-4o/, limits: T(128000, 16384, { vision: true, pricing: { inPerMTok: 2.5, outPerMTok: 10, cachedInPerMTok: 1.25 } }) },
    { match: /gpt-4\.1-nano/, limits: T(1000000, 32768, { vision: true, pricing: { inPerMTok: 0.1, outPerMTok: 0.4, cachedInPerMTok: 0.025 } }) },
    { match: /gpt-4\.1-mini/, limits: T(1000000, 32768, { vision: true, pricing: { inPerMTok: 0.4, outPerMTok: 1.6, cachedInPerMTok: 0.1 } }) },
    { match: /gpt-4\.1/, limits: T(1000000, 32768, { vision: true, pricing: { inPerMTok: 2, outPerMTok: 8, cachedInPerMTok: 0.5 } }) },
    { match: /o4-mini/, limits: T(200000, 100000, { vision: true, pricing: { inPerMTok: 1.1, outPerMTok: 4.4, cachedInPerMTok: 0.275 } }) },
    { match: /o3-mini/, limits: T(200000, 100000, { pricing: { inPerMTok: 1.1, outPerMTok: 4.4, cachedInPerMTok: 0.55 } }) },
    { match: /\bo3\b/, limits: T(200000, 100000, { vision: true, pricing: { inPerMTok: 2, outPerMTok: 8, cachedInPerMTok: 0.5 } }) },
    { match: /gpt-4-turbo/, limits: T(128000, 4096, { vision: true, pricing: { inPerMTok: 10, outPerMTok: 30 } }) },
    { match: /gpt-4/, limits: T(8192, 4096, { pricing: { inPerMTok: 30, outPerMTok: 60 } }) },
    { match: /gpt-3\.5/, limits: T(16385, 4096, { pricing: { inPerMTok: 0.5, outPerMTok: 1.5 } }) },
    // Anthropic — specific generations before the claude-3 catch-all
    { match: /claude-(3-5|3\.5|3-7|3\.7)/, limits: T(200000, 8192, { vision: true, pricing: { inPerMTok: 3, outPerMTok: 15, cachedInPerMTok: 0.3 } }) },
    { match: /claude-(opus|sonnet)-4|claude-4/, limits: T(200000, 64000, { vision: true, pricing: { inPerMTok: 3, outPerMTok: 15, cachedInPerMTok: 0.3 } }) },
    { match: /claude-haiku-4/, limits: T(200000, 64000, { vision: true, pricing: { inPerMTok: 1, outPerMTok: 5, cachedInPerMTok: 0.1 } }) },
    { match: /claude-3-opus/, limits: T(200000, 4096, { vision: true, pricing: { inPerMTok: 15, outPerMTok: 75, cachedInPerMTok: 1.5 } }) },
    { match: /claude-3/, limits: T(200000, 4096, { vision: true, pricing: { inPerMTok: 3, outPerMTok: 15, cachedInPerMTok: 0.3 } }) },
    { match: /claude/, limits: T(200000, 8192, { vision: true }) },
    // Zhipu GLM — glm-4v (vision) before glm-4
    { match: /glm-4v/, limits: T(8192, 4096, { vision: true }) },
    { match: /glm-4/, limits: T(128000, 4096) },
    // DeepSeek
    { match: /deepseek-r(easoner|1)/, limits: T(65536, 8192, { pricing: { inPerMTok: 0.55, outPerMTok: 2.19, cachedInPerMTok: 0.14 } }) },
    { match: /deepseek/, limits: T(65536, 8192, { pricing: { inPerMTok: 0.27, outPerMTok: 1.1, cachedInPerMTok: 0.07 } }) },
    // Meta Llama — 3.1/3.2/3.3 (128k) before plain llama-3 (8k)
    { match: /llama-?3\.[123]/, limits: T(128000, 4096) },
    { match: /llama-?3/, limits: T(8192, 4096) },
    // Google Gemini
    { match: /gemini-(1\.5|2)/, limits: T(1000000, 8192, { vision: true }) },
    { match: /gemini/, limits: T(128000, 8192, { vision: true }) },
    // Alibaba Qwen
    { match: /qwen/, limits: T(32768, 8192) },
];

const validOverride = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

export function resolveLimits(modelId, overrides) {
    const id = (modelId ?? '').toLowerCase();
    const entry = MODEL_TABLE.find((e) => e.match.test(id));
    const base = entry ? entry.limits : FALLBACK_LIMITS;
    const resolved = {
        contextWindow: validOverride(overrides?.contextWindow) ? overrides.contextWindow : base.contextWindow,
        maxOutputTokens: validOverride(overrides?.maxOutputTokens) ? overrides.maxOutputTokens : base.maxOutputTokens,
        capabilities: { ...base.capabilities },
    };
    if (base.pricing) resolved.pricing = { ...base.pricing };
    return resolved;
}
