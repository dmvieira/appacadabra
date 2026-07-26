/**
 * Dynamic OpenRouter model catalog + persistent pricing snapshot for BYOK.
 *
 * Two caches:
 *   Cache A — full `/api/v1/models` payload in `app_settings`
 *     (`model_catalog_json` + `model_catalog_fetched_at`). Populates the
 *     ModelPicker. Stale-while-revalidate: after 24h the app tries to
 *     refresh; a failed refresh keeps the old cache intact (never
 *     "expires to empty").
 *   Cache B — pricing snapshot of models the user has actually chosen,
 *     in the `model_pricing_snapshot` SQLite table. Rows are only written
 *     when the user confirms a selection, and never deleted. Guarantees
 *     that once a user has picked a model, its price is always resolvable
 *     locally — even offline or after OpenRouter deprecates it.
 *
 * A hot in-memory Map (`pricingMemo`) loaded from Cache B at startup gives
 * synchronous O(1) price lookups from any `calculateCostUsd` call — no I/O
 * per AI request.
 */

import { OR_BASE_URL, MODELS, USD_PRICING_SEED, type CatalogPricing } from './pricing';
import { getOpenRouterKey } from './keyStorage';
import {
    getSetting,
    setSetting,
    upsertPricingSnapshot,
    getAllPricingSnapshots,
} from '../database/db';

// ============= RAW /models RESPONSE SHAPES =============

export interface OpenRouterModelArchitecture {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
    tokenizer?: string;
}

export interface OpenRouterModelPricing {
    prompt?: string;
    completion?: string;
    image?: string;
    request?: string;
    web_search?: string;
    input_cache_read?: string;
    input_cache_write?: string;
    audio?: string;
    video?: string;
}

export interface OpenRouterModel {
    id: string;
    name?: string;
    context_length?: number;
    architecture?: OpenRouterModelArchitecture;
    pricing?: OpenRouterModelPricing;
    supported_parameters?: string[];
    top_provider?: { context_length?: number };
}

interface CachedCatalog {
    fetchedAt: number;
    models: OpenRouterModel[];
}

// ============= CACHE A KEYS =============

const CACHE_KEY_JSON = 'model_catalog_json';
const CACHE_KEY_FETCHED_AT = 'model_catalog_fetched_at';
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// ============= CACHE B HOT MEMO =============

const pricingMemo: Map<string, CatalogPricing> = new Map();
let pricingMemoLoaded = false;
// Dedups concurrent `loadPricingSnapshotIntoMemory()` calls. Two callers
// arriving before the first `getAllPricingSnapshots()` resolves used to
// hit SQLite twice; both now await the same promise.
let pricingMemoLoadInFlight: Promise<void> | null = null;

// ============= TASK REQUIREMENTS (canonical filter table) =============

export type TaskKey = keyof typeof MODELS;

export interface TaskRequirement {
    input: string[];
    output: string[];
    requiredParams?: string[];
    /**
     * MUSIC shares its `output: ['audio']` modality with any future audio
     * model, so it's scoped by id-substring to the known music providers.
     * TTS and EMBED used to have similar flags but OpenRouter now tags them
     * with dedicated `output_modalities` values (`speech`, `embeddings`) so
     * the modality check alone is enough.
     */
    isMusic?: boolean;
}

// Whitelist substrings for id/name matching. Extend when OpenRouter adds
// new providers (Suno/MusicGen/…).
const MUSIC_ID_HINTS = ['lyria', 'musicgen', 'suno'];

export const TASK_REQUIREMENTS: Record<TaskKey, TaskRequirement> = {
    SPELL_S: { input: ['text'], output: ['text'], requiredParams: ['reasoning'] },
    WEBVIEW: { input: ['text', 'image', 'audio', 'file'], output: ['text'] },
    IMAGE: { input: ['text'], output: ['image'] },
    IMAGE_EDIT: { input: ['text', 'image'], output: ['image'] },
    TTS: { input: ['text'], output: ['speech'] },
    MUSIC: { input: ['text'], output: ['audio'], isMusic: true },
    EMBED: { input: ['text'], output: ['embeddings'] },
    VIDEO_FAST: { input: ['text'], output: ['video'] },
    VIDEO_STD: { input: ['text', 'image'], output: ['video'] },
};

/**
 * i18n label key per task. Kept alongside TASK_REQUIREMENTS so any new task
 * added here has a paired label key in the strings table.
 */
export const TASK_LABEL_KEYS: Record<TaskKey, string> = {
    SPELL_S: 'openrouterTaskSpellS',
    WEBVIEW: 'openrouterTaskWebview',
    IMAGE: 'openrouterTaskImage',
    IMAGE_EDIT: 'openrouterTaskImageEdit',
    TTS: 'openrouterTaskTts',
    MUSIC: 'openrouterTaskMusic',
    EMBED: 'openrouterTaskEmbed',
    VIDEO_FAST: 'openrouterTaskVideoFast',
    VIDEO_STD: 'openrouterTaskVideoStd',
};

// ============= FETCH =============

// `GET /api/v1/models` without a filter returns only chat/completion models.
// Non-chat modalities (embeddings, video, speech, image) require the
// `?output_modalities=<X>` query param to appear. We fetch the base + one
// slice per non-chat modality in parallel and merge them into a single
// catalog. Add new slices here as OpenRouter surfaces new modalities.
const MODALITY_SLICES = ['embeddings', 'video', 'speech', 'image'] as const;

async function fetchModelsSlice(
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
): Promise<OpenRouterModel[]> {
    const response = await fetch(url, { method: 'GET', headers, signal });
    if (!response.ok) {
        throw new Error(`OpenRouter ${url} returned ${response.status}`);
    }
    const json = (await response.json()) as { data: OpenRouterModel[] };
    return json.data ?? [];
}

/**
 * Calls `GET /api/v1/models` plus one slice per non-chat modality
 * (`?output_modalities=embeddings|video|speech`) in parallel and merges the
 * results by `id`. The base slice is critical — its failure propagates.
 * Modality slice failures are logged but non-fatal so a single flaky
 * endpoint can't wipe the whole catalog.
 *
 * Auth is optional for `/models` but we pass the user's key when available
 * for attribution/consistency.
 */
export async function fetchOpenRouterModels(signal?: AbortSignal): Promise<OpenRouterModel[]> {
    const key = await getOpenRouterKey();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;

    const baseUrl = `${OR_BASE_URL}/models`;
    const [baseResult, ...sliceResults] = await Promise.allSettled([
        fetchModelsSlice(baseUrl, headers, signal),
        ...MODALITY_SLICES.map(m =>
            fetchModelsSlice(`${baseUrl}?output_modalities=${m}`, headers, signal),
        ),
    ]);

    if (baseResult.status === 'rejected') {
        throw baseResult.reason;
    }

    const byId = new Map<string, OpenRouterModel>();
    for (const model of baseResult.value) byId.set(model.id, model);
    for (const result of sliceResults) {
        if (result.status === 'fulfilled') {
            for (const model of result.value) byId.set(model.id, model);
        } else {
            console.warn('[modelCatalog] modality slice fetch failed:', result.reason);
        }
    }
    return Array.from(byId.values());
}

// ============= CATALOG (Cache A) =============

async function readCachedCatalog(): Promise<CachedCatalog | null> {
    const [rawJson, rawFetchedAt] = await Promise.all([
        getSetting(CACHE_KEY_JSON),
        getSetting(CACHE_KEY_FETCHED_AT),
    ]);
    if (!rawJson || !rawFetchedAt) return null;
    try {
        const models = JSON.parse(rawJson) as OpenRouterModel[];
        const fetchedAt = Number(rawFetchedAt);
        if (!Number.isFinite(fetchedAt)) return null;
        return { fetchedAt, models };
    } catch {
        return null;
    }
}

async function writeCatalog(models: OpenRouterModel[]): Promise<void> {
    const now = Date.now();
    await Promise.all([
        setSetting(CACHE_KEY_JSON, JSON.stringify(models)),
        setSetting(CACHE_KEY_FETCHED_AT, String(now)),
    ]);
}

let backgroundRefreshInFlight: Promise<void> | null = null;
// Dedups concurrent cold-start `getModelCatalog()` calls with no cache —
// two mounts firing at once used to trigger two `/models` fetches (one per
// caller). Merged into a single in-flight promise; both callers await it.
let coldStartFetchInFlight: Promise<OpenRouterModel[]> | null = null;

function fireBackgroundRefresh(): void {
    if (backgroundRefreshInFlight) return;
    backgroundRefreshInFlight = (async () => {
        try {
            const fresh = await fetchOpenRouterModels();
            await writeCatalog(fresh);
            await syncSnapshotFromCatalog(fresh);
        } catch {
            // Refresh failed — old cache stays intact, fetchedAt unchanged,
            // next call will try again.
        } finally {
            backgroundRefreshInFlight = null;
        }
    })();
}

/**
 * Returns the catalog with stale-while-revalidate semantics:
 *   - Fresh cache → return immediately, no fetch.
 *   - Stale cache → return immediately, dispatch refresh in background.
 *   - No cache → await fetch, propagate errors.
 *   - `force: true` → always await, always propagate.
 */
export async function getModelCatalog(opts?: { force?: boolean }): Promise<OpenRouterModel[]> {
    if (opts?.force) {
        const fresh = await fetchOpenRouterModels();
        await writeCatalog(fresh);
        await syncSnapshotFromCatalog(fresh);
        return fresh;
    }

    const cached = await readCachedCatalog();
    if (cached) {
        const age = Date.now() - cached.fetchedAt;
        if (age >= STALE_AFTER_MS) fireBackgroundRefresh();
        return cached.models;
    }

    if (coldStartFetchInFlight) return coldStartFetchInFlight;
    coldStartFetchInFlight = (async () => {
        try {
            const fresh = await fetchOpenRouterModels();
            await writeCatalog(fresh);
            await syncSnapshotFromCatalog(fresh);
            return fresh;
        } finally {
            coldStartFetchInFlight = null;
        }
    })();
    return coldStartFetchInFlight;
}

// ============= PRICING PARSER =============

/**
 * Converts OpenRouter's per-token USD strings to our internal per-M-token
 * numbers. OpenRouter returns `"prompt": "0.0000005"` meaning $0.50 / M
 * tokens; multiply by 1_000_000. `web_search` and `request` come as
 * per-request USD; kept as-is.
 */
export function parsePricingFromModel(model: OpenRouterModel): CatalogPricing | null {
    const p = model.pricing;
    if (!p) return null;
    const perM = (s?: string): number => {
        if (!s) return 0;
        const n = Number(s);
        return Number.isFinite(n) ? n * 1_000_000 : 0;
    };
    const perReq = (s?: string): number | undefined => {
        if (!s) return undefined;
        const n = Number(s);
        return Number.isFinite(n) ? n : undefined;
    };
    return {
        inputPerMToken: perM(p.prompt),
        outputPerMToken: perM(p.completion),
        audioInputPerMToken: p.audio ? perM(p.audio) : undefined,
        searchPerQuery: perReq(p.web_search),
    };
}

// ============= CACHE B — SNAPSHOT (persistent) =============

/**
 * Loads all rows from `model_pricing_snapshot` into `pricingMemo`. Idempotent;
 * safe to call multiple times. Call once at app startup before any AI call.
 */
export async function loadPricingSnapshotIntoMemory(): Promise<void> {
    if (pricingMemoLoaded) return;
    if (pricingMemoLoadInFlight) return pricingMemoLoadInFlight;
    pricingMemoLoadInFlight = (async () => {
        try {
            const rows = await getAllPricingSnapshots();
            for (const row of rows) {
                try {
                    const pricing = JSON.parse(row.pricingJson) as CatalogPricing;
                    pricingMemo.set(row.modelId, pricing);
                } catch {
                    // Skip corrupted rows.
                }
            }
        } catch (e) {
            console.warn('[modelCatalog] Failed to load pricing snapshot:', e);
        } finally {
            pricingMemoLoaded = true;
            pricingMemoLoadInFlight = null;
        }
    })();
    return pricingMemoLoadInFlight;
}

/**
 * Snapshots the given model's pricing to Cache B and updates the hot memo.
 * Called when the user confirms a selection in the ModelPicker.
 *
 * If the model has no `pricing` object on the catalog (rare — happens when
 * OpenRouter omits the field), we still snapshot a zero-priced row. Rationale:
 *   1. `usage.cost` from the real API response remains the primary cost
 *      source, so spend is still recorded correctly.
 *   2. `syncSnapshotFromCatalog` upgrades the zero row to real pricing the
 *      next time the model reappears in the catalog with a pricing block.
 * The alternative (early-return) silently left `pricingMemo` empty for that
 * model, which turned every cost estimate into 0 for the whole session.
 */
export async function snapshotPricing(modelId: string, model: OpenRouterModel): Promise<void> {
    let pricing = parsePricingFromModel(model);
    if (!pricing) {
        console.warn(`[modelCatalog] Snapshotting ${modelId} with zero pricing — /models row had no pricing block`);
        pricing = { inputPerMToken: 0, outputPerMToken: 0 };
    }
    pricingMemo.set(modelId, pricing);
    await upsertPricingSnapshot(modelId, model.name ?? modelId, JSON.stringify(pricing));
}

/**
 * After a successful catalog refresh, update `pricingJson` for every snapshot
 * row whose model is still in the fresh catalog. Rows for models that no
 * longer appear are LEFT INTACT — their prices remain usable locally so the
 * user can keep using a deprecated model until they re-select.
 */
export async function syncSnapshotFromCatalog(catalog: OpenRouterModel[]): Promise<void> {
    if (!pricingMemoLoaded) await loadPricingSnapshotIntoMemory();
    if (pricingMemo.size === 0) return;

    const catalogById = new Map(catalog.map(m => [m.id, m]));
    for (const modelId of pricingMemo.keys()) {
        const fresh = catalogById.get(modelId);
        if (!fresh) continue;
        const parsed = parsePricingFromModel(fresh);
        if (!parsed) continue;
        pricingMemo.set(modelId, parsed);
        try {
            await upsertPricingSnapshot(modelId, fresh.name ?? modelId, JSON.stringify(parsed));
        } catch (e) {
            console.warn(`[modelCatalog] Failed to sync ${modelId}:`, e);
        }
    }
}

/**
 * Synchronous price lookup used by `calculateCostUsd` on every AI response.
 * Order: hot memo (Cache B) → USD_PRICING_SEED fallback → null.
 */
export function resolvePricingForModel(modelId: string): CatalogPricing | null {
    const memo = pricingMemo.get(modelId);
    if (memo) return memo;
    const seed = USD_PRICING_SEED[modelId];
    if (seed) return seed;
    return null;
}

// ============= FILTERING =============

function hasAll(list: string[] | undefined, required: string[]): boolean {
    if (required.length === 0) return true;
    if (!list) return false;
    return required.every(r => list.includes(r));
}

/**
 * Filters the catalog to models that satisfy a task's I/O modality and
 * parameter requirements.
 */
export function filterModelsForTask(taskKey: TaskKey, catalog: OpenRouterModel[]): OpenRouterModel[] {
    const req = TASK_REQUIREMENTS[taskKey];
    return catalog.filter(m => {
        const arch = m.architecture;
        if (!hasAll(arch?.input_modalities, req.input)) return false;
        if (!hasAll(arch?.output_modalities, req.output)) return false;
        if (req.requiredParams && !hasAll(m.supported_parameters, req.requiredParams)) return false;
        if (req.isMusic) {
            // MUSIC shares `output: ['audio']` with any other audio-output
            // model (e.g. voice cloning). Scope to known music providers so
            // the picker doesn't cross-list them.
            const id = m.id.toLowerCase();
            const name = (m.name ?? '').toLowerCase();
            return MUSIC_ID_HINTS.some(h => id.includes(h) || name.includes(h));
        }
        return true;
    });
}

// ============= MISSING-MODEL DETECTION (for startup badge) =============

/**
 * Given the current catalog and the user's chosen model IDs (one per task),
 * returns the task keys whose chosen model is not in the catalog. Used by
 * the store to compute `missingModelTasks`.
 */
export function findMissingModelTasks(
    catalog: OpenRouterModel[],
    chosenByTask: Partial<Record<TaskKey, string>>,
): TaskKey[] {
    const ids = new Set(catalog.map(m => m.id));
    const missing: TaskKey[] = [];
    for (const [taskKey, modelId] of Object.entries(chosenByTask) as [TaskKey, string][]) {
        if (!modelId) continue;
        if (!ids.has(modelId)) missing.push(taskKey);
    }
    return missing;
}
