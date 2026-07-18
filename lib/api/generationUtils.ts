/**
 * Client port of the pure helpers from `firebase/functions/src/utils.ts`
 * that the generators pipeline needs. Firestore-specific helpers stay on
 * the server — we copy only the JSON/HTML/callback/patch/retry logic.
 *
 * The behaviour is intentionally byte-for-byte identical to the server
 * so generation output stays predictable post-BYOK.
 */

// ============= JSON / HTML EXTRACTION =============

function stripJsonEllipsis(text: string): string {
    let result = '';
    let inString = false;
    let escape = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (escape) {
            result += ch;
            escape = false;
            i++;
        } else if (ch === '\\' && inString) {
            result += ch;
            escape = true;
            i++;
        } else if (ch === '"') {
            inString = !inString;
            result += ch;
            i++;
        } else if (!inString && text[i] === '.' && text[i + 1] === '.' && text[i + 2] === '.') {
            const trimmed = result.trimEnd();
            result = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
            i += 3;
        } else {
            result += ch;
            i++;
        }
    }
    return result;
}

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
    const openMatch =
        response.match(/```html[ \t]*[\r\n]/i) ??
        response.match(/```(?![a-zA-Z])/);
    if (openMatch && openMatch.index !== undefined) {
        const contentStart = openMatch.index + openMatch[0].length;
        const afterOpen = response.substring(contentStart);
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
        text.match(/^```json[ \t]*[\r\n]/i) ??
        text.match(/^```(?![a-zA-Z])/);
    if (openMatch && openMatch.index !== undefined) {
        const contentStart = openMatch.index + openMatch[0].length;
        const afterOpen = text.substring(contentStart);
        const closeIdx = afterOpen.search(/^```[ \t]*$/m);
        const stripped = closeIdx !== -1
            ? afterOpen.substring(0, closeIdx).trim()
            : afterOpen.trim();
        text = stripped.indexOf('{') !== -1 ? stripped : text;
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
        const recovered = attemptPartialJsonRecovery(text.substring(startObj));
        if (recovered !== null) {
            try {
                return JSON.parse(recovered);
            } catch (_) {
                // fall through to throw
            }
        }
        throw new Error(`AI response was truncated (depth: ${depth}, inString: ${inString}, originalLength: ${originalLength})`);
    }

    text = stripJsonEllipsis(text);
    text = repairJson(text);

    try {
        return JSON.parse(text);
    } catch (e: any) {
        throw new Error(`Failed to parse AI JSON: ${e.message} (at pos ${e.at || 'unknown'})`);
    }
}

// ============= AI RESPONSE HELPERS =============

export function extractText(result: any): string {
    if (result?.choices) {
        const text = result.choices[0]?.message?.content;
        if (!text) {
            const reason = result.choices[0]?.finish_reason;
            console.warn(`[extractText] Empty response. finish_reason: ${reason ?? 'unknown'}`);
        }
        return text || '';
    }
    return '';
}

// ============= USAGE NORMALIZATION =============

export interface GenerationUsage {
    promptTokens: number;
    responseTokens: number;
    thoughtsTokens: number;
    totalTokens: number;
    cachedTokens: number;
    // Accumulated `usage.cost` reported by OpenRouter across all HTTP calls
    // in the pipeline. Preferred over the local calculateCostUsd fallback
    // because it already accounts for web-search fees, reasoning tokens, and
    // provider-side discounts we don't otherwise see.
    reportedCostUsd: number;
}

export function emptyUsage(): GenerationUsage {
    return { promptTokens: 0, responseTokens: 0, thoughtsTokens: 0, totalTokens: 0, cachedTokens: 0, reportedCostUsd: 0 };
}

/**
 * Extract usage from an OpenRouter chat completion result and merge it into an
 * accumulator. OpenRouter wraps Gemini's response_metadata with extra fields:
 *   completion_tokens_details.reasoning_tokens (thinking tokens, billable)
 *   prompt_tokens_details.cached_tokens (25% discount on input)
 *   cost (provider-reported USD, includes web-search fees when present)
 */
export function accUsage(acc: GenerationUsage, result: any): void {
    const u = result?.usage ?? {};
    const promptTokens = u.prompt_tokens ?? 0;
    const responseTokens = u.completion_tokens ?? 0;
    const thoughtsTokens = u.completion_tokens_details?.reasoning_tokens ?? 0;
    const totalTokens = u.total_tokens ?? (promptTokens + responseTokens);
    const cachedTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
    const reportedCost = typeof u.cost === 'number' && u.cost > 0 ? u.cost : 0;
    acc.promptTokens += promptTokens;
    acc.responseTokens += responseTokens;
    acc.thoughtsTokens += thoughtsTokens;
    acc.totalTokens += totalTokens;
    acc.cachedTokens += cachedTokens;
    acc.reportedCostUsd += reportedCost;
}

// ============= CALLBACK PATTERN FIXER =============

export function fixCallbackPatterns(html: string): string {
    let fixedHtml = html;
    let callbackCounter = 0;
    const extractedCallbacks: string[] = [];

    const scriptMatch = fixedHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    if (!scriptMatch) return html;

    for (const scriptBlock of scriptMatch) {
        let scriptContent = scriptBlock.replace(/<\/?script[^>]*>/gi, '');
        let modified = false;

        // Pattern 1: function(...) { ... }
        const funcPattern = /(Appacadabra(?:AI|Calendar|Notify|Share|Contacts|Auth|Sensors)\.[a-zA-Z]+\([^,)]*),\s*function\s*\(([^)]*)\)\s*\{/g;

        let match: RegExpExecArray | null;
        while ((match = funcPattern.exec(scriptContent)) !== null) {
            callbackCounter++;
            const callbackName = `appCallback_${callbackCounter}`;
            const apiCall = match[1];
            const params = match[2];

            const startIdx = match.index + match[0].length;
            let braceCount = 1;
            let endIdx = startIdx;

            while (braceCount > 0 && endIdx < scriptContent.length) {
                if (scriptContent[endIdx] === '{') braceCount++;
                if (scriptContent[endIdx] === '}') braceCount--;
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
                if (scriptContent[endIdx] === '{') braceCount++;
                if (scriptContent[endIdx] === '}') braceCount--;
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
            const newScriptContent = extractedCallbacks.join('\n') + '\n' + scriptContent;
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
    const lines = sourceCode.replace(/\r\n/g, '\n').split('\n');
    const sortedPatches = [...patches].sort((a, b) => b.startLine - a.startLine);

    for (const patch of sortedPatches) {
        if (patch.startLine < 1 || patch.endLine > lines.length || patch.startLine > patch.endLine) {
            continue;
        }
        const startIndex = patch.startLine - 1;
        const deleteCount = (patch.endLine - patch.startLine) + 1;
        const newLines = patch.content.replace(/\r\n/g, '\n').split('\n');
        lines.splice(startIndex, deleteCount, ...newLines);
    }

    return lines.join('\n');
}

// ============= RETRY LOGIC =============

/**
 * Retry wrapper that mirrors the server's behaviour: backoff on transient
 * network failures and 5xx-style upstream errors. The client also catches
 * the OpenRouter error shape via `(e as any).retryable` so callers don't
 * need to know about the error class.
 *
 * `attempt` is passed to the callback so callers can adjust request
 * parameters on retries — most importantly, flipping `noCache: true` on
 * `openrouter.chat()` so a bad cached response can't re-serve itself.
 */
export async function withRetry<T>(
    fn: (attempt: number) => Promise<T>,
    maxRetries = 2,
): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn(attempt);
        } catch (e: any) {
            lastError = e;
            const msg: string = e?.message || '';
            const status: number | undefined = e?.status ?? e?.response?.status;
            const isRetryable =
                e?.retryable === true ||
                msg.includes('DEADLINE_EXCEEDED') ||
                msg.includes('UNAVAILABLE') ||
                msg.includes('ECONNRESET') ||
                msg.includes('ECONNREFUSED') ||
                msg.includes('fetch failed') ||
                msg.includes('Network request failed') ||
                status === 500 ||
                status === 502 ||
                status === 503 ||
                status === 529;

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
