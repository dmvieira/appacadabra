/**
 * Shared "the chosen model is dead" fan-out.
 *
 * Any code path that runs an AI call the user chose a model for (spell
 * create/edit, WebView AI, TTS, image, video, …) can pipe a caught error
 * through this helper. When the error is `byok.error.modelUnavailable`,
 * the ModelUnavailableModal is surfaced with the offending task+model so
 * the user can pick a replacement or reset the preference.
 *
 * `bridgeUIStore` lives in the main JS context; the background HeadlessJsTask
 * runs in a separate context where the store isn't hydrated. In that case
 * `useBridgeUIStore` throws on import and we swallow it — the FGS side
 * persists `lastErrorCode='byok.error.modelUnavailable'` on `pending_jobs`
 * instead, and the main-thread reconciler dispatches the modal at boot.
 */
import { OpenRouterError } from './openrouter';
import type { TaskKey } from './modelCatalog';

/**
 * Returns true when the error was a model-unavailable and the modal has
 * been requested (or persistence should be attempted by the caller in the
 * headless case). Never throws — always safe to call from a catch block.
 */
export function signalModelUnavailable(
    appId: number | null,
    taskKey: TaskKey,
    err: unknown,
    fallbackModelId: string,
): boolean {
    if (!(err instanceof OpenRouterError) || err.code !== 'byok.error.modelUnavailable') {
        return false;
    }
    try {
        // Lazy require so this module stays importable from the headless
        // context (where bridgeUIStore's WebView deps may not resolve).
        const { useBridgeUIStore } = require('../bridgeUIStore') as typeof import('../bridgeUIStore');
        useBridgeUIStore.getState().requestModelUnavailable(
            appId,
            taskKey,
            err.modelId ?? fallbackModelId,
        );
    } catch {
        // Headless context — caller is responsible for persisting the
        // signal on the pending_jobs row so the main thread can dispatch
        // the modal when it comes back online.
    }
    return true;
}

/**
 * Extracts the model id off an `OpenRouterError` when it's a
 * model-unavailable case, else null. Used by the FGS reconciler to know
 * which model to name in the modal.
 */
export function extractUnavailableModelId(err: unknown): string | null {
    if (err instanceof OpenRouterError && err.code === 'byok.error.modelUnavailable') {
        return err.modelId ?? null;
    }
    return null;
}
