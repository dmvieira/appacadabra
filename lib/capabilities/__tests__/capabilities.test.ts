// Inline mocks for native modules not covered by jest.setup.js
jest.mock('expo-speech', () => ({
    speak: jest.fn(),
    stop: jest.fn(),
    isSpeakingAsync: jest.fn(() => Promise.resolve(false)),
}));

jest.mock('expo-calendar', () => ({
    requestCalendarPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
    getCalendarsAsync: jest.fn(() => Promise.resolve([])),
    createEventAsync: jest.fn(() => Promise.resolve('event-id-1')),
    getEventsAsync: jest.fn(() => Promise.resolve([])),
    deleteEventAsync: jest.fn(() => Promise.resolve()),
    EntityTypes: { EVENT: 'event' },
}));

jest.mock('expo-contacts', () => ({
    requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
    getContactsAsync: jest.fn(() => Promise.resolve({ data: [], hasNextPage: false })),
    addContactAsync: jest.fn(() => Promise.resolve('contact-id-1')),
    presentFormAsync: jest.fn(() => Promise.resolve()),
    Fields: { Emails: 'emails', PhoneNumbers: 'phoneNumbers', Name: 'name' },
    SortTypes: { LastName: 'lastName' },
}));

jest.mock('expo-image-picker', () => ({
    requestCameraPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
    launchCameraAsync: jest.fn(() => Promise.resolve({ canceled: true })),
    launchImageLibraryAsync: jest.fn(() => Promise.resolve({ canceled: true })),
}));

jest.mock('expo-battery', () => ({
    getBatteryLevelAsync: jest.fn(() => Promise.resolve(0.8)),
    getBatteryStateAsync: jest.fn(() => Promise.resolve(1)),
    BatteryState: { CHARGING: 2, FULL: 3, UNPLUGGED: 1, UNKNOWN: 0 },
}));

jest.mock('expo-network', () => ({
    getNetworkStateAsync: jest.fn(() => Promise.resolve({ type: 'wifi', isInternetReachable: true })),
    NetworkStateType: { WIFI: 'wifi', CELLULAR: 'cellular', NONE: 'none', UNKNOWN: 'unknown' },
}));

jest.mock('expo-haptics', () => ({
    impactAsync: jest.fn(() => Promise.resolve()),
    notificationAsync: jest.fn(() => Promise.resolve()),
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

jest.mock('expo-print', () => ({
    printAsync: jest.fn(() => Promise.resolve()),
    printToFileAsync: jest.fn(() => Promise.resolve({ uri: 'file:///tmp/print.pdf' })),
}));

jest.mock('react-native-view-shot', () => ({
    captureRef: jest.fn(() => Promise.resolve('base64screenshot')),
}));

jest.mock('expo-sensors', () => ({
    Accelerometer: {
        setUpdateInterval: jest.fn(),
        addListener: jest.fn(() => ({ remove: jest.fn() })),
        removeAllListeners: jest.fn(),
    },
    Gyroscope: {
        setUpdateInterval: jest.fn(),
        addListener: jest.fn(() => ({ remove: jest.fn() })),
        removeAllListeners: jest.fn(),
    },
    Magnetometer: {
        setUpdateInterval: jest.fn(),
        addListener: jest.fn(() => ({ remove: jest.fn() })),
        removeAllListeners: jest.fn(),
    },
    Pedometer: {
        isAvailableAsync: jest.fn(() => Promise.resolve(true)),
        watchStepCount: jest.fn(() => ({ remove: jest.fn() })),
        getStepCountAsync: jest.fn(() => Promise.resolve({ steps: 100 })),
    },
}));

jest.mock('react-native-health-connect', () => ({
    initialize: jest.fn(() => Promise.resolve(true)),
    requestPermission: jest.fn(() => Promise.resolve([])),
    readRecords: jest.fn(() => Promise.resolve({ records: [] })),
    aggregateRecord: jest.fn(() => Promise.resolve({})),
    getGrantedPermissions: jest.fn(() => Promise.resolve([])),
    getSdkStatus: jest.fn(() => Promise.resolve(3)),
    SdkAvailabilityStatus: { SDK_AVAILABLE: 3 },
}));

jest.mock('react-native-health', () => ({
    __esModule: true,
    default: {
        Constants: {
            Permissions: {
                StepCount: 'StepCount',
                HeartRate: 'HeartRate',
                SleepAnalysis: 'SleepAnalysis',
                ActiveEnergyBurned: 'ActiveEnergyBurned',
                Workout: 'Workout',
            },
        },
        initHealthKit: jest.fn((_perms: any, cb: (err: string | null) => void) => cb(null as any)),
        getStepCount: jest.fn((_opts: any, cb: (err: string | null, result: { value: number }) => void) => cb(null as any, { value: 0 })),
        getDailyStepCountSamples: jest.fn((_opts: any, cb: (err: string | null, results: any[]) => void) => cb(null as any, [])),
        getHeartRateSamples: jest.fn((_opts: any, cb: (err: string | null, results: any[]) => void) => cb(null as any, [])),
        getSamples: jest.fn((_opts: any, cb: (err: string | null, results: any[]) => void) => cb(null as any, [])),
        getSleepSamples: jest.fn((_opts: any, cb: (err: string | null, results: any[]) => void) => cb(null as any, [])),
        getActiveEnergyBurned: jest.fn((_opts: any, cb: (err: string | null, results: any[]) => void) => cb(null as any, [])),
    },
}));


jest.mock('expo-linking', () => ({
    openURL: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../bridgeUIStore', () => ({
    useBridgeUIStore: {
        getState: jest.fn(() => ({
            setNativeActivityActive: jest.fn(),
            openVideoPlayer: jest.fn(),
            openScanner: jest.fn(),
            closeScanner: jest.fn(),
            requestCostEstimate: jest.fn(() => Promise.resolve(true)),
            requestKeyMissing: jest.fn(() => Promise.resolve('openSettings')),
        })),
    },
}));

jest.mock('../../api/keyStorage', () => ({
    hasOpenRouterKey: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../../store', () => ({
    useAppStore: {
        getState: jest.fn(() => ({
            currentAppId: 1,
        })),
    },
}));

jest.mock('../../database/db', () => ({
    getAlarmsForApp: jest.fn(() => Promise.resolve([])),
    saveAlarm: jest.fn(() => Promise.resolve()),
    deleteAlarm: jest.fn(() => Promise.resolve()),
    deleteAllAlarmsForApp: jest.fn(() => Promise.resolve()),
    getSetting: jest.fn(() => Promise.resolve(null)),
    setSetting: jest.fn(() => Promise.resolve()),
    getAllFormsForApp: jest.fn(() => Promise.resolve([])),
    saveForm: jest.fn(() => Promise.resolve()),
    deleteForm: jest.fn(() => Promise.resolve()),
    incrementSpendUsd: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../api/ai', () => ({
    aiGenerate: jest.fn(() => Promise.resolve({ text: 'OCR page text', usage: {}, creditsUsed: 0, costUsd: 0.001 })),
}));

jest.mock('../../api/pricing', () => ({
    estimateUsd: jest.fn(() => 0.01),
    formatUsd: jest.fn((n: number) => `$${n.toFixed(4)}`),
}));

jest.mock('../../api/modelPreferences', () => ({
    getPreferredModel: jest.fn(() => Promise.resolve('test/model')),
}));

jest.mock('mammoth/mammoth.browser.min.js', () => ({
    extractRawText: jest.fn(),
}), { virtual: true });

// react-native is already mocked by jest-expo preset.
// Stub AlarmModule and Share into NativeModules in beforeAll below.

import { ALL_CAPABILITIES, DISABLED_CAPABILITIES } from '../index';

const describeCapability = (id: string) =>
    DISABLED_CAPABILITIES.has(id) ? describe.skip : describe;
import * as Battery from 'expo-battery';
import * as Notifications from 'expo-notifications';
import * as Sharing from 'expo-sharing';
import { NativeModules, Vibration, Share } from 'react-native';

// Set up native module stubs that aren't provided by jest-expo preset
beforeAll(() => {
    // AlarmModule (used by notify.ts)
    NativeModules.AlarmModule = {
        scheduleAlarm: jest.fn(() => Promise.resolve()),
        cancelAlarm: jest.fn(() => Promise.resolve()),
    };
});

// ─── Mock HandlerContext ─────────────────────────────────────────────────────

const ctx = {
    webViewRef: { current: { injectJavaScript: jest.fn() } },
    viewContainerRef: { current: null },
    appId: 1,
    callbackName: 'cb_test',
    onJobCreated: jest.fn(),
};

// ─── Section A: Module structure ─────────────────────────────────────────────

describe(`Module structure — all ${ALL_CAPABILITIES.length} capabilities`, () => {

    it.each(ALL_CAPABILITIES)('$id — has non-empty id', (cap) => {
        expect(typeof cap.id).toBe('string');
        expect(cap.id.length).toBeGreaterThan(0);
    });

    it.each(ALL_CAPABILITIES)('$id — has non-empty displayName', (cap) => {
        expect(typeof cap.displayName).toBe('string');
        expect(cap.displayName.length).toBeGreaterThan(0);
    });

    it.each(ALL_CAPABILITIES)('$id — has valid semver minVersion', (cap) => {
        expect(cap.minVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it.each(ALL_CAPABILITIES)('$id — has non-empty docs', (cap) => {
        expect(typeof cap.docs).toBe('string');
        expect(cap.docs.length).toBeGreaterThan(0);
    });

    it.each(ALL_CAPABILITIES)('$id — has getInjectedJS function', (cap) => {
        expect(typeof cap.getInjectedJS).toBe('function');
    });

    it.each(ALL_CAPABILITIES)('$id — has handleMessage async function', (cap) => {
        expect(typeof cap.handleMessage).toBe('function');
    });

    it('all capability IDs are unique', () => {
        const ids = ALL_CAPABILITIES.map(c => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

// ─── Section B: getInjectedJS contract ───────────────────────────────────────

describe('getInjectedJS contract', () => {
    const knownIdentifiers: Record<string, string[]> = {
        clipboard: ['AppacadabraClipboard', 'setString', 'getString'],
        share: ['AppacadabraShare', 'share', 'shareFile'],
        screen: ['AppacadabraScreen', 'capture', 'print'],
        device: ['AppacadabraDevice', 'vibrate', 'getBatteryLevel'],
        calendar: ['AppacadabraCalendar', 'createEvent', 'getEvents'],
        notify: ['AppacadabraNotify', 'showNow', 'schedule'],
        health: ['AppacadabraHealth', 'getSteps', 'getHeartRate'],
        contacts: ['AppacadabraContacts', 'search', 'add'],
        sensors: ['AppacadabraSensors', 'startAccelerometer', 'startGPS'],
        ui: ['AppacadabraUI', 'showLoader', 'toast'],
        camera: ['AppacadabraCamera', 'takePhoto', 'recordVideo'],
        audio: ['AppacadabraAudio', 'recordStart', 'speak'],
        forms: ['AppacadabraForms', 'createForm', 'getResponses', 'watchResponses', 'stopWatchResponses'],
        docs: ['AppacadabraDocs', 'createDoc', 'convert', 'setDoc', 'watchDoc', 'stopWatchDoc', 'extract'],
        sheets: ['AppacadabraSheets', 'createSheet', 'appendRows', 'watchSheet', 'stopWatchSheet', 'setRows'],
        ai: ['AppacadabraAI', 'generate', 'similarity'],
    };

    it.each(ALL_CAPABILITIES)('$id — getInjectedJS returns non-empty string', (cap) => {
        const js = cap.getInjectedJS(1, false);
        expect(typeof js).toBe('string');
        expect(js.length).toBeGreaterThan(0);
    });

    it.each(ALL_CAPABILITIES)('$id — getInjectedJS contains expected identifiers', (cap) => {
        const identifiers = knownIdentifiers[cap.id] ?? [];
        const js = cap.getInjectedJS(1, false);
        for (const identifier of identifiers) {
            expect(js).toContain(identifier);
        }
    });
});

// ─── Section C: handleMessage for simple/mockable handlers ───────────────────

describeCapability('clipboard')('handleMessage — clipboard', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'clipboard')!;

    it('returns null for any message type (pure WebView API)', async () => {
        const result = await cap.handleMessage('CLIPBOARD_SET', {}, ctx);
        expect(result).toBeNull();
    });

    it('returns null for unknown type', async () => {
        const result = await cap.handleMessage('UNKNOWN', {}, ctx);
        expect(result).toBeNull();
    });
});

describeCapability('device')('handleMessage — device', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'device')!;

    it('VIBRATE: returns success for numeric pattern', async () => {
        const result = await cap.handleMessage('VIBRATE', { pattern: 200 }, ctx);
        expect(result).toMatchObject({ success: true });
        expect(result!.result).toBe('Vibrated 200ms');
    });

    it('DEVICE_IS_ONLINE: returns success with true or false string', async () => {
        const result = await cap.handleMessage('DEVICE_IS_ONLINE', {}, ctx);
        expect(result).toMatchObject({ success: true });
        expect(['true', 'false']).toContain(result!.result);
    });

    it('DEVICE_GET_BATTERY_LEVEL: returns success with battery level string', async () => {
        (Battery.getBatteryLevelAsync as jest.Mock).mockResolvedValue(0.8);
        const result = await cap.handleMessage('DEVICE_GET_BATTERY_LEVEL', {}, ctx);
        expect(result).toMatchObject({ success: true, result: '0.8' });
    });

    it('returns null for unknown type', async () => {
        const result = await cap.handleMessage('UNKNOWN_TYPE', {}, ctx);
        expect(result).toBeNull();
    });
});

describeCapability('share')('handleMessage — share', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'share')!;

    it('SHARE_CONTENT: calls Share.share and returns Shared on success', async () => {
        jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as any);
        const result = await cap.handleMessage('SHARE_CONTENT', { text: 'hello' }, ctx);
        expect(Share.share).toHaveBeenCalled();
        expect(result).toMatchObject({ success: true });
        expect(result!.result).toBe('Shared');
    });

    it('SHARE_FILE: writes base64 file and calls shareAsync', async () => {
        const { isAvailableAsync, shareAsync } = require('expo-sharing');
        (isAvailableAsync as jest.Mock).mockResolvedValue(true);
        (shareAsync as jest.Mock).mockResolvedValue(undefined);

        const result = await cap.handleMessage('SHARE_FILE', {
            base64: 'SGVsbG8=',
            mimeType: 'text/plain',
            filename: 'test.txt',
        }, ctx);
        expect(shareAsync).toHaveBeenCalled();
        expect(result).toMatchObject({ success: true });
    });

    it('returns null for unknown type', async () => {
        const result = await cap.handleMessage('UNKNOWN', {}, ctx);
        expect(result).toBeNull();
    });
});

describeCapability('notify')('handleMessage — notify', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'notify')!;

    beforeEach(() => {
        (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
        (Notifications.scheduleNotificationAsync as jest.Mock).mockResolvedValue('notif-id-123');
    });

    it('NOTIFY_SHOW_NOW: calls scheduleNotificationAsync and returns ID', async () => {
        const result = await cap.handleMessage('NOTIFY_SHOW_NOW', {
            title: 'Test',
            message: 'Hello',
        }, ctx);
        expect(Notifications.scheduleNotificationAsync).toHaveBeenCalled();
        expect(result).toMatchObject({ success: true });
    });

    it('NOTIFY_CANCEL_ALL: returns success with cancellation count message', async () => {
        const result = await cap.handleMessage('NOTIFY_CANCEL_ALL', {}, ctx);
        expect(result).toMatchObject({ success: true });
        expect(result!.result).toContain('Cancelled');
    });

    it('returns null for unknown type', async () => {
        const result = await cap.handleMessage('UNKNOWN', {}, ctx);
        expect(result).toBeNull();
    });
});

// ─── Section D: additional handler tests (Phase 2) ────────────────────────────

describeCapability('screen')('handleMessage — screen', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'screen')!;

    it('PRINT with html: calls printAsync and returns Print dialog opened', async () => {
        const { printAsync } = require('expo-print');
        (printAsync as jest.Mock).mockResolvedValue(undefined);
        const result = await cap.handleMessage('PRINT', { html: '<h1>Test</h1>' }, ctx);
        expect(printAsync).toHaveBeenCalled();
        expect(result).toMatchObject({ success: true, result: 'Print dialog opened' });
    });

    it('PRINT without html: returns failure', async () => {
        const result = await cap.handleMessage('PRINT', {}, ctx);
        expect(result).toMatchObject({ success: false });
    });

    it('SCREEN_CAPTURE with valid webViewRef: returns base64 image', async () => {
        const { captureRef } = require('react-native-view-shot');
        (captureRef as jest.Mock).mockResolvedValue('base64screenshot');
        const result = await cap.handleMessage('SCREEN_CAPTURE', {}, ctx);
        expect(result).toMatchObject({ success: true });
    });

    it('SCREEN_CAPTURE with null refs: returns capture target not available', async () => {
        const noRefCtx = { ...ctx, webViewRef: { current: null }, viewContainerRef: { current: null } };
        const result = await cap.handleMessage('SCREEN_CAPTURE', {}, noRefCtx);
        expect(result).toMatchObject({ success: false, result: 'Capture target not available' });
    });

    it('returns null for unknown type', async () => {
        const cap2 = ALL_CAPABILITIES.find(c => c.id === 'screen')!;
        const result = await cap2.handleMessage('UNKNOWN', {}, ctx);
        expect(result).toBeNull();
    });
});

describeCapability('ui')('handleMessage — ui', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'ui')!;

    it('UI_SHOW_LOADER: returns null (pure WebView API)', async () => {
        const result = await cap.handleMessage('UI_SHOW_LOADER', {}, ctx);
        expect(result).toBeNull();
    });

    it('returns null for any unknown type', async () => {
        const result = await cap.handleMessage('UNKNOWN', {}, ctx);
        expect(result).toBeNull();
    });
});

describeCapability('calendar')('handleMessage — calendar', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'calendar')!;

    it('CALENDAR_CREATE_EVENT: calls Linking.openURL and returns Calendar opened', async () => {
        const { openURL } = require('expo-linking');
        (openURL as jest.Mock).mockResolvedValue(undefined);
        const result = await cap.handleMessage('CALENDAR_CREATE_EVENT', {
            title: 'Test Event',
            description: 'Test',
            startTimeMs: Date.now(),
            endTimeMs: Date.now() + 3600000,
        }, ctx);
        expect(openURL).toHaveBeenCalled();
        expect(result).toMatchObject({ success: true, result: 'Calendar opened' });
    });

    it('CALENDAR_GET_EVENTS: returns empty array when no calendars found', async () => {
        const result = await cap.handleMessage('CALENDAR_GET_EVENTS', {
            startTimeMs: Date.now(),
            endTimeMs: Date.now() + 86400000,
        }, ctx);
        expect(result).toMatchObject({ success: true });
    });

    it('returns null for unknown type', async () => {
        const cap2 = ALL_CAPABILITIES.find(c => c.id === 'calendar')!;
        const result = await cap2.handleMessage('UNKNOWN', {}, ctx);
        expect(result).toBeNull();
    });
});

describeCapability('contacts')('handleMessage — contacts', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'contacts')!;

    it('CONTACTS_SEARCH: calls getContactsAsync and returns contacts list', async () => {
        const Contacts = require('expo-contacts');
        const result = await cap.handleMessage('CONTACTS_SEARCH', { query: 'John' }, ctx);
        expect(Contacts.getContactsAsync).toHaveBeenCalled();
        expect(result).toMatchObject({ success: true });
    });

    it('returns null for unknown type', async () => {
        const cap2 = ALL_CAPABILITIES.find(c => c.id === 'contacts')!;
        const result = await cap2.handleMessage('UNKNOWN', {}, ctx);
        expect(result).toBeNull();
    });
});

describeCapability('sensors')('handleMessage — sensors', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'sensors')!;

    it('SENSORS_STOP_ALL: removes all listeners and returns success', async () => {
        const result = await cap.handleMessage('SENSORS_STOP_ALL', {}, ctx);
        expect(result).toMatchObject({ success: true });
    });

    it('SENSORS_STOP_PEDOMETER without active session: returns success', async () => {
        const result = await cap.handleMessage('SENSORS_STOP_PEDOMETER', {}, ctx);
        expect(result).toMatchObject({ success: true });
    });

    it('SENSORS_STOP_ACCELEROMETER: removes listeners and returns success', async () => {
        const result = await cap.handleMessage('SENSORS_STOP_ACCELEROMETER', {}, ctx);
        expect(result).toMatchObject({ success: true });
    });

    it('returns null for unknown type', async () => {
        const cap2 = ALL_CAPABILITIES.find(c => c.id === 'sensors')!;
        const result = await cap2.handleMessage('UNKNOWN', {}, ctx);
        expect(result).toBeNull();
    });
});

describeCapability('health')('handleMessage — health', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'health')!;

    it('HEALTH_INITIALIZE: returns success without native calls', async () => {
        const result = await cap.handleMessage('HEALTH_INITIALIZE', {}, ctx);
        // Platform-tolerant: Android variant returns 'Health Connect initialized',
        // iOS variant returns 'HealthKit initialized'. Both are valid.
        expect(result).toMatchObject({ success: true });
        expect(result?.result).toMatch(/initialized/);
    });

    it('HEALTH_GET_STEPS: returns step data when SDK is available', async () => {
        const result = await cap.handleMessage('HEALTH_GET_STEPS', {
            startTimeMs: Date.now() - 86400000,
            endTimeMs: Date.now(),
        }, ctx);
        expect(result).toMatchObject({ success: true });
    });

    it('returns null for unknown type', async () => {
        const cap2 = ALL_CAPABILITIES.find(c => c.id === 'health')!;
        const result = await cap2.handleMessage('UNKNOWN', {}, ctx);
        expect(result).toBeNull();
    });
});

describeCapability('camera')('handleMessage — camera', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'camera')!;

    it('VIDEO_STOP without active sound: returns Stopped', async () => {
        const result = await cap.handleMessage('VIDEO_STOP', {}, ctx);
        expect(result).toMatchObject({ success: true, result: 'Stopped' });
    });

    it('VIDEO_IS_PLAYING without active sound: returns false string', async () => {
        const result = await cap.handleMessage('VIDEO_IS_PLAYING', {}, ctx);
        expect(result).toMatchObject({ success: true, result: 'false' });
    });

    it('returns null for unknown type', async () => {
        const cap2 = ALL_CAPABILITIES.find(c => c.id === 'camera')!;
        const result = await cap2.handleMessage('UNKNOWN', {}, ctx);
        expect(result).toBeNull();
    });
});

describeCapability('audio')('handleMessage — audio', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'audio')!;

    it('TTS_SPEAK with text: calls Speech.speak and returns Speaking', async () => {
        const Speech = require('expo-speech');
        const result = await cap.handleMessage('TTS_SPEAK', { text: 'Hello world' }, ctx);
        expect(Speech.speak).toHaveBeenCalledWith('Hello world', expect.any(Object));
        expect(result).toMatchObject({ success: true, result: 'Speaking' });
    });

    it('TTS_STOP: calls Speech.stop and returns Stopped', async () => {
        const Speech = require('expo-speech');
        const result = await cap.handleMessage('TTS_STOP', {}, ctx);
        expect(Speech.stop).toHaveBeenCalled();
        expect(result).toMatchObject({ success: true, result: 'Stopped' });
    });

    it('TTS_SPEAK without text: returns failure', async () => {
        const result = await cap.handleMessage('TTS_SPEAK', {}, ctx);
        expect(result).toMatchObject({ success: false });
    });

    it('returns null for unknown type', async () => {
        const cap2 = ALL_CAPABILITIES.find(c => c.id === 'audio')!;
        const result = await cap2.handleMessage('UNKNOWN', {}, ctx);
        expect(result).toBeNull();
    });
});

describeCapability('notify')('handleMessage — notify (additional)', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'notify')!;

    beforeEach(() => {
        (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
    });

    it('NOTIFY_HAS_PERMISSION: returns true when permission granted', async () => {
        const result = await cap.handleMessage('NOTIFY_HAS_PERMISSION', {}, ctx);
        expect(result).toMatchObject({ success: true, result: 'true' });
    });
});

// ─── Section E: error path tests (Phase 3) ────────────────────────────────────

describeCapability('device')('error paths — device', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'device')!;

    it('DEVICE_GET_BATTERY_LEVEL when getBatteryLevelAsync throws: returns failure', async () => {
        (Battery.getBatteryLevelAsync as jest.Mock).mockRejectedValueOnce(new Error('Battery unavailable'));
        const result = await cap.handleMessage('DEVICE_GET_BATTERY_LEVEL', {}, ctx);
        expect(result).toMatchObject({ success: false });
    });
});

describeCapability('share')('error paths — share', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'share')!;

    it('SHARE_CONTENT when Share.share throws: returns failure', async () => {
        jest.spyOn(Share, 'share').mockRejectedValueOnce(new Error('Share failed'));
        const result = await cap.handleMessage('SHARE_CONTENT', { text: 'hello' }, ctx);
        expect(result).toMatchObject({ success: false });
    });
});

describeCapability('notify')('error paths — notify', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'notify')!;

    it('NOTIFY_SHOW_NOW when permission denied: returns permission denied failure', async () => {
        (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied' });
        (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied' });
        const result = await cap.handleMessage('NOTIFY_SHOW_NOW', { title: 'Test', message: 'Hi' }, ctx);
        expect(result).toMatchObject({ success: false, result: 'Notification permission denied' });
    });
});

// ─── Section F/G/H: Google capability sync tests (sheets, docs, forms) ────────

jest.mock('../../firebase', () => ({ requestGoogleScopes: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({
    readAsStringAsync: jest.fn(() => Promise.resolve('base64pdfcontent')),
    writeAsStringAsync: jest.fn(() => Promise.resolve()),
    deleteAsync: jest.fn(() => Promise.resolve()),
    EncodingType: { Base64: 'base64' },
    cacheDirectory: 'file:///cache/',
    documentDirectory: 'file:///documents/',
}));

import { computeDiff, activeWatchers as sheetsWatchers, resourceCache as sheetsCache, writeQueue as sheetsQueue } from '../sheets';
import { activeWatchers as docsWatchers, resourceCache as docsCache, writeQueue as docsQueue } from '../docs';
import { activeWatchers as formsWatchers, resourceCache as formsCache } from '../forms';

const { requestGoogleScopes } = require('../../firebase');

// Helper: build a minimal fetch mock response
const mockFetchOk = (body: any) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve('') } as any);

// Flush all pending microtasks (for async chains with multiple awaits)
const flushPromises = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// Extract and parse the JSON payload from a createCallbackScript output
function parseInjectedPayload(injectedScript: string): any {
    const match = injectedScript.match(/var __d = "([\s\S]*?)";/);
    if (!match) return null;
    try { return JSON.parse(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')); } catch { return null; }
}

describe('Google capabilities — sync (sheets, docs, forms)', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        (global.fetch as jest.Mock) = jest.fn();
        requestGoogleScopes.mockResolvedValue('fake-token');
        sheetsWatchers.clear();
        sheetsCache.clear();
        sheetsQueue.length = 0;
        docsWatchers.clear();
        docsCache.clear();
        docsQueue.length = 0;
        formsWatchers.clear();
        formsCache.clear();
    });

    afterEach(() => {
        sheetsWatchers.forEach(w => clearInterval(w.interval));
        sheetsWatchers.clear();
        docsWatchers.forEach(w => clearInterval(w.interval));
        docsWatchers.clear();
        formsWatchers.forEach(w => clearInterval(w.interval));
        formsWatchers.clear();
        jest.useRealTimers();
    });

    describeCapability('sheets')('handleMessage — sheets', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'sheets')!;

    it('SHEETS_CREATE: creates sheet and returns sheetId + url', async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk({ spreadsheetId: 'sid-1' })); // create
        const result = await cap.handleMessage('SHEETS_CREATE', { title: 'My Sheet', headers: [] }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any)).toMatchObject({ sheetId: 'sid-1' });
    });

    it('SHEETS_GET_ROWS: parses headers and row objects', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({
            values: [['Name', 'Age'], ['Alice', '30'], ['Bob', '25']],
        }));
        const result = await cap.handleMessage('SHEETS_GET_ROWS', { sheetId: 'sid-1' }, ctx);
        expect(result).toMatchObject({ success: true });
        const parsed = (result!.result! as any);
        expect(parsed.headers).toEqual(['Name', 'Age']);
        expect(parsed.rows).toEqual([{ Name: 'Alice', Age: '30' }, { Name: 'Bob', Age: '25' }]);
    });

    it('SHEETS_GET_ROWS: returns empty arrays when sheet is empty', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({ values: [] }));
        const result = await cap.handleMessage('SHEETS_GET_ROWS', { sheetId: 'sid-empty' }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any)).toEqual({ headers: [], rows: [] });
    });

    it('SHEETS_APPEND_ROWS: appends rows and returns updatedRows', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({ updates: { updatedRows: 2 } }));
        const result = await cap.handleMessage('SHEETS_APPEND_ROWS', {
            sheetId: 'sid-1', rows: [['Alice', '30'], ['Bob', '25']],
        }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any)).toMatchObject({ updatedRows: 2 });
    });

    it('SHEETS_APPEND_ROWS: empty rows array returns 0 without fetch', async () => {
        const result = await cap.handleMessage('SHEETS_APPEND_ROWS', { sheetId: 'sid-1', rows: [] }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any)).toMatchObject({ updatedRows: 0 });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('SHEETS_SET_ROWS: writes headers + rows and returns rowsWritten', async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk({ values: [['Name', 'Age']] })) // GET headers
            .mockResolvedValueOnce(mockFetchOk({}))  // clear
            .mockResolvedValueOnce(mockFetchOk({})); // append
        const rows = [{ Name: 'Alice', Age: '30' }];
        const result = await cap.handleMessage('SHEETS_SET_ROWS', { sheetId: 'sid-1', rows }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any)).toMatchObject({ rowsWritten: 1 });
    });

    it('SHEETS_SET_ROWS: updates active watcher snapshot', async () => {
        // Set up a fake watcher for this key
        const fakeInterval = setInterval(() => {}, 99999);
        sheetsWatchers.set('1_sid-watch', {
            interval: fakeInterval,
            webViewRef: ctx.webViewRef as any,
            callbackName: 'onChange',
            snapshot: [{ Name: 'Old', Age: '10' }],
        });
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk({ values: [['Name', 'Age']] }))
            .mockResolvedValueOnce(mockFetchOk({}))
            .mockResolvedValueOnce(mockFetchOk({}));
        const rows = [{ Name: 'Alice', Age: '30' }];
        await cap.handleMessage('SHEETS_SET_ROWS', { sheetId: 'sid-watch', rows }, ctx);
        expect(sheetsWatchers.get('1_sid-watch')?.snapshot).toEqual(rows);
        clearInterval(fakeInterval);
    });

    it('SHEETS_WATCH: immediate callback with initial:true', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({
            values: [['Name'], ['Alice']],
        }));
        const injectSpy = ctx.webViewRef.current!.injectJavaScript as jest.Mock;
        injectSpy.mockClear();

        const result = await cap.handleMessage('SHEETS_WATCH',
            { sheetId: 'sid-1', intervalMs: 5000, callbackName: 'onChanged' }, ctx);
        expect(result).toMatchObject({ success: true, deferredCallback: true });

        await flushPromises();

        expect(injectSpy).toHaveBeenCalled();
        const payload = parseInjectedPayload(injectSpy.mock.calls[0][0] as string);
        expect(payload.initial).toBe(true);
        expect(payload.headers).toContain('Name');
    });

    it('SHEETS_WATCH: poll fires when external change detected', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({ values: [['Name'], ['Alice']] }));
        const injectSpy = ctx.webViewRef.current!.injectJavaScript as jest.Mock;
        injectSpy.mockClear();

        await cap.handleMessage('SHEETS_WATCH', { sheetId: 'sid-2', intervalMs: 5000, callbackName: 'onChanged' }, ctx);
        await flushPromises();
        injectSpy.mockClear();

        // External change: Bob added
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({ values: [['Name'], ['Alice'], ['Bob']] }));
        jest.advanceTimersByTime(5000);
        await flushPromises();

        expect(injectSpy).toHaveBeenCalled();
        const payload = parseInjectedPayload(injectSpy.mock.calls[0][0] as string);
        expect(payload.initial).toBe(false);
        expect(payload.rows.some((r: any) => r.Name === 'Bob')).toBe(true);
    });

    it('SHEETS_WATCH: poll after setRows does not re-fire', async () => {
        const rows = [{ Name: 'Alice', Age: '30' }];
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({ values: [['Name', 'Age'], ['Alice', '30']] }));
        const injectSpy = ctx.webViewRef.current!.injectJavaScript as jest.Mock;

        await cap.handleMessage('SHEETS_WATCH', { sheetId: 'sid-3', intervalMs: 5000, callbackName: 'onChanged' }, ctx);
        await flushPromises();

        // After initial poll, snapshot is updated; simulate what setRows also does
        const watcher = sheetsWatchers.get('1_sid-3');
        if (watcher) watcher.snapshot = rows;
        injectSpy.mockClear();

        // Poll returns identical data
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({ values: [['Name', 'Age'], ['Alice', '30']] }));
        jest.advanceTimersByTime(5000);
        await flushPromises();

        expect(injectSpy).not.toHaveBeenCalled();
    });

    it('SHEETS_WATCH re-watch: does not fire callback when data unchanged', async () => {
        const rows = [['Name', 'Age'], ['Alice', '30']];
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({ values: rows }));
        const injectSpy = ctx.webViewRef.current!.injectJavaScript as jest.Mock;

        // First watch — populates snapshot
        await cap.handleMessage('SHEETS_WATCH', { sheetId: 'sid-rewatch', intervalMs: 5000, callbackName: 'onChanged' }, ctx);
        await flushPromises();
        injectSpy.mockClear();

        // Re-watch with identical data
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({ values: rows }));
        await cap.handleMessage('SHEETS_WATCH', { sheetId: 'sid-rewatch', intervalMs: 5000, callbackName: 'onChanged' }, ctx);
        await flushPromises();

        expect(injectSpy).not.toHaveBeenCalled();
    });

    it('SHEETS_WATCH re-watch: fires callback with diff when data changed', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({
            values: [['Name', 'Age'], ['Alice', '30']],
        }));
        const injectSpy = ctx.webViewRef.current!.injectJavaScript as jest.Mock;

        // First watch
        await cap.handleMessage('SHEETS_WATCH', { sheetId: 'sid-rewatch2', intervalMs: 5000, callbackName: 'onChanged' }, ctx);
        await flushPromises();
        injectSpy.mockClear();

        // Re-watch with changed data (Bob added)
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({
            values: [['Name', 'Age'], ['Alice', '30'], ['Bob', '25']],
        }));
        await cap.handleMessage('SHEETS_WATCH', { sheetId: 'sid-rewatch2', intervalMs: 5000, callbackName: 'onChanged' }, ctx);
        await flushPromises();

        expect(injectSpy).toHaveBeenCalled();
        const payload = parseInjectedPayload(injectSpy.mock.calls[0][0] as string);
        expect(payload.initial).toBe(false);
        expect(payload.rows.some((r: any) => r.Name === 'Bob')).toBe(true);
        expect(payload.added).toEqual([{ Name: 'Bob', Age: '25' }]);
    });

    it('SHEETS_WATCH re-watch: preserves snapshot from previous watcher', async () => {
        const initialRows = [{ Name: 'Alice', Age: '30' }];
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({
            values: [['Name', 'Age'], ['Alice', '30']],
        }));

        // First watch — builds snapshot
        await cap.handleMessage('SHEETS_WATCH', { sheetId: 'sid-snap', intervalMs: 5000, callbackName: 'onChanged' }, ctx);
        await flushPromises();

        // Re-watch with same data — snapshot must be carried over to new watcher entry
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({
            values: [['Name', 'Age'], ['Alice', '30']],
        }));
        await cap.handleMessage('SHEETS_WATCH', { sheetId: 'sid-snap', intervalMs: 5000, callbackName: 'onChanged' }, ctx);

        // Before doPoll completes, snapshot should already be the preserved one
        const watcher = sheetsWatchers.get('1_sid-snap');
        expect(watcher?.snapshot).toEqual(initialRows);

        await flushPromises();
    });

    it('SHEETS_STOP_WATCH: clears interval and returns stopped:true', async () => {
        const fakeInterval = setInterval(() => {}, 99999);
        sheetsWatchers.set('1_sid-stop', {
            interval: fakeInterval,
            webViewRef: ctx.webViewRef as any,
            callbackName: 'onChanged',
            snapshot: null,
        });
        const result = await cap.handleMessage('SHEETS_STOP_WATCH', { sheetId: 'sid-stop' }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any)).toMatchObject({ stopped: true });
        expect(sheetsWatchers.has('1_sid-stop')).toBe(false);
    });

    it('computeDiff: detects changed rows by index comparison', () => {
        const prev = [{ Name: 'Alice', Age: '30' }, { Name: 'Bob', Age: '25' }];
        const next = [{ Name: 'Alice', Age: '31' }, { Name: 'Bob', Age: '25' }];
        const diff = computeDiff(prev, next);
        expect(diff.changed).toEqual([{ Name: 'Alice', Age: '31' }]);
        expect(diff.changed.length).toBe(1);
        expect(diff.deleted.length).toBe(0);
        expect(diff.added.length).toBe(0);
    });

    it('computeDiff: detects additions and deletions by length', () => {
        const prev = [{ Name: 'Alice' }];
        const next = [{ Name: 'Alice' }, { Name: 'Bob' }, { Name: 'Charlie' }];
        const diff = computeDiff(prev, next);
        expect(diff.added).toEqual([{ Name: 'Bob' }, { Name: 'Charlie' }]);
        expect(diff.deleted).toEqual([]);
        expect(diff.changed).toEqual([]); // Alice unchanged
    });

    it('null token: returns failure', async () => {
        requestGoogleScopes.mockResolvedValueOnce(null);
        const result = await cap.handleMessage('SHEETS_GET_ROWS', { sheetId: 'sid-1' }, ctx);
        expect(result).toMatchObject({ success: false });
    });

    it('SHEETS_GET_ROWS offline with cache: returns cached data', async () => {
        sheetsCache.set('sid-cached', { headers: ['X'], rows: [{ X: '1' }] });
        (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));
        const result = await cap.handleMessage('SHEETS_GET_ROWS', { sheetId: 'sid-cached' }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any).cached).toBe(true);
    });

    it('SHEETS_GET_ROWS offline without cache: returns offline:true', async () => {
        (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));
        const result = await cap.handleMessage('SHEETS_GET_ROWS', { sheetId: 'sid-nocache' }, ctx);
        expect(result).toMatchObject({ success: false });
        expect((result!.result! as any).offline).toBe(true);
    });

    it('SHEETS_SET_ROWS offline: queues write and returns queued:true', async () => {
        (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));
        const result = await cap.handleMessage('SHEETS_SET_ROWS', { sheetId: 'sid-q', rows: [{ X: '1' }] }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any).queued).toBe(true);
        expect(sheetsQueue.length).toBe(1);
    });

    it('returns null for unknown type', async () => {
        const result = await cap.handleMessage('UNKNOWN', {}, ctx);
        expect(result).toBeNull();
    });
});

// ─── Section G: docs — watch + setDoc ────────────────────────────────────────

describeCapability('docs')('handleMessage — docs', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'docs')!;

    it('DOCS_CREATE: creates doc and returns docId + url', async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk({ documentId: 'doc-1' }));
        const result = await cap.handleMessage('DOCS_CREATE', { title: 'My Doc', content: '' }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any)).toMatchObject({ docId: 'doc-1' });
    });

    it('DOCS_GET: returns title and content', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({
            title: 'Test Doc',
            body: { content: [{ paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [{ textRun: { content: 'Hello\n' } }] } }] },
        }));
        const result = await cap.handleMessage('DOCS_GET', { docId: 'doc-1' }, ctx);
        expect(result).toMatchObject({ success: true });
        const parsed = (result!.result! as any);
        expect(parsed.title).toBe('Test Doc');
        expect(typeof parsed.content).toBe('string');
    });

    it('DOCS_APPEND_TEXT: appends text to doc', async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk({ title: 'Doc', body: { content: [{ endIndex: 5 }] } })) // GET for endIndex
            .mockResolvedValueOnce(mockFetchOk({}))   // batchUpdate append
            .mockResolvedValueOnce(mockFetchOk({ title: 'Doc', body: { content: [] } })); // GET for snapshot update
        const result = await cap.handleMessage('DOCS_APPEND_TEXT', { docId: 'doc-1', text: 'New text' }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any)).toMatchObject({ docId: 'doc-1' });
    });

    // ─── CONVERT: content correctness ────────────────────────────────────────

    it('CONVERT markdown→html: produces HTML tags for headings and paragraphs', async () => {
        const result = await cap.handleMessage('CONVERT', {
            from: 'markdown', to: 'html',
            content: '# Title\n\nParagraph with **bold** and *italic*.\n\n- item A\n- item B',
        }, ctx);
        expect(result).toMatchObject({ success: true });
        expect(result!.deferredCallback).toBeFalsy(); // callback must fire from runner
        const html = result!.result!;
        expect(html).toMatch(/<h1[^>]*>/i);
        expect(html).toMatch(/<strong[^>]*>/i);
        expect(html).toMatch(/<em[^>]*>/i);
        expect(html).toMatch(/<ul[^>]*>/i);
        expect(html).toContain('Title');
        expect(html).toContain('bold');
    });

    it('CONVERT html→markdown: produces atx headings and preserves text', async () => {
        const result = await cap.handleMessage('CONVERT', {
            from: 'html', to: 'markdown',
            content: '<h1>Title</h1><p>Para with <strong>bold</strong> and <em>italic</em>.</p><ul><li>A</li><li>B</li></ul>',
        }, ctx);
        expect(result).toMatchObject({ success: true });
        expect(result!.deferredCallback).toBeFalsy(); // callback must fire from runner
        const md = result!.result!;
        expect(md).toMatch(/^# Title/m);
        expect(md).toContain('**bold**');
        expect(md).toContain('*italic*');
        expect(md).toMatch(/-\s+A/);
        expect(md).toMatch(/-\s+B/);
    });

    it('CONVERT html→markdown: strips script and style tags', async () => {
        const result = await cap.handleMessage('CONVERT', {
            from: 'html', to: 'markdown',
            content: '<script>alert("xss")</script><p>Safe text</p><style>body{color:red}</style>',
        }, ctx);
        expect(result).toMatchObject({ success: true });
        const md = result!.result!;
        expect(md).not.toContain('alert');
        expect(md).not.toContain('color:red');
        expect(md).toContain('Safe text');
    });

    it('CONVERT html→markdown roundtrip: markdown→html→markdown preserves structure', async () => {
        const original = '# Heading\n\nParagraph with **bold** text.\n\n- item one\n- item two';
        const toHtml = await cap.handleMessage('CONVERT', { from: 'markdown', to: 'html', content: original }, ctx);
        expect(toHtml).toMatchObject({ success: true });
        const backToMd = await cap.handleMessage('CONVERT', { from: 'html', to: 'markdown', content: toHtml!.result! }, ctx);
        expect(backToMd).toMatchObject({ success: true });
        const md = backToMd!.result!;
        expect(md).toMatch(/^# Heading/m);
        expect(md).toContain('bold');
        expect(md).toContain('item one');
    });

    it('CONVERT markdown→pdf: returns non-empty base64 and no deferredCallback', async () => {
        const result = await cap.handleMessage('CONVERT', { from: 'markdown', to: 'pdf', content: '# Hello\n\nWorld' }, ctx);
        expect(result).toMatchObject({ success: true });
        expect(result!.deferredCallback).toBeFalsy();
        expect(result!.result!.length).toBeGreaterThan(0);
    });

    it('CONVERT html→pdf: returns non-empty base64 and no deferredCallback', async () => {
        const result = await cap.handleMessage('CONVERT', { from: 'html', to: 'pdf', content: '<h1>Hello</h1><p>World</p>' }, ctx);
        expect(result).toMatchObject({ success: true });
        expect(result!.deferredCallback).toBeFalsy();
        expect(result!.result!.length).toBeGreaterThan(0);
    });

    it('CONVERT empty content: returns error', async () => {
        const result = await cap.handleMessage('CONVERT', { from: 'html', to: 'markdown', content: '' }, ctx);
        expect(result).toMatchObject({ success: false });
    });

    it('CONVERT missing content: returns error', async () => {
        const result = await cap.handleMessage('CONVERT', { from: 'html', to: 'markdown' }, ctx);
        expect(result).toMatchObject({ success: false });
    });

    it('CONVERT unsupported format: returns error with message', async () => {
        const result = await cap.handleMessage('CONVERT', { from: 'markdown', to: 'docx', content: 'text' }, ctx);
        expect(result).toMatchObject({ success: false });
        expect(result!.result).toContain('docx');
    });

    it('CONVERT does not call injectJavaScript — callback is fired by runner', async () => {
        const injectSpy = ctx.webViewRef.current!.injectJavaScript as jest.Mock;
        injectSpy.mockClear();
        await cap.handleMessage('CONVERT', { from: 'html', to: 'markdown', content: '<p>test</p>' }, ctx);
        // The capability itself must NOT inject the callback — that is the runner's responsibility
        expect(injectSpy).not.toHaveBeenCalled();
    });

    it('DOCS_SET: replaces doc content and returns docId', async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk({ title: 'Doc', body: { content: [{ endIndex: 10 }] } })) // GET for endIndex
            .mockResolvedValueOnce(mockFetchOk({}))   // batchUpdate (delete+insert)
            .mockResolvedValueOnce(mockFetchOk({ title: 'Doc', body: { content: [] } })); // GET for snapshot update
        const result = await cap.handleMessage('DOCS_SET', { docId: 'doc-1', content: '# New' }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any)).toMatchObject({ docId: 'doc-1' });
    });

    it('DOCS_SET on empty doc (endIndex ≤ 2): skips deleteContentRange', async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk({ title: 'Empty', body: { content: [{ endIndex: 1 }] } })) // GET
            .mockResolvedValueOnce(mockFetchOk({}))   // batchUpdate (insert only)
            .mockResolvedValueOnce(mockFetchOk({ title: 'Empty', body: { content: [] } })); // snapshot GET
        const result = await cap.handleMessage('DOCS_SET', { docId: 'doc-empty', content: 'Hello' }, ctx);
        expect(result).toMatchObject({ success: true });
        // Verify deleteContentRange was NOT sent (body of batchUpdate should only have insert)
        const batchCall = (global.fetch as jest.Mock).mock.calls[1];
        const body = JSON.parse(batchCall[1].body);
        expect(body.requests.every((r: any) => !r.deleteContentRange)).toBe(true);
    });

    it('DOCS_SET: updates active watcher snapshot', async () => {
        const fakeInterval = setInterval(() => {}, 99999);
        docsWatchers.set('1_doc-w', {
            interval: fakeInterval,
            webViewRef: ctx.webViewRef as any,
            callbackName: 'onChange',
            snapshot: { title: 'Old', content: 'Old content' },
        });
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk({ title: 'Doc', body: { content: [{ endIndex: 5 }] } }))
            .mockResolvedValueOnce(mockFetchOk({}))
            .mockResolvedValueOnce(mockFetchOk({ title: 'New', body: { content: [{ paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [{ textRun: { content: 'New content\n' } }] } }] } }));
        await cap.handleMessage('DOCS_SET', { docId: 'doc-w', content: 'New content' }, ctx);
        const snap = docsWatchers.get('1_doc-w')?.snapshot;
        expect(snap?.title).toBe('New');
        clearInterval(fakeInterval);
    });

    it('DOCS_WATCH: immediate callback with initial:true', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({
            title: 'My Doc',
            body: { content: [{ paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [{ textRun: { content: 'Hello\n' } }] } }] },
        }));
        const injectSpy = ctx.webViewRef.current!.injectJavaScript as jest.Mock;
        injectSpy.mockClear();

        const result = await cap.handleMessage('DOCS_WATCH',
            { docId: 'doc-1', intervalMs: 10000, callbackName: 'onDocChanged' }, ctx);
        expect(result).toMatchObject({ success: true, deferredCallback: true });

        await flushPromises();

        expect(injectSpy).toHaveBeenCalled();
        const payload = parseInjectedPayload(injectSpy.mock.calls[0][0] as string);
        expect(payload.initial).toBe(true);
        expect(payload.title).toBe('My Doc');
    });

    it('DOCS_WATCH: poll detects external content change', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({ title: 'Doc', body: { content: [] } }));
        const injectSpy = ctx.webViewRef.current!.injectJavaScript as jest.Mock;
        injectSpy.mockClear();

        await cap.handleMessage('DOCS_WATCH', { docId: 'doc-poll', intervalMs: 10000, callbackName: 'onDocChanged' }, ctx);
        await flushPromises();
        injectSpy.mockClear();

        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({
            title: 'Doc Updated',
            body: { content: [{ paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [{ textRun: { content: 'New!\n' } }] } }] },
        }));
        jest.advanceTimersByTime(10000);
        await flushPromises();

        expect(injectSpy).toHaveBeenCalled();
        const payload = parseInjectedPayload(injectSpy.mock.calls[0][0] as string);
        expect(payload.initial).toBe(false);
        expect(payload.title).toBe('Doc Updated');
    });

    it('DOCS_WATCH: poll after appendText does not re-fire', async () => {
        const docBody = { content: [{ paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [{ textRun: { content: 'Hello\n' } }] } }] };
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({ title: 'Doc', body: docBody }));
        const injectSpy = ctx.webViewRef.current!.injectJavaScript as jest.Mock;

        await cap.handleMessage('DOCS_WATCH', { docId: 'doc-ap', intervalMs: 10000, callbackName: 'onDoc' }, ctx);
        await flushPromises(); // snapshot is now { title: 'Doc', content: 'Hello' }
        injectSpy.mockClear();

        // Poll returns same data — snapshot matches, should not fire
        (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk({ title: 'Doc', body: docBody }));
        jest.advanceTimersByTime(10000);
        await flushPromises();

        expect(injectSpy).not.toHaveBeenCalled();
    });

    it('DOCS_STOP_WATCH: clears interval and returns stopped:true', async () => {
        const fakeInterval = setInterval(() => {}, 99999);
        docsWatchers.set('1_doc-stop', {
            interval: fakeInterval,
            webViewRef: ctx.webViewRef as any,
            callbackName: 'onChange',
            snapshot: null,
        });
        const result = await cap.handleMessage('DOCS_STOP_WATCH', { docId: 'doc-stop' }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any)).toMatchObject({ stopped: true });
        expect(docsWatchers.has('1_doc-stop')).toBe(false);
    });

    it('DOCS_GET offline with cache: returns cached data with cached:true', async () => {
        docsCache.set('doc-c', { title: 'Cached Doc', content: 'old content' });
        (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));
        const result = await cap.handleMessage('DOCS_GET', { docId: 'doc-c' }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any).cached).toBe(true);
    });

    it('DOCS_GET offline without cache: returns offline:true', async () => {
        (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));
        const result = await cap.handleMessage('DOCS_GET', { docId: 'doc-nocache' }, ctx);
        expect(result).toMatchObject({ success: false });
        expect((result!.result! as any).offline).toBe(true);
    });

    it('DOCS_SET offline: queues write and returns queued:true', async () => {
        (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));
        const result = await cap.handleMessage('DOCS_SET', { docId: 'doc-q', content: 'Hello' }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any).queued).toBe(true);
        expect(docsQueue.length).toBe(1);
    });

    it('null token: returns failure', async () => {
        requestGoogleScopes.mockResolvedValueOnce(null);
        const result = await cap.handleMessage('DOCS_GET', { docId: 'doc-1' }, ctx);
        expect(result).toMatchObject({ success: false });
    });

    // ─── DOCS_EXTRACT ───────────────────────────────────────────────────────

    describe('DOCS_EXTRACT', () => {
        const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');
        const mammoth = require('mammoth/mammoth.browser.min.js');
        const aiApi = require('../../api/ai');
        const bridgeStore = require('../../bridgeUIStore');
        const keyStorage = require('../../api/keyStorage');
        const dbMod = require('../../database/db');

        beforeEach(() => {
            (mammoth.extractRawText as jest.Mock).mockReset();
            (aiApi.aiGenerate as jest.Mock).mockClear();
            (dbMod.incrementSpendUsd as jest.Mock).mockClear();
            (keyStorage.hasOpenRouterKey as jest.Mock).mockResolvedValue(true);
        });

        it('extracts UTF-8 text from text/plain', async () => {
            const result = await cap.handleMessage('DOCS_EXTRACT',
                { base64: b64('Hello, world!'), mimeType: 'text/plain' }, ctx);
            expect(result).toMatchObject({ success: true, result: 'Hello, world!' });
        });

        it('extracts markdown from text/markdown', async () => {
            const result = await cap.handleMessage('DOCS_EXTRACT',
                { base64: b64('# Title\n\nBody'), mimeType: 'text/markdown' }, ctx);
            expect(result).toMatchObject({ success: true, result: '# Title\n\nBody' });
        });

        it('accepts a data URI payload (strips prefix in handler input path)', async () => {
            // The handler itself expects raw base64; the injectedJS strips data: prefix.
            // Directly here we send raw base64 to confirm the byte path.
            const result = await cap.handleMessage('DOCS_EXTRACT',
                { base64: b64('inline'), mimeType: 'text/plain' }, ctx);
            expect(result).toMatchObject({ success: true, result: 'inline' });
        });

        it('rejects unknown mimetype', async () => {
            const result = await cap.handleMessage('DOCS_EXTRACT',
                { base64: b64('data'), mimeType: 'application/x-weird' }, ctx);
            expect(result).toMatchObject({ success: false });
            expect(result!.result as string).toMatch(/Unsupported mimeType/);
        });

        it('rejects empty base64', async () => {
            const result = await cap.handleMessage('DOCS_EXTRACT',
                { base64: '', mimeType: 'text/plain' }, ctx);
            expect(result).toMatchObject({ success: false, result: 'Empty file contents' });
        });

        it('rejects missing mimetype', async () => {
            const result = await cap.handleMessage('DOCS_EXTRACT',
                { base64: b64('x'), mimeType: '' }, ctx);
            expect(result).toMatchObject({ success: false, result: 'Missing mimeType' });
        });

        it('extracts DOCX text via mammoth', async () => {
            (mammoth.extractRawText as jest.Mock).mockResolvedValueOnce({ value: 'Document body text' });
            const result = await cap.handleMessage('DOCS_EXTRACT',
                { base64: b64('fakedocx'), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, ctx);
            expect(result).toMatchObject({ success: true, result: 'Document body text' });
            expect(mammoth.extractRawText).toHaveBeenCalled();
        });

        it('maps encrypted DOCX error to encrypted_docx', async () => {
            (mammoth.extractRawText as jest.Mock).mockRejectedValueOnce(new Error('File is encrypted'));
            const result = await cap.handleMessage('DOCS_EXTRACT',
                { base64: b64('enc'), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, ctx);
            expect(result).toMatchObject({ success: false, result: 'encrypted_docx' });
        });

        it('PDF: shows cost modal, sends base64 to aiGenerate, records spend, returns text', async () => {
            const requestCostEstimate = jest.fn().mockResolvedValue(true);
            (bridgeStore.useBridgeUIStore.getState as jest.Mock).mockReturnValueOnce({
                requestCostEstimate,
                requestKeyMissing: jest.fn(),
            });
            (aiApi.aiGenerate as jest.Mock).mockResolvedValueOnce({
                text: 'Extracted PDF text',
                usage: {},
                creditsUsed: 0,
                costUsd: 0.004,
            });

            const pdfB64 = b64('pdf-bytes');
            const result = await cap.handleMessage('DOCS_EXTRACT',
                { base64: pdfB64, mimeType: 'application/pdf' }, ctx);

            expect(requestCostEstimate).toHaveBeenCalledWith(1, 'generate', expect.any(String), 'test/model', 1);
            expect(aiApi.aiGenerate).toHaveBeenCalledTimes(1);
            expect(aiApi.aiGenerate).toHaveBeenCalledWith(expect.objectContaining({
                prompt: expect.stringMatching(/Extract all text/i),
                pdfs: [pdfB64],
            }));
            expect(result).toMatchObject({ success: true, result: 'Extracted PDF text' });
            expect(dbMod.incrementSpendUsd).toHaveBeenCalledWith(1, 0.004);
        });

        it('PDF: user cancels cost modal → user_cancelled, aiGenerate not called', async () => {
            (bridgeStore.useBridgeUIStore.getState as jest.Mock).mockReturnValueOnce({
                requestCostEstimate: jest.fn().mockResolvedValue(false),
                requestKeyMissing: jest.fn(),
            });

            const result = await cap.handleMessage('DOCS_EXTRACT',
                { base64: b64('scan'), mimeType: 'application/pdf' }, ctx);
            expect(result).toMatchObject({ success: false, result: 'user_cancelled' });
            expect(aiApi.aiGenerate).not.toHaveBeenCalled();
            expect(dbMod.incrementSpendUsd).not.toHaveBeenCalled();
        });

        it('PDF: no OpenRouter key → no_openrouter_key, requestKeyMissing invoked', async () => {
            (keyStorage.hasOpenRouterKey as jest.Mock).mockResolvedValueOnce(false);
            const requestKeyMissing = jest.fn().mockResolvedValue('openSettings');
            (bridgeStore.useBridgeUIStore.getState as jest.Mock).mockReturnValueOnce({
                requestCostEstimate: jest.fn(),
                requestKeyMissing,
            });

            const result = await cap.handleMessage('DOCS_EXTRACT',
                { base64: b64('scan'), mimeType: 'application/pdf' }, ctx);
            expect(requestKeyMissing).toHaveBeenCalledWith('generate');
            expect(result).toMatchObject({ success: false, result: 'no_openrouter_key' });
            expect(aiApi.aiGenerate).not.toHaveBeenCalled();
        });

        it('PDF: aiGenerate rejects → surfaces error, no crash', async () => {
            (bridgeStore.useBridgeUIStore.getState as jest.Mock).mockReturnValueOnce({
                requestCostEstimate: jest.fn().mockResolvedValue(true),
                requestKeyMissing: jest.fn(),
            });
            (aiApi.aiGenerate as jest.Mock).mockRejectedValueOnce(new Error('model_does_not_support_pdf'));

            const result = await cap.handleMessage('DOCS_EXTRACT',
                { base64: b64('pdf'), mimeType: 'application/pdf' }, ctx);
            expect(result).toMatchObject({ success: false, result: 'model_does_not_support_pdf' });
            expect(dbMod.incrementSpendUsd).not.toHaveBeenCalled();
        });
    });

    it('returns null for unknown type', async () => {
        const result = await cap.handleMessage('UNKNOWN', {}, ctx);
        expect(result).toBeNull();
    });
});

// ─── Section H: forms — watchResponses ───────────────────────────────────────

describeCapability('forms')('handleMessage — forms', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'forms')!;

    const mockFormSchema = { items: [{ questionItem: { question: { questionId: 'q1' } }, title: 'Name' }] };
    const mockResponsesData = { responses: [{ responseId: 'r1', lastSubmittedTime: '2026-01-01', answers: { q1: { textAnswers: { answers: [{ value: 'Alice' }] } } } }] };

    beforeEach(() => {
        // AsyncStorage mock
        require('@react-native-async-storage/async-storage').getItem.mockResolvedValue(JSON.stringify({ q1: 'Name' }));
        require('@react-native-async-storage/async-storage').setItem.mockResolvedValue(undefined);
    });

    it('FORMS_CREATE: creates form and returns formId + shareUrl', async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk({ formId: 'form-1' }))  // create
            .mockResolvedValueOnce(mockFetchOk({}))                     // batchUpdate
            .mockResolvedValueOnce(mockFetchOk({ items: [] }));         // GET schema
        const result = await cap.handleMessage('FORMS_CREATE', {
            title: 'My Form', questions: [{ type: 'text', title: 'Name' }],
        }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any)).toMatchObject({ formId: 'form-1' });
    });

    it('FORMS_UPDATE: updates form and returns formId', async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk({ items: [] }))           // GET existing
            .mockResolvedValueOnce(mockFetchOk({}))                      // batchUpdate
            .mockResolvedValueOnce(mockFetchOk({ items: [] }));          // GET updated
        const result = await cap.handleMessage('FORMS_UPDATE', {
            formId: 'form-1', title: 'Updated', questions: [{ type: 'text', title: 'Email' }],
        }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any)).toMatchObject({ formId: 'form-1' });
    });

    it('FORMS_GET_RESPONSES: returns human-readable responses', async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk(mockFormSchema))
            .mockResolvedValueOnce(mockFetchOk(mockResponsesData));
        const result = await cap.handleMessage('FORMS_GET_RESPONSES', { formId: 'form-1' }, ctx);
        expect(result).toMatchObject({ success: true });
        const parsed = (result!.result! as any);
        expect(parsed.responses[0].answers['Name']).toBe('Alice');
    });

    it('FORMS_WATCH_RESPONSES: initial callback with initial:true and all responses', async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk(mockFormSchema))
            .mockResolvedValueOnce(mockFetchOk(mockResponsesData));
        const injectSpy = ctx.webViewRef.current!.injectJavaScript as jest.Mock;
        injectSpy.mockClear();

        const result = await cap.handleMessage('FORMS_WATCH_RESPONSES',
            { formId: 'form-1', intervalMs: 15000, callbackName: 'onResponses' }, ctx);
        expect(result).toMatchObject({ success: true, deferredCallback: true });

        await flushPromises();

        expect(injectSpy).toHaveBeenCalled();
        const payload = parseInjectedPayload(injectSpy.mock.calls[0][0] as string);
        expect(payload.initial).toBe(true);
        expect(payload.responses[0].answers['Name']).toBe('Alice');
    });

    it('FORMS_WATCH_RESPONSES: poll with new response fires callback with newResponses', async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk(mockFormSchema))
            .mockResolvedValueOnce(mockFetchOk(mockResponsesData));
        const injectSpy = ctx.webViewRef.current!.injectJavaScript as jest.Mock;
        injectSpy.mockClear();

        await cap.handleMessage('FORMS_WATCH_RESPONSES',
            { formId: 'form-2', intervalMs: 15000, callbackName: 'onResponses' }, ctx);
        await flushPromises();
        injectSpy.mockClear();

        const twoResponses = {
            responses: [
                { responseId: 'r1', lastSubmittedTime: '2026-01-01', answers: { q1: { textAnswers: { answers: [{ value: 'Alice' }] } } } },
                { responseId: 'r2', lastSubmittedTime: '2026-01-02', answers: { q1: { textAnswers: { answers: [{ value: 'Bob' }] } } } },
            ],
        };
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk(mockFormSchema))
            .mockResolvedValueOnce(mockFetchOk(twoResponses));
        jest.advanceTimersByTime(15000);
        await flushPromises();

        expect(injectSpy).toHaveBeenCalled();
        const payload = parseInjectedPayload(injectSpy.mock.calls[0][0] as string);
        expect(payload.newResponses).toHaveLength(1);
        expect(payload.newResponses[0].answers['Name']).toBe('Bob');
        expect(payload.initial).toBe(false);
    });

    it('FORMS_WATCH_RESPONSES: poll without new responses does not fire', async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk(mockFormSchema))
            .mockResolvedValueOnce(mockFetchOk(mockResponsesData));
        const injectSpy = ctx.webViewRef.current!.injectJavaScript as jest.Mock;

        await cap.handleMessage('FORMS_WATCH_RESPONSES',
            { formId: 'form-3', intervalMs: 15000, callbackName: 'onResponses' }, ctx);
        await flushPromises();
        injectSpy.mockClear();

        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(mockFetchOk(mockFormSchema))
            .mockResolvedValueOnce(mockFetchOk(mockResponsesData));
        jest.advanceTimersByTime(15000);
        await flushPromises();

        expect(injectSpy).not.toHaveBeenCalled();
    });

    it('FORMS_STOP_WATCH_RESPONSES: clears interval and returns stopped:true', async () => {
        const fakeInterval = setInterval(() => {}, 99999);
        formsWatchers.set('1_form-stop', {
            interval: fakeInterval,
            webViewRef: ctx.webViewRef as any,
            callbackName: 'onResponses',
            snapshot: null,
        });
        const result = await cap.handleMessage('FORMS_STOP_WATCH_RESPONSES', { formId: 'form-stop' }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any)).toMatchObject({ stopped: true });
        expect(formsWatchers.has('1_form-stop')).toBe(false);
    });

    it('FORMS_GET_RESPONSES offline with cache: returns cached:true', async () => {
        formsCache.set('form-c', [{ responseId: 'r1', submitTime: '', answers: {} }]);
        (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));
        const result = await cap.handleMessage('FORMS_GET_RESPONSES', { formId: 'form-c' }, ctx);
        expect(result).toMatchObject({ success: true });
        expect((result!.result! as any).cached).toBe(true);
    });

    it('FORMS_GET_RESPONSES offline without cache: returns offline:true', async () => {
        // Reset getItem so loadFormsCache returns null (no persisted responses)
        require('@react-native-async-storage/async-storage').getItem.mockResolvedValue(null);
        (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));
        const result = await cap.handleMessage('FORMS_GET_RESPONSES', { formId: 'form-nocache' }, ctx);
        expect(result).toMatchObject({ success: false });
        expect((result!.result! as any).offline).toBe(true);
    });

    it('null token: returns failure', async () => {
        requestGoogleScopes.mockResolvedValueOnce(null);
        const result = await cap.handleMessage('FORMS_GET_RESPONSES', { formId: 'form-1' }, ctx);
        expect(result).toMatchObject({ success: false });
    });

    it('returns null for unknown type', async () => {
        const result = await cap.handleMessage('UNKNOWN', {}, ctx);
        expect(result).toBeNull();
    });
    }); // end describeCapability('forms')
}); // end describe('Google capabilities — sync')

