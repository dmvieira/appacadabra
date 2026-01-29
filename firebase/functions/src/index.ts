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
// WebView models (Lite version as requested)
const webviewModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

const webviewSearchModel = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    // @ts-ignore - googleSearch exists in API
    tools: [{ googleSearch: {} }, { googleMaps: {} }],
});

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
const RATE_LIMITS = {
    // Maximum calls per minute per user
    CALLS_PER_MINUTE: 10,
    // Maximum tokens per minute per user (prevents loop abuse)
    TOKENS_PER_MINUTE: 50000,
    // Cooldown after hitting limit (ms)
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

// Constants
const TOKENS_PER_CREDIT = 7000; // 1 mana = 7000 tokens

interface PreviousEdit {
    version: number;
    instruction: string;
}

interface GenerateSpellRequest {
    action: "create" | "edit" | "convert" | "webview_ai";
    prompt?: string;
    currentCode?: string;
    instruction?: string;
    // For edit - include history context
    previousEdits?: PreviousEdit[];
    selectedContext?: string;
    // For convert
    sourceCode?: string;
    frameworkHint?: string;
    // For WebView AI
    schema?: object;
    imageBase64?: string;
    audioBase64?: string;
    useSearch?: boolean; // New parameter for consolidated webview action
}

interface GenerateSpellResponse {
    text: string;
    usage: {
        promptTokens: number;
        responseTokens: number;
        totalTokens: number;
    };
    creditsUsed: number;
    creditsRemaining: number;
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
// Deterministically fixes inline callbacks in Appacadabra API calls
// Transforms: AppacadabraAI.generate("prompt", function(...) { ... })
// Into: window.handle_X = function(...) { ... }; AppacadabraAI.generate("prompt", "handle_X");

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

// Apply patches to source code
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

// Main function to generate/edit spells
export const generateSpell = onCall<GenerateSpellRequest>(
    {
        region: "southamerica-east1",
        memory: "512MiB",
        timeoutSeconds: 300, // 5 minutes to match client timeout
        secrets: ["GEMINI_API_KEY"],
    },
    async (request): Promise<GenerateSpellResponse> => {
        // Validate authentication
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        // App Check verification (maximum security)
        // if (request.app === undefined) {
        //     throw new HttpsError("failed-precondition", "Request not from a trusted app");
        // }

        const uid = request.auth.uid;
        // Decompress inputs
        const action = request.data.action;
        const prompt = decompressContent(request.data.prompt || "");
        const sourceCode = decompressContent(request.data.sourceCode || "");

        const {
            frameworkHint,
            schema,
            imageBase64,
            audioBase64,
            useSearch
        } = request.data;

        // Validate required fields
        if (!action) {
            throw new HttpsError("invalid-argument", "Action is required");
        }

        // Content moderation
        const textToValidate = prompt || sourceCode || "";
        if (textToValidate) {
            const validation = validateContentRequest(textToValidate);
            if (!validation.allowed) {
                throw new HttpsError("permission-denied", validation.reason || "Request blocked");
            }
        }

        const userRef = db.collection("users").doc(uid);

        // Use transaction for atomic credit operations
        return await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);

            // Create user document if doesn't exist
            if (!userDoc.exists) {
                transaction.set(userRef, {
                    credits: 0,
                    creditsUsed: 0,
                    createdAt: FieldValue.serverTimestamp(),
                    lastActive: FieldValue.serverTimestamp(),
                });
                throw new HttpsError("failed-precondition", "Insufficient credits");
            }

            const userData = userDoc.data()!;
            const currentCredits = userData.credits || 0;

            // Check minimum credits (0.1 to allow starting)
            if (currentCredits < 0.1) {
                throw new HttpsError("failed-precondition", "Insufficient credits");
            }

            // Check rate limits (prevents loop abuse)
            const rateLimitError = await checkRateLimit(userRef, transaction, userData);
            if (rateLimitError) {
                throw new HttpsError("resource-exhausted", rateLimitError);
            }

            let resultText = "";
            let usage = { promptTokens: 0, responseTokens: 0, totalTokens: 0 };

            try {
                switch (action) {
                    case "create":
                        throw new HttpsError("failed-precondition", "Action 'create' has moved to async Job Queue. Please update app.");

                    case "edit":
                        throw new HttpsError("failed-precondition", "Action 'edit' has moved to async Job Queue. Please update app.");

                    case "convert": {
                        if (!sourceCode) {
                            throw new HttpsError("invalid-argument", "sourceCode is required for convert");
                        }

                        const framework = frameworkHint || "web project";
                        // SYSTEM_INSTRUCTIONS first for implicit caching
                        const convertPrompt = `${SYSTEM_INSTRUCTIONS}\n\n${CONVERT_PROJECT_PROMPT}\n\nFramework hint: ${framework}\n\nSOURCE CODE TO CONVERT:\n${sourceCode}`;

                        const result = await mainModel.generateContent(convertPrompt, { timeout: 120000 });

                        // Validate converted code
                        let convertResultText = fixCallbackPatterns(extractHtml(result.response.text()));
                        let convertValidation = validateGeneratedCode(convertResultText);

                        if (!convertValidation.valid) {
                            if (convertValidation.canRetry) {
                                console.log("[CONVERT] Validation failed, attempting fix...", convertValidation.errors);
                                const fixPrompt = generateFixPrompt(convertValidation.errors, convertResultText);
                                const fixResult = await mainModel.generateContent(fixPrompt, { timeout: 120000 });
                                // Note: We sum up usage here? Logic above uses `usage = ...`. 
                                // To be accurate we should accumulate, but current logic assigns `usage`.
                                // Let's accumulate for correctness in this scope.
                                const fixUsage = getUsage(fixResult);
                                usage = {
                                    promptTokens: (getUsage(result).promptTokens + fixUsage.promptTokens),
                                    responseTokens: (getUsage(result).responseTokens + fixUsage.responseTokens),
                                    totalTokens: (getUsage(result).totalTokens + fixUsage.totalTokens)
                                };
                                convertResultText = fixCallbackPatterns(extractHtml(fixResult.response.text()));
                                convertValidation = validateGeneratedCode(convertResultText);
                            }

                            if (!convertValidation.valid) {
                                const errorMsg = convertValidation.errors[0]?.message || "Unknown validation error";
                                console.log("[CONVERT] Final validation failed:", convertValidation.errors);
                                throw new HttpsError("internal", `Conversion failed: ${errorMsg}`);
                            }
                        } else {
                            usage = getUsage(result);
                        }

                        resultText = convertResultText;
                        break;
                    }

                    case "webview_ai": {
                        if (!prompt) {
                            throw new HttpsError("invalid-argument", "Prompt is required for webview_ai");
                        }

                        const parts: any[] = [prompt];

                        // Add image if provided
                        if (imageBase64) {
                            parts.push({
                                inlineData: {
                                    mimeType: "image/jpeg",
                                    data: imageBase64,
                                },
                            });
                        }

                        // Add audio if provided
                        if (audioBase64) {
                            parts.push({
                                inlineData: {
                                    mimeType: "audio/wav",
                                    data: audioBase64,
                                },
                            });
                        }

                        // Determine model based on schema (JSON) or search/default
                        let model;
                        let result;
                        if (schema) {
                            // Robustness: If schema appears to be data (not a schema), infer it
                            let effectiveSchema = schema;
                            // validation heuristic: if it doesn't have "type" keyword at root, it's likely data
                            if (!(schema as any).type) {
                                console.log("[WEBVIEW_AI] Inferring schema from data example...");
                                effectiveSchema = inferSchema(schema);
                            }

                            // If schema is present, we need a JSON model.
                            // We don't have a dedicated "webviewJsonModel", but we can use genAI to get one with tools if needed
                            // Or assume the fallbackJsonModel (lite) is sufficient as requested.
                            // The user said: "use gemini-2.5-flash ... for everything webview"
                            model = genAI.getGenerativeModel({
                                model: "gemini-3-flash-preview",
                                generationConfig: {
                                    responseMimeType: "application/json",
                                    // @ts-ignore - schema is supported in preview
                                    responseSchema: effectiveSchema
                                },
                                // @ts-ignore
                                tools: useSearch ? [{ googleSearch: {} }] : undefined,
                            });

                            try {
                                result = await model.generateContent(parts, { timeout: 120000 });
                                usage = getUsage(result);
                                resultText = result.response.text();
                            } catch (schemaError: any) {
                                console.warn("[WEBVIEW_AI] Schema generation failed, falling back to prompt instructions...", schemaError.message);

                                // Fallback: Remove schema from config and add to prompt
                                model = genAI.getGenerativeModel({
                                    model: "gemini-3-flash-preview",
                                    generationConfig: {
                                        responseMimeType: "application/json"
                                    },
                                    // @ts-ignore
                                    tools: useSearch ? [{ googleSearch: {} }] : undefined,
                                });

                                // Append schema instructions to the LAST part (text)
                                const schemaPrompt = `\n\nRETURN JSON ONLY. STRICTLY FOLLOW THIS SCHEMA:\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``;

                                if (typeof parts[0] === 'string') {
                                    parts[0] += schemaPrompt;
                                } else {
                                    // Should be string at 0 usually, but safety check
                                    parts.push(schemaPrompt);
                                }

                                result = await model.generateContent(parts, { timeout: 120000 });
                                usage = getUsage(result);
                                resultText = result.response.text();
                            }
                        } else {
                            if (useSearch) {
                                model = webviewSearchModel;
                            } else {
                                model = webviewModel;
                            }

                            result = await model.generateContent(parts, { timeout: 120000 });
                            usage = getUsage(result);
                            resultText = result.response.text();
                        }
                        console.log(`[WEBVIEW_AI] Generated text length: ${resultText?.length}`);
                        if (!resultText) {
                            console.warn(`[WEBVIEW_AI] Generated text is empty! Prompt: ${prompt.substring(0, 100)}...`);

                            // Deep Debugging
                            const responseDump = result ? JSON.stringify(result.response, null, 2) : "No result object";
                            console.warn(`[WEBVIEW_AI] Full Response Dump: ${responseDump}`);

                            const candidate = result?.response?.candidates?.[0];
                            if (candidate) {
                                console.warn(`[WEBVIEW_AI] Finish Reason: ${candidate.finishReason}`);
                                console.warn(`[WEBVIEW_AI] Safety Ratings: ${JSON.stringify(candidate.safetyRatings)}`);
                            }
                        }


                        // Validate JSON if schema was requested
                        if (schema) {
                            try {
                                // This throws if invalid JSON
                                extractJson(resultText);
                            } catch (e) {
                                console.error("[WEBVIEW_AI] JSON validation failed:", e);
                                throw new HttpsError("internal", "AI failed to generate valid JSON response");
                            }
                        }
                        break;
                    }

                    default:
                        throw new HttpsError("invalid-argument", `Unknown action: ${action}`);
                }
            } catch (error: any) {
                // If it's already an HttpsError, rethrow
                if (error.code) {
                    throw error;
                }
                console.error("Gemini API error:", error);
                throw new HttpsError("internal", `AI generation failed: ${error.message}`);
            }

            // Calculate credits used
            const creditsUsed = usage.totalTokens / TOKENS_PER_CREDIT;
            const newCredits = Math.max(0, currentCredits - creditsUsed);

            // Get current rate limit to update token count
            const currentRateLimit: RateLimitData = userData.rateLimit || {
                callsThisMinute: 0,
                callsThisHour: 0,
                tokensThisMinute: 0,
                lastMinuteReset: Date.now(),
                lastHourReset: Date.now(),
            };
            currentRateLimit.tokensThisMinute += usage.totalTokens;

            // Update user credits and rate limit tokens
            transaction.update(userRef, {
                credits: newCredits,
                creditsUsed: FieldValue.increment(creditsUsed),
                lastActive: FieldValue.serverTimestamp(),
                rateLimit: currentRateLimit,
            });

            return {
                text: compressContent(resultText), // Compress output
                usage,
                creditsUsed,
                creditsRemaining: newCredits,
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
                    let totalUsage = { promptTokens: 0, responseTokens: 0, totalTokens: 0 };
                    const addUsage = (u: any) => {
                        totalUsage.promptTokens += u.promptTokens;
                        totalUsage.responseTokens += u.responseTokens;
                        totalUsage.totalTokens += u.totalTokens;
                    };

                    // Stage 1: Planning
                    console.log(`[Job ${jobId}] Stage 1: Planning...`);
                    const plannerPrompt = `${SYSTEM_INSTRUCTIONS}\n\n${UNIFIED_CREATE_PLANNER_PROMPT}\n\nUser Request: ${prompt}`;
                    const planResult = await mainModel.generateContent(plannerPrompt, { timeout: 120000 });
                    addUsage(getUsage(planResult));
                    const appPlan = extractJson(planResult.response.text());
                    console.log(`[Job ${jobId}] Plan created:`, JSON.stringify(appPlan).substring(0, 200) + '...');

                    // Stage 2: Coding
                    console.log(`[Job ${jobId}] Stage 2: Coding...`);
                    const codePrompt = `${SYSTEM_INSTRUCTIONS}\n\n${UNIFIED_CREATE_CODE_PROMPT}\n\n--- APP PLAN ---\n${JSON.stringify(appPlan, null, 2)}`;
                    const codeResult = await mainModel.generateContent(codePrompt, { timeout: 120000 });
                    addUsage(getUsage(codeResult));

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
                        addUsage(getUsage(fixResult));
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
                    let totalUsage = { promptTokens: 0, responseTokens: 0, totalTokens: 0 };
                    const addUsage = (u: any) => {
                        totalUsage.promptTokens += u.promptTokens;
                        totalUsage.responseTokens += u.responseTokens;
                        totalUsage.totalTokens += u.totalTokens;
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
                    addUsage(getUsage(planResult));
                    const editPlan = extractJson(planResult.response.text());
                    console.log(`[Job ${jobId}] Edit Plan:`, JSON.stringify(editPlan, null, 2));

                    // Stage 2: Patch
                    console.log(`[Job ${jobId}] Stage 2: Patching...`);
                    const patchPrompt = `${SYSTEM_INSTRUCTIONS}\n\n${UNIFIED_EDIT_MIGRATE_PROMPT}\n\n--- EDIT PLAN ---\n${JSON.stringify(editPlan, null, 2)}\n\n--- CODE CONTEXT ---\n\`\`\`html\n${numberedCode}\n\`\`\``;
                    const patchResult = await mainModel.generateContent(patchPrompt, { timeout: 120000 });
                    addUsage(getUsage(patchResult));
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
                        addUsage(getUsage(fixResult));
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
            const creditsUsed = usage.totalTokens / TOKENS_PER_CREDIT;

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
