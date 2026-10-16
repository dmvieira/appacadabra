/**
 * Tests for the OAuth flow's redirect URI handling.
 *
 * PicPay's DCR rejects custom URI schemes ("field 'redirect_uris' must use
 * https scheme"), so the flow must thread an https relay URI through client
 * registration, the authorize URL, and the token exchange.
 */

import {
    registerClient,
    runOAuthFlow,
    resolveAuthorizationServer,
    discoverProtectedResource,
    fetchAuthorizationServerMetadata,
    resolveAuthServerMeta,
} from '../auth';

jest.mock('expo-crypto', () => ({
    getRandomBytesAsync: jest.fn(async () => new Uint8Array(16).fill(1)),
    CryptoDigestAlgorithm: { SHA256: 'SHA256' },
    CryptoEncoding: { BASE64: 'BASE64' },
    digestStringAsync: jest.fn(async () => 'ZGlnZXN0'),
}));

jest.mock('expo-web-browser', () => ({
    openAuthSessionAsync: jest.fn(),
    // Android: the native module has no dismissBrowser, so the JS export
    // returns undefined — the flow must survive that.
    dismissBrowser: jest.fn(() => undefined),
}));

jest.mock('expo-linking', () => ({
    parse: jest.fn(),
}));

jest.mock('react-native', () => ({
    NativeModules: {
        LoopbackServerModule: {
            start: jest.fn(),
            waitForCallback: jest.fn(),
            stop: jest.fn(async () => true),
        },
    },
}));

import { NativeModules } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';

const LoopbackServer = (NativeModules as any).LoopbackServerModule;

const CONNECTION = {
    id: 1,
    slug: 'picpay',
    name: 'PicPay',
    mcpUrl: 'https://mcp.example/v2/mcp',
    transport: 'streamable-http' as const,
    authStrategy: 'oauth' as const,
    status: 'needs_auth' as const,
    source: 'curated' as const,
    createdAt: 0,
};

const PROTECTED_RESOURCE = {
    resource: 'https://mcp.example/v2/mcp',
    authorization_servers: ['https://as.example'],
    scopes_supported: ['openid', 'offline_access', 'wallet.read'],
};

const AS_METADATA = {
    issuer: 'https://as.example',
    authorization_endpoint: 'https://as.example/authorize',
    token_endpoint: 'https://as.example/token',
    registration_endpoint: 'https://mcp.example/v2/mcp/register',
};

function jsonResponse(body: unknown, status = 200) {
    return { ok: status < 400, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

/** Installs a fetch mock that answers the discovery/DCR/token sequence and records requests. */
function installFetchFlow(opts: { registrationStatus?: number; registrationBody?: unknown } = {}) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.includes('oauth-protected-resource')) return jsonResponse(PROTECTED_RESOURCE);
        if (url.includes('oauth-authorization-server')) return jsonResponse(AS_METADATA);
        if (url.endsWith('/register')) {
            if (opts.registrationStatus && opts.registrationStatus >= 400) {
                return {
                    ok: false,
                    status: opts.registrationStatus,
                    text: () => Promise.resolve(JSON.stringify(opts.registrationBody)),
                    json: () => Promise.reject(new Error('not json')),
                };
            }
            return jsonResponse({ client_id: 'client-123' });
        }
        if (url.endsWith('/token')) return jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
        return jsonResponse({}, 404);
    });
    return calls;
}

beforeEach(() => {
    (WebBrowser.openAuthSessionAsync as jest.Mock).mockImplementation(async (authUrl: string) => ({
        type: 'success',
        url: `https://appacadabra.ai/mcp-callback.html?code=xyz&state=${new URL(authUrl).searchParams.get('state')}`,
    }));
    (Linking.parse as jest.Mock).mockImplementation((url: string) => ({
        queryParams: Object.fromEntries(new URL(url).searchParams),
    }));
});

afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
});

describe('registerClient', () => {
    it('registers with the default custom-scheme redirect', async () => {
        const calls = installFetchFlow();
        const client = await registerClient('https://mcp.example/v2/mcp/register');
        expect(client.client_id).toBe('client-123');
        const body = JSON.parse((calls[0].init!.body as string));
        expect(body.redirect_uris).toEqual(['appacadabra://mcp-callback']);
    });

    it('registers with the https relay when overridden', async () => {
        const calls = installFetchFlow();
        await registerClient('https://mcp.example/v2/mcp/register', 'Appacadabra', 'https://appacadabra.ai/mcp-callback.html');
        const body = JSON.parse((calls[0].init!.body as string));
        expect(body.redirect_uris).toEqual(['https://appacadabra.ai/mcp-callback.html']);
    });

    it('surfaces the server error body in the thrown message', async () => {
        installFetchFlow({
            registrationStatus: 400,
            registrationBody: { error: 'invalid_client_metadata', error_description: "field 'redirect_uris' must use https scheme" },
        });
        await expect(registerClient('https://mcp.example/v2/mcp/register'))
            .rejects
            .toThrow(/invalid_client_metadata/);
    });
});

describe('runOAuthFlow redirect URI threading', () => {
    it('uses the custom scheme by default (DCR, authorize, exchange)', async () => {
        const calls = installFetchFlow();
        await runOAuthFlow(CONNECTION);

        const registerBody = JSON.parse(calls.find(c => c.url.endsWith('/register'))!.init!.body as string);
        expect(registerBody.redirect_uris).toEqual(['appacadabra://mcp-callback']);

        const authCall = (WebBrowser.openAuthSessionAsync as jest.Mock).mock.calls[0];
        expect(authCall[0]).toContain('redirect_uri=appacadabra%3A%2F%2Fmcp-callback');
        expect(authCall[1]).toBe('appacadabra://mcp-callback');

        const tokenBody = new URLSearchParams(calls.find(c => c.url.endsWith('/token'))!.init!.body as string);
        expect(tokenBody.get('redirect_uri')).toBe('appacadabra://mcp-callback');
    });

    it('threads the https relay through DCR, authorize and exchange', async () => {
        const calls = installFetchFlow();
        const bundle = await runOAuthFlow(CONNECTION, { redirectUri: 'https://appacadabra.ai/mcp-callback.html' });

        const registerBody = JSON.parse(calls.find(c => c.url.endsWith('/register'))!.init!.body as string);
        expect(registerBody.redirect_uris).toEqual(['https://appacadabra.ai/mcp-callback.html']);

        const authCall = (WebBrowser.openAuthSessionAsync as jest.Mock).mock.calls[0];
        expect(authCall[0]).toContain(encodeURIComponent('https://appacadabra.ai/mcp-callback.html'));
        expect(authCall[1]).toBe('https://appacadabra.ai/mcp-callback.html');

        const tokenBody = new URLSearchParams(calls.find(c => c.url.endsWith('/token'))!.init!.body as string);
        expect(tokenBody.get('redirect_uri')).toBe('https://appacadabra.ai/mcp-callback.html');

        expect(bundle.accessToken).toBe('at-1');
        expect(bundle.clientId).toBe('client-123');
    });
});

describe('runOAuthFlow loopback redirect (PicPay-style servers)', () => {
    beforeEach(() => {
        (WebBrowser.openAuthSessionAsync as jest.Mock).mockReset();
        (WebBrowser.dismissBrowser as jest.Mock).mockClear();
        LoopbackServer.start.mockReset();
        LoopbackServer.waitForCallback.mockReset();
        LoopbackServer.stop.mockClear();
    });

    function armLoopback(port: number) {
        LoopbackServer.start.mockResolvedValue({ port });
        // The callback URL must echo the state from the generated authorize URL.
        LoopbackServer.waitForCallback.mockImplementation(() => new Promise<string>(resolve => {
            (WebBrowser.openAuthSessionAsync as jest.Mock).mockImplementationOnce(async (authUrl: string) => {
                const state = new URL(authUrl).searchParams.get('state');
                resolve(`http://127.0.0.1:${port}/callback?code=xyz&state=${state}`);
                return { type: 'dismissed' };
            });
        }));
    }

    it('serves the redirect on the loopback and registers a fresh client', async () => {
        const calls = installFetchFlow();
        armLoopback(4567);
        // A stored client_id is bound to a dead port — must NOT be reused.
        const bundle = await runOAuthFlow({ ...CONNECTION, clientId: 'stale-client' }, { loopback: true });

        expect(LoopbackServer.start).toHaveBeenCalled();

        const registerBody = JSON.parse(calls.find(c => c.url.endsWith('/register'))!.init!.body as string);
        expect(registerBody.redirect_uris).toEqual(['http://127.0.0.1:4567/callback']);

        const authCall = (WebBrowser.openAuthSessionAsync as jest.Mock).mock.calls[0];
        expect(authCall[0]).toContain(encodeURIComponent('http://127.0.0.1:4567/callback'));
        expect(authCall[1]).toBe('http://127.0.0.1:4567/callback');

        expect(WebBrowser.dismissBrowser).toHaveBeenCalled();

        const tokenBody = new URLSearchParams(calls.find(c => c.url.endsWith('/token'))!.init!.body as string);
        expect(tokenBody.get('redirect_uri')).toBe('http://127.0.0.1:4567/callback');
        expect(tokenBody.get('code')).toBe('xyz');

        expect(bundle.accessToken).toBe('at-1');
        // Fresh DCR client, not the stale one.
        expect(bundle.clientId).toBe('client-123');

        expect(LoopbackServer.stop).toHaveBeenCalled();
    });

    it('parses loopback http callbacks without expo Linking and survives a no-op dismissBrowser', async () => {
        installFetchFlow();
        armLoopback(4567);
        // The mocked openAuthSessionAsync echoes the state into the URL the
        // native server would receive; Linking.parse is NOT consulted for
        // http callbacks — Object.fromEntries(new URL(...)) is used instead.
        const linkParse = Linking.parse as jest.Mock;
        linkParse.mockClear();
        const bundle = await runOAuthFlow(CONNECTION, { loopback: true });

        expect(linkParse).not.toHaveBeenCalled();
        expect(WebBrowser.dismissBrowser).toHaveBeenCalled();
        expect(bundle.accessToken).toBe('at-1');
    });

    it('stops the loopback server when the user cancels', async () => {
        installFetchFlow();
        LoopbackServer.start.mockResolvedValue({ port: 4567 });
        LoopbackServer.waitForCallback.mockReturnValue(new Promise(() => undefined)); // never fires
        (WebBrowser.openAuthSessionAsync as jest.Mock).mockResolvedValue({ type: 'cancel' });

        await expect(runOAuthFlow(CONNECTION, { loopback: true }))
            .rejects
            .toThrow('Authorization cancelled');
        expect(LoopbackServer.stop).toHaveBeenCalled();
    });
});

describe('authorization-server discovery fallbacks', () => {
    /** Fetch mock routed by exact URL; the MCP POST probe answers `probe`. */
    function installRoutes(routes: Record<string, unknown>, probe: { status: number; wwwAuthenticate?: string } = { status: 401 }) {
        const urls: string[] = [];
        (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
            urls.push(url);
            if (init?.method === 'POST' && url === 'https://mcp.example/v2/mcp') {
                return {
                    ok: probe.status < 400,
                    status: probe.status,
                    headers: { get: (h: string) => (h.toLowerCase() === 'www-authenticate' ? probe.wwwAuthenticate ?? null : null) },
                    json: () => Promise.resolve({}),
                    text: () => Promise.resolve(''),
                };
            }
            if (url in routes) return jsonResponse(routes[url]);
            return jsonResponse({}, 404);
        });
        return urls;
    }

    it('falls back to the origin-root protected-resource well-known', async () => {
        installRoutes({
            'https://mcp.example/.well-known/oauth-protected-resource': PROTECTED_RESOURCE,
            'https://as.example/.well-known/oauth-authorization-server': AS_METADATA,
        });
        const resolved = await resolveAuthorizationServer('https://mcp.example/v2/mcp');
        expect(resolved).toMatchObject({ authorizationServer: 'https://as.example', legacy: false });
        expect(resolved!.resourceScopes).toEqual(PROTECTED_RESOURCE.scopes_supported);
    });

    it('prefers the resource_metadata URL advertised on the 401', async () => {
        const urls = installRoutes(
            {
                'https://meta.example/prm': PROTECTED_RESOURCE,
                'https://as.example/.well-known/oauth-authorization-server': AS_METADATA,
            },
            { status: 401, wwwAuthenticate: 'Bearer resource_metadata="https://meta.example/prm"' },
        );
        const resource = await discoverProtectedResource('https://mcp.example/v2/mcp');
        expect(resource?.authorization_servers).toEqual(['https://as.example']);
        expect(urls).not.toContain('https://mcp.example/.well-known/oauth-protected-resource/v2/mcp');
    });

    it('skips metadata that names no authorization server', async () => {
        installRoutes({
            'https://mcp.example/.well-known/oauth-protected-resource/v2/mcp': { resource: 'x', authorization_servers: [] },
            'https://mcp.example/.well-known/oauth-protected-resource': PROTECTED_RESOURCE,
        });
        const resource = await discoverProtectedResource('https://mcp.example/v2/mcp');
        expect(resource?.authorization_servers).toEqual(['https://as.example']);
    });

    it('falls back to OIDC discovery appended to the issuer path', async () => {
        installRoutes({
            'https://as.example/tenant/.well-known/openid-configuration': AS_METADATA,
        });
        const meta = await fetchAuthorizationServerMetadata('https://as.example/tenant');
        expect(meta?.token_endpoint).toBe('https://as.example/token');
    });

    it('legacy servers: uses the MCP origin as authorization server when the endpoint answers 401', async () => {
        installRoutes({
            'https://mcp.example/.well-known/oauth-authorization-server': AS_METADATA,
        });
        const resolved = await resolveAuthorizationServer('https://mcp.example/v2/mcp');
        expect(resolved).toMatchObject({ authorizationServer: 'https://mcp.example', legacy: true, resourceScopes: null });
    });

    it('legacy fallback is NOT used for public endpoints (no 401)', async () => {
        installRoutes(
            { 'https://mcp.example/.well-known/oauth-authorization-server': AS_METADATA },
            { status: 200 },
        );
        expect(await resolveAuthorizationServer('https://mcp.example/v2/mcp')).toBeNull();
    });

    it('runOAuthFlow completes against a legacy server', async () => {
        installRoutes({
            'https://mcp.example/.well-known/oauth-authorization-server': {
                ...AS_METADATA,
                registration_endpoint: 'https://mcp.example/register',
                token_endpoint: 'https://mcp.example/token',
            },
            'https://mcp.example/register': { client_id: 'legacy-client' },
            'https://mcp.example/token': { access_token: 'at-legacy' },
        });
        const bundle = await runOAuthFlow(CONNECTION);
        expect(bundle).toMatchObject({ accessToken: 'at-legacy', clientId: 'legacy-client' });
    });

    it('resolveAuthServerMeta returns null when nothing is discoverable', async () => {
        installRoutes({}, { status: 401 });
        expect(await resolveAuthServerMeta(CONNECTION)).toBeNull();
    });
});
