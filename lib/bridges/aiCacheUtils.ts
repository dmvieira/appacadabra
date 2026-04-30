import * as db from '../database/db';

const TEXT_AI_TYPES = new Set(['AI_GENERATE', 'AI_SIMILARITY']);
const MEDIA_AI_TYPES = new Set(['AI_GENERATE_IMAGE', 'AI_GENERATE_VIDEO', 'AUDIO_SPEAK_AI']);

export interface AiCacheSaveArgs {
    type: string;
    success: boolean;
    result: string;
    creditsUsed: number;
    appId: number;
    callbackName: string;
    requestData: any;
    mediaLocalPath?: string;
}

/**
 * Persists the result of a WebView AI call to webview_ai_cache.
 * Text types (AI_GENERATE, AI_SIMILARITY) require a non-empty result.
 * Media types (AI_GENERATE_IMAGE, AI_GENERATE_VIDEO, AUDIO_SPEAK_AI) require mediaLocalPath.
 * Returns the new row id, or null if the entry was not saved.
 */
export async function saveAiResultToCache(args: AiCacheSaveArgs): Promise<number | null> {
    const { type, success, result, creditsUsed, appId, callbackName, requestData, mediaLocalPath } = args;

    if (TEXT_AI_TYPES.has(type)) {
        if (!success || !result) return null;
        try {
            return await db.saveWebviewAiCache({
                appId, callbackName, action: type,
                requestData: JSON.stringify(requestData),
                result,
                creditsUsed,
                success: 1,
            });
        } catch (e) {
            console.warn(`[aiCacheUtils] Failed to cache ${type} response:`, e);
            return null;
        }
    }

    if (MEDIA_AI_TYPES.has(type)) {
        if (!mediaLocalPath) return null;
        try {
            return await db.saveWebviewAiCache({
                appId, callbackName, action: type,
                requestData: JSON.stringify(requestData),
                result,
                mediaLocalPath,
                creditsUsed,
                success: success ? 1 : 0,
            });
        } catch (e) {
            console.warn(`[aiCacheUtils] Failed to cache ${type} response:`, e);
            return null;
        }
    }

    return null;
}
