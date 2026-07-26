/**
 * Contract: per-task model selection follows the chain:
 *   1. user override (`model.<TASK>` in `app_settings`)
 *   2. current AI tier's default (`TIER_MODELS[tier][task]`)
 *   3. hardcoded safety net (`MODELS[task]`)
 * A regression at any layer silently changes which model runs for millions of
 * calls, so each layer has an explicit test.
 */

const store = new Map<string, string | null>();
const mockGetSetting = jest.fn(async (key: string) => store.get(key) ?? null);
const mockSetSetting = jest.fn(async (key: string, value: string) => { store.set(key, value); });
const mockDeleteSetting = jest.fn(async (key: string) => { store.delete(key); });

jest.mock('../../database/db', () => ({
    getSetting: (...args: any[]) => mockGetSetting(...(args as [string])),
    setSetting: (...args: any[]) => mockSetSetting(...(args as [string, string])),
    deleteSetting: (...args: any[]) => mockDeleteSetting(...(args as [string])),
}));

import {
    getPreferredModel,
    setPreferredModel,
    clearPreferredModel,
    clearAllModelPreferences,
    getAllPreferredModels,
    getAiTier,
    setAiTier,
    getTierDefaultModel,
} from '../modelPreferences';
import { MODELS, TIER_MODELS, DEFAULT_AI_TIER } from '../pricing';

beforeEach(() => {
    store.clear();
    mockGetSetting.mockClear();
    mockSetSetting.mockClear();
    mockDeleteSetting.mockClear();
});

describe('getAiTier', () => {
    it('returns DEFAULT_AI_TIER when nothing is stored', async () => {
        expect(await getAiTier()).toBe(DEFAULT_AI_TIER);
    });

    it('roundtrips through setAiTier', async () => {
        await setAiTier('archmage');
        expect(await getAiTier()).toBe('archmage');
    });

    it('ignores an unknown stored value and falls back to default', async () => {
        store.set('ai.tier', 'demigod');
        expect(await getAiTier()).toBe(DEFAULT_AI_TIER);
    });
});

describe('getPreferredModel', () => {
    it('returns the user override when set', async () => {
        store.set('model.TTS', 'openai/gpt-4o-audio');
        expect(await getPreferredModel('TTS')).toBe('openai/gpt-4o-audio');
    });

    it('falls back to the current tier default when no override', async () => {
        await setAiTier('apprentice');
        expect(await getPreferredModel('SPELL_S')).toBe(TIER_MODELS.apprentice.SPELL_S);
    });

    it('uses the default tier (sorcerer) when no tier has been picked', async () => {
        expect(await getPreferredModel('SPELL_S')).toBe(TIER_MODELS.sorcerer.SPELL_S);
    });

    it('treats an empty saved value as unset', async () => {
        store.set('model.SPELL_S', '');
        expect(await getPreferredModel('SPELL_S')).toBe(TIER_MODELS.sorcerer.SPELL_S);
    });
});

describe('getTierDefaultModel', () => {
    it('returns the tier map value without consulting user overrides', async () => {
        store.set('model.WEBVIEW', 'user/custom-model');
        await setAiTier('archmage');
        expect(await getTierDefaultModel('WEBVIEW')).toBe(TIER_MODELS.archmage.WEBVIEW);
    });
});

describe('setPreferredModel', () => {
    it('writes to app_settings under the model.<TASK> key', async () => {
        await setPreferredModel('WEBVIEW', 'anthropic/claude-3.5-sonnet');
        expect(mockSetSetting).toHaveBeenCalledWith('model.WEBVIEW', 'anthropic/claude-3.5-sonnet');
    });
});

describe('clearPreferredModel', () => {
    it('deletes the row so subsequent reads fall back to the tier default', async () => {
        await setPreferredModel('IMAGE', 'foo/bar');
        await clearPreferredModel('IMAGE');
        expect(mockDeleteSetting).toHaveBeenCalledWith('model.IMAGE');
        expect(await getPreferredModel('IMAGE')).toBe(TIER_MODELS.sorcerer.IMAGE);
    });
});

describe('clearAllModelPreferences', () => {
    it('deletes every model.<TASK> row', async () => {
        for (const k of Object.keys(MODELS)) {
            await setPreferredModel(k as keyof typeof MODELS, `custom/${k}`);
        }
        await clearAllModelPreferences();
        for (const k of Object.keys(MODELS)) {
            expect(mockDeleteSetting).toHaveBeenCalledWith(`model.${k}`);
        }
    });

    it('leaves ai.tier untouched', async () => {
        await setAiTier('apprentice');
        await clearAllModelPreferences();
        expect(await getAiTier()).toBe('apprentice');
    });
});

describe('getAllPreferredModels', () => {
    it('returns one entry per task, defaulting to the current tier', async () => {
        await setAiTier('archmage');
        const all = await getAllPreferredModels();
        expect(Object.keys(all).sort()).toEqual(Object.keys(MODELS).sort());
        for (const k of Object.keys(MODELS) as (keyof typeof MODELS)[]) {
            expect(all[k]).toBe(TIER_MODELS.archmage[k]);
        }
    });
});
