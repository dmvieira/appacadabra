/**
 * Firebase Functions for Appacadabra
 * Handles all AI operations with credit management via Firestore
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { JWT } from "google-auth-library";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, DocumentReference, Transaction, DocumentData } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";
import { getMessaging } from "firebase-admin/messaging";
import OpenAI from 'openai';

import * as zlib from 'zlib';
import { CONVERT_PROJECT_PROMPT } from "./prompts";
import { buildSystemInstructions, ALL_CAPABILITIES } from "./capabilities/index";
import { NOTIF_I18N } from "./i18n";
import { MODELS, OR_BASE_URL, OR_REASONING_HIGH, OR_WEB_SEARCH } from "./config";
import { submitVideoJob, pollAndDownloadVideo } from "./videoJob";
import { generateSpellCreate, generateSpellEdit, generateWebviewAI } from "./generators";
import {
    sanitizeForFirestore,
    calculateCostUsd,
    calcImageMana,
    calcVideoMana,
    extractHtml,
    extractText,
    fixCallbackPatterns,
    getUsage,
    withRetry,
    computeManaCost,
    MANA_VALUE_USD,
    sanitizeSpellHtml,
    generateSlug,
    translateSpellMeta,
} from "./utils";

// Initialize Firebase Admin
initializeApp();
const db = getFirestore();

// Constants
const DEFAULT_TIMEOUT_MS = 480000;

// Initialize OpenRouter client (OpenAI-compatible)
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || '').trim();
let _or: OpenAI | null = null;
function getOR(): OpenAI {
    return _or ?? (_or = new OpenAI({
        baseURL: OR_BASE_URL,
        apiKey: OPENROUTER_API_KEY,
        timeout: DEFAULT_TIMEOUT_MS,
        defaultHeaders: { 'X-OpenRouter-Cache': 'true' },
    }));
}


// ============= AUDIO UTILS =============
function pcmToWav(pcmBuffer: Buffer, sampleRate = 24000, channels = 1, bitDepth = 16): Buffer {
    const dataSize = pcmBuffer.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28);
    header.writeUInt16LE(channels * (bitDepth / 8), 32);
    header.writeUInt16LE(bitDepth, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcmBuffer]);
}

// ============= COMPRESSION UTILS =============
function compressContent(text: string): string {
    if (!text) return '';
    try {
        const compressed = zlib.gzipSync(Buffer.from(text));
        return `GZIP:${compressed.toString('base64')}`;
    } catch (e) {
        console.error('Compression failed', e);
        return text;
    }
}


function decompressContent(input: string): string {
    if (!input) return '';
    if (input.startsWith('GZIP:')) {
        const base64 = input.substring(5);
        try {
            const buffer = Buffer.from(base64, 'base64');
            return zlib.gunzipSync(buffer).toString();
        } catch (e) {
            console.error('Decompression failed', e);
            return input;
        }
    }
    return input;
}


// ============= RATE LIMITING =============
// Constants for rate limiting
// Rate Limits
const RATE_LIMITS = {
    CALLS_PER_MINUTE: 30, // Increased
    TOKENS_PER_MINUTE: 500000, // Increased
    COOLDOWN_MS: 60000,
    SUGGEST_SPELLS_DAILY: 50,
};

interface RateLimitData {
    callsThisMinute: number;
    tokensThisMinute: number;
    lastMinuteReset: number;
    cooldownUntil?: number;
    // Daily limits
    dailySuggestSpells?: number;
    lastDailyReset?: number;
}

// Check and update rate limits (returns error message if rate limited)
// Check and update daily rate limits for suggestSpells
async function checkDailyRateLimit(
    userRef: DocumentReference,
    transaction: Transaction,
    userData: DocumentData
): Promise<string | null> {
    const now = Date.now();
    const rateLimit: RateLimitData = userData.rateLimit || {
        callsThisMinute: 0,
        tokensThisMinute: 0,
        lastMinuteReset: now,
    };

    // 24-hour reset (simple logic based on lastDailyReset)
    const dayMs = 24 * 60 * 60 * 1000;
    if (!rateLimit.lastDailyReset || now - rateLimit.lastDailyReset > dayMs) {
        rateLimit.dailySuggestSpells = 0;
        rateLimit.lastDailyReset = now;
    }

    if ((rateLimit.dailySuggestSpells || 0) >= RATE_LIMITS.SUGGEST_SPELLS_DAILY) {
        return `You've reached your daily limit of ${RATE_LIMITS.SUGGEST_SPELLS_DAILY} suggestions. Try again tomorrow!`;
    }

    // Increment
    rateLimit.dailySuggestSpells = (rateLimit.dailySuggestSpells || 0) + 1;
    transaction.update(userRef, { rateLimit });

    return null;
}

// Check and update per-minute rate limits (returns error message if rate limited)
async function checkRateLimit(
    userRef: DocumentReference,
    transaction: Transaction,
    userData: DocumentData
): Promise<string | null> {
    const now = Date.now();
    const rateLimit: RateLimitData = userData.rateLimit || {
        callsThisMinute: 0,
        tokensThisMinute: 0,
        lastMinuteReset: now,
    };

    if (rateLimit.cooldownUntil && now < rateLimit.cooldownUntil) {
        const remainingSecs = Math.ceil((rateLimit.cooldownUntil - now) / 1000);
        return `Rate limited. Try again in ${remainingSecs} seconds.`;
    }

    if (now - rateLimit.lastMinuteReset > 60000) {
        rateLimit.callsThisMinute = 0;
        rateLimit.tokensThisMinute = 0;
        rateLimit.lastMinuteReset = now;
        delete rateLimit.cooldownUntil;
    }

    if (rateLimit.callsThisMinute >= RATE_LIMITS.CALLS_PER_MINUTE) {
        rateLimit.cooldownUntil = now + RATE_LIMITS.COOLDOWN_MS;
        transaction.update(userRef, { rateLimit });
        return `Too many requests. Wait 1 minute before trying again.`;
    }

    if (rateLimit.tokensThisMinute >= RATE_LIMITS.TOKENS_PER_MINUTE) {
        rateLimit.cooldownUntil = now + RATE_LIMITS.COOLDOWN_MS;
        transaction.update(userRef, { rateLimit });
        return `Token limit reached. Wait 1 minute before trying again.`;
    }

    rateLimit.callsThisMinute++;
    transaction.update(userRef, { rateLimit });
    return null;
}


interface PreviousEdit {
    version: number;
    instruction: string;
}

// Pricing Constants
const FIXED_COST_CREATE_EDIT = 1.0;


// Function to add credits (for purchases/ad rewards)
export const addCredits = onCall<{ amount: number; source: string; purchaseToken?: string }>(
    {
        region: "southamerica-east1",
        enforceAppCheck: false,
    },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const uid = request.auth.uid;
        const { amount, source, purchaseToken } = request.data;

        if (!amount || amount <= 0) {
            throw new HttpsError("invalid-argument", "Amount must be positive");
        }

        const userRef = db.collection("users").doc(uid);

        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);

            // Idempotency: if purchaseToken provided, use it as log doc ID to deduplicate
            const logRef = purchaseToken
                ? db.collection("users").doc(uid).collection("creditLogs").doc(purchaseToken)
                : db.collection("users").doc(uid).collection("creditLogs").doc();

            if (purchaseToken) {
                const logDoc = await transaction.get(logRef);
                if (logDoc.exists) {
                    // Already credited — return without modifying balance
                    return;
                }
            }

            if (!userDoc.exists) {
                transaction.set(userRef, {
                    credits: amount,
                    creditsUsed: 0,
                    createdAt: FieldValue.serverTimestamp(),
                    lastActive: FieldValue.serverTimestamp(),
                });
            } else {
                transaction.update(userRef, {
                    credits: FieldValue.increment(amount),
                    lastActive: FieldValue.serverTimestamp(),
                });
            }

            transaction.set(logRef, {
                amount,
                source,
                timestamp: FieldValue.serverTimestamp(),
            });
        });

        // Return updated balance
        const userDoc = await userRef.get();
        return {
            success: true,
            creditsRemaining: userDoc.data()?.credits || 0,
        };
    }
);

// Function to void/refund a Google Play purchase
export const voidPurchase = onCall<{ purchaseToken: string; productId: string }>(
    {
        region: "southamerica-east1",
        enforceAppCheck: false,
        secrets: ["GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"],
    },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const { purchaseToken, productId } = request.data;
        if (!purchaseToken || !productId) {
            throw new HttpsError("invalid-argument", "purchaseToken and productId are required");
        }

        const serviceAccountJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
        if (!serviceAccountJson) {
            throw new HttpsError("internal", "Service account not configured");
        }

        let serviceAccount: any;
        try {
            serviceAccount = JSON.parse(serviceAccountJson);
        } catch {
            throw new HttpsError("internal", "Invalid service account JSON");
        }

        const client = new JWT({
            email: serviceAccount.client_email,
            key: serviceAccount.private_key,
            scopes: ["https://www.googleapis.com/auth/androidpublisher"],
        });

        const accessToken = await client.getAccessToken();
        if (!accessToken.token) {
            throw new HttpsError("internal", "Failed to obtain access token");
        }

        const packageName = "ai.appacadabra.app";
        const refundUrl = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/products/${productId}/tokens/${purchaseToken}:refund`;

        const response = await fetch(refundUrl, {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken.token}` },
        });

        if (response.status !== 204 && !response.ok) {
            const body = await response.text();
            console.error(`[voidPurchase] Google Play API error ${response.status}:`, body);
            throw new HttpsError("internal", `Refund failed: ${response.status}`);
        }

        return { success: true };
    }
);

// Function to get user credits balance
export const getCredits = onCall(
    {
        region: "southamerica-east1",
        enforceAppCheck: false,
    },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const uid = request.auth.uid;
        const userRef = db.collection("users").doc(uid);
        const userDoc = await userRef.get();

        const provider = (request.auth.token as any)?.firebase?.sign_in_provider ?? "unknown";

        if (!userDoc.exists) {
            // Create user with 0 credits
            await userRef.set({
                credits: 0,
                creditsUsed: 0,
                createdAt: FieldValue.serverTimestamp(),
                lastActive: FieldValue.serverTimestamp(),
                provider,
            });
            return { credits: 0 };
        }

        if (!userDoc.data()?.provider) {
            await userRef.update({ provider });
        }

        return { credits: userDoc.data()?.credits || 0 };
    }
);

export const suggestSpells = onCall<{ query: string; language: string }>(
    {
        region: "southamerica-east1",
        enforceAppCheck: false,
        secrets: ["OPENROUTER_API_KEY"],
    },
    async (request) => {
        if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
        const { query, language } = request.data;
        if (!query?.trim()) throw new HttpsError("invalid-argument", "Query required");

        const ALLOWED_LANGUAGES = ['pt-BR', 'en-US', 'es-ES', 'fr-FR', 'de-DE', 'ja-JP', 'zh-CN', 'ko-KR', 'it-IT', 'ru-RU', 'ar-SA', 'hi-IN', 'nl-NL', 'pl-PL', 'tr-TR', 'vi-VN', 'th-TH', 'id-ID'];
        // Accept both full tags ("pt-BR") and short codes ("pt") sent by the client
        const safeLanguage = ALLOWED_LANGUAGES.find(l => l === language || l.startsWith(language + '-')) ?? 'en-US';

        const uid = request.auth.uid;
        const userRef = db.collection("users").doc(uid);

        return await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) throw new HttpsError("failed-precondition", "No user data");

            const limitError = await checkDailyRateLimit(userRef, transaction, userDoc.data()!);
            if (limitError) throw new HttpsError("resource-exhausted", limitError);

            const result = await withRetry(() => getOR().chat.completions.create({
                model: MODELS.SUGGEST,
                messages: [
                    {
                        role: 'system',
                        content: `You are helping users of Appacadabra, an app that creates mini AI-powered tools called "spells". You MUST respond entirely in ${safeLanguage} — titles and descriptions must be in ${safeLanguage}.`,
                    },
                    {
                        role: 'user',
                        content: `The user searched for "${query.trim()}" but found no results. Suggest exactly 2 spell ideas related to "${query.trim()}". For each: title (3–5 words) and description (one sentence starting with an action verb, written as a prompt for an AI to create the spell).`,
                    },
                ],
                response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: 'suggestions',
                        schema: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    title: { type: 'string' },
                                    description: { type: 'string' },
                                },
                                required: ['title', 'description'],
                            },
                        },
                    },
                },
            }));

            const content = result.choices[0]?.message?.content;
            if (!content) throw new HttpsError("internal", "AI returned no suggestions. Please try again.");
            let suggestions: Array<{ title: string; description: string }>;
            try {
                const parsed = JSON.parse(content);
                suggestions = Array.isArray(parsed)
                    ? parsed.map(s => ({
                        title: String(s?.title ?? ''),
                        description: String(s?.description ?? ''),
                    }))
                    : [];
            } catch {
                throw new HttpsError("internal", "AI returned malformed suggestions. Please try again.");
            }
            return { suggestions };
        });
    }
);

// ============= ASYNC JOB PROCESSOR =============

interface Job {
    id: string;
    userId: string;
    action: 'create' | 'edit' | 'convert' | 'app_icon' | 'webview_ai' | 'webview_ai_tts' | 'webview_ai_image' | 'webview_ai_similarity' | 'webview_ai_video';
    status: 'queued' | 'processing' | 'completed' | 'failed';
    createdAt: any;
    updatedAt: any;
    payload: {
        prompt?: string;
        currentCode?: string; // GZIP:base64
        instruction?: string;
        selectedContext?: string;
        previousEdits?: PreviousEdit[];
        sourceCode?: string; // GZIP:base64 — for convert
        frameworkHint?: string; // for convert
        storageStructure?: Array<{
            key: string;
            schema: object;
        }>;
        // webview_ai fields
        schema?: object;
        imagesBase64?: string[];
        videosBase64?: string[];
        audiosBase64?: string[];
        useSearch?: boolean;
        tools?: string[];
        model?: string;
        voiceName?: string;
        items?: string[];
        appId?: string | number;
        appVersion?: string;
    };
    result?: {
        text: string; // GZIP:base64
        usage: any;
        creditsUsed: number;
        creditsRemaining: number;
        appName?: string; // For notification
    };
    error?: string;
}


async function sendJobNotification(uid: string, action: string, success: boolean, data?: Record<string, any>) {
    try {
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return;
        const { pushToken, locale } = userDoc.data() ?? {};
        if (!pushToken) return;

        const strings = NOTIF_I18N[locale ?? 'en'] ?? NOTIF_I18N['en'];
        const title = success
            ? (action === 'edit' ? strings.editTitle : strings.createTitle)
            : strings.failTitle;
        const body = success
            ? (action === 'edit' ? strings.editBody : strings.createBody)
            : strings.failBody;

        console.log(`[Push Notification] Sending FCM to user ${uid}`);
        const result = await getMessaging().send({
            token: pushToken,
            notification: { title, body },
            data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
            android: { notification: { sound: 'default' } },
        });
        console.log('[Push Notification] FCM result:', result);
    } catch (err: any) {
        console.error('[Push Notification] Error sending:', err);
        if (err?.errorInfo?.code === 'messaging/registration-token-not-registered') {
            await db.collection('users').doc(uid).update({ pushToken: FieldValue.delete() });
            console.log('[Push Notification] Stale FCM token removed for user:', uid);
        }
    }
}

export const processSpellJob = onDocumentCreated(
    {
        document: "jobs/{jobId}",
        region: "southamerica-east1",
        memory: "512MiB",
        timeoutSeconds: 540,
        secrets: ["OPENROUTER_API_KEY"],
    },
    async (event) => {
        const snapshot = event.data;
        if (!snapshot) return;

        const jobData = snapshot.data() as Job;
        const jobId = event.params.jobId;

        // Only process queued jobs
        if (jobData.status !== 'queued') return;

        console.log(`[Job ${jobId}] Starting processing. Action: ${jobData.action}`);

        const auditLog: any = {};
        await snapshot.ref.update({
            status: 'processing',
            startedAt: FieldValue.serverTimestamp(),
            auditLog: auditLog  // Initialize empty audit log
        });

        const uid = jobData.userId;
        const { action, payload } = jobData;

        // Decompress Inputs
        const prompt = decompressContent(payload.prompt || "");
        const currentCode = decompressContent(payload.currentCode || "");
        const instruction = decompressContent(payload.instruction || "");
        const selectedContext = payload.selectedContext ? decompressContent(payload.selectedContext) : undefined;
        const storageStructure: Array<{ key: string; schema: object }> =
            Array.isArray(payload.storageStructure) ? payload.storageStructure : [];
        let previousEdits = payload.previousEdits;
        // limit number of versions sent to model for context (e.g. 10), but always include first version if exists, as it usually contains original instruction
        if (Array.isArray(previousEdits) && previousEdits.length > 0) {
            const first = previousEdits[0];
            const last10 = previousEdits.slice(-10);
            const last10NoFirst = last10.filter(e => e.version !== first.version);
            previousEdits = [first, ...last10NoFirst];
        }

        const sourceCode = decompressContent(payload.sourceCode || "");
        const frameworkHint = payload.frameworkHint;
        const appVersion: string = payload.appVersion ?? '1.0.0';

        const schema = payload.schema;
        const imagesBase64 = payload.imagesBase64;
        const videosBase64 = payload.videosBase64;
        const audiosBase64 = payload.audiosBase64;
        const useSearch = payload.useSearch;
        const requestedTools = payload.tools;
        const requestedModel = payload.model;
        const voiceName = payload.voiceName;
        const items: string[] = payload.items || [];


        const resolveMedia = async (mediaArray: string[] | undefined): Promise<string[] | undefined> => {
            if (!mediaArray || mediaArray.length === 0) return mediaArray;
            return Promise.all(mediaArray.map(async (item) => {
                if (item.startsWith('http')) {
                    console.log(`[Job ${jobId}] Downloading media from Storage: ${item.substring(0, 100)}...`);
                    // Use native fetch to download
                    const response = await fetch(item);
                    if (!response.ok) throw new Error(`Failed to download job input media: ${response.status}`);
                    const buffer = Buffer.from(await response.arrayBuffer());
                    return buffer.toString('base64');
                }
                return item;
            }));
        };

        const userRef = db.collection("users").doc(uid);
        let preDeductedMana = 0; // tracks pre-deducted amount so we can refund on failure
        try {
            // Resolve any Storage URLs in media arrays back to Base64 for the models
            const resolvedImages = await resolveMedia(imagesBase64);
            const resolvedVideos = await resolveMedia(videosBase64);
            const resolvedAudios = await resolveMedia(audiosBase64);

            // 1. Check Credits/Limits
            const userDoc = await userRef.get();
            if (!userDoc.exists) throw new Error("User not found");

            const userData = userDoc.data()!;
            const currentBalance = userData.credits || 0;
            if (currentBalance < 0.1) {
                throw new Error("Insufficient credits");
            }

            // Estimate cost before executing — block if balance is insufficient
            const actionTypeMap: Record<string, string> = {
                webview_ai_generate: 'generate',
                webview_ai_image: 'image',
                webview_ai_video: 'video',
                webview_ai_tts: 'audio',
                webview_ai_similarity: 'similarity',
            };
            const estimateType = actionTypeMap[action];
            const estimatedCost = estimateType
                ? computeManaCost(estimateType, {
                    prompt,
                    text: prompt,
                    images: imagesBase64,
                    videos: videosBase64,
                    audios: audiosBase64,
                    search: useSearch,
                    schema,
                    items,
                }).value
                : FIXED_COST_CREATE_EDIT;

            if (estimatedCost > currentBalance) {
                throw new Error(`Insufficient credits: operation requires ~${estimatedCost.toFixed(2)} mana but balance is ${currentBalance.toFixed(2)}`);
            }

            // Pre-deduct estimated cost atomically before calling AI.
            // This ensures that if the function crashes or times out between AI completion
            // and the deduction transaction, the user is still charged.
            // On success the deduction transaction applies the delta (actual vs estimated).
            // On failure the catch block refunds preDeductedMana.
            await db.runTransaction(async (preDeductTx) => {
                const freshDoc = await preDeductTx.get(userRef);
                if (!freshDoc.exists) throw new Error("User not found");
                const freshBalance = (freshDoc.data()!.credits as number) || 0;
                if (freshBalance < estimatedCost) throw new Error("Insufficient credits (re-check)");
                preDeductTx.update(userRef, { credits: freshBalance - estimatedCost });
            });
            preDeductedMana = estimatedCost;

            let resultText = "";
            let usage = { promptTokens: 0, responseTokens: 0, thoughtsTokens: 0, totalTokens: 0, cachedTokens: 0 };
            let appName: string | undefined;
            let auditLog: any = {};
            let creditsUsed = FIXED_COST_CREATE_EDIT;
            let logModelId: string = MODELS.SPELL_S;
            let logExtras: Record<string, any> = {};

            switch (action) {
                case "create": {
                    console.log(`[Job ${jobId}] Delegating to generateSpellCreate...`);
                    const createResult = await generateSpellCreate(prompt, appVersion, getOR());
                    resultText = createResult.html;
                    usage = createResult.usage;
                    appName = createResult.appName;
                    if (createResult.initialValidationErrors.length > 0) {
                        auditLog.initialValidationErrors = createResult.initialValidationErrors;
                    }
                    logModelId = MODELS.SPELL_S;
                    break;
                }
                case "edit": {
                    console.log(`[Job ${jobId}] Delegating to generateSpellEdit...`);
                    const editResult = await generateSpellEdit({
                        currentCode,
                        instruction,
                        previousEdits,
                        selectedContext,
                        storageStructure,
                    }, appVersion, getOR());
                    resultText = editResult.html;
                    usage = editResult.usage;
                    if (editResult.initialValidationErrors.length > 0) {
                        auditLog.initialValidationErrors = editResult.initialValidationErrors;
                    }
                    logModelId = MODELS.SPELL_S;
                    break;
                }

                case "convert": {
                    if (!sourceCode) throw new Error("sourceCode required for convert");
                    console.log(`[Job ${jobId}] [CONVERT] Starting spell conversion`);

                    const framework = frameworkHint || "web project";
                    const convertPrompt = `${CONVERT_PROJECT_PROMPT}\n\nFramework: ${framework}\n\nSOURCE:\n${sourceCode}`;
                    const convertSysInstructions = buildSystemInstructions(appVersion, ALL_CAPABILITIES);

                    const convertResult = await withRetry(() => getOR().chat.completions.create({
                        model: MODELS.SPELL_S,
                        messages: [
                            { role: 'system', content: convertSysInstructions },
                            { role: 'user', content: convertPrompt },
                        ],
                        ...OR_REASONING_HIGH,
                        ...OR_WEB_SEARCH,
                    }));

                    const convU = getUsage(convertResult);
                    usage = {
                        ...convU,
                        cachedTokens: convertResult.usage?.prompt_tokens_details?.cached_tokens || 0,
                    };
                    resultText = fixCallbackPatterns(extractHtml(extractText(convertResult)));
                    if (!resultText) throw new Error("AI returned empty response");

                    creditsUsed = FIXED_COST_CREATE_EDIT;
                    logModelId = MODELS.SPELL_S;
                    break;
                }

                case "app_icon": {
                    if (!prompt) throw new Error("Prompt required for app icon generation");
                    console.log(`[Job ${jobId}] [APP_ICON] Generating icon for: ${prompt.substring(0, 80)}...`);

                    const iconResult = await withRetry(() => getOR().chat.completions.create({
                        model: MODELS.IMAGE,
                        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
                    }));

                    usage = sanitizeForFirestore({
                        promptTokens: Math.max(0, iconResult.usage?.prompt_tokens ?? 0),
                        responseTokens: Math.max(0, iconResult.usage?.completion_tokens ?? 0),
                        thoughtsTokens: 0,
                        totalTokens: Math.max(0, iconResult.usage?.total_tokens ?? 0),
                        cachedTokens: 0,
                    });

                    const iconMsg = iconResult.choices[0]?.message as any;
                    const iconParts: any[] = Array.isArray(iconMsg?.images) ? iconMsg.images
                        : Array.isArray(iconMsg?.content) ? iconMsg.content : [];
                    let iconBase64 = '';
                    for (const part of iconParts) {
                        if (part?.type === 'image_url') {
                            const url: string = part.image_url?.url ?? '';
                            iconBase64 = url.includes(',') ? url.split(',')[1] : url;
                            break;
                        }
                    }

                    if (!iconBase64) throw new Error('No image generated by model');

                    const iconBucket = getStorage().bucket();
                    const iconFileName = `generated_images/${uid}/${jobId}.jpeg`;
                    const iconFile = iconBucket.file(iconFileName);

                    const iconToken = require('crypto').randomUUID();
                    await iconFile.save(Buffer.from(iconBase64, 'base64'), {
                        contentType: 'image/jpeg',
                        metadata: {
                            metadata: {
                                firebaseStorageDownloadTokens: iconToken,
                                userId: uid,
                                jobId: jobId,
                            }
                        }
                    });

                    const iconDownloadUrl = `https://firebasestorage.googleapis.com/v0/b/${iconBucket.name}/o/${encodeURIComponent(iconFileName)}?alt=media&token=${iconToken}`;

                    resultText = iconDownloadUrl;
                    creditsUsed = 0.5; // Fixed cost for app icon, independent of base image price
                    logModelId = MODELS.IMAGE;
                    logExtras.imageCount = 1;
                    logExtras.imageUrl = iconDownloadUrl;
                    break;
                }

                case "webview_ai": {
                    if (!prompt) throw new Error("Prompt required");
                    if (resolvedVideos?.length) {
                        console.warn(`[Job ${jobId}] [WEBVIEW_AI] Video inputs not supported via OpenRouter — ignored`);
                    }
                    const waiResult = await generateWebviewAI({
                        prompt,
                        schema: schema as Record<string, unknown> | undefined,
                        images: resolvedImages,
                        audios: resolvedAudios,
                        useSearch,
                        requestedModel,
                        requestedTools,
                    }, getOR());
                    resultText = waiResult.text;
                    usage = sanitizeForFirestore(waiResult.usage);
                    creditsUsed = waiResult.creditsUsed;
                    logModelId = requestedModel ?? MODELS.WEBVIEW;
                    logExtras.searchQueries = waiResult.searchQueriesUsed;
                    auditLog.rawAiResponse = (resultText || '').substring(0, 10000);
                    auditLog.schemaProvided = !!schema;
                    auditLog.modelUsed = logModelId;
                    break;
                }

                case "webview_ai_image": {
                    if (!prompt) throw new Error("Prompt required for image generation");

                    console.log(`[Job ${jobId}] [WEBVIEW_AI_IMAGE] Generating image for: ${prompt.substring(0, 80)}...`);

                    const detectMimeTypeJobImg = (base64: string): string => {
                        if (base64.startsWith('/9j/')) return 'image/jpeg';
                        if (base64.startsWith('iVBOR')) return 'image/png';
                        return 'image/jpeg';
                    };

                    const inputImages = (resolvedImages ?? []).slice(0, 14);
                    const imgModel = inputImages.length > 0 ? MODELS.IMAGE_EDIT : MODELS.IMAGE;

                    const imgResult = await withRetry(() => getOR().chat.completions.create({
                        model: imgModel,
                        messages: [{
                            role: 'user',
                            content: [
                                { type: 'text', text: prompt },
                                ...inputImages.map((b64: string) => ({
                                    type: 'image_url' as const,
                                    image_url: { url: `data:${detectMimeTypeJobImg(b64)};base64,${b64}` },
                                })),
                            ],
                        }],
                    }));

                    usage = sanitizeForFirestore({
                        promptTokens: Math.max(0, imgResult.usage?.prompt_tokens ?? 0),
                        responseTokens: Math.max(0, imgResult.usage?.completion_tokens ?? 0),
                        thoughtsTokens: 0,
                        totalTokens: Math.max(0, imgResult.usage?.total_tokens ?? 0),
                        cachedTokens: 0,
                    });

                    // Extract image — OpenRouter may return images in message.images or message.content
                    const imgMsg = imgResult.choices[0]?.message as any;
                    const imgParts: any[] = Array.isArray(imgMsg?.images) ? imgMsg.images
                        : Array.isArray(imgMsg?.content) ? imgMsg.content : [];
                    let imageBase64 = '';
                    for (const part of imgParts) {
                        if (part?.type === 'image_url') {
                            const url: string = part.image_url?.url ?? '';
                            imageBase64 = url.includes(',') ? url.split(',')[1] : url;
                            break;
                        }
                    }

                    if (!imageBase64) throw new Error('No image generated by model');

                    // ====================================================
                    // UPLOAD TO FIREBASE STORAGE (Bypass 1MB Firestore limit)
                    // ====================================================
                    const bucket = getStorage().bucket();
                    // Detect actual MIME from magic bytes of generated image
                    const imageMime = imageBase64.startsWith('/9j/') ? 'image/jpeg'
                        : imageBase64.startsWith('iVBOR') ? 'image/png'
                            : 'image/jpeg';
                    const imageExt = imageMime === 'image/png' ? 'png' : 'jpeg';
                    const fileName = `generated_images/${uid}/${jobId}.${imageExt}`;
                    const file = bucket.file(fileName);

                    const token = require('crypto').randomUUID();
                    await file.save(Buffer.from(imageBase64, 'base64'), {
                        contentType: imageMime,
                        metadata: {
                            metadata: {
                                firebaseStorageDownloadTokens: token,
                                userId: uid,
                                jobId: jobId,
                            }
                        }
                    });

                    const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media&token=${token}`;

                    resultText = downloadUrl;
                    // Base cost + extra per inspiration image
                    creditsUsed = calcImageMana(inputImages.length);
                    logModelId = imgModel;
                    logExtras.imageCount = 1;
                    logExtras.imageUrl = downloadUrl;
                    break;
                }

                case 'webview_ai_video': {
                    console.log(`[Job ${jobId}] [WEBVIEW_AI_VIDEO] Generating video for: ${prompt.substring(0, 80)}...`);

                    const imageUrls: string[] = [];
                    const tempRefFiles: any[] = [];
                    for (const [i, raw] of (imagesBase64?.slice(0, 3) ?? []).entries()) {
                        if (!raw) continue;
                        if (raw.startsWith('http')) {
                            imageUrls.push(raw);
                        } else {
                            const refMime = raw.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
                            const refExt = refMime === 'image/png' ? 'png' : 'jpg';
                            const refBucket = getStorage().bucket();
                            const refFileName = `video_refs/${uid}/${jobId}_ref${i}.${refExt}`;
                            const refToken = require('crypto').randomUUID();
                            await refBucket.file(refFileName).save(Buffer.from(raw, 'base64'), {
                                contentType: refMime,
                                metadata: { metadata: { firebaseStorageDownloadTokens: refToken } },
                            });
                            imageUrls.push(`https://firebasestorage.googleapis.com/v0/b/${refBucket.name}/o/${encodeURIComponent(refFileName)}?alt=media&token=${refToken}`);
                            tempRefFiles.push(refBucket.file(refFileName));
                            console.log(`[Job ${jobId}] [WEBVIEW_AI_VIDEO] Uploaded ref image ${i} (${refMime}) to Storage`);
                        }
                    }

                    const hasImages = imageUrls.length > 0;
                    const videoModel = hasImages ? MODELS.VIDEO_STD : MODELS.VIDEO_FAST;

                    const genResponse = await withRetry(() =>
                        submitVideoJob(prompt, imageUrls, videoModel, OPENROUTER_API_KEY)
                    );

                    // Poll max 14 × 30s = 420s, staying within the 540s function timeout
                    const MAX_POLLS = 14;
                    const videoBuffer = await pollAndDownloadVideo(
                        genResponse.id,
                        genResponse.polling_url,
                        OPENROUTER_API_KEY,
                        MAX_POLLS,
                        30000,
                        (poll, max) => console.log(`[Job ${jobId}] [WEBVIEW_AI_VIDEO] Waiting for video... poll ${poll}/${max}`),
                    );

                    // Verify magic bytes for MP4 (00 00 00 ... ftyp)
                    const magic = videoBuffer.subarray(0, 12).toString('hex');
                    console.log(`[Job ${jobId}] [WEBVIEW_AI_VIDEO] Buffer size: ${videoBuffer.length} bytes. Magic bytes (hex): ${magic}`);

                    if (!magic.includes('66747970')) { // "ftyp" in hex
                        console.error(`[Job ${jobId}] [WEBVIEW_AI_VIDEO] WARNING: Buffer does not seem to be a valid MP4 file (missing ftyp)`);
                    }
                    // ====================================================
                    // UPLOAD TO FIREBASE STORAGE (Bypass 1MB Firestore limit)
                    // ====================================================
                    const bucket = getStorage().bucket();
                    const fileName = `generated_videos/${uid}/${jobId}.mp4`;
                    const file = bucket.file(fileName);

                    const token = require('crypto').randomUUID();
                    await file.save(videoBuffer, {
                        contentType: 'video/mp4',
                        metadata: {
                            metadata: {
                                firebaseStorageDownloadTokens: token,
                                userId: uid,
                                jobId: jobId,
                            }
                        }
                    });

                    const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media&token=${token}`;

                    // Delete temp reference images now that the video is downloaded
                    for (const f of tempRefFiles) {
                        f.delete().catch((e: any) =>
                            console.warn(`[Job ${jobId}] [WEBVIEW_AI_VIDEO] Failed to delete temp ref image: ${e.message}`)
                        );
                    }

                    resultText = downloadUrl;

                    const durationSeconds = 8; // OpenRouter doesn't expose duration metadata yet
                    creditsUsed = calcVideoMana(durationSeconds, hasImages);
                    logModelId = videoModel;
                    logExtras.durationSec = durationSeconds;
                    logExtras.videoUrl = downloadUrl;
                    break;

                }

                case "webview_ai_similarity": {
                    console.log(`[Job ${jobId}] [WEBVIEW_AI_SIMILARITY] items: ${items?.length ?? 0}`);
                    if (items.length < 2) throw new Error("At least 2 items required for similarity");

                    const embeddings = await Promise.all(
                        items.map((item: string) => getOR().embeddings.create({
                            model: MODELS.EMBED,
                            input: item,
                        }))
                    );
                    console.log(`[Job ${jobId}] [WEBVIEW_AI_SIMILARITY] Embeddings computed, building matrix...`);
                    const vectors = embeddings.map(e => e.data[0].embedding);
                    if (vectors.some(v => !v?.length)) throw new Error('Similarity model returned empty embeddings');

                    function cosine(a: number[], b: number[]): number {
                        let dot = 0, magA = 0, magB = 0;
                        for (let i = 0; i < a.length; i++) {
                            dot += a[i] * b[i];
                            magA += a[i] * a[i];
                            magB += b[i] * b[i];
                        }
                        return dot / (Math.sqrt(magA) * Math.sqrt(magB));
                    }

                    const matrix: number[][] = [];
                    for (let i = 0; i < vectors.length; i++) {
                        const row: number[] = [];
                        for (let j = 0; j < vectors.length; j++) {
                            if (i === j) {
                                row.push(1.0);
                            } else if (j < i) {
                                row.push(matrix[j][i]);
                            } else {
                                row.push(Math.round(cosine(vectors[i], vectors[j]) * 10000) / 10000);
                            }
                        }
                        matrix.push(row);
                    }

                    resultText = JSON.stringify({ matrix, vectors, count: items.length });
                    creditsUsed = items.length * 0.01;
                    usage = { promptTokens: 0, responseTokens: 0, thoughtsTokens: 0, totalTokens: 0, cachedTokens: 0 };
                    logModelId = MODELS.EMBED;
                    logExtras.itemCount = items.length;
                    break;
                }

                case 'webview_ai_tts': {
                    if (!prompt) throw new Error('Text required for TTS');

                    const selectedVoice = voiceName || 'Aoede';
                    console.log(`[Job ${jobId}] [WEBVIEW_AI_TTS] voice=${selectedVoice}, text="${prompt.substring(0, 60)}..."`);

                    const ttsResponse = await withRetry(() =>
                        getOR().audio.speech.create({
                            model: MODELS.TTS,
                            input: prompt,
                            voice: selectedVoice as any,
                            response_format: 'pcm',
                        })
                    );
                    const pcmBuffer = Buffer.from(await ttsResponse.arrayBuffer());
                    if (!pcmBuffer.length) throw new Error('TTS returned empty audio buffer');
                    const audioBuffer = pcmToWav(pcmBuffer);

                    // Estimate usage for cost calculation (TTS token counts not exposed by OpenRouter audio endpoint)
                    const estimatedInputTokens = Math.ceil(prompt.length / 4);
                    const estimatedOutputTokens = Math.ceil(audioBuffer.length / 32);
                    usage = sanitizeForFirestore({
                        promptTokens: estimatedInputTokens,
                        responseTokens: estimatedOutputTokens,
                        thoughtsTokens: 0,
                        totalTokens: estimatedInputTokens + estimatedOutputTokens,
                        cachedTokens: 0,
                    });
                    const ttsCostUsd = calculateCostUsd(MODELS.TTS, usage);
                    creditsUsed = ttsCostUsd / MANA_VALUE_USD;

                    // ====================================================
                    // UPLOAD TO FIREBASE STORAGE (Bypass 1MB Firestore limit)
                    // ====================================================
                    if (audioBuffer.length > 800_000) {
                        console.log(`[Job ${jobId}] [WEBVIEW_AI_TTS] Audio size (${Math.round(audioBuffer.length / 1024)}KB) exceeds threshold. Uploading to Storage...`);
                        const bucket = getStorage().bucket();
                        const fileName = `generated_audio/${uid}/${jobId}.wav`;
                        const file = bucket.file(fileName);

                        const token = require('crypto').randomUUID();
                        await file.save(audioBuffer, {
                            contentType: 'audio/wav',
                            metadata: {
                                metadata: {
                                    firebaseStorageDownloadTokens: token,
                                    userId: uid,
                                    jobId: jobId,
                                }
                            }
                        });

                        const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media&token=${token}`;
                        resultText = downloadUrl;
                        logExtras.audioUrl = downloadUrl;
                    } else {
                        resultText = audioBuffer.toString('base64');
                    }

                    logModelId = MODELS.TTS;
                    break;
                }

                default:
                    console.error(`[Job ${jobId}] Unknown action: ${action}`);
                    throw new Error(`Invalid Async Action: ${action}`);
            }

            // Deduct Credits
            // creditsUsed is set inside the switch per action type
            let costUsd: number;
            if (action === 'webview_ai_image' || action === 'webview_ai_video') {
                costUsd = creditsUsed * MANA_VALUE_USD;
            } else {
                costUsd = calculateCostUsd(logModelId, usage, {
                    searchQueries: logExtras.searchQueries,
                    mapsQueries: logExtras.mapsQueries,
                });
            }

            await db.runTransaction(async (t) => {
                const ref = db.collection("users").doc(uid);
                const doc = await t.get(ref);
                if (doc.exists) {
                    const data = doc.data()!;

                    // Rate limit check
                    const limitError = await checkRateLimit(ref, t, data);
                    if (limitError) throw new Error(`RATE_LIMITED: ${limitError}`);

                    // Balance was already reduced by preDeductedMana; apply the delta
                    // between estimated and actual cost (positive delta = refund, negative = extra charge).
                    const preDeductDelta = preDeductedMana - creditsUsed;
                    const newCredits = Math.max(0, (data.credits || 0) + preDeductDelta);
                    preDeductedMana = 0; // mark as settled so the catch block does not double-refund
                    t.update(ref, {
                        credits: newCredits,
                        creditsUsed: FieldValue.increment(creditsUsed),
                        'rateLimit.tokensThisMinute': FieldValue.increment(usage.totalTokens || 0),
                        lastActive: FieldValue.serverTimestamp(),
                    });

                    // Ensure EVERYTHING in finalResult is a primitive or basic Array/Object.
                    // This explicitly strips out grpc-js Metadata or any hidden SDK classes.
                    const finalResult = {
                        text: compressContent(resultText || ""),
                        costUsd: Math.max(0, Number(costUsd) || 0),
                        creditsUsed: Math.max(0, Number(creditsUsed) || 0),
                        creditsRemaining: Math.max(0, Number(newCredits) || 0),
                        usage: {
                            promptTokens: Math.max(0, Number(usage?.promptTokens) || 0),
                            responseTokens: Math.max(0, Number(usage?.responseTokens) || 0),
                            thoughtsTokens: Math.max(0, Number(usage?.thoughtsTokens) || 0),
                            totalTokens: Math.max(0, Number(usage?.totalTokens) || 0),
                            cachedTokens: Math.max(0, Number(usage?.cachedTokens) || 0),
                        },
                        appName: appName ? String(appName) : undefined,
                    };

                    const resultSize = JSON.stringify(finalResult).length;
                    if (resultSize > 1000000) {
                        console.warn(`[Job ${jobId}] WARNING: Result size is large: ${resultSize} chars`);
                    }

                    // ABSOLUTE FINAL SAFETY CAST - This is mathematically guaranteed to remove all hidden classes
                    // or gRPC artifacts that might have bypassed previous checks.
                    let safeResult = sanitizeForFirestore(finalResult);
                    let safeAudit = sanitizeForFirestore(auditLog);

                    try {
                        safeResult = JSON.parse(JSON.stringify(safeResult));
                        safeAudit = JSON.parse(JSON.stringify(safeAudit));
                    } catch (stringifyErr) {
                        console.error(`[Job ${jobId}] JSON stringify failed! Data contained circular/invalid structure:`, stringifyErr);
                    }

                    console.log(`[Job ${jobId}] safeResult keys: ${Object.keys(safeResult || {})}`);
                    console.log(`[Job ${jobId}] safeResult.usage keys: ${Object.keys((safeResult || {}).usage || {})}`);
                    console.log(`[Job ${jobId}] final safeResult string snippet: ${JSON.stringify(safeResult).substring(0, 300)}`);

                    try {
                        t.update(snapshot.ref, {
                            status: 'completed',
                            completedAt: FieldValue.serverTimestamp(),
                            result: safeResult,
                            audit: safeAudit // Save audited logs
                        });
                    } catch (updateErr) {
                        console.error(`[Job ${jobId}] t.update failed for completed state:`, updateErr);
                        throw updateErr;
                    }

                    // Write usage log
                    const logRef = db.collection('users').doc(uid).collection('usageLogs').doc();
                    t.set(logRef, {
                        action,
                        modelId: logModelId,
                        promptTokens: usage.promptTokens,
                        responseTokens: usage.responseTokens,
                        thoughtsTokens: usage.thoughtsTokens,
                        totalTokens: usage.totalTokens,
                        cachedTokens: usage.cachedTokens ?? 0,
                        costUsd,
                        creditsUsed,
                        timestamp: FieldValue.serverTimestamp(),
                        jobId,
                        ...sanitizeForFirestore(logExtras),
                    });
                }
            });

            // Send push notification on success (only for spell creation/editing)
            if (action === 'create' || action === 'edit') {
                await sendJobNotification(uid, action, true, {
                    jobId,
                    status: 'completed',
                    appId: String(payload?.appId ?? ''),
                    notificationType: action === 'create' ? 'app_created' : 'app_edited',
                });
            }

        } catch (error: any) {
            console.error(`Job ${jobId} failed:`, error);
            const errorMsg = typeof error?.message === 'string' ? error.message : String(error || 'Unknown error');

            // Refund the pre-deducted amount if the AI call never completed (or the
            // success transaction was rolled back). preDeductedMana is zeroed out by the
            // success path once it settles, so this only runs on genuine failures.
            if (preDeductedMana > 0) {
                try {
                    await userRef.update({ credits: FieldValue.increment(preDeductedMana) });
                    console.log(`[Job ${jobId}] Refunded ${preDeductedMana} mana to user ${uid} after failure.`);
                } catch (refundErr) {
                    console.error(`[Job ${jobId}] CRITICAL: Failed to refund ${preDeductedMana} mana to user ${uid}:`, refundErr);
                }
            }

            try {
                const currentDoc = await snapshot.ref.get();
                if (currentDoc.data()?.status === 'completed') return; // transaction already committed, don't overwrite
                await snapshot.ref.update({
                    status: 'failed',
                    error: errorMsg,
                    failedAt: FieldValue.serverTimestamp(),
                });

                if (action === 'create' || action === 'edit') {
                    await sendJobNotification(uid, action, false, {
                        jobId,
                        status: 'failed',
                        appId: String(payload?.appId ?? ''),
                        notificationType: action === 'create' ? 'app_created' : 'app_edited',
                    });
                }
            } catch (fallbackErr) {
                console.error(`[Job ${jobId}] Failed to write failure state to Firestore:`, fallbackErr);
            }
        }
    }
);

/**
 * uploadMedia: Securely upload large base64 media (images/videos/audios)
 * from the app to Firebase Storage and return URLs.
 * This bypasses the 1MB Firestore document limit for job payloads.
 */
export const uploadMedia = onCall({
    region: 'southamerica-east1',
    enforceAppCheck: false, // Set to true if app check is fully configured
    memory: '1GiB',
    timeoutSeconds: 300,
}, async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required');
    const uid = request.auth.uid;
    const { media, contentType } = request.data;

    if (!Array.isArray(media) || media.length === 0) {
        throw new HttpsError('invalid-argument', 'Media array required');
    }

    const MAX_FILES = 15;
    const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file

    if (media.length > MAX_FILES) {
        throw new HttpsError('invalid-argument', `Too many files (max ${MAX_FILES})`);
    }
    for (const base64 of media) {
        if (typeof base64 !== 'string') {
            throw new HttpsError('invalid-argument', 'Invalid media data');
        }
        // base64 encodes 3 bytes as 4 chars; approximate decoded size
        const approxBytes = Math.ceil(base64.length * 0.75);
        if (approxBytes > MAX_FILE_BYTES) {
            throw new HttpsError('invalid-argument', `File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
        }
    }

    const bucket = getStorage().bucket();
    const urls: string[] = [];

    for (const base64 of media) {
        const uuid = require('crypto').randomUUID();
        const ext = contentType?.split('/')[1] || 'bin';
        const fileName = `job_inputs/${uid}/${uuid}.${ext}`;
        const file = bucket.file(fileName);

        const token = require('crypto').randomUUID();
        await file.save(Buffer.from(base64, 'base64'), {
            contentType: contentType || 'application/octet-stream',
            metadata: {
                metadata: {
                    firebaseStorageDownloadTokens: token,
                    userId: uid,
                }
            }
        });

        const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media&token=${token}`;
        urls.push(url);
    }

    return { urls };
});

export const claimInstallBonus = onCall({ region: 'southamerica-east1' }, async (request) => {
    const uid = request.auth?.uid;
    const bonus = 2;
    if (!uid) throw new HttpsError('unauthenticated', 'Not authenticated');

    const hardwareId: string | undefined = request.data?.hardwareId;
    if (!hardwareId || hardwareId.length < 4) {
        throw new HttpsError('invalid-argument', 'Missing hardwareId');
    }

    // Fetch Google UID server-side — cannot be forged by client
    const userRecord = await getAuth().getUser(uid);
    const googleProvider = userRecord.providerData.find(p => p.providerId === 'google.com');
    const googleUid = googleProvider?.uid;
    if (!googleUid) throw new HttpsError('failed-precondition', 'No Google account linked');

    const deviceRef = db.collection('install_bonuses').doc(`device_${hardwareId}`);
    const googleRef = db.collection('install_bonuses').doc(`google_${googleUid}`);

    const result = await db.runTransaction(async (tx) => {
        const [deviceDoc, googleDoc] = await Promise.all([tx.get(deviceRef), tx.get(googleRef)]);
        if (deviceDoc.exists || googleDoc.exists) {
            return { granted: false };
        }

        const userRef = db.collection('users').doc(uid);
        const userDoc = await tx.get(userRef);
        const current = userDoc.exists ? (userDoc.data()?.credits ?? 0) : 0;
        const now = FieldValue.serverTimestamp();

        tx.set(deviceRef, { claimedAt: now, userId: uid, googleUid, hardwareId });
        tx.set(googleRef, { claimedAt: now, userId: uid, googleUid, hardwareId });
        tx.set(userRef, { credits: current + bonus }, { merge: true });
        tx.set(userRef.collection('creditLogs').doc(), { amount: bonus, source: 'install_bonus', timestamp: now });

        return { granted: true, newBalance: current + bonus, bonusAmount: bonus };
    });

    return result;
});

export const estimateManaCost = onCall({
    region: 'southamerica-east1',
    enforceAppCheck: false,
}, async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required');

    const { type, data } = request.data;
    if (!type || !data) throw new HttpsError('invalid-argument', 'Type and data required');

    return computeManaCost(type, data);
});

// ============= SPELL STORE =============

const PUBLISH_SPELL_HOURLY_LIMIT = 10;
const PUBLISH_SPELL_MAX_HTML_BYTES = 512000;

interface PublishSpellInput {
    name: string;
    description?: string;
    htmlBase64: string;
    version: number;
    previewImageBase64?: string;
    iconBase64?: string;
    visibility: 'public' | 'unlisted';
    forkOfSpellId?: string;
    locale?: string;
    existingSpellId?: string;
}

interface UnpublishSpellInput {
    spellId: string;
}

async function checkPublishRateLimit(uid: string): Promise<void> {
    const userRef = db.collection('users').doc(uid);
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const data = snap.exists ? snap.data() ?? {} : {};
        const now = Date.now();
        const hourAgo = now - 60 * 60 * 1000;
        const rawTimes: number[] = Array.isArray(data.publishSpellTimes) ? data.publishSpellTimes : [];
        const recent = rawTimes.filter(t => typeof t === 'number' && t > hourAgo);
        if (recent.length >= PUBLISH_SPELL_HOURLY_LIMIT) {
            throw new HttpsError('resource-exhausted',
                `Publish rate limit reached (${PUBLISH_SPELL_HOURLY_LIMIT}/hour). Try again later.`);
        }
        recent.push(now);
        tx.set(userRef, { publishSpellTimes: recent }, { merge: true });
    });
}

async function uploadPublicAsset(
    storagePath: string,
    buffer: Buffer,
    contentType: string,
): Promise<void> {
    const bucket = getStorage().bucket();
    const file = bucket.file(storagePath);
    await file.save(buffer, {
        contentType,
        metadata: { contentType },
    });
    try {
        await file.makePublic();
    } catch (e) {
        console.warn(`[publishSpell] makePublic failed for ${storagePath}:`, e);
    }
}

export const publishSpell = onCall<PublishSpellInput>(
    {
        region: 'southamerica-east1',
        enforceAppCheck: false,
        memory: '512MiB',
        timeoutSeconds: 120,
        secrets: ['OPENROUTER_API_KEY'],
    },
    async (request) => {
        if (!request.auth) throw new HttpsError('unauthenticated', 'Login required');
        const provider = (request.auth.token as any)?.firebase?.sign_in_provider;
        if (provider === 'anonymous') {
            throw new HttpsError('permission-denied', 'Sign in with Google to publish spells to the Store');
        }

        const { name, description, htmlBase64, version, previewImageBase64, iconBase64, visibility, forkOfSpellId, locale, existingSpellId } = request.data;
        if (!name || typeof name !== 'string') throw new HttpsError('invalid-argument', 'Spell name required');
        if (!htmlBase64 || typeof htmlBase64 !== 'string') throw new HttpsError('invalid-argument', 'Spell HTML required');
        if (visibility !== 'public' && visibility !== 'unlisted') {
            throw new HttpsError('invalid-argument', 'visibility must be "public" or "unlisted"');
        }
        if (typeof version !== 'number' || version < 1) {
            throw new HttpsError('invalid-argument', 'version must be a positive number');
        }
        if (forkOfSpellId !== undefined && typeof forkOfSpellId !== 'string') {
            throw new HttpsError('invalid-argument', 'forkOfSpellId must be a string');
        }

        await checkPublishRateLimit(request.auth.uid);

        if (!htmlBase64.startsWith('GZIP:')) {
            throw new HttpsError('invalid-argument', 'Spell HTML must be gzip-compressed');
        }
        let html: string;
        try {
            html = zlib.gunzipSync(Buffer.from(htmlBase64.substring(5), 'base64')).toString('utf-8');
        } catch {
            throw new HttpsError('invalid-argument', 'Failed to decompress spell HTML');
        }

        if (Buffer.byteLength(html, 'utf-8') > PUBLISH_SPELL_MAX_HTML_BYTES) {
            throw new HttpsError('invalid-argument', 'Spell HTML too large (max 500KB)');
        }

        const { html: sanitizedHtml, violations } = sanitizeSpellHtml(html);
        if (violations.length > 0) {
            throw new HttpsError('invalid-argument', 'Spell contains unsafe content: ' + violations.join(', '));
        }

        const slug = generateSlug(name);

        // Resolve doc reference: update existing listing or create new
        let spellRef = db.collection('store_spells').doc();
        let spellId = spellRef.id;
        let isUpdate = false;
        if (existingSpellId && typeof existingSpellId === 'string') {
            const existingSnap = await db.collection('store_spells').doc(existingSpellId).get();
            if (existingSnap.exists && existingSnap.data()?.authorUid === request.auth!.uid) {
                spellRef = existingSnap.ref;
                spellId = existingSpellId;
                isUpdate = true;
            }
        }

        const htmlStoragePath = `store_html/${spellId}/spell.html`;
        const uploadedPaths: string[] = [];
        try {
            await uploadPublicAsset(
                htmlStoragePath,
                Buffer.from(sanitizedHtml, 'utf-8'),
                'text/html; charset=utf-8',
            );
            uploadedPaths.push(htmlStoragePath);

            let previewImagePath: string | null = null;
            if (previewImageBase64) {
                previewImagePath = `store_previews/${spellId}/preview.png`;
                await uploadPublicAsset(
                    previewImagePath,
                    Buffer.from(previewImageBase64, 'base64'),
                    'image/png',
                );
                uploadedPaths.push(previewImagePath);
            }

            let iconPath: string | null = null;
            if (iconBase64) {
                iconPath = `store_icons/${spellId}/icon.png`;
                await uploadPublicAsset(
                    iconPath,
                    Buffer.from(iconBase64, 'base64'),
                    'image/png',
                );
                uploadedPaths.push(iconPath);
            }

            const finalDescription = (description ?? '').trim();
            if (!finalDescription) {
                throw new HttpsError('invalid-argument', 'Description is required');
            }

            const hintLang = typeof locale === 'string' ? locale.split('-')[0].toLowerCase() : undefined;
            const originalLang = hintLang ?? 'en';
            const translations: Record<string, { name: string; description: string }> = {
                [originalLang]: { name, description: finalDescription },
            };
            const translationsStatus = visibility === 'public' ? 'pending' : 'skipped';

            const userRecord = await getAuth().getUser(request.auth!.uid);
            const authorName = userRecord.displayName || null;

            // Resolve variant lineage: look up parent to find the root of the family tree
            let resolvedForkOfSpellId: string | null = null;
            let rootSpellId = spellId;
            if (forkOfSpellId) {
                const parentSnap = await db.collection('store_spells').doc(forkOfSpellId).get();
                if (parentSnap.exists) {
                    resolvedForkOfSpellId = forkOfSpellId;
                    const parentData = parentSnap.data()!;
                    rootSpellId = typeof parentData.rootSpellId === 'string' ? parentData.rootSpellId : forkOfSpellId;
                }
            }

            const storeUrl = `https://appacadabra.ai/store/${spellId}/${slug}`;
            await db.runTransaction(async (tx) => {
                if (isUpdate) {
                    tx.update(spellRef, {
                        name,
                        description: finalDescription,
                        originalLang,
                        translations,
                        translationsStatus,
                        slug,
                        htmlStoragePath,
                        previewImagePath,
                        iconPath,
                        publishedVersion: version,
                        forkOfSpellId: resolvedForkOfSpellId,
                        rootSpellId,
                        updatedAt: FieldValue.serverTimestamp(),
                        status: 'active',
                        visibility,
                    });
                } else {
                    tx.set(spellRef, {
                        authorUid: request.auth!.uid,
                        authorName,
                        name,
                        description: finalDescription,
                        originalLang,
                        translations,
                        translationsStatus,
                        slug,
                        htmlStoragePath,
                        previewImagePath,
                        iconPath,
                        publishedVersion: version,
                        learnCount: 0,
                        variantCount: 0,
                        forkOfSpellId: resolvedForkOfSpellId,
                        rootSpellId,
                        publishedAt: FieldValue.serverTimestamp(),
                        updatedAt: FieldValue.serverTimestamp(),
                        status: 'active',
                        visibility,
                    });
                    if (resolvedForkOfSpellId) {
                        tx.update(db.collection('store_spells').doc(resolvedForkOfSpellId), {
                            variantCount: FieldValue.increment(1),
                        });
                    }
                }
            });

            return { spellId, slug, storeUrl };
        } catch (e) {
            if (uploadedPaths.length > 0) {
                const bucket = getStorage().bucket();
                await Promise.allSettled(uploadedPaths.map(p => bucket.file(p).delete()));
            }
            throw e;
        }
    }
);

export const unpublishSpell = onCall<UnpublishSpellInput>(
    {
        region: 'southamerica-east1',
        enforceAppCheck: false,
    },
    async (request) => {
        if (!request.auth) throw new HttpsError('unauthenticated', 'Login required');
        const provider = (request.auth.token as any)?.firebase?.sign_in_provider;
        if (provider === 'anonymous') {
            throw new HttpsError('permission-denied', 'Anonymous users cannot unpublish spells');
        }

        const { spellId } = request.data;
        if (!spellId || typeof spellId !== 'string') {
            throw new HttpsError('invalid-argument', 'spellId required');
        }

        const spellRef = db.collection('store_spells').doc(spellId);
        const snap = await spellRef.get();
        if (!snap.exists) throw new HttpsError('not-found', 'Spell not found');

        const data = snap.data()!;
        if (data.authorUid !== request.auth.uid) {
            throw new HttpsError('permission-denied', 'You can only unpublish your own spells');
        }

        await spellRef.update({
            status: 'removed',
            updatedAt: FieldValue.serverTimestamp(),
        });

        const bucket = getStorage().bucket();
        const pathsToDelete = [data.htmlStoragePath, data.iconPath, data.previewImagePath]
            .filter((p): p is string => typeof p === 'string');
        await Promise.allSettled(pathsToDelete.map(p => bucket.file(p).delete()));

        return { success: true };
    }
);

export const getMyPublishedSpells = onCall(
    { region: 'southamerica-east1', enforceAppCheck: false },
    async (request) => {
        if (!request.auth) throw new HttpsError('unauthenticated', 'Login required');
        const snap = await db.collection('store_spells')
            .where('authorUid', '==', request.auth.uid)
            .where('status', '==', 'active')
            .get();
        return {
            spells: snap.docs.map(d => ({
                spellId: d.id,
                name: d.data().name as string,
                slug: d.data().slug as string,
                visibility: d.data().visibility as 'public' | 'unlisted',
            })),
        };
    },
);

export const translateStoreSpell = onDocumentWritten(
    {
        document: 'store_spells/{spellId}',
        region: 'southamerica-east1',
        timeoutSeconds: 120,
        secrets: ['OPENROUTER_API_KEY'],
    },
    async (event) => {
        const after = event.data?.after;
        if (!after?.exists) return;
        const data = after.data()!;
        if (data.translationsStatus !== 'pending') return;

        try {
            await after.ref.update({ translationsStatus: 'processing' });
        } catch {
            return;
        }

        try {
            const hintLang = typeof data.originalLang === 'string' ? data.originalLang : undefined;
            const result = await translateSpellMeta(data.name, data.description, getOR(), hintLang);
            await after.ref.update({
                translations: result.translations,
                originalLang: result.originalLang,
                translationsStatus: 'done',
            });
        } catch (e: any) {
            console.warn('[translateStoreSpell] failed:', e?.message);
            await after.ref.update({ translationsStatus: 'failed' });
        }
    },
);

export const learnSpell = onCall<{ spellId: string }>(
    {
        region: 'southamerica-east1',
        timeoutSeconds: 30,
    },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError('unauthenticated', 'Sign in with Google to learn spells.');
        }
        const provider = (request.auth.token as any)?.firebase?.sign_in_provider;
        if (provider === 'anonymous') {
            throw new HttpsError('unauthenticated', 'Sign in with Google to learn spells.');
        }
        const uid = request.auth.uid;
        const { spellId } = request.data;
        if (!spellId || typeof spellId !== 'string') {
            throw new HttpsError('invalid-argument', 'spellId is required.');
        }

        const learnedRef = db.collection('users').doc(uid)
            .collection('learned_spells').doc(spellId);
        const spellRef = db.collection('store_spells').doc(spellId);

        let alreadyLearned = false;
        await db.runTransaction(async (tx) => {
            const [learnedSnap, spellSnap] = await Promise.all([
                tx.get(learnedRef),
                tx.get(spellRef),
            ]);
            if (learnedSnap.exists) {
                alreadyLearned = true;
                return;
            }
            if (!spellSnap.exists || spellSnap.data()?.status !== 'active') {
                throw new HttpsError('not-found', 'Spell not found or no longer available.');
            }
            tx.set(learnedRef, {
                spellId,
                learnedAt: FieldValue.serverTimestamp(),
                syncedToApp: false,
                localAppId: null,
            });
            tx.update(spellRef, {
                learnCount: FieldValue.increment(1),
            });
        });

        if (alreadyLearned) return { alreadyLearned: true };
        return { success: true };
    }
);

export const unlearnSpell = onCall<{ spellId: string }>(
    {
        region: 'southamerica-east1',
        timeoutSeconds: 30,
    },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError('unauthenticated', 'Sign in with Google to unlearn spells.');
        }
        const provider = (request.auth.token as any)?.firebase?.sign_in_provider;
        if (provider === 'anonymous') {
            throw new HttpsError('unauthenticated', 'Sign in with Google to unlearn spells.');
        }
        const uid = request.auth.uid;
        const { spellId } = request.data;
        if (!spellId || typeof spellId !== 'string') {
            throw new HttpsError('invalid-argument', 'spellId is required.');
        }

        const learnedRef = db.collection('users').doc(uid)
            .collection('learned_spells').doc(spellId);
        const learnedSnap = await learnedRef.get();
        if (!learnedSnap.exists) {
            return { ok: true, alreadyUnlearned: true };
        }
        await learnedRef.delete();
        // Best-effort decrement of learnCount; failure here is non-fatal because the
        // user-facing source of truth (learned_spells doc) is already gone.
        await db.collection('store_spells').doc(spellId).update({
            learnCount: FieldValue.increment(-1),
        }).catch(() => {});
        return { ok: true };
    }
);

interface SyncedSpellItem {
    spellId: string;
    slug: string;
    name: string;
    description: string;
    iconPath: string | null;
    authorName: string;
    publishedVersion: number;
    signedHtmlUrl: string;
    originalLang?: string;
    translations?: Record<string, { name: string; description: string }>;
    forkOfSpellId?: string | null;
    rootSpellId?: string;
}

export const syncLearnedSpells = onCall<{ lastSyncedAt?: number; forceSpellId?: string; recoverAll?: boolean } | undefined>(
    {
        region: 'southamerica-east1',
        timeoutSeconds: 30,
    },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError('unauthenticated', 'Sign in with Google to sync learned spells.');
        }
        const provider = (request.auth.token as any)?.firebase?.sign_in_provider;
        if (provider === 'anonymous') {
            throw new HttpsError('unauthenticated', 'Sign in with Google to sync learned spells.');
        }
        const uid = request.auth.uid;
        const forceSpellId = typeof request.data?.forceSpellId === 'string' ? request.data.forceSpellId : null;
        const recoverAll = request.data?.recoverAll === true;

        // When recoverAll, return every learned spell so the client can re-import any that
        // are missing locally (covers reinstall and cross-device cases). The client filters
        // out tombstoned spells before re-inserting.
        const baseQuery = db
            .collection('users').doc(uid)
            .collection('learned_spells');
        const learnedSnap = recoverAll
            ? await baseQuery.get()
            : await baseQuery.where('syncedToApp', '==', false).get();

        // Invariant: forceSpellId covers reinstall — a learned spell can be returned even if
        // it was previously marked syncedToApp on a different installation.
        const candidateIds = new Set<string>(learnedSnap.docs.map(d => d.id));
        if (forceSpellId && !candidateIds.has(forceSpellId)) {
            const forcedSnap = await db
                .collection('users').doc(uid)
                .collection('learned_spells').doc(forceSpellId)
                .get();
            if (forcedSnap.exists) {
                candidateIds.add(forceSpellId);
            }
        }

        if (candidateIds.size === 0) return { spells: [] };

        const bucket = getStorage().bucket();
        const expiresAt = Date.now() + 60 * 60 * 1000;

        const results = await Promise.all(Array.from(candidateIds).map(async (spellId) => {
            try {
                const spellSnap = await db.collection('store_spells').doc(spellId).get();
                if (!spellSnap.exists) return null;
                const spell = spellSnap.data()!;
                if (spell.status !== 'active') return null;
                if (!spell.htmlStoragePath) return null;

                const [signedHtmlUrl] = await bucket.file(spell.htmlStoragePath).getSignedUrl({
                    action: 'read',
                    expires: expiresAt,
                });

                const item: SyncedSpellItem = {
                    spellId,
                    slug: spell.slug ?? '',
                    name: spell.name ?? 'Spell',
                    description: spell.description ?? '',
                    iconPath: spell.iconPath ?? null,
                    authorName: spell.authorName ?? 'Anonymous',
                    publishedVersion: typeof spell.publishedVersion === 'number' ? spell.publishedVersion : 1,
                    signedHtmlUrl,
                    originalLang: typeof spell.originalLang === 'string' ? spell.originalLang : 'en',
                    translations: (spell.translations && typeof spell.translations === 'object')
                        ? spell.translations as Record<string, { name: string; description: string }>
                        : {},
                    forkOfSpellId: typeof spell.forkOfSpellId === 'string' ? spell.forkOfSpellId : null,
                    rootSpellId: typeof spell.rootSpellId === 'string' ? spell.rootSpellId : spellId,
                };
                return item;
            } catch (e) {
                console.warn(`[syncLearnedSpells] Failed to prepare spell ${spellId}:`, e);
                return null;
            }
        }));

        const spells = results.filter((s): s is SyncedSpellItem => s !== null);
        return { spells };
    }
);

export const markSpellSynced = onCall<{ spellId: string; localAppId: number | null; syncedToApp: boolean }>(
    {
        region: 'southamerica-east1',
        timeoutSeconds: 30,
    },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError('unauthenticated', 'Sign in with Google to sync learned spells.');
        }
        const provider = (request.auth.token as any)?.firebase?.sign_in_provider;
        if (provider === 'anonymous') {
            throw new HttpsError('unauthenticated', 'Sign in with Google to sync learned spells.');
        }
        const uid = request.auth.uid;

        const { spellId, localAppId, syncedToApp } = request.data;
        if (!spellId || typeof spellId !== 'string') {
            throw new HttpsError('invalid-argument', 'spellId is required.');
        }
        if (typeof syncedToApp !== 'boolean') {
            throw new HttpsError('invalid-argument', 'syncedToApp must be a boolean.');
        }
        if (localAppId !== null && typeof localAppId !== 'number') {
            throw new HttpsError('invalid-argument', 'localAppId must be a number or null.');
        }

        const learnedRef = db.collection('users').doc(uid)
            .collection('learned_spells').doc(spellId);
        await learnedRef.set({
            syncedToApp,
            localAppId,
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        return { success: true };
    }
);
