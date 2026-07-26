/**
 * Per-task user preferences for which OpenRouter model to use.
 *
 * Storage layout in `app_settings`:
 *   - `model.<TASK_KEY>` — the user's explicit choice for one task (optional).
 *   - `ai.tier` — the currently selected AI tier ('apprentice' | 'sorcerer'
 *     | 'archmage'). When absent, `DEFAULT_AI_TIER` ('sorcerer') is used.
 *
 * Resolution chain for `getPreferredModel(task)`:
 *   1. User's per-task pref (`model.<TASK>`), if set.
 *   2. `TIER_MODELS[currentTier][task]`.
 *   3. `MODELS[task]` — hardcoded safety net when the tier map points at an
 *      ID we can't resolve. Kept so new users always have a working default.
 */

import { MODELS, TIER_MODELS, AI_TIERS, DEFAULT_AI_TIER, type AiTier } from './pricing';
import type { TaskKey } from './modelCatalog';
import { getSetting, setSetting, deleteSetting } from '../database/db';

const PREFIX = 'model.';
const TIER_KEY = 'ai.tier';

function keyFor(taskKey: TaskKey): string {
    return `${PREFIX}${taskKey}`;
}

/**
 * Reads the currently-selected AI tier from `app_settings`. Falls back to
 * `DEFAULT_AI_TIER` when unset or when the stored value is not a known tier.
 */
export async function getAiTier(): Promise<AiTier> {
    const saved = await getSetting(TIER_KEY);
    if (saved && (AI_TIERS as readonly string[]).includes(saved)) {
        return saved as AiTier;
    }
    return DEFAULT_AI_TIER;
}

/**
 * Persists the selected tier. Does NOT clear existing per-task overrides —
 * the UI is responsible for calling `clearAllModelPreferences` when the user
 * confirms a destructive tier switch.
 */
export async function setAiTier(tier: AiTier): Promise<void> {
    await setSetting(TIER_KEY, tier);
}

/**
 * Returns the model that the current tier assigns to `taskKey`, without
 * consulting the user's per-task override. Used by the ModelPicker to render
 * the "default row" so the user sees what going back to defaults will pick.
 */
export async function getTierDefaultModel(taskKey: TaskKey): Promise<string> {
    const tier = await getAiTier();
    return TIER_MODELS[tier][taskKey] ?? MODELS[taskKey];
}

/**
 * Resolves the model ID to use for a given task. Follows the resolution chain
 * documented at the top of this file: user pref → tier default → hardcoded
 * fallback in `MODELS[taskKey]`.
 */
export async function getPreferredModel(taskKey: TaskKey): Promise<string> {
    const saved = await getSetting(keyFor(taskKey));
    if (saved && saved.length > 0) return saved;
    const tier = await getAiTier();
    return TIER_MODELS[tier][taskKey] ?? MODELS[taskKey];
}

export async function setPreferredModel(taskKey: TaskKey, modelId: string): Promise<void> {
    await setSetting(keyFor(taskKey), modelId);
}

export async function clearPreferredModel(taskKey: TaskKey): Promise<void> {
    await deleteSetting(keyFor(taskKey));
}

/**
 * Wipes every `model.<TASK>` row from `app_settings`. Called by the tier
 * switcher after user confirmation so the app immediately reflects the new
 * tier's defaults across all tasks.
 */
export async function clearAllModelPreferences(): Promise<void> {
    const tasks = Object.keys(MODELS) as TaskKey[];
    await Promise.all(tasks.map(k => deleteSetting(keyFor(k))));
}

/**
 * Returns a map of every task's currently-preferred model ID. Used by the
 * startup missing-model check.
 */
export async function getAllPreferredModels(): Promise<Record<TaskKey, string>> {
    const entries = await Promise.all(
        (Object.keys(MODELS) as TaskKey[]).map(async k => [k, await getPreferredModel(k)] as const),
    );
    return Object.fromEntries(entries) as Record<TaskKey, string>;
}
