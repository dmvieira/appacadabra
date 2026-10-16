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

/** Evaluates the injected bridge against a fake window + sendMessage. */
function loadBridge() {
    const sent: { type: string; data: any; cb: string }[] = [];
    const win: any = {};
    const sendMessage = (type: string, data: any, cb: string) => { sent.push({ type, data, cb }); };
    // eslint-disable-next-line no-new-func
    new Function('window', 'sendMessage', mcpCapability.getInjectedJS(1, false))(win, sendMessage);
    return { api: win.AppacadabraMCP, win, sent };
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
            expect(sent).toEqual([{ type: 'MCP_READ_RESOURCE', data: { slug: 'picpay', uri: 'file:///a' }, cb: 'onRes' }]);
        });
    });

    describe('injected invoke', () => {
        it('callback style forwards the callback name and returns undefined', () => {
            const { api, sent } = loadBridge();
            expect(api.callTool('picpay', 'get_balance', { a: 1 }, 'onRes')).toBeUndefined();
            expect(sent[0]).toEqual({ type: 'MCP_CALL_TOOL', data: { slug: 'picpay', tool: 'get_balance', args: { a: 1 } }, cb: 'onRes' });
        });

        it('tolerates callTool(slug, tool, callback) with omitted args', () => {
            const { api, sent } = loadBridge();
            api.callTool('picpay', 'get_balance', 'onRes');
            expect(sent[0]).toMatchObject({ data: { args: {} }, cb: 'onRes' });
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
