/**
 * MCP manager — orchestrates store + token storage + client + auth for the
 * runtime capability and the Settings UI.
 */

import {
    callTool as clientCallTool,
    listTools as clientListTools,
    resetSession,
    ensureSession,
} from './client';
import { runOAuthFlow, resolveAuthServerMeta } from './auth';
import {
    getConnection,
    upsertConnection,
    upsertProviderAsConnection,
    setConnectionStatus,
    setConnectionTokenRef,
    setConnectionClientId,
    setConnectionAuthMeta,
    cacheTools,
    getCachedTools,
    touchConnection,
    deleteConnection,
} from './store';
import { saveTokens, getTokens, clearTokens, tokenRefFor } from './tokenStorage';
import type { McpCallResult, McpConnection, McpProvider, McpTokenBundle, McpTool } from './types';
import { McpAuthRequiredError } from './types';

export interface ConnectResult {
    success: boolean;
    slug: string;
    accountLabel?: string;
    error?: string;
}

function parseScopes(authMeta?: string | null): string[] {
    if (!authMeta) return [];
    try {
        const parsed = JSON.parse(authMeta) as { scopesSupported?: string[]; tokenEndpoint?: string };
        return parsed.scopesSupported ?? [];
    } catch {
        return [];
    }
}

function parseTokenEndpoint(authMeta?: string | null): string | undefined {
    if (!authMeta) return undefined;
    try {
        return (JSON.parse(authMeta) as { tokenEndpoint?: string }).tokenEndpoint;
    } catch {
        return undefined;
    }
}

async function refreshTokens(connection: McpConnection, bundle: McpTokenBundle): Promise<McpTokenBundle> {
    const tokenEndpoint = parseTokenEndpoint(connection.authMeta);
    if (!tokenEndpoint || !bundle.refreshToken || !bundle.clientId) return bundle;
    try {
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: bundle.refreshToken,
            client_id: bundle.clientId,
            ...(bundle.clientSecret ? { client_secret: bundle.clientSecret } : {}),
        }).toString();
        const res = await fetch(tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        if (!res.ok) return bundle;
        const json = (await res.json()) as {
            access_token: string;
            refresh_token?: string;
            token_type?: string;
            expires_in?: number;
        };
        const refreshed: McpTokenBundle = {
            ...bundle,
            accessToken: json.access_token,
            refreshToken: json.refresh_token ?? bundle.refreshToken,
            tokenType: json.token_type ?? bundle.tokenType,
            expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
        };
        await saveTokens(connection.slug, refreshed);
        return refreshed;
    } catch {
        return bundle;
    }
}

/** Returns auth headers for a connection, refreshing the token if needed. */
async function buildAuthHeaders(connection: McpConnection): Promise<Record<string, string>> {
    if (connection.authStrategy === 'none') return {};
    let bundle = await getTokens(connection.slug);
    if (!bundle) return {};
    if (bundle.expiresAt && Date.now() > bundle.expiresAt - 60_000 && bundle.refreshToken) {
        bundle = await refreshTokens(connection, bundle);
    }
    return { Authorization: `Bearer ${bundle.accessToken}` };
}

/** Ensures a stored connection row exists for the given slug. */
export async function ensureConnectionRow(slug: string): Promise<McpConnection | null> {
    return getConnection(slug);
}

/**
 * Returns the connection row for a slug, materializing it from the curated
 * catalog when the slug is known but no row exists yet.
 */
export async function ensureConnectionForSlug(slug: string): Promise<McpConnection | null> {
    let connection = await getConnection(slug);
    if (connection) return connection;
    try {
        const { getCuratedProvider } = require('./curatedCatalog');
        const provider = getCuratedProvider(slug);
        if (provider) {
            await upsertProviderAsConnection(provider);
            connection = await getConnection(slug);
        }
    } catch {
        // ignore
    }
    return connection;
}

/**
 * Connects (auth) a provider/connection. `bearerToken` is required for
 * `bearer`-strategy servers; OAuth servers run the full browser flow.
 */
export async function connectProvider(
    providerOrConnection: McpProvider | McpConnection,
    opts: { bearerToken?: string; scopes?: string[]; accountLabel?: string } = {},
): Promise<ConnectResult> {
    const slug = providerOrConnection.slug;

    // Materialize the row if we were given a provider descriptor.
    if (!('authStrategy' in providerOrConnection) || !('status' in providerOrConnection)) {
        await upsertProviderAsConnection(providerOrConnection as McpProvider);
    }
    let connection = await getConnection(slug);
    if (!connection) {
        return { success: false, slug, error: 'Connection not found' };
    }

    try {
        if (connection.authStrategy === 'none') {
            await setConnectionStatus(slug, 'connected');
            return { success: true, slug };
        }

        if (connection.authStrategy === 'bearer') {
            if (!opts.bearerToken) return { success: false, slug, error: 'Token required' };
            await saveTokens(slug, { accessToken: opts.bearerToken, tokenType: 'Bearer' });
            await setConnectionTokenRef(slug, tokenRefFor(slug));
            await setConnectionStatus(slug, 'connected', opts.accountLabel ?? null);
            resetSession(connection.mcpUrl);
            return { success: true, slug, accountLabel: opts.accountLabel };
        }

        // OAuth
        const authMeta = await resolveAuthServerMeta(connection);
        if (!authMeta) {
            // Server does not publish OAuth metadata. It may be public: probe it.
            try {
                const tools = await clientListTools(connection.mcpUrl, { headers: {} });
                await cacheTools(slug, tools);
                await setConnectionStatus(slug, 'connected');
                return { success: true, slug };
            } catch (probeErr) {
                if (probeErr instanceof McpAuthRequiredError) {
                    await setConnectionStatus(slug, 'needs_auth');
                    return { success: false, slug, error: 'Authentication required' };
                }
                await setConnectionStatus(slug, 'error');
                return { success: false, slug, error: probeErr instanceof Error ? probeErr.message : 'Connection failed' };
            }
        }
        await setConnectionAuthMeta(slug, authMeta);
        connection = (await getConnection(slug))!;

        const bundle = await runOAuthFlow(connection, { scopes: opts.scopes });
        await saveTokens(slug, bundle);
        await setConnectionTokenRef(slug, tokenRefFor(slug));
        if (bundle.clientId) await setConnectionClientId(slug, bundle.clientId);
        await setConnectionStatus(slug, 'connected', opts.accountLabel ?? null);
        resetSession(connection.mcpUrl);
        return { success: true, slug, accountLabel: opts.accountLabel };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await setConnectionStatus(slug, 'needs_auth');
        return { success: false, slug, error: message };
    }
}

/** Disconnects: clears tokens and marks the connection as needing auth. */
export async function disconnectProvider(slug: string): Promise<void> {
    const connection = await getConnection(slug);
    await clearTokens(slug);
    resetSession(connection?.mcpUrl ?? '');
    await setConnectionStatus(slug, connection?.authStrategy === 'none' ? 'connected' : 'needs_auth');
    await setConnectionTokenRef(slug, null);
}

/** Removes the connection entirely (and tokens). */
export async function removeProvider(slug: string): Promise<void> {
    await clearTokens(slug);
    await deleteConnection(slug);
}

export async function isConnected(slug: string): Promise<boolean> {
    const connection = await getConnection(slug);
    if (!connection) return false;
    if (connection.authStrategy === 'none') return true;
    const tokens = await getTokens(slug);
    return !!tokens?.accessToken;
}

/**
 * Lists tools for a connection, using the cache when fresh, otherwise hitting
 * the server. Requires the server to be reachable (auth for auth-required
 * servers).
 */
export async function listProviderTools(slug: string, opts: { forceRefresh?: boolean } = {}): Promise<McpTool[]> {
    const connection = await getConnection(slug);
    if (!connection) throw new McpAuthRequiredError(slug, 'Unknown provider');
    if (!opts.forceRefresh) {
        const cached = await getCachedTools(slug);
        if (cached.length) return cached;
    }
    const headers = await buildAuthHeaders(connection);
    const tools = await clientListTools(connection.mcpUrl, { headers });
    await cacheTools(slug, tools);
    await touchConnection(slug);
    return tools;
}

/**
 * Calls a tool on a connection. Throws `McpAuthRequiredError` when the server
 * requires OAuth and no valid token is available.
 */
export async function callProviderTool(
    slug: string,
    tool: string,
    args: Record<string, unknown>,
): Promise<McpCallResult> {
    const connection = await getConnection(slug);
    if (!connection) throw new McpAuthRequiredError(slug, 'Unknown provider');

    const headers = await buildAuthHeaders(connection);
    if (connection.authStrategy !== 'none' && !headers.Authorization) {
        throw new McpAuthRequiredError(slug, 'Authentication required');
    }

    await ensureSession(connection.mcpUrl, { headers }).catch(err => {
        if (err instanceof McpAuthRequiredError) throw err;
        throw err;
    });

    const result = await clientCallTool(connection.mcpUrl, tool, args ?? {}, { headers });
    await touchConnection(slug);
    return result;
}

export { parseScopes };
