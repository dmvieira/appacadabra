/**
 * State-machine view of the generator pipeline.
 *
 * Phase 2 background execution (iOS URLSession-bg + Android WorkManager
 * fallback) needs the pipeline to survive process death. That rules out the
 * `await`-chain used by `generateSpellCreate`/`generateSpellEdit` — a killed
 * process loses continuation state and would have to restart from the
 * planner stage, wasting reasoning tokens and user wall-clock time.
 *
 * This module reifies the pipeline as an explicit state machine:
 *
 *   initState → nextStage → nextStage → … → complete | error
 *
 * Each `nextStage` call does **exactly one HTTP round-trip** (or zero, for
 * pure validation) and returns a serializable state object. Callers persist
 * the state to `pending_jobs` between stages so a relaunched process can
 * resume mid-pipeline instead of starting over.
 *
 * `driveInProcess()` composes them for the Android FGS / in-process path;
 * the Swift URLSession-bg driver (added later in Phase 2) will drive the
 * same stages via native HTTP calls.
 *
 * IMPORTANT: prompts, models, reasoning effort, fix-loop budget, and outer
 * retry budget must match `generators.ts` byte-for-byte. If the two drift,
 * behaviour will differ between foreground and backgrounded generation.
 */
import { chat as openrouterChat, OpenRouterError, type ChatResponse, type ChatMessage } from './openrouter';
import { OR_REASONING_HIGH, OR_WEB_SEARCH, calculateCostUsd } from './pricing';
import { getPreferredModel } from './modelPreferences';
import {
    UNIFIED_CREATE_PLANNER_PROMPT,
    UNIFIED_CREATE_CODE_PROMPT,
    UNIFIED_EDIT_PLANNER_PROMPT,
    UNIFIED_EDIT_MIGRATE_PROMPT,
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

const GENERATION_TIMEOUT_MS = 480_000;

// Budgets must match generators.ts. Any change here without a matching change
// there produces different behaviour between the classic driver and the
// stage-machine driver — a silent regression the tests won't catch.
export const MAX_OUTER_ATTEMPTS = 3;
export const CREATE_FIX_BUDGET = 2;
export const EDIT_FIX_BUDGET = 1;

// Explicit output cap for the spell pipeline. DeepSeek V4 Flash with
// `reasoning: high` burns a large thinking budget before emitting content;
// without an explicit `max_tokens` the model can be cut off mid-response
// (surfacing as `AI response was truncated (depth: N, inString: …)` from
// `extractJson`). 32k leaves generous room for reasoning + full HTML output.
export const SPELL_MAX_TOKENS = 32_000;

// ------------------------------------------------------------
// State types
// ------------------------------------------------------------

export type CreateStage = 'planner' | 'coder' | 'validate' | 'fix' | 'complete';
export type EditStage = 'planner' | 'patch' | 'validate' | 'fix' | 'complete';

export interface CreateJobState {
    kind: 'create';
    prompt: string;
    appVersion: string;
    // Snapshot of the user's SPELL_S preference at job creation. Persisted
    // with the job so a resumed background run uses the same model even if
    // the user changed the preference mid-generation.
    spellModel: string;
    outerAttempt: number;
    stage: CreateStage;
    fixAttempt: number;
    plan: unknown | null;
    html: string | null;
    initialErrors: ValidationError[];
    lastErrors: ValidationError[];
    usage: GenerationUsage;
}

export interface EditJobState {
    kind: 'edit';
    instruction: string;
    appVersion: string;
    spellModel: string;
    normalizedCode: string;
    numberedCode: string;
    historyContext: string;
    selectionPart: string;
    storageKeysPart: string;
    outerAttempt: number;
    stage: EditStage;
    fixAttempt: number;
    plan: unknown | null;
    html: string | null;
    initialErrors: ValidationError[];
    lastErrors: ValidationError[];
    usage: GenerationUsage;
}

export interface CompleteResult {
    kind: 'create' | 'edit';
    html: string;
    usage: GenerationUsage;
    costUsd: number;
    appName?: string;
    initialValidationErrors: ValidationError[];
}

export type StageOutcome<S> =
    | { done: false; state: S }
    | { done: true; result: CompleteResult };

// ------------------------------------------------------------
// State constructors
// ------------------------------------------------------------

export async function initCreateState(params: { prompt: string; appVersion: string }): Promise<CreateJobState> {
    return {
        kind: 'create',
        prompt: params.prompt,
        appVersion: params.appVersion,
        spellModel: await getPreferredModel('SPELL_S'),
        outerAttempt: 0,
        stage: 'planner',
        fixAttempt: 0,
        plan: null,
        html: null,
        initialErrors: [],
        lastErrors: [],
        usage: emptyUsage(),
    };
}

export interface InitEditParams {
    currentCode: string;
    instruction: string;
    appVersion: string;
    previousEdits?: { version: number; instruction: string }[];
    selectedContext?: string;
    storageStructure?: { key: string; schema: unknown }[];
}

export async function initEditState(params: InitEditParams): Promise<EditJobState> {
    let rawCode = params.currentCode;
    if (rawCode && !rawCode.trimStart().startsWith('<')) {
        const recovered = extractHtml(rawCode);
        if (recovered?.trimStart().startsWith('<')) rawCode = recovered;
    }
    const normalizedCode = rawCode.replace(/\r\n/g, '\n');
    const numberedCode = normalizedCode
        .split('\n')
        .map((l, i) => `${i + 1}| ${l}`)
        .join('\n');

    const historyContext = params.previousEdits?.length
        ? `\nPrevious edits:\n${params.previousEdits.map(e => `- v${e.version}: ${e.instruction}`).join('\n')}\n`
        : '';
    const selectionPart = params.selectedContext
        ? `\nSelected code:\n"""\n${params.selectedContext}\n"""\n`
        : '';
    const storageKeysPart = params.storageStructure?.length
        ? `\n⚠️ STORAGE STRUCTURE GUARDRAIL: This spell already has user data persisted in localStorage. You MUST NOT rename keys, remove keys, or change data types — doing so causes permanent data loss:\n${params.storageStructure.map(s => `- localStorage["${s.key}"]: ${JSON.stringify(s.schema)}`).join('\n')}\n`
        : '';

    return {
        kind: 'edit',
        instruction: params.instruction,
        appVersion: params.appVersion,
        spellModel: await getPreferredModel('SPELL_S'),
        normalizedCode,
        numberedCode,
        historyContext,
        selectionPart,
        storageKeysPart,
        outerAttempt: 0,
        stage: 'planner',
        fixAttempt: 0,
        plan: null,
        html: null,
        initialErrors: [],
        lastErrors: [],
        usage: emptyUsage(),
    };
}

// ------------------------------------------------------------
// Shared HTTP helpers
// ------------------------------------------------------------

function makeUserContent(text: string): ChatMessage {
    return { role: 'user', content: text };
}

function makeSystemContent(text: string): ChatMessage {
    return { role: 'system', content: text };
}

async function raceTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeout = new Promise<never>((_, reject) =>
        setTimeout(
            () => reject(new Error(`AI Generation Timeout (${GENERATION_TIMEOUT_MS / 1000}s)`)),
            GENERATION_TIMEOUT_MS,
        ),
    );
    return Promise.race([promise, timeout]);
}

async function callModel(
    userContent: string,
    systemInstructions: string,
    outerAttempt: number,
    model: string,
    signal?: AbortSignal,
): Promise<ChatResponse> {
    return raceTimeout(
        withRetry(async retryAttempt => {
            // Bypass OpenRouter's prompt cache on any retry (outer driver loop
            // or inner withRetry). A cached response that was already empty /
            // truncated / tool_calls-only would just re-serve itself and defeat
            // the retry.
            const noCache = outerAttempt > 0 || retryAttempt > 0;
            const messages = [makeSystemContent(systemInstructions), makeUserContent(userContent)];
            let res: ChatResponse;
            try {
                res = await openrouterChat({
                    model,
                    messages,
                    ...OR_REASONING_HIGH,
                    ...OR_WEB_SEARCH,
                    max_tokens: SPELL_MAX_TOKENS,
                    noCache,
                    signal,
                });
            } catch (err) {
                // Reproduzido em scripts/repro-deepseek-500.ts: DeepSeek V4 Flash
                // devolve 500 upstream quando o plugin `web` viaja junto com
                // payload grande. Como planear/patchar HTML não precisa de web
                // search, cair pra sem-plugin em vez de estourar o withRetry todo.
                if (err instanceof OpenRouterError && (err.status ?? 0) >= 500) {
                    console.warn('[generatorStages.callModel] Upstream 5xx com web plugin; retry sem web');
                    res = await openrouterChat({
                        model,
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

            // Some reasoning models return empty content with
            // finish_reason='tool_calls' when the web plugin misfires (usually
            // when the model decides to call the plugin but its output never
            // gets threaded back). Retry once without the plugin — the
            // planner/patch/coder prompts don't actually need web search to
            // succeed, so this is a safe fallback.
            const reason = res.choices?.[0]?.finish_reason ?? 'unknown';
            if (reason === 'tool_calls') {
                const retry = await openrouterChat({
                    model,
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
}

function extractTitle(html: string): string | undefined {
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return m?.[1]?.trim();
}

function runValidation(html: string): ValidationError[] {
    return [
        ...validateGeneratedCode(html).errors,
        ...validateWithExecution(html).errors,
    ];
}

function resolveCostUsd(usage: GenerationUsage, modelId: string): number {
    // Same guard as WebView AI: prefer OpenRouter's reported cost when > 0,
    // fall back to per-token pricing otherwise. The reported figure already
    // accounts for web-search fees and provider-side discounts.
    return usage.reportedCostUsd > 0
        ? usage.reportedCostUsd
        : calculateCostUsd(modelId, usage);
}

function completeCreate(state: CreateJobState): CompleteResult {
    const html = state.html!;
    return {
        kind: 'create',
        html,
        usage: state.usage,
        costUsd: resolveCostUsd(state.usage, state.spellModel),
        appName: extractTitle(html),
        initialValidationErrors: state.initialErrors,
    };
}

function completeEdit(state: EditJobState): CompleteResult {
    const html = state.html!;
    return {
        kind: 'edit',
        html,
        usage: state.usage,
        costUsd: resolveCostUsd(state.usage, state.spellModel),
        initialValidationErrors: state.initialErrors,
    };
}

function resetCreateForRetry(state: CreateJobState): CreateJobState {
    return {
        ...state,
        outerAttempt: state.outerAttempt + 1,
        stage: 'planner',
        fixAttempt: 0,
        plan: null,
        html: null,
        initialErrors: [],
        lastErrors: [],
        usage: emptyUsage(),
    };
}

function resetEditForRetry(state: EditJobState): EditJobState {
    return {
        ...state,
        outerAttempt: state.outerAttempt + 1,
        stage: 'planner',
        fixAttempt: 0,
        plan: null,
        html: null,
        initialErrors: [],
        lastErrors: [],
        usage: emptyUsage(),
    };
}

// ------------------------------------------------------------
// Create pipeline — one stage per call
// ------------------------------------------------------------

export async function nextCreateStage(
    state: CreateJobState,
    opts?: { signal?: AbortSignal },
): Promise<StageOutcome<CreateJobState>> {
    switch (state.stage) {
        case 'planner': {
            const sys = buildPlannerSystemInstructions(state.appVersion, ALL_CAPABILITIES);
            const res = await callModel(
                `${UNIFIED_CREATE_PLANNER_PROMPT}\n\nUser Request: ${state.prompt}`,
                sys,
                state.outerAttempt,
                state.spellModel,
                opts?.signal,
            );
            const usage = { ...state.usage };
            accUsage(usage, res);
            const plan = extractJson(extractText(res));
            return {
                done: false,
                state: { ...state, stage: 'coder', plan, usage },
            };
        }

        case 'coder': {
            const selectedCaps = getCapabilitiesByApiNames(
                ((state.plan as any)?.technicalRequirements?.apis ?? []).map((a: any) => a.name),
                state.appVersion,
                ALL_CAPABILITIES,
            );
            const sys = buildSystemInstructions(state.appVersion, selectedCaps);
            const res = await callModel(
                `${UNIFIED_CREATE_CODE_PROMPT}\n\n--- APP PLAN ---\n${JSON.stringify(state.plan, null, 2)}`,
                sys,
                state.outerAttempt,
                state.spellModel,
                opts?.signal,
            );
            const usage = { ...state.usage };
            accUsage(usage, res);
            const html = fixCallbackPatterns(extractHtml(extractText(res)));
            if (!html) throw new Error('AI returned empty response');
            return {
                done: false,
                state: { ...state, stage: 'validate', html, usage },
            };
        }

        case 'validate': {
            const errors = runValidation(state.html!);
            const isFirstValidate = state.initialErrors.length === 0 && state.fixAttempt === 0;
            const initialErrors = isFirstValidate ? errors : state.initialErrors;

            if (errors.length === 0) {
                const done = { ...state, stage: 'complete' as const, initialErrors, lastErrors: [] };
                return { done: true, result: completeCreate(done) };
            }

            const hasFixable = errors.some(e => e.fixable);
            if (!hasFixable || state.fixAttempt >= CREATE_FIX_BUDGET) {
                // Throw to bubble up to the driver, which decides on outer
                // retry vs give-up. Matches generators.ts, where any error
                // (network, timeout, validation exhaustion) triggers the same
                // outer retry loop.
                throw new Error(`App generation failed: ${errors[0]?.message}`);
            }

            return {
                done: false,
                state: {
                    ...state,
                    stage: 'fix',
                    initialErrors,
                    lastErrors: errors,
                },
            };
        }

        case 'fix': {
            const selectedCaps = getCapabilitiesByApiNames(
                ((state.plan as any)?.technicalRequirements?.apis ?? []).map((a: any) => a.name),
                state.appVersion,
                ALL_CAPABILITIES,
            );
            const sys = buildSystemInstructions(state.appVersion, selectedCaps);
            const res = await callModel(
                generateFixPrompt(state.lastErrors, state.html!),
                sys,
                state.outerAttempt,
                state.spellModel,
                opts?.signal,
            );
            const usage = { ...state.usage };
            accUsage(usage, res);
            const html = fixCallbackPatterns(extractHtml(extractText(res)));
            if (!html) throw new Error('AI returned empty response after fix');
            return {
                done: false,
                state: {
                    ...state,
                    stage: 'validate',
                    html,
                    fixAttempt: state.fixAttempt + 1,
                    usage,
                },
            };
        }

        case 'complete':
            return { done: true, result: completeCreate(state) };
    }
}

// ------------------------------------------------------------
// Edit pipeline — one stage per call
// ------------------------------------------------------------

export async function nextEditStage(
    state: EditJobState,
    opts?: { signal?: AbortSignal },
): Promise<StageOutcome<EditJobState>> {
    switch (state.stage) {
        case 'planner': {
            const sys = buildPlannerSystemInstructions(state.appVersion, ALL_CAPABILITIES);
            const userMsg = `${UNIFIED_EDIT_PLANNER_PROMPT}\n\nUser's edit request: ${state.instruction}${state.historyContext}${state.selectionPart}${state.storageKeysPart}\n\nFull code:\n\`\`\`html\n${state.numberedCode}\n\`\`\``;
            const res = await callModel(userMsg, sys, state.outerAttempt, state.spellModel, opts?.signal);
            const usage = { ...state.usage };
            accUsage(usage, res);
            const plan = extractJson(extractText(res));
            return { done: false, state: { ...state, stage: 'patch', plan, usage } };
        }

        case 'patch': {
            const sys = buildSystemInstructions(state.appVersion, ALL_CAPABILITIES);
            const userMsg = `${UNIFIED_EDIT_MIGRATE_PROMPT}\n\n--- EDIT PLAN ---\n${JSON.stringify(state.plan, null, 2)}\n\n--- CODE CONTEXT ---\n\`\`\`html\n${state.numberedCode}\n\`\`\``;
            const res = await callModel(userMsg, sys, state.outerAttempt, state.spellModel, opts?.signal);
            const usage = { ...state.usage };
            accUsage(usage, res);
            const patchResponse = extractJson(extractText(res));
            const html = fixCallbackPatterns(
                applyPatches(state.normalizedCode, patchResponse?.changes ?? []),
            );
            return {
                done: false,
                state: { ...state, stage: 'validate', html, usage },
            };
        }

        case 'validate': {
            const errors = runValidation(state.html!);
            const isFirstValidate = state.initialErrors.length === 0 && state.fixAttempt === 0;
            const initialErrors = isFirstValidate ? errors : state.initialErrors;

            if (errors.length === 0) {
                const done = { ...state, stage: 'complete' as const, initialErrors, lastErrors: [] };
                return { done: true, result: completeEdit(done) };
            }

            const hasFixable = errors.some(e => e.fixable);
            if (!hasFixable || state.fixAttempt >= EDIT_FIX_BUDGET) {
                throw new Error(`Edit failed: ${errors[0]?.message}`);
            }

            return {
                done: false,
                state: {
                    ...state,
                    stage: 'fix',
                    initialErrors,
                    lastErrors: errors,
                },
            };
        }

        case 'fix': {
            const res = await callModel(
                generateFixPrompt(state.lastErrors, state.html!),
                'Follow instructions and fix these errors in the code',
                state.outerAttempt,
                state.spellModel,
                opts?.signal,
            );
            const usage = { ...state.usage };
            accUsage(usage, res);
            const html = fixCallbackPatterns(extractHtml(extractText(res)));
            if (!html) throw new Error('AI returned empty response after fix');
            return {
                done: false,
                state: {
                    ...state,
                    stage: 'validate',
                    html,
                    fixAttempt: state.fixAttempt + 1,
                    usage,
                },
            };
        }

        case 'complete':
            return { done: true, result: completeEdit(state) };
    }
}

// ------------------------------------------------------------
// Driver — used by the Android FGS / in-process fallback
// ------------------------------------------------------------

function resetForRetry<S extends CreateJobState | EditJobState>(state: S): S {
    if (state.kind === 'create') return resetCreateForRetry(state) as S;
    return resetEditForRetry(state) as S;
}

export async function driveInProcess<S extends CreateJobState | EditJobState>(
    initialState: S,
    step: (state: S, opts?: { signal?: AbortSignal }) => Promise<StageOutcome<S>>,
    opts?: { signal?: AbortSignal; onState?: (state: S) => void },
): Promise<CompleteResult> {
    let state: S = initialState;
    let lastError: unknown;
    // Outer retry loop: matches `for (attempt = 0; attempt <= 2; attempt++)` in
    // generators.ts. Any exception inside a stage — network, timeout, empty
    // response, validation exhaustion — is caught here and re-attempted from
    // the planner stage until MAX_OUTER_ATTEMPTS is spent.
    while (state.outerAttempt < MAX_OUTER_ATTEMPTS) {
        try {
            // Inner loop drives stages within one outer attempt.
            // Cap = plan+code+validate + fix×FIX_BUDGET + validate×FIX_BUDGET
            // ≈ under 10 stage transitions. 50 gives plenty of headroom.
            for (let i = 0; i < 50; i++) {
                const outcome = await step(state, { signal: opts?.signal });
                if (outcome.done) return outcome.result;
                state = outcome.state;
                opts?.onState?.(state);
            }
            throw new Error('driveInProcess exceeded stage transition cap');
        } catch (err) {
            lastError = err;
            if (state.outerAttempt >= MAX_OUTER_ATTEMPTS - 1) throw err;
            console.warn(
                `[driveInProcess] outer attempt ${state.outerAttempt + 1} failed, retrying...`,
                err,
            );
            state = resetForRetry(state);
            opts?.onState?.(state);
        }
    }
    throw lastError ?? new Error('driveInProcess exhausted retries');
}
