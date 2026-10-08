jest.mock('../../mcp/manager', () => ({
    isConnected: jest.fn(async () => true),
    ensureConnectionForSlug: jest.fn(async () => ({ slug: 'picpay', name: 'PicPay', authStrategy: 'oauth', status: 'needs_auth', mcpUrl: 'https://x/mcp' })),
    connectProvider: jest.fn(async () => ({ success: true, slug: 'picpay' })),
    listProviderTools: jest.fn(async () => [{ name: 'get_balance', description: 'b' }]),
    callProviderTool: jest.fn(async () => ({ text: 'ok', raw: {}, isError: false })),
}));

jest.mock('../../bridgeUIStore', () => ({
    useBridgeUIStore: {
        getState: () => ({
            requestMcpConnect: jest.fn(async () => true),
        }),
    },
}));

import { mcpCapability } from '../mcp';

const ctx: any = { webViewRef: { current: { injectJavaScript: jest.fn() } }, appId: 1 };

describe('mcp capability', () => {
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
});
