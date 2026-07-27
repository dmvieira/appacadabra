/**
 * HeadlessJsTask entry point for the Android foreground service. Runs inside
 * a headless JS context that RN keeps alive as long as the returned Promise
 * has not resolved.
 *
 * Registered in `index.js` via `AppRegistry.registerHeadlessTask`. Kotlin
 * side (BackgroundGeneratorService) starts the task with a `taskKey` of
 * `'create'` or `'edit'` plus a JSON blob of the pipeline params.
 *
 * The pipeline runs as a state machine (see `lib/api/generatorStages.ts`)
 * with state persisted to `pending_jobs` after every stage transition, so
 * the eventual WorkManager fallback (Phase 3) can resume mid-pipeline
 * instead of restarting from the planner stage. Every transition also
 * emits a `BGGenProgress` event so the main JS context — when it's alive —
 * can update the spell card UI immediately.
 *
 * The three underlying `runCreateJob` / `runEditJob` / `runResumeJob`
 * functions are also exported so iOS (which has no HeadlessJsTask) can
 * reuse the same persisted, resumable pipeline from the main JS context.
 */
import { DeviceEventEmitter, NativeModules } from 'react-native';
import Constants from 'expo-constants';
import * as db from './database/db';
import {
    initCreateState,
    initEditState,
    nextCreateStage,
    nextEditStage,
    driveInProcess,
    type CreateJobState,
    type EditJobState,
    type CreateStage,
    type EditStage,
} from './api/generatorStages';
import { logAppCreated, logAppEdited } from './analytics';
import type { PendingJob } from './database/types';
import { extractUnavailableModelId } from './api/modelUnavailableSignal';

interface TaskData {
    taskKey: string;
    paramsJson: string;
}

interface CreateParams {
    jobId: string;
    prompt: string;
    appVersion?: string;
}

interface EditParams {
    jobId: string;
    appId: number;
    currentCode: string;
    instruction: string;
    selectedContext?: string;
    previousEdits: { version: number; instruction: string }[];
    storageStructure?: { key: string; schema: unknown }[];
    appVersion?: string;
}

interface ResumeParams {
    jobId: string;
}

function getAppVersion(hint?: string): string {
    return hint ?? Constants.expoConfig?.version ?? '2.0.15';
}

export async function runBackgroundGeneratorTask(data: TaskData): Promise<void> {
    const params = JSON.parse(data.paramsJson) as CreateParams | EditParams | ResumeParams;
    await runJobWithReporting(params.jobId, async () => {
        if (data.taskKey === 'create') {
            await runCreateJob(params as CreateParams);
        } else if (data.taskKey === 'edit') {
            await runEditJob(params as EditParams);
        } else if (data.taskKey === 'resume') {
            await runResumeJob((params as ResumeParams).jobId);
        } else {
            throw new Error(`Unknown BackgroundGenerator taskKey: ${data.taskKey}`);
        }
    });
}

/**
 * Wraps a pipeline invocation with the standard failure-reporting +
 * watchdog-clear contract. Callers (Android headless task, iOS in-process
 * runner) hand it a jobId and the actual work function; on throw it
 * persists a failed row + emits BGGenFailed so the store's subscription
 * fires the same error UI regardless of platform.
 */
export async function runJobWithReporting(
    jobId: string,
    work: () => Promise<void>,
): Promise<void> {
    try {
        await work();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code =
            error instanceof Error && 'code' in error
                ? String((error as Error & { code: unknown }).code)
                : 'unknown';
        const modelId = extractUnavailableModelId(error);
        await persistFailure(jobId, code, message, modelId);
        DeviceEventEmitter.emit('BGGenFailed', { jobId, code, message, modelId });
    } finally {
        // Android: clears the WorkManager watchdog so a completed job does
        // not fire the resume path 20 min later. No-op on iOS (native side
        // does not expose clearWatchdog), which matches intent.
        clearWatchdog(jobId);
        // Belt-and-suspenders: HeadlessJsTaskService.onHeadlessJsTaskFinish
        // is unreliable on some OEM ROMs (see comment in
        // BackgroundGeneratorModule.finishJob). The store's onCompleted/
        // onFailed subscription also calls finishJob; both calls are
        // idempotent, so double-firing is safe.
        await finishFgsInline(jobId);
    }
}

export async function runCreateJob(p: CreateParams): Promise<void> {
    const state = await initCreateState({ prompt: p.prompt, appVersion: getAppVersion(p.appVersion) });
    await persistState(p.jobId, state);
    emitProgress(p.jobId, state);

    const result = await driveInProcess(state, nextCreateStage, {
        onState: async (s) => {
            await persistState(p.jobId, s);
            emitProgress(p.jobId, s);
        },
    });

    await persistCompletion(p.jobId, result.html, result.usage, result.costUsd);
    logAppCreated(0);
    DeviceEventEmitter.emit('BGGenCompleted', {
        jobId: p.jobId,
        html: result.html,
        usage: usageToWire(result.usage),
        costUsd: result.costUsd,
        appName: result.appName,
    });
}

export async function runEditJob(p: EditParams): Promise<void> {
    const state = await initEditState({
        currentCode: p.currentCode,
        instruction: p.instruction,
        appVersion: getAppVersion(p.appVersion),
        previousEdits: p.previousEdits,
        selectedContext: p.selectedContext,
        storageStructure: p.storageStructure,
    });
    await persistState(p.jobId, state);
    emitProgress(p.jobId, state);

    const result = await driveInProcess(state, nextEditStage, {
        onState: async (s) => {
            await persistState(p.jobId, s);
            emitProgress(p.jobId, s);
        },
    });

    await persistCompletion(p.jobId, result.html, result.usage, result.costUsd);
    logAppEdited(0);
    DeviceEventEmitter.emit('BGGenCompleted', {
        jobId: p.jobId,
        html: result.html,
        usage: usageToWire(result.usage),
        costUsd: result.costUsd,
    });
}

/**
 * Resume a job whose `pending_jobs` row is still `processing` — the FGS was
 * killed (OEM aggressive battery mgmt, OOM, or the WorkManager watchdog
 * fired). Rebuilds initial state from the row's immutable inputs, then
 * overlays the persisted stage/plan/html/usage cursor so the state machine
 * picks up from the last completed stage instead of the planner.
 */
export async function runResumeJob(jobId: string): Promise<void> {
    const row = await db.getPendingJob(jobId);
    if (!row) {
        // No row — the FGS was spawned by a resume for a jobId that has
        // already been deleted. Stop it so the ongoing notification does not
        // linger on OEM ROMs where onHeadlessJsTaskFinish cleanup is flaky.
        await finishFgsInline(jobId);
        return;
    }
    if (row.status !== 'processing') {
        // Row transitioned to a terminal state elsewhere — nothing to resume.
        await finishFgsInline(jobId);
        return;
    }
    if (row.currentStage === 'complete') {
        // Pipeline had already finished but the completion handler in the
        // store never ran (app killed/backgrounded before BGGenCompleted
        // fired). Delete the orphan row so reconcile stops re-triggering
        // resume, then tear down the FGS.
        try { await db.deletePendingJob(jobId); } catch { /* best-effort */ }
        await finishFgsInline(jobId);
        return;
    }

    if (row.type === 'create') {
        const state = await rebuildCreateState(row);
        await persistState(jobId, state);
        emitProgress(jobId, state);
        const result = await driveInProcess(state, nextCreateStage, {
            onState: async (s) => {
                await persistState(jobId, s);
                emitProgress(jobId, s);
            },
        });
        await persistCompletion(jobId, result.html, result.usage, result.costUsd);
        logAppCreated(0);
        DeviceEventEmitter.emit('BGGenCompleted', {
            jobId,
            html: result.html,
            usage: usageToWire(result.usage),
            costUsd: result.costUsd,
            appName: result.appName,
        });
        return;
    }

    if (row.type === 'edit') {
        if (row.appId == null) throw new Error(`resume: edit job ${jobId} missing appId`);
        const app = await db.getAppById(row.appId);
        if (!app) throw new Error(`resume: edit job ${jobId} references missing app ${row.appId}`);
        const previousEdits = await db.getVersionsForApp(row.appId).then(vs =>
            vs.map(v => ({ version: v.version, instruction: v.instruction ?? '' })),
        );
        const state = await rebuildEditState(row, app.code, previousEdits);
        await persistState(jobId, state);
        emitProgress(jobId, state);
        const result = await driveInProcess(state, nextEditStage, {
            onState: async (s) => {
                await persistState(jobId, s);
                emitProgress(jobId, s);
            },
        });
        await persistCompletion(jobId, result.html, result.usage, result.costUsd);
        logAppEdited(0);
        DeviceEventEmitter.emit('BGGenCompleted', {
            jobId,
            html: result.html,
            usage: usageToWire(result.usage),
            costUsd: result.costUsd,
        });
        return;
    }

    throw new Error(`resume: unsupported pending_job type ${row.type}`);
}

async function rebuildCreateState(row: PendingJob): Promise<CreateJobState> {
    const base = await initCreateState({ prompt: row.promptText, appVersion: getAppVersion() });
    return overlayPersistedCursor(base, row) as CreateJobState;
}

async function rebuildEditState(
    row: PendingJob,
    currentCode: string,
    previousEdits: { version: number; instruction: string }[],
): Promise<EditJobState> {
    const base = await initEditState({
        currentCode,
        instruction: row.promptText,
        appVersion: getAppVersion(),
        previousEdits,
        selectedContext: row.selectedContext ?? undefined,
    });
    return overlayPersistedCursor(base, row) as EditJobState;
}

/**
 * Restore stage cursor / partial results onto a fresh initial state. The
 * initial state carries the immutable inputs (prompt, normalized code,
 * system-instructions inputs) that we can't reconstruct from the DB.
 */
function overlayPersistedCursor<S extends CreateJobState | EditJobState>(
    base: S,
    row: PendingJob,
): S {
    if (row.currentStage && row.currentStage !== 'complete') {
        base.stage = row.currentStage as CreateStage & EditStage;
    }
    if (typeof row.stageAttempt === 'number') base.fixAttempt = row.stageAttempt;
    if (typeof row.outerAttempt === 'number') base.outerAttempt = row.outerAttempt;
    if (row.planJson) {
        try { base.plan = JSON.parse(row.planJson); } catch { /* ignore parse errors */ }
    }
    if (row.currentHtml) base.html = row.currentHtml;
    if (row.usageJson) {
        try { base.usage = JSON.parse(row.usageJson); } catch { /* ignore */ }
    }
    return base;
}

function clearWatchdog(jobId: string): void {
    const native = (NativeModules as Record<string, unknown>).BackgroundGenerator as
        | { clearWatchdog?: (jobId: string) => Promise<void> }
        | undefined;
    native?.clearWatchdog?.(jobId).catch(() => {});
}

/**
 * Stop the Android FGS for a job without going through the store's
 * subscription. Called from `runResumeJob` early-return paths where no
 * BGGen* event is emitted, and from `runJobWithReporting`'s finally block as
 * belt-and-suspenders against OEM ROMs that ignore
 * `HeadlessJsTaskService.onHeadlessJsTaskFinish` cleanup.
 *
 * Inline (does not import from `backgroundGenerator.ts`) to avoid a circular
 * dependency — that module already imports from this file.
 */
async function finishFgsInline(jobId: string): Promise<void> {
    const native = (NativeModules as Record<string, unknown>).BackgroundGenerator as
        | { finishJob?: (jobId: string) => Promise<void> }
        | undefined;
    try {
        await native?.finishJob?.(jobId);
    } catch {
        // Best-effort. If the module is missing or the call fails, the RN
        // task-finish path is still there as a fallback.
    }
}

function emitProgress(jobId: string, state: CreateJobState | EditJobState): void {
    DeviceEventEmitter.emit('BGGenProgress', {
        jobId,
        stage: state.stage,
        attempt: state.outerAttempt,
    });
}

function usageToWire(usage: { promptTokens: number; responseTokens: number; totalTokens: number }) {
    return {
        promptTokens: usage.promptTokens,
        responseTokens: usage.responseTokens,
        totalTokens: usage.totalTokens,
    };
}

async function persistState(
    jobId: string,
    state: CreateJobState | EditJobState,
): Promise<void> {
    try {
        const existing = await db.getPendingJob(jobId);
        if (!existing) return;
        await db.upsertPendingJob({
            ...existing,
            status: 'processing',
            currentStage: state.stage,
            stageAttempt: state.fixAttempt,
            outerAttempt: state.outerAttempt,
            planJson: state.plan ? JSON.stringify(state.plan) : null,
            currentHtml: state.html,
            usageJson: JSON.stringify(state.usage),
            updatedAt: Date.now(),
        });
    } catch {
        // Best-effort. Persistence failure does not abort the pipeline —
        // the emitted event is the primary channel to the main JS context.
    }
}

async function persistCompletion(
    jobId: string,
    html: string,
    usage: { promptTokens: number; responseTokens: number; totalTokens: number },
    _costUsd: number,
): Promise<void> {
    try {
        const existing = await db.getPendingJob(jobId);
        if (!existing) return;
        await db.upsertPendingJob({
            ...existing,
            status: 'processing',
            currentStage: 'complete',
            currentHtml: html,
            usageJson: JSON.stringify(usage),
            updatedAt: Date.now(),
        });
    } catch {
        // Best-effort persistence — the emitted event is the primary channel.
    }
}

async function persistFailure(
    jobId: string,
    code: string,
    message: string,
    modelId: string | null,
): Promise<void> {
    try {
        const existing = await db.getPendingJob(jobId);
        if (!existing) return;
        await db.upsertPendingJob({
            ...existing,
            status: 'failed',
            lastErrorCode: code,
            // For model-unavailable, stamp the modelId so the reconciler in
            // store.ts can name the specific dead model when it dispatches
            // ModelUnavailableModal after a background job failed while the
            // main JS context was down.
            lastErrorMessage: modelId ?? message,
            updatedAt: Date.now(),
        });
    } catch {
        // ignored
    }
}
