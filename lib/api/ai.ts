import { t } from '../i18n';
import { logAppCreated, logAppEdited, logAiGenerate, logAiGenerateImage } from '../analytics';
import {
    generateSpellCreate as byokGenerateSpellCreate,
    generateSpellEdit as byokGenerateSpellEdit,
    generateConvert as byokGenerateConvert,
    generateWebviewAI as byokGenerateWebviewAI,
} from './generators';
import * as openrouter from './openrouter';
import { calcImageUsd, calcMusicUsd, calcVideoUsd, calculateCostUsd } from './pricing';
import { getPreferredModel } from './modelPreferences';
import { signalModelUnavailable } from './modelUnavailableSignal';
import Constants from 'expo-constants';

// ============= CONTENT MODERATION =============
// Validation disabled as per user request (2026-01-20)

export interface ContentValidationResult {
    allowed: boolean;
    reason?: string;
}

export function validateContentRequest(text: string): ContentValidationResult {
    return { allowed: true };
}

function getAppVersion(): string {
    return Constants.expoConfig?.version ?? '2.0.15';
}

// ============= AI FUNCTIONS (BYOK direct via OpenRouter) =============

export interface ByokGenerationResult {
    text: string;
    usage: {
        promptTokens: number;
        responseTokens: number;
        totalTokens: number;
    };
    costUsd: number;
    appName?: string;
}

function toGenerationResult(r: { html?: string; text?: string; usage: { promptTokens: number; responseTokens: number; totalTokens: number }; costUsd?: number; appName?: string }): ByokGenerationResult {
    return {
        text: r.html ?? r.text ?? '',
        usage: {
            promptTokens: r.usage.promptTokens,
            responseTokens: r.usage.responseTokens,
            totalTokens: r.usage.totalTokens,
        },
        costUsd: r.costUsd ?? 0,
        appName: r.appName,
    };
}

export async function generateApp(description: string): Promise<ByokGenerationResult> {
    const validation = validateContentRequest(description);
    if (!validation.allowed) {
        throw new Error(validation.reason || t('requestBlocked'));
    }

    try {
        const result = await byokGenerateSpellCreate({ prompt: description, appVersion: getAppVersion() });
        const wrapped = toGenerationResult(result);
        logAppCreated(0);
        return wrapped;
    } catch (err) {
        signalModelUnavailable(null, 'SPELL_S', err, await getPreferredModel('SPELL_S'));
        throw err;
    }
}

export async function editApp(currentCode: string, instructions: string): Promise<ByokGenerationResult> {
    const validation = validateContentRequest(instructions);
    if (!validation.allowed) {
        throw new Error(validation.reason || t('requestBlocked'));
    }

    try {
        const result = await byokGenerateSpellEdit({
            currentCode,
            instruction: instructions,
            appVersion: getAppVersion(),
        });
        const wrapped = toGenerationResult(result);
        logAppEdited(0);
        return wrapped;
    } catch (err) {
        signalModelUnavailable(null, 'SPELL_S', err, await getPreferredModel('SPELL_S'));
        throw err;
    }
}

export async function editAppWithContext(
    currentCode: string,
    instructions: string,
    selectedContext: string,
    previousEdits: { version: number; instruction: string | null }[]
): Promise<ByokGenerationResult> {
    const validation = validateContentRequest(instructions);
    if (!validation.allowed) {
        throw new Error(validation.reason || t('requestBlocked'));
    }

    const validEdits = previousEdits
        .filter(e => e.instruction !== null)
        .map(e => ({ version: e.version, instruction: e.instruction as string }));

    try {
        const result = await byokGenerateSpellEdit({
            currentCode,
            instruction: instructions,
            appVersion: getAppVersion(),
            previousEdits: validEdits,
            selectedContext,
        });
        const wrapped = toGenerationResult(result);
        logAppEdited(0);
        return wrapped;
    } catch (err) {
        signalModelUnavailable(null, 'SPELL_S', err, await getPreferredModel('SPELL_S'));
        throw err;
    }
}

export async function convertNodeProject(sourceCode: string, frameworkHint: string): Promise<ByokGenerationResult> {
    try {
        const result = await byokGenerateConvert({
            sourceCode,
            frameworkHint,
            appVersion: getAppVersion(),
        });
        return toGenerationResult(result);
    } catch (err) {
        signalModelUnavailable(null, 'SPELL_S', err, await getPreferredModel('SPELL_S'));
        throw err;
    }
}

// ============= BRIDGE AI FUNCTIONS =============

export interface AIGenerateOptions {
    prompt: string;
    search?: boolean;
    schema?: object;
    images?: string[]; // base64 array
    videos?: string[]; // base64 array
    audios?: string[]; // base64 array
    pdfs?: string[]; // base64 array (application/pdf)
}

// Used by WebView Bridge
export async function aiGenerate(options: AIGenerateOptions): Promise<{ text: string, usage: any, creditsUsed: number, costUsd: number }> {
    console.log('[AI] aiGenerate (BYOK)', JSON.stringify({ ...options, images: options.images?.length || 0, videos: options.videos?.length || 0, audios: options.audios?.length || 0, pdfs: options.pdfs?.length || 0 }));

    const { prompt, search, schema, images, audios, pdfs } = options;

    // Strip any leading data URI header — including MIME parameters like
    // "; codecs=opus" that WhatsApp attaches to voice notes (mimeType comes
    // through as "audio/ogg; codecs=opus" and the previous regex stopped at
    // the first ";", leaving the header embedded in the payload and getting
    // the request rejected by the provider). Matching up to the first comma
    // covers every RFC-2397-shaped prefix regardless of the parameter list.
    const cleanPrefix = (str: string) => typeof str === 'string' ? str.replace(/^(data:[^,]+,)+/i, '') : str;
    const cleanImages = images?.map(cleanPrefix);
    const cleanAudios = audios?.map(cleanPrefix);
    const cleanPdfs = pdfs?.map(cleanPrefix);

    const result = await byokGenerateWebviewAI({
        prompt,
        schema: schema as Record<string, unknown> | undefined,
        images: cleanImages,
        audios: cleanAudios,
        pdfs: cleanPdfs,
        useSearch: search,
    });

    logAiGenerate(0, !!(cleanImages?.length), !!(cleanAudios?.length));
    return {
        text: result.text,
        usage: result.usage,
        creditsUsed: 0,
        costUsd: result.costUsd ?? 0,
    };
}

// Used by WebView Bridge - Similarity
// Embeddings via OpenRouter; cosine-similarity matrix computed client-side so
// the WebView consumer can keep treating `text` as a JSON-stringified matrix.
export async function aiSimilarity(items: string[], signal?: AbortSignal): Promise<{ text: string, creditsUsed: number, costUsd: number }> {
    console.log('[AI] aiSimilarity (BYOK)', items.length, 'items');

    const embedModel = await getPreferredModel('EMBED');
    const { vectors, usage } = await openrouter.embed({
        model: embedModel,
        input: items,
        signal,
    });

    // Server returned a flat Float32-style row-major matrix as JSON. Mirror the
    // exact shape so the spell-side helper does not need to change.
    const n = vectors.length;
    const matrix: number[][] = [];
    for (let i = 0; i < n; i++) {
        const row: number[] = new Array(n);
        for (let j = 0; j < n; j++) {
            row[j] = cosineSim(vectors[i], vectors[j]);
        }
        matrix.push(row);
    }

    const reportedCost = (usage as any)?.cost;
    const costUsd =
        typeof reportedCost === 'number' && reportedCost > 0
            ? reportedCost
            : calculateCostUsd(embedModel, {
                  promptTokens: items.reduce((sum, s) => sum + Math.ceil(s.length / 4), 0),
                  responseTokens: 0,
              });

    return {
        text: JSON.stringify(matrix),
        creditsUsed: 0,
        costUsd,
    };
}

function cosineSim(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Used by WebView Bridge - Generate Image
export async function aiGenerateImage(prompt: string, imagesBase64?: string[], signal?: AbortSignal): Promise<{ imageBase64: string, usage: any, creditsUsed: number, costUsd: number }> {
    console.log('[AI] aiGenerateImage (BYOK)', prompt?.substring(0, 80), imagesBase64?.length ? `with ${imagesBase64.length} image(s)` : '');

    const cleanPrefix = (str: string) => typeof str === 'string' ? str.replace(/^(data:[^;]+;base64,)+/i, '') : str;
    const cleanImages = imagesBase64?.map(cleanPrefix);

    const model = cleanImages?.length
        ? await getPreferredModel('IMAGE_EDIT')
        : await getPreferredModel('IMAGE');
    const { images: outImages, usage } = await openrouter.generateImage({
        model,
        prompt,
        referenceImagesBase64: cleanImages,
        signal,
    });

    const first = outImages[0] ?? '';
    // Strip data: prefix if present so the bridge receives raw base64.
    const imageBase64 = first.startsWith('data:')
        ? (first.split(',')[1] ?? '')
        : first;

    logAiGenerateImage(0);
    const reportedCost = (usage as any)?.cost;
    const costUsd =
        typeof reportedCost === 'number' && reportedCost > 0
            ? reportedCost
            : calcImageUsd(cleanImages?.length ?? 0);

    return {
        imageBase64,
        usage,
        creditsUsed: 0,
        costUsd,
    };
}

// Used by WebView Bridge - Generate TTS Audio
export async function aiGenerateTTS(text: string, voiceName?: string, signal?: AbortSignal): Promise<{ audioBase64: string, usage: any, creditsUsed: number, costUsd: number }> {
    console.log('[AI] aiGenerateTTS (BYOK)', text?.substring(0, 80), 'voice:', voiceName);

    const ttsModel = await getPreferredModel('TTS');
    const { audioBase64, usage } = await openrouter.tts({
        model: ttsModel,
        text,
        voice: voiceName,
        signal,
    });

    const reportedCost = (usage as any)?.cost;
    const costUsd =
        typeof reportedCost === 'number' && reportedCost > 0
            ? reportedCost
            : calculateCostUsd(ttsModel, {
                  promptTokens: Math.ceil((text?.length ?? 0) / 4) + 50,
                  responseTokens: Math.ceil((text?.length ?? 0) * 2),
              });

    return {
        audioBase64,
        usage,
        creditsUsed: 0,
        costUsd,
    };
}

// Used by WebView Bridge - Generate Music
export async function aiGenerateMusic(prompt: string, signal?: AbortSignal): Promise<{ audioBase64: string, usage: any, creditsUsed: number, costUsd: number }> {
    console.log('[AI] aiGenerateMusic (BYOK)', prompt?.substring(0, 80));

    const musicModel = await getPreferredModel('MUSIC');
    const { audioBase64, usage } = await openrouter.generateMusic({
        model: musicModel,
        prompt,
        signal,
    });

    // Lyria bills per song ($0.08), not per token — usage.cost is authoritative
    // when present, otherwise the fixed per-song fallback stands in.
    const reportedCost = (usage as any)?.cost;
    const costUsd =
        typeof reportedCost === 'number' && reportedCost > 0
            ? reportedCost
            : calcMusicUsd();

    return {
        audioBase64,
        usage,
        creditsUsed: 0,
        costUsd,
    };
}

// Used by WebView Bridge - Generate Video
// Submits + polls. Default cap of 8 minutes matches the old server timeout.
const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_POLL_TIMEOUT_MS = 8 * 60_000;

export async function aiGenerateVideo(prompt: string, imagesBase64?: string[], signal?: AbortSignal): Promise<{ videoBase64: string, usage: any, creditsUsed: number, costUsd: number }> {
    console.log('[AI] aiGenerateVideo (BYOK)', prompt?.substring(0, 80), imagesBase64?.length ? `with ${imagesBase64.length} image(s)` : '');

    const cleanPrefix = (str: string) => typeof str === 'string' ? str.replace(/^(data:[^;]+;base64,)+/i, '') : str;
    const cleanImages = imagesBase64?.map(cleanPrefix);
    const firstImage = cleanImages?.[0];
    const model = firstImage
        ? await getPreferredModel('VIDEO_STD')
        : await getPreferredModel('VIDEO_FAST');

    const submission = await openrouter.submitVideo({
        model,
        prompt,
        inputImageBase64: firstImage,
        signal,
    });

    const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (signal?.aborted) {
            throw new Error('aborted');
        }
        await new Promise(r => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
        const polled = await openrouter.pollVideo(submission.pollingUrl, signal);
        if (polled) {
            // OpenRouter may return either inline base64 or a URL — resolve to base64.
            let videoBase64 = polled.videoBase64 ?? '';
            if (!videoBase64 && polled.videoUrl) {
                videoBase64 = await urlToBase64(polled.videoUrl);
            }
            const reportedCost = (polled.usage as any)?.cost;
            const costUsd =
                typeof reportedCost === 'number' && reportedCost > 0
                    ? reportedCost
                    : calcVideoUsd(8, !!firstImage);

            return {
                videoBase64,
                usage: polled.usage,
                creditsUsed: 0,
                costUsd,
            };
        }
    }
    throw new Error('Video generation timed out');
}

async function urlToBase64(url: string): Promise<string> {
    const response = await fetch(url);
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result as string;
            resolve(result.includes(',') ? result.split(',')[1] : result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}
