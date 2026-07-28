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
import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
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
import type { PendingJob, NewGeneratedApp } from './database/types';
import { extractUnavailableModelId } from './api/modelUnavailableSignal';
import SharingShortcuts from './bridges/SharingShortcuts';
import { t } from './i18n';

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
    logAppCreated();
    // Persist the spell + fire the success notification here in the headless
    // task so the notification cannot be dropped by the RN bridge tearing
    // down before the store subscriber's async chain finishes. Store
    // subscribers now only refresh UI state — DB write, notification post,
    // and pending_jobs cleanup all happen synchronously below.
    const appId = await finalizeCreateInline(
        p.jobId,
        result.html,
        result.appName,
        p.prompt,
        result.costUsd ?? 0,
    );
    DeviceEventEmitter.emit('BGGenCompleted', {
        jobId: p.jobId,
        appId,
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
    logAppEdited();
    await finalizeEditInline(
        p.jobId,
        p.appId,
        result.html,
        p.instruction,
        result.costUsd ?? 0,
    );
    DeviceEventEmitter.emit('BGGenCompleted', {
        jobId: p.jobId,
        appId: p.appId,
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
        logAppCreated();
        const appId = await finalizeCreateInline(
            jobId,
            result.html,
            result.appName,
            row.promptText,
            result.costUsd ?? 0,
        );
        DeviceEventEmitter.emit('BGGenCompleted', {
            jobId,
            appId,
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
        logAppEdited();
        await finalizeEditInline(
            jobId,
            row.appId,
            result.html,
            row.promptText,
            result.costUsd ?? 0,
        );
        DeviceEventEmitter.emit('BGGenCompleted', {
            jobId,
            appId: row.appId,
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

/**
 * Persist a completed spell + post the success notification synchronously
 * from the headless task. The store subscriber used to own this work, but
 * the RN bridge could be torn down mid-await when the FGS stopped — the
 * notification scheduling call would then silently fail (`.catch(() => {})`
 * swallowed the error) and the user would never see the "Spell Ready"
 * banner. Running it here guarantees the notification fires before the
 * task-finish path stops the service.
 *
 * All DB writes are idempotent on jobId, so running this again from the
 * store subscriber (or a resume) is safe.
 */
async function finalizeCreateInline(
    jobId: string,
    html: string,
    appName: string | undefined,
    prompt: string,
    costUsd: number,
): Promise<number> {
    const now = Date.now();
    // Mirror the fallback the store subscriber used to apply — a truncated
    // prompt is a better UX default than a generic "Untitled" label.
    const resolvedName = (appName && appName.trim()) || prompt.slice(0, 40) || 'Spell';
    const newApp: NewGeneratedApp = {
        name: resolvedName,
        code: html,
        currentVersion: 1,
        iconPath: null,
        lastUpdated: now,
        createdAt: now,
        consoleLogs: '',
        totalSpendUsd: costUsd,
        jobId,
        requiresBiometric: false,
        shortDescription: prompt,
        sortOrder: 0,
    };
    const appId = await db.insertApp(newApp);
    await db.insertVersion({
        appId,
        version: 1,
        code: html,
        instruction: prompt || '',
        selectedContext: null,
        createdAt: now,
        jobId,
    });
    try {
        await SharingShortcuts.publishShortcut(String(appId), resolvedName, null);
    } catch {
        // Best-effort — ShortcutManagerCompat is upsert-by-id and failure is
        // never user-visible on its own.
    }
    await postCreateSuccessNotification(appId, resolvedName, jobId);
    await db.deletePendingJob(jobId).catch(() => {});
    return appId;
}

async function finalizeEditInline(
    jobId: string,
    appId: number,
    html: string,
    instruction: string,
    costUsd: number,
): Promise<void> {
    const app = await db.getAppById(appId);
    if (!app) {
        // Spell deleted mid-flight — drop the row and skip the notification.
        await db.deletePendingJob(jobId).catch(() => {});
        return;
    }
    const newVersion = app.currentVersion + 1;
    const newTotal = (app.totalSpendUsd ?? 0) + (costUsd ?? 0);
    await db.updateAppContent(appId, html, newVersion, newTotal, jobId);
    await db.insertVersion({
        appId,
        version: newVersion,
        code: html,
        instruction: instruction || '',
        selectedContext: null,
        createdAt: Date.now(),
        jobId,
    });
    await postEditSuccessNotification(appId, app.name, jobId);
    await db.deletePendingJob(jobId).catch(() => {});
}

async function postCreateSuccessNotification(
    appId: number,
    appName: string,
    jobId: string,
): Promise<void> {
    const channelId = `spell-${appId}`;
    if (Platform.OS === 'android') {
        try {
            await Notifications.setNotificationChannelAsync(channelId, {
                name: appName,
                importance: Notifications.AndroidImportance.HIGH,
                vibrationPattern: [0, 250, 250, 250],
                lightColor: '#FF9500',
            });
        } catch {
            // Channel may already exist; the notification schedule below is
            // still safe.
        }
    }
    await Notifications.scheduleNotificationAsync({
        identifier: `spell-created-${jobId}`,
        content: {
            title: t('appReadyTitle'),
            body: t('appReadyBody', { name: appName }),
            data: { appId, kind: 'create-success' },
        },
        trigger: Platform.OS === 'android'
            ? ({ channelId } as unknown as null)
            : null,
    }).catch(() => {});
}

async function postEditSuccessNotification(
    appId: number,
    appName: string,
    jobId: string,
): Promise<void> {
    await Notifications.scheduleNotificationAsync({
        identifier: `spell-updated-${jobId}`,
        content: {
            title: t('appUpdatedTitle'),
            body: t('appUpdatedBody', { name: appName }),
            data: { appId, kind: 'edit-success' },
        },
        trigger: null,
    }).catch(() => {});
}
