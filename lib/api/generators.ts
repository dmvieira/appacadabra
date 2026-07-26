/**
 * Client-side AI generators (Phase 2 implementation).
 *
 * Direct port of `firebase/functions/src/generators.ts` — the planner+coder
 * ordering, prompts, reasoning effort, web-search tools, fix loop iterations,
 * and outer retry policy must match the server byte-for-byte so generation
 * quality stays identical after BYOK rolls out.
 *
 * The only mechanical difference: `or.chat.completions.create(...)` becomes
 * `openrouter.chat({...})` (our thin fetch wrapper) — same request shape,
 * same response shape.
 */

import { chat as openrouterChat, OpenRouterError, type ChatResponse, type ChatMessage } from './openrouter';
import { OR_REASONING_HIGH, OR_WEB_SEARCH, calculateCostUsd } from './pricing';
import { getPreferredModel } from './modelPreferences';
import {
    UNIFIED_CREATE_PLANNER_PROMPT,
    UNIFIED_CREATE_CODE_PROMPT,
    UNIFIED_EDIT_PLANNER_PROMPT,
    UNIFIED_EDIT_MIGRATE_PROMPT,
    CONVERT_PROJECT_PROMPT,
} from './prompts';
import {
    buildSystemInstructions,
    buildPlannerSystemInstructions,
    getCapabilitiesByApiNames,
} from './systemPrompt';
import { ALL_CAPABILITIES } from '../capabilities';
import {
    extractHtml,
    extractJson,
    extractText,
    fixCallbackPatterns,
    applyPatches,
    withRetry,
    makeRetryableEmptyResponseError,
    accUsage,
    emptyUsage,
    type GenerationUsage,
} from './generationUtils';
import {
    validateGeneratedCode,
    generateFixPrompt,
    type ValidationError,
} from '../validators/codeValidator';
import { validateWithExecution } from '../validators/executionValidator';
import { SPELL_MAX_TOKENS } from './generatorStages';

// ============================================================
// Shared types
// ============================================================

const GENERATION_TIMEOUT_MS = 480_000;

export type ProgressEvent =
    | { type: 'plan_started' }
    | { type: 'plan_completed'; planSummary?: string }
    | { type: 'code_started' }
    | { type: 'code_progress'; charsSoFar: number }
    | { type: 'code_completed' }
    | { type: 'validation_failed'; attempt: number; errorCount: number }
    | { type: 'fix_started'; attempt: number }
    | { type: 'completed' };

// Race a generation call against the global timeout (mirrors server raceTimeout).
async function raceTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeout = new Promise<never>((_, reject) =>
        setTimeout(
            () => reject(new Error(`AI Generation Timeout (${GENERATION_TIMEOUT_MS / 1000}s)`)),
            GENERATION_TIMEOUT_MS,
        ),
    );
    return Promise.race([promise, timeout]);
}

function makeUserContent(text: string): ChatMessage {
    return { role: 'user', content: text };
}

function makeSystemContent(text: string): ChatMessage {
    return { role: 'system', content: text };
}

// Prefer OpenRouter's reported usage.cost (already includes web search + reasoning)
// and fall back to local per-token pricing when the field is missing. Same guard
// as the WebView AI path in lib/api/ai.ts. `modelId` is the effective model
// actually called (respects user's preference), so the fallback matches what
// OpenRouter would have charged for that specific model.
function resolveCostUsd(usage: GenerationUsage, modelId: string): number {
    return usage.reportedCostUsd > 0
        ? usage.reportedCostUsd
        : calculateCostUsd(modelId, usage);
}

// Sniff audio container from magic bytes on the raw base64 (no decoding
// needed — we compare base64 prefixes directly).
// Gemini/OpenRouter reject audio when `input_audio.format` disagrees with
// the actual container, so hardcoding 'wav' breaks OGG (WhatsApp voice
// notes), MP3, FLAC, AAC, etc. Defaults to 'wav' if unrecognized — most
// clients that produce audio inside the WebView (MediaRecorder) still emit
// WAV/PCM, so this is a safe fallback.
function detectAudioFormat(base64: string): 'wav' | 'mp3' | 'ogg' | 'flac' | 'aac' | 'm4a' | 'webm' {
    if (!base64) return 'wav';
    // WAV: "RIFF" → "UklGR"
    if (base64.startsWith('UklGR')) return 'wav';
    // OGG (incl. OPUS-in-OGG from WhatsApp): "OggS" → "T2dnU" or "T2dnUw"
    if (base64.startsWith('T2dnU')) return 'ogg';
    // FLAC: "fLaC" → "ZkxhQw"
    if (base64.startsWith('ZkxhQ')) return 'flac';
    // MP3 with ID3v2 tag: "ID3" → "SUQz"
    if (base64.startsWith('SUQz')) return 'mp3';
    // MPEG/AAC frame sync — first byte 0xFF makes chars 1-2 always "//"; the
    // 3rd char narrows to a 2-bit-varying set determined by the sync + layer:
    //   0xFFFB (MP3 L3 MPEG-1)  → s,t,u,v      0xFFF3 (MP3 L3 MPEG-2) → M,N,O,P
    //   0xFFFA (MP3 L2 MPEG-1)  → o,p,q,r      0xFFF2 (MP3 L2 MPEG-2) → I,J,K,L
    //   0xFFF1/0xFFF9 (ADTS AAC) → E,F,G,H / k,l,m,n
    if (base64.startsWith('//')) {
        const c3 = base64.charAt(2);
        if ('stuvMNOPopqrIJKL'.indexOf(c3) >= 0) return 'mp3';
        if ('EFGHklmn'.indexOf(c3) >= 0) return 'aac';
    }
    // MP4/M4A: ISO box "ftyp" at byte offset 4 → base64 chars 5..12 contain "ZnR5cA"
    if (base64.length >= 16 && base64.slice(4, 14).indexOf('ZnR5cA') >= 0) return 'm4a';
    // WebM/Matroska EBML header "1A 45 DF A3" → "GkXf"
    if (base64.startsWith('GkXf')) return 'webm';
    return 'wav';
}

// ============================================================
// generateSpellCreate
// ============================================================

export interface CreateResult {
    html: string;
    usage: GenerationUsage;
    costUsd: number;
    appName?: string;
    /** Validation errors found before the fix loop ran. Empty = first-pass was valid. */
    initialValidationErrors: ValidationError[];
}

export interface CreateParams {
    prompt: string;
    appVersion: string;
    signal?: AbortSignal;
    onProgress?: (e: ProgressEvent) => void;
}

/**
 * Two-stage planner + coder. Mirrors server's `generateSpellCreate`:
 *   1. `UNIFIED_CREATE_PLANNER_PROMPT` → JSON plan
 *   2. `UNIFIED_CREATE_CODE_PROMPT` + plan → HTML
 *   3. Validate via codeValidator + executionValidator
 *   4. Auto-fix loop up to 2 iterations with `generateFixPrompt`
 *   5. Outer retry up to 3 attempts (attempt 0, 1, 2)
 */
export async function generateSpellCreate(params: CreateParams): Promise<CreateResult> {
    const { prompt, appVersion, signal, onProgress } = params;
    const spellModel = await getPreferredModel('SPELL_S');
    let lastError: unknown;

    for (let attempt = 0; attempt <= 2; attempt++) {
        try {
            if (attempt > 0) {
                console.warn(`[generateSpellCreate] retry attempt ${attempt}`);
            }
            const usage = emptyUsage();

            const callModel = (content: string, sysInstr: string): Promise<ChatResponse> =>
                raceTimeout(
                    withRetry(async retryAttempt => {
                        // Bypass OpenRouter's prompt cache on any retry (outer
                        // loop or inner withRetry). A cached response that was
                        // already empty/truncated/tool_calls-only would just
                        // re-serve itself and defeat the retry.
                        const noCache = attempt > 0 || retryAttempt > 0;
                        const messages = [makeSystemContent(sysInstr), makeUserContent(content)];
                        let res: ChatResponse;
                        try {
                            res = await openrouterChat({
                                model: spellModel,
                                messages,
                                ...OR_REASONING_HIGH,
                                ...OR_WEB_SEARCH,
                                max_tokens: SPELL_MAX_TOKENS,
                                noCache,
                                signal,
                            });
                        } catch (err) {
                            // Reproduzido em scripts/repro-deepseek-500.ts: DeepSeek V4
                            // Flash devolve 500 upstream quando o plugin `web` viaja
                            // junto com payload grande. Como planear/coder HTML não
                            // precisa de web search, cair pra sem-plugin.
                            if (err instanceof OpenRouterError && (err.status ?? 0) >= 500) {
                                console.warn('[generateSpellCreate.callModel] Upstream 5xx com web plugin; retry sem web');
                                res = await openrouterChat({
                                    model: spellModel,
                                    messages,
                                    ...OR_REASONING_HIGH,
                                    max_tokens: SPELL_MAX_TOKENS,
                                    noCache: true,
                                    signal,
                                });
                            } else {
                                throw err;
                            }
                        }
                        if (extractText(res)) return res;
                        const reason = res.choices?.[0]?.finish_reason ?? 'unknown';
                        if (reason === 'tool_calls') {
                            const retry = await openrouterChat({
                                model: spellModel,
                                messages,
                                ...OR_REASONING_HIGH,
                                max_tokens: SPELL_MAX_TOKENS,
                                noCache: true,
                                signal,
                            });
                            if (extractText(retry)) return retry;
                        }
                        throw makeRetryableEmptyResponseError(reason);
                    }),
                );

            // Stage 1: Planning
            onProgress?.({ type: 'plan_started' });
            const plannerSys = buildPlannerSystemInstructions(appVersion, ALL_CAPABILITIES);
            const planResult = await callModel(
                `${UNIFIED_CREATE_PLANNER_PROMPT}\n\nUser Request: ${prompt}`,
                plannerSys,
            );
            accUsage(usage, planResult);
            const appPlan = extractJson(extractText(planResult));
            onProgress?.({ type: 'plan_completed', planSummary: appPlan?.appName });

            // Stage 2: Coding
            onProgress?.({ type: 'code_started' });
            const selectedCaps = getCapabilitiesByApiNames(
                (appPlan?.technicalRequirements?.apis ?? []).map((a: any) => a.name),
                appVersion,
                ALL_CAPABILITIES,
            );
            const coderSys = buildSystemInstructions(appVersion, selectedCaps);
            const codeResult = await callModel(
                `${UNIFIED_CREATE_CODE_PROMPT}\n\n--- APP PLAN ---\n${JSON.stringify(appPlan, null, 2)}`,
                coderSys,
            );
            accUsage(usage, codeResult);

            let html = fixCallbackPatterns(extractHtml(extractText(codeResult)));
            if (!html) throw new Error('AI returned empty response');
            onProgress?.({ type: 'code_completed' });

            // Validation (first pass)
            const initErrors: ValidationError[] = [
                ...validateGeneratedCode(html).errors,
                ...validateWithExecution(html).errors,
            ];

            // Fix loop — up to 2 attempts
            let currentHtml = html;
            let currentErrors = initErrors;

            for (
                let fixAttempt = 0;
                fixAttempt < 2 &&
                currentErrors.length > 0 &&
                currentErrors.some(e => e.fixable);
                fixAttempt++
            ) {
                onProgress?.({
                    type: 'validation_failed',
                    attempt: fixAttempt,
                    errorCount: currentErrors.length,
                });
                onProgress?.({ type: 'fix_started', attempt: fixAttempt });
                const fixResult = await callModel(
                    generateFixPrompt(currentErrors, currentHtml),
                    coderSys,
                );
                accUsage(usage, fixResult);
                currentHtml = fixCallbackPatterns(extractHtml(extractText(fixResult)));
                if (!currentHtml) throw new Error('AI returned empty response after fix');
                currentErrors = [
                    ...validateGeneratedCode(currentHtml).errors,
                    ...validateWithExecution(currentHtml).errors,
                ];
            }

            if (currentErrors.length > 0) {
                throw new Error(`App generation failed: ${currentErrors[0]?.message}`);
            }
            html = currentHtml;

            const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
            const costUsd = resolveCostUsd(usage, spellModel);
            onProgress?.({ type: 'completed' });
            return {
                html,
                usage,
                costUsd,
                appName: titleMatch?.[1]?.trim(),
                initialValidationErrors: initErrors,
            };
        } catch (err) {
            lastError = err;
            if (attempt < 2) {
                console.warn(
                    `[generateSpellCreate] attempt ${attempt + 1} failed, retrying...`,
                    err,
                );
            }
        }
    }
    throw lastError;
}

// ============================================================
// generateSpellEdit
// ============================================================

export interface PreviousEdit {
    version: number;
    instruction: string;
}

export interface StorageKey {
    key: string;
    schema: unknown;
}

export interface EditParams {
    currentCode: string;
    instruction: string;
    appVersion: string;
    previousEdits?: PreviousEdit[];
    selectedContext?: string;
    storageStructure?: StorageKey[];
    signal?: AbortSignal;
    onProgress?: (e: ProgressEvent) => void;
}

export interface EditResult {
    html: string;
    usage: GenerationUsage;
    costUsd: number;
    initialValidationErrors: ValidationError[];
}

/**
 * Two-stage edit. Mirrors server's `generateSpellEdit`:
 *   1. `UNIFIED_EDIT_PLANNER_PROMPT` → JSON patch plan
 *   2. `UNIFIED_EDIT_MIGRATE_PROMPT` → JSON `changes` array of patches
 *   3. Apply patches → validate → 1 fix iteration
 *   4. Guardrail: refuses renames/removals of existing localStorage keys via
 *      the warning embedded in the prompt.
 */
export async function generateSpellEdit(params: EditParams): Promise<EditResult> {
    const {
        currentCode,
        instruction,
        appVersion,
        previousEdits,
        selectedContext,
        storageStructure,
        signal,
        onProgress,
    } = params;

    // Pre-compute inputs that don't change between retries
    let rawCode = currentCode;
    if (rawCode && !rawCode.trimStart().startsWith('<')) {
        const recovered = extractHtml(rawCode);
        if (recovered?.trimStart().startsWith('<')) rawCode = recovered;
    }
    const normalizedCode = rawCode.replace(/\r\n/g, '\n');
    const numberedCode = normalizedCode
        .split('\n')
        .map((l, i) => `${i + 1}| ${l}`)
        .join('\n');

    const historyContext = previousEdits?.length
        ? `\nPrevious edits:\n${previousEdits.map(e => `- v${e.version}: ${e.instruction}`).join('\n')}\n`
        : '';
    const selectionPart = selectedContext
        ? `\nSelected code:\n"""\n${selectedContext}\n"""\n`
        : '';
    const storageKeysPart = storageStructure?.length
        ? `\n⚠️ STORAGE STRUCTURE GUARDRAIL: This spell already has user data persisted in localStorage. You MUST NOT rename keys, remove keys, or change data types — doing so causes permanent data loss:\n${storageStructure.map(s => `- localStorage["${s.key}"]: ${JSON.stringify(s.schema)}`).join('\n')}\n`
        : '';

    const editPlannerSys = buildPlannerSystemInstructions(appVersion, ALL_CAPABILITIES);
    const editPatcherSys = buildSystemInstructions(appVersion, ALL_CAPABILITIES);
    const spellModel = await getPreferredModel('SPELL_S');

    let lastError: unknown;
    for (let attempt = 0; attempt <= 2; attempt++) {
        try {
            if (attempt > 0) {
                console.warn(`[generateSpellEdit] retry attempt ${attempt}`);
            }
            const usage = emptyUsage();

            const callEditModel = (content: string, sysInstr: string): Promise<ChatResponse> =>
                raceTimeout(
                    withRetry(async retryAttempt => {
                        const noCache = attempt > 0 || retryAttempt > 0;
                        const messages = [makeSystemContent(sysInstr), makeUserContent(content)];
                        let res: ChatResponse;
                        try {
                            res = await openrouterChat({
                                model: spellModel,
                                messages,
                                ...OR_REASONING_HIGH,
                                ...OR_WEB_SEARCH,
                                max_tokens: SPELL_MAX_TOKENS,
                                noCache,
                                signal,
                            });
                        } catch (err) {
                            if (err instanceof OpenRouterError && (err.status ?? 0) >= 500) {
                                console.warn('[generateSpellEdit.callEditModel] Upstream 5xx com web plugin; retry sem web');
                                res = await openrouterChat({
                                    model: spellModel,
                                    messages,
                                    ...OR_REASONING_HIGH,
                                    max_tokens: SPELL_MAX_TOKENS,
                                    noCache: true,
                                    signal,
                                });
                            } else {
                                throw err;
                            }
                        }
                        if (extractText(res)) return res;
                        const reason = res.choices?.[0]?.finish_reason ?? 'unknown';
                        if (reason === 'tool_calls') {
                            const retry = await openrouterChat({
                                model: spellModel,
                                messages,
                                ...OR_REASONING_HIGH,
                                max_tokens: SPELL_MAX_TOKENS,
                                noCache: true,
                                signal,
                            });
                            if (extractText(retry)) return retry;
                        }
                        throw makeRetryableEmptyResponseError(reason);
                    }),
                );

            // Stage 1: Plan
            onProgress?.({ type: 'plan_started' });
            const planPrompt = `${UNIFIED_EDIT_PLANNER_PROMPT}\n\nUser's edit request: ${instruction}${historyContext}${selectionPart}${storageKeysPart}\n\nFull code:\n\`\`\`html\n${numberedCode}\n\`\`\``;
            const planResult = await callEditModel(planPrompt, editPlannerSys);
            accUsage(usage, planResult);
            const editPlan = extractJson(extractText(planResult));
            onProgress?.({ type: 'plan_completed' });

            // Stage 2: Patch
            onProgress?.({ type: 'code_started' });
            const patchPrompt = `${UNIFIED_EDIT_MIGRATE_PROMPT}\n\n--- EDIT PLAN ---\n${JSON.stringify(editPlan, null, 2)}\n\n--- CODE CONTEXT ---\n\`\`\`html\n${numberedCode}\n\`\`\``;
            const patchResult = await callEditModel(patchPrompt, editPatcherSys);
            accUsage(usage, patchResult);
            const patchResponse = extractJson(extractText(patchResult));

            let html = fixCallbackPatterns(
                applyPatches(normalizedCode, patchResponse?.changes ?? []),
            );
            onProgress?.({ type: 'code_completed' });

            // Validation (first pass)
            const initErrors: ValidationError[] = [
                ...validateGeneratedCode(html).errors,
                ...validateWithExecution(html).errors,
            ];

            // Fix loop — 1 iteration (mirrors server's production behaviour)
            if (initErrors.length > 0 && initErrors.some(e => e.fixable)) {
                onProgress?.({
                    type: 'validation_failed',
                    attempt: 0,
                    errorCount: initErrors.length,
                });
                onProgress?.({ type: 'fix_started', attempt: 0 });
                const fixResult = await callEditModel(
                    generateFixPrompt(initErrors, html),
                    'Follow instructions and fix these errors in the code',
                );
                accUsage(usage, fixResult);
                html = fixCallbackPatterns(extractHtml(extractText(fixResult)));
                if (!html) throw new Error('AI returned empty response after fix');
                const afterErrors = [
                    ...validateGeneratedCode(html).errors,
                    ...validateWithExecution(html).errors,
                ];
                if (afterErrors.length > 0) {
                    throw new Error(`Edit failed: ${afterErrors[0]?.message}`);
                }
            } else if (initErrors.length > 0) {
                throw new Error(`Edit failed: ${initErrors[0]?.message}`);
            }

            const costUsd = resolveCostUsd(usage, spellModel);
            onProgress?.({ type: 'completed' });
            return { html, usage, costUsd, initialValidationErrors: initErrors };
        } catch (err) {
            lastError = err;
            if (attempt < 2) {
                console.warn(
                    `[generateSpellEdit] attempt ${attempt + 1} failed, retrying...`,
                    err,
                );
            }
        }
    }
    throw lastError;
}

// ============================================================
// generateConvert
// ============================================================

export interface ConvertParams {
    sourceCode: string;
    frameworkHint?: string;
    appVersion: string;
    signal?: AbortSignal;
}

export interface ConvertResult {
    html: string;
    usage: GenerationUsage;
    costUsd: number;
}

/** One-shot React/Node → standalone HTML conversion. */
export async function generateConvert(params: ConvertParams): Promise<ConvertResult> {
    const { sourceCode, frameworkHint, appVersion, signal } = params;
    const usage = emptyUsage();
    const sys = buildSystemInstructions(appVersion, ALL_CAPABILITIES);
    const spellModel = await getPreferredModel('SPELL_S');

    const userMsg = `${CONVERT_PROJECT_PROMPT}\n\n--- SOURCE${frameworkHint ? ` (${frameworkHint})` : ''} ---\n\`\`\`\n${sourceCode}\n\`\`\``;

    const result = await raceTimeout(
        withRetry(async () => {
            const res = await openrouterChat({
                model: spellModel,
                messages: [makeSystemContent(sys), makeUserContent(userMsg)],
                ...OR_REASONING_HIGH,
                signal,
            });
            if (!extractText(res)) {
                throw makeRetryableEmptyResponseError(
                    res.choices?.[0]?.finish_reason ?? 'unknown',
                );
            }
            return res;
        }),
    );
    accUsage(usage, result);

    const html = fixCallbackPatterns(extractHtml(extractText(result)));
    if (!html) throw new Error('AI returned empty response');
    const costUsd = resolveCostUsd(usage, spellModel);
    return { html, usage, costUsd };
}

// ============================================================
// generateWebviewAI (text generation called from inside a spell)
// ============================================================

export interface WebviewAIParams {
    prompt: string;
    schema?: Record<string, unknown>;
    images?: string[];
    audios?: string[];
    useSearch?: boolean;
    requestedModel?: string;
    requestedTools?: string[];
    signal?: AbortSignal;
}

export interface WebviewAIResult {
    text: string;
    usage: GenerationUsage;
    searchQueriesUsed: number;
    costUsd: number;
}

function inferSchema(data: any): any {
    if (data === null || data === undefined) return { type: 'string' };
    if (typeof data === 'string') return { type: 'string' };
    if (typeof data === 'number') {
        return Number.isInteger(data) ? { type: 'integer' } : { type: 'number' };
    }
    if (typeof data === 'boolean') return { type: 'boolean' };
    if (Array.isArray(data)) {
        return {
            type: 'array',
            items: data.length > 0 ? inferSchema(data[0]) : { type: 'string' },
        };
    }
    if (typeof data === 'object') {
        const properties: any = {};
        const required: string[] = [];
        Object.keys(data).forEach(key => {
            properties[key] = inferSchema(data[key]);
            required.push(key);
        });
        return { type: 'object', properties, required };
    }
    return { type: 'string' };
}

// OpenRouter strict json_schema requires additionalProperties:false and complete required[] on every object.
function normalizeSchemaForStrictMode(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;
    if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
        if (schema.additionalProperties === undefined) schema.additionalProperties = false;
        if (!Array.isArray(schema.required) || schema.required.length === 0) {
            schema.required = Object.keys(schema.properties);
        }
        Object.keys(schema.properties).forEach(k => normalizeSchemaForStrictMode(schema.properties[k]));
    }
    if (schema.type === 'array' && schema.items) normalizeSchemaForStrictMode(schema.items);
    return schema;
}

export async function generateWebviewAI(params: WebviewAIParams): Promise<WebviewAIResult> {
    const {
        prompt,
        schema,
        images,
        audios,
        useSearch,
        requestedModel,
        requestedTools,
        signal,
    } = params;

    let tools = requestedTools ?? [];
    if (useSearch && !tools.includes('googleSearch')) tools = [...tools, 'googleSearch'];
    const useWebSearch = tools.includes('googleSearch') || tools.includes('googleMaps');
    const effectiveModel = requestedModel ?? (await getPreferredModel('WEBVIEW'));

    const userContent: Array<{ type: string; [key: string]: unknown }> = [
        { type: 'text', text: prompt },
    ];
    if (images?.length) {
        for (const img of images) {
            userContent.push({
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${img}` },
            });
        }
    }
    if (audios?.length) {
        for (const aud of audios) {
            userContent.push({
                type: 'input_audio',
                input_audio: { data: aud, format: detectAudioFormat(aud) },
            });
        }
    }

    const resolvedSchema = schema
        ? !(schema as any).type
            ? inferSchema(schema)
            : schema
        : undefined;

    const messages: ChatMessage[] = [];
    const sContent =
        'Do exactly what the user asks for. Do not add any extra information or explanations.';
    if (useWebSearch) {
        messages.push(
            makeSystemContent(
                sContent +
                    '\n\nYou have access to web search and web fetch. Use web_search to find relevant links and web_fetch to read the full content of documentation or specific pages when needed for accuracy.',
            ),
        );
    }
    messages.push({ role: 'user', content: userContent });

    const result = await withRetry(() =>
        openrouterChat({
            model: effectiveModel,
            messages,
            max_tokens: 65536,
            noCache: true,
            ...OR_REASONING_HIGH,
            ...(useWebSearch ? OR_WEB_SEARCH : {}),
            ...(resolvedSchema
                ? {
                      extra: {
                          response_format: {
                              type: 'json_schema',
                              json_schema: {
                                  name: 'response',
                                  schema: normalizeSchemaForStrictMode(resolvedSchema) as any,
                                  strict: true,
                              },
                          },
                          provider: { require_parameters: true },
                      },
                  }
                : {}),
            signal,
        }),
    );

    const usage = emptyUsage();
    accUsage(usage, result);

    let text = extractText(result);

    if (schema && text) {
        try {
            text = JSON.stringify(extractJson(text));
        } catch (e: any) {
            const snippet = text.length > 200 ? text.substring(0, 200) + '...' : text;
            throw new Error(`JSON Extraction Failed: ${e.message} | Raw: ${snippet}`);
        }
    }

    if (!text) throw new Error('AI returned empty response');

    // Best-effort: OpenRouter doesn't expose web-search request count today, so
    // we approximate. The server used the same approximation.
    const searchQueriesUsed = useWebSearch ? 1 : 0;
    const reportedCost = (result.usage as any)?.cost;
    const costUsd =
        typeof reportedCost === 'number' && reportedCost > 0
            ? reportedCost
            : calculateCostUsd(effectiveModel, usage, { searchQueries: searchQueriesUsed });

    return { text, usage, searchQueriesUsed, costUsd };
}
