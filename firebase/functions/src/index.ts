/**
 * Firebase Functions for Appacadabra
 * Handles all AI operations with credit management via Firestore
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, DocumentReference, Transaction, DocumentData } from "firebase-admin/firestore";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAICacheManager } from "@google/generative-ai/server";
// @ts-ignore - installed at deploy time via package.json
import { GoogleGenAI, VideoGenerationReferenceType } from "@google/genai";
import * as zlib from 'zlib';
import {
    SYSTEM_INSTRUCTIONS,
    CONVERT_PROJECT_PROMPT,
    // Unified 2-Step Prompts
    UNIFIED_CREATE_PLANNER_PROMPT,
    UNIFIED_CREATE_CODE_PROMPT,
    UNIFIED_EDIT_PLANNER_PROMPT,
    UNIFIED_EDIT_MIGRATE_PROMPT,
    validateContentRequest,
} from "./prompts";
import { validateGeneratedCode, generateFixPrompt } from "./codeValidator";
import { validateWithExecution } from "./executionValidator";

// Initialize Firebase Admin
initializeApp();
const db = getFirestore();

// Initialize Gemini AI (API key from environment)
const API_KEY = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(API_KEY);
// @ts-ignore - lazy to avoid "API key must be set" error during deploy analysis
let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI { return _ai ?? (_ai = new GoogleGenAI({ apiKey: API_KEY })); }

// Models configuration
// Main models for Create/Edit/Convert (kept as fallback if cache fails)
const mainModel = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
    // @ts-ignore
    tools: [{ googleSearch: {} }],
    generationConfig: {
        // @ts-ignore
        thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: "high"
        }
    }
});

// Context Caching for SYSTEM_INSTRUCTIONS (~1,800 tokens)
// Cache read: 25% of input price → significant savings at volume
const cacheManager = new GoogleAICacheManager(API_KEY);
let _sysCache: any = null;
let _sysCacheExpiresAt = 0;
const CACHE_TTL_S = 3600;           // 1 hour TTL
const CACHE_RENEW_BEFORE_MS = 5 * 60 * 1000;  // renew 5 min before expiry

async function getMainModelWithCache() {
    const now = Date.now();
    if (!_sysCache || now > _sysCacheExpiresAt - CACHE_RENEW_BEFORE_MS) {
        console.log('[CACHE] Creating/renewing SYSTEM_INSTRUCTIONS cache...');
        _sysCache = await cacheManager.create({
            model: 'models/gemini-3-flash-preview',
            systemInstruction: {
                role: 'system',
                parts: [{ text: SYSTEM_INSTRUCTIONS }],
            },
            // contents is technically required by the SDK types but the API accepts
            // caches with only systemInstruction. Cast to avoid the TypeScript error.
            contents: [],
            ttlSeconds: CACHE_TTL_S,
        } as any);
        _sysCacheExpiresAt = now + CACHE_TTL_S * 1000;
        console.log(`[CACHE] Cache created: ${_sysCache.name}`);
    }
    return genAI.getGenerativeModelFromCachedContent(_sysCache, {
        // @ts-ignore
        tools: [{ googleSearch: {} }],
        generationConfig: {
            // @ts-ignore
            thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' },
        },
    });
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

function pcmToWav(pcmData: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
    const byteRate = sampleRate * channels * bitsPerSample / 8;
    const blockAlign = channels * bitsPerSample / 8;
    const dataSize = pcmData.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);        // AudioFormat: PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcmData]);
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
};

interface RateLimitData {
    callsThisMinute: number;
    tokensThisMinute: number;
    lastMinuteReset: number;
    cooldownUntil?: number;
}

// Check and update rate limits (returns error message if rate limited)
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

    // Check if user is in cooldown
    if (rateLimit.cooldownUntil && now < rateLimit.cooldownUntil) {
        const remainingSecs = Math.ceil((rateLimit.cooldownUntil - now) / 1000);
        return `Rate limited. Try again in ${remainingSecs} seconds.`;
    }

    // Reset minute counters if a minute has passed
    if (now - rateLimit.lastMinuteReset > 60000) {
        rateLimit.callsThisMinute = 0;
        rateLimit.tokensThisMinute = 0;
        rateLimit.lastMinuteReset = now;
    }

    // Check limits
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

    // Increment call counter
    rateLimit.callsThisMinute++;

    // Update rate limit in transaction (tokens will be added after generation)
    transaction.update(userRef, { rateLimit });

    return null; // No rate limit hit
}


interface PreviousEdit {
    version: number;
    instruction: string;
}

interface GenerateSpellResponse {
    text: string;
    usage: {
        promptTokens: number;
        responseTokens: number;
        thoughtsTokens: number;
        totalTokens: number;
        cachedTokens: number;
    };
    creditsUsed: number;
    creditsRemaining: number;
}

// Pricing Constants (Tokens per 1 Mana)
const FIXED_COST_CREATE_EDIT = 1.0;

interface PricingTier {
    tokensPerMana: number;
}

// Pricing Table
const PRICING_TABLE: Record<string, PricingTier> = {
    'gemini-3-flash-preview:search': { tokensPerMana: 12000 },
    'gemini-3-flash-preview:none': { tokensPerMana: 24000 },
    'gemini-2.5-flash:full_tools': { tokensPerMana: 12000 }, // Search + Maps
    'gemini-2.5-flash:partial_tools': { tokensPerMana: 20000 }, // Search OR Maps
    'gemini-2.5-flash:none': { tokensPerMana: 32000 },
    'gemini-2.5-flash-lite:none': { tokensPerMana: 120000 },
};

// ============= USD COST CALCULATION =============
const USD_PRICING: Record<string, {
    inputPerMToken: number;
    outputPerMToken: number;
    audioInputPerMToken?: number;
    searchPerQuery?: number;
}> = {
    'gemini-3-flash-preview': {
        inputPerMToken: 0.50,
        outputPerMToken: 3.00,
        audioInputPerMToken: 1.00,
        searchPerQuery: 0.014, // after 5,000 queries/month free
    },
    'gemini-2.5-flash': {
        inputPerMToken: 0.30,
        outputPerMToken: 2.50, // includes thinking tokens at same price
        audioInputPerMToken: 1.00,
        searchPerQuery: 0.035, // after 1,500/day free
    },
    'gemini-2.5-flash-lite': {
        inputPerMToken: 0.10,
        outputPerMToken: 0.40,
        audioInputPerMToken: 0.30,
    },
    'gemini-2.5-flash-preview-tts': {
        inputPerMToken: 0.50,
        outputPerMToken: 10.00,
    },
    'gemini-embedding-001': {
        inputPerMToken: 0.15,
        outputPerMToken: 0,
    },
};

const USD_IMAGE_PER_UNIT = 0.04;           // gemini-2.5-flash-image (Imagen 4 standard)
const USD_VIDEO_PER_SECOND_FAST = 0.15;    // veo-3.1-fast-generate-preview (Veo 3.1 Fast, no images)
const USD_VIDEO_PER_SECOND_STD = 0.40;    // veo-3.1-generate-preview (Veo 3.1 Standard, with images)

function calculateCostUsd(
    modelId: string,
    usage: { promptTokens: number; responseTokens: number; thoughtsTokens?: number; cachedTokens?: number },
    extras?: { searchQueries?: number }
): number {
    const pricing = USD_PRICING[modelId];
    if (!pricing) return 0;

    // Cached tokens (via Context Caching API) are charged at 25% of input price.
    // cachedContentTokenCount is a subset of promptTokenCount.
    const cached = usage.cachedTokens ?? 0;
    const nonCached = usage.promptTokens - cached;
    const inputCost = (nonCached / 1_000_000) * pricing.inputPerMToken
        + (cached / 1_000_000) * pricing.inputPerMToken * 0.25;

    // Thinking tokens are billed at the same output price — include in calculation.
    const billableOutput = usage.responseTokens + (usage.thoughtsTokens ?? 0);
    const outputCost = (billableOutput / 1_000_000) * pricing.outputPerMToken;

    const searchCost = extras?.searchQueries && pricing.searchPerQuery
        ? extras.searchQueries * pricing.searchPerQuery
        : 0;

    return inputCost + outputCost + searchCost;
}

function getPricingKey(model: string, tools?: string[]): string {
    const safeModel = model || 'gemini-3-flash-preview'; // Default
    const hasSearch = tools?.includes('googleSearch');
    const hasMaps = tools?.includes('googleMaps');
    const toolCount = (hasSearch ? 1 : 0) + (hasMaps ? 1 : 0);

    if (safeModel.includes('gemini-3-flash-preview')) {
        return hasSearch ? 'gemini-3-flash-preview:search' : 'gemini-3-flash-preview:none';
    }
    if (safeModel.includes('gemini-2.5-flash-lite')) {
        return 'gemini-2.5-flash-lite:none';
    }
    if (safeModel.includes('gemini-2.5-flash')) {
        if (toolCount >= 2) return 'gemini-2.5-flash:full_tools';
        if (toolCount === 1) return 'gemini-2.5-flash:partial_tools';
        return 'gemini-2.5-flash:none';
    }

    // Fallback
    return 'gemini-3-flash-preview:none';
}

function resolveModelName(modelId: string): string {
    // User confirmed model names are correct, no mapping needed
    return modelId;
}

// Helper to get text from response, filtering out thinking tokens and logging them
function extractText(result: any): string {
    const candidate = result.response?.candidates?.[0];
    if (!candidate?.content?.parts) {
        return result.response?.text() || "";
    }

    let resultText = "";
    let thoughts = "";

    for (const part of candidate.content.parts) {
        if (part.thought) {
            thoughts += part.text || "";
        } else if (part.text) {
            resultText += part.text;
        }
    }

    if (thoughts) {
        console.log("--- GEMINI REASONING ---");
        console.log(thoughts);
        console.log("--- END REASONING ---");
    }

    return resultText;
}

// Helper to get usage metadata
function getUsage(result: any): { promptTokens: number; responseTokens: number; thoughtsTokens: number; totalTokens: number } {
    const usage = result.response?.usageMetadata;
    const cachedTokens = usage?.cachedContentTokenCount || 0;
    if (cachedTokens > 0) {
        console.log(`[CACHE HIT] ${cachedTokens} tokens from cache (of ${usage?.promptTokenCount} prompt tokens)`);
    }
    const thoughtsTokens = usage?.thoughtsTokenCount || 0;
    if (thoughtsTokens > 0) {
        console.log(`[THINKING] ${thoughtsTokens} thinking tokens`);
    }
    return {
        promptTokens: usage?.promptTokenCount || 0,
        responseTokens: usage?.candidatesTokenCount || 0,
        thoughtsTokens,
        totalTokens: usage?.totalTokenCount || 0,
    };
}

// Helper to extract HTML from markdown code block
function extractHtml(response: string): string {
    const match = response.match(/```html\s*([\s\S]*?)```/);
    if (match) {
        return match[1].trim();
    }
    return response.trim();
}

// Helper to extract JSON from markdown code block
function extractJson(response: string): any {
    let text = response.trim();

    // 1. Remove markdown code blocks if present
    // Matches ```json or ``` followed by content and then ```
    const markdownMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (markdownMatch) {
        text = markdownMatch[1].trim();
    }

    // 2. Find the first '{' and last '}' to isolate the JSON object
    const startObj = text.indexOf('{');
    const endObj = text.lastIndexOf('}');

    if (startObj !== -1 && endObj !== -1 && endObj > startObj) {
        text = text.substring(startObj, endObj + 1);
    }

    // 3. Attempt to parse
    try {
        return JSON.parse(text);
    } catch (e) {
        console.error("JSON Parse Error:", e);
        console.error("Raw Text:", response);
        throw e; // Re-throw to be caught by caller
    }
}

// Helper to infer JSON Schema from a data example (robustness)
function inferSchema(data: any): any {
    if (data === null || data === undefined) return { type: "string", nullable: true };

    const type = typeof data;

    if (type === "string") return { type: "string" };
    if (type === "number") return { type: "number" };
    if (type === "boolean") return { type: "boolean" };

    if (Array.isArray(data)) {
        // Assume first item is representative, or default to string
        const itemSchema = data.length > 0 ? inferSchema(data[0]) : { type: "string" };
        return {
            type: "array",
            items: itemSchema
        };
    }

    if (type === "object") {
        const properties: any = {};
        const required: string[] = [];

        // If it already looks like a schema (has "type" or "properties"), return as is
        // preventing double conversion if user actually sent a partial schema
        if (data.type && (data.properties || data.items || data.type === 'string')) {
            return data;
        }

        Object.keys(data).forEach(key => {
            properties[key] = inferSchema(data[key]);
            required.push(key);
        });

        return {
            type: "object",
            properties,
            required
        };
    }

    return { type: "string" }; // Fallback
}

// ============= CALLBACK PATTERN FIXER =============
function fixCallbackPatterns(html: string): string {
    let fixedHtml = html;
    let callbackCounter = 0;
    const extractedCallbacks: string[] = [];

    // Find all script sections
    const scriptMatch = fixedHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    if (!scriptMatch) return html;

    for (const scriptBlock of scriptMatch) {
        let scriptContent = scriptBlock.replace(/<\/?script[^>]*>/gi, "");
        let modified = false;

        // Pattern 1: function(...) { ... }
        const funcPattern = /(Appacadabra(?:AI|Calendar|Notify|Share|Contacts|Auth|Sensors)\.[a-zA-Z]+\([^,)]*),\s*function\s*\(([^)]*)\)\s*\{/g;

        let match;
        while ((match = funcPattern.exec(scriptContent)) !== null) {
            callbackCounter++;
            const callbackName = `appCallback_${callbackCounter}`;
            const apiCall = match[1];
            const params = match[2];

            // Find the matching closing brace for the callback
            const startIdx = match.index + match[0].length;
            let braceCount = 1;
            let endIdx = startIdx;

            while (braceCount > 0 && endIdx < scriptContent.length) {
                if (scriptContent[endIdx] === "{") braceCount++;
                if (scriptContent[endIdx] === "}") braceCount--;
                endIdx++;
            }

            if (braceCount === 0) {
                const callbackBody = scriptContent.substring(startIdx, endIdx - 1);
                const globalFunc = `window.${callbackName} = function(${params}) {${callbackBody}};`;
                extractedCallbacks.push(globalFunc);

                // Replace the inline callback with the function name
                const fullMatch = scriptContent.substring(match.index, endIdx);
                const replacement = `${apiCall}, "${callbackName}"`;
                scriptContent = scriptContent.replace(fullMatch, replacement);
                modified = true;

                // Reset regex to continue finding
                funcPattern.lastIndex = 0;
            }
        }

        // Pattern 2: arrow functions (...) => { ... }
        const arrowPattern = /(Appacadabra(?:AI|Calendar|Notify|Share|Contacts|Auth|Sensors)\.[a-zA-Z]+\([^,)]*),\s*\(([^)]*)\)\s*=>\s*\{/g;

        while ((match = arrowPattern.exec(scriptContent)) !== null) {
            callbackCounter++;
            const callbackName = `appCallback_${callbackCounter}`;
            const apiCall = match[1];
            const params = match[2];

            const startIdx = match.index + match[0].length;
            let braceCount = 1;
            let endIdx = startIdx;

            while (braceCount > 0 && endIdx < scriptContent.length) {
                if (scriptContent[endIdx] === "{") braceCount++;
                if (scriptContent[endIdx] === "}") braceCount--;
                endIdx++;
            }

            if (braceCount === 0) {
                const callbackBody = scriptContent.substring(startIdx, endIdx - 1);
                const globalFunc = `window.${callbackName} = function(${params}) {${callbackBody}};`;
                extractedCallbacks.push(globalFunc);

                const fullMatch = scriptContent.substring(match.index, endIdx);
                const replacement = `${apiCall}, "${callbackName}"`;
                scriptContent = scriptContent.replace(fullMatch, replacement);
                modified = true;

                arrowPattern.lastIndex = 0;
            }
        }

        if (modified) {
            // Prepend extracted callbacks to script content
            const newScriptContent = extractedCallbacks.join("\n") + "\n" + scriptContent;
            fixedHtml = fixedHtml.replace(scriptBlock, `<script>${newScriptContent}</script>`);
            extractedCallbacks.length = 0; // Clear for next script block
        }
    }

    if (callbackCounter > 0) {
        console.log(`[CALLBACK FIX] Transformed ${callbackCounter} inline callbacks to global functions`);
    }

    return fixedHtml;
}

interface Patch {
    startLine: number;
    endLine: number;
    content: string;
}

function applyPatches(sourceCode: string, patches: Patch[]): string {
    let lines = sourceCode.replace(/\r\n/g, "\n").split("\n");
    const sortedPatches = [...patches].sort((a, b) => b.startLine - a.startLine);

    for (const patch of sortedPatches) {
        if (patch.startLine < 1 || patch.endLine > lines.length || patch.startLine > patch.endLine) {
            console.warn(`Invalid patch range ${patch.startLine}-${patch.endLine}`);
            continue;
        }
        const startIndex = patch.startLine - 1;
        const deleteCount = (patch.endLine - patch.startLine) + 1;
        const newLines = patch.content.replace(/\r\n/g, "\n").split("\n");
        lines.splice(startIndex, deleteCount, ...newLines);
    }

    return lines.join("\n");
}

interface GenerateSpellRequest {
    action: "create" | "edit" | "convert" | "webview_ai" | "webview_ai_image" | "webview_ai_similarity" | "webview_ai_video" | "webview_ai_tts";
    prompt?: string;
    currentCode?: string;
    instruction?: string;
    previousEdits?: PreviousEdit[];
    selectedContext?: string;
    sourceCode?: string;
    frameworkHint?: string;
    // WebView AI
    schema?: object;
    imagesBase64?: string[];   // Images (array)
    videosBase64?: string[];   // Videos (array)
    audiosBase64?: string[];   // Audios (array)
    model?: string;         // 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'
    tools?: string[];       // ['googleSearch', 'googleMaps']
    useSearch?: boolean;    // Legacy support
    // Embeddings / Similarity
    items?: string[];       // Array of texts (or image base64) to compare
    // TTS
    voiceName?: string;     // 'Aoede' | 'Charon' | 'Fenrir' | 'Kore' | 'Puck' | 'Orbit' | 'Zephyr'
}

export const generateSpell = onCall<GenerateSpellRequest>(
    {
        region: "southamerica-east1",
        memory: "512MiB",
        timeoutSeconds: 300,
        secrets: ["GEMINI_API_KEY"],
        enforceAppCheck: false,
    },
    async (request): Promise<GenerateSpellResponse> => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const uid = request.auth.uid;
        const { action, model: requestedModel, tools: requestedTools, useSearch } = request.data;
        const prompt = decompressContent(request.data.prompt || "");
        const sourceCode = decompressContent(request.data.sourceCode || "");
        const { schema, imagesBase64, videosBase64, audiosBase64 } = request.data;

        if (!action) throw new HttpsError("invalid-argument", "Action required");

        // Content moderation
        const textToValidate = prompt || sourceCode || "";
        if (textToValidate) {
            const validation = validateContentRequest(textToValidate);
            if (!validation.allowed) {
                throw new HttpsError("permission-denied", validation.reason || "Request blocked");
            }
        }

        const userRef = db.collection("users").doc(uid);

        return await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) throw new HttpsError("failed-precondition", "No user data");

            const userData = userDoc.data()!;
            const currentCredits = userData.credits || 0;

            if (currentCredits < 0.1 && action !== 'convert') { // Convert might be free? No logic says otherwise.
                throw new HttpsError("failed-precondition", "Insufficient credits");
            }

            const limitError = await checkRateLimit(userRef, transaction, userData);
            if (limitError) throw new HttpsError("resource-exhausted", limitError);

            let resultText = "";
            let usage = { promptTokens: 0, responseTokens: 0, thoughtsTokens: 0, cachedTokens: 0, totalTokens: 0 };
            let creditsUsed = 0;
            let logModelId = 'gemini-3-flash-preview';
            let logExtras: Record<string, any> = {};

            try {
                switch (action) {
                    case "create":
                    case "edit":
                        throw new HttpsError("failed-precondition", "Use async jobs for create/edit");

                    case "convert": {
                        // Fixed cost for Convert (Import) same as Create/Edit
                        // User confirmed: criação, edição e importação = 1 mana fixo

                        const framework = request.data.frameworkHint || "web project";
                        const convertPrompt = `${CONVERT_PROJECT_PROMPT}\n\nFramework: ${framework}\n\nSOURCE:\n${sourceCode}`;

                        // Use cached model (SYSTEM_INSTRUCTIONS injected as system instruction)
                        let result: any;
                        try {
                            const cachedModel = await getMainModelWithCache();
                            result = await cachedModel.generateContent(convertPrompt);
                        } catch (cacheErr) {
                            console.warn('[CACHE] Falling back to mainModel for convert:', cacheErr);
                            result = await mainModel.generateContent(`${SYSTEM_INSTRUCTIONS}\n\n${convertPrompt}`);
                        }

                        const u = getUsage(result);
                        usage = { ...u, cachedTokens: (result.response.usageMetadata?.cachedContentTokenCount || 0) };
                        resultText = fixCallbackPatterns(extractHtml(extractText(result)));

                        // Price as Fixed Cost
                        creditsUsed = FIXED_COST_CREATE_EDIT;
                        logModelId = 'gemini-3-flash-preview';
                        break;
                    }

                    case "webview_ai": {
                        if (!prompt) throw new HttpsError("invalid-argument", "Prompt required");

                        // normalize tools
                        let tools = requestedTools || [];
                        if (useSearch && !tools.includes('googleSearch')) tools.push('googleSearch');

                        const modelId = requestedModel || 'gemini-3-flash-preview';
                        const resolvedModelName = resolveModelName(modelId);

                        // Get pricing key
                        const pricingKey = getPricingKey(modelId, tools);
                        const pricing = PRICING_TABLE[pricingKey] || PRICING_TABLE['gemini-3-flash-preview:none'];
                        const tokensPerMana = pricing.tokensPerMana;

                        console.log(`[WEBVIEW_AI] Model: ${modelId} -> ${resolvedModelName}, Tools: ${tools}, Pricing: ${pricingKey} (1/${tokensPerMana})`);

                        // Build tools config
                        const toolConfig: any[] = [];
                        if (tools.includes('googleSearch')) toolConfig.push({ googleSearch: {} });
                        // Maps tool check - verify if available in SDK, assuming yes if user asked
                        // @ts-ignore
                        if (tools.includes('googleMaps')) toolConfig.push({ googleMaps: {} });

                        // Build Parts
                        const parts: any[] = [prompt];
                        if (imagesBase64?.length) {
                            for (const img of imagesBase64) {
                                parts.push({ inlineData: { mimeType: "image/jpeg", data: img } });
                            }
                        }
                        if (videosBase64?.length) {
                            for (const vid of videosBase64) {
                                parts.push({ inlineData: { mimeType: "video/mp4", data: vid } });
                            }
                        }
                        if (audiosBase64?.length) {
                            for (const aud of audiosBase64) {
                                parts.push({ inlineData: { mimeType: "audio/wav", data: aud } });
                            }
                        }

                        // Model Config
                        const genConfig: any = {};
                        if (schema) {
                            genConfig.responseMimeType = "application/json";
                            // basic check if valid schema or object
                            if (!(schema as any).type) {
                                genConfig.responseSchema = inferSchema(schema);
                            } else {
                                genConfig.responseSchema = schema;
                            }
                        }

                        const generativeModel = genAI.getGenerativeModel({
                            model: resolvedModelName,
                            generationConfig: {
                                ...genConfig,
                                // @ts-ignore
                                thinkingConfig: (resolvedModelName.includes('gemini-3'))
                                    ? { includeThoughts: true, thinkingLevel: "high" }
                                    : { includeThoughts: true, thinkingBudget: (resolvedModelName.includes('2.5-flash-lite') ? 24576 : (resolvedModelName.includes('2.5-pro') ? 32768 : 24576)) }
                            },
                            // @ts-ignore
                            tools: toolConfig.length > 0 ? toolConfig : undefined
                        });

                        const result = await generativeModel.generateContent(parts);
                        const u = getUsage(result);
                        usage = {
                            promptTokens: u.promptTokens,
                            responseTokens: u.responseTokens,
                            thoughtsTokens: u.thoughtsTokens,
                            totalTokens: u.totalTokens,
                            cachedTokens: (result.response.usageMetadata?.cachedContentTokenCount || 0)
                        };

                        resultText = extractText(result);
                        creditsUsed = usage.totalTokens / tokensPerMana;
                        logModelId = modelId;
                        if (tools.includes('googleSearch')) logExtras.searchQueries = 1;
                        break;
                    }

                    case "webview_ai_image": {
                        if (!prompt) throw new HttpsError("invalid-argument", "Prompt required for image generation");

                        console.log(`[WEBVIEW_AI_IMAGE] Generating image for: ${prompt.substring(0, 80)}...`);

                        const imgResult = await getAI().models.generateContent({
                            model: 'gemini-2.5-flash-image',
                            contents: [{ role: 'user', parts: [{ text: prompt }] }],
                            config: {
                                responseModalities: ['TEXT', 'IMAGE'],
                            },
                        });

                        usage = {
                            promptTokens: imgResult.usageMetadata?.promptTokenCount || 0,
                            responseTokens: imgResult.usageMetadata?.candidatesTokenCount || 0,
                            thoughtsTokens: 0,
                            totalTokens: imgResult.usageMetadata?.totalTokenCount || 0,
                            cachedTokens: 0
                        };

                        // Extract image from response parts
                        const parts = imgResult.candidates?.[0]?.content?.parts || [];
                        let imageBase64 = '';
                        for (const part of parts) {
                            if ((part as any).inlineData) {
                                imageBase64 = (part as any).inlineData.data;
                                break;
                            }
                        }

                        if (!imageBase64) {
                            throw new Error('No image generated by model');
                        }

                        resultText = imageBase64;

                        // Fixed cost: 0.5 mana per image generation
                        creditsUsed = 0.5;
                        logModelId = 'gemini-2.5-flash-image';
                        logExtras.imageCount = 1;
                        break;
                    }

                    case 'webview_ai_video': {
                        console.log(`[WEBVIEW_AI_VIDEO] Generating video for: ${prompt.substring(0, 80)}...`);

                        // First image = starting frame; additional images = reference images (up to 2 more)
                        const firstImage = imagesBase64?.[0]
                            ? { imageBytes: imagesBase64[0], mimeType: "image/jpeg" }
                            : undefined;
                        const referenceImages = imagesBase64?.slice(1, 3).map(img => ({
                            image: { imageBytes: img, mimeType: "image/jpeg" },
                            referenceType: VideoGenerationReferenceType.ASSET,
                        }));

                        const hasImages = !!firstImage;
                        let operation = await getAI().models.generateVideos({
                            model: hasImages ? 'veo-3.1-generate-preview' : 'veo-3.1-fast-generate-preview',
                            prompt: prompt,
                            ...(firstImage ? { image: firstImage } : {}),
                            config: {
                                ...(hasImages
                                    ? { aspectRatio: "16:9" }
                                    : { resolution: "720p" }),
                                ...(referenceImages?.length ? { referenceImages } : {}),
                            },
                        });

                        while (!operation.done) {
                            console.log(`[WEBVIEW_AI_VIDEO] Waiting for video...`);
                            await new Promise(resolve => setTimeout(resolve, 8000));
                            operation = await getAI().operations.getVideosOperation({ operation });
                        }

                        const videoFile = operation.response?.generatedVideos?.[0]?.video;
                        if (!videoFile?.uri) throw new Error('No video generated by model');

                        console.log(`[WEBVIEW_AI_VIDEO] Downloading from: ${videoFile.uri}`);
                        const videoResponse = await fetch(`${videoFile.uri}?alt=media`, {
                            headers: { 'x-goog-api-key': API_KEY }
                        });
                        if (!videoResponse.ok) throw new Error(`Video download failed: ${videoResponse.status}`);

                        const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
                        resultText = videoBuffer.toString('base64');

                        const durationSeconds = (videoFile as any).videoMetadata?.durationSeconds ?? 5;
                        // Mana cost: ~1 mana ≈ $0.075 USD
                        // Fast ($0.15/s) → 2.0 mana/s | Standard ($0.40/s) → 5.0 mana/s
                        creditsUsed = durationSeconds * (hasImages ? 5.0 : 2.0);
                        logModelId = hasImages ? 'veo-3.1-generate-preview' : 'veo-3.1-fast-generate-preview';
                        logExtras.durationSec = durationSeconds;
                        break;
                    }

                    case "webview_ai_similarity": {
                        // Similarity endpoint: accepts an array of items, returns pairwise similarity matrix
                        const items: string[] = request.data.items || [];
                        if (items.length < 2) throw new HttpsError("invalid-argument", "At least 2 items required for similarity");

                        const embModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });

                        // Compute embeddings for all items
                        const embeddings = await Promise.all(
                            items.map((item: string) => embModel.embedContent(item))
                        );
                        const vectors = embeddings.map((e: any) => e.embedding.values);

                        // Cosine similarity helper
                        function cosine(a: number[], b: number[]): number {
                            let dot = 0, magA = 0, magB = 0;
                            for (let i = 0; i < a.length; i++) {
                                dot += a[i] * b[i];
                                magA += a[i] * a[i];
                                magB += b[i] * b[i];
                            }
                            return dot / (Math.sqrt(magA) * Math.sqrt(magB));
                        }

                        // Build pairwise similarity matrix
                        const matrix: number[][] = [];
                        for (let i = 0; i < vectors.length; i++) {
                            const row: number[] = [];
                            for (let j = 0; j < vectors.length; j++) {
                                if (i === j) {
                                    row.push(1.0);
                                } else if (j < i) {
                                    row.push(matrix[j][i]); // symmetric
                                } else {
                                    row.push(Math.round(cosine(vectors[i], vectors[j]) * 10000) / 10000);
                                }
                            }
                            matrix.push(row);
                        }

                        resultText = JSON.stringify({ matrix, vectors, count: items.length });
                        creditsUsed = items.length * 0.01;
                        usage = { promptTokens: 0, responseTokens: 0, thoughtsTokens: 0, totalTokens: 0, cachedTokens: 0 };
                        logModelId = 'gemini-embedding-001';
                        logExtras.itemCount = items.length;
                        break;
                    }

                    case 'webview_ai_tts': {
                        if (!prompt) throw new HttpsError('invalid-argument', 'Text required for TTS');
                        const voiceName = request.data.voiceName;

                        const selectedVoice = voiceName || 'Aoede';

                        console.log(`[WEBVIEW_AI_TTS] voice=${selectedVoice}, text="${prompt.substring(0, 60)}..."`);

                        const ttsModel = genAI.getGenerativeModel({
                            model: 'gemini-2.5-flash-preview-tts',
                            generationConfig: {
                                responseModalities: ['AUDIO'],
                                speechConfig: {
                                    voiceConfig: {
                                        prebuiltVoiceConfig: { voiceName: selectedVoice }
                                    }
                                }
                            } as any,
                        });

                        const ttsResult = await ttsModel.generateContent(prompt);

                        const ttsParts = ttsResult.response.candidates?.[0]?.content?.parts || [];
                        let audioBase64 = '';
                        for (const part of ttsParts as any[]) {
                            if (part.inlineData) {
                                audioBase64 = part.inlineData.data;
                                break;
                            }
                        }

                        if (!audioBase64) throw new Error('TTS returned no audio');

                        // Asymmetric pricing: input $0.50/M (200K tokens/mana), output $10/M (10K tokens/mana)
                        const u = getUsage(ttsResult);
                        usage = { promptTokens: u.promptTokens, responseTokens: u.responseTokens, thoughtsTokens: u.thoughtsTokens, totalTokens: u.totalTokens, cachedTokens: 0 };
                        const inputCost = u.promptTokens / 200_000;
                        const outputCost = u.responseTokens / 10_000;
                        creditsUsed = inputCost + outputCost;

                        // Gemini TTS returns raw PCM (24kHz, 16-bit, mono) — wrap in WAV container
                        const pcmBuffer = Buffer.from(audioBase64, 'base64');
                        resultText = pcmToWav(pcmBuffer).toString('base64');
                        logModelId = 'gemini-2.5-flash-preview-tts';
                        break;
                    }
                }
            } catch (error: any) {
                console.error("AI Error", error);
                throw new HttpsError("internal", error.message);
            }

            const newCredits = Math.max(0, currentCredits - creditsUsed);

            // Update rate limit stats with generated tokens
            const now = Date.now();
            const currentStats: RateLimitData = userData.rateLimit || {
                callsThisMinute: 0,
                tokensThisMinute: 0,
                lastMinuteReset: now,
            };
            // Reset counters if a minute has passed since last reset
            if (now - (currentStats.lastMinuteReset || 0) > 60000) {
                currentStats.callsThisMinute = 0;
                currentStats.tokensThisMinute = 0;
                currentStats.lastMinuteReset = now;
                delete currentStats.cooldownUntil;
            }
            currentStats.tokensThisMinute = (currentStats.tokensThisMinute || 0) + (usage.totalTokens || 0);

            transaction.update(userRef, {
                credits: newCredits,
                creditsUsed: FieldValue.increment(creditsUsed),
                rateLimit: currentStats,
                lastActive: FieldValue.serverTimestamp()
            });

            // Compute USD cost and write usage log
            let costUsd: number;
            if (action === 'webview_ai_image') {
                costUsd = USD_IMAGE_PER_UNIT;
            } else if (action === 'webview_ai_video') {
                costUsd = (logExtras.durationSec ?? 0) * (logModelId === 'veo-3.1-generate-preview' ? USD_VIDEO_PER_SECOND_STD : USD_VIDEO_PER_SECOND_FAST);
            } else {
                costUsd = calculateCostUsd(logModelId, usage, {
                    searchQueries: logExtras.searchQueries,
                });
            }

            const logRef = db.collection('users').doc(uid).collection('usageLogs').doc();
            transaction.set(logRef, {
                action,
                modelId: logModelId,
                promptTokens: usage.promptTokens,
                responseTokens: usage.responseTokens,
                thoughtsTokens: usage.thoughtsTokens,
                totalTokens: usage.totalTokens,
                cachedTokens: usage.cachedTokens,
                costUsd,
                creditsUsed,
                timestamp: FieldValue.serverTimestamp(),
                ...logExtras,
            });

            return {
                text: compressContent(resultText),
                usage,
                creditsUsed,
                creditsRemaining: newCredits
            };
        });
    }
);

// Function to add credits (for purchases/ad rewards)
export const addCredits = onCall<{ amount: number; source: string }>(
    {
        region: "southamerica-east1",
        enforceAppCheck: false,
    },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const uid = request.auth.uid;
        const { amount, source } = request.data;

        if (!amount || amount <= 0) {
            throw new HttpsError("invalid-argument", "Amount must be positive");
        }

        const userRef = db.collection("users").doc(uid);

        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);

            if (!userDoc.exists) {
                // Create new user
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

            // Log the credit addition
            const logRef = db.collection("users").doc(uid).collection("creditLogs").doc();
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

        if (!userDoc.exists) {
            // Create user with 0 credits
            await userRef.set({
                credits: 0,
                creditsUsed: 0,
                createdAt: FieldValue.serverTimestamp(),
                lastActive: FieldValue.serverTimestamp(),
            });
            return { credits: 0 };
        }

        return { credits: userDoc.data()?.credits || 0 };
    }
);

// ============= ASYNC JOB PROCESSOR =============

interface Job {
    id: string;
    userId: string;
    action: 'create' | 'edit';
    status: 'queued' | 'processing' | 'completed' | 'failed';
    createdAt: any;
    updatedAt: any;
    payload: {
        prompt?: string;
        currentCode?: string; // GZIP:base64
        instruction?: string;
        selectedContext?: string;
        previousEdits?: PreviousEdit[];
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

export const processSpellJob = onDocumentCreated(
    {
        document: "jobs/{jobId}",
        region: "southamerica-east1",
        memory: "512MiB",
        timeoutSeconds: 540, // 9 minutes (thinkingLevel: high needs more time)
        secrets: ["GEMINI_API_KEY"],
    },
    async (event) => {
        const snapshot = event.data;
        if (!snapshot) return;

        const jobData = snapshot.data() as Job;
        const jobId = event.params.jobId;

        // Only process queued jobs
        if (jobData.status !== 'queued') return;

        console.log(`[Job ${jobId}] Starting processing. Action: ${jobData.action}`);

        // Mark as processing
        await snapshot.ref.update({
            status: 'processing',
            startedAt: FieldValue.serverTimestamp(),
        });

        const uid = jobData.userId;
        const { action, payload } = jobData;

        // Decompress Inputs
        const prompt = decompressContent(payload.prompt || "");
        const currentCode = decompressContent(payload.currentCode || "");
        const instruction = decompressContent(payload.instruction || "");
        const selectedContext = payload.selectedContext ? decompressContent(payload.selectedContext) : undefined;
        let previousEdits = payload.previousEdits;
        // limit number of versions sent to model for context (e.g. 10), but always include first version if exists, as it usually contains original instruction
        if (Array.isArray(previousEdits) && previousEdits.length > 0) {
            const first = previousEdits[0];
            const last10 = previousEdits.slice(-10);
            const last10NoFirst = last10.filter(e => e.version !== first.version);
            previousEdits = [first, ...last10NoFirst];
        }

        const userRef = db.collection("users").doc(uid);

        try {
            // 1. Check Credits/Limits
            const userDoc = await userRef.get();
            if (!userDoc.exists) throw new Error("User not found");

            const userData = userDoc.data()!;
            if ((userData.credits || 0) < 0.1) {
                throw new Error("Insufficient credits");
            }

            let resultText = "";
            let usage = { promptTokens: 0, responseTokens: 0, thoughtsTokens: 0, totalTokens: 0, cachedTokens: 0 };
            let appName: string | undefined;
            let auditLog: any = {};

            switch (action) {
                case "create": {
                    let totalUsage = { promptTokens: 0, responseTokens: 0, thoughtsTokens: 0, totalTokens: 0, cachedTokens: 0 };
                    const addUsage = (result: any) => {
                        const u = getUsage(result);
                        totalUsage.promptTokens += u.promptTokens;
                        totalUsage.responseTokens += u.responseTokens;
                        totalUsage.thoughtsTokens += u.thoughtsTokens;
                        totalUsage.totalTokens += u.totalTokens;
                        totalUsage.cachedTokens += (result.response?.usageMetadata?.cachedContentTokenCount || 0);
                    };

                    // Get cached model (SYSTEM_INSTRUCTIONS injected as system instruction)
                    let createModel: any;
                    try {
                        createModel = await getMainModelWithCache();
                    } catch (cacheErr) {
                        console.warn(`[Job ${jobId}] [CACHE] Falling back to mainModel:`, cacheErr);
                        createModel = null;
                    }
                    const callModel = async (p: string, fullPromptFallback: string) => {
                        if (createModel) return createModel.generateContent(p, { timeout: 120000 });
                        return mainModel.generateContent(fullPromptFallback, { timeout: 120000 });
                    };

                    // Stage 1: Planning
                    console.log(`[Job ${jobId}] Stage 1: Planning...`);
                    const plannerPrompt = `${UNIFIED_CREATE_PLANNER_PROMPT}\n\nUser Request: ${prompt}`;
                    const planResult = await callModel(plannerPrompt, `${SYSTEM_INSTRUCTIONS}\n\n${plannerPrompt}`);
                    addUsage(planResult);
                    const appPlan = extractJson(extractText(planResult));
                    console.log(`[Job ${jobId}] Plan created:`, JSON.stringify(appPlan).substring(0, 200) + '...');

                    // Stage 2: Coding
                    console.log(`[Job ${jobId}] Stage 2: Coding...`);
                    const codePrompt = `${UNIFIED_CREATE_CODE_PROMPT}\n\n--- APP PLAN ---\n${JSON.stringify(appPlan, null, 2)}`;
                    const codeResult = await callModel(codePrompt, `${SYSTEM_INSTRUCTIONS}\n\n${codePrompt}`);
                    addUsage(codeResult);

                    resultText = fixCallbackPatterns(extractHtml(extractText(codeResult)));

                    // Audit
                    auditLog = {
                        plannerPrompt,
                        codePrompt
                    };

                    // Validation
                    console.log(`[Job ${jobId}] Validating code...`);
                    let validation = validateGeneratedCode(resultText);
                    let execValidation = validateWithExecution(resultText);
                    let allErrors = [...validation.errors, ...execValidation.errors];

                    if (allErrors.length > 0) {
                        auditLog.initialValidationErrors = allErrors;
                    }

                    if (allErrors.length > 0 && allErrors.some(e => e.fixable)) {
                        console.warn(`[Job ${jobId}] Validation failed. Retrying with fix prompt...`, allErrors);
                        const fixPrompt = generateFixPrompt(allErrors, resultText);

                        // Audit fix
                        auditLog.fixPrompt = fixPrompt;

                        const fixResult = await callModel(fixPrompt, fixPrompt);
                        addUsage(fixResult);
                        resultText = fixCallbackPatterns(extractHtml(extractText(fixResult)));
                        validation = validateGeneratedCode(resultText);
                        execValidation = validateWithExecution(resultText);
                        allErrors = [...validation.errors, ...execValidation.errors];

                        if (allErrors.length > 0) {
                            auditLog.finalValidationErrors = allErrors;
                        }
                    }

                    if (allErrors.length > 0) throw new Error(`App generation failed: ${allErrors[0]?.message || 'Unknown'}`);
                    usage = totalUsage;

                    // Extract App Name from Title
                    const titleMatch = resultText.match(/<title[^>]*>([^<]+)<\/title>/i);
                    if (titleMatch && titleMatch[1]) {
                        appName = titleMatch[1].trim();
                    }
                    break;
                }
                case "edit": {
                    let totalUsage = { promptTokens: 0, responseTokens: 0, thoughtsTokens: 0, totalTokens: 0, cachedTokens: 0 };
                    const addUsage = (result: any) => {
                        const u = getUsage(result);
                        totalUsage.promptTokens += u.promptTokens;
                        totalUsage.responseTokens += u.responseTokens;
                        totalUsage.thoughtsTokens += u.thoughtsTokens;
                        totalUsage.totalTokens += u.totalTokens;
                        totalUsage.cachedTokens += (result.response?.usageMetadata?.cachedContentTokenCount || 0);
                    };

                    const normalizedCode = currentCode.replace(/\r\n/g, "\n");
                    const codeLines = normalizedCode.split("\n");
                    const numberedCode = codeLines.map((line: string, i: number) => `${i + 1}| ${line}`).join("\n");

                    const historyContext = previousEdits && previousEdits.length > 0
                        ? `\nPrevious edits:\n${previousEdits.map((e: PreviousEdit) => `- v${e.version}: ${e.instruction}`).join("\n")}\n`
                        : "";
                    const selectionPart = selectedContext
                        ? `\nSelected code:\n"""\n${selectedContext}\n"""\n`
                        : "";

                    // Get cached model (SYSTEM_INSTRUCTIONS injected as system instruction)
                    let editModel: any;
                    try {
                        editModel = await getMainModelWithCache();
                    } catch (cacheErr) {
                        console.warn(`[Job ${jobId}] [CACHE] Falling back to mainModel:`, cacheErr);
                        editModel = null;
                    }
                    const callEditModel = async (p: string, fullPromptFallback: string) => {
                        if (editModel) return editModel.generateContent(p, { timeout: 120000 });
                        return mainModel.generateContent(fullPromptFallback, { timeout: 120000 });
                    };

                    // Stage 1: Plan
                    console.log(`[Job ${jobId}] Stage 1: Planning Edit...`);
                    const planPrompt = `${UNIFIED_EDIT_PLANNER_PROMPT}\n\nUser's edit request: ${instruction}${historyContext}${selectionPart}\n\nFull code:\n\`\`\`html\n${numberedCode}\n\`\`\``;
                    const planResult = await callEditModel(planPrompt, `${SYSTEM_INSTRUCTIONS}\n\n${planPrompt}`);
                    addUsage(planResult);
                    const editPlan = extractJson(extractText(planResult));
                    console.log(`[Job ${jobId}] Edit Plan:`, JSON.stringify(editPlan, null, 2));

                    // Stage 2: Patch
                    console.log(`[Job ${jobId}] Stage 2: Patching...`);
                    const patchPrompt = `${UNIFIED_EDIT_MIGRATE_PROMPT}\n\n--- EDIT PLAN ---\n${JSON.stringify(editPlan, null, 2)}\n\n--- CODE CONTEXT ---\n\`\`\`html\n${numberedCode}\n\`\`\``;
                    const patchResult = await callEditModel(patchPrompt, `${SYSTEM_INSTRUCTIONS}\n\n${patchPrompt}`);
                    addUsage(patchResult);
                    const patchResponse = extractJson(extractText(patchResult));

                    // Audit
                    auditLog = {
                        planPrompt,
                        patchPrompt
                    };

                    resultText = fixCallbackPatterns(applyPatches(normalizedCode, patchResponse.changes || []));
                    console.log(`[Job ${jobId}] Patching complete. Validating...`);

                    // Validation
                    let editValidation = validateGeneratedCode(resultText);
                    let editExecValidation = validateWithExecution(resultText);
                    let editAllErrors = [...editValidation.errors, ...editExecValidation.errors];

                    if (editAllErrors.length > 0) {
                        auditLog.initialValidationErrors = editAllErrors;
                    }

                    if (editAllErrors.length > 0 && editAllErrors.some(e => e.fixable)) {
                        console.warn(`[Job ${jobId}] Validation failed. Retrying with fix prompt...`, editAllErrors);
                        const fixPrompt = generateFixPrompt(editAllErrors, resultText);

                        // Audit fix
                        auditLog.fixPrompt = fixPrompt;

                        const fixResult = await callEditModel(fixPrompt, fixPrompt);
                        addUsage(fixResult);
                        resultText = fixCallbackPatterns(extractHtml(extractText(fixResult)));
                        editValidation = validateGeneratedCode(resultText);
                        editExecValidation = validateWithExecution(resultText);
                        editAllErrors = [...editValidation.errors, ...editExecValidation.errors];

                        if (editAllErrors.length > 0) {
                            auditLog.finalValidationErrors = editAllErrors;
                        }
                    }
                    if (editAllErrors.length > 0) throw new Error(`Edit failed: ${editAllErrors[0]?.message}`);

                    usage = totalUsage;
                    // For edits, we don't strictly need appName, client knows it.
                    break;
                }
                default:
                    throw new Error(`Invalid Async Action: ${action}`);
            }

            // Deduct Credits
            const creditsUsed = FIXED_COST_CREATE_EDIT;
            const costUsd = calculateCostUsd('gemini-3-flash-preview', usage);

            await db.runTransaction(async (t) => {
                const ref = db.collection("users").doc(uid);
                const doc = await t.get(ref);
                if (doc.exists) {
                    const data = doc.data()!;
                    const newCredits = Math.max(0, (data.credits || 0) - creditsUsed);
                    t.update(ref, {
                        credits: newCredits,
                        creditsUsed: FieldValue.increment(creditsUsed),
                        lastActive: FieldValue.serverTimestamp(),
                    });

                    // Update Job
                    t.update(snapshot.ref, {
                        status: 'completed',
                        completedAt: FieldValue.serverTimestamp(),
                        result: {
                            text: compressContent(resultText),
                            usage,
                            costUsd,
                            creditsUsed,
                            creditsRemaining: newCredits,
                            ...(appName ? { appName } : {}),
                        },
                        audit: auditLog // Save audit logs
                    });

                    // Write usage log
                    const logRef = db.collection('users').doc(uid).collection('usageLogs').doc();
                    t.set(logRef, {
                        action,
                        modelId: 'gemini-3-flash-preview',
                        promptTokens: usage.promptTokens,
                        responseTokens: usage.responseTokens,
                        thoughtsTokens: usage.thoughtsTokens,
                        totalTokens: usage.totalTokens,
                        cachedTokens: usage.cachedTokens,
                        costUsd,
                        creditsUsed,
                        timestamp: FieldValue.serverTimestamp(),
                        jobId,
                    });
                }
            });

        } catch (error: any) {
            console.error(`Job ${jobId} failed:`, error);
            await snapshot.ref.update({
                status: 'failed',
                error: error.message || 'Unknown error',
                failedAt: FieldValue.serverTimestamp(),
            });
        }
    }
);
