/**
 * Firebase Functions for Appacadabra
 * Handles all AI operations with credit management via Firestore
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, DocumentReference, Transaction, DocumentData } from "firebase-admin/firestore";
import { GoogleGenerativeAI } from "@google/generative-ai";
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
    model: "gemini-2.5-flash-lite",
    // @ts-ignore - googleSearch exists in API
    tools: [{ googleSearch: {} }, { googleMaps: {} }],
});

// Main models for Create/Edit/Convert
const mainModel = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
    // @ts-ignore
    tools: [{ googleSearch: {} }],
});




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
        timeoutSeconds: 120,
        secrets: ["GEMINI_API_KEY"],
    },
    async (request): Promise<GenerateSpellResponse> => {
        // Validate authentication
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        // App Check verification (maximum security)
        if (request.app === undefined) {
            throw new HttpsError("failed-precondition", "Request not from a trusted app");
        }

        const uid = request.auth.uid;
        const {
            action,
            prompt,
            currentCode,
            instruction,
            previousEdits,
            selectedContext,
            sourceCode,
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
        const textToValidate = prompt || instruction || "";
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
                    case "create": {
                        if (!prompt) {
                            throw new HttpsError("invalid-argument", "Prompt is required for create");
                        }

                        // ============= 2-STEP CREATE PIPELINE (Unified) =============
                        // Uses gemini-3-flash-preview for speed/quality balance
                        let totalUsage = { promptTokens: 0, responseTokens: 0, totalTokens: 0 };
                        const addUsage = (u: { promptTokens: number; responseTokens: number; totalTokens: number }) => {
                            totalUsage.promptTokens += u.promptTokens;
                            totalUsage.responseTokens += u.responseTokens;
                            totalUsage.totalTokens += u.totalTokens;
                        };

                        // Stage 1: Unified Planner (Spec + Features + Contract)
                        console.log("[CREATE] Stage 1: Planning...");
                        const plannerPrompt = `${SYSTEM_INSTRUCTIONS}\n\n${UNIFIED_CREATE_PLANNER_PROMPT}\n\nUser Request: ${prompt}`;
                        const planResult = await mainModel.generateContent(plannerPrompt);
                        addUsage(getUsage(planResult));
                        const appPlan = extractJson(planResult.response.text());
                        console.log("[CREATE] Plan:", JSON.stringify(appPlan));

                        // Stage 2: Unified Code Generator (HTML + CSS + JS)
                        console.log("[CREATE] Stage 2: Generating code...");
                        const codePrompt = `${SYSTEM_INSTRUCTIONS}\n\n${UNIFIED_CREATE_CODE_PROMPT}\n\n--- APP PLAN ---\n${JSON.stringify(appPlan, null, 2)}`;
                        const codeResult = await mainModel.generateContent(codePrompt);
                        addUsage(getUsage(codeResult));

                        // Extract HTML and fix patterns
                        resultText = fixCallbackPatterns(extractHtml(codeResult.response.text()));

                        // Validate generated code
                        let validation = validateGeneratedCode(resultText);
                        if (!validation.valid) {
                            if (validation.canRetry) {
                                console.log("[CREATE] Validation failed, attempting fix...", validation.errors);
                                const fixPrompt = generateFixPrompt(validation.errors, resultText);
                                const fixResult = await mainModel.generateContent(fixPrompt);
                                addUsage(getUsage(fixResult));
                                resultText = fixCallbackPatterns(extractHtml(fixResult.response.text()));
                                console.log("[CREATE] Fix applied, revalidating...");
                                validation = validateGeneratedCode(resultText);
                            }

                            if (!validation.valid) {
                                const errorMsg = validation.errors[0]?.message || "Unknown validation error";
                                console.log("[CREATE] Final validation failed:", validation.errors);
                                throw new HttpsError("internal", `App generation failed: ${errorMsg}`);
                            }
                        }

                        usage = totalUsage;
                        console.log(`[CREATE] Total tokens: ${usage.totalTokens}`);
                        break;
                    }

                    case "edit": {
                        if (!currentCode || !instruction) {
                            throw new HttpsError("invalid-argument", "currentCode and instruction are required for edit");
                        }

                        // ============= 2-STEP EDIT PIPELINE (Unified) =============
                        let totalUsage = { promptTokens: 0, responseTokens: 0, totalTokens: 0 };
                        const addUsage = (u: { promptTokens: number; responseTokens: number; totalTokens: number }) => {
                            totalUsage.promptTokens += u.promptTokens;
                            totalUsage.responseTokens += u.responseTokens;
                            totalUsage.totalTokens += u.totalTokens;
                        };

                        // Normalize and prepare code
                        const normalizedCode = currentCode.replace(/\r\n/g, "\n");
                        const codeLines = normalizedCode.split("\n");
                        const numberedCode = codeLines.map((line: string, i: number) => `${i + 1}| ${line}`).join("\n");

                        // Build history context
                        const historyContext = previousEdits && previousEdits.length > 0
                            ? `\nPrevious edits:\n${previousEdits.map((e: PreviousEdit) => `- v${e.version}: ${e.instruction}`).join("\n")}\n`
                            : "";

                        // Build selection context
                        const selectionPart = selectedContext
                            ? `\nSelected code:\n"""\n${selectedContext}\n"""\n`
                            : "";

                        // Stage 1: Unified Planner (Intent + Impact + Patch Plan)
                        console.log("[EDIT] Stage 1: Planning patches...");
                        const planPrompt = `${SYSTEM_INSTRUCTIONS}\n\n${UNIFIED_EDIT_PLANNER_PROMPT}\n\nUser's edit request: ${instruction}${historyContext}${selectionPart}\n\nFull code:\n\`\`\`html\n${numberedCode}\n\`\`\``;
                        const planResult = await mainModel.generateContent(planPrompt);
                        addUsage(getUsage(planResult));
                        const editPlan = extractJson(planResult.response.text());
                        console.log("[EDIT] Plan:", JSON.stringify(editPlan));

                        // Stage 2: Patch Generator (Generate JSON Patches)
                        console.log("[EDIT] Stage 2: Generating patches...");
                        const patchPrompt = `${SYSTEM_INSTRUCTIONS}\n\n${UNIFIED_EDIT_MIGRATE_PROMPT}\n\n--- EDIT PLAN ---\n${JSON.stringify(editPlan, null, 2)}\n\n--- CODE CONTEXT ---\n\`\`\`html\n${numberedCode}\n\`\`\``;
                        const patchResult = await mainModel.generateContent(patchPrompt);
                        addUsage(getUsage(patchResult));
                        const patchResponse = extractJson(patchResult.response.text());

                        // Apply patches deterministically
                        resultText = fixCallbackPatterns(applyPatches(normalizedCode, patchResponse.changes || []));

                        // Validate edited code
                        let editValidation = validateGeneratedCode(resultText);
                        if (!editValidation.valid) {
                            if (editValidation.canRetry) {
                                console.log("[EDIT] Validation failed, attempting fix...", editValidation.errors);
                                const fixPrompt = generateFixPrompt(editValidation.errors, resultText);
                                const fixResult = await mainModel.generateContent(fixPrompt);
                                addUsage(getUsage(fixResult));
                                resultText = fixCallbackPatterns(extractHtml(fixResult.response.text()));
                                console.log("[EDIT] Fix applied");
                                editValidation = validateGeneratedCode(resultText);
                            }

                            if (!editValidation.valid) {
                                const errorMsg = editValidation.errors[0]?.message || "Unknown validation error";
                                console.log("[EDIT] Final validation failed:", editValidation.errors);
                                throw new HttpsError("internal", `Edit failed: ${errorMsg}`);
                            }
                        }

                        usage = totalUsage;
                        console.log(`[EDIT] Total tokens: ${usage.totalTokens}`);
                        break;
                    }

                    case "convert": {
                        if (!sourceCode) {
                            throw new HttpsError("invalid-argument", "sourceCode is required for convert");
                        }

                        const framework = frameworkHint || "web project";
                        // SYSTEM_INSTRUCTIONS first for implicit caching
                        const convertPrompt = `${SYSTEM_INSTRUCTIONS}\n\n${CONVERT_PROJECT_PROMPT}\n\nFramework hint: ${framework}\n\nSOURCE CODE TO CONVERT:\n${sourceCode}`;

                        const result = await mainModel.generateContent(convertPrompt);

                        // Validate converted code
                        let convertResultText = fixCallbackPatterns(extractHtml(result.response.text()));
                        let convertValidation = validateGeneratedCode(convertResultText);

                        if (!convertValidation.valid) {
                            if (convertValidation.canRetry) {
                                console.log("[CONVERT] Validation failed, attempting fix...", convertValidation.errors);
                                const fixPrompt = generateFixPrompt(convertValidation.errors, convertResultText);
                                const fixResult = await mainModel.generateContent(fixPrompt);
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
                        if (schema) {
                            // If schema is present, we need a JSON model.
                            // We don't have a dedicated "webviewJsonModel", but we can use genAI to get one with tools if needed
                            // Or assume the fallbackJsonModel (lite) is sufficient as requested.
                            // The user said: "use gemini-2.5-flash-lite ... for everything webview"
                            model = genAI.getGenerativeModel({
                                model: "gemini-3-flash-preview",
                                generationConfig: { responseMimeType: "application/json" },
                                // @ts-ignore
                                tools: useSearch ? [{ googleSearch: {} }] : undefined,
                            });
                        } else {
                            if (useSearch) {
                                model = webviewSearchModel;
                            } else {
                                model = webviewModel;
                            }
                        }

                        const result = await model.generateContent(parts);
                        usage = getUsage(result);
                        resultText = result.response.text();

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
                text: resultText,
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
