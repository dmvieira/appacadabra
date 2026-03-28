import * as vm from 'vm';
import { getInjectedJavaScript } from '../injectedJS';

function makeMockPrototype() {
    return { appendChild: jest.fn(), setAttribute: jest.fn(), insertAdjacentHTML: jest.fn() };
}

function createSandbox(overrides: Record<string, any> = {}) {
    const listeners: Record<string, Function[]> = {};
    const sandbox: any = {
        window: null as any,
        document: {
            head: null,
            documentElement: { appendChild: jest.fn() },
            createElement: (tag: string) => ({ tagName: tag, textContent: '', style: {} }),
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
        // Browser globals used at module level in the injected script
        HTMLImageElement: { prototype: { src: '' } },
        HTMLVideoElement: { prototype: { src: '' } },
        HTMLAudioElement: { prototype: { src: '' } },
        Element: { prototype: makeMockPrototype() },
        XMLHttpRequest: { prototype: { open: jest.fn(), send: jest.fn() } },
        navigator: {
            vibrate: jest.fn(),
            clipboard: { writeText: jest.fn(), readText: jest.fn() },
            onLine: true,
            language: 'en',
            userAgent: 'test',
            geolocation: { watchPosition: jest.fn(), clearWatch: jest.fn() },
        },
        open: jest.fn(),
        location: { href: '', origin: '', protocol: 'https:', host: 'localhost' },
        localStorage: {
            _store: {} as Record<string, string>,
            getItem: jest.fn(function(k: string) { return (this as any)._store[k] ?? null; }),
            setItem: jest.fn(function(k: string, v: string) { (this as any)._store[k] = v; }),
            removeItem: jest.fn(function(k: string) { delete (this as any)._store[k]; }),
            clear: jest.fn(function() { (this as any)._store = {}; }),
            bind: jest.fn(function(ctx: any) { return this; }),
        },
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

describe('getInjectedJavaScript', () => {
    describe('script validity', () => {
        it('generates a non-empty string', () => {
            const script = getInjectedJavaScript(1);
            expect(typeof script).toBe('string');
            expect(script.length).toBeGreaterThan(0);
        });

        it('does not throw when parsed via new Function()', () => {
            const script = getInjectedJavaScript(1);
            expect(() => new Function(script)).not.toThrow();
        });
    });

    describe('null document.head regression', () => {
        it('does NOT throw when document.head is null', () => {
            const sb = createSandbox();
            const script = getInjectedJavaScript(1);
            expect(() => vm.runInNewContext(script, sb)).not.toThrow();
        });

        it('registers DOMContentLoaded listener when document.head is null', () => {
            const sb = createSandbox();
            const script = getInjectedJavaScript(1);
            vm.runInNewContext(script, sb);
            expect(sb.__listeners['DOMContentLoaded']).toBeDefined();
            expect(sb.__listeners['DOMContentLoaded'].length).toBeGreaterThan(0);
        });

        it('injects style immediately when document.head exists', () => {
            const headAppendChild = jest.fn();
            const sb = createSandbox({
                document: {
                    head: { appendChild: headAppendChild },
                    documentElement: { appendChild: jest.fn() },
                    createElement: (tag: string) => ({ tagName: tag, textContent: '', style: {} }),
                    addEventListener: jest.fn(),
                    removeEventListener: jest.fn(),
                },
            });
            const script = getInjectedJavaScript(1);
            vm.runInNewContext(script, sb);
            expect(headAppendChild).toHaveBeenCalled();
        });
    });

    describe('bridge globals after execution (document.head=null)', () => {
        let sb: any;
        beforeEach(() => {
            sb = createSandbox();
            vm.runInNewContext(getInjectedJavaScript(1), sb);
        });

        it('defines window.AppacadabraAI', () => {
            expect(sb.window.AppacadabraAI).toBeDefined();
        });

        it('window.AppacadabraAI.generate is a function', () => {
            expect(typeof sb.window.AppacadabraAI.generate).toBe('function');
        });

        it('defines window.AppacadabraForms', () => {
            expect(sb.window.AppacadabraForms).toBeDefined();
        });

        it('defines window.AppacadabraDocs', () => {
            expect(sb.window.AppacadabraDocs).toBeDefined();
        });

        it('defines window.AppacadabraSheets', () => {
            expect(sb.window.AppacadabraSheets).toBeDefined();
        });

        it('defines window.toggleSelectionMode', () => {
            expect(typeof sb.window.toggleSelectionMode).toBe('function');
        });

        it('defines window.__handleChunkedMediaCallback', () => {
            expect(typeof sb.window.__handleChunkedMediaCallback).toBe('function');
        });
    });

    describe('console.log override', () => {
        let sb: any;
        let originalLog: jest.Mock;

        beforeEach(() => {
            sb = createSandbox();
            originalLog = sb.console.log;
            vm.runInNewContext(getInjectedJavaScript(1), sb);
        });

        it('overrides console.log after script runs with document.head=null', () => {
            expect(sb.console.log).not.toBe(originalLog);
        });

        it('overrides console.warn, console.error, console.info', () => {
            expect(sb.console.warn).not.toBe(jest.fn());
            expect(sb.console.error).not.toBe(jest.fn());
            expect(sb.console.info).not.toBe(jest.fn());
        });

        it('original console still called alongside override', () => {
            sb.console.log('hello');
            expect(originalLog).toHaveBeenCalledWith('hello');
        });
    });

    describe('edit mode flag', () => {
        it('sets window.__IS_EDIT_MODE__ = true when isEditMode=true', () => {
            const sb = createSandbox();
            vm.runInNewContext(getInjectedJavaScript(1, undefined, true), sb);
            expect(sb.window.__IS_EDIT_MODE__).toBe(true);
        });

        it('sets window.__IS_EDIT_MODE__ = false when isEditMode=false', () => {
            const sb = createSandbox();
            vm.runInNewContext(getInjectedJavaScript(1, undefined, false), sb);
            expect(sb.window.__IS_EDIT_MODE__).toBe(false);
        });
    });
});
