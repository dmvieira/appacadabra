/**
 * Cost-accumulation fallback for WebView AI capabilities.
 *
 * The WebView bridge writes `costUsd` returned by `lib/api/ai.ts` into
 * `generated_apps.totalSpendUsd`. When OpenRouter fails to include a
 * `usage.cost` on the response (always for /audio/speech, often for image
 * and video endpoints), the caller must fall back to local pricing so the
 * spell's accumulated spend stays honest.
 *
 * These tests lock in that fallback for image / video / TTS / similarity.
 * Text lives in `generators.ts` and is covered by `generators.test.ts`.
 */

jest.unmock('../api/ai');

jest.mock('../api/openrouter', () => ({
    generateImage: jest.fn(),
    tts: jest.fn(),
    submitVideo: jest.fn(),
    pollVideo: jest.fn(),
    embed: jest.fn(),
}));

jest.mock('../analytics', () => ({
    logEvent: jest.fn(),
    setUserProperties: jest.fn(),
    logAppCreated: jest.fn(),
    logAppEdited: jest.fn(),
    logAiGenerate: jest.fn(),
    logAiGenerateImage: jest.fn(),
}));

import * as openrouter from '../api/openrouter';
import {
    aiGenerateImage,
    aiGenerateTTS,
    aiGenerateVideo,
    aiSimilarity,
} from '../api/ai';
import {
    calcImageUsd,
    calcVideoUsd,
    calculateCostUsd,
    MODELS,
} from '../api/pricing';

const mGenerateImage = openrouter.generateImage as jest.MockedFunction<typeof openrouter.generateImage>;
const mTts = openrouter.tts as jest.MockedFunction<typeof openrouter.tts>;
const mSubmitVideo = openrouter.submitVideo as jest.MockedFunction<typeof openrouter.submitVideo>;
const mPollVideo = openrouter.pollVideo as jest.MockedFunction<typeof openrouter.pollVideo>;
const mEmbed = openrouter.embed as jest.MockedFunction<typeof openrouter.embed>;

beforeEach(() => {
    mGenerateImage.mockReset();
    mTts.mockReset();
    mSubmitVideo.mockReset();
    mPollVideo.mockReset();
    mEmbed.mockReset();
});

// ============= IMAGE =============

describe('aiGenerateImage cost fallback', () => {
    it('uses OpenRouter usage.cost when present and > 0', async () => {
        mGenerateImage.mockResolvedValue({
            images: ['AAA'],
            usage: { cost: 0.123 } as any,
        });
        const r = await aiGenerateImage('hi');
        expect(r.costUsd).toBeCloseTo(0.123, 6);
    });

    it('falls back to calcImageUsd(0) when usage missing (no input images)', async () => {
        mGenerateImage.mockResolvedValue({ images: ['AAA'], usage: undefined });
        const r = await aiGenerateImage('hi');
        expect(r.costUsd).toBeCloseTo(calcImageUsd(0), 6);
        expect(r.costUsd).toBeGreaterThan(0);
    });

    it('falls back to calcImageUsd(N) counting input images (zero cost treated as missing)', async () => {
        mGenerateImage.mockResolvedValue({
            images: ['AAA'],
            usage: { cost: 0 } as any,
        });
        const r = await aiGenerateImage('hi', ['img1', 'img2']);
        expect(r.costUsd).toBeCloseTo(calcImageUsd(2), 6);
    });
});

// ============= TTS =============

describe('aiGenerateTTS cost fallback', () => {
    it('always falls back (TTS endpoint returns no usage)', async () => {
        mTts.mockResolvedValue({
            audioBase64: 'BBB',
            mimeType: 'audio/wav',
            usage: undefined,
        });
        const text = 'hello world';
        const r = await aiGenerateTTS(text);
        const expected = calculateCostUsd(MODELS.TTS, {
            promptTokens: Math.ceil(text.length / 4) + 50,
            responseTokens: Math.ceil(text.length * 2),
        });
        expect(r.costUsd).toBeCloseTo(expected, 6);
        expect(r.costUsd).toBeGreaterThan(0);
    });

    it('uses reported usage.cost when > 0', async () => {
        mTts.mockResolvedValue({
            audioBase64: 'BBB',
            mimeType: 'audio/wav',
            usage: { cost: 0.05 } as any,
        });
        const r = await aiGenerateTTS('hello');
        expect(r.costUsd).toBeCloseTo(0.05, 6);
    });
});

// ============= VIDEO =============

describe('aiGenerateVideo cost fallback', () => {
    // aiGenerateVideo polls every VIDEO_POLL_INTERVAL_MS (5s). Fake timers keep
    // the tests instant.
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    async function runVideo(fn: () => Promise<any>): Promise<any> {
        const promise = fn();
        // Advance past the first setTimeout(5000) so pollVideo resolves.
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(5000);
        return promise;
    }

    it('uses OpenRouter usage.cost when present', async () => {
        mSubmitVideo.mockResolvedValue({ id: 'x', pollingUrl: 'u' });
        mPollVideo.mockResolvedValue({
            videoBase64: 'CCC',
            usage: { cost: 4.2 } as any,
        });
        const r = await runVideo(() => aiGenerateVideo('hi'));
        expect(r.costUsd).toBeCloseTo(4.2, 6);
    });

    it('falls back to calcVideoUsd(8, false) for text-only video', async () => {
        mSubmitVideo.mockResolvedValue({ id: 'x', pollingUrl: 'u' });
        mPollVideo.mockResolvedValue({ videoBase64: 'CCC', usage: undefined });
        const r = await runVideo(() => aiGenerateVideo('hi'));
        expect(r.costUsd).toBeCloseTo(calcVideoUsd(8, false), 6);
        expect(r.costUsd).toBeGreaterThan(0);
    });

    it('falls back to calcVideoUsd(8, true) when an input image is present', async () => {
        mSubmitVideo.mockResolvedValue({ id: 'x', pollingUrl: 'u' });
        mPollVideo.mockResolvedValue({ videoBase64: 'CCC', usage: undefined });
        const r = await runVideo(() => aiGenerateVideo('hi', ['img1']));
        expect(r.costUsd).toBeCloseTo(calcVideoUsd(8, true), 6);
    });
});

// ============= SIMILARITY =============

describe('aiSimilarity cost fallback', () => {
    it('uses OpenRouter usage.cost when > 0', async () => {
        mEmbed.mockResolvedValue({
            vectors: [[1, 0], [0, 1]],
            usage: { cost: 0.05 } as any,
        });
        const r = await aiSimilarity(['a', 'b']);
        expect(r.costUsd).toBeCloseTo(0.05, 6);
    });

    it('falls back to per-item token sum when usage missing', async () => {
        mEmbed.mockResolvedValue({
            vectors: [[1, 0], [0, 1]],
            usage: undefined,
        });
        const items = ['hello', 'world foo bar'];
        const r = await aiSimilarity(items);
        const expected = calculateCostUsd(MODELS.EMBED, {
            promptTokens: items.reduce((s, i) => s + Math.ceil(i.length / 4), 0),
            responseTokens: 0,
        });
        expect(r.costUsd).toBeCloseTo(expected, 6);
    });
});
