/**
 * Pricing parity tests: the client-side `pricing.ts` must produce identical
 * results to the server's `utils.ts:calculateCostUsd` for the same input.
 *
 * If this test fails, paid spell generations will be billed against the
 * wrong amount and the CostEstimateModal will lie to the user — both
 * non-negotiable, hence the parity is enforced here at build time.
 */

import {
    MODELS,
    OR_BASE_URL,
    calculateCostUsd,
    calcImageUsd,
    calcVideoUsd,
    estimateUsd,
    formatUsd,
} from '../api/pricing';

describe('pricing.MODELS', () => {
    it('uses the same model identifiers as the server `config.ts`', () => {
        expect(MODELS).toEqual({
            SPELL_S: 'deepseek/deepseek-v4-flash',
            SUGGEST: 'deepseek/deepseek-v4-flash',
            WEBVIEW: 'google/gemini-3.1-flash-lite',
            IMAGE: 'google/gemini-3.1-flash-image-preview',
            IMAGE_EDIT: 'google/gemini-2.5-flash-image',
            TTS: 'google/gemini-3.1-flash-tts-preview',
            EMBED: 'google/gemini-embedding-001',
            VIDEO_FAST: 'google/veo-3.1-lite',
            VIDEO_STD: 'google/veo-3.1-fast',
        });
    });

    it('uses the OpenRouter v1 base URL', () => {
        expect(OR_BASE_URL).toBe('https://openrouter.ai/api/v1');
    });
});

describe('calculateCostUsd', () => {
    it('returns 0 for an unknown model so we never lie about cost', () => {
        expect(calculateCostUsd('unknown/model', { promptTokens: 1000, responseTokens: 1000 })).toBe(0);
    });

    it('charges cached prompt tokens at 25% of input rate (server invariant)', () => {
        const full = calculateCostUsd(MODELS.SPELL_S, {
            promptTokens: 1_000_000,
            responseTokens: 0,
        });
        const halfCached = calculateCostUsd(MODELS.SPELL_S, {
            promptTokens: 1_000_000,
            responseTokens: 0,
            cachedTokens: 500_000,
        });
        // half cached = 0.5 input + 0.5*0.25 input = 0.625 * full
        expect(halfCached).toBeCloseTo(full * 0.625, 6);
    });

    it('counts thinking tokens as billable output', () => {
        const withoutThoughts = calculateCostUsd(MODELS.SPELL_S, {
            promptTokens: 0,
            responseTokens: 1_000_000,
        });
        const withThoughts = calculateCostUsd(MODELS.SPELL_S, {
            promptTokens: 0,
            responseTokens: 500_000,
            thoughtsTokens: 500_000,
        });
        expect(withThoughts).toBeCloseTo(withoutThoughts, 6);
    });

    it('adds searchPerQuery cost when extras.searchQueries is provided', () => {
        const base = calculateCostUsd(MODELS.SPELL_S, { promptTokens: 0, responseTokens: 0 });
        const withSearch = calculateCostUsd(
            MODELS.SPELL_S,
            { promptTokens: 0, responseTokens: 0 },
            { searchQueries: 3 },
        );
        // SPELL_S has searchPerQuery=0.014 → 3 * 0.014 = 0.042
        expect(withSearch - base).toBeCloseTo(0.042, 6);
    });
});

describe('calcImageUsd', () => {
    it('charges $0.04 base + $0.10 per input image', () => {
        expect(calcImageUsd(0)).toBeCloseTo(0.04, 6);
        expect(calcImageUsd(2)).toBeCloseTo(0.24, 6);
    });
});

describe('calcVideoUsd', () => {
    it('charges fast rate without input images', () => {
        expect(calcVideoUsd(8, false)).toBeCloseTo(2.0, 6);
    });
    it('charges standard rate when input images are present', () => {
        expect(calcVideoUsd(4, true)).toBeCloseTo(2.6, 6);
    });
});

describe('formatUsd', () => {
    it('shows tiny costs as `< $0.01`', () => {
        expect(formatUsd(0.0001)).toBe('< $0.01');
    });
    it('trims trailing zeros under $1', () => {
        expect(formatUsd(0.5)).toBe('$0.5');
        expect(formatUsd(0.1234)).toBe('$0.1234');
    });
    it('rounds to 2 decimals at $1+', () => {
        expect(formatUsd(12.345)).toBe('$12.35');
    });
});

describe('estimateUsd', () => {
    it('returns positive USD for a create estimate', () => {
        const value = estimateUsd({ type: 'create', promptLength: 200 });
        expect(value).toBeGreaterThan(0);
    });

    it('matches calcImageUsd for app_icon', () => {
        expect(estimateUsd({ type: 'app_icon' })).toBeCloseTo(calcImageUsd(0), 6);
    });

    it('matches calcVideoUsd for webview_ai_video', () => {
        expect(
            estimateUsd({ type: 'webview_ai_video', videoSeconds: 6, videoHasImages: true }),
        ).toBeCloseTo(calcVideoUsd(6, true), 6);
    });
});
