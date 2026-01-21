import { t } from '../i18n';
import * as firebase from '../firebase';
import { GenerationResult } from '../firebase';

// ============= CONTENT MODERATION =============
// Validation disabled as per user request (2026-01-20)

export interface ContentValidationResult {
    allowed: boolean;
    reason?: string;
}

export function validateContentRequest(text: string): ContentValidationResult {
    return { allowed: true };
}

// ============= AI FUNCTIONS (FIREBASE WRAPPERS) =============

export async function generateApp(description: string): Promise<GenerationResult> {
    // 1. Local Moderation (Fail fast) - currently bypassed
    const validation = validateContentRequest(description);
    if (!validation.allowed) {
        throw new Error(validation.reason || t('requestBlocked'));
    }

    // 2. Call Firebase
    return await firebase.generateSpellCreate(description);
}

export async function editApp(currentCode: string, instructions: string): Promise<GenerationResult> {
    const validation = validateContentRequest(instructions);
    if (!validation.allowed) {
        throw new Error(validation.reason || t('requestBlocked'));
    }

    return await firebase.generateSpellEdit(currentCode, instructions);
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

    return await firebase.generateSpellEdit(currentCode, instructions, {
        previousEdits: validEdits,
        selectedContext
    });
}

export async function convertNodeProject(sourceCode: string, frameworkHint: string): Promise<GenerationResult> {
    return await firebase.generateSpellConvert(sourceCode, frameworkHint);
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
export async function aiGenerate(options: AIGenerateOptions): Promise<{ text: string, usage: any }> {
    console.log('[AI] aiGenerate (via Firebase)', JSON.stringify({ ...options, image: options.image ? '<base64>' : null, audio: options.audio ? '<base64>' : null }));

    const { prompt, search, schema, image, audio } = options;

    // Clean base64 if needed
    const cleanImage = image ? image.replace(/^data:image\/[^;]+;base64,/, '') : undefined;
    const cleanAudio = audio ? audio.replace(/^data:audio\/[^;]+;base64,/, '') : undefined;

    const result = await firebase.generateSpellWebviewAI(prompt, {
        schema,
        imageBase64: cleanImage,
        audioBase64: cleanAudio,
        useSearch: search
    });

    return {
        text: result.text,
        usage: result.usage
    };
}

// Legacy text-only wrapper
export async function aiGenerateText(prompt: string): Promise<string> {
    const result = await firebase.generateSpellWebviewAI(prompt);
    return result.text;
}
