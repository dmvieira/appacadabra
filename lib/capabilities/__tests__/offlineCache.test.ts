/**
 * Testes para cache offline de sheets, docs e forms.
 *
 * Bug A — loading eterno: erros HTTP (não-TypeError) em doPoll(initial=true)
 *         devem sempre chamar o callback para não travar o WebView.
 * Bug B — cache ignorado: !res.ok deve consultar cache antes de retornar erro
 *         nos GETs one-shot (GET_ROWS, GET_RESPONSES).
 * Melhoria C — persistência entre sessões: dados fetched gravados em
 *         AsyncStorage e lidos na primeira abertura sem internet.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../firebase', () => ({ requestGoogleScopes: jest.fn() }));

jest.mock('expo-file-system/legacy', () => ({
    documentDirectory: '/mock/documents/',
    readAsStringAsync: jest.fn(),
    writeAsStringAsync: jest.fn(),
    deleteAsync: jest.fn(),
    getInfoAsync: jest.fn(),
    makeDirectoryAsync: jest.fn(),
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
}));

jest.mock('marked', () => ({
    marked: { lexer: jest.fn(() => []) },
    Renderer: jest.fn(),
}));

jest.mock('turndown', () => jest.fn().mockImplementation(() => ({
    turndown: jest.fn((s: string) => s),
    addRule: jest.fn(),
    remove: jest.fn(),
    use: jest.fn(),
})));

jest.mock('expo-print', () => ({
    printAsync: jest.fn(),
    printToFileAsync: jest.fn(() => Promise.resolve({ uri: '/tmp/test.pdf' })),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { requestGoogleScopes } from '../../firebase';
import {
    sheetsCapability,
    resourceCache as sheetsCache,
    activeWatchers as sheetsWatchers,
} from '../sheets';
import {
    docsCapability,
    resourceCache as docsCache,
    activeWatchers as docsWatchers,
} from '../docs';
import {
    formsCapability,
    resourceCache as formsCache,
    activeWatchers as formsWatchers,
} from '../forms';

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockGoogleScopes = requestGoogleScopes as jest.Mock;
const mockGetItem = AsyncStorage.getItem as jest.Mock;
const mockSetItem = AsyncStorage.setItem as jest.Mock;

/** Aguarda múltiplos ciclos de microtask + event loop para doPoll fire-and-forget. */
const flush = () => new Promise<void>(r => setTimeout(r, 0));

function makeCtx(id = 1) {
    return {
        webViewRef: { current: { injectJavaScript: jest.fn() } },
        viewContainerRef: { current: null },
        appId: id,
        callbackName: 'onResult',
        onJobCreated: jest.fn(),
        isEditMode: false,
    };
}

function makeRes(ok: boolean, body: any, status = ok ? 200 : 401) {
    return {
        ok,
        status,
        json: jest.fn(() => Promise.resolve(body)),
        text: jest.fn(() => Promise.resolve(String(status))),
    };
}

const NETWORK_ERROR = Object.assign(new TypeError('Network request failed'), {});

function injected(mock: jest.Mock, idx = 0): string {
    return (mock.mock.calls[idx]?.[0] as string) ?? '';
}

function callbackWasSuccess(mock: jest.Mock, idx = 0): boolean {
    return injected(mock, idx).includes('(true,');
}

function callbackPayload(mock: jest.Mock, idx = 0): any {
    const script = injected(mock, idx);
    // The script stores data as: var __d = "...escaped JSON...";
    const m = script.match(/var __d = "((?:[^"\\]|\\.)*)"/);
    if (!m) return null;
    try {
        const unescaped = m[1]
            .replace(/\\\\/g, '\\')
            .replace(/\\"/g, '"')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t');
        return JSON.parse(unescaped);
    } catch { return null; }
}

const SHEETS_DATA = { headers: ['name'], rows: [{ name: 'Alice' }] };
const DOCS_SNAP = { title: 'My Doc', content: '# Hello' };
const FORMS_RESP = [{ responseId: 'r1', submitTime: '2024-01-01T00:00:00Z', answers: {} }];

function clearWatchers() {
    sheetsWatchers.forEach(w => clearInterval(w.interval));
    sheetsWatchers.clear();
    docsWatchers.forEach(w => clearInterval(w.interval));
    docsWatchers.clear();
    formsWatchers.forEach(w => clearInterval(w.interval));
    formsWatchers.clear();
}

// ── beforeEach ────────────────────────────────────────────────────────────────

beforeEach(() => {
    jest.clearAllMocks();
    sheetsCache.clear();
    docsCache.clear();
    formsCache.clear();
    clearWatchers();
    mockGoogleScopes.mockResolvedValue(null);
    mockGetItem.mockResolvedValue(null);
    mockSetItem.mockResolvedValue(undefined);
    (global.fetch as jest.Mock) = jest.fn();
});

// ═══════════════════════════════════════════════════════════════════════════════
// SHEETS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Sheets', () => {

    // ── SHEETS_WATCH — doPoll(initial=true) ────────────────────────────────────

    describe('SHEETS_WATCH — doPoll(initial=true)', () => {
        // Helper: dispara SHEETS_WATCH e aguarda doPoll fire-and-forget terminar
        async function watchSheet(ctx: ReturnType<typeof makeCtx>, sheetId: string) {
            await sheetsCapability.handleMessage('SHEETS_WATCH', {
                sheetId, intervalMs: 999999, callbackName: 'onResult',
            }, ctx as any);
            await flush();
        }

        it('1 — rede ok: callback com rows frescos e AsyncStorage gravado', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(
                makeRes(true, { values: [['name'], ['Alice']] })
            );
            const ctx = makeCtx();
            await watchSheet(ctx, 's_test01');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
            const p = callbackPayload(ctx.webViewRef.current.injectJavaScript);
            expect(p?.rows).toEqual([{ name: 'Alice' }]);
            expect(mockSetItem).toHaveBeenCalledWith(
                expect.stringContaining('sheets_cache_s_test01'), expect.any(String)
            );
        });

        it('2 — TypeError Network + resourceCache hit: callback com cache', async () => {
            sheetsCache.set('s_test02', SHEETS_DATA);
            mockGoogleScopes.mockRejectedValue(NETWORK_ERROR);
            const ctx = makeCtx();
            await watchSheet(ctx, 's_test02');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
            expect(callbackPayload(ctx.webViewRef.current.injectJavaScript)?.cached).toBe(true);
        });

        it('3 — TypeError Network + AsyncStorage hit: callback com dados persistidos [C]', async () => {
            mockGoogleScopes.mockRejectedValue(NETWORK_ERROR);
            mockGetItem.mockResolvedValue(JSON.stringify(SHEETS_DATA));
            const ctx = makeCtx();
            await watchSheet(ctx, 's_test03');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
            expect(callbackPayload(ctx.webViewRef.current.injectJavaScript)?.cached).toBe(true);
        });

        it('4 — TypeError Network + tudo vazio: callback com offline', async () => {
            mockGoogleScopes.mockRejectedValue(NETWORK_ERROR);
            const ctx = makeCtx();
            await watchSheet(ctx, 's_test04');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(false);
            expect(callbackPayload(ctx.webViewRef.current.injectJavaScript)?.offline).toBe(true);
        });

        it('5 — HTTP 401 + resourceCache hit: callback com cache [Bug A]', async () => {
            sheetsCache.set('s_test05', SHEETS_DATA);
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(makeRes(false, {}, 401));
            const ctx = makeCtx();
            await watchSheet(ctx, 's_test05');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
            expect(callbackPayload(ctx.webViewRef.current.injectJavaScript)?.cached).toBe(true);
        });

        it('6 — HTTP 401 + AsyncStorage hit: callback com dados persistidos [Bug A + C]', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(makeRes(false, {}, 401));
            mockGetItem.mockResolvedValue(JSON.stringify(SHEETS_DATA));
            const ctx = makeCtx();
            await watchSheet(ctx, 's_test06');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
        });

        it('7 — HTTP 401 + tudo vazio: callback com mensagem (não trava) [Bug A]', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(makeRes(false, {}, 401));
            const ctx = makeCtx();
            await watchSheet(ctx, 's_test07');
            expect(ctx.webViewRef.current.injectJavaScript).toHaveBeenCalled();
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(false);
        });

        it('8 — HTTP 500 + resourceCache hit: callback com cache', async () => {
            sheetsCache.set('s_test08', SHEETS_DATA);
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(makeRes(false, {}, 500));
            const ctx = makeCtx();
            await watchSheet(ctx, 's_test08');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
        });
    });

    // ── SHEETS_WATCH — doPoll(initial=false) ───────────────────────────────────

    describe('SHEETS_WATCH — doPoll(initial=false)', () => {

        async function watchSheetNonInitial(ctx: ReturnType<typeof makeCtx>, sheetId: string, snapshot: any[]) {
            // Prime com watcher existente (snapshot != null → doPoll(false))
            sheetsWatchers.set(`${ctx.appId}_${sheetId}`, {
                interval: setInterval(() => {}, 999999),
                webViewRef: ctx.webViewRef as any,
                callbackName: 'onResult',
                snapshot,
                skipNextPoll: false,
            });
            await sheetsCapability.handleMessage('SHEETS_WATCH', {
                sheetId, intervalMs: 999999, callbackName: 'onResult',
            }, ctx as any);
            await flush();
        }

        it('9 — rede ok, dados mudaram: callback chamado', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(
                makeRes(true, { values: [['name'], ['Bob']] })
            );
            const ctx = makeCtx();
            // snapshot anterior com Alice, novo dado Bob
            await watchSheetNonInitial(ctx, 's_test09', [{ name: 'Alice' }]);
            expect(ctx.webViewRef.current.injectJavaScript).toHaveBeenCalled();
        });

        it('10 — rede ok, dados iguais: injectJavaScript NÃO chamado', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            const sameRows = [{ name: 'Alice' }];
            (global.fetch as jest.Mock).mockResolvedValue(
                makeRes(true, { values: [['name'], ['Alice']] })
            );
            const ctx = makeCtx();
            await watchSheetNonInitial(ctx, 's_test10', sameRows);
            expect(ctx.webViewRef.current.injectJavaScript).not.toHaveBeenCalled();
        });

        it('11 — TypeError Network + initial=false: injectJavaScript NÃO chamado', async () => {
            mockGoogleScopes.mockRejectedValue(NETWORK_ERROR);
            const ctx = makeCtx();
            await watchSheetNonInitial(ctx, 's_test11', [{ name: 'Alice' }]);
            expect(ctx.webViewRef.current.injectJavaScript).not.toHaveBeenCalled();
        });

        it('12 — HTTP 401 + initial=false: injectJavaScript NÃO chamado', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(makeRes(false, {}, 401));
            const ctx = makeCtx();
            await watchSheetNonInitial(ctx, 's_test12', [{ name: 'Alice' }]);
            expect(ctx.webViewRef.current.injectJavaScript).not.toHaveBeenCalled();
        });
    });

    // ── SHEETS_GET_ROWS ────────────────────────────────────────────────────────

    describe('SHEETS_GET_ROWS', () => {

        it('13 — rede ok: retorna rows e AsyncStorage gravado', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(
                makeRes(true, { values: [['name'], ['Alice']] })
            );
            const res = await sheetsCapability.handleMessage(
                'SHEETS_GET_ROWS', { sheetId: 'sg_test13' }, makeCtx() as any
            );
            await flush();
            expect(res?.success).toBe(true);
            expect(((res?.result ?? {}) as any).rows).toEqual([{ name: 'Alice' }]);
            expect(mockSetItem).toHaveBeenCalledWith(
                expect.stringContaining('sheets_cache_sg_test13'), expect.any(String)
            );
        });

        it('14 — TypeError Network + resourceCache hit: retorna cache', async () => {
            sheetsCache.set('sg_test14', SHEETS_DATA);
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockRejectedValue(NETWORK_ERROR);
            const res = await sheetsCapability.handleMessage(
                'SHEETS_GET_ROWS', { sheetId: 'sg_test14' }, makeCtx() as any
            );
            expect(res?.success).toBe(true);
            expect(((res?.result ?? {}) as any).cached).toBe(true);
        });

        it('15 — TypeError Network + AsyncStorage hit: retorna dados persistidos [C]', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockRejectedValue(NETWORK_ERROR);
            mockGetItem.mockResolvedValue(JSON.stringify(SHEETS_DATA));
            const res = await sheetsCapability.handleMessage(
                'SHEETS_GET_ROWS', { sheetId: 'sg_test15' }, makeCtx() as any
            );
            expect(res?.success).toBe(true);
            expect(((res?.result ?? {}) as any).cached).toBe(true);
        });

        it('16 — TypeError Network + tudo vazio: retorna offline failure', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockRejectedValue(NETWORK_ERROR);
            const res = await sheetsCapability.handleMessage(
                'SHEETS_GET_ROWS', { sheetId: 'sg_test16' }, makeCtx() as any
            );
            expect(res?.success).toBe(false);
            expect(((res?.result ?? {}) as any).offline).toBe(true);
        });

        it('17 — HTTP 401 + resourceCache hit: retorna cache [Bug B]', async () => {
            sheetsCache.set('sg_test17', SHEETS_DATA);
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(makeRes(false, {}, 401));
            const res = await sheetsCapability.handleMessage(
                'SHEETS_GET_ROWS', { sheetId: 'sg_test17' }, makeCtx() as any
            );
            expect(res?.success).toBe(true);
            expect(((res?.result ?? {}) as any).cached).toBe(true);
        });

        it('18 — HTTP 401 + AsyncStorage hit: retorna dados persistidos [Bug B + C]', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(makeRes(false, {}, 401));
            mockGetItem.mockResolvedValue(JSON.stringify(SHEETS_DATA));
            const res = await sheetsCapability.handleMessage(
                'SHEETS_GET_ROWS', { sheetId: 'sg_test18' }, makeCtx() as any
            );
            expect(res?.success).toBe(true);
            expect(((res?.result ?? {}) as any).cached).toBe(true);
        });

        it('19 — HTTP 401 + tudo vazio: retorna failure', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(makeRes(false, {}, 401));
            const res = await sheetsCapability.handleMessage(
                'SHEETS_GET_ROWS', { sheetId: 'sg_test19' }, makeCtx() as any
            );
            expect(res?.success).toBe(false);
        });

        it('20 — HTTP 500 + resourceCache hit: retorna cache', async () => {
            sheetsCache.set('sg_test20', SHEETS_DATA);
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(makeRes(false, {}, 500));
            const res = await sheetsCapability.handleMessage(
                'SHEETS_GET_ROWS', { sheetId: 'sg_test20' }, makeCtx() as any
            );
            expect(res?.success).toBe(true);
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOCS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Docs', () => {

    function mockFetchDocOk() {
        (global.fetch as jest.Mock).mockResolvedValue(makeRes(true, {
            title: 'My Doc',
            body: {
                content: [
                    { paragraph: { elements: [{ textRun: { content: 'Hello' } }] } },
                    { endIndex: 10 },
                ],
            },
        }));
    }

    function mockFetchDocFail(status = 403) {
        (global.fetch as jest.Mock).mockResolvedValue(makeRes(false, {}, status));
    }

    // ── DOCS_WATCH — doPoll(initial=true) ─────────────────────────────────────

    describe('DOCS_WATCH — doPoll(initial=true)', () => {
        async function watchDoc(ctx: ReturnType<typeof makeCtx>, docId: string) {
            await docsCapability.handleMessage('DOCS_WATCH', {
                docId, intervalMs: 999999, callbackName: 'onResult',
            }, ctx as any);
            await flush();
        }

        it('21 — rede ok: callback com snap e AsyncStorage gravado', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            mockFetchDocOk();
            const ctx = makeCtx();
            await watchDoc(ctx, 'd_test21');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
            expect(mockSetItem).toHaveBeenCalledWith(
                expect.stringContaining('docs_cache_d_test21'), expect.any(String)
            );
        });

        it('22 — TypeError Network + resourceCache hit: callback com cache', async () => {
            docsCache.set('d_test22', DOCS_SNAP);
            mockGoogleScopes.mockRejectedValue(NETWORK_ERROR);
            const ctx = makeCtx();
            await watchDoc(ctx, 'd_test22');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
            expect(callbackPayload(ctx.webViewRef.current.injectJavaScript)?.cached).toBe(true);
        });

        it('23 — TypeError Network + AsyncStorage hit: callback com dados persistidos [C]', async () => {
            mockGoogleScopes.mockRejectedValue(NETWORK_ERROR);
            mockGetItem.mockResolvedValue(JSON.stringify(DOCS_SNAP));
            const ctx = makeCtx();
            await watchDoc(ctx, 'd_test23');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
            expect(callbackPayload(ctx.webViewRef.current.injectJavaScript)?.cached).toBe(true);
        });

        it('24 — TypeError Network + tudo vazio: callback com offline', async () => {
            mockGoogleScopes.mockRejectedValue(NETWORK_ERROR);
            const ctx = makeCtx();
            await watchDoc(ctx, 'd_test24');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(false);
            expect(callbackPayload(ctx.webViewRef.current.injectJavaScript)?.offline).toBe(true);
        });

        it('25 — HTTP 403 + resourceCache hit: callback com cache [Bug A]', async () => {
            docsCache.set('d_test25', DOCS_SNAP);
            mockGoogleScopes.mockResolvedValue('token');
            mockFetchDocFail(403);
            const ctx = makeCtx();
            await watchDoc(ctx, 'd_test25');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
            expect(callbackPayload(ctx.webViewRef.current.injectJavaScript)?.cached).toBe(true);
        });

        it('26 — HTTP 403 + AsyncStorage hit: callback com dados persistidos [Bug A + C]', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            mockFetchDocFail(403);
            mockGetItem.mockResolvedValue(JSON.stringify(DOCS_SNAP));
            const ctx = makeCtx();
            await watchDoc(ctx, 'd_test26');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
        });

        it('27 — HTTP 403 + tudo vazio: callback com mensagem (não trava) [Bug A]', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            mockFetchDocFail(403);
            const ctx = makeCtx();
            await watchDoc(ctx, 'd_test27');
            expect(ctx.webViewRef.current.injectJavaScript).toHaveBeenCalled();
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(false);
        });
    });

    // ── DOCS_WATCH — doPoll(initial=false) ────────────────────────────────────

    describe('DOCS_WATCH — doPoll(initial=false)', () => {
        async function watchDocNonInitial(ctx: ReturnType<typeof makeCtx>, docId: string, snapshot: any) {
            docsWatchers.set(`${ctx.appId}_${docId}`, {
                interval: setInterval(() => {}, 999999),
                webViewRef: ctx.webViewRef as any,
                callbackName: 'onResult',
                snapshot,
            });
            await docsCapability.handleMessage('DOCS_WATCH', {
                docId, intervalMs: 999999, callbackName: 'onResult',
            }, ctx as any);
            await flush();
        }

        it('28 — TypeError Network + initial=false: injectJavaScript NÃO chamado', async () => {
            mockGoogleScopes.mockRejectedValue(NETWORK_ERROR);
            const ctx = makeCtx();
            await watchDocNonInitial(ctx, 'd_test28', DOCS_SNAP);
            expect(ctx.webViewRef.current.injectJavaScript).not.toHaveBeenCalled();
        });

        it('29 — HTTP 403 + initial=false: injectJavaScript NÃO chamado', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            mockFetchDocFail(403);
            const ctx = makeCtx();
            await watchDocNonInitial(ctx, 'd_test29', DOCS_SNAP);
            expect(ctx.webViewRef.current.injectJavaScript).not.toHaveBeenCalled();
        });
    });

    // ── DOCS_GET ──────────────────────────────────────────────────────────────

    describe('DOCS_GET', () => {
        it('30 — rede ok: retorna snap e AsyncStorage gravado', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            mockFetchDocOk();
            const res = await docsCapability.handleMessage(
                'DOCS_GET', { docId: 'dg_test30' }, makeCtx() as any
            );
            await flush();
            expect(res?.success).toBe(true);
            expect(mockSetItem).toHaveBeenCalledWith(
                expect.stringContaining('docs_cache_dg_test30'), expect.any(String)
            );
        });

        it('31 — TypeError Network + resourceCache hit: retorna cache', async () => {
            docsCache.set('dg_test31', DOCS_SNAP);
            mockGoogleScopes.mockRejectedValue(NETWORK_ERROR);
            const res = await docsCapability.handleMessage(
                'DOCS_GET', { docId: 'dg_test31' }, makeCtx() as any
            );
            expect(res?.success).toBe(true);
            expect(((res?.result ?? {}) as any).cached).toBe(true);
        });

        it('32 — TypeError Network + AsyncStorage hit: retorna dados persistidos [C]', async () => {
            mockGoogleScopes.mockRejectedValue(NETWORK_ERROR);
            mockGetItem.mockResolvedValue(JSON.stringify(DOCS_SNAP));
            const res = await docsCapability.handleMessage(
                'DOCS_GET', { docId: 'dg_test32' }, makeCtx() as any
            );
            expect(res?.success).toBe(true);
            expect(((res?.result ?? {}) as any).cached).toBe(true);
        });

        it('33 — TypeError Network + tudo vazio: retorna offline failure', async () => {
            mockGoogleScopes.mockRejectedValue(NETWORK_ERROR);
            const res = await docsCapability.handleMessage(
                'DOCS_GET', { docId: 'dg_test33' }, makeCtx() as any
            );
            expect(res?.success).toBe(false);
            expect(((res?.result ?? {}) as any).offline).toBe(true);
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FORMS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Forms', () => {

    function mockFormGetOk() {
        // FORMS_GET_RESPONSES: fetch form schema + fetch responses
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(makeRes(true, { items: [] }))
            .mockResolvedValueOnce(makeRes(true, { responses: [] }));
    }

    function mockFormsWatchFetchOk() {
        // fetchResponses no FORMS_WATCH só faz fetch de responses
        (global.fetch as jest.Mock).mockResolvedValue(makeRes(true, { responses: [] }));
    }

    // ── FORMS_WATCH — doPoll(initial=true) ────────────────────────────────────

    describe('FORMS_WATCH — doPoll(initial=true)', () => {
        async function watchForm(ctx: ReturnType<typeof makeCtx>, formId: string) {
            await formsCapability.handleMessage('FORMS_WATCH_RESPONSES', {
                formId, intervalMs: 999999, callbackName: 'onResult',
            }, ctx as any);
            await flush();
        }

        it('34 — rede ok: callback com responses e AsyncStorage gravado', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            mockFormsWatchFetchOk();
            const ctx = makeCtx();
            await watchForm(ctx, 'fw_test34');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
            expect(mockSetItem).toHaveBeenCalledWith(
                expect.stringContaining('forms_responses_cache_fw_test34'), expect.any(String)
            );
        });

        it('35 — TypeError Network + resourceCache hit: callback com cache', async () => {
            formsCache.set('fw_test35', FORMS_RESP);
            mockGoogleScopes.mockRejectedValue(NETWORK_ERROR);
            const ctx = makeCtx();
            await watchForm(ctx, 'fw_test35');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
            expect(callbackPayload(ctx.webViewRef.current.injectJavaScript)?.cached).toBe(true);
        });

        it('36 — TypeError Network + AsyncStorage hit: callback com dados persistidos [C]', async () => {
            mockGoogleScopes.mockRejectedValue(NETWORK_ERROR);
            mockGetItem.mockResolvedValue(JSON.stringify(FORMS_RESP));
            const ctx = makeCtx();
            await watchForm(ctx, 'fw_test36');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
            expect(callbackPayload(ctx.webViewRef.current.injectJavaScript)?.cached).toBe(true);
        });

        it('37 — TypeError Network + tudo vazio: callback com offline', async () => {
            mockGoogleScopes.mockRejectedValue(NETWORK_ERROR);
            const ctx = makeCtx();
            await watchForm(ctx, 'fw_test37');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(false);
            expect(callbackPayload(ctx.webViewRef.current.injectJavaScript)?.offline).toBe(true);
        });

        it('38 — HTTP 500 + resourceCache hit: callback com cache [Bug A]', async () => {
            formsCache.set('fw_test38', FORMS_RESP);
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(makeRes(false, {}, 500));
            const ctx = makeCtx();
            await watchForm(ctx, 'fw_test38');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
            expect(callbackPayload(ctx.webViewRef.current.injectJavaScript)?.cached).toBe(true);
        });

        it('39 — HTTP 500 + AsyncStorage hit: callback com dados persistidos [Bug A + C]', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(makeRes(false, {}, 500));
            mockGetItem.mockResolvedValue(JSON.stringify(FORMS_RESP));
            const ctx = makeCtx();
            await watchForm(ctx, 'fw_test39');
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(true);
        });

        it('40 — HTTP 500 + tudo vazio: callback com mensagem (não trava) [Bug A]', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(makeRes(false, {}, 500));
            const ctx = makeCtx();
            await watchForm(ctx, 'fw_test40');
            expect(ctx.webViewRef.current.injectJavaScript).toHaveBeenCalled();
            expect(callbackWasSuccess(ctx.webViewRef.current.injectJavaScript)).toBe(false);
        });
    });

    // ── FORMS_WATCH — doPoll(initial=false) ───────────────────────────────────

    describe('FORMS_WATCH — doPoll(initial=false)', () => {
        async function watchFormNonInitial(ctx: ReturnType<typeof makeCtx>, formId: string) {
            formsWatchers.set(`${ctx.appId}_${formId}`, {
                interval: setInterval(() => {}, 999999),
                webViewRef: ctx.webViewRef as any,
                callbackName: 'onResult',
                snapshot: new Set(['r1']),
            });
            await formsCapability.handleMessage('FORMS_WATCH_RESPONSES', {
                formId, intervalMs: 999999, callbackName: 'onResult',
            }, ctx as any);
            await flush();
        }

        it('41 — TypeError Network + initial=false: injectJavaScript NÃO chamado', async () => {
            mockGoogleScopes.mockRejectedValue(NETWORK_ERROR);
            const ctx = makeCtx();
            await watchFormNonInitial(ctx, 'fw_test41');
            expect(ctx.webViewRef.current.injectJavaScript).not.toHaveBeenCalled();
        });

        it('42 — HTTP 500 + initial=false: injectJavaScript NÃO chamado', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockResolvedValue(makeRes(false, {}, 500));
            const ctx = makeCtx();
            await watchFormNonInitial(ctx, 'fw_test42');
            expect(ctx.webViewRef.current.injectJavaScript).not.toHaveBeenCalled();
        });
    });

    // ── FORMS_GET_RESPONSES ────────────────────────────────────────────────────

    describe('FORMS_GET_RESPONSES', () => {

        it('43 — rede ok: retorna responses e AsyncStorage gravado', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            mockFormGetOk();
            const res = await formsCapability.handleMessage(
                'FORMS_GET_RESPONSES', { formId: 'fg_test43' }, makeCtx() as any
            );
            await flush();
            expect(res?.success).toBe(true);
            expect(mockSetItem).toHaveBeenCalledWith(
                expect.stringContaining('forms_responses_cache_fg_test43'), expect.any(String)
            );
        });

        it('44 — TypeError Network + resourceCache hit: retorna cache', async () => {
            formsCache.set('fg_test44', FORMS_RESP);
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockRejectedValue(NETWORK_ERROR);
            const res = await formsCapability.handleMessage(
                'FORMS_GET_RESPONSES', { formId: 'fg_test44' }, makeCtx() as any
            );
            expect(res?.success).toBe(true);
            expect(((res?.result ?? {}) as any).cached).toBe(true);
        });

        it('45 — TypeError Network + AsyncStorage hit: retorna dados persistidos [C]', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockRejectedValue(NETWORK_ERROR);
            mockGetItem.mockResolvedValue(JSON.stringify(FORMS_RESP));
            const res = await formsCapability.handleMessage(
                'FORMS_GET_RESPONSES', { formId: 'fg_test45' }, makeCtx() as any
            );
            expect(res?.success).toBe(true);
            expect(((res?.result ?? {}) as any).cached).toBe(true);
        });

        it('46 — TypeError Network + tudo vazio: retorna offline failure', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock).mockRejectedValue(NETWORK_ERROR);
            const res = await formsCapability.handleMessage(
                'FORMS_GET_RESPONSES', { formId: 'fg_test46' }, makeCtx() as any
            );
            expect(res?.success).toBe(false);
            expect(((res?.result ?? {}) as any).offline).toBe(true);
        });

        it('47 — HTTP 401 + resourceCache hit: retorna cache [Bug B]', async () => {
            formsCache.set('fg_test47', FORMS_RESP);
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock)
                .mockResolvedValueOnce(makeRes(true, { items: [] }))
                .mockResolvedValueOnce(makeRes(false, {}, 401));
            const res = await formsCapability.handleMessage(
                'FORMS_GET_RESPONSES', { formId: 'fg_test47' }, makeCtx() as any
            );
            expect(res?.success).toBe(true);
            expect(((res?.result ?? {}) as any).cached).toBe(true);
        });

        it('48 — HTTP 401 + AsyncStorage hit: retorna dados persistidos [Bug B + C]', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock)
                .mockResolvedValueOnce(makeRes(true, { items: [] }))
                .mockResolvedValueOnce(makeRes(false, {}, 401));
            mockGetItem.mockResolvedValue(JSON.stringify(FORMS_RESP));
            const res = await formsCapability.handleMessage(
                'FORMS_GET_RESPONSES', { formId: 'fg_test48' }, makeCtx() as any
            );
            expect(res?.success).toBe(true);
            expect(((res?.result ?? {}) as any).cached).toBe(true);
        });

        it('49 — HTTP 401 + tudo vazio: retorna failure', async () => {
            mockGoogleScopes.mockResolvedValue('token');
            (global.fetch as jest.Mock)
                .mockResolvedValueOnce(makeRes(true, { items: [] }))
                .mockResolvedValueOnce(makeRes(false, {}, 401));
            const res = await formsCapability.handleMessage(
                'FORMS_GET_RESPONSES', { formId: 'fg_test49' }, makeCtx() as any
            );
            expect(res?.success).toBe(false);
        });
    });
});
