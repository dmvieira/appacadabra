/**
 * Pure utility functions extracted from index.ts for testability.
 * No Firebase or external dependencies — all functions are side-effect-free.
 */

// ============= FIRESTORE UTILS =============

/**
 * Aggressive sanitization for metadata blocks (usage, logs, extras).
 * Only primitive types, strict plain objects, and arrays are allowed.
 */
export function sanitizeForFirestore(obj: any): any {
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


// ============= USD COST CALCULATION =============

export const MANA_VALUE_USD = 0.06; // 1 mana ≡ $0.06 AI compute (~45% margem sobre mana_50)

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
        searchPerQuery: 0.014,
        mapsPerQuery: 0.025,
    },
    'gemini-2.5-flash': {
        inputPerMToken: 0.30,
        outputPerMToken: 2.50,
        audioInputPerMToken: 1.00,
        searchPerQuery: 0.035,
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
    // OpenRouter models
    'openai/gpt-oss-120b:free': { inputPerMToken: 0.10, outputPerMToken: 0.40, audioInputPerMToken: 0.30 },
    'deepseek/deepseek-v4-flash': { inputPerMToken: 0.14, outputPerMToken: 0.28, audioInputPerMToken: 1.00, searchPerQuery: 0.014 },
    'google/gemini-3.1-flash-lite-preview': { inputPerMToken: 0.25, outputPerMToken: 1.50, audioInputPerMToken: 1.00, searchPerQuery: 0.014 },
};

const USD_IMAGE_PER_UNIT = 0.04;
const USD_VIDEO_PER_SECOND_FAST = 0.25;
const USD_VIDEO_PER_SECOND_STD = 0.65;
const MANA_PER_INPUT_IMAGE = 0.1;

export function calculateCostUsd(
    modelId: string,
    usage: { promptTokens: number; responseTokens: number; thoughtsTokens?: number; cachedTokens?: number },
    extras?: { searchQueries?: number; mapsQueries?: number; audioTokens?: number }
): number {
    const pricing = USD_PRICING[modelId];
    if (!pricing) return 0;

    const cached = usage.cachedTokens ?? 0;
    const nonCached = usage.promptTokens - cached;
    const inputCost = (nonCached / 1_000_000) * pricing.inputPerMToken
        + (cached / 1_000_000) * pricing.inputPerMToken * 0.25;

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

export function calcImageMana(numInputImages: number): number {
    return USD_IMAGE_PER_UNIT / MANA_VALUE_USD + numInputImages * MANA_PER_INPUT_IMAGE;
}

export function calcVideoMana(durationSeconds: number, hasImages: boolean): number {
    const costUsd = durationSeconds * (hasImages ? USD_VIDEO_PER_SECOND_STD : USD_VIDEO_PER_SECOND_FAST);
    return costUsd / MANA_VALUE_USD;
}


// ============= JSON / HTML EXTRACTION =============

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

function attemptPartialJsonRecovery(text: string): string | null {
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

    const opener = text[0];
    const closer = opener === '{' ? '}' : ']';
    const partial = text.substring(0, lastDepth1Close + 1).trimEnd();
    const trimmed = partial.replace(/,\s*$/, '');
    return trimmed + closer;
}

export function extractHtml(response: string): string {
    // Prefer ```html (explicit tag); fall back to ``` not followed by a language word.
    // This prevents ```css / ```js from being mistaken for the HTML fence.
    const openMatch =
        response.match(/```html[ \t]*[\r\n]/i) ??
        response.match(/```(?![a-zA-Z])/);
    if (openMatch && openMatch.index !== undefined) {
        const contentStart = openMatch.index + openMatch[0].length;
        const afterOpen = response.substring(contentStart);
        // Find the first closing ``` on its own line (not another language fence).
        const closeIdx = afterOpen.search(/^```[ \t]*$/m);
        if (closeIdx !== -1) {
            return afterOpen.substring(0, closeIdx).trim();
        }
        return afterOpen.trim();
    }
    const docTypeIdx = response.toLowerCase().indexOf('<!doctype html>');
    if (docTypeIdx !== -1) {
        return response.substring(docTypeIdx).trim();
    }
    return response.trim();
}

export function extractJson(response: string): any {
    let text = response.trim();
    const originalLength = text.length;

    const openMatch =
        text.match(/```json[ \t]*[\r\n]/i) ??
        text.match(/```(?![a-zA-Z])/);
    if (openMatch && openMatch.index !== undefined) {
        const contentStart = openMatch.index + openMatch[0].length;
        const afterOpen = text.substring(contentStart);
        const closeIdx = afterOpen.search(/^```[ \t]*$/m);
        if (closeIdx !== -1) {
            text = afterOpen.substring(0, closeIdx).trim();
        } else {
            text = afterOpen.trim();
        }
    }

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
        let recovered = attemptPartialJsonRecovery(text.substring(startObj));
        if (recovered !== null) {
            try {
                return JSON.parse(recovered);
            } catch (_) {
                // fall through to throw
            }
        }
        throw new Error(`AI response was truncated (depth: ${depth}, inString: ${inString}, originalLength: ${originalLength})`);
    }

    text = repairJson(text);

    try {
        return JSON.parse(text);
    } catch (e: any) {
        throw new Error(`Failed to parse AI JSON: ${e.message} (at pos ${e.at || 'unknown'})`);
    }
}


// ============= CALLBACK PATTERN FIXER =============

export function fixCallbackPatterns(html: string): string {
    let fixedHtml = html;
    let callbackCounter = 0;
    const extractedCallbacks: string[] = [];

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
            const newScriptContent = extractedCallbacks.join("\n") + "\n" + scriptContent;
            fixedHtml = fixedHtml.replace(scriptBlock, `<script>${newScriptContent}</script>`);
            extractedCallbacks.length = 0;
        }
    }

    return fixedHtml;
}


// ============= PATCH APPLICATION =============

export interface Patch {
    startLine: number;
    endLine: number;
    content: string;
}

export function applyPatches(sourceCode: string, patches: Patch[]): string {
    let lines = sourceCode.replace(/\r\n/g, "\n").split("\n");
    const sortedPatches = [...patches].sort((a, b) => b.startLine - a.startLine);

    for (const patch of sortedPatches) {
        if (patch.startLine < 1 || patch.endLine > lines.length || patch.startLine > patch.endLine) {
            continue;
        }
        const startIndex = patch.startLine - 1;
        const deleteCount = (patch.endLine - patch.startLine) + 1;
        const newLines = patch.content.replace(/\r\n/g, "\n").split("\n");
        lines.splice(startIndex, deleteCount, ...newLines);
    }

    return lines.join("\n");
}


// ============= RETRY LOGIC =============

/** Retries transient Gemini/network errors with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (e: any) {
            lastError = e;
            const msg: string = e?.message || '';
            const status: number | undefined = e?.status ?? e?.response?.status;
            const isRetryable =
                msg.includes('DEADLINE_EXCEEDED') ||
                msg.includes('UNAVAILABLE') ||
                msg.includes('ECONNRESET') ||
                msg.includes('ECONNREFUSED') ||
                msg.includes('fetch failed') ||
                e?.cause?.code === 'ECONNRESET' ||
                e?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
                msg.includes('UND_ERR_HEADERS_TIMEOUT') ||
                status === 500 ||
                status === 502 ||
                status === 503 ||
                status === 529; // OpenRouter overloaded

            if (isRetryable && attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 1000;
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw e;
            }
        }
    }
    throw lastError;
}


// ============= MANA COST ESTIMATION =============

export function computeManaCost(type: string, data: any): { mana: string; value: number } {
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

// ============= AI RESPONSE HELPERS =============

export function extractText(result: any): string {
    // OpenAI / OpenRouter format
    if (result?.choices) {
        const text = result.choices[0]?.message?.content;
        if (!text) {
            const reason = result.choices[0]?.finish_reason;
            console.warn(`[extractText] Empty response. finish_reason: ${reason ?? 'unknown'}`);
        }
        return text || '';
    }
    // Gemini format
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

export function getUsage(result: any): { promptTokens: number; responseTokens: number; thoughtsTokens: number; totalTokens: number } {
    // OpenAI / OpenRouter format
    if (result?.usage?.prompt_tokens !== undefined) {
        const thoughtsTokens = result.usage.completion_tokens_details?.reasoning_tokens || 0;
        if (thoughtsTokens > 0) console.log(`[THINKING] ${thoughtsTokens} thinking tokens`);
        return {
            promptTokens: result.usage.prompt_tokens || 0,
            responseTokens: result.usage.completion_tokens || 0,
            thoughtsTokens,
            totalTokens: result.usage.total_tokens || 0,
        };
    }
    // Gemini format
    const usage = result.usageMetadata;
    const cachedTokens = usage?.cachedContentTokenCount || 0;
    if (cachedTokens > 0) console.log(`[CACHE HIT] ${cachedTokens} tokens from cache`);
    const thoughtsTokens = usage?.thoughtsTokenCount || 0;
    if (thoughtsTokens > 0) console.log(`[THINKING] ${thoughtsTokens} thinking tokens`);
    return {
        promptTokens: usage?.promptTokenCount || 0,
        responseTokens: usage?.candidatesTokenCount || 0,
        thoughtsTokens,
        totalTokens: usage?.totalTokenCount || 0,
    };
}
