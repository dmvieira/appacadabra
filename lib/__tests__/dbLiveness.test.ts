/**
 * Issue #1 root cause: Xiaomi MIUI/HyperOS Doze tears down the RN headless
 * JS context mid-persist. `expo-sqlite`'s already-queued prepareAsync call
 * rejects with `NativeDatabase.prepareAsync ... rejected`. Without
 * reclassification the raw message surfaces in the modal.
 *
 * `runJobWithReporting` maps this shape to `byok.error.aborted` — the
 * localized "job was aborted" message — instead of `'unknown'`.
 */

jest.mock('react-native', () => ({
    Platform: { OS: 'android' },
    NativeModules: {},
    DeviceEventEmitter: {
        addListener: jest.fn(),
        removeAllListeners: jest.fn(),
        emit: jest.fn(),
    },
    AppState: {
        currentState: 'active',
        addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    },
    I18nManager: {
        allowRTL: jest.fn(),
        forceRTL: jest.fn(),
        isRTL: false,
    },
}));

jest.mock('expo-notifications', () => ({
    scheduleNotificationAsync: jest.fn(() => Promise.resolve('mock-id')),
    setNotificationChannelAsync: jest.fn(() => Promise.resolve()),
    getPresentedNotificationsAsync: jest.fn(() => Promise.resolve([])),
    AndroidImportance: { HIGH: 4 },
}));

jest.mock('../bridges/SharingShortcuts', () => ({
    __esModule: true,
    default: {
        publishShortcut: jest.fn(() => Promise.resolve(true)),
    },
}));

jest.mock('../database/db', () => ({
    getPendingJob: jest.fn(() => Promise.resolve({
        jobId: 'j',
        type: 'create',
        appId: null,
        promptText: 'p',
        selectedContext: null,
        status: 'processing',
        startedAt: 0,
        updatedAt: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
    })),
    upsertPendingJob: jest.fn(() => Promise.resolve()),
}));

jest.mock('../analytics', () => ({
    logAppCreated: jest.fn(),
    logAppEdited: jest.fn(),
}));

jest.mock('../api/openrouter', () => ({
    chat: jest.fn(),
    OpenRouterError: class OpenRouterError extends Error {},
}));

jest.mock('../validators/codeValidator', () => ({
    validateGeneratedCode: jest.fn(() => ({ valid: true, errors: [] })),
    generateFixPrompt: jest.fn(() => ''),
}));

jest.mock('../validators/executionValidator', () => ({
    validateWithExecution: jest.fn(() => ({ valid: true, errors: [] })),
}));

jest.mock('../capabilities', () => ({
    ALL_CAPABILITIES: [],
}));

import { DeviceEventEmitter } from 'react-native';
import * as db from '../database/db';
import { runJobWithReporting } from '../backgroundGeneratorTask';

describe('runJobWithReporting DB-handle reclassification', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('reclassifies NativeDatabase.prepareAsync rejection as byok.error.aborted', async () => {
        const emit = DeviceEventEmitter.emit as jest.Mock;
        const upsert = db.upsertPendingJob as jest.Mock;

        const err = new Error(
            `Call to function 'NativeDatabase.prepareAsync' has been rejected.`,
        );

        await runJobWithReporting('job_db', async () => { throw err; });

        expect(emit).toHaveBeenCalledWith('BGGenFailed', expect.objectContaining({
            jobId: 'job_db',
            code: 'byok.error.aborted',
        }));
        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
            status: 'failed',
            lastErrorCode: 'byok.error.aborted',
        }));
    });

    it('reclassifies "Database is closed" as byok.error.aborted', async () => {
        const emit = DeviceEventEmitter.emit as jest.Mock;
        await runJobWithReporting('job_db2', async () => {
            throw new Error('The Database is closed.');
        });
        expect(emit).toHaveBeenCalledWith('BGGenFailed', expect.objectContaining({
            code: 'byok.error.aborted',
        }));
    });

    it('leaves unrelated errors with their original code', async () => {
        const emit = DeviceEventEmitter.emit as jest.Mock;
        const err = Object.assign(new Error('rate limited'), { code: 'byok.error.rateLimited' });
        await runJobWithReporting('job_rl', async () => { throw err; });
        expect(emit).toHaveBeenCalledWith('BGGenFailed', expect.objectContaining({
            code: 'byok.error.rateLimited',
        }));
    });

    it('exposes abortJob so external callers can abort a running job', async () => {
        // Import fresh to check the exported surface.
        const mod = require('../backgroundGeneratorTask');
        expect(typeof mod.abortJob).toBe('function');
        // Aborting an unknown jobId is a no-op (safe under races).
        expect(() => mod.abortJob('no-such-job')).not.toThrow();
    });
});
