/**
 * Background Spell Generator — cross-platform facade.
 *
 * The BYOK migration (commit b7876f0) moved the planner→coder→fix pipeline
 * from Firebase Functions into the RN JS thread. Backgrounding or killing the
 * app now interrupts an in-flight generation. This module presents a single
 * event-based API that store.ts consumes; the actual execution is delegated to
 * a native module when available (Android FGS / iOS URLSession-bg) and falls
 * back to running the pipeline in-process otherwise.
 *
 * Phase 1 (Android): native module runs the TS pipeline inside a Foreground
 * Service via HeadlessJsTaskService — survives backgrounding.
 *
 * Phase 2 v1 (iOS): native module wraps the pipeline in
 * `beginBackgroundTask` so the JS-side execution keeps running through the
 * OS-granted ~30 s background window instead of the ~5 s default. The JS
 * side runs the *same* persisted state machine as Android (via
 * `runCreateJob`/`runEditJob` from backgroundGeneratorTask.ts), so a job
 * interrupted by the OS window expiring can be resumed from the last
 * completed stage on foreground return — see `resume()` below and
 * `reconcilePendingJobs` in store.ts.
 */
import { DeviceEventEmitter, NativeModules, Platform, type EmitterSubscription } from 'react-native';
import {
    runCreateJob,
    runEditJob,
    runResumeJob,
    runJobWithReporting,
} from './backgroundGeneratorTask';
import * as db from './database/db';

export type BgJobStage = 'planner' | 'coder' | 'patch' | 'validate' | 'fix' | 'complete';

export interface BgGenProgressEvent {
    jobId: string;
    stage: BgJobStage;
    attempt: number;
}

export interface BgGenCompletedEvent {
    jobId: string;
    html: string;
    usage: {
        promptTokens: number;
        responseTokens: number;
        totalTokens: number;
    };
    costUsd: number;
    appName?: string;
}

export interface BgGenFailedEvent {
    jobId: string;
    code: string;
    message: string;
    /** Present when code === 'byok.error.modelUnavailable'. */
    modelId?: string | null;
}

export interface StartCreateParams {
    jobId: string;
    prompt: string;
    appVersion?: string;
    /** Localized text used as the foreground-service notification title. */
    notificationTitle?: string;
}

export interface StartEditParams {
    jobId: string;
    appId: number;
    currentCode: string;
    instruction: string;
    selectedContext?: string;
    previousEdits: { version: number; instruction: string }[];
    appVersion?: string;
    /** Localized text used as the foreground-service notification title. */
    notificationTitle?: string;
}

export type BgJobStatus =
    | { state: 'running'; stage: BgJobStage; attempt: number }
    | { state: 'not-found' };

const EVENT_PROGRESS = 'BGGenProgress';
const EVENT_COMPLETED = 'BGGenCompleted';
const EVENT_FAILED = 'BGGenFailed';

interface NativeBackgroundGenerator {
    startCreate(params: StartCreateParams): Promise<void>;
    startEdit(params: StartEditParams): Promise<void>;
    cancel(jobId: string): Promise<void>;
    status(jobId: string): Promise<BgJobStatus>;
    /**
     * iOS only. Called by the in-process fallback when the pipeline finishes
     * (success or failure) so the module can release the `beginBackgroundTask`
     * token. Android's HeadlessJsTaskService manages its own lifecycle, so
     * the module there does not expose this method — hence the optional.
     */
    endJob?(jobId: string): Promise<void>;
    /**
     * Android only. Starts the FGS in resume mode for a job that is still
     * `processing` in the DB but no longer running in native. The JS-side
     * task reads pending_jobs and re-drives the state machine.
     */
    resume?(jobId: string): Promise<void>;
    /**
     * Android only. Cancels the WorkManager watchdog for a job. Called from
     * the JS task at terminal states so a completed happy-path job doesn't
     * fire the resume watchdog 20 min later.
     */
    clearWatchdog?(jobId: string): Promise<void>;
    /**
     * Android only. Cancels the watchdog AND stops the BackgroundGenerator
     * foreground service. Called from the store when the job hits a terminal
     * state so the "Conjurando Feitiço" ongoing notification is dismissed
     * synchronously — Service.onDestroy runs dismissNotification. Mirrors
     * the WebViewAiKeepAliveModule.release() pattern.
     */
    finishJob?(jobId: string): Promise<void>;
    /**
     * iOS only. Submits a BGProcessingTaskRequest to iOS for opportunistic
     * background wake-up while the app is suspended. Handler (in
     * AppDelegate) emits `BGReconcileRequest`, which JS uses to trigger
     * `reconcilePendingJobs`. iOS decides when (or whether) to fire it —
     * treated as bonus, not the deterministic path.
     */
    scheduleBackgroundProcessing?(): Promise<void>;
}

function getNativeModule(): NativeBackgroundGenerator | null {
    const mod = (NativeModules as Record<string, unknown>).BackgroundGenerator;
    if (mod && typeof (mod as NativeBackgroundGenerator).startCreate === 'function') {
        return mod as NativeBackgroundGenerator;
    }
    return null;
}

/**
 * On Android the native module hosts the entire pipeline (survives
 * backgrounding via foreground service). On iOS the native module only
 * extends the background window — the pipeline still runs in the JS thread
 * — so the two platforms need different orchestration.
 */
function nativeDrivesPipeline(): boolean {
    return Platform.OS === 'android' && getNativeModule() !== null;
}

function nativeExtendsBackground(): boolean {
    return Platform.OS === 'ios' && getNativeModule() !== null;
}

/**
 * True when the platform can survive backgrounding via a native executor
 * (Android FGS today; iOS gets kill-survival in a follow-up phase).
 * Callers can still use this module when false — execution just happens
 * in-process and will be interrupted by the OS like any JS work.
 */
export function isNativeAvailable(): boolean {
    return nativeDrivesPipeline() || nativeExtendsBackground();
}

export async function startCreate(params: StartCreateParams): Promise<void> {
    if (nativeDrivesPipeline()) {
        await getNativeModule()!.startCreate(params);
        return;
    }
    if (nativeExtendsBackground()) {
        try {
            await getNativeModule()!.startCreate(params);
        } catch {
            // Non-fatal: the pipeline still runs in-process; we just miss
            // the extended background window. Better than not starting at all.
        }
    }
    void runCreateInProcess(params);
}

export async function startEdit(params: StartEditParams): Promise<void> {
    if (nativeDrivesPipeline()) {
        await getNativeModule()!.startEdit(params);
        return;
    }
    if (nativeExtendsBackground()) {
        try {
            await getNativeModule()!.startEdit(params);
        } catch {
            // See note above in startCreate.
        }
    }
    void runEditInProcess(params);
}

// ----- Active-job registry -----
// Jobs currently being driven by the JS pipeline in *this* process. Used by
// reconcilePendingJobs to distinguish "actively running here" (leave alone)
// from "orphaned pending_jobs row" (candidate for resume). Only meaningful on
// iOS / fallback paths — Android's native FGS owns lifecycle via
// bgGen.status(). Public so store.ts can consult it during reconciliation.
const activeInProcessJobs = new Set<string>();

export function isJobActiveInProcess(jobId: string): boolean {
    return activeInProcessJobs.has(jobId);
}

export function activeInProcessJobCount(): number {
    return activeInProcessJobs.size;
}

/**
 * Ask the platform to resume a job whose `pending_jobs` row is still
 * `processing` but which is no longer running in the current process.
 *
 * Android: delegates to the native module, which restarts the FGS in
 * `resume` taskKey. The state machine picks up from the persisted stage.
 *
 * iOS: no separate native "resume" mode — instead we call the same native
 * `beginBackgroundTask` window opener and drive `runResumeJob` in this
 * JS context. The row's persisted stage/plan/html mean we skip already-
 * completed HTTP round-trips instead of restarting from the planner.
 *
 * Returns true on both a scheduled Android resume and a locally-driven
 * iOS resume; false when no path is available (e.g. neither native nor
 * a pending row).
 */
export async function resume(jobId: string): Promise<boolean> {
    const native = getNativeModule();

    // Android — hand off to the FGS in resume mode.
    if (Platform.OS === 'android' && native?.resume) {
        try {
            await native.resume(jobId);
            return true;
        } catch {
            return false;
        }
    }

    // iOS / fallback — drive the persisted state machine in-process.
    if (activeInProcessJobs.has(jobId)) {
        // Someone in this process is already resuming it; do not fork a
        // second driver against the same row.
        return true;
    }
    const row = await db.getPendingJob(jobId).catch(() => null);
    if (!row || row.status !== 'processing') return false;

    // Extend the OS background window if the native side is available.
    // The current type contract requires the full create/edit params dict,
    // but iOS only reads `jobId` — we bypass the compiler here rather than
    // widening the public startCreate signature just for this path.
    if (nativeExtendsBackground()) {
        try {
            const startFn = row.type === 'edit' ? native!.startEdit : native!.startCreate;
            await startFn.call(native, { jobId } as unknown as StartCreateParams & StartEditParams);
        } catch {
            // Non-fatal — resume still runs in the foreground JS context.
        }
    }

    activeInProcessJobs.add(jobId);
    void (async () => {
        try {
            await runJobWithReporting(jobId, () => runResumeJob(jobId));
        } finally {
            activeInProcessJobs.delete(jobId);
            await endNativeJob(jobId);
        }
    })();
    return true;
}

/**
 * Ask iOS to schedule a BGProcessingTaskRequest so the OS may wake the app
 * in background and let JS run `reconcilePendingJobs`. Best-effort; safe
 * to call multiple times (iOS de-dupes by identifier). No-op on Android
 * (the FGS keeps the process alive without OS scheduling help).
 */
export async function scheduleBackgroundProcessing(): Promise<void> {
    const native = getNativeModule();
    if (!native?.scheduleBackgroundProcessing) return;
    try {
        await native.scheduleBackgroundProcessing();
    } catch {
        // Non-fatal — foreground-resume is the deterministic path.
    }
}

/**
 * Cancel the WorkManager watchdog for a completed/failed job so it does not
 * fire the resume path uselessly. Android only; no-op elsewhere.
 */
export async function clearWatchdog(jobId: string): Promise<void> {
    const native = getNativeModule();
    if (!native?.clearWatchdog) return;
    try {
        await native.clearWatchdog(jobId);
    } catch {
        // Best-effort — WorkManager will still no-op if the job is complete.
    }
}

/**
 * Tear down the FGS + watchdog for a terminal job. Android only; no-op
 * elsewhere (iOS uses `endJob` from the in-process runner instead).
 *
 * Called from the store's onCompleted/onFailed handlers so the "Conjurando
 * Feitiço" ongoing notification is dismissed at the same moment the app
 * posts the success/failure notification — instead of waiting on
 * HeadlessJsTaskService.onHeadlessJsTaskFinish, which fires unreliably on
 * some OEM ROMs under the New Architecture.
 */
export async function finishJob(jobId: string): Promise<void> {
    const native = getNativeModule();
    if (!native?.finishJob) return;
    try {
        await native.finishJob(jobId);
    } catch {
        // Best-effort — the RN task-finish path is still there as a fallback.
    }
}

export async function cancel(jobId: string): Promise<void> {
    const native = getNativeModule();
    if (native) {
        await native.cancel(jobId);
    }
    // In-process path has no cancellation hook today — the pipeline finishes or
    // errors out on its own. Once the state machine lands, cancellation becomes
    // a persisted flag the executor checks between stages.
}

export async function status(jobId: string): Promise<BgJobStatus> {
    const native = getNativeModule();
    if (native) {
        return native.status(jobId);
    }
    return { state: 'not-found' };
}

async function endNativeJob(jobId: string): Promise<void> {
    const native = getNativeModule();
    if (!native?.endJob) return;
    try {
        await native.endJob(jobId);
    } catch {
        // ignored — the OS will eventually reclaim the background token
    }
}

// ----- Event subscription helpers -----

export function onProgress(listener: (e: BgGenProgressEvent) => void): EmitterSubscription {
    return DeviceEventEmitter.addListener(EVENT_PROGRESS, listener);
}

export function onCompleted(listener: (e: BgGenCompletedEvent) => void): EmitterSubscription {
    return DeviceEventEmitter.addListener(EVENT_COMPLETED, listener);
}

export function onFailed(listener: (e: BgGenFailedEvent) => void): EmitterSubscription {
    return DeviceEventEmitter.addListener(EVENT_FAILED, listener);
}

// ----- In-process fallback -----
// Runs the same persisted state machine as the Android headless task so a
// job interrupted by the OS window closing on iOS can be resumed from the
// last completed stage on foreground return, instead of restarting from
// the planner. Events are emitted by the shared runner and the failure
// wrapper (runJobWithReporting) so the store's subscription hears the same
// channels regardless of platform.

async function runCreateInProcess(params: StartCreateParams): Promise<void> {
    activeInProcessJobs.add(params.jobId);
    try {
        await runJobWithReporting(params.jobId, () =>
            runCreateJob({
                jobId: params.jobId,
                prompt: params.prompt,
                appVersion: params.appVersion,
            }),
        );
    } finally {
        activeInProcessJobs.delete(params.jobId);
        await endNativeJob(params.jobId);
    }
}

async function runEditInProcess(params: StartEditParams): Promise<void> {
    activeInProcessJobs.add(params.jobId);
    try {
        await runJobWithReporting(params.jobId, () =>
            runEditJob({
                jobId: params.jobId,
                appId: params.appId,
                currentCode: params.currentCode,
                instruction: params.instruction,
                selectedContext: params.selectedContext,
                previousEdits: params.previousEdits,
                appVersion: params.appVersion,
            }),
        );
    } finally {
        activeInProcessJobs.delete(params.jobId);
        await endNativeJob(params.jobId);
    }
}
