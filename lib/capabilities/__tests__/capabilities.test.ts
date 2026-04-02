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

jest.mock('marked', () => ({
    marked: jest.fn((s: string) => s),
}));

jest.mock('expo-linking', () => ({
    openURL: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../manaStore', () => ({
    useManaStore: {
        getState: jest.fn(() => ({
            spendMana: jest.fn(() => Promise.resolve(true)),
            getManaBalance: jest.fn(() => 100),
        })),
    },
}));

jest.mock('../../bridgeUIStore', () => ({
    useBridgeUIStore: {
        getState: jest.fn(() => ({
            setNativeActivityActive: jest.fn(),
            openVideoPlayer: jest.fn(),
            openScanner: jest.fn(),
            closeScanner: jest.fn(),
            showManaConfirm: jest.fn(),
        })),
    },
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
}));

// react-native is already mocked by jest-expo preset.
// Stub AlarmModule and Share into NativeModules in beforeAll below.

import { ALL_CAPABILITIES } from '../index';
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

describe('Module structure — all 16 capabilities', () => {
    it('has exactly 16 capabilities', () => {
        expect(ALL_CAPABILITIES).toHaveLength(16);
    });

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
    const find = (id: string) => ALL_CAPABILITIES.find(c => c.id === id)!;

    const cases: Array<[string, string[]]> = [
        ['clipboard', ['AppacadabraClipboard', 'setString', 'getString']],
        ['share', ['AppacadabraShare', 'share', 'shareFile']],
        ['screen', ['AppacadabraScreen', 'capture', 'print']],
        ['device', ['AppacadabraDevice', 'vibrate', 'getBatteryLevel']],
        ['calendar', ['AppacadabraCalendar', 'createEvent', 'getEvents']],
        ['notify', ['AppacadabraNotify', 'showNow', 'schedule']],
        ['health', ['AppacadabraHealth', 'getSteps', 'getHeartRate']],
        ['contacts', ['AppacadabraContacts', 'search', 'add']],
        ['sensors', ['AppacadabraSensors', 'startAccelerometer', 'startGPS']],
        ['ui', ['AppacadabraUI', 'showLoader', 'toast']],
        ['camera', ['AppacadabraCamera', 'takePhoto', 'recordVideo']],
        ['audio', ['AppacadabraAudio', 'recordStart', 'speak']],
        ['forms', ['AppacadabraForms', 'createForm', 'getResponses']],
        ['docs', ['AppacadabraDocs', 'createDoc', 'generatePDF']],
        ['sheets', ['AppacadabraSheets', 'createSheet', 'appendRows']],
        ['ai', ['AppacadabraAI', 'generate', 'similarity']],
    ];

    test.each(cases)('%s — getInjectedJS returns non-empty string', (id) => {
        const cap = find(id);
        const js = cap.getInjectedJS(1, false);
        expect(typeof js).toBe('string');
        expect(js.length).toBeGreaterThan(0);
    });

    test.each(cases)('%s — getInjectedJS contains expected identifiers', (id, identifiers) => {
        const cap = find(id);
        const js = cap.getInjectedJS(1, false);
        for (const identifier of identifiers) {
            expect(js).toContain(identifier);
        }
    });
});

// ─── Section C: handleMessage for simple/mockable handlers ───────────────────

describe('handleMessage — clipboard', () => {
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

describe('handleMessage — device', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'device')!;

    it('VIBRATE: returns success for numeric pattern', async () => {
        const result = await cap.handleMessage('VIBRATE', { pattern: 200 }, ctx);
        expect(result).toMatchObject({ success: true });
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

describe('handleMessage — share', () => {
    const cap = ALL_CAPABILITIES.find(c => c.id === 'share')!;

    it('SHARE_CONTENT: calls Share.share and returns success', async () => {
        jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as any);
        const result = await cap.handleMessage('SHARE_CONTENT', { text: 'hello' }, ctx);
        expect(Share.share).toHaveBeenCalled();
        expect(result).toMatchObject({ success: true });
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

describe('handleMessage — notify', () => {
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

    it('NOTIFY_CANCEL_ALL: returns success with All cancelled message', async () => {
        const result = await cap.handleMessage('NOTIFY_CANCEL_ALL', {}, ctx);
        expect(result).toMatchObject({ success: true });
        expect(result!.result).toContain('Cancelled');
    });

    it('returns null for unknown type', async () => {
        const result = await cap.handleMessage('UNKNOWN', {}, ctx);
        expect(result).toBeNull();
    });
});
