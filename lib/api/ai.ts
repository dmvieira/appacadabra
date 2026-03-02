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
                    setTimeout(() => reject(new Error('Operation timed out')), timeoutMs);
                });

                // Race the operation against the timeout
                return await Promise.race([operation(), timeoutPromise]);
            } catch (error) {
                lastError = error;
                if (attempt < retries) {
                    console.warn(`[AI] Attempt ${attempt + 1} failed, retrying...`, error);
                    // Optional: slight delay backoff could go here
                }
            }
        }
        throw lastError;
    };
    return runOp();
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
    image?: string; // base64
    audio?: string; // base64
}

// Used by WebView Bridge
export async function aiGenerate(options: AIGenerateOptions): Promise<{ text: string, usage: any, creditsUsed: number }> {
    console.log('[AI] aiGenerate (via Firebase)', JSON.stringify({ ...options, image: options.image ? '<base64>' : null, audio: options.audio ? '<base64>' : null }));

    const { prompt, search, schema, image, audio } = options;

    // Clean base64 if needed
    const cleanImage = image ? image.replace(/^data:image\/[^;]+;base64,/, '') : undefined;
    const cleanAudio = audio ? audio.replace(/^data:audio\/[^;]+;base64,/, '') : undefined;

    return withTimeoutAndRetry(async () => {
        const result = await firebase.generateSpellWebviewAI(prompt, {
            schema,
            imageBase64: cleanImage,
            audioBase64: cleanAudio,
            useSearch: search
        });

        const creditsUsed = result.creditsUsed || 0;
        logAiGenerate(creditsUsed, !!cleanImage, !!cleanAudio);
        return {
            text: result.text,
            usage: result.usage,
            creditsUsed,
        };
    });
}

// Used by WebView Bridge - Generate Image
export async function aiGenerateImage(prompt: string): Promise<{ imageBase64: string, usage: any, creditsUsed: number }> {
    console.log('[AI] aiGenerateImage (via Firebase)', prompt?.substring(0, 80));

    return withTimeoutAndRetry(async () => {
        const result = await firebase.generateSpellImageGen(prompt);

        const creditsUsed = result.creditsUsed || 0;
        logAiGenerateImage(creditsUsed);
        return {
            imageBase64: result.text, // Server returns base64 image data in text field
            usage: result.usage,
            creditsUsed,
        };
    });
}
