import { t } from '../i18n';
import * as firebase from '../firebase';
import { GenerationResult } from '../firebase';
import { logAppCreated, logAppEdited, logAiGenerate, logAiGenerateImage } from '../analytics';

// ============= CONTENT MODERATION =============
// Validation disabled as per user request (2026-01-20)

export interface ContentValidationResult {
    allowed: boolean;
    reason?: string;
}

export function validateContentRequest(text: string): ContentValidationResult {
    return { allowed: true };
}

// Helper for timeout and retry
async function withTimeoutAndRetry<T>(
    operation: () => Promise<T>,
    timeoutMs: number = 240000, // 4 minutes default
    retries: number = 1
): Promise<T> {
    const runOp = async (): Promise<T> => {
        let lastError: any;

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                // Create a promise that rejects after timeout
                const timeoutPromise = new Promise<never>((_, reject) => {
                    setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
                });

                // Race the operation against the timeout
                return await Promise.race([operation(), timeoutPromise]);
            } catch (e) {
                lastError = e;
                console.warn(`[AI] Attempt ${attempt + 1} failed:`, e);
                if (attempt < retries) {
                    // Exponential backoff
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
                }
            }
        }
        throw lastError;
    };

    return runOp();
}

async function resolveStorageUrlToBase64(urlOrBase64: string): Promise<string> {
    if (!urlOrBase64 || !urlOrBase64.startsWith('http')) return urlOrBase64;

    console.log('[AI] resolveStorageUrlToBase64: Downloading...', urlOrBase64.substring(0, 100));
    try {
        const response = await fetch(urlOrBase64);
        const blob = await response.blob();
        return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = (reader.result as string).split(',')[1] || (reader.result as string);
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (err) {
        console.error('[AI] Failed to resolve storage URL:', err);
        throw err;
    }
}

// ============= AI FUNCTIONS (FIREBASE WRAPPERS) =============

export async function generateApp(description: string): Promise<GenerationResult> {
    // 1. Local Moderation (Fail fast) - currently bypassed
    const validation = validateContentRequest(description);
    if (!validation.allowed) {
        throw new Error(validation.reason || t('requestBlocked'));
    }

    // 2. Call Firebase with retry
    const result = await withTimeoutAndRetry(() => firebase.generateSpellCreate(description));
    logAppCreated(result.creditsUsed || 0);
    return result;
}

export async function editApp(currentCode: string, instructions: string): Promise<GenerationResult> {
    const validation = validateContentRequest(instructions);
    if (!validation.allowed) {
        throw new Error(validation.reason || t('requestBlocked'));
    }

    const result = await withTimeoutAndRetry(() => firebase.generateSpellEdit(currentCode, instructions));
    logAppEdited(result.creditsUsed || 0);
    return result;
}

export async function editAppWithContext(
    currentCode: string,
    instructions: string,
    selectedContext: string,
    previousEdits: { version: number; instruction: string | null }[]
): Promise<GenerationResult> {
    const validation = validateContentRequest(instructions);
    if (!validation.allowed) {
        throw new Error(validation.reason || t('requestBlocked'));
    }

    // Map previousEdits to the format expected by firebase
    const validEdits = previousEdits
        .filter(e => e.instruction !== null)
        .map(e => ({ version: e.version, instruction: e.instruction as string }));

    const result = await withTimeoutAndRetry(() => firebase.generateSpellEdit(currentCode, instructions, {
        previousEdits: validEdits,
        selectedContext
    }));
    logAppEdited(result.creditsUsed || 0);
    return result;
}

export async function convertNodeProject(sourceCode: string, frameworkHint: string): Promise<GenerationResult> {
    return withTimeoutAndRetry(() => firebase.generateSpellConvert(sourceCode, frameworkHint));
}

// ============= BRIDGE AI FUNCTIONS =============

export interface AIGenerateOptions {
    prompt: string;
    search?: boolean;
    schema?: object;
    images?: string[]; // base64 array
    videos?: string[]; // base64 array
    audios?: string[]; // base64 array
}

// Used by WebView Bridge
export async function aiGenerate(options: AIGenerateOptions): Promise<{ text: string, usage: any, creditsUsed: number }> {
    console.log('[AI] aiGenerate (via Firebase)', JSON.stringify({ ...options, images: options.images?.length || 0, videos: options.videos?.length || 0, audios: options.audios?.length || 0 }));

    const { prompt, search, schema, images, videos, audios } = options;

    // Clean base64 prefixes
    const cleanImages = images?.map(img => img.replace(/^data:image\/[^;]+;base64,/, ''));
    const cleanVideos = videos?.map(v => v.replace(/^data:video\/[^;]+;base64,/, ''));
    const cleanAudios = audios?.map(a => a.replace(/^data:audio\/[^;]+;base64,/, ''));

    const result = await firebase.generateSpellWebviewAI(prompt, {
        schema,
        imagesBase64: cleanImages,
        videosBase64: cleanVideos,
        audiosBase64: cleanAudios,
        useSearch: search
    });

    const creditsUsed = result.creditsUsed || 0;
    logAiGenerate(creditsUsed, !!(cleanImages?.length), !!(cleanAudios?.length));
    return {
        text: result.text,
        usage: result.usage,
        creditsUsed,
    };
}

// Used by WebView Bridge - Similarity
export async function aiSimilarity(items: string[]): Promise<{ text: string, creditsUsed: number }> {
    console.log('[AI] aiSimilarity (via Firebase)', items.length, 'items');

    const result = await firebase.generateSpellSimilarity(items);
    return {
        text: result.text,
        creditsUsed: result.creditsUsed || 0,
    };
}

// Used by WebView Bridge - Generate Image
export async function aiGenerateImage(prompt: string, imagesBase64?: string[]): Promise<{ imageBase64: string, usage: any, creditsUsed: number }> {
    console.log('[AI] aiGenerateImage (via Firebase)', prompt?.substring(0, 80), imagesBase64?.length ? `with ${imagesBase64.length} image(s)` : '');

    const cleanImages = imagesBase64?.map(img => img.replace(/^data:image\/[^;]+;base64,/, ''));
    const result = await firebase.generateSpellImageGen(prompt, cleanImages);
    const imageBase64 = await resolveStorageUrlToBase64(result.text);

    const creditsUsed = result.creditsUsed || 0;
    logAiGenerateImage(creditsUsed);
    return {
        imageBase64,
        usage: result.usage,
        creditsUsed,
    };
}

// Used by WebView Bridge - Generate TTS Audio
export async function aiGenerateTTS(text: string, voiceName?: string): Promise<{ audioBase64: string, usage: any, creditsUsed: number }> {
    console.log('[AI] aiGenerateTTS (via Firebase)', text?.substring(0, 80), 'voice:', voiceName);

    const result = await firebase.generateSpellTTS(text, voiceName);
    const audioBase64 = await resolveStorageUrlToBase64(result.text);

    const creditsUsed = result.creditsUsed || 0;
    return {
        audioBase64,
        usage: result.usage,
        creditsUsed,
    };
}

// Used by WebView Bridge - Generate Video
export async function aiGenerateVideo(prompt: string, imagesBase64?: string[]): Promise<{ videoBase64: string, usage: any, creditsUsed: number }> {
    console.log('[AI] aiGenerateVideo (via Firebase)', prompt?.substring(0, 80), imagesBase64?.length ? `with ${imagesBase64.length} image(s)` : '');

    const cleanImages = imagesBase64?.map(img => img.replace(/^data:image\/[^;]+;base64,/, ''));
    const result = await firebase.generateSpellVideoGen(prompt, cleanImages);
    const videoBase64 = await resolveStorageUrlToBase64(result.text);

    const creditsUsed = result.creditsUsed || 0;
    return {
        videoBase64,
        usage: result.usage,
        creditsUsed,
    };
}

export async function estimateManaCost(type: string, data: any): Promise<{ mana: string; value: number }> {
    return firebase.estimateManaCost(type, data);
}
