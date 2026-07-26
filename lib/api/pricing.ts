/**
 * OpenRouter model identifiers and USD cost calculation.
 *
 * Port byte-a-byte de:
 *   firebase/functions/src/config.ts:3-13   (MODELS, OR_REASONING_HIGH, OR_WEB_SEARCH)
 *   firebase/functions/src/utils.ts:59-120  (calculateCostUsd, calcImageMana, calcVideoMana)
 *
 * Mesmos IDs e mesma fórmula do servidor — qualquer divergência quebra paridade
 * de qualidade pós-refactor BYOK.
 */

export const OR_BASE_URL = 'https://openrouter.ai/api/v1';

export const MODELS = {
    SPELL_S: 'deepseek/deepseek-v4-flash',
    WEBVIEW: 'google/gemini-3-flash-preview',
    IMAGE: 'google/gemini-3.1-flash-image-preview',
    IMAGE_EDIT: 'google/gemini-2.5-flash-image',
    TTS: 'google/gemini-3.1-flash-tts-preview',
    MUSIC: 'google/lyria-3-pro-preview',
    EMBED: 'google/gemini-embedding-001',
    VIDEO_FAST: 'google/veo-3.1-lite',
    VIDEO_STD: 'google/veo-3.1-fast',
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

// ============= AI TIERS =============

export const AI_TIERS = ['apprentice', 'sorcerer', 'archmage'] as const;
export type AiTier = (typeof AI_TIERS)[number];

export const DEFAULT_AI_TIER: AiTier = 'sorcerer';

type TaskKey = keyof typeof MODELS;

/**
 * Curated model choice per (tier, task). The resolver in modelPreferences.ts
 * falls back to `MODELS[task]` when a tier entry points at an ID that is
 * missing from the OpenRouter catalog — so this map can grow/shrink without
 * risking a broken default.
 *
 * TTS, MUSIC and EMBED collapse to the same model across tiers because there
 * is only one viable option today; extending them is a no-op change.
 */
export const TIER_MODELS: Record<AiTier, Record<TaskKey, string>> = {
    apprentice: {
        SPELL_S: 'deepseek/deepseek-v4-flash',
        WEBVIEW: 'google/gemini-3.5-flash-lite',
        IMAGE: 'google/gemini-3.1-flash-lite-image',
        IMAGE_EDIT: 'google/gemini-3.1-flash-lite-image',
        TTS: 'google/gemini-3.1-flash-tts-preview',
        MUSIC: 'google/lyria-3-pro-preview',
        EMBED: 'intfloat/multilingual-e5-large',
        VIDEO_FAST: 'google/veo-3.1-lite',
        VIDEO_STD: 'google/veo-3.1-lite',
    },
    sorcerer: {
        SPELL_S: 'deepseek/deepseek-v4-pro',
        WEBVIEW: 'google/gemini-3.6-flash',
        IMAGE: 'google/gemini-3.1-flash-image',
        IMAGE_EDIT: 'google/gemini-3.1-flash-image',
        TTS: 'google/gemini-3.1-flash-tts-preview',
        MUSIC: 'google/lyria-3-pro-preview',
        EMBED: 'intfloat/multilingual-e5-large',
        VIDEO_FAST: 'google/veo-3.1-fast',
        VIDEO_STD: 'google/veo-3.1-fast',
    },
    archmage: {
        SPELL_S: 'z-ai/glm-5.2',
        WEBVIEW: 'google/gemini-3.1-pro-preview',
        IMAGE: 'google/gemini-3-pro-image',
        IMAGE_EDIT: 'google/gemini-3-pro-image',
        TTS: 'google/gemini-3.1-flash-tts-preview',
        MUSIC: 'google/lyria-3-pro-preview',
        EMBED: 'intfloat/multilingual-e5-large',
        VIDEO_FAST: 'google/veo-3.1',
        VIDEO_STD: 'google/veo-3.1',
    },
};

export const OR_REASONING_HIGH = { reasoning: { effort: 'high' as const } };

// OpenRouter's web-search integration. Uses the current `plugins: [{id:'web'}]`
// shape (handled server-side by OpenRouter, no tool_calls loop on our side).
// The old `tools: [{type: 'openrouter:web_search'}, ...]` shape was making
// reasoning models (DeepSeek V4 Flash) return `finish_reason: 'tool_calls'`
// with empty content, which threw `Empty AI response (finish_reason:
// tool_calls)` and cascaded into `No JSON object found` when the planner
// stage tried to parse the empty response.
export const OR_WEB_SEARCH = {
    plugins: [{ id: 'web', max_results: 10 }],
};

// ============= USD COST CALCULATION =============

export interface CatalogPricing {
    inputPerMToken: number;
    outputPerMToken: number;
    audioInputPerMToken?: number;
    searchPerQuery?: number;
    mapsPerQuery?: number;
}

/**
 * Seed prices for the hardcoded default models. Used as last-resort fallback
 * when a user is brand new and has neither picked a model (Cache B empty) nor
 * loaded the OpenRouter catalog (Cache A empty). Runtime cost calc always
 * prefers Cache B via `resolvePricingForModel` in `modelCatalog.ts`.
 */
export const USD_PRICING_SEED: Record<string, CatalogPricing> = {
    'deepseek/deepseek-v4-flash': { inputPerMToken: 0.14, outputPerMToken: 0.28, audioInputPerMToken: 0.0, searchPerQuery: 0.014 },
    'google/gemini-3-flash-preview': { inputPerMToken: 0.50, outputPerMToken: 3.00, searchPerQuery: 0.014 },
    'google/gemini-3.1-flash-image-preview': { inputPerMToken: 0.10, outputPerMToken: 0.40 },
    'google/gemini-2.5-flash-image': { inputPerMToken: 0.30, outputPerMToken: 2.50 },
    'google/gemini-3.1-flash-tts-preview': { inputPerMToken: 0.50, outputPerMToken: 10.00 },
    // Lyria cobra por música ($0.08/song), não por token — calcMusicUsd() é a fonte da verdade.
    'google/lyria-3-pro-preview': { inputPerMToken: 0, outputPerMToken: 0 },
    'google/gemini-embedding-001': { inputPerMToken: 0.15, outputPerMToken: 0 },
    // Tier defaults — calibrados contra OpenRouter /models em 2026-07-26.
    'deepseek/deepseek-v4-pro': { inputPerMToken: 0.435, outputPerMToken: 0.87, searchPerQuery: 0.014 },
    'z-ai/glm-5.2': { inputPerMToken: 0.6692, outputPerMToken: 2.1032, searchPerQuery: 0.014 },
    'google/gemini-3.5-flash-lite': { inputPerMToken: 0.30, outputPerMToken: 2.50, searchPerQuery: 0.014 },
    'google/gemini-3.6-flash': { inputPerMToken: 1.50, outputPerMToken: 7.50, searchPerQuery: 0.014 },
    'google/gemini-3.1-pro-preview': { inputPerMToken: 2.00, outputPerMToken: 12.00, searchPerQuery: 0.014 },
    'google/gemini-3.1-flash-lite-image': { inputPerMToken: 0.25, outputPerMToken: 1.50, searchPerQuery: 0.014 },
    'google/gemini-3.1-flash-image': { inputPerMToken: 0.50, outputPerMToken: 3.00, searchPerQuery: 0.014 },
    'google/gemini-3-pro-image': { inputPerMToken: 2.00, outputPerMToken: 12.00, searchPerQuery: 0.014 },
    // Embedding não está no catálogo OpenRouter — preço aproximado com base em modelos similares.
    'intfloat/multilingual-e5-large': { inputPerMToken: 0.10, outputPerMToken: 0 },
    // Video price-per-second lives in USD_VIDEO_PER_SECOND_* — token entries are informational only.
    'google/veo-3.1-lite': { inputPerMToken: 0, outputPerMToken: 0 },
    'google/veo-3.1': { inputPerMToken: 0, outputPerMToken: 0 },
};

const USD_IMAGE_PER_UNIT = 0.04;
const USD_VIDEO_PER_SECOND_FAST = 0.25;
const USD_VIDEO_PER_SECOND_STD = 0.65;
const USD_PER_INPUT_IMAGE = 0.10;
const USD_MUSIC_PER_SONG = 0.08;

export interface UsageBreakdown {
    promptTokens: number;
    responseTokens: number;
    thoughtsTokens?: number;
    cachedTokens?: number;
}

export interface UsageExtras {
    searchQueries?: number;
    mapsQueries?: number;
    audioTokens?: number;
}

export function calculateCostUsd(
    modelId: string,
    usage: UsageBreakdown,
    extras?: UsageExtras,
): number {
    // Lazy require to avoid the pricing.ts ↔ modelCatalog.ts cycle at load
    // time; both modules are loaded before any AI call fires.
    const { resolvePricingForModel } = require('./modelCatalog') as typeof import('./modelCatalog');
    const pricing = resolvePricingForModel(modelId);
    if (!pricing) return 0;

    const cached = usage.cachedTokens ?? 0;
    const nonCached = usage.promptTokens - cached;
    const inputCost =
        (nonCached / 1_000_000) * pricing.inputPerMToken +
        (cached / 1_000_000) * pricing.inputPerMToken * 0.25;

    const billableOutput = usage.responseTokens + (usage.thoughtsTokens ?? 0);
    const outputCost = (billableOutput / 1_000_000) * pricing.outputPerMToken;

    const searchCost =
        extras?.searchQueries && pricing.searchPerQuery ? extras.searchQueries * pricing.searchPerQuery : 0;

    const mapsCost = extras?.mapsQueries && pricing.mapsPerQuery ? extras.mapsQueries * pricing.mapsPerQuery : 0;

    const audioCost =
        extras?.audioTokens && pricing.audioInputPerMToken
            ? (extras.audioTokens / 1_000_000) * pricing.audioInputPerMToken
            : 0;

    return inputCost + outputCost + searchCost + mapsCost + audioCost;
}

export function calcImageUsd(numInputImages: number): number {
    return USD_IMAGE_PER_UNIT + numInputImages * USD_PER_INPUT_IMAGE;
}

export function calcVideoUsd(durationSeconds: number, hasImages: boolean): number {
    return durationSeconds * (hasImages ? USD_VIDEO_PER_SECOND_STD : USD_VIDEO_PER_SECOND_FAST);
}

export function calcMusicUsd(): number {
    return USD_MUSIC_PER_SONG;
}

export function formatUsd(amount: number): string {
    if (amount < 0.01) return `< $0.01`;
    if (amount < 1) return `$${amount.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
    return `$${amount.toFixed(2)}`;
}

// ============= ESTIMATION (client-side, pre-call) =============

export type EstimateType =
    | 'create'
    | 'edit'
    | 'convert'
    | 'app_icon'
    | 'webview_ai'
    | 'webview_ai_image'
    | 'webview_ai_video'
    | 'webview_ai_tts'
    | 'webview_ai_music'
    | 'webview_ai_similarity';

export interface EstimateInput {
    type: EstimateType;
    promptLength?: number;
    inputImages?: number;
    videoSeconds?: number;
    videoHasImages?: boolean;
    ttsCharacters?: number;
    similarityItems?: number;
    /**
     * User's resolved model id for this operation (from `getPreferredModel`).
     * When present, `estimateUsd` prices against this model instead of the
     * hardcoded default in `MODELS.*`. Falls back to the default when absent
     * so callers that don't yet resolve a preference still work.
     */
    modelId?: string;
}

/**
 * Rough USD estimate to surface in CostEstimateModal before the call lands.
 * Real cost comes from `usage.cost` on the response — this is best-effort.
 */
export function estimateUsd(input: EstimateInput): number {
    const promptTokens = Math.ceil((input.promptLength ?? 0) / 4);
    switch (input.type) {
        case 'create':
        case 'edit':
        case 'convert':
            return calculateCostUsd(input.modelId ?? MODELS.SPELL_S, {
                promptTokens: promptTokens + 1800,
                responseTokens: 4000,
                thoughtsTokens: 2000,
            });
        case 'app_icon':
            return calcImageUsd(0);
        case 'webview_ai':
            return calculateCostUsd(input.modelId ?? MODELS.WEBVIEW, {
                promptTokens: promptTokens + 200,
                responseTokens: 800,
            });
        case 'webview_ai_image':
            return calcImageUsd(input.inputImages ?? 0);
        case 'webview_ai_video':
            return calcVideoUsd(input.videoSeconds ?? 8, input.videoHasImages ?? false);
        case 'webview_ai_tts':
            return calculateCostUsd(input.modelId ?? MODELS.TTS, {
                promptTokens: Math.ceil((input.ttsCharacters ?? 0) / 4) + 50,
                responseTokens: Math.ceil((input.ttsCharacters ?? 0) * 2),
            });
        case 'webview_ai_music':
            return calcMusicUsd();
        case 'webview_ai_similarity':
            return calculateCostUsd(input.modelId ?? MODELS.EMBED, {
                promptTokens: (input.similarityItems ?? 1) * 50,
                responseTokens: 0,
            });
    }
}
