import * as vm from 'vm';
import { getInjectedJavaScript } from '../injectedJS';
import { DISABLED_CAPABILITIES } from '../../capabilities/index';

const describeCapability = (id: string) =>
    DISABLED_CAPABILITIES.has(id) ? describe.skip : describe;

function makeMockPrototype() {
    return { appendChild: jest.fn(), setAttribute: jest.fn(), insertAdjacentHTML: jest.fn() };
}

function createSandbox(overrides: Record<string, any> = {}) {
    const listeners: Record<string, Function[]> = {};
    const postMessage = (overrides.ReactNativeWebView && overrides.ReactNativeWebView.postMessage)
        ? overrides.ReactNativeWebView.postMessage
        : jest.fn();
    const sandbox: any = {
        window: null as any,
        document: {
            head: null,
            body: { classList: { add: jest.fn(), remove: jest.fn() }, addEventListener: jest.fn(), removeEventListener: jest.fn(), appendChild: jest.fn(), querySelector: jest.fn(() => null), querySelectorAll: jest.fn(() => []) },
            documentElement: { appendChild: jest.fn(), outerHTML: '<html></html>' },
            createElement: (tag: string) => ({ tagName: tag, textContent: '', style: {}, className: '', id: '', innerHTML: '', appendChild: jest.fn(), setAttribute: jest.fn(), addEventListener: jest.fn(), removeEventListener: jest.fn(), focus: jest.fn(), querySelector: jest.fn(() => null), onclick: null }),
            getElementById: jest.fn((id: string) => ({ id, style: {}, remove: jest.fn() })),
            addEventListener: (evt: string, fn: Function) => {
                listeners[evt] = listeners[evt] || [];
                listeners[evt].push(fn);
            },
            removeEventListener: jest.fn(),
        },
        console: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
        setTimeout: jest.fn(),
        clearTimeout: jest.fn(),
        fetch: jest.fn(),
        HTMLImageElement: { prototype: { src: '' } },
        HTMLVideoElement: { prototype: { src: '' } },
        HTMLAudioElement: { prototype: { src: '' } },
        Element: { prototype: makeMockPrototype() },
        XMLHttpRequest: { prototype: { open: jest.fn(), send: jest.fn() } },
        navigator: {
            vibrate: jest.fn(),
            clipboard: {
                writeText: jest.fn(() => Promise.resolve()),
                readText: jest.fn(() => Promise.resolve('')),
            },
            onLine: true,
            language: 'en',
            userAgent: 'test-agent',
            geolocation: { watchPosition: jest.fn(), clearWatch: jest.fn() },
        },
        open: jest.fn(),
        getComputedStyle: jest.fn(() => ({ getPropertyValue: jest.fn(() => '') })),
        location: { href: '', origin: '', protocol: 'https:', host: 'localhost' },
        localStorage: {
            _store: {} as Record<string, string>,
            getItem: jest.fn(function(k: string) { return (this as any)._store[k] ?? null; }),
            setItem: jest.fn(function(k: string, v: string) { (this as any)._store[k] = v; }),
            removeItem: jest.fn(function(k: string) { delete (this as any)._store[k]; }),
            clear: jest.fn(function() { (this as any)._store = {}; }),
            bind: jest.fn(function() { return this; }),
        },
        ReactNativeWebView: { postMessage },
        CustomEvent: class CustomEvent { constructor(type: string, opts?: any) {} },
        Event: class Event { constructor(type: string) {} },
        atob: typeof atob !== 'undefined' ? atob : (s: string) => Buffer.from(s, 'base64').toString('binary'),
        Blob: typeof Blob !== 'undefined' ? Blob : class Blob {},
        URL: typeof URL !== 'undefined' ? URL : class URL { constructor(url: string) {} },
        Object: Object,
        JSON: JSON,
        Array: Array,
        Promise: Promise,
        Error: Error,
        ...overrides,
    };
    sandbox.window = sandbox;
    sandbox.__listeners = listeners;
    return sandbox;
}

function getLastMessage(postMessage: jest.Mock) {
    const calls = postMessage.mock.calls;
    return JSON.parse(calls[calls.length - 1][0]);
}

// ─── AppacadabraAI ───────────────────────────────────────────────────────────

describeCapability('ai')('AppacadabraAI', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => postMessage.mockClear());

    it('generate → AI_GENERATE with prompt and callbackName', () => {
        sb.AppacadabraAI.generate('hello', 'myCb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('AI_GENERATE');
        expect(msg.data.prompt).toBe('hello');
        expect(msg.callbackName).toBe('myCb');
    });

    it('generateImage → AI_GENERATE_IMAGE with prompt', () => {
        sb.AppacadabraAI.generateImage('a cat', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('AI_GENERATE_IMAGE');
        expect(msg.data.prompt).toBe('a cat');
    });

    it('generateVideo → AI_GENERATE_VIDEO with prompt', () => {
        sb.AppacadabraAI.generateVideo('sunset', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('AI_GENERATE_VIDEO');
        expect(msg.data.prompt).toBe('sunset');
    });

    it('similarity → AI_SIMILARITY with items', () => {
        const items = ['dog', 'cat'];
        sb.AppacadabraAI.similarity(items, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('AI_SIMILARITY');
        expect(msg.data.items).toEqual(items);
    });

    it('parseJSON strips markdown fences and returns object', () => {
        const result = sb.AppacadabraAI.parseJSON('```json\n{"a":1}\n```');
        expect(result).toEqual({ a: 1 });
    });

    it('parseJSON returns the object directly if passed an object', () => {
        const obj = { already: "object" };
        const result = sb.AppacadabraAI.parseJSON(obj);
        expect(result).toBe(obj);
    });

    it('parseJSON returns null for invalid JSON', () => {
        const result = sb.AppacadabraAI.parseJSON('not json');
        expect(result).toBeNull();
    });

    it('withSearch().generate → data.search = true', () => {
        sb.AppacadabraAI.withSearch().generate('query', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.data.search).toBe(true);
    });

    it('withSchema().generate → data.schema is set', () => {
        const schema = { type: 'string' };
        sb.AppacadabraAI.withSchema(schema).generate('q', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.data.schema).toBeDefined();
    });

    it('fromImage().generate → data.images is set', () => {
        sb.AppacadabraAI.fromImage('http://img.jpg').generate('describe', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.data.images).toBeDefined();
    });
});

// ─── AppacadabraForms ────────────────────────────────────────────────────────

describeCapability('forms')('AppacadabraForms', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => postMessage.mockClear());

    it('createForm → FORMS_CREATE with title', () => {
        sb.AppacadabraForms.createForm('My Form', [], 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('FORMS_CREATE');
        expect(msg.data.title).toBe('My Form');
    });

    it('updateForm → FORMS_UPDATE with formId', () => {
        sb.AppacadabraForms.updateForm('id1', 'Updated', [], 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('FORMS_UPDATE');
        expect(msg.data.formId).toBe('id1');
    });

    it('getResponses → FORMS_GET_RESPONSES with formId', () => {
        sb.AppacadabraForms.getResponses('id1', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('FORMS_GET_RESPONSES');
        expect(msg.data.formId).toBe('id1');
    });
});

// ─── AppacadabraDocs ─────────────────────────────────────────────────────────

describeCapability('docs')('AppacadabraDocs', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => postMessage.mockClear());

    it('createDoc → DOCS_CREATE with title', () => {
        sb.AppacadabraDocs.createDoc('My Doc', 'content here', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('DOCS_CREATE');
        expect(msg.data.title).toBe('My Doc');
    });

    it('getDoc → DOCS_GET with docId', () => {
        sb.AppacadabraDocs.getDoc('doc123', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('DOCS_GET');
        expect(msg.data.docId).toBe('doc123');
    });

    it('appendText → DOCS_APPEND_TEXT with docId and text', () => {
        sb.AppacadabraDocs.appendText('doc123', 'extra text', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('DOCS_APPEND_TEXT');
        expect(msg.data.docId).toBe('doc123');
        expect(msg.data.text).toBe('extra text');
    });

    it('generatePDF → GENERATE_PDF', () => {
        sb.AppacadabraDocs.generatePDF('# Title', 'markdown', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('GENERATE_PDF');
    });
});

// ─── AppacadabraSheets ───────────────────────────────────────────────────────

describeCapability('sheets')('AppacadabraSheets', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => postMessage.mockClear());

    it('createSheet → SHEETS_CREATE with title', () => {
        sb.AppacadabraSheets.createSheet('Budget', ['A', 'B'], 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SHEETS_CREATE');
        expect(msg.data.title).toBe('Budget');
    });

    it('appendRows → SHEETS_APPEND_ROWS with rows', () => {
        sb.AppacadabraSheets.appendRows('sheet1', [['a', 'b']], 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SHEETS_APPEND_ROWS');
        expect(msg.data.rows).toEqual([['a', 'b']]);
    });

    it('getRows → SHEETS_GET_ROWS with sheetId', () => {
        sb.AppacadabraSheets.getRows('sheet1', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SHEETS_GET_ROWS');
        expect(msg.data.sheetId).toBe('sheet1');
    });

    it('watchSheet → SHEETS_WATCH with sheetId and interval', () => {
        sb.AppacadabraSheets.watchSheet('sheet1', 5000, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SHEETS_WATCH');
        expect(msg.data.sheetId).toBe('sheet1');
        expect(msg.data.intervalMs).toBe(5000);
    });

    it('setRows → SHEETS_SET_ROWS with rows', () => {
        sb.AppacadabraSheets.setRows('sheet1', [{ Name: 'Alice' }], 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SHEETS_SET_ROWS');
        expect(msg.data.sheetId).toBe('sheet1');
    });
});

// ─── AppacadabraCalendar ─────────────────────────────────────────────────────

describeCapability('calendar')('AppacadabraCalendar', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => postMessage.mockClear());

    it('createEvent → CALENDAR_CREATE_EVENT', () => {
        sb.AppacadabraCalendar.createEvent('Meeting', 'desc', 0, 1000, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('CALENDAR_CREATE_EVENT');
    });

    it('createEventWithReminder → CALENDAR_CREATE_EVENT_REMINDER with reminderMinutes', () => {
        sb.AppacadabraCalendar.createEventWithReminder('Meeting', 'desc', 0, 1000, 15, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('CALENDAR_CREATE_EVENT_REMINDER');
        expect(msg.data.reminderMinutes).toBe(15);
    });

    it('getEvents → CALENDAR_GET_EVENTS', () => {
        sb.AppacadabraCalendar.getEvents(0, 1000, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('CALENDAR_GET_EVENTS');
    });

    it('deleteEvent → CALENDAR_DELETE_EVENT with eventId', () => {
        sb.AppacadabraCalendar.deleteEvent('evt1', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('CALENDAR_DELETE_EVENT');
        expect(msg.data.eventId).toBe('evt1');
    });
});

// ─── AppacadabraNotify ───────────────────────────────────────────────────────

describeCapability('notify')('AppacadabraNotify', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => postMessage.mockClear());

    it('showNow → NOTIFY_SHOW_NOW', () => {
        sb.AppacadabraNotify.showNow('Title', 'msg', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('NOTIFY_SHOW_NOW');
    });

    it('alert returns a Promise (custom dialog, not postMessage)', () => {
        // AppacadabraNotify.alert is overridden to a Promise-based DOM dialog
        const result = sb.AppacadabraNotify.alert('msg');
        expect(result).toBeInstanceOf(Promise);
        expect(postMessage.mock.calls.length).toBe(0);
    });

    it('schedule → NOTIFY_SCHEDULE with isAlarm falsy', () => {
        sb.AppacadabraNotify.schedule('Title', 'msg', 5, 'cb', 'id1');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('NOTIFY_SCHEDULE');
        expect(msg.data.isAlarm).toBeFalsy();
    });

    it('alarm → NOTIFY_SCHEDULE with isAlarm = true', () => {
        sb.AppacadabraNotify.alarm('Title', 'msg', 5, 'cb', 'id1');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('NOTIFY_SCHEDULE');
        expect(msg.data.isAlarm).toBe(true);
    });

    it('scheduleAt → NOTIFY_SCHEDULE', () => {
        sb.AppacadabraNotify.scheduleAt('Title', 'msg', Date.now() + 60000, 'cb', 'id1');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('NOTIFY_SCHEDULE');
    });

    it('alarmAt → NOTIFY_SCHEDULE with isAlarm = true', () => {
        sb.AppacadabraNotify.alarmAt('Title', 'msg', Date.now() + 60000, 'cb', 'id1');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('NOTIFY_SCHEDULE');
        expect(msg.data.isAlarm).toBe(true);
    });

    it('getScheduled → NOTIFY_GET_SCHEDULED', () => {
        sb.AppacadabraNotify.getScheduled('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('NOTIFY_GET_SCHEDULED');
    });

    it('cancel → NOTIFY_CANCEL with id', () => {
        sb.AppacadabraNotify.cancel('id1', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('NOTIFY_CANCEL');
        expect(msg.data.id).toBe('id1');
    });

    it('cancelAll → NOTIFY_CANCEL_ALL', () => {
        sb.AppacadabraNotify.cancelAll('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('NOTIFY_CANCEL_ALL');
    });

    it('edit mode: showNow does NOT post any message', () => {
        const pmEditMode = jest.fn();
        const sbEdit = createSandbox({ ReactNativeWebView: { postMessage: pmEditMode } });
        vm.runInNewContext(getInjectedJavaScript(1, undefined, true), sbEdit);
        sbEdit.AppacadabraNotify.showNow('Title', 'msg', 'cb');
        // console.log override may post CONSOLE_LOG but showNow should not post NOTIFY_SHOW_NOW
        const notifyCalls = pmEditMode.mock.calls
            .map((c: any[]) => JSON.parse(c[0]))
            .filter((m: any) => m.type === 'NOTIFY_SHOW_NOW');
        expect(notifyCalls).toHaveLength(0);
    });
});

// ─── AppacadabraShare ────────────────────────────────────────────────────────

describeCapability('share')('AppacadabraShare', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => postMessage.mockClear());

    it('share → SHARE_CONTENT with text and url', () => {
        sb.AppacadabraShare.share('hello', 'http://url', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SHARE_CONTENT');
        expect(msg.data.text).toBe('hello');
        expect(msg.data.url).toBe('http://url');
    });

    it('shareFile → SHARE_FILE with filename', () => {
        sb.AppacadabraShare.shareFile('base64data', 'image/png', 'file.png', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SHARE_FILE');
        expect(msg.data.filename).toBe('file.png');
    });
});

// ─── AppacadabraHealth ───────────────────────────────────────────────────────

describeCapability('health')('AppacadabraHealth', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => postMessage.mockClear());

    it('initialize → HEALTH_INITIALIZE', () => {
        sb.AppacadabraHealth.initialize('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('HEALTH_INITIALIZE');
    });

    it('getSteps → HEALTH_GET_STEPS', () => {
        sb.AppacadabraHealth.getSteps(0, 1000, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('HEALTH_GET_STEPS');
    });

    it('getHeartRate → HEALTH_GET_HEART_RATE', () => {
        sb.AppacadabraHealth.getHeartRate(0, 1000, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('HEALTH_GET_HEART_RATE');
    });

    it('getExercise → HEALTH_GET_EXERCISE', () => {
        sb.AppacadabraHealth.getExercise(0, 1000, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('HEALTH_GET_EXERCISE');
    });

    it('getSleep → HEALTH_GET_SLEEP', () => {
        sb.AppacadabraHealth.getSleep(0, 1000, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('HEALTH_GET_SLEEP');
    });

    it('getCalories → HEALTH_GET_CALORIES', () => {
        sb.AppacadabraHealth.getCalories(0, 1000, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('HEALTH_GET_CALORIES');
    });
});

// ─── AppacadabraContacts ─────────────────────────────────────────────────────

describeCapability('contacts')('AppacadabraContacts', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => postMessage.mockClear());

    it('search → CONTACTS_SEARCH with query', () => {
        sb.AppacadabraContacts.search('John', 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('CONTACTS_SEARCH');
        expect(msg.data.query).toBe('John');
    });

    it('add → CONTACTS_ADD', () => {
        sb.AppacadabraContacts.add({ name: 'John' }, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('CONTACTS_ADD');
    });

    it('update → CONTACTS_UPDATE with contact.id', () => {
        sb.AppacadabraContacts.update({ id: '1', name: 'John' }, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('CONTACTS_UPDATE');
        expect(msg.data.contact.id).toBe('1');
    });
});

// ─── AppacadabraClipboard ────────────────────────────────────────────────────

describeCapability('clipboard')('AppacadabraClipboard', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => {
        postMessage.mockClear();
        sb.navigator.clipboard.writeText.mockClear();
        sb.navigator.clipboard.writeText.mockImplementation(() => Promise.resolve());
        sb.navigator.clipboard.readText.mockClear();
        sb.navigator.clipboard.readText.mockImplementation(() => Promise.resolve(''));
    });

    it('setString calls navigator.clipboard.writeText', () => {
        sb.AppacadabraClipboard.setString('hello');
        expect(sb.navigator.clipboard.writeText).toHaveBeenCalledWith('hello');
    });

    it('getString calls navigator.clipboard.readText', () => {
        sb.navigator.clipboard.readText.mockResolvedValue('text');
        sb.AppacadabraClipboard.getString('cb');
        expect(sb.navigator.clipboard.readText).toHaveBeenCalled();
    });
});

// ─── AppacadabraDevice ───────────────────────────────────────────────────────

describeCapability('device')('AppacadabraDevice', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => postMessage.mockClear());

    it('getBatteryLevel → DEVICE_GET_BATTERY_LEVEL', () => {
        sb.AppacadabraDevice.getBatteryLevel('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('DEVICE_GET_BATTERY_LEVEL');
    });

    it('isCharging → DEVICE_IS_CHARGING', () => {
        sb.AppacadabraDevice.isCharging('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('DEVICE_IS_CHARGING');
    });

    it('isOnline → DEVICE_IS_ONLINE', () => {
        sb.AppacadabraDevice.isOnline('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('DEVICE_IS_ONLINE');
    });

    it('getNetworkType → DEVICE_GET_NETWORK_INFO', () => {
        sb.AppacadabraDevice.getNetworkType('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('DEVICE_GET_NETWORK_INFO');
    });

    it('vibrate → VIBRATE with pattern', () => {
        sb.AppacadabraDevice.vibrate([100, 50, 100]);
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('VIBRATE');
        expect(msg.data.pattern).toEqual([100, 50, 100]);
    });

    it('cancelVibration → VIBRATE with pattern = 0', () => {
        sb.AppacadabraDevice.cancelVibration();
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('VIBRATE');
        expect(msg.data.pattern).toBe(0);
    });

    it('language property equals navigator.language', () => {
        expect(sb.AppacadabraDevice.language).toBe('en');
    });

    it('userAgent property equals navigator.userAgent', () => {
        expect(sb.AppacadabraDevice.userAgent).toBe('test-agent');
    });

    it('openBrowser calls window.open', () => {
        sb.open.mockClear();
        sb.AppacadabraDevice.openBrowser('https://example.com');
        expect(sb.open).toHaveBeenCalledWith('https://example.com', '_blank');
    });
});

// ─── AppacadabraScreen ───────────────────────────────────────────────────────

describeCapability('screen')('AppacadabraScreen', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => postMessage.mockClear());

    it('print → PRINT', () => {
        sb.AppacadabraScreen.print();
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('PRINT');
    });

    it('capture → SCREEN_CAPTURE', () => {
        sb.AppacadabraScreen.capture('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SCREEN_CAPTURE');
    });
});

// ─── AppacadabraUI ───────────────────────────────────────────────────────────

describeCapability('ui')('AppacadabraUI', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => postMessage.mockClear());

    it('showLoader does not throw', () => {
        expect(() => sb.AppacadabraUI.showLoader('Loading...')).not.toThrow();
    });

    it('hideLoader does not throw', () => {
        expect(() => sb.AppacadabraUI.hideLoader()).not.toThrow();
    });

    it('toast does not throw', () => {
        expect(() => sb.AppacadabraUI.toast('Done!', 'success')).not.toThrow();
    });
});

// ─── AppacadabraSensors ──────────────────────────────────────────────────────

describeCapability('sensors')('AppacadabraSensors', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => {
        postMessage.mockClear();
        sb.navigator.geolocation.watchPosition.mockClear();
    });

    it('startAccelerometer → SENSORS_START_ACCELEROMETER', () => {
        sb.AppacadabraSensors.startAccelerometer(100, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SENSORS_START_ACCELEROMETER');
    });

    it('startGyroscope → SENSORS_START_GYROSCOPE', () => {
        sb.AppacadabraSensors.startGyroscope(100, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SENSORS_START_GYROSCOPE');
    });

    it('startMagnetometer → SENSORS_START_MAGNETOMETER', () => {
        sb.AppacadabraSensors.startMagnetometer(100, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SENSORS_START_MAGNETOMETER');
    });

    it('startPedometer → SENSORS_START_PEDOMETER', () => {
        sb.AppacadabraSensors.startPedometer('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SENSORS_START_PEDOMETER');
    });

    it('startGPS calls navigator.geolocation.watchPosition', () => {
        sb.AppacadabraSensors.startGPS('cb');
        expect(sb.navigator.geolocation.watchPosition).toHaveBeenCalled();
    });

    it('startSpeedometer calls navigator.geolocation.watchPosition', () => {
        sb.AppacadabraSensors.startSpeedometer('cb');
        expect(sb.navigator.geolocation.watchPosition).toHaveBeenCalled();
    });

    it('stopAccelerometer → SENSORS_STOP_ACCELEROMETER', () => {
        sb.AppacadabraSensors.stopAccelerometer();
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SENSORS_STOP_ACCELEROMETER');
    });

    it('stopGyroscope → SENSORS_STOP_GYROSCOPE', () => {
        sb.AppacadabraSensors.stopGyroscope();
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SENSORS_STOP_GYROSCOPE');
    });

    it('stopMagnetometer → SENSORS_STOP_MAGNETOMETER', () => {
        sb.AppacadabraSensors.stopMagnetometer();
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SENSORS_STOP_MAGNETOMETER');
    });

    it('stopPedometer → SENSORS_STOP_PEDOMETER', () => {
        sb.AppacadabraSensors.stopPedometer();
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SENSORS_STOP_PEDOMETER');
    });

    it('stopAll → SENSORS_STOP_ALL', () => {
        sb.AppacadabraSensors.stopAll();
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SENSORS_STOP_ALL');
    });

    it('startCompass is an alias for startMagnetometer', () => {
        postMessage.mockClear();
        sb.AppacadabraSensors.startCompass(100, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SENSORS_START_MAGNETOMETER');
    });

    it('stopCompass is an alias for stopMagnetometer', () => {
        postMessage.mockClear();
        sb.AppacadabraSensors.stopCompass();
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SENSORS_STOP_MAGNETOMETER');
    });
});

// ─── AppacadabraCamera ───────────────────────────────────────────────────────

describeCapability('camera')('AppacadabraCamera', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => postMessage.mockClear());

    it('takePhoto → CAMERA_TAKE_PHOTO', () => {
        sb.AppacadabraCamera.takePhoto('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('CAMERA_TAKE_PHOTO');
    });

    it('recordVideo → CAMERA_RECORD_VIDEO', () => {
        sb.AppacadabraCamera.recordVideo({}, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('CAMERA_RECORD_VIDEO');
    });

    it('playVideo → VIDEO_PLAY', () => {
        sb.AppacadabraCamera.playVideo('http://video.mp4', {}, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('VIDEO_PLAY');
    });

    it('stopPlaying → VIDEO_STOP', () => {
        sb.AppacadabraCamera.stopPlaying('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('VIDEO_STOP');
    });

    it('isPlaying → VIDEO_IS_PLAYING', () => {
        sb.AppacadabraCamera.isPlaying('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('VIDEO_IS_PLAYING');
    });

    it('scan → SCANNER_SCAN', () => {
        sb.AppacadabraCamera.scan('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('SCANNER_SCAN');
    });
});

// ─── AppacadabraAudio ────────────────────────────────────────────────────────

describeCapability('audio')('AppacadabraAudio', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => postMessage.mockClear());

    it('recordStart → AUDIO_RECORD_START', () => {
        sb.AppacadabraAudio.recordStart('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('AUDIO_RECORD_START');
    });

    it('recordStop → AUDIO_RECORD_STOP', () => {
        sb.AppacadabraAudio.recordStop('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('AUDIO_RECORD_STOP');
    });

    it('speak → TTS_SPEAK with text', () => {
        sb.AppacadabraAudio.speak('hello', {}, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('TTS_SPEAK');
        expect(msg.data.text).toBe('hello');
    });

    it('speakAI → AUDIO_SPEAK_AI', () => {
        sb.AppacadabraAudio.speakAI('hello', {}, 'cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('AUDIO_SPEAK_AI');
    });

    it('stopSpeaking → TTS_STOP', () => {
        sb.AppacadabraAudio.stopSpeaking('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('TTS_STOP');
    });

    it('isSpeaking → TTS_IS_SPEAKING', () => {
        sb.AppacadabraAudio.isSpeaking('cb');
        const msg = getLastMessage(postMessage);
        expect(msg.type).toBe('TTS_IS_SPEAKING');
    });
});

// ─── localStorage override ───────────────────────────────────────────────────

describe('localStorage override', () => {
    let sb: any;
    let postMessage: jest.Mock;

    beforeAll(() => {
        postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    beforeEach(() => postMessage.mockClear());

    it('setItem → STORAGE_SET with key and value', () => {
        sb.localStorage.setItem('myKey', 'myValue');
        const storageCalls = postMessage.mock.calls
            .map((c: any[]) => JSON.parse(c[0]))
            .filter((m: any) => m.type === 'STORAGE_SET');
        expect(storageCalls).toHaveLength(1);
        expect(storageCalls[0].data.key).toBe('myKey');
        expect(storageCalls[0].data.value).toBe('myValue');
    });

    it('removeItem → STORAGE_REMOVE', () => {
        sb.localStorage.removeItem('myKey');
        const storageCalls = postMessage.mock.calls
            .map((c: any[]) => JSON.parse(c[0]))
            .filter((m: any) => m.type === 'STORAGE_REMOVE');
        expect(storageCalls).toHaveLength(1);
    });

    it('clear → STORAGE_CLEAR', () => {
        sb.localStorage.clear();
        const storageCalls = postMessage.mock.calls
            .map((c: any[]) => JSON.parse(c[0]))
            .filter((m: any) => m.type === 'STORAGE_CLEAR');
        expect(storageCalls).toHaveLength(1);
    });

    it('setItem in edit mode does NOT send STORAGE_SET', () => {
        const pmEdit = jest.fn();
        const sbEdit = createSandbox({ ReactNativeWebView: { postMessage: pmEdit } });
        vm.runInNewContext(getInjectedJavaScript(1, undefined, true), sbEdit);
        pmEdit.mockClear();
        sbEdit.localStorage.setItem('k', 'v');
        const storageCalls = pmEdit.mock.calls
            .map((c: any[]) => JSON.parse(c[0]))
            .filter((m: any) => m.type === 'STORAGE_SET');
        expect(storageCalls).toHaveLength(0);
    });
});

// ─── toggleSelectionMode ─────────────────────────────────────────────────────

describe('toggleSelectionMode', () => {
    let sb: any;

    beforeAll(() => {
        const postMessage = jest.fn();
        sb = createSandbox({ ReactNativeWebView: { postMessage } });
        vm.runInNewContext(getInjectedJavaScript(1), sb);
    });

    it('toggleSelectionMode(true) adds class to document.body', () => {
        sb.toggleSelectionMode(true);
        expect(sb.document.body.classList.add).toHaveBeenCalledWith('selection-mode');
    });

    it('toggleSelectionMode(false) removes class from document.body', () => {
        sb.toggleSelectionMode(false);
        expect(sb.document.body.classList.remove).toHaveBeenCalledWith('selection-mode');
    });
});
