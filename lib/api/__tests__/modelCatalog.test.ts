/**
 * Coverage for the dual-cache model catalog:
 *   Cache A — full `/models` payload with stale-while-revalidate
 *   Cache B — persistent pricing snapshot of user-chosen models
 *
 * The critical invariants:
 *   1. Cache A is only overwritten by a successful refresh — a failed refresh
 *      keeps the old bytes (never "expires to empty").
 *   2. Cache B rows for models that disappear from a fresh catalog are LEFT
 *      INTACT so the user can keep using a deprecated model until they
 *      re-select.
 *   3. `resolvePricingForModel` is synchronous — memo hit, else USD_PRICING_SEED,
 *      else null. Any AI cost calc runs off this without I/O.
 */

const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();
const mockDeleteSetting = jest.fn();
const mockUpsertPricingSnapshot = jest.fn(async () => {});
const mockGetAllPricingSnapshots = jest.fn(async () => [] as { modelId: string; name: string; pricingJson: string }[]);

jest.mock('../../database/db', () => ({
    getSetting: (...args: any[]) => mockGetSetting(...args),
    setSetting: (...args: any[]) => mockSetSetting(...args),
    deleteSetting: (...args: any[]) => mockDeleteSetting(...args),
    upsertPricingSnapshot: (...args: any[]) => mockUpsertPricingSnapshot(...args),
    getAllPricingSnapshots: (...args: any[]) => mockGetAllPricingSnapshots(...args),
}));

jest.mock('../keyStorage', () => ({
    getOpenRouterKey: jest.fn(async () => null),
}));

const originalFetch = global.fetch;

function makeModel(overrides: Partial<import('../modelCatalog').OpenRouterModel> = {}): import('../modelCatalog').OpenRouterModel {
    return {
        id: 'test/model',
        name: 'Test Model',
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0.0000005', completion: '0.000001' },
        supported_parameters: [],
        ...overrides,
    };
}

function mockFetchOk(models: any[]) {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: models }),
    });
}

function mockFetchFail(status = 500) {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status,
        json: async () => ({}),
    });
}

beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn() as any;
    mockGetSetting.mockReset();
    mockSetSetting.mockReset();
    mockDeleteSetting.mockReset();
    mockUpsertPricingSnapshot.mockReset();
    mockUpsertPricingSnapshot.mockImplementation(async () => {});
    mockGetAllPricingSnapshots.mockReset();
    mockGetAllPricingSnapshots.mockResolvedValue([]);
});

afterAll(() => {
    global.fetch = originalFetch;
});

describe('parsePricingFromModel', () => {
    it('converts per-token USD strings to per-M-token numbers', () => {
        const { parsePricingFromModel } = require('../modelCatalog');
        const parsed = parsePricingFromModel(makeModel({
            pricing: { prompt: '0.0000005', completion: '0.000003', web_search: '0.014' },
        }));
        // 0.0000005 * 1_000_000 = 0.5
        expect(parsed.inputPerMToken).toBeCloseTo(0.5, 6);
        expect(parsed.outputPerMToken).toBeCloseTo(3.0, 6);
        expect(parsed.searchPerQuery).toBeCloseTo(0.014, 6);
    });

    it('returns null when the model has no pricing', () => {
        const { parsePricingFromModel } = require('../modelCatalog');
        expect(parsePricingFromModel({ id: 'x' })).toBeNull();
    });
});

describe('getModelCatalog (Cache A stale-while-revalidate)', () => {
    it('returns fresh cache (<24h) without calling the network', async () => {
        const cached = [makeModel({ id: 'cached/one' })];
        mockGetSetting.mockImplementation(async (k: string) => {
            if (k === 'model_catalog_json') return JSON.stringify(cached);
            if (k === 'model_catalog_fetched_at') return String(Date.now() - 1000);
            return null;
        });

        const { getModelCatalog } = require('../modelCatalog');
        const out = await getModelCatalog();

        expect(out).toEqual(cached);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns stale cache immediately AND fires a background refresh', async () => {
        const stale = [makeModel({ id: 'stale/one' })];
        const fresh = [makeModel({ id: 'fresh/one' })];
        mockGetSetting.mockImplementation(async (k: string) => {
            if (k === 'model_catalog_json') return JSON.stringify(stale);
            if (k === 'model_catalog_fetched_at') return String(Date.now() - 48 * 60 * 60 * 1000);
            return null;
        });
        mockFetchOk(fresh);

        const { getModelCatalog } = require('../modelCatalog');
        const out = await getModelCatalog();

        expect(out).toEqual(stale);
        // Give the fire-and-forget refresh a tick to run.
        await new Promise(r => setImmediate(r));
        expect(mockSetSetting).toHaveBeenCalledWith('model_catalog_json', JSON.stringify(fresh));
    });

    it('stale cache + refresh FAILS keeps old bytes intact', async () => {
        const stale = [makeModel({ id: 'stale/one' })];
        mockGetSetting.mockImplementation(async (k: string) => {
            if (k === 'model_catalog_json') return JSON.stringify(stale);
            if (k === 'model_catalog_fetched_at') return String(Date.now() - 48 * 60 * 60 * 1000);
            return null;
        });
        mockFetchFail(500);

        const { getModelCatalog } = require('../modelCatalog');
        const out = await getModelCatalog();

        expect(out).toEqual(stale);
        await new Promise(r => setImmediate(r));
        // The failing refresh must not have written a new catalog.
        expect(mockSetSetting).not.toHaveBeenCalledWith('model_catalog_json', expect.anything());
    });

    it('no cache + fetch OK writes the catalog', async () => {
        mockGetSetting.mockResolvedValue(null);
        const fresh = [makeModel({ id: 'fresh/one' })];
        mockFetchOk(fresh);

        const { getModelCatalog } = require('../modelCatalog');
        const out = await getModelCatalog();
        expect(out).toEqual(fresh);
        expect(mockSetSetting).toHaveBeenCalledWith('model_catalog_json', JSON.stringify(fresh));
    });

    it('no cache + fetch FAILS propagates the error', async () => {
        mockGetSetting.mockResolvedValue(null);
        mockFetchFail(503);

        const { getModelCatalog } = require('../modelCatalog');
        await expect(getModelCatalog()).rejects.toThrow(/503/);
    });

    it('force: true always awaits fresh and propagates failures', async () => {
        mockGetSetting.mockImplementation(async (k: string) => {
            if (k === 'model_catalog_json') return JSON.stringify([makeModel()]);
            if (k === 'model_catalog_fetched_at') return String(Date.now() - 1000);
            return null;
        });
        mockFetchFail(429);

        const { getModelCatalog } = require('../modelCatalog');
        await expect(getModelCatalog({ force: true })).rejects.toThrow(/429/);
    });
});

describe('filterModelsForTask', () => {
    it('excludes models missing a required input modality', () => {
        const { filterModelsForTask } = require('../modelCatalog');
        const catalog = [
            makeModel({ id: 'text-only', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }),
            makeModel({ id: 'text-image-audio', architecture: { input_modalities: ['text', 'image', 'audio'], output_modalities: ['text'] } }),
        ];
        const out = filterModelsForTask('WEBVIEW', catalog);
        expect(out.map((m: any) => m.id)).toEqual(['text-image-audio']);
    });

    it('applies requiredParams (reasoning for SPELL_S)', () => {
        const { filterModelsForTask } = require('../modelCatalog');
        const catalog = [
            makeModel({ id: 'no-reason', supported_parameters: [] }),
            makeModel({ id: 'reason', supported_parameters: ['reasoning'] }),
        ];
        const out = filterModelsForTask('SPELL_S', catalog);
        expect(out.map((m: any) => m.id)).toEqual(['reason']);
    });

    it('EMBED matches models tagged output_modalities: [embeddings] (no id heuristic)', () => {
        const { filterModelsForTask } = require('../modelCatalog');
        const catalog = [
            // OpenRouter tags these cleanly; the picker must not rely on the
            // "embedding" substring anymore.
            makeModel({
                id: 'openai/text-embedding-3-small',
                architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] },
            }),
            makeModel({
                id: 'nvidia/nemotron-3-embed-1b',
                architecture: { input_modalities: ['text', 'image'], output_modalities: ['embeddings'] },
            }),
            makeModel({ id: 'chat/only', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }),
        ];
        const out = filterModelsForTask('EMBED', catalog);
        expect(out.map((m: any) => m.id).sort()).toEqual([
            'nvidia/nemotron-3-embed-1b',
            'openai/text-embedding-3-small',
        ]);
    });

    it('TTS matches models tagged output_modalities: [speech]', () => {
        const { filterModelsForTask } = require('../modelCatalog');
        const catalog = [
            makeModel({
                id: 'openai/gpt-4o-mini-tts',
                architecture: { input_modalities: ['text'], output_modalities: ['speech'] },
            }),
            makeModel({
                id: 'google/lyria-3-pro-preview',
                architecture: { input_modalities: ['text'], output_modalities: ['audio'] },
            }),
        ];
        const out = filterModelsForTask('TTS', catalog);
        expect(out.map((m: any) => m.id)).toEqual(['openai/gpt-4o-mini-tts']);
    });

    it('VIDEO_FAST matches any video model that accepts text (text-only or text+image)', () => {
        const { filterModelsForTask } = require('../modelCatalog');
        const catalog = [
            makeModel({
                id: 'google/veo-3.1-lite',
                architecture: { input_modalities: ['text'], output_modalities: ['video'] },
            }),
            makeModel({
                id: 'x-ai/grok-imagine-video-1.5',
                architecture: { input_modalities: ['text', 'image'], output_modalities: ['video'] },
            }),
        ];
        const out = filterModelsForTask('VIDEO_FAST', catalog);
        expect(out.map((m: any) => m.id).sort()).toEqual([
            'google/veo-3.1-lite',
            'x-ai/grok-imagine-video-1.5',
        ]);
    });

    it('VIDEO_STD excludes text-only video models (needs text + image input)', () => {
        const { filterModelsForTask } = require('../modelCatalog');
        const catalog = [
            makeModel({
                id: 'google/veo-3.1-lite',
                architecture: { input_modalities: ['text'], output_modalities: ['video'] },
            }),
            makeModel({
                id: 'x-ai/grok-imagine-video-1.5',
                architecture: { input_modalities: ['text', 'image'], output_modalities: ['video'] },
            }),
        ];
        const out = filterModelsForTask('VIDEO_STD', catalog);
        expect(out.map((m: any) => m.id)).toEqual(['x-ai/grok-imagine-video-1.5']);
    });

    it('MUSIC still uses id-substring heuristic to scope to known providers', () => {
        const { filterModelsForTask } = require('../modelCatalog');
        const catalog = [
            makeModel({
                id: 'google/lyria-3-pro-preview',
                architecture: { input_modalities: ['text'], output_modalities: ['audio'] },
            }),
            makeModel({
                // Voice-cloning model with the same output modality as Lyria —
                // must not cross-list.
                id: 'someprovider/voiceclone-1',
                architecture: { input_modalities: ['text'], output_modalities: ['audio'] },
            }),
        ];
        const out = filterModelsForTask('MUSIC', catalog);
        expect(out.map((m: any) => m.id)).toEqual(['google/lyria-3-pro-preview']);
    });
});

describe('fetchOpenRouterModels (multi-modality merge)', () => {
    it('merges base + embeddings + video + speech + image slices, deduping by id', async () => {
        const chat = [makeModel({ id: 'chat/one' })];
        const emb = [makeModel({
            id: 'openai/text-embedding-3-small',
            architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] },
        })];
        const vid = [makeModel({
            id: 'google/veo-3.1',
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['video'] },
        })];
        const spc = [makeModel({
            id: 'openai/gpt-4o-mini-tts',
            architecture: { input_modalities: ['text'], output_modalities: ['speech'] },
        })];
        const img = [makeModel({
            id: 'black-forest-labs/flux.2-pro',
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
        })];
        // Order matches Promise.allSettled invocation: base, embeddings, video, speech, image.
        mockFetchOk(chat);
        mockFetchOk(emb);
        mockFetchOk(vid);
        mockFetchOk(spc);
        mockFetchOk(img);

        const { fetchOpenRouterModels } = require('../modelCatalog');
        const merged = await fetchOpenRouterModels();
        const ids = merged.map((m: any) => m.id).sort();
        expect(ids).toEqual([
            'black-forest-labs/flux.2-pro',
            'chat/one',
            'google/veo-3.1',
            'openai/gpt-4o-mini-tts',
            'openai/text-embedding-3-small',
        ]);
    });

    it('tolerates modality slice failure — still returns base models', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const chat = [makeModel({ id: 'chat/one' })];
        mockFetchOk(chat);       // base OK
        mockFetchFail(500);      // embeddings fails
        mockFetchFail(500);      // video fails
        mockFetchFail(500);      // speech fails
        mockFetchFail(500);      // image fails

        const { fetchOpenRouterModels } = require('../modelCatalog');
        const out = await fetchOpenRouterModels();
        expect(out.map((m: any) => m.id)).toEqual(['chat/one']);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('base slice failure propagates (catalog cannot be built without chat models)', async () => {
        mockFetchFail(503);      // base fails
        mockFetchOk([]);         // slices ok (but useless without base)
        mockFetchOk([]);
        mockFetchOk([]);
        mockFetchOk([]);

        const { fetchOpenRouterModels } = require('../modelCatalog');
        await expect(fetchOpenRouterModels()).rejects.toThrow(/503/);
    });
});

describe('Cache B — snapshot + resolvePricingForModel', () => {
    it('resolvePricingForModel falls back to USD_PRICING_SEED when memo is empty', () => {
        const { resolvePricingForModel } = require('../modelCatalog');
        const seed = resolvePricingForModel('deepseek/deepseek-v4-flash');
        expect(seed).not.toBeNull();
        expect(seed?.inputPerMToken).toBeGreaterThan(0);
    });

    it('resolvePricingForModel returns null for unknown ids with no memo/seed hit', () => {
        const { resolvePricingForModel } = require('../modelCatalog');
        expect(resolvePricingForModel('nobody/nobody')).toBeNull();
    });

    it('loadPricingSnapshotIntoMemory populates memo from SQLite', async () => {
        mockGetAllPricingSnapshots.mockResolvedValueOnce([
            {
                modelId: 'openai/gpt-4o',
                name: 'GPT-4o',
                pricingJson: JSON.stringify({ inputPerMToken: 5, outputPerMToken: 15 }),
            },
        ]);
        const { loadPricingSnapshotIntoMemory, resolvePricingForModel } = require('../modelCatalog');
        await loadPricingSnapshotIntoMemory();
        const p = resolvePricingForModel('openai/gpt-4o');
        expect(p?.inputPerMToken).toBe(5);
        expect(p?.outputPerMToken).toBe(15);
    });

    it('snapshotPricing writes to Cache B and updates the memo', async () => {
        const { snapshotPricing, resolvePricingForModel } = require('../modelCatalog');
        await snapshotPricing('anthropic/claude-3.5-sonnet', makeModel({
            id: 'anthropic/claude-3.5-sonnet',
            name: 'Claude 3.5 Sonnet',
            pricing: { prompt: '0.000003', completion: '0.000015' },
        }));
        expect(mockUpsertPricingSnapshot).toHaveBeenCalledWith(
            'anthropic/claude-3.5-sonnet',
            'Claude 3.5 Sonnet',
            expect.any(String),
        );
        const p = resolvePricingForModel('anthropic/claude-3.5-sonnet');
        expect(p?.inputPerMToken).toBeCloseTo(3, 6);
    });

    it('snapshotPricing writes a zero-pricing row when model has no pricing block', async () => {
        // Regression guard: previously, snapshotPricing returned silently when
        // parsePricingFromModel returned null, leaving pricingMemo empty for
        // the chosen model. That turned every cost estimate into 0.
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { snapshotPricing, resolvePricingForModel } = require('../modelCatalog');
        await snapshotPricing('mystery/no-pricing', {
            id: 'mystery/no-pricing',
            name: 'Mystery Model',
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        } as any);
        expect(mockUpsertPricingSnapshot).toHaveBeenCalledWith(
            'mystery/no-pricing',
            'Mystery Model',
            expect.any(String),
        );
        const p = resolvePricingForModel('mystery/no-pricing');
        expect(p).toEqual({ inputPerMToken: 0, outputPerMToken: 0 });
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('syncSnapshotFromCatalog upgrades a zero-pricing row when the model reappears with real pricing', async () => {
        mockGetAllPricingSnapshots.mockResolvedValueOnce([
            {
                modelId: 'mystery/no-pricing',
                name: 'Mystery Model',
                pricingJson: JSON.stringify({ inputPerMToken: 0, outputPerMToken: 0 }),
            },
        ]);
        const { loadPricingSnapshotIntoMemory, syncSnapshotFromCatalog, resolvePricingForModel } = require('../modelCatalog');
        await loadPricingSnapshotIntoMemory();

        await syncSnapshotFromCatalog([
            makeModel({
                id: 'mystery/no-pricing',
                pricing: { prompt: '0.000004', completion: '0.000008' },
            }),
        ]);

        const upgraded = resolvePricingForModel('mystery/no-pricing');
        expect(upgraded?.inputPerMToken).toBeCloseTo(4, 6);
        expect(upgraded?.outputPerMToken).toBeCloseTo(8, 6);
    });

    it('syncSnapshotFromCatalog updates existing rows but does NOT delete rows whose model disappeared', async () => {
        mockGetAllPricingSnapshots.mockResolvedValueOnce([
            {
                modelId: 'still-here/v1',
                name: 'Still Here v1',
                pricingJson: JSON.stringify({ inputPerMToken: 1, outputPerMToken: 2 }),
            },
            {
                modelId: 'gone/v0',
                name: 'Gone v0',
                pricingJson: JSON.stringify({ inputPerMToken: 99, outputPerMToken: 99 }),
            },
        ]);

        const { loadPricingSnapshotIntoMemory, syncSnapshotFromCatalog, resolvePricingForModel } = require('../modelCatalog');
        await loadPricingSnapshotIntoMemory();

        // Fresh catalog only contains still-here/v1, with new pricing.
        await syncSnapshotFromCatalog([
            makeModel({
                id: 'still-here/v1',
                pricing: { prompt: '0.0000025', completion: '0.000005' },
            }),
        ]);

        // still-here/v1 updated
        const updated = resolvePricingForModel('still-here/v1');
        expect(updated?.inputPerMToken).toBeCloseTo(2.5, 6);
        // gone/v0 left intact — its old price still resolves
        const preserved = resolvePricingForModel('gone/v0');
        expect(preserved?.inputPerMToken).toBe(99);
        // Only the still-present model was written back.
        const writtenIds = mockUpsertPricingSnapshot.mock.calls.map((c: any[]) => c[0]);
        expect(writtenIds).toEqual(['still-here/v1']);
    });
});

describe('findMissingModelTasks', () => {
    it('flags tasks whose chosen model is not in the catalog', () => {
        const { findMissingModelTasks } = require('../modelCatalog');
        const catalog = [makeModel({ id: 'in-catalog/one' })];
        const missing = findMissingModelTasks(catalog, {
            SPELL_S: 'in-catalog/one',
            WEBVIEW: 'gone/deprecated',
        });
        expect(missing).toEqual(['WEBVIEW']);
    });
});
