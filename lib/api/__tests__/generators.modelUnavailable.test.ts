/**
 * B3 regression: when the spell create/edit path throws an
 * `OpenRouterError({ code: 'byok.error.modelUnavailable' })`, the outer
 * wrapper in `lib/api/ai.ts` MUST forward that signal to
 * `useBridgeUIStore.requestModelUnavailable(taskKey, modelId)` before
 * re-throwing, so the picker modal appears instead of a generic error UI.
 */

// jest.setup.js globally mocks '../ai' with fake exports, which shadows the
// real generateApp/editApp/etc. Undo that here — the entire point of this
// test file is to exercise the real ai.ts wrappers.
jest.unmock('../ai');

// Mock the OpenRouter generators layer — we don't want to hit the real
// network stack. The tests substitute the throwing behavior per-case.
jest.mock('../generators', () => ({
    generateSpellCreate: jest.fn(),
    generateSpellEdit: jest.fn(),
    generateConvert: jest.fn(),
    generateWebviewAI: jest.fn(),
}));

// The bridge UI store is where the modal signal lands; capture calls.
// Must be named with `mock` prefix so jest.mock() factory can reference it.
const mockRequestModelUnavailable = jest.fn();
jest.mock('../../bridgeUIStore', () => ({
    useBridgeUIStore: {
        getState: () => ({ requestModelUnavailable: mockRequestModelUnavailable }),
    },
}));

jest.mock('../modelPreferences', () => ({
    getPreferredModel: jest.fn(async () => 'fallback/model'),
}));

jest.mock('../../analytics', () => ({
    logAppCreated: jest.fn(),
    logAppEdited: jest.fn(),
    logAiGenerate: jest.fn(),
    logAiGenerateImage: jest.fn(),
}));

jest.mock('expo-constants', () => ({
    default: { expoConfig: { version: '3.1.2' } },
}));

import { OpenRouterError } from '../openrouter';
import * as generators from '../generators';
import { generateApp, editApp, editAppWithContext, convertNodeProject } from '../ai';

describe('B3 — spell paths surface ModelUnavailableModal', () => {
    beforeEach(() => {
        mockRequestModelUnavailable.mockClear();
        (generators.generateSpellCreate as jest.Mock).mockReset();
        (generators.generateSpellEdit as jest.Mock).mockReset();
        (generators.generateConvert as jest.Mock).mockReset();
    });

    function makeUnavailableError(modelId: string): OpenRouterError {
        return new OpenRouterError(
            'byok.error.modelUnavailable',
            'Model no longer available',
            404,
            false,
            modelId,
        );
    }

    it('generateApp forwards modelUnavailable to the picker signal', async () => {
        (generators.generateSpellCreate as jest.Mock).mockRejectedValueOnce(
            makeUnavailableError('x/dead-model'),
        );

        await expect(generateApp('make me a spell')).rejects.toBeInstanceOf(OpenRouterError);

        expect(mockRequestModelUnavailable).toHaveBeenCalledTimes(1);
        expect(mockRequestModelUnavailable).toHaveBeenCalledWith(null, 'SPELL_S', 'x/dead-model');
    });

    it('editApp forwards modelUnavailable to the picker signal', async () => {
        (generators.generateSpellEdit as jest.Mock).mockRejectedValueOnce(
            makeUnavailableError('y/gone-model'),
        );

        await expect(editApp('<html/>', 'add dark mode')).rejects.toBeInstanceOf(OpenRouterError);

        expect(mockRequestModelUnavailable).toHaveBeenCalledWith(null, 'SPELL_S', 'y/gone-model');
    });

    it('editAppWithContext forwards modelUnavailable to the picker signal', async () => {
        (generators.generateSpellEdit as jest.Mock).mockRejectedValueOnce(
            makeUnavailableError('z/vanished'),
        );

        await expect(
            editAppWithContext('<html/>', 'add dark mode', 'context', [
                { version: 1, instruction: 'first' },
            ]),
        ).rejects.toBeInstanceOf(OpenRouterError);

        expect(mockRequestModelUnavailable).toHaveBeenCalledWith(null, 'SPELL_S', 'z/vanished');
    });

    it('convertNodeProject forwards modelUnavailable to the picker signal', async () => {
        (generators.generateConvert as jest.Mock).mockRejectedValueOnce(
            makeUnavailableError('w/removed'),
        );

        await expect(convertNodeProject('const x = 1;', 'react')).rejects.toBeInstanceOf(OpenRouterError);

        expect(mockRequestModelUnavailable).toHaveBeenCalledWith(null, 'SPELL_S', 'w/removed');
    });

    it('does not fire the signal for unrelated errors', async () => {
        (generators.generateSpellCreate as jest.Mock).mockRejectedValueOnce(
            new OpenRouterError('byok.error.rateLimited', 'slow down', 429),
        );

        await expect(generateApp('anything')).rejects.toBeInstanceOf(OpenRouterError);
        expect(mockRequestModelUnavailable).not.toHaveBeenCalled();
    });

    it('falls back to the preferred model id when the error omits modelId', async () => {
        (generators.generateSpellCreate as jest.Mock).mockRejectedValueOnce(
            new OpenRouterError('byok.error.modelUnavailable', 'gone', 404),
        );

        await expect(generateApp('anything')).rejects.toBeInstanceOf(OpenRouterError);
        expect(mockRequestModelUnavailable).toHaveBeenCalledWith(null, 'SPELL_S', 'fallback/model');
    });
});
