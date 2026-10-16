jest.mock('../../mcp/manager', () => ({
    isConnected: jest.fn(async () => true),
    ensureConnectionForSlug: jest.fn(async () => ({ slug: 'picpay', name: 'PicPay', authStrategy: 'oauth', status: 'needs_auth', mcpUrl: 'https://x/mcp' })),
    connectProvider: jest.fn(async () => ({ success: true, slug: 'picpay' })),
    listProviderTools: jest.fn(async () => [{ name: 'get_balance', description: 'b' }]),
    callProviderTool: jest.fn(async () => ({ text: 'ok', raw: {}, isError: false })),
    readProviderResource: jest.fn(async (_slug: string, uri: string) => ({ uri, contents: [{ text: 'hello' }] })),
}));

const mockRequestMcpConnect = jest.fn(async () => true);
jest.mock('../../bridgeUIStore', () => ({
    useBridgeUIStore: {
        getState: () => ({
            requestMcpConnect: mockRequestMcpConnect,
        }),
    },
}));

import { mcpCapability } from '../mcp';
import * as manager from '../../mcp/manager';
import { McpAuthRequiredError } from '../../mcp/types';

const mockedManager = manager as jest.Mocked<typeof manager>;

const ctx: any = { webViewRef: { current: { injectJavaScript: jest.fn() } }, appId: null };

/** Evaluates the injected bridge against a fake window + sendMessage + console. */
function loadBridge() {
    const sent: { type: string; data: any; cb: string }[] = [];
    const win: any = {};
    const fakeConsole = { log: jest.fn() };
    const sendMessage = (type: string, data: any, cb: string) => { sent.push({ type, data, cb }); };
    // eslint-disable-next-line no-new-func
    new Function('window', 'sendMessage', 'console', mcpCapability.getInjectedJS(1, false))(win, sendMessage, fakeConsole);
    return { api: win.AppacadabraMCP, win, sent, logs: fakeConsole.log };
}

describe('mcp capability', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockedManager.isConnected.mockResolvedValue(true);
        mockRequestMcpConnect.mockResolvedValue(true);
    });

    it('exposes the AppacadabraMCP bridge in injected JS', () => {
        const js = mcpCapability.getInjectedJS(1, false);
        expect(js).toContain('window.AppacadabraMCP');
        expect(js).toContain('listTools');
        expect(js).toContain('callTool');
        expect(js).toContain('MCP_CALL_TOOL');
    });

    it('does not claim unrelated message types', async () => {
        expect(await mcpCapability.handleMessage('STORAGE_SET', {}, ctx)).toBeNull();
    });

    it('lists tools via the bridge', async () => {
        const res = await mcpCapability.handleMessage('MCP_LIST_TOOLS', { slug: 'picpay' }, ctx);
        expect(res).toMatchObject({ success: true });
        expect((res as any).result[0].name).toBe('get_balance');
    });

    it('calls a tool via the bridge', async () => {
        const res = await mcpCapability.handleMessage('MCP_CALL_TOOL', { slug: 'picpay', tool: 'get_balance', args: {} }, ctx);
        expect(res).toMatchObject({ success: true });
        expect((res as any).result.text).toBe('ok');
    });

    it('returns connectivity', async () => {
        const res = await mcpCapability.handleMessage('MCP_IS_CONNECTED', { slug: 'picpay' }, ctx);
        expect(res).toMatchObject({ success: true, result: true });
    });

    it('validates missing slug', async () => {
        const res = await mcpCapability.handleMessage('MCP_CALL_TOOL', { slug: '', tool: '' }, ctx);
        expect(res).toMatchObject({ success: false });
    });

    describe('readResource', () => {
        it('reads a resource from the given server', async () => {
            const res = await mcpCapability.handleMessage('MCP_READ_RESOURCE', { slug: 'picpay', uri: 'file:///a' }, ctx);
            expect(res).toMatchObject({ success: true, result: { uri: 'file:///a' } });
            expect(mockedManager.readProviderResource).toHaveBeenCalledWith('picpay', 'file:///a');
        });

        it('rejects a call without slug or uri', async () => {
            expect(await mcpCapability.handleMessage('MCP_READ_RESOURCE', { uri: 'file:///a' }, ctx)).toMatchObject({ success: false });
            expect(await mcpCapability.handleMessage('MCP_READ_RESOURCE', { slug: 'picpay' }, ctx)).toMatchObject({ success: false });
            expect(mockedManager.readProviderResource).not.toHaveBeenCalled();
        });

        it('injected readResource sends both slug and uri', () => {
            const { api, sent } = loadBridge();
            api.readResource('picpay', 'file:///a', 'onRes');
            expect(sent[0]).toMatchObject({ type: 'MCP_READ_RESOURCE', data: { slug: 'picpay', uri: 'file:///a' } });
            expect(sent[0].cb).not.toBe('onRes');
        });
    });

    describe('injected invoke', () => {
        it('callback style wraps the callback (for logging) and still delivers to the user global', () => {
            const { api, win, sent } = loadBridge();
            win.onRes = jest.fn();
            expect(api.callTool('picpay', 'get_balance', { a: 1 }, 'onRes')).toBeUndefined();
            expect(sent[0]).toMatchObject({ type: 'MCP_CALL_TOOL', data: { slug: 'picpay', tool: 'get_balance', args: { a: 1 } } });
            expect(sent[0].cb).not.toBe('onRes');
            win[sent[0].cb](true, { ok: 1 });
            expect(win.onRes).toHaveBeenCalledWith(true, { ok: 1 });
            expect(win[sent[0].cb]).toBeUndefined();
        });

        it('tolerates callTool(slug, tool, callback) with omitted args', () => {
            const { api, win, sent } = loadBridge();
            win.onRes = jest.fn();
            api.callTool('picpay', 'get_balance', 'onRes');
            expect(sent[0]).toMatchObject({ data: { args: {} } });
            win[sent[0].cb](true, {});
            expect(win.onRes).toHaveBeenCalled();
        });

        it('promise style resolves { success, data } and removes the temp callback', async () => {
            const { api, win, sent } = loadBridge();
            const p = api.callTool('picpay', 'get_balance', {});
            const cb = sent[0].cb;
            expect(typeof win[cb]).toBe('function');
            win[cb](true, { text: 'ok' });
            await expect(p).resolves.toEqual({ success: true, data: { text: 'ok' } });
            expect(win[cb]).toBeUndefined();
        });

        it('promise style uses unique callback names per call', () => {
            const { api, sent } = loadBridge();
            void api.listTools('picpay');
            void api.listTools('picpay');
            expect(sent[0].cb).not.toBe(sent[1].cb);
        });
    });

    describe('injected MCP logging (mandatory raw echo)', () => {
        it('logs the raw payload on promise-style callTool', async () => {
            const { api, win, sent, logs } = loadBridge();
            const p = api.callTool('picpay', 'get_balance', {});
            win[sent[0].cb](true, { text: 'ok', raw: { dias: [{ dia: '2026-10-16', valor: '123.45' }] }, isError: false });
            await p;
            expect(logs).toHaveBeenCalledTimes(1);
            const msg = logs.mock.calls[0][0] as string;
            expect(msg).toContain('[MCP] picpay.get_balance → ');
            expect(msg).toContain('"valor":"123.45"');
        });

        it('logs BEFORE invoking the user callback (callback style)', () => {
            const { api, win, sent, logs } = loadBridge();
            const order: string[] = [];
            logs.mockImplementation(() => { order.push('log'); });
            win.onRes = () => { order.push('cb'); };
            api.callTool('picpay', 'get_balance', {}, 'onRes');
            win[sent[0].cb](true, { text: 'ok', raw: { a: 1 }, isError: false });
            expect(order).toEqual(['log', 'cb']);
        });

        it('marks tool-level errors with ✗', () => {
            const { api, win, sent, logs } = loadBridge();
            win.onRes = () => undefined;
            api.callTool('picpay', 'get_balance', {}, 'onRes');
            win[sent[0].cb](true, { text: 'nope', raw: {}, isError: true });
            expect(logs.mock.calls[0][0]).toContain('✗');
        });

        it('truncates very large raw payloads with a size marker', () => {
            const { api, win, sent, logs } = loadBridge();
            win.onRes = () => undefined;
            api.callTool('picpay', 'get_balance', {}, 'onRes');
            win[sent[0].cb](true, { text: 'ok', raw: { blob: 'x'.repeat(5000) }, isError: false });
            const msg = logs.mock.calls[0][0] as string;
            expect(msg.length).toBeLessThan(1600);
            expect(msg).toContain('…[');
        });

        it('listTools logs the tool count and first names', () => {
            const { api, win, sent, logs } = loadBridge();
            api.listTools('picpay', 'onTools');
            win[sent[0].cb](true, [{ name: 'get_balance' }, { name: 'statements_list' }]);
            expect(logs.mock.calls[0][0]).toContain('[MCP] picpay.listTools → 2 tools: get_balance, statements_list');
        });

        it('readResource logs the contents', () => {
            const { api, win, sent, logs } = loadBridge();
            api.readResource('picpay', 'res://1', 'onRes');
            win.onRes = () => undefined;
            win[sent[0].cb](true, { uri: 'res://1', contents: [{ text: 'hi' }] });
            expect(logs.mock.calls[0][0]).toContain('picpay.readResource(res://1)');
            expect(logs.mock.calls[0][0]).toContain('"text":"hi"');
        });

        it('a console failure never breaks the response delivery', () => {
            const sent2: { type: string; data: any; cb: string }[] = [];
            const win: any = {};
            const brokenConsole = { log: () => { throw new Error('boom'); } };
            // eslint-disable-next-line no-new-func
            new Function('window', 'sendMessage', 'console', mcpCapability.getInjectedJS(1, false))(
                win,
                (type: string, data: any, cb: string) => { sent2.push({ type, data, cb }); },
                brokenConsole,
            );
            win.onRes = jest.fn();
            win.AppacadabraMCP.callTool('picpay', 'get_balance', {}, 'onRes');
            win[sent2[0].cb](true, { text: 'ok', raw: {}, isError: false });
            expect(win.onRes).toHaveBeenCalledWith(true, { text: 'ok', raw: {}, isError: false });
        });
    });

    describe('auth recovery', () => {
        it('re-runs login once and retries when the server rejects the token', async () => {
            mockedManager.callProviderTool
                .mockRejectedValueOnce(new McpAuthRequiredError('picpay'))
                .mockResolvedValueOnce({ text: 'ok2', raw: {}, isError: false } as any);
            // Manager cleared the token → not connected anymore.
            mockedManager.isConnected.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
            const res = await mcpCapability.handleMessage('MCP_CALL_TOOL', { slug: 'picpay', tool: 'get_balance', args: {} }, ctx);
            expect(res).toMatchObject({ success: true, result: { text: 'ok2' } });
            expect(mockRequestMcpConnect).toHaveBeenCalledTimes(1);
            expect(mockedManager.connectProvider).toHaveBeenCalledTimes(1);
            expect(mockedManager.callProviderTool).toHaveBeenCalledTimes(2);
        });

        it('surfaces cancellation when the user declines the re-login', async () => {
            mockedManager.listProviderTools.mockRejectedValueOnce(new McpAuthRequiredError('picpay'));
            mockedManager.isConnected.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
            mockRequestMcpConnect.mockResolvedValueOnce(false);
            const res = await mcpCapability.handleMessage('MCP_LIST_TOOLS', { slug: 'picpay' }, ctx);
            expect(res).toMatchObject({ success: false });
            expect(mockedManager.listProviderTools).toHaveBeenCalledTimes(1);
        });

        it('does not retry non-auth errors', async () => {
            mockedManager.callProviderTool.mockRejectedValueOnce(new Error('boom'));
            const res = await mcpCapability.handleMessage('MCP_CALL_TOOL', { slug: 'picpay', tool: 'get_balance', args: {} }, ctx);
            expect(res).toMatchObject({ success: false, result: 'boom' });
            expect(mockedManager.callProviderTool).toHaveBeenCalledTimes(1);
        });
    });
});
