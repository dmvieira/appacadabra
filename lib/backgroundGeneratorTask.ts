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
 */
import { DeviceEventEmitter } from 'react-native';
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
} from './api/generatorStages';
import { logAppCreated, logAppEdited } from './analytics';

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

function getAppVersion(hint?: string): string {
    return hint ?? Constants.expoConfig?.version ?? '2.0.15';
}

export async function runBackgroundGeneratorTask(data: TaskData): Promise<void> {
    let jobId = 'unknown';
    try {
        const params = JSON.parse(data.paramsJson) as CreateParams | EditParams;
        jobId = params.jobId;

        if (data.taskKey === 'create') {
            await runCreate(params as CreateParams);
        } else if (data.taskKey === 'edit') {
            await runEdit(params as EditParams);
        } else {
            throw new Error(`Unknown BackgroundGenerator taskKey: ${data.taskKey}`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code =
            error instanceof Error && 'code' in error
                ? String((error as Error & { code: unknown }).code)
                : 'unknown';
        await persistFailure(jobId, code, message);
        DeviceEventEmitter.emit('BGGenFailed', { jobId, code, message });
    }
}

async function runCreate(p: CreateParams): Promise<void> {
    const state = initCreateState({ prompt: p.prompt, appVersion: getAppVersion(p.appVersion) });
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

async function runEdit(p: EditParams): Promise<void> {
    const state = initEditState({
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

async function persistFailure(jobId: string, code: string, message: string): Promise<void> {
    try {
        const existing = await db.getPendingJob(jobId);
        if (!existing) return;
        await db.upsertPendingJob({
            ...existing,
            status: 'failed',
            lastErrorCode: code,
            lastErrorMessage: message,
            updatedAt: Date.now(),
        });
    } catch {
        // ignored
    }
}
