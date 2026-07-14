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
 * OS-granted ~30 s background window instead of the ~5 s default. Full
 * swipe-kill survival via `URLSession.background` is a follow-up.
 */
import { DeviceEventEmitter, NativeModules, Platform, type EmitterSubscription } from 'react-native';
import * as ai from './api/ai';

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
// Mirrors the shape the native side will produce so store.ts can subscribe to
// one channel regardless of platform / native availability.

async function runCreateInProcess(params: StartCreateParams): Promise<void> {
    try {
        DeviceEventEmitter.emit(EVENT_PROGRESS, {
            jobId: params.jobId,
            stage: 'planner',
            attempt: 0,
        } satisfies BgGenProgressEvent);
        const result = await ai.generateApp(params.prompt);
        DeviceEventEmitter.emit(EVENT_COMPLETED, {
            jobId: params.jobId,
            html: result.text,
            usage: result.usage,
            costUsd: result.costUsd,
            appName: result.appName,
        } satisfies BgGenCompletedEvent);
    } catch (error) {
        DeviceEventEmitter.emit(EVENT_FAILED, {
            jobId: params.jobId,
            code: error instanceof Error && 'code' in error ? String((error as Error & { code: unknown }).code) : 'unknown',
            message: error instanceof Error ? error.message : String(error),
        } satisfies BgGenFailedEvent);
    } finally {
        await endNativeJob(params.jobId);
    }
}

async function runEditInProcess(params: StartEditParams): Promise<void> {
    try {
        DeviceEventEmitter.emit(EVENT_PROGRESS, {
            jobId: params.jobId,
            stage: 'planner',
            attempt: 0,
        } satisfies BgGenProgressEvent);
        const result = await ai.editAppWithContext(
            params.currentCode,
            params.instruction,
            params.selectedContext ?? '',
            params.previousEdits,
        );
        DeviceEventEmitter.emit(EVENT_COMPLETED, {
            jobId: params.jobId,
            html: result.text,
            usage: result.usage,
            costUsd: result.costUsd,
            appName: result.appName,
        } satisfies BgGenCompletedEvent);
    } catch (error) {
        DeviceEventEmitter.emit(EVENT_FAILED, {
            jobId: params.jobId,
            code: error instanceof Error && 'code' in error ? String((error as Error & { code: unknown }).code) : 'unknown',
            message: error instanceof Error ? error.message : String(error),
        } satisfies BgGenFailedEvent);
    } finally {
        await endNativeJob(params.jobId);
    }
}
