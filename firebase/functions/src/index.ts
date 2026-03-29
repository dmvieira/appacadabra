/**
 * Firebase Functions for Appacadabra
 * Handles all AI operations with credit management via Firestore
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, DocumentReference, Transaction, DocumentData } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";
import { GoogleGenAI, VideoGenerationReferenceType, Type, ThinkingLevel } from "@google/genai";

import * as zlib from 'zlib';
import {
    SYSTEM_INSTRUCTIONS,
    CONVERT_PROJECT_PROMPT,
    // Unified 2-Step Prompts
    UNIFIED_CREATE_PLANNER_PROMPT,
    UNIFIED_CREATE_CODE_PROMPT,
    UNIFIED_EDIT_PLANNER_PROMPT,
    UNIFIED_EDIT_MIGRATE_PROMPT,
} from "./prompts";
import { validateGeneratedCode, generateFixPrompt } from "./codeValidator";
import { validateWithExecution } from "./executionValidator";

// Initialize Firebase Admin
initializeApp();
const db = getFirestore();

// Initialize Gemini AI (API key from environment)
const API_KEY = process.env.GEMINI_API_KEY || "";
let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI { return _ai ?? (_ai = new GoogleGenAI({ apiKey: API_KEY, httpOptions: { timeout: 300000 } })); }

// Main model config (reused for all create/edit/convert calls)
const MAIN_MODEL_CONFIG = {
    tools: [{ googleSearch: {} }],
    thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
};


// Config for cached calls — tools must not be repeated here (they live in the cache)
const CACHED_MAIN_MODEL_CONFIG = {
    thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
};

// Context Caching for SYSTEM_INSTRUCTIONS (~1,800 tokens)
// Cache read: 25% of input price → significant savings at volume
let _sysCache: any = null;
let _sysCacheExpiresAt = 0;
const CACHE_TTL_S = 3600;           // 1 hour TTL
const CACHE_RENEW_BEFORE_MS = 5 * 60 * 1000;  // renew 5 min before expiry

async function getOrCreateSysCache(): Promise<string> {
    const now = Date.now();
    if (!_sysCache || now > _sysCacheExpiresAt - CACHE_RENEW_BEFORE_MS) {
        console.log('[CACHE] Creating/renewing SYSTEM_INSTRUCTIONS cache...');
        _sysCache = await getAI().caches.create({
            model: 'models/gemini-3-flash-preview',
            config: {
                systemInstruction: SYSTEM_INSTRUCTIONS,
                tools: [{ googleSearch: {} }],
                ttl: `${CACHE_TTL_S}s`,
            },
        });
        _sysCacheExpiresAt = now + CACHE_TTL_S * 1000;
        console.log(`[CACHE] Cache created: ${_sysCache.name}`);
    }
    return _sysCache.name!;
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


// ============= FIRESTORE UTILS =============


/**
 * Aggressive sanitization for metadata blocks (usage, logs, extras).
 * Only primitive types, strict plain objects, and arrays are allowed.
 */
function sanitizeForFirestore(obj: any): any {
    if (obj === null || obj === undefined) return null;

    const t = typeof obj;
    if (t === 'number') {
        return isNaN(obj) || !isFinite(obj) ? 0 : obj;
    }
    if (t === 'string' || t === 'boolean') {
        return obj;
    }

    const typeStr = Object.prototype.toString.call(obj);

    if (typeStr === '[object Array]') {
        return obj.map((item: any) => sanitizeForFirestore(item)).filter((item: any) => item !== undefined);
    }

    if (typeStr === '[object Object]') {
        // Double check it's actually a plain object (no custom prototype)
        const proto = Object.getPrototypeOf(obj);
        if (proto !== null && proto !== Object.prototype) {
            // It's a class instance like Metadata or Map. Reject it completely.
            return null;
        }

        const plain: any = {};
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                const val = obj[key];
                if (val !== undefined && typeof val !== 'function') {
                    plain[key] = sanitizeForFirestore(val);
                }
            }
        }
        return plain;
    }

    // Reject Dates, Maps, Sets, Promises, Buffers, etc.
    return null;
}


// ============= RATE LIMITING =============
// Constants for rate limiting
// Rate Limits
const RATE_LIMITS = {
    CALLS_PER_MINUTE: 30, // Increased
    TOKENS_PER_MINUTE: 500000, // Increased
    COOLDOWN_MS: 60000,
    SUGGEST_SPELLS_DAILY: 10,
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
const MANA_VALUE_USD = 0.06; // 1 mana ≡ $0.06 AI compute (~45% margem sobre mana_50)

// ============= USD COST CALCULATION =============
const USD_PRICING: Record<string, {
    inputPerMToken: number;
    outputPerMToken: number;
    audioInputPerMToken?: number;
    searchPerQuery?: number;
    mapsPerQuery?: number;
}> = {
    'gemini-3-flash-preview': {
        inputPerMToken: 0.50,
        outputPerMToken: 3.00,
        audioInputPerMToken: 1.00,
        searchPerQuery: 0.014, // after 5,000 queries/month free
        mapsPerQuery: 0.025,
    },
    'gemini-2.5-flash': {
        inputPerMToken: 0.30,
        outputPerMToken: 2.50, // includes thinking tokens at same price
        audioInputPerMToken: 1.00,
        searchPerQuery: 0.035, // after 1,500/day free
        mapsPerQuery: 0.025,
    },
    'gemini-2.5-flash-lite': {
        inputPerMToken: 0.10,
        outputPerMToken: 0.40,
        audioInputPerMToken: 0.30,
        mapsPerQuery: 0.025,
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
const USD_VIDEO_PER_SECOND_FAST = 0.25;    // veo-3.1-fast-generate-preview ($0.15 vídeo + $0.10 áudio/s)
const USD_VIDEO_PER_SECOND_STD = 0.65;    // veo-3.1-generate-preview ($0.40 vídeo + $0.25 áudio/s)
const MANA_PER_INPUT_IMAGE = 0.1; // extra mana per inspiration image sent to AI_GENERATE_IMAGE

function calculateCostUsd(
    modelId: string,
    usage: { promptTokens: number; responseTokens: number; thoughtsTokens?: number; cachedTokens?: number },
    extras?: { searchQueries?: number; mapsQueries?: number; audioTokens?: number }
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

    const mapsCost = extras?.mapsQueries && pricing.mapsPerQuery
        ? extras.mapsQueries * pricing.mapsPerQuery
        : 0;

    const audioCost = extras?.audioTokens && pricing.audioInputPerMToken
        ? (extras.audioTokens / 1_000_000) * pricing.audioInputPerMToken
        : 0;

    return inputCost + outputCost + searchCost + mapsCost + audioCost;
}

function calcImageMana(numInputImages: number): number {
    return USD_IMAGE_PER_UNIT / MANA_VALUE_USD + numInputImages * MANA_PER_INPUT_IMAGE;
}

function calcVideoMana(durationSeconds: number, hasImages: boolean): number {
    const costUsd = durationSeconds * (hasImages ? USD_VIDEO_PER_SECOND_STD : USD_VIDEO_PER_SECOND_FAST);
    return costUsd / MANA_VALUE_USD;
}

// Helper to get text from response
function extractText(result: any): string {
    try {
        const text = result.text;
        if (!text) {
            const finishReason = result.candidates?.[0]?.finishReason;
            console.warn(`[extractText] Empty response. finishReason: ${finishReason}`);
        }
        return text || "";
    } catch (e) {
        const finishReason = result?.candidates?.[0]?.finishReason;
        console.warn(`[extractText] result.text threw: ${e}. finishReason: ${finishReason}`);
        return "";
    }
}

// Helper to get usage metadata
function getUsage(result: any): { promptTokens: number; responseTokens: number; thoughtsTokens: number; totalTokens: number } {
    const usage = result.usageMetadata;
    const cachedTokens = usage?.cachedContentTokenCount || 0;
    if (cachedTokens > 0) {
        console.log(`[CACHE HIT] ${cachedTokens} tokens from cache`);
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

// Helper to repair common AI JSON issues (literal newlines/tabs inside string values)
function repairJson(text: string): string {
    let result = '';
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escape) {
            result += ch;
            escape = false;
        } else if (ch === '\\' && inString) {
            result += ch;
            escape = true;
        } else if (ch === '"') {
            inString = !inString;
            result += ch;
        } else if (inString && ch === '\n') {
            result += '\\n';
        } else if (inString && ch === '\r') {
            result += '\\r';
        } else if (inString && ch === '\t') {
            result += '\\t';
        } else {
            result += ch;
        }
    }
    return result;
}

// Helper to extract HTML from markdown code block
function extractHtml(response: string): string {
    const openMatch = response.match(/```(?:html)?\s*/i);
    if (openMatch && openMatch.index !== undefined) {
        const contentStart = openMatch.index + openMatch[0].length;
        const lastClose = response.lastIndexOf('```');
        if (lastClose > contentStart) {
            return response.substring(contentStart, lastClose).trim();
        }
        return response.substring(contentStart).trim();
    }
    // Fallback if no code blocks but there is a preamble
    const docTypeIdx = response.toLowerCase().indexOf('<!doctype html>');
    if (docTypeIdx !== -1) {
        return response.substring(docTypeIdx).trim();
    }
    return response.trim();
}

function attemptPartialJsonRecovery(text: string): string | null {
    // Find the last position where depth was 1 and we just closed a `}`
    // i.e., the last complete item inside a top-level array/object
    let depth = 0;
    let inString = false;
    let escape = false;
    let lastDepth1Close = -1;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') {
            depth--;
            if (depth === 1) lastDepth1Close = i;
        }
    }

    if (lastDepth1Close === -1) return null;

    // Close any open structure after the last complete child
    // Find what the top-level opener was
    const opener = text[0];
    const closer = opener === '{' ? '}' : ']';
    // Strip everything after last complete item and close
    const partial = text.substring(0, lastDepth1Close + 1).trimEnd();
    // Remove trailing comma if present
    const trimmed = partial.replace(/,\s*$/, '');
    return trimmed + closer;
}

// Helper to extract JSON from markdown code block or raw text
function extractJson(response: string): any {
    let text = response.trim();
    const originalLength = text.length;

    // 1. Remove markdown code blocks if present
    // Use lastIndexOf for the closing ``` so that backticks inside JSON string values don't truncate early
    const openMatch = text.match(/^\s*```(?:json)?\s*/);
    if (openMatch && openMatch.index !== undefined) {
        const contentStart = openMatch.index + openMatch[0].length;
        const lastClose = text.lastIndexOf('```');
        if (lastClose > contentStart + 2) {
            text = text.substring(contentStart, lastClose).trim();
        } else {
            // No distinct closing found (truly truncated code block), take rest
            text = text.substring(contentStart).trim();
        }
    }
    // If no ``` at all, text is used as-is (raw JSON)

    // 2. Find the first '{' and the matching '}' (respecting strings)
    const startObj = text.indexOf('{');
    if (startObj === -1) {
        throw new Error(`No JSON object found in response (Length: ${originalLength})`);
    }

    let depth = 0;
    let inString = false;
    let escape = false;
    let endObj = -1;

    for (let i = startObj; i < text.length; i++) {
        const ch = text[i];
        if (escape) {
            escape = false;
        } else if (ch === '\\' && inString) {
            escape = true;
        } else if (ch === '"') {
            inString = !inString;
        } else if (!inString) {
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    endObj = i;
                    break;
                }
            }
        }
    }

    if (endObj !== -1) {
        text = text.substring(startObj, endObj + 1);
    } else if (depth > 0) {
        // Attempt partial recovery: find last complete top-level item
        let recovered = attemptPartialJsonRecovery(text.substring(startObj));
        if (recovered !== null) {
            try {
                const parsed = JSON.parse(recovered);
                console.warn(`[extractJson] Truncated response recovered partially (originalLength: ${originalLength})`);
                return parsed;
            } catch (_) {
                // fall through to throw
            }
        }
        throw new Error(`AI response was truncated (depth: ${depth}, inString: ${inString}, originalLength: ${originalLength})`);
    }

    // 3. Repair common AI JSON issues
    text = repairJson(text);

    // 4. Attempt to parse
    try {
        return JSON.parse(text);
    } catch (e: any) {
        console.error("JSON Parse Error:", e);
        console.error("Raw Text (last 100 chars):", text.slice(-100));
        throw new Error(`Failed to parse AI JSON: ${e.message} (at pos ${e.at || 'unknown'})`);
    }
}

// Helper to infer JSON Schema from a data example (robustness)
function inferSchema(data: any): any {
    if (data === null || data === undefined) return { type: Type.STRING, nullable: true };
    const t = typeof data;

    if (t === "string") return { type: Type.STRING };
    if (t === "number") return { type: Type.NUMBER };
    if (t === "boolean") return { type: Type.BOOLEAN };

    if (Array.isArray(data)) {
        return { type: Type.ARRAY, items: data.length > 0 ? inferSchema(data[0]) : { type: Type.STRING } };
    }

    if (t === "object") {
        if (data.type && (data.properties || data.items || data.type === 'string')) return data;
        const properties: any = {};
        const required: string[] = [];
        Object.keys(data).forEach(key => { properties[key] = inferSchema(data[key]); required.push(key); });
        return { type: Type.OBJECT, properties, required };
    }

    return { type: Type.STRING };
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

/** Retries transient Gemini/network errors with exponential backoff. */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (e: any) {
            lastError = e;
            const msg: string = e?.message || '';
            const isRetryable =
                msg.includes('DEADLINE_EXCEEDED') ||
                msg.includes('UNAVAILABLE') ||
                e?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
                msg.includes('UND_ERR_HEADERS_TIMEOUT');

            if (isRetryable && attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
                console.warn(`[withRetry] attempt ${attempt + 1} failed (${msg.substring(0, 80)}), retrying in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw e;
            }
        }
    }
    throw lastError;
}

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

export const suggestSpells = onCall<{ query: string; language: string }>(
    {
        region: "southamerica-east1",
        enforceAppCheck: false,
        secrets: ["GEMINI_API_KEY"],
    },
    async (request) => {
        if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
        const { query, language } = request.data;
        if (!query?.trim()) throw new HttpsError("invalid-argument", "Query required");

        const uid = request.auth.uid;
        const userRef = db.collection("users").doc(uid);

        return await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) throw new HttpsError("failed-precondition", "No user data");

            const limitError = await checkDailyRateLimit(userRef, transaction, userDoc.data()!);
            if (limitError) throw new HttpsError("resource-exhausted", limitError);

            const prompt = `You are helping users of Appacadabra, an app that creates mini AI-powered tools called "spells".
The user searched for "${query.trim()}" but found no results.
Suggest exactly 2 spell ideas related to "${query.trim()}".
Respond in language: ${language}.
For each suggestion:
- title: short name (3–5 words)
- description: one sentence written as a prompt for the AI to create it, starting with an action verb.`;

            const result = await withRetry(() => getAI().models.generateContent({
                model: "gemini-2.5-flash-lite",
                contents: prompt,
                config: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                title: { type: Type.STRING },
                                description: { type: Type.STRING },
                            },
                            required: ["title", "description"],
                        },
                    },
                },
            }));

            const suggestions = JSON.parse(result.text!);
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

            let resultText = "";
            let usage = { promptTokens: 0, responseTokens: 0, thoughtsTokens: 0, totalTokens: 0, cachedTokens: 0 };
            let appName: string | undefined;
            let auditLog: any = {};
            let creditsUsed = FIXED_COST_CREATE_EDIT;
            let logModelId = 'gemini-3-flash-preview';
            let logExtras: Record<string, any> = {};

            switch (action) {
                case "create": {
                    let totalUsage = { promptTokens: 0, responseTokens: 0, thoughtsTokens: 0, totalTokens: 0, cachedTokens: 0 };
                    const addUsage = (result: any) => {
                        const u = getUsage(result);
                        totalUsage.promptTokens += u.promptTokens;
                        totalUsage.responseTokens += u.responseTokens;
                        totalUsage.thoughtsTokens += u.thoughtsTokens;
                        totalUsage.totalTokens += u.totalTokens;
                        totalUsage.cachedTokens += result.usageMetadata?.cachedContentTokenCount || 0;
                    };

                    let sysCacheName: string | null = null;
                    try { sysCacheName = await getOrCreateSysCache(); }
                    catch (cacheErr) { console.warn(`[Job ${jobId}] [CACHE] Falling back:`, cacheErr); }

                    const callModel = async (p: string, fullPromptFallback: string) => {
                        const timeoutPromise = new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('AI Generation Timeout (300s)')), 300000)
                        );

                        const generationPromise = withRetry(async () => {
                            if (sysCacheName) {
                                const result = await getAI().models.generateContent({
                                    model: 'models/gemini-3-flash-preview',
                                    contents: p,
                                    config: { ...CACHED_MAIN_MODEL_CONFIG, cachedContent: sysCacheName },
                                });
                                const text = extractText(result);
                                if (!text) {
                                    const finishReason = result.candidates?.[0]?.finishReason;
                                    throw new Error(`Empty AI response (finishReason: ${finishReason ?? 'unknown'})`);
                                }
                                return result;
                            }
                            const result = await getAI().models.generateContent({
                                model: 'models/gemini-3-flash-preview',
                                contents: fullPromptFallback,
                                config: MAIN_MODEL_CONFIG,
                            });
                            const text = extractText(result);
                            if (!text) {
                                const finishReason = result.candidates?.[0]?.finishReason;
                                throw new Error(`Empty AI response (finishReason: ${finishReason ?? 'unknown'})`);
                            }
                            return result;
                        });

                        return Promise.race([generationPromise, timeoutPromise]) as Promise<any>;
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
                    if (!resultText) throw new Error("AI returned empty response");

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
                        if (!resultText) throw new Error("AI returned empty response");
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
                        totalUsage.cachedTokens += result.usageMetadata?.cachedContentTokenCount || 0;
                    };

                    const normalizedCode = currentCode.replace(/\r\n/g, "\n");
                    const codeLines = normalizedCode.split("\n");
                    console.log(`[Job ${jobId}] Editing code: ${codeLines.length} lines, ${normalizedCode.length} chars`);
                    const numberedCode = codeLines.map((line: string, i: number) => `${i + 1}| ${line}`).join("\n");

                    const historyContext = previousEdits && previousEdits.length > 0
                        ? `\nPrevious edits:\n${previousEdits.map((e: PreviousEdit) => `- v${e.version}: ${e.instruction}`).join("\n")}\n`
                        : "";
                    const selectionPart = selectedContext
                        ? `\nSelected code:\n"""\n${selectedContext}\n"""\n`
                        : "";
                    const storageKeysPart = storageStructure.length > 0
                        ? `\n⚠️ STORAGE STRUCTURE GUARDRAIL: This spell already has user data persisted in localStorage. You MUST NOT rename keys, remove keys, or change data types — doing so causes permanent data loss:\n${storageStructure.map(item => `- localStorage["${item.key}"]: ${JSON.stringify(item.schema)}`).join('\n')}\n`
                        : '';

                    let editCacheName: string | null = null;
                    try { editCacheName = await getOrCreateSysCache(); }
                    catch (cacheErr) { console.warn(`[Job ${jobId}] [CACHE] Falling back:`, cacheErr); }

                    const callEditModel = async (p: string, fullPromptFallback: string) => {
                        return withRetry(async () => {
                            if (editCacheName) {
                                const result = await getAI().models.generateContent({
                                    model: 'models/gemini-3-flash-preview',
                                    contents: p,
                                    config: { ...CACHED_MAIN_MODEL_CONFIG, cachedContent: editCacheName },
                                });
                                const text = extractText(result);
                                if (!text) {
                                    const finishReason = result.candidates?.[0]?.finishReason;
                                    throw new Error(`Empty AI response (finishReason: ${finishReason ?? 'unknown'})`);
                                }
                                return result;
                            }
                            const result = await getAI().models.generateContent({
                                model: 'models/gemini-3-flash-preview',
                                contents: fullPromptFallback,
                                config: MAIN_MODEL_CONFIG,
                            });
                            const text = extractText(result);
                            if (!text) {
                                const finishReason = result.candidates?.[0]?.finishReason;
                                throw new Error(`Empty AI response (finishReason: ${finishReason ?? 'unknown'})`);
                            }
                            return result;
                        });
                    };

                    // Stage 1: Plan
                    console.log(`[Job ${jobId}] Stage 1: Planning Edit...`);
                    const planPrompt = `${UNIFIED_EDIT_PLANNER_PROMPT}\n\nUser's edit request: ${instruction}${historyContext}${selectionPart}${storageKeysPart}\n\nFull code:\n\`\`\`html\n${numberedCode}\n\`\`\``;
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
                    auditLog.planPrompt = planPrompt;
                    auditLog.patchPrompt = patchPrompt;

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
                        if (!resultText) throw new Error("AI returned empty response");
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

                case "convert": {
                    if (!sourceCode) throw new Error("sourceCode required for convert");
                    console.log(`[Job ${jobId}] [CONVERT] Starting spell conversion`);

                    const framework = frameworkHint || "web project";
                    const convertPrompt = `${CONVERT_PROJECT_PROMPT}\n\nFramework: ${framework}\n\nSOURCE:\n${sourceCode}`;

                    let convertResult: any;
                    let convCacheName: string | null = null;
                    try { convCacheName = await getOrCreateSysCache(); }
                    catch (cacheErr) { console.warn(`[Job ${jobId}] [CACHE] Falling back for convert:`, cacheErr); }

                    if (convCacheName) {
                        convertResult = await withRetry(() => getAI().models.generateContent({
                            model: 'models/gemini-3-flash-preview',
                            contents: convertPrompt,
                            config: { ...CACHED_MAIN_MODEL_CONFIG, cachedContent: convCacheName },
                        }));
                    } else {
                        convertResult = await withRetry(() => getAI().models.generateContent({
                            model: 'models/gemini-3-flash-preview',
                            contents: `${SYSTEM_INSTRUCTIONS}\n\n${convertPrompt}`,
                            config: MAIN_MODEL_CONFIG,
                        }));
                    }

                    const convU = getUsage(convertResult);
                    usage = { ...convU, cachedTokens: convertResult.usageMetadata?.cachedContentTokenCount || 0 };
                    resultText = fixCallbackPatterns(extractHtml(extractText(convertResult)));
                    if (!resultText) throw new Error("AI returned empty response");

                    creditsUsed = FIXED_COST_CREATE_EDIT;
                    logModelId = 'gemini-3-flash-preview';
                    break;
                }

                case "app_icon": {
                    if (!prompt) throw new Error("Prompt required for app icon generation");
                    console.log(`[Job ${jobId}] [APP_ICON] Generating icon for: ${prompt.substring(0, 80)}...`);

                    const iconResult = await withRetry(() => getAI().models.generateContent({
                        model: 'gemini-3.1-flash-image-preview',
                        contents: [{ role: 'user', parts: [{ text: prompt }] }],
                        config: {
                            responseModalities: ['TEXT', 'IMAGE'],
                            imageConfig: { imageSize: '512' },
                        },
                    }));

                    usage = sanitizeForFirestore({
                        promptTokens: Math.max(0, Number(iconResult.usageMetadata?.promptTokenCount) || 0),
                        responseTokens: Math.max(0, Number(iconResult.usageMetadata?.candidatesTokenCount) || 0),
                        thoughtsTokens: 0,
                        totalTokens: Math.max(0, Number(iconResult.usageMetadata?.totalTokenCount) || 0),
                        cachedTokens: 0
                    });

                    const iconParts = iconResult.candidates?.[0]?.content?.parts || [];
                    let iconBase64 = '';
                    for (const part of iconParts) {
                        if ((part as any).inlineData) {
                            iconBase64 = (part as any).inlineData.data;
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
                    logModelId = 'gemini-3.1-flash-image-preview';
                    logExtras.imageCount = 1;
                    logExtras.imageUrl = iconDownloadUrl;
                    break;
                }

                case "webview_ai": {
                    if (!prompt) throw new Error("Prompt required");

                    // normalize tools
                    let tools = requestedTools || [];
                    if (useSearch && !tools.includes('googleSearch')) tools.push('googleSearch');

                    const modelId = requestedModel || 'gemini-3-flash-preview';

                    console.log(`[Job ${jobId}] [WEBVIEW_AI] Model: ${modelId}, Tools: ${tools}`);

                    // Build tools config
                    const toolConfig: any[] = [];
                    if (tools.includes('googleSearch')) toolConfig.push({ googleSearch: {} });
                    if (tools.includes('googleMaps')) toolConfig.push({ googleMaps: {} });

                    // Build Parts
                    const parts: any[] = [prompt];
                    if (resolvedImages?.length) {
                        for (const img of resolvedImages) {
                            parts.push({ inlineData: { mimeType: "image/jpeg", data: img } });
                        }
                    }
                    if (resolvedVideos?.length) {
                        for (const vid of resolvedVideos) {
                            parts.push({ inlineData: { mimeType: "video/mp4", data: vid } });
                        }
                    }
                    if (resolvedAudios?.length) {
                        for (const aud of resolvedAudios) {
                            parts.push({ inlineData: { mimeType: "audio/wav", data: aud } });
                        }
                    }

                    // Model Config
                    const genConfig: any = { maxOutputTokens: 65536 };
                    if (schema) {
                        genConfig.responseMimeType = "application/json";
                        if (!(schema as any).type) {
                            genConfig.responseSchema = inferSchema(schema);
                        } else {
                            genConfig.responseSchema = schema;
                        }
                    }

                    const result = await withRetry(() => getAI().models.generateContent({
                        model: modelId,
                        contents: parts,
                        config: {
                            ...genConfig,
                            thinkingConfig: modelId.includes('gemini-3')
                                ? { thinkingLevel: toolConfig.length > 0 ? ThinkingLevel.MINIMAL : ThinkingLevel.HIGH }
                                : { thinkingBudget: modelId.includes('2.5-flash-lite') ? 24576 : 32768 },
                            tools: toolConfig.length > 0 ? toolConfig : undefined,
                        },
                    }));

                    usage = sanitizeForFirestore({
                        promptTokens: Math.max(0, Number(result.usageMetadata?.promptTokenCount) || 0),
                        responseTokens: Math.max(0, Number(result.usageMetadata?.candidatesTokenCount) || 0),
                        thoughtsTokens: Math.max(0, Number(result.usageMetadata?.thoughtsTokenCount) || 0),
                        totalTokens: Math.max(0, Number(result.usageMetadata?.totalTokenCount) || 0),
                        cachedTokens: Math.max(0, Number(result.usageMetadata?.cachedContentTokenCount) || 0),
                    });

                    resultText = extractText(result);

                    // AUDIT LOG
                    auditLog.rawAiResponse = (resultText || "").substring(0, 10000); // Capture more
                    auditLog.schemaProvided = !!schema;
                    auditLog.modelUsed = modelId;

                    // If a schema was requested, ensure the response is clean JSON
                    if (schema && resultText) {
                        try {
                            const parsed = extractJson(resultText);
                            resultText = JSON.stringify(parsed);
                            auditLog.extractedJson = resultText;
                        } catch (e: any) {
                            console.warn(`[Job ${jobId}] [WEBVIEW_AI] JSON extraction failed:`, e.message);
                            auditLog.extractionError = e.message;
                            // Add snippet to error for immediate visibility in UI
                            const snippet = resultText.length > 200 ? resultText.substring(0, 200) + "..." : resultText;
                            throw new Error(`JSON Extraction Failed: ${e.message} | Raw: ${snippet}`);
                        }
                    }

                    // Empty AI response is always invalid — fail the job explicitly
                    if (!resultText) {
                        throw new Error("AI returned empty response");
                    }

                    // Count actual tool calls from grounding metadata
                    const groundingMeta = result.candidates?.[0]?.groundingMetadata;
                    const actualSearchQueries = (groundingMeta as any)?.webSearchQueries?.length ?? 0;
                    const groundingChunks = (groundingMeta as any)?.groundingChunks ?? [];
                    const actualMapsQueries = groundingChunks.some(
                        (c: any) => c?.retrievedContext?.uri?.includes('maps.googleapis') ||
                            c?.web?.uri?.includes('maps.google')
                    ) ? 1 : 0;

                    // Resolve model ID for pricing lookup
                    const pricingModelId = modelId.includes('gemini-2.5-flash-lite') ? 'gemini-2.5-flash-lite'
                        : modelId.includes('gemini-2.5-flash') ? 'gemini-2.5-flash'
                            : 'gemini-3-flash-preview';

                    const waiCostUsd = calculateCostUsd(pricingModelId, usage, {
                        searchQueries: actualSearchQueries,
                        mapsQueries: actualMapsQueries,
                    });
                    creditsUsed = waiCostUsd / MANA_VALUE_USD;

                    logModelId = modelId;
                    logExtras.searchQueries = actualSearchQueries;
                    if (actualMapsQueries > 0) logExtras.mapsQueries = actualMapsQueries;
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

                    const jobImagePartsFromInput = (resolvedImages ?? []).slice(0, 14).map((b64: string) => ({
                        inlineData: { mimeType: detectMimeTypeJobImg(b64), data: b64 },
                    }));

                    const imgResult = await withRetry(() => getAI().models.generateContent({
                        model: 'gemini-3.1-flash-image-preview',
                        contents: [{ role: 'user', parts: [{ text: prompt }, ...jobImagePartsFromInput] }],
                        config: {
                            responseModalities: ['TEXT', 'IMAGE'],
                            imageConfig: { imageSize: '512' },
                        },
                    }));

                    usage = sanitizeForFirestore({
                        promptTokens: Math.max(0, Number(imgResult.usageMetadata?.promptTokenCount) || 0),
                        responseTokens: Math.max(0, Number(imgResult.usageMetadata?.candidatesTokenCount) || 0),
                        thoughtsTokens: 0,
                        totalTokens: Math.max(0, Number(imgResult.usageMetadata?.totalTokenCount) || 0),
                        cachedTokens: 0
                    });

                    // Extract image from response parts
                    const imgParts = imgResult.candidates?.[0]?.content?.parts || [];
                    let imageBase64 = '';
                    for (const part of imgParts) {
                        if ((part as any).inlineData) {
                            imageBase64 = (part as any).inlineData.data;
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
                    creditsUsed = calcImageMana(jobImagePartsFromInput.length);
                    logModelId = 'gemini-3.1-flash-image-preview';
                    logExtras.imageCount = 1;
                    logExtras.imageUrl = downloadUrl;
                    break;
                }

                case 'webview_ai_video': {
                    console.log(`[Job ${jobId}] [WEBVIEW_AI_VIDEO] Generating video for: ${prompt.substring(0, 80)}...`);

                    const detectMimeType = (base64: string): string => {
                        if (base64.startsWith('/9j/')) return 'image/jpeg';
                        if (base64.startsWith('iVBOR')) return 'image/png';
                        return 'image/jpeg';
                    };

                    const firstImageB64 = resolvedImages?.[0];
                    const extraImageB64s = resolvedImages?.slice(1, 3) ?? [];
                    const hasImages = !!firstImageB64;
                    const hasReferenceImages = extraImageB64s.length > 0;

                    const startingFrame = (hasImages && !hasReferenceImages)
                        ? { imageBytes: firstImageB64!, mimeType: detectMimeType(firstImageB64!) }
                        : undefined;

                    const referenceImages = hasReferenceImages
                        ? [
                            { image: { imageBytes: firstImageB64!, mimeType: detectMimeType(firstImageB64!) }, referenceType: VideoGenerationReferenceType.ASSET },
                            ...extraImageB64s.map(img => ({
                                image: { imageBytes: img, mimeType: detectMimeType(img) },
                                referenceType: VideoGenerationReferenceType.ASSET,
                            })),
                        ]
                        : undefined;

                    let operation = await getAI().models.generateVideos({
                        model: hasImages ? 'veo-3.1-generate-preview' : 'veo-3.1-fast-generate-preview',
                        prompt: prompt,
                        ...(startingFrame ? { image: startingFrame } : {}),
                        config: {
                            numberOfVideos: 1,
                            ...(!hasImages
                                ? { resolution: "720p" }
                                : hasReferenceImages
                                    ? { aspectRatio: "16:9" }
                                    : {}),
                            ...(referenceImages ? { referenceImages } : {}),
                        },
                    });

                    while (!operation.done) {
                        console.log(`[Job ${jobId}] [WEBVIEW_AI_VIDEO] Waiting for video...`);
                        await new Promise(resolve => setTimeout(resolve, 8000));
                        operation = await getAI().operations.getVideosOperation({ operation });
                    }

                    const videoFile = operation.response?.generatedVideos?.[0]?.video;
                    if (!videoFile?.uri) throw new Error('No video generated by model');

                    console.log(`[Job ${jobId}] [WEBVIEW_AI_VIDEO] Downloading from: ${videoFile.uri.substring(0, 100)}... API_KEY present: ${!!API_KEY}`);
                    const videoResponse = await fetch(videoFile.uri, {
                        headers: { 'x-goog-api-key': API_KEY }
                    });

                    console.log(`[Job ${jobId}] [WEBVIEW_AI_VIDEO] Download status: ${videoResponse.status}, Content-Type: ${videoResponse.headers.get('content-type')}`);
                    if (!videoResponse.ok) {
                        const errBody = await videoResponse.text();
                        console.error(`[Job ${jobId}] [WEBVIEW_AI_VIDEO] Download failed body: ${errBody.substring(0, 200)}`);
                        throw new Error(`Video download failed: ${videoResponse.status}`);
                    }

                    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
                    if (!videoBuffer.length) throw new Error('Video generation returned empty data');

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

                    resultText = downloadUrl;

                    const durationSeconds = (videoFile as any).videoMetadata?.durationSeconds ?? 8;
                    console.log(`[Job ${jobId}] [WEBVIEW_AI_VIDEO] videoFile metadata:`, JSON.stringify((videoFile as any).videoMetadata));
                    creditsUsed = calcVideoMana(durationSeconds, hasImages);
                    logModelId = hasImages ? 'veo-3.1-generate-preview' : 'veo-3.1-fast-generate-preview';
                    logExtras.durationSec = durationSeconds;
                    logExtras.videoUrl = downloadUrl;
                    break;

                }

                case "webview_ai_similarity": {
                    console.log(`[Job ${jobId}] [WEBVIEW_AI_SIMILARITY] items: ${items?.length ?? 0}`);
                    if (items.length < 2) throw new Error("At least 2 items required for similarity");

                    const embeddings = await Promise.all(
                        items.map((item: string) => getAI().models.embedContent({
                            model: "gemini-embedding-001",
                            contents: item,
                        }))
                    );
                    console.log(`[Job ${jobId}] [WEBVIEW_AI_SIMILARITY] Embeddings computed, building matrix...`);
                    const vectors = embeddings.map(e => e.embeddings![0].values!);
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
                    logModelId = 'gemini-embedding-001';
                    logExtras.itemCount = items.length;
                    break;
                }

                case 'webview_ai_tts': {
                    if (!prompt) throw new Error('Text required for TTS');

                    const selectedVoice = voiceName || 'Aoede';
                    console.log(`[Job ${jobId}] [WEBVIEW_AI_TTS] voice=${selectedVoice}, text="${prompt.substring(0, 60)}..."`);

                    const ttsResult = await withRetry(() => getAI().models.generateContent({
                        model: 'gemini-2.5-flash-preview-tts',
                        contents: prompt,
                        config: {
                            responseModalities: ['AUDIO'],
                            speechConfig: {
                                voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } },
                            },
                        },
                    }));

                    const ttsParts = ttsResult.candidates?.[0]?.content?.parts || [];
                    let audioBase64 = '';
                    for (const part of ttsParts as any[]) {
                        if (part.inlineData) {
                            audioBase64 = part.inlineData.data;
                            break;
                        }
                    }

                    if (!audioBase64) throw new Error('TTS returned no audio');

                    const u = getUsage(ttsResult);
                    usage = sanitizeForFirestore({
                        promptTokens: Math.max(0, Number(u.promptTokens) || 0),
                        responseTokens: Math.max(0, Number(u.responseTokens) || 0),
                        thoughtsTokens: Math.max(0, Number(u.thoughtsTokens) || 0),
                        totalTokens: Math.max(0, Number(u.totalTokens) || 0),
                        cachedTokens: 0
                    });
                    const ttsCostUsd = calculateCostUsd('gemini-2.5-flash-preview-tts', usage);
                    creditsUsed = ttsCostUsd / MANA_VALUE_USD;

                    const pcmBuffer = Buffer.from(audioBase64, 'base64');
                    const wavBuffer = pcmToWav(pcmBuffer);

                    // ====================================================
                    // UPLOAD TO FIREBASE STORAGE (Bypass 1MB Firestore limit)
                    // ====================================================
                    if (wavBuffer.length > 800_000) {
                        console.log(`[Job ${jobId}] [WEBVIEW_AI_TTS] Audio size (${Math.round(wavBuffer.length / 1024)}KB) exceeds threshold. Uploading to Storage...`);
                        const bucket = getStorage().bucket();
                        const fileName = `generated_audio/${uid}/${jobId}.wav`;
                        const file = bucket.file(fileName);

                        const token = require('crypto').randomUUID();
                        await file.save(wavBuffer, {
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
                        resultText = wavBuffer.toString('base64');
                    }

                    logModelId = 'gemini-2.5-flash-preview-tts';
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

                    const newCredits = Math.max(0, (data.credits || 0) - creditsUsed);
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
                        cachedTokens: usage.cachedTokens,
                        costUsd,
                        creditsUsed,
                        timestamp: FieldValue.serverTimestamp(),
                        jobId,
                        ...sanitizeForFirestore(logExtras),
                    });
                }
            });

        } catch (error: any) {
            console.error(`Job ${jobId} failed:`, error);
            const errorMsg = typeof error?.message === 'string' ? error.message : String(error || 'Unknown error');
            try {
                const currentDoc = await snapshot.ref.get();
                if (currentDoc.data()?.status === 'completed') return; // transaction already committed, don't overwrite
                await snapshot.ref.update({
                    status: 'failed',
                    error: errorMsg,
                    failedAt: FieldValue.serverTimestamp(),
                });
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
    const bonus = 0;
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

        return { granted: true, newBalance: current + bonus };
    });

    return result;
});

function computeManaCost(type: string, data: any): { mana: string; value: number } {
    switch (type) {
        case 'generate': {
            const promptLen = (data.prompt || '').length;
            const numImages = data.images?.length || 0;
            const numVideos = data.videos?.length || 0;
            const numAudios = data.audios?.length || 0;
            const hasSearch = !!data.search;
            const hasSchema = !!data.schema;

            const audioTokens = numAudios * 5_000;
            const promptTokens = (promptLen / 4)
                + (numImages * 500)
                + (numVideos * 15_000);

            const thinkingTk = Math.min(32768, Math.max(1000, Math.floor(promptTokens)));
            const outputTk = hasSchema ? 400 : 200;

            const costUsd = calculateCostUsd('gemini-3-flash-preview', {
                promptTokens,
                responseTokens: outputTk,
                thoughtsTokens: thinkingTk
            }, {
                searchQueries: hasSearch ? 1 : 0,
                audioTokens
            });

            const mana = costUsd / MANA_VALUE_USD;
            return { mana: `~${mana.toFixed(1)}`, value: mana };
        }

        case 'image': {
            const mana = calcImageMana(data.images?.length || 0);
            return { mana: `~${mana.toFixed(1)}`, value: mana };
        }

        case 'video': {
            const mana = calcVideoMana(8, (data.images?.length || 0) > 0);
            return { mana: `~${mana.toFixed(1)}`, value: mana };
        }

        case 'audio': {
            const chars = (data.text || '').length;
            const inputTk = chars / 4;
            const outputTk = inputTk * 8;
            const costUsd = calculateCostUsd('gemini-2.5-flash-preview-tts', {
                promptTokens: inputTk,
                responseTokens: outputTk
            });
            const mana = Math.max(0.01, costUsd / MANA_VALUE_USD);
            return { mana: `~${mana.toFixed(2)}`, value: mana };
        }

        case 'similarity': {
            const items = data.items || [];
            const totalChars = items.reduce((s: number, x: string) =>
                s + (typeof x === 'string' ? x.length : 0), 0);
            const totalTk = totalChars / 4;
            const costUsd = calculateCostUsd('gemini-embedding-001', {
                promptTokens: totalTk,
                responseTokens: 0
            });
            const mana = Math.max(0.01, costUsd / MANA_VALUE_USD);
            return { mana: `~${mana.toFixed(3)}`, value: mana };
        }

        default:
            return { mana: '~1', value: 1.0 };
    }
}

export const estimateManaCost = onCall({
    region: 'southamerica-east1',
    enforceAppCheck: false,
}, async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required');

    const { type, data } = request.data;
    if (!type || !data) throw new HttpsError('invalid-argument', 'Type and data required');

    return computeManaCost(type, data);
});
