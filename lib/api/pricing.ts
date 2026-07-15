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
    SUGGEST: 'deepseek/deepseek-v4-flash',
    WEBVIEW: 'google/gemini-3-flash-preview',
    IMAGE: 'google/gemini-3.1-flash-image-preview',
    IMAGE_EDIT: 'google/gemini-2.5-flash-image',
    TTS: 'google/gemini-3.1-flash-tts-preview',
    EMBED: 'google/gemini-embedding-001',
    VIDEO_FAST: 'google/veo-3.1-lite',
    VIDEO_STD: 'google/veo-3.1-fast',
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

export const OR_REASONING_HIGH = { reasoning: { effort: 'high' as const } };

export const OR_WEB_SEARCH = {
    tools: [
        {
            type: 'openrouter:web_search',
            parameters: {
                engine: 'parallel',
                max_results: 10,
                max_total_results: 20,
            },
        },
        {
            type: 'openrouter:web_fetch',
            parameters: {
                engine: 'openrouter',
                max_uses: 10,
                max_content_tokens: 50000,
            },
        },
    ],
};

// ============= USD COST CALCULATION =============

const USD_PRICING: Record<
    string,
    {
        inputPerMToken: number;
        outputPerMToken: number;
        audioInputPerMToken?: number;
        searchPerQuery?: number;
        mapsPerQuery?: number;
    }
> = {
    'deepseek/deepseek-v4-flash': { inputPerMToken: 0.14, outputPerMToken: 0.28, audioInputPerMToken: 0.0, searchPerQuery: 0.014 },
    'google/gemini-3-flash-preview': { inputPerMToken: 0.50, outputPerMToken: 3.00, searchPerQuery: 0.014 },
    'google/gemini-3.1-flash-image-preview': { inputPerMToken: 0.10, outputPerMToken: 0.40 },
    'google/gemini-2.5-flash-image': { inputPerMToken: 0.30, outputPerMToken: 2.50 },
    'google/gemini-3.1-flash-tts-preview': { inputPerMToken: 0.50, outputPerMToken: 10.00 },
    'google/gemini-embedding-001': { inputPerMToken: 0.15, outputPerMToken: 0 },
};

const USD_IMAGE_PER_UNIT = 0.04;
const USD_VIDEO_PER_SECOND_FAST = 0.25;
const USD_VIDEO_PER_SECOND_STD = 0.65;
const USD_PER_INPUT_IMAGE = 0.10;

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
    const pricing = USD_PRICING[modelId];
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
    | 'webview_ai_similarity';

export interface EstimateInput {
    type: EstimateType;
    promptLength?: number;
    inputImages?: number;
    videoSeconds?: number;
    videoHasImages?: boolean;
    ttsCharacters?: number;
    similarityItems?: number;
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
            return calculateCostUsd(MODELS.SPELL_S, {
                promptTokens: promptTokens + 1800,
                responseTokens: 4000,
                thoughtsTokens: 2000,
            });
        case 'app_icon':
            return calcImageUsd(0);
        case 'webview_ai':
            return calculateCostUsd(MODELS.WEBVIEW, {
                promptTokens: promptTokens + 200,
                responseTokens: 800,
            });
        case 'webview_ai_image':
            return calcImageUsd(input.inputImages ?? 0);
        case 'webview_ai_video':
            return calcVideoUsd(input.videoSeconds ?? 8, input.videoHasImages ?? false);
        case 'webview_ai_tts':
            return calculateCostUsd(MODELS.TTS, {
                promptTokens: Math.ceil((input.ttsCharacters ?? 0) / 4) + 50,
                responseTokens: Math.ceil((input.ttsCharacters ?? 0) * 2),
            });
        case 'webview_ai_similarity':
            return calculateCostUsd(MODELS.EMBED, {
                promptTokens: (input.similarityItems ?? 1) * 50,
                responseTokens: 0,
            });
    }
}
