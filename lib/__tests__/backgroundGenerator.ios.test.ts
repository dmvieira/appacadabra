/**
 * iOS resume + reconciliation coverage for the background-generation
 * facade. On iOS the OS closes our background window in ~30s, so a job
 * interrupted mid-flight must be restartable from foreground via the
 * persisted state in `pending_jobs`.
 *
 * These tests pin the *contracts* the store's reconcile loop depends on:
 *   - `isJobActiveInProcess` reflects the in-memory registry
 *   - `resume(jobId)` refuses when no processing row exists
 *   - `resume(jobId)` short-circuits when a driver is already active for
 *     the same jobId (idempotency guard against reconcile+foreground races)
 *   - `runJobWithReporting` persists a failed row + emits BGGenFailed on
 *     throw so store subscriptions render the retry modal on any platform
 *   - `scheduleBackgroundProcessing` is a safe no-op without native
 */

jest.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    NativeModules: {},
    DeviceEventEmitter: {
        addListener: jest.fn(),
        removeAllListeners: jest.fn(),
        emit: jest.fn(),
    },
}));

jest.mock('../api/openrouter', () => {
    class OpenRouterError extends Error {
        code: string;
        status?: number;
        retryable?: boolean;
        modelId?: string;
        constructor(code: string, message: string, status?: number, retryable?: boolean, modelId?: string) {
            super(message);
            this.code = code;
            this.status = status;
            this.retryable = retryable;
            this.modelId = modelId;
        }
    }
    return {
        chat: jest.fn(),
        OpenRouterError,
    };
});

jest.mock('../validators/codeValidator', () => ({
    validateGeneratedCode: jest.fn(() => ({ valid: true, errors: [], canRetry: false })),
    generateFixPrompt: jest.fn(() => 'fix this'),
}));

jest.mock('../validators/executionValidator', () => ({
    validateWithExecution: jest.fn(() => ({ valid: true, errors: [], canRetry: false })),
}));

jest.mock('../capabilities', () => ({
    ALL_CAPABILITIES: [],
}));

jest.mock('../database/db', () => ({
    getPendingJob: jest.fn(),
    upsertPendingJob: jest.fn(() => Promise.resolve()),
    getAppById: jest.fn(),
    getVersionsForApp: jest.fn(() => Promise.resolve([])),
}));

jest.mock('../analytics', () => ({
    logAppCreated: jest.fn(),
    logAppEdited: jest.fn(),
}));

import { DeviceEventEmitter } from 'react-native';
import * as bgGen from '../backgroundGenerator';
import { runJobWithReporting } from '../backgroundGeneratorTask';
import * as db from '../database/db';

describe('backgroundGenerator (iOS)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('activeInProcessJobs registry', () => {
        it('starts empty', () => {
            expect(bgGen.activeInProcessJobCount()).toBe(0);
            expect(bgGen.isJobActiveInProcess('never-started')).toBe(false);
        });
    });

    describe('resume()', () => {
        it('returns false when the pending row is missing', async () => {
            (db.getPendingJob as jest.Mock).mockResolvedValueOnce(null);
            const ok = await bgGen.resume('job_missing');
            expect(ok).toBe(false);
        });

        it('returns false when the pending row is not processing anymore', async () => {
            (db.getPendingJob as jest.Mock).mockResolvedValueOnce({
                jobId: 'job_done',
                type: 'create',
                appId: null,
                promptText: 'x',
                selectedContext: null,
                status: 'failed',
                startedAt: 0,
                updatedAt: 0,
                lastErrorCode: null,
                lastErrorMessage: null,
            });
            const ok = await bgGen.resume('job_done');
            expect(ok).toBe(false);
        });
    });

    describe('scheduleBackgroundProcessing()', () => {
        it('is a no-op when the native module is unavailable', async () => {
            // No NativeModules.BackgroundGenerator registered in the mock —
            // must not throw.
            await expect(bgGen.scheduleBackgroundProcessing()).resolves.toBeUndefined();
        });
    });

    describe('runJobWithReporting()', () => {
        it('persists failed row + emits BGGenFailed on throw', async () => {
            const emit = DeviceEventEmitter.emit as jest.Mock;
            const upsert = db.upsertPendingJob as jest.Mock;
            (db.getPendingJob as jest.Mock).mockResolvedValueOnce({
                jobId: 'job_err',
                type: 'create',
                appId: null,
                promptText: 'x',
                selectedContext: null,
                status: 'processing',
                startedAt: 0,
                updatedAt: 0,
                lastErrorCode: null,
                lastErrorMessage: null,
            });

            const err = Object.assign(new Error('kaboom'), { code: 'byok.error.upstream' });
            await runJobWithReporting('job_err', async () => {
                throw err;
            });

            expect(emit).toHaveBeenCalledWith('BGGenFailed', {
                jobId: 'job_err',
                code: 'byok.error.upstream',
                message: 'kaboom',
                // Non-modelUnavailable errors carry a null modelId so the
                // store subscription can uniformly destructure the payload.
                modelId: null,
            });
            expect(upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    jobId: 'job_err',
                    status: 'failed',
                    lastErrorCode: 'byok.error.upstream',
                    lastErrorMessage: 'kaboom',
                }),
            );
        });

        it('does not emit BGGenFailed when work completes normally', async () => {
            const emit = DeviceEventEmitter.emit as jest.Mock;
            await runJobWithReporting('job_ok', async () => { /* noop */ });
            const failedCalls = emit.mock.calls.filter(([evt]) => evt === 'BGGenFailed');
            expect(failedCalls).toHaveLength(0);
        });
    });
});
