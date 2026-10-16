/**
 * Manager auth behavior: token recovery on 401, public-server detection and
 * the oauth → bearer switch when the user supplies an access token.
 */

jest.mock('../client', () => ({
    callTool: jest.fn(),
    listTools: jest.fn(),
    readResource: jest.fn(),
    resetSession: jest.fn(),
    ensureSession: jest.fn(async () => 'session-1'),
}));

jest.mock('../auth', () => ({
    runOAuthFlow: jest.fn(),
    resolveAuthServerMeta: jest.fn(),
}));

jest.mock('../store', () => ({
    getConnection: jest.fn(),
    upsertConnection: jest.fn(),
    upsertProviderAsConnection: jest.fn(),
    setConnectionStatus: jest.fn(async () => undefined),
    setConnectionTokenRef: jest.fn(async () => undefined),
    setConnectionClientId: jest.fn(async () => undefined),
    setConnectionAuthMeta: jest.fn(async () => undefined),
    setConnectionAuthStrategy: jest.fn(async () => undefined),
    cacheTools: jest.fn(async () => undefined),
    getCachedTools: jest.fn(async () => []),
    touchConnection: jest.fn(async () => undefined),
    deleteConnection: jest.fn(async () => undefined),
    saveToolShape: jest.fn(async () => undefined),
}));

jest.mock('../tokenStorage', () => ({
    saveTokens: jest.fn(async () => undefined),
    getTokens: jest.fn(),
    clearTokens: jest.fn(async () => undefined),
    tokenRefFor: (slug: string) => `ref:${slug}`,
}));

jest.mock('../../i18n', () => ({ t: (k: string) => k }));

import * as client from '../client';
import * as auth from '../auth';
import * as store from '../store';
import * as tokens from '../tokenStorage';
import { McpAuthRequiredError } from '../types';
import { callProviderTool, listProviderTools, readProviderResource, connectProvider, isConnected } from '../manager';

const mClient = client as jest.Mocked<typeof client>;
const mAuth = auth as jest.Mocked<typeof auth>;
const mStore = store as jest.Mocked<typeof store>;
const mTokens = tokens as jest.Mocked<typeof tokens>;

const OAUTH_CONN: any = {
    slug: 'acme',
    name: 'Acme',
    mcpUrl: 'https://mcp.acme.test/mcp',
    transport: 'streamable-http',
    authStrategy: 'oauth',
    status: 'connected',
    source: 'manual',
    authMeta: JSON.stringify({ tokenEndpoint: 'https://as.acme.test/token' }),
};

const OK = { text: 'ok', raw: { a: 1 }, isError: false };

beforeEach(() => {
    jest.clearAllMocks();
    mStore.getConnection.mockResolvedValue(OAUTH_CONN);
    mStore.getCachedTools.mockResolvedValue([]);
    (global as any).fetch = jest.fn();
});

describe('auth recovery on 401', () => {
    it('refreshes once and retries with the new token', async () => {
        mTokens.getTokens.mockResolvedValue({ accessToken: 'old', refreshToken: 'rt', clientId: 'cid' } as any);
        (global as any).fetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'new' }) });
        mClient.callTool
            .mockRejectedValueOnce(new McpAuthRequiredError('https://mcp.acme.test/mcp'))
            .mockResolvedValueOnce(OK as any);

        const res = await callProviderTool('acme', 'get', {});
        expect(res).toEqual(OK);
        expect(mClient.callTool).toHaveBeenCalledTimes(2);
        expect(mClient.callTool.mock.calls[1][3]).toEqual({ headers: { Authorization: 'Bearer new' } });
        expect(mTokens.saveTokens).toHaveBeenCalledWith('acme', expect.objectContaining({ accessToken: 'new' }));
        expect(mTokens.clearTokens).not.toHaveBeenCalled();
    });

    it('clears the token and marks needs_auth when no refresh is possible', async () => {
        mTokens.getTokens.mockResolvedValue({ accessToken: 'old' } as any);
        mClient.listTools.mockRejectedValue(new McpAuthRequiredError('x'));

        await expect(listProviderTools('acme', { forceRefresh: true })).rejects.toBeInstanceOf(McpAuthRequiredError);
        expect(mTokens.clearTokens).toHaveBeenCalledWith('acme');
        expect(mStore.setConnectionStatus).toHaveBeenCalledWith('acme', 'needs_auth');
        expect(mClient.resetSession).toHaveBeenCalledWith(OAUTH_CONN.mcpUrl);
    });

    it('clears the token when the refreshed token is also rejected', async () => {
        mTokens.getTokens.mockResolvedValue({ accessToken: 'old', refreshToken: 'rt', clientId: 'cid' } as any);
        (global as any).fetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'new' }) });
        mClient.readResource.mockRejectedValue(new McpAuthRequiredError('x'));

        await expect(readProviderResource('acme', 'res://1')).rejects.toBeInstanceOf(McpAuthRequiredError);
        expect(mClient.readResource).toHaveBeenCalledTimes(2);
        expect(mTokens.clearTokens).toHaveBeenCalledWith('acme');
    });

    it('does not touch credentials on non-auth errors', async () => {
        mTokens.getTokens.mockResolvedValue({ accessToken: 'old' } as any);
        mClient.callTool.mockRejectedValue(new Error('HTTP 500'));
        await expect(callProviderTool('acme', 'get', {})).rejects.toThrow('HTTP 500');
        expect(mTokens.clearTokens).not.toHaveBeenCalled();
        expect(mStore.setConnectionStatus).not.toHaveBeenCalled();
    });

    it('fails fast without a token for authenticated strategies', async () => {
        mTokens.getTokens.mockResolvedValue(null);
        await expect(callProviderTool('acme', 'get', {})).rejects.toBeInstanceOf(McpAuthRequiredError);
        expect(mClient.callTool).not.toHaveBeenCalled();
    });

    it('public servers (none) never get credentials invalidated', async () => {
        mStore.getConnection.mockResolvedValue({ ...OAUTH_CONN, authStrategy: 'none' });
        mClient.callTool.mockRejectedValue(new McpAuthRequiredError('x'));
        await expect(callProviderTool('acme', 'get', {})).rejects.toBeInstanceOf(McpAuthRequiredError);
        expect(mTokens.clearTokens).not.toHaveBeenCalled();
    });
});

describe('connectProvider', () => {
    it('persists authStrategy none when an oauth server turns out to be public', async () => {
        mStore.getConnection.mockResolvedValue({ ...OAUTH_CONN, status: 'needs_auth', authMeta: null });
        mAuth.resolveAuthServerMeta.mockResolvedValue(null);
        mClient.listTools.mockResolvedValue([{ name: 't' }] as any);

        const res = await connectProvider({ ...OAUTH_CONN, status: 'needs_auth' });
        expect(res.success).toBe(true);
        expect(mStore.setConnectionAuthStrategy).toHaveBeenCalledWith('acme', 'none');
        expect(mStore.setConnectionStatus).toHaveBeenCalledWith('acme', 'connected');
    });

    it('reports auth required when the server rejects and publishes no OAuth metadata', async () => {
        mStore.getConnection.mockResolvedValue({ ...OAUTH_CONN, status: 'needs_auth', authMeta: null });
        mAuth.resolveAuthServerMeta.mockResolvedValue(null);
        mClient.listTools.mockRejectedValue(new McpAuthRequiredError('x'));

        const res = await connectProvider({ ...OAUTH_CONN, status: 'needs_auth' });
        expect(res).toMatchObject({ success: false, error: 'mcpErrorAuthRequired' });
        expect(mStore.setConnectionStatus).toHaveBeenCalledWith('acme', 'needs_auth');
    });

    it('switches an oauth connection to bearer when a token is supplied', async () => {
        mStore.getConnection.mockResolvedValue({ ...OAUTH_CONN, status: 'needs_auth' });
        mTokens.getTokens.mockResolvedValue({ accessToken: 'api-key' } as any);
        mClient.listTools.mockResolvedValue([] as any);

        const res = await connectProvider({ ...OAUTH_CONN, status: 'needs_auth' }, { bearerToken: 'api-key' });
        expect(res.success).toBe(true);
        expect(mStore.setConnectionAuthStrategy).toHaveBeenCalledWith('acme', 'bearer');
        expect(mTokens.saveTokens).toHaveBeenCalledWith('acme', { accessToken: 'api-key', tokenType: 'Bearer' });
        expect(mAuth.runOAuthFlow).not.toHaveBeenCalled();
    });

    it('bearer without token fails with token required', async () => {
        mStore.getConnection.mockResolvedValue({ ...OAUTH_CONN, authStrategy: 'bearer', status: 'needs_auth' });
        const res = await connectProvider({ ...OAUTH_CONN, authStrategy: 'bearer', status: 'needs_auth' });
        expect(res).toMatchObject({ success: false, error: 'mcpErrorTokenRequired' });
    });
});

describe('isConnected', () => {
    it('is false once the token was cleared after a 401', async () => {
        mTokens.getTokens.mockResolvedValue(null);
        expect(await isConnected('acme')).toBe(false);
    });
});
