import OpenAI from 'openai';
import { MODELS, OR_REASONING_HIGH, OR_WEB_SEARCH } from './config';

const TIMEOUT_MS = 480_000;
import {
    UNIFIED_CREATE_PLANNER_PROMPT,
    UNIFIED_CREATE_CODE_PROMPT,
    UNIFIED_EDIT_PLANNER_PROMPT,
    UNIFIED_EDIT_MIGRATE_PROMPT,
} from './prompts';
import { buildSystemInstructions, ALL_CAPABILITIES } from './capabilities/index';
import { buildPlannerSystemInstructions, getCapabilitiesByApiNames } from './capabilities/helpers';
import {
    extractHtml,
    extractJson,
    extractText,
    fixCallbackPatterns,
    applyPatches,
    withRetry,
    getUsage,
    calculateCostUsd,
    sanitizeForFirestore,
    MANA_VALUE_USD,
} from './utils';
import { validateGeneratedCode, generateFixPrompt, ValidationError } from './codeValidator';
import { validateWithExecution } from './executionValidator';

// ============================================================
// Shared types
// ============================================================

export interface GenerationUsage {
    promptTokens: number;
    responseTokens: number;
    thoughtsTokens: number;
    totalTokens: number;
    cachedTokens: number;
}

function emptyUsage(): GenerationUsage {
    return { promptTokens: 0, responseTokens: 0, thoughtsTokens: 0, totalTokens: 0, cachedTokens: 0 };
}

function accUsage(acc: GenerationUsage, result: any): void {
    const u = getUsage(result);
    acc.promptTokens += u.promptTokens;
    acc.responseTokens += u.responseTokens;
    acc.thoughtsTokens += u.thoughtsTokens;
    acc.totalTokens += u.totalTokens;
    acc.cachedTokens += result.usage?.prompt_tokens_details?.cached_tokens
        || result.usageMetadata?.cachedContentTokenCount || 0;
}

// Race a generation call against the global timeout
async function raceTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`AI Generation Timeout (${TIMEOUT_MS / 1000}s)`)), TIMEOUT_MS)
    );
    return Promise.race([promise, timeout]);
}

// ============================================================
// generateSpellCreate
// ============================================================

export interface CreateResult {
    html: string;
    usage: GenerationUsage;
    appName?: string;
    /** Validation errors found before the fix loop ran. Empty = first-pass was valid. */
    initialValidationErrors: ValidationError[];
}

export async function generateSpellCreate(
    prompt: string,
    appVersion: string,
    or: OpenAI,
): Promise<CreateResult> {
    const usage = emptyUsage();

    const callModel = (content: string, sysInstr: string) =>
        raceTimeout(withRetry(async () => {
            const res = await or.chat.completions.create({
                model: MODELS.SPELL_S,
                messages: [{ role: 'system', content: sysInstr }, { role: 'user', content: content }],
                ...OR_REASONING_HIGH,
                ...OR_WEB_SEARCH,
            });
            if (!extractText(res)) throw new Error(`Empty AI response (finish_reason: ${res.choices?.[0]?.finish_reason ?? 'unknown'})`);
            return res;
        }));

    // Stage 1: Planning
    const plannerSys = buildPlannerSystemInstructions(appVersion, ALL_CAPABILITIES);
    const planResult = await callModel(`${UNIFIED_CREATE_PLANNER_PROMPT}\n\nUser Request: ${prompt}`, plannerSys);
    accUsage(usage, planResult);
    const appPlan = extractJson(extractText(planResult));

    // Stage 2: Coding
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

    // Validation (first pass)
    const initErrors = [
        ...validateGeneratedCode(html).errors,
        ...validateWithExecution(html).errors,
    ];

    // Fix loop — up to 2 attempts
    let currentHtml = html;
    let currentErrors = initErrors;

    for (let attempt = 0; attempt < 2 && currentErrors.length > 0 && currentErrors.some(e => e.fixable); attempt++) {
        const fixResult = await callModel(generateFixPrompt(currentErrors, currentHtml), coderSys);
        accUsage(usage, fixResult);
        currentHtml = fixCallbackPatterns(extractHtml(extractText(fixResult)));
        if (!currentHtml) throw new Error('AI returned empty response after fix');
        currentErrors = [
            ...validateGeneratedCode(currentHtml).errors,
            ...validateWithExecution(currentHtml).errors,
        ];
    }

    if (currentErrors.length > 0) throw new Error(`App generation failed: ${currentErrors[0]?.message}`);
    html = currentHtml;

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return { html, usage, appName: titleMatch?.[1]?.trim(), initialValidationErrors: initErrors };
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
    previousEdits?: PreviousEdit[];
    selectedContext?: string;
    storageStructure?: StorageKey[];
}

export interface EditResult {
    html: string;
    usage: GenerationUsage;
    /** Validation errors found before the fix loop ran. Empty = first-pass was valid. */
    initialValidationErrors: ValidationError[];
}

export async function generateSpellEdit(
    params: EditParams,
    appVersion: string,
    or: OpenAI,
): Promise<EditResult> {
    const { currentCode, instruction, previousEdits, selectedContext, storageStructure } = params;
    const usage = emptyUsage();

    // Self-heal corrupted code (mirrors production behaviour)
    let rawCode = currentCode;
    if (rawCode && !rawCode.trimStart().startsWith('<')) {
        const recovered = extractHtml(rawCode);
        if (recovered?.trimStart().startsWith('<')) rawCode = recovered;
    }
    const normalizedCode = rawCode.replace(/\r\n/g, '\n');
    const numberedCode = normalizedCode.split('\n').map((l, i) => `${i + 1}| ${l}`).join('\n');

    const historyContext = previousEdits?.length
        ? `\nPrevious edits:\n${previousEdits.map(e => `- v${e.version}: ${e.instruction}`).join('\n')}\n`
        : '';
    const selectionPart = selectedContext ? `\nSelected code:\n"""\n${selectedContext}\n"""\n` : '';
    const storageKeysPart = storageStructure?.length
        ? `\n⚠️ STORAGE STRUCTURE GUARDRAIL: This spell already has user data persisted in localStorage. You MUST NOT rename keys, remove keys, or change data types — doing so causes permanent data loss:\n${storageStructure.map(s => `- localStorage["${s.key}"]: ${JSON.stringify(s.schema)}`).join('\n')}\n`
        : '';

    const editPlannerSys = buildPlannerSystemInstructions(appVersion, ALL_CAPABILITIES);
    const editPatcherSys = buildSystemInstructions(appVersion, ALL_CAPABILITIES);

    const callEditModel = (content: string, sysInstr: string) =>
        raceTimeout(withRetry(async () => {
            const res = await or.chat.completions.create({
                model: MODELS.SPELL_S,
                messages: [{ role: 'system', content: sysInstr }, { role: 'user', content: content }],
                ...OR_REASONING_HIGH,
                ...OR_WEB_SEARCH,
            });
            if (!extractText(res)) throw new Error(`Empty AI response (finish_reason: ${res.choices?.[0]?.finish_reason ?? 'unknown'})`);
            return res;
        }));

    // Stage 1: Plan
    const planPrompt = `${UNIFIED_EDIT_PLANNER_PROMPT}\n\nUser's edit request: ${instruction}${historyContext}${selectionPart}${storageKeysPart}\n\nFull code:\n\`\`\`html\n${numberedCode}\n\`\`\``;
    const planResult = await callEditModel(planPrompt, editPlannerSys);
    accUsage(usage, planResult);
    const editPlan = extractJson(extractText(planResult));

    // Stage 2: Patch
    const patchPrompt = `${UNIFIED_EDIT_MIGRATE_PROMPT}\n\n--- EDIT PLAN ---\n${JSON.stringify(editPlan, null, 2)}\n\n--- CODE CONTEXT ---\n\`\`\`html\n${numberedCode}\n\`\`\``;
    const patchResult = await callEditModel(patchPrompt, editPatcherSys);
    accUsage(usage, patchResult);
    const patchResponse = extractJson(extractText(patchResult));

    let html = fixCallbackPatterns(applyPatches(normalizedCode, patchResponse?.changes ?? []));

    // Validation (first pass)
    const initErrors = [
        ...validateGeneratedCode(html).errors,
        ...validateWithExecution(html).errors,
    ];

    // Fix loop (mirrors production behaviour)
    if (initErrors.length > 0 && initErrors.some(e => e.fixable)) {
        const fixResult = await callEditModel(generateFixPrompt(initErrors, html), "Follow instructions and fix these errors in the code");
        accUsage(usage, fixResult);
        html = fixCallbackPatterns(extractHtml(extractText(fixResult)));
        if (!html) throw new Error('AI returned empty response after fix');
        const afterErrors = [
            ...validateGeneratedCode(html).errors,
            ...validateWithExecution(html).errors,
        ];
        if (afterErrors.length > 0) throw new Error(`Edit failed: ${afterErrors[0]?.message}`);
    } else if (initErrors.length > 0) {
        throw new Error(`Edit failed: ${initErrors[0]?.message}`);
    }

    return { html, usage, initialValidationErrors: initErrors };
}

// ============================================================
// generateWebviewAI
// ============================================================

export interface WebviewAIParams {
    prompt: string;
    schema?: Record<string, unknown>;
    images?: string[];   // base64 strings (no data URI prefix)
    audios?: string[];   // base64 WAV strings
    useSearch?: boolean;
    requestedModel?: string;
    requestedTools?: string[];
}

export interface WebviewAIResult {
    text: string;
    usage: GenerationUsage;
    searchQueriesUsed: number;
    creditsUsed: number;
}

function inferSchema(data: any): any {
    if (data === null || data === undefined) return { type: 'string' };
    if (typeof data === 'string') return { type: 'string' };
    if (typeof data === 'number') return Number.isInteger(data) ? { type: 'integer' } : { type: 'number' };
    if (typeof data === 'boolean') return { type: 'boolean' };
    if (Array.isArray(data)) return { type: 'array', items: data.length > 0 ? inferSchema(data[0]) : { type: 'string' } };
    if (typeof data === 'object') {
        const properties: any = {};
        const required: string[] = [];
        Object.keys(data).forEach(key => { properties[key] = inferSchema(data[key]); required.push(key); });
        return { type: 'object', properties, required };
    }
    return { type: 'string' };
}

export async function generateWebviewAI(
    params: WebviewAIParams,
    or: OpenAI,
): Promise<WebviewAIResult> {
    const { prompt, schema, images, audios, useSearch, requestedModel, requestedTools } = params;

    let tools = requestedTools ?? [];
    if (useSearch && !tools.includes('googleSearch')) tools = [...tools, 'googleSearch'];
    const useWebSearch = tools.includes('googleSearch') || tools.includes('googleMaps');
    const effectiveModel = requestedModel ?? MODELS.WEBVIEW;

    const userContent: any[] = [{ type: 'text', text: prompt }];
    if (images?.length) {
        for (const img of images) {
            userContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } });
        }
    }
    if (audios?.length) {
        for (const aud of audios) {
            userContent.push({ type: 'input_audio', input_audio: { data: aud, format: 'wav' } });
        }
    }

    const resolvedSchema = schema
        ? (!(schema as any).type ? inferSchema(schema) : schema)
        : undefined;

    const messages: any[] = [];
    const sContent: string = 'Do exactly what the user asks for. Do not add any extra information or explanations.'
    if (useWebSearch) {
        messages.push({
            role: 'system',
            content: sContent + '\n\nYou have access to web search and web fetch. Use web_search to find relevant links and web_fetch to read the full content of documentation or specific pages when needed for accuracy.'
        });
    }
    messages.push({ role: 'user', content: userContent });

    const result = await withRetry(() => or.chat.completions.create({
        model: effectiveModel,
        messages,
        max_tokens: 65536,
        ...OR_REASONING_HIGH,
        ...(useWebSearch ? OR_WEB_SEARCH : {}),
        ...(resolvedSchema ? {
            response_format: {
                type: 'json_schema',
                json_schema: { name: 'response', schema: resolvedSchema as any, strict: false },
            },
        } : {}),
    }));

    const rawUsage = sanitizeForFirestore(getUsage(result));
    const usage: GenerationUsage = {
        promptTokens: rawUsage.promptTokens ?? 0,
        responseTokens: rawUsage.responseTokens ?? 0,
        thoughtsTokens: rawUsage.thoughtsTokens ?? 0,
        totalTokens: rawUsage.totalTokens ?? 0,
        cachedTokens: (result as any).usage?.prompt_tokens_details?.cached_tokens ?? 0,
    };

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

    const searchQueriesUsed = rawUsage.webSearchRequests ?? (useWebSearch ? 1 : 0);
    const creditsUsed = calculateCostUsd(effectiveModel, usage, { searchQueries: searchQueriesUsed }) / MANA_VALUE_USD;

    return { text, usage, searchQueriesUsed, creditsUsed };
}
