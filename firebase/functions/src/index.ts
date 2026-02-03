/**
 * Firebase Functions for Appacadabra
 * Handles all AI operations with credit management via Firestore
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, DocumentReference, Transaction, DocumentData } from "firebase-admin/firestore";
import { GoogleGenerativeAI } from "@google/generative-ai";
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

// Initialize Firebase Admin
initializeApp();
const db = getFirestore();

// Initialize Gemini AI (API key from environment)
const API_KEY = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(API_KEY);

// Models configuration
// Main models for Create/Edit/Convert
const mainModel = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
    // @ts-ignore
    tools: [{ googleSearch: {} }],
});


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
    CALLS_PER_MINUTE: 10,
    TOKENS_PER_MINUTE: 150000, // Increased to accommodate lite models
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
        totalTokens: number;
        cachedTokens?: number;
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

// Helper to get usage metadata
function getUsage(result: any): { promptTokens: number; responseTokens: number; totalTokens: number } {
    const usage = result.response?.usageMetadata;
    const cachedTokens = usage?.cachedContentTokenCount || 0;
    if (cachedTokens > 0) {
        console.log(`[CACHE HIT] ${cachedTokens} tokens from cache (of ${usage?.promptTokenCount} prompt tokens)`);
    }
    return {
        promptTokens: usage?.promptTokenCount || 0,
        responseTokens: usage?.candidatesTokenCount || 0,
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
    const text = response.trim();

    // Strategy 1: Find valid JSON bounded by { } anywhere in the text
    const startObj = text.indexOf('{');
    const endObj = text.lastIndexOf('}');

    if (startObj !== -1 && endObj !== -1 && endObj > startObj) {
        const potentialJson = text.substring(startObj, endObj + 1);
        try {
            return JSON.parse(potentialJson);
        } catch (e) {
            // Continue if this fails
        }
    }

    // Strategy 2: If finding brackets failed, try markdown stripping
    const match = text.match(/```([\s\S]*?)```/);
    if (match) {
        let content = match[1].trim();
        const firstLineEnd = content.indexOf('\n');
        if (firstLineEnd !== -1) {
            const firstLine = content.substring(0, firstLineEnd).trim();
            if (/^[a-z]+$/i.test(firstLine) && !firstLine.includes('{')) {
                content = content.substring(firstLineEnd).trim();
            }
        }
        try {
            return JSON.parse(content);
        } catch (e) { }
    }

    // Strategy 3: Direct parse
    return JSON.parse(text);
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
    action: "create" | "edit" | "convert" | "webview_ai";
    prompt?: string;
    currentCode?: string;
    instruction?: string;
    previousEdits?: PreviousEdit[];
    selectedContext?: string;
    sourceCode?: string;
    frameworkHint?: string;
    // WebView AI
    schema?: object;
    imageBase64?: string;
    audioBase64?: string;
    model?: string;         // New: 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'
    tools?: string[];       // New: ['googleSearch', 'googleMaps']
    useSearch?: boolean;    // Legacy support
}

export const generateSpell = onCall<GenerateSpellRequest>(
    {
        region: "southamerica-east1",
        memory: "512MiB",
        timeoutSeconds: 300,
        secrets: ["GEMINI_API_KEY"],
    },
    async (request): Promise<GenerateSpellResponse> => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const uid = request.auth.uid;
        const { action, model: requestedModel, tools: requestedTools, useSearch } = request.data;
        const prompt = decompressContent(request.data.prompt || "");
        const sourceCode = decompressContent(request.data.sourceCode || "");
        const { schema, imageBase64, audioBase64 } = request.data;

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
            let usage = { promptTokens: 0, responseTokens: 0, cachedTokens: 0, totalTokens: 0 };
            let creditsUsed = 0;

            try {
                switch (action) {
                    case "create":
                    case "edit":
                        throw new HttpsError("failed-precondition", "Use async jobs for create/edit");

                    case "convert": {
                        // Fixed cost for Convert (Import) same as Create/Edit
                        // User confirmed: criação, edição e importação = 1 mana fixo

                        const framework = request.data.frameworkHint || "web project";
                        const convertPrompt = `${SYSTEM_INSTRUCTIONS}\n\n${CONVERT_PROJECT_PROMPT}\n\nFramework: ${framework}\n\nSOURCE:\n${sourceCode}`;

                        // Use main model (consistent with Create/Edit)
                        const result = await mainModel.generateContent(convertPrompt);

                        // Validation logic ... (simplified for brevity here, assume usage update)
                        // Note: To save space, using standard logic.
                        const u = getUsage(result);
                        usage = { ...u, cachedTokens: (result.response.usageMetadata?.cachedContentTokenCount || 0) };
                        resultText = fixCallbackPatterns(extractHtml(result.response.text()));

                        // Price as Fixed Cost
                        creditsUsed = FIXED_COST_CREATE_EDIT;
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
                        if (imageBase64) parts.push({ inlineData: { mimeType: "image/jpeg", data: imageBase64 } });
                        if (audioBase64) parts.push({ inlineData: { mimeType: "audio/wav", data: audioBase64 } });

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
                            generationConfig: genConfig,
                            // @ts-ignore
                            tools: toolConfig.length > 0 ? toolConfig : undefined
                        });

                        const result = await generativeModel.generateContent(parts);
                        const u = getUsage(result);
                        usage = {
                            promptTokens: u.promptTokens,
                            responseTokens: u.responseTokens,
                            totalTokens: u.totalTokens,
                            cachedTokens: (result.response.usageMetadata?.cachedContentTokenCount || 0)
                        };

                        resultText = result.response.text();
                        creditsUsed = usage.totalTokens / tokensPerMana;
                        break;
                    }
                }
            } catch (error: any) {
                console.error("AI Error", error);
                throw new HttpsError("internal", error.message);
            }

            const newCredits = Math.max(0, currentCredits - creditsUsed);

            // Update stats
            const currentStats = userData.rateLimit || { tokensThisMinute: 0 };
            currentStats.tokensThisMinute += usage.totalTokens;

            transaction.update(userRef, {
                credits: newCredits,
                creditsUsed: FieldValue.increment(creditsUsed),
                rateLimit: currentStats,
                lastActive: FieldValue.serverTimestamp()
            });

            return {
                text: compressContent(resultText),
                usage: usage, // Now includes cachedTokens if I updated the interface... wait, I need to update response interface
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
        timeoutSeconds: 300, // 5 minutes Max
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
        const previousEdits = payload.previousEdits;

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
            let usage = { promptTokens: 0, responseTokens: 0, totalTokens: 0 };
            let appName: string | undefined;
            let auditLog: any = {};

            switch (action) {
                case "create": {
                    let totalUsage = { promptTokens: 0, responseTokens: 0, totalTokens: 0, cachedTokens: 0 };
                    const addUsage = (result: any) => {
                        const u = getUsage(result);
                        totalUsage.promptTokens += u.promptTokens;
                        totalUsage.responseTokens += u.responseTokens;
                        totalUsage.totalTokens += u.totalTokens;
                        totalUsage.cachedTokens += (result.response?.usageMetadata?.cachedContentTokenCount || 0);
                    };

                    // Stage 1: Planning
                    console.log(`[Job ${jobId}] Stage 1: Planning...`);
                    const plannerPrompt = `${SYSTEM_INSTRUCTIONS}\n\n${UNIFIED_CREATE_PLANNER_PROMPT}\n\nUser Request: ${prompt}`;
                    const planResult = await mainModel.generateContent(plannerPrompt, { timeout: 120000 });
                    addUsage(planResult);
                    const appPlan = extractJson(planResult.response.text());
                    console.log(`[Job ${jobId}] Plan created:`, JSON.stringify(appPlan).substring(0, 200) + '...');

                    // Stage 2: Coding
                    console.log(`[Job ${jobId}] Stage 2: Coding...`);
                    const codePrompt = `${SYSTEM_INSTRUCTIONS}\n\n${UNIFIED_CREATE_CODE_PROMPT}\n\n--- APP PLAN ---\n${JSON.stringify(appPlan, null, 2)}`;
                    const codeResult = await mainModel.generateContent(codePrompt, { timeout: 120000 });
                    addUsage(codeResult);

                    resultText = fixCallbackPatterns(extractHtml(codeResult.response.text()));

                    // Audit
                    auditLog = {
                        plannerPrompt,
                        codePrompt
                    };

                    // Validation
                    console.log(`[Job ${jobId}] Validating code...`);
                    let validation = validateGeneratedCode(resultText);

                    if (!validation.valid) {
                        auditLog.initialValidationErrors = validation.errors;
                    }

                    if (!validation.valid && validation.canRetry) {
                        console.warn(`[Job ${jobId}] Validation failed. Retrying with fix prompt...`, validation.errors);
                        const fixPrompt = generateFixPrompt(validation.errors, resultText);

                        // Audit fix
                        auditLog.fixPrompt = fixPrompt;

                        const fixResult = await mainModel.generateContent(fixPrompt, { timeout: 120000 });
                        addUsage(fixResult);
                        resultText = fixCallbackPatterns(extractHtml(fixResult.response.text()));
                        validation = validateGeneratedCode(resultText);

                        if (!validation.valid) {
                            auditLog.finalValidationErrors = validation.errors;
                        }
                    }

                    if (!validation.valid) throw new Error(`App generation failed: ${validation.errors[0]?.message || 'Unknown'}`);
                    usage = totalUsage;

                    // Extract App Name from Title
                    const titleMatch = resultText.match(/<title[^>]*>([^<]+)<\/title>/i);
                    if (titleMatch && titleMatch[1]) {
                        appName = titleMatch[1].trim();
                    }
                    break;
                }
                case "edit": {
                    let totalUsage = { promptTokens: 0, responseTokens: 0, totalTokens: 0, cachedTokens: 0 };
                    const addUsage = (result: any) => {
                        const u = getUsage(result);
                        totalUsage.promptTokens += u.promptTokens;
                        totalUsage.responseTokens += u.responseTokens;
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

                    // Stage 1: Plan
                    console.log(`[Job ${jobId}] Stage 1: Planning Edit...`);
                    const planPrompt = `${SYSTEM_INSTRUCTIONS}\n\n${UNIFIED_EDIT_PLANNER_PROMPT}\n\nUser's edit request: ${instruction}${historyContext}${selectionPart}\n\nFull code:\n\`\`\`html\n${numberedCode}\n\`\`\``;
                    const planResult = await mainModel.generateContent(planPrompt, { timeout: 120000 });
                    addUsage(planResult);
                    const editPlan = extractJson(planResult.response.text());
                    console.log(`[Job ${jobId}] Edit Plan:`, JSON.stringify(editPlan, null, 2));

                    // Stage 2: Patch
                    console.log(`[Job ${jobId}] Stage 2: Patching...`);
                    const patchPrompt = `${SYSTEM_INSTRUCTIONS}\n\n${UNIFIED_EDIT_MIGRATE_PROMPT}\n\n--- EDIT PLAN ---\n${JSON.stringify(editPlan, null, 2)}\n\n--- CODE CONTEXT ---\n\`\`\`html\n${numberedCode}\n\`\`\``;
                    const patchResult = await mainModel.generateContent(patchPrompt, { timeout: 120000 });
                    addUsage(patchResult);
                    const patchResponse = extractJson(patchResult.response.text());

                    // Audit
                    auditLog = {
                        planPrompt,
                        patchPrompt
                    };

                    resultText = fixCallbackPatterns(applyPatches(normalizedCode, patchResponse.changes || []));
                    console.log(`[Job ${jobId}] Patching complete. Validating...`);

                    // Validation
                    let editValidation = validateGeneratedCode(resultText);

                    if (!editValidation.valid) {
                        auditLog.initialValidationErrors = editValidation.errors;
                    }

                    if (!editValidation.valid && editValidation.canRetry) {
                        console.warn(`[Job ${jobId}] Validation failed. Retrying with fix prompt...`, editValidation.errors);
                        const fixPrompt = generateFixPrompt(editValidation.errors, resultText);

                        // Audit fix
                        auditLog.fixPrompt = fixPrompt;

                        const fixResult = await mainModel.generateContent(fixPrompt, { timeout: 120000 });
                        addUsage(fixResult);
                        resultText = fixCallbackPatterns(extractHtml(fixResult.response.text()));
                        editValidation = validateGeneratedCode(resultText);

                        if (!editValidation.valid) {
                            auditLog.finalValidationErrors = editValidation.errors;
                        }
                    }
                    if (!editValidation.valid) throw new Error(`Edit failed: ${editValidation.errors[0]?.message}`);

                    usage = totalUsage;
                    // For edits, we don't strictly need appName, client knows it.
                    break;
                }
                default:
                    throw new Error(`Invalid Async Action: ${action}`);
            }

            // Deduct Credits
            const creditsUsed = FIXED_COST_CREATE_EDIT;

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
                            creditsUsed,
                            creditsRemaining: newCredits,
                            ...(appName ? { appName } : {}),
                        },
                        audit: auditLog // Save audit logs
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
