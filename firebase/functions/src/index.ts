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
    GENERATE_APP_PROMPT,
    SMART_PATCH_INSTRUCTIONS,
    CONVERT_PROJECT_PROMPT,
    validateContentRequest,
} from "./prompts";

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

// Main models for Create/Edit/Convert (Pro/Preview version as requested)
// All main actions use googleSearch as requested
const mainModel = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
    // @ts-ignore
    tools: [{ googleSearch: {} }],
});

const mainJsonModel = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
    generationConfig: { responseMimeType: "application/json" },
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

                        const fullPrompt = SYSTEM_INSTRUCTIONS + "\n\n" + GENERATE_APP_PROMPT + prompt;

                        const result = await mainModel.generateContent(fullPrompt);
                        usage = getUsage(result);
                        resultText = extractHtml(result.response.text());
                        break;
                    }

                    case "edit": {
                        if (!currentCode || !instruction) {
                            throw new HttpsError("invalid-argument", "currentCode and instruction are required for edit");
                        }

                        // Add line numbers to code
                        const normalizedCode = currentCode.replace(/\r\n/g, "\n");
                        const codeLines = normalizedCode.split("\n");
                        const numberedCode = codeLines.map((line: string, i: number) => `${i + 1}| ${line}`).join("\n");

                        // Build history context if previous edits exist
                        const historyContext = previousEdits && previousEdits.length > 0
                            ? `\nIMPORTANT - Previous edits made to this app (DO NOT UNDO these changes):\n${previousEdits.map((e: PreviousEdit) => `- v${e.version}: ${e.instruction}`).join("\n")}\nMake sure your new edit PRESERVES all the functionality and changes from previous versions.\n`
                            : "";

                        // Build selection context if user selected specific code
                        const selectionPart = selectedContext
                            ? `\nThe user selected this specific part of the code (Focus your edits here):\n"""\n${selectedContext}\n"""\n`
                            : "";

                        const editPrompt = `${SYSTEM_INSTRUCTIONS}\n\nHere is an existing HTML application with line numbers:\n\n\`\`\`html\n${numberedCode}\n\`\`\`\n${historyContext}${selectionPart}\nUser instructions: ${instruction}\n\n${SMART_PATCH_INSTRUCTIONS}`;

                        const result = await mainJsonModel.generateContent(editPrompt);
                        usage = getUsage(result);
                        const jsonResponse = JSON.parse(result.response.text());
                        resultText = applyPatches(normalizedCode, jsonResponse.changes || []);
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
                        usage = getUsage(result);
                        resultText = extractHtml(result.response.text());
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
                                model: "gemini-2.5-flash-lite",
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
