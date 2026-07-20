/**
 * Regression for the WhatsApp voice-note failure: WhatsApp shares audio
 * with mimeType `audio/ogg; codecs=opus`, and the spell wraps the payload
 * as `data:audio/ogg; codecs=opus;base64,<bytes>` before handing it to
 * `AppacadabraAI.fromAudio(...)`. The cleanPrefix regex in `ai.aiGenerate`
 * used to stop at the first `;`, so it never matched that header — the raw
 * data URI ended up embedded in the outgoing payload and OpenRouter
 * returned HTTP 400. This test locks in the fix so audio with MIME
 * parameters is stripped down to the actual base64 before reaching the
 * provider.
 */

jest.unmock('../api/ai');

jest.mock('../api/generators', () => ({
    generateSpellCreate: jest.fn(),
    generateSpellEdit: jest.fn(),
    generateConvert: jest.fn(),
    generateWebviewAI: jest.fn(),
}));

jest.mock('../analytics', () => ({
    logEvent: jest.fn(),
    setUserProperties: jest.fn(),
    logAppCreated: jest.fn(),
    logAppEdited: jest.fn(),
    logAiGenerate: jest.fn(),
    logAiGenerateImage: jest.fn(),
}));

import * as generators from '../api/generators';
import { aiGenerate } from '../api/ai';

const mWebview = generators.generateWebviewAI as jest.MockedFunction<
    typeof generators.generateWebviewAI
>;

beforeEach(() => {
    mWebview.mockReset();
    mWebview.mockResolvedValue({
        text: 'ok',
        usage: { promptTokens: 1, responseTokens: 1, totalTokens: 2, reportedCostUsd: 0 } as any,
        searchQueriesUsed: 0,
        costUsd: 0,
    });
});

const RAW_OGG = 'T2dnUwACAAAAAAAAAAAAAAAA';

describe('aiGenerate cleanPrefix — data URI stripping', () => {
    it('strips a standard data URI prefix (no MIME params)', async () => {
        await aiGenerate({ prompt: 'p', audios: [`data:audio/ogg;base64,${RAW_OGG}`] });
        const call = mWebview.mock.calls[0][0];
        expect(call.audios).toEqual([RAW_OGG]);
    });

    it('strips a WhatsApp-style data URI with "; codecs=opus" (regression)', async () => {
        await aiGenerate({
            prompt: 'p',
            audios: [`data:audio/ogg; codecs=opus;base64,${RAW_OGG}`],
        });
        const call = mWebview.mock.calls[0][0];
        expect(call.audios).toEqual([RAW_OGG]);
    });

    it('strips multiple stacked prefixes', async () => {
        await aiGenerate({
            prompt: 'p',
            audios: [`data:audio/ogg;base64,data:audio/ogg; codecs=opus;base64,${RAW_OGG}`],
        });
        const call = mWebview.mock.calls[0][0];
        expect(call.audios).toEqual([RAW_OGG]);
    });

    it('leaves raw base64 untouched when there is no prefix', async () => {
        await aiGenerate({ prompt: 'p', audios: [RAW_OGG] });
        const call = mWebview.mock.calls[0][0];
        expect(call.audios).toEqual([RAW_OGG]);
    });

    it('applies the same stripping to images', async () => {
        await aiGenerate({
            prompt: 'p',
            images: [`data:image/jpeg; profile=strict;base64,SGVsbG8=`],
        });
        const call = mWebview.mock.calls[0][0];
        expect(call.images).toEqual(['SGVsbG8=']);
    });
});
