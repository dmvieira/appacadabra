/**
 * Coverage for `estimateUsd` after M3 — it must use the user's
 * resolved model id (from `getPreferredModel`) instead of the
 * hardcoded default in `MODELS.*`. If the user picked a pricier
 * o1 model for WEBVIEW, the pre-call cost estimate has to reflect
 * that, not the default flash-tier number.
 */

const mockResolvePricing = jest.fn();

jest.mock('../modelCatalog', () => ({
    resolvePricingForModel: (...args: any[]) => mockResolvePricing(...args),
}));

import { estimateUsd, MODELS } from '../pricing';

beforeEach(() => {
    mockResolvePricing.mockReset();
});

describe('estimateUsd — modelId override', () => {
    it('uses the passed modelId, not MODELS.WEBVIEW, for webview_ai', () => {
        mockResolvePricing.mockImplementation((id: string) => {
            if (id === 'openai/o1') return { inputPerMToken: 15, outputPerMToken: 60 };
            if (id === MODELS.WEBVIEW) return { inputPerMToken: 0.5, outputPerMToken: 3 };
            return null;
        });

        const withOverride = estimateUsd({
            type: 'webview_ai',
            promptLength: 1000,
            modelId: 'openai/o1',
        });
        const withDefault = estimateUsd({
            type: 'webview_ai',
            promptLength: 1000,
        });

        expect(withOverride).toBeGreaterThan(withDefault);
        expect(mockResolvePricing).toHaveBeenCalledWith('openai/o1');
        expect(mockResolvePricing).toHaveBeenCalledWith(MODELS.WEBVIEW);
    });

    it('uses the passed modelId for create/edit/convert (SPELL_S slot)', () => {
        mockResolvePricing.mockImplementation((id: string) => {
            if (id === 'anthropic/claude-opus') return { inputPerMToken: 20, outputPerMToken: 80 };
            if (id === MODELS.SPELL_S) return { inputPerMToken: 0.14, outputPerMToken: 0.28 };
            return null;
        });

        const opusEstimate = estimateUsd({
            type: 'create',
            promptLength: 500,
            modelId: 'anthropic/claude-opus',
        });
        const defaultEstimate = estimateUsd({
            type: 'create',
            promptLength: 500,
        });

        expect(opusEstimate).toBeGreaterThan(defaultEstimate * 50);
        expect(mockResolvePricing).toHaveBeenCalledWith('anthropic/claude-opus');
    });

    it('uses the passed modelId for webview_ai_tts', () => {
        mockResolvePricing.mockImplementation((id: string) => {
            if (id === 'elevenlabs/turbo') return { inputPerMToken: 5, outputPerMToken: 25 };
            if (id === MODELS.TTS) return { inputPerMToken: 0.5, outputPerMToken: 10 };
            return null;
        });

        const custom = estimateUsd({
            type: 'webview_ai_tts',
            ttsCharacters: 200,
            modelId: 'elevenlabs/turbo',
        });
        const def = estimateUsd({
            type: 'webview_ai_tts',
            ttsCharacters: 200,
        });

        expect(custom).toBeGreaterThan(def);
        expect(mockResolvePricing).toHaveBeenCalledWith('elevenlabs/turbo');
    });

    it('uses the passed modelId for webview_ai_similarity (EMBED slot)', () => {
        mockResolvePricing.mockImplementation((id: string) => {
            if (id === 'cohere/embed-v4') return { inputPerMToken: 3, outputPerMToken: 0 };
            if (id === MODELS.EMBED) return { inputPerMToken: 0.15, outputPerMToken: 0 };
            return null;
        });

        const cohere = estimateUsd({
            type: 'webview_ai_similarity',
            similarityItems: 10,
            modelId: 'cohere/embed-v4',
        });
        const def = estimateUsd({
            type: 'webview_ai_similarity',
            similarityItems: 10,
        });

        expect(cohere).toBeGreaterThan(def);
        expect(mockResolvePricing).toHaveBeenCalledWith('cohere/embed-v4');
    });

    it('falls back to the hardcoded default when no modelId is passed', () => {
        mockResolvePricing.mockReturnValue({ inputPerMToken: 0.5, outputPerMToken: 3 });

        estimateUsd({ type: 'webview_ai', promptLength: 100 });

        expect(mockResolvePricing).toHaveBeenCalledWith(MODELS.WEBVIEW);
    });
});
