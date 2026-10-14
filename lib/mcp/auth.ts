/**
 * MCP OAuth 2.1 client (authorization-code + PKCE + Dynamic Client Registration).
 *
 * Implements the standard MCP authorization flow used by clients like opencode
 * and Claude Code:
 *
 *   1. request the resource → 401 with `WWW-Authenticate: Bearer resource_metadata="..."`
 *   2. GET the protected-resource metadata (RFC 9728) → `authorization_servers[]`
 *   3. GET the authorization-server metadata (RFC 8414)
 *   4. register a public client via DCR (RFC 7591) when a `registration_endpoint` exists
 *   5. PKCE S256 authorization via an in-app browser
 *   6. exchange the code for tokens at the token endpoint
 *   7. persist tokens in SecureStore and reuse the refresh token (`offline_access`)
 *
 * Also supports static bearer tokens and public (no-auth) servers.
 */

import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { NativeModules } from 'react-native';
import { parseResourceMetadataUrl } from './client';
import type { McpConnection, McpTokenBundle } from './types';
import { McpAuthRequiredError } from './types';

const REDIRECT_URI = 'appacadabra://mcp-callback';
const DISCOVERY_TIMEOUT_MS = 30_000;
const LOOPBACK_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

interface LoopbackServerNative {
    start(): Promise<{ port: number }>;
    waitForCallback(timeoutMs: number): Promise<string>;
    stop(): Promise<boolean>;
}
const LoopbackServer = NativeModules.LoopbackServerModule as LoopbackServerNative | undefined;

export interface ProtectedResourceMetadata {
    resource: string;
    authorization_servers: string[];
    scopes_supported?: string[];
}

export interface AuthorizationServerMetadata {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    scopes_supported?: string[];
    response_types_supported?: string[];
    grant_types_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
    code_challenge_methods_supported?: string[];
}

function base64url(bytes: Uint8Array | string): string {
    let b64: string;
    if (typeof bytes === 'string') {
        b64 = bytes;
    } else {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        b64 = btoa(binary);
    }
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
    try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} for ${url}${text ? `: ${text.slice(0, 300)}` : ''}`);
        }
        return (await res.json()) as T;
    } finally {
        clearTimeout(timeout);
    }
}

/** Builds the `.well-known` URL inserting the path per RFC 8414 / 9728. */
function wellKnownUrl(baseUrl: string, wellKnown: string): string {
    const u = new URL(baseUrl);
    const path = u.pathname.replace(/\/$/, '');
    return `${u.origin}/.well-known/${wellKnown}${path}`;
}

/**
 * Detects the protected-resource metadata URL. Prefers the `resource_metadata`
 * advertised on the 401 response; falls back to the well-known path.
 */
export async function discoverProtectedResource(mcpUrl: string): Promise<ProtectedResourceMetadata | null> {
    let resourceMetadataUrl: string | undefined;

    // Probe: unauthenticated initialize surfaces the WWW-Authenticate header.
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
        const res = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'appacadabra', version: '1.0.0' } },
            }),
            signal: controller.signal,
        });
        clearTimeout(timeout);
        resourceMetadataUrl = parseResourceMetadataUrl(res.headers.get('www-authenticate'));
    } catch {
        // Network error — try the well-known fallback below.
    }

    if (!resourceMetadataUrl) {
        resourceMetadataUrl = wellKnownUrl(mcpUrl, 'oauth-protected-resource');
    }

    try {
        return await fetchJson<ProtectedResourceMetadata>(resourceMetadataUrl);
    } catch {
        return null;
    }
}

export async function fetchAuthorizationServerMetadata(authServerUrl: string): Promise<AuthorizationServerMetadata | null> {
    try {
        return await fetchJson<AuthorizationServerMetadata>(
            wellKnownUrl(authServerUrl, 'oauth-authorization-server'),
        );
    } catch {
        try {
            return await fetchJson<AuthorizationServerMetadata>(
                wellKnownUrl(authServerUrl, 'openid-configuration'),
            );
        } catch {
            return null;
        }
    }
}

interface DcrClient {
    client_id: string;
    client_secret?: string;
}

export async function registerClient(
    registrationEndpoint: string,
    clientName = 'Appacadabra',
    redirectUri: string = REDIRECT_URI,
): Promise<DcrClient> {
    const body = {
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
    };
    return fetchJson<DcrClient>(registrationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
}

async function exchangeCode(
    tokenEndpoint: string,
    params: Record<string, string>,
): Promise<TokenResponse> {
    const body = new URLSearchParams(params).toString();
    try {
        return await fetchJson<TokenResponse>(tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
    } catch (err) {
        throw new McpAuthRequiredError('', err instanceof Error ? err.message : 'token exchange failed');
    }
}

export interface ConnectOptions {
    /** Called with the authorization URL so the UI can observe/announce it. */
    onAuthUrl?: (url: string) => void;
    /** Extra scopes to request (e.g. write scopes). Defaults to read-only subset. */
    scopes?: string[];
    /**
     * Overrides the app deep link as redirect URI (DCR + authorize + exchange).
     * Required for servers that only accept https redirects; the https page
     * must relay the response back to the app scheme.
     */
    redirectUri?: string;
    /**
     * Serves the redirect on the device loopback (http://127.0.0.1:{port}/callback)
     * via the native LoopbackServerModule — the RFC 8252 pattern used by
     * desktop clients. Use for servers that reject custom schemes (e.g. PicPay).
     */
    loopback?: boolean;
}

/**
 * Runs the full OAuth flow for an OAuth-capable connection and returns the
 * token bundle to persist. Throws on cancellation/failure.
 */
export async function runOAuthFlow(
    connection: McpConnection,
    opts: ConnectOptions = {},
): Promise<McpTokenBundle> {
    if (opts.loopback && !LoopbackServer) {
        throw new McpAuthRequiredError(connection.slug, 'Loopback redirect unavailable');
    }
    const loopback = opts.loopback && LoopbackServer ? await LoopbackServer!.start() : null;
    const redirectUri = loopback ? `http://127.0.0.1:${loopback.port}/callback` : opts.redirectUri ?? REDIRECT_URI;
    try {
    const resource = await discoverProtectedResource(connection.mcpUrl);
    if (!resource || !resource.authorization_servers?.length) {
        throw new McpAuthRequiredError(connection.slug, 'No OAuth metadata published by server');
    }
    const authServerUrl = resource.authorization_servers[0];
    const meta = await fetchAuthorizationServerMetadata(authServerUrl);
    if (!meta || !meta.authorization_endpoint || !meta.token_endpoint) {
        throw new McpAuthRequiredError(connection.slug, 'No authorization-server metadata');
    }

    // DCR — register a public client if the server supports it and we don't
    // have one. Loopback ports are ephemeral: a stored client_id is bound to
    // a now-dead redirect, so always register fresh in that mode.
    let clientId = loopback ? undefined : connection.clientId ?? undefined;
    let clientSecret: string | undefined;
    if (!clientId && meta.registration_endpoint) {
        const reg = await registerClient(meta.registration_endpoint, 'Appacadabra', redirectUri);
        clientId = reg.client_id;
        clientSecret = reg.client_secret;
    }
    if (!clientId) {
        throw new McpAuthRequiredError(connection.slug, 'Server requires a pre-registered client_id');
    }

    // PKCE
    const verifier = base64url(await Crypto.getRandomBytesAsync(32));
    const challenge = base64url(
        await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
            encoding: Crypto.CryptoEncoding.BASE64,
        }),
    );
    const state = base64url(await Crypto.getRandomBytesAsync(16));

    const defaultScopes = resource.scopes_supported?.filter(s => /\.read$|openid|offline_access/.test(s));
    const scopes = opts.scopes ?? defaultScopes ?? resource.scopes_supported ?? [];

    const authUrl =
        `${meta.authorization_endpoint}?` +
        new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: redirectUri,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state,
            ...(scopes.length ? { scope: scopes.join(' ') } : {}),
        }).toString();

    opts.onAuthUrl?.(authUrl);

    const finishWithCallbackUrl = async (callbackUrl: string): Promise<McpTokenBundle> => {
        // Loopback callbacks are http URLs (http://127.0.0.1:{port}/callback?...)
        // which expo's Linking.parse is not designed for — use URL parsing there
        // and fall back to Linking for custom-scheme redirects.
        let queryParams: Record<string, unknown>;
        if (callbackUrl.startsWith('http://') || callbackUrl.startsWith('https://')) {
            queryParams = Object.fromEntries(new URL(callbackUrl).searchParams) as Record<string, unknown>;
        } else {
            queryParams = Linking.parse(callbackUrl).queryParams ?? {};
        }
        const code = (queryParams.code as string) || undefined;
        const returnedState = (queryParams.state as string) || undefined;
        if (!code || (returnedState && returnedState !== state)) {
            throw new McpAuthRequiredError(connection.slug, 'Invalid authorization response');
        }

        const token = await exchangeCode(meta.token_endpoint, {
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: verifier,
            ...(clientSecret ? { client_secret: clientSecret } : {}),
        });

        return {
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            tokenType: token.token_type ?? 'Bearer',
            expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
            clientId,
            clientSecret,
        };
    };

    if (loopback && LoopbackServer) {
        const callbackPromise = LoopbackServer.waitForCallback(LOOPBACK_CALLBACK_TIMEOUT_MS);
        const sessionPromise = WebBrowser.openAuthSessionAsync(authUrl, redirectUri);
        sessionPromise.catch(() => undefined);
        // The tab cannot auto-close on a loopback http URL: the native server
        // resolves with the callback URL and the browser is dismissed here.
        const callbackUrl = await Promise.race([
            callbackPromise,
            sessionPromise.then(() => {
                throw new Error('Authorization cancelled');
            }),
        ]);
        // dismissBrowser is a no-op on Android (the user closes the Custom Tab
        // manually) and returns undefined there — never let it break the flow.
        try {
            void WebBrowser.dismissBrowser?.();
        } catch {
            // ignore
        }
        return await finishWithCallbackUrl(callbackUrl);
    }

    const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri);
    if (result.type !== 'success' || !result.url) {
        throw new Error('Authorization cancelled');
    }
    return await finishWithCallbackUrl(result.url);
    } finally {
        if (loopback && LoopbackServer) void LoopbackServer.stop().catch(() => undefined);
    }
}

/** Serializes auth-server metadata for persistence in the connection row. */
export async function resolveAuthServerMeta(connection: McpConnection): Promise<string | null> {
    const resource = await discoverProtectedResource(connection.mcpUrl);
    if (!resource?.authorization_servers?.length) return null;
    const meta = await fetchAuthorizationServerMetadata(resource.authorization_servers[0]);
    if (!meta) return null;
    return JSON.stringify({
        authorizationServer: resource.authorization_servers[0],
        authorizationEndpoint: meta.authorization_endpoint,
        tokenEndpoint: meta.token_endpoint,
        registrationEndpoint: meta.registration_endpoint ?? null,
        scopesSupported: resource.scopes_supported ?? meta.scopes_supported ?? [],
    });
}
