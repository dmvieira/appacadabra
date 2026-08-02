/**
 * Notification-dedup coverage for the background generator finalize path.
 *
 * Issue #3 root cause was double-posting the "Spell Ready" notification when
 * the WorkManager watchdog spawned a parallel HeadlessJS task. Even after the
 * native + JS dedup guards, we keep this safety net at post time: if a
 * notification with the same identifier is already presented, skip the
 * schedule call.
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
        removeShortcut: jest.fn(() => Promise.resolve(true)),
    },
}));

jest.mock('../database/db', () => ({
    getPendingJob: jest.fn(),
    upsertPendingJob: jest.fn(() => Promise.resolve()),
    getAppById: jest.fn(),
    getVersionsForApp: jest.fn(() => Promise.resolve([])),
    insertApp: jest.fn(() => Promise.resolve(42)),
    insertVersion: jest.fn(() => Promise.resolve()),
    updateAppContent: jest.fn(() => Promise.resolve()),
    deletePendingJob: jest.fn(() => Promise.resolve()),
}));

jest.mock('../analytics', () => ({
    logAppCreated: jest.fn(),
    logAppEdited: jest.fn(),
}));

jest.mock('../api/openrouter', () => ({
    chat: jest.fn(),
}));

jest.mock('../validators/codeValidator', () => ({
    validateGeneratedCode: jest.fn(() => ({ valid: true, errors: [], canRetry: false })),
    generateFixPrompt: jest.fn(() => 'fix'),
}));

jest.mock('../validators/executionValidator', () => ({
    validateWithExecution: jest.fn(() => ({ valid: true, errors: [], canRetry: false })),
}));

jest.mock('../capabilities', () => ({
    ALL_CAPABILITIES: [],
}));

jest.mock('../api/modelPreferences', () => ({
    getPreferredModel: jest.fn(async () => 'deepseek/deepseek-v4-flash'),
}));

jest.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED: 'WHEN_UNLOCKED',
    getItemAsync: jest.fn(async () => null),
    setItemAsync: jest.fn(async () => {}),
    deleteItemAsync: jest.fn(async () => {}),
}));

import * as Notifications from 'expo-notifications';
import * as openrouter from '../api/openrouter';
import * as db from '../database/db';
import { runCreateJob } from '../backgroundGeneratorTask';

const mChat = openrouter.chat as jest.MockedFunction<typeof openrouter.chat>;
const mGetPresented = Notifications.getPresentedNotificationsAsync as jest.Mock;
const mSchedule = Notifications.scheduleNotificationAsync as jest.Mock;

function chatResponse(content: string) {
    return {
        id: 'x',
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
    } as any;
}

beforeEach(() => {
    jest.clearAllMocks();
    (db.getPendingJob as jest.Mock).mockResolvedValue({
        jobId: 'job_n1',
        type: 'create',
        appId: null,
        promptText: 'p',
        selectedContext: null,
        status: 'processing',
        startedAt: 0,
        updatedAt: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
    });
});

describe('postCreateSuccessNotification dedup', () => {
    function primeHappyPathChat() {
        const plan = { appName: 'x', technicalRequirements: { apis: [] } };
        const html = '<!DOCTYPE html><html><head><title>x</title></head><body/></html>';
        // Multi-call default so any retry/attempt still resolves to a valid
        // response — the test cares about the finalize notification, not the
        // retry behaviour.
        mChat.mockImplementation((async (req: any) => {
            const last = req.messages[req.messages.length - 1]?.content ?? '';
            if (String(last).includes('APP PLAN')) return chatResponse('```html\n' + html + '\n```');
            return chatResponse(JSON.stringify(plan));
        }) as any);
    }

    it('skips schedule when the same identifier is already presented', async () => {
        mGetPresented.mockResolvedValue([
            { request: { identifier: 'spell-created-job_n1' } },
        ]);
        primeHappyPathChat();

        await runCreateJob({ jobId: 'job_n1', prompt: 'p', appVersion: '3.0.0' });

        expect(mSchedule).not.toHaveBeenCalled();
    });

    it('schedules when no matching presented notification exists', async () => {
        mGetPresented.mockResolvedValue([
            { request: { identifier: 'unrelated-id' } },
        ]);
        primeHappyPathChat();

        await runCreateJob({ jobId: 'job_n1', prompt: 'p', appVersion: '3.0.0' });

        expect(mSchedule).toHaveBeenCalledWith(
            expect.objectContaining({ identifier: 'spell-created-job_n1' }),
        );
    });

    it('falls back to scheduling when getPresentedNotificationsAsync throws', async () => {
        mGetPresented.mockRejectedValue(new Error('permission denied'));
        primeHappyPathChat();

        await runCreateJob({ jobId: 'job_n1', prompt: 'p', appVersion: '3.0.0' });

        expect(mSchedule).toHaveBeenCalled();
    });
});
