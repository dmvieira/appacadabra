/**
 * MCP manager — orchestrates store + token storage + client + auth for the
 * runtime capability and the Settings UI.
 */

import {
    callTool as clientCallTool,
    listTools as clientListTools,
    readResource as clientReadResource,
    resetSession,
    ensureSession,
    type McpResourceResult,
} from './client';
import { runOAuthFlow, resolveAuthServerMeta } from './auth';
import { t } from '../i18n';
import {
    getConnection,
    upsertConnection,
    upsertProviderAsConnection,
    setConnectionStatus,
    setConnectionTokenRef,
    setConnectionClientId,
    setConnectionAuthMeta,
    setConnectionAuthStrategy,
    cacheTools,
    getCachedTools,
    touchConnection,
    deleteConnection,
} from './store';
import { saveTokens, getTokens, clearTokens, tokenRefFor } from './tokenStorage';
import { missingRequiredArgs } from './toolArgs';
import { extractShape } from './payloadShape';
import { saveToolShape } from './store';
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

/**
 * Best-effort: fetch and cache the tool list right after a successful connect
 * so the connection UI shows a tool count immediately and the NEXT generation
 * already sees real tool schemas. Never throws, never fails the connect.
 */
async function warmToolCache(slug: string): Promise<void> {
    try {
        await listProviderTools(slug, { forceRefresh: true });
    } catch {
        // Server unreachable or auth rejected the listing — prewarm retries later.
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

/** Drops a rejected credential so the next use goes through login again. */
async function invalidateAuth(connection: McpConnection): Promise<void> {
    await clearTokens(connection.slug).catch(() => undefined);
    await setConnectionTokenRef(connection.slug, null).catch(() => undefined);
    await setConnectionStatus(connection.slug, 'needs_auth').catch(() => undefined);
    resetSession(connection.mcpUrl);
}

/**
 * Runs an authenticated request. When the server rejects the credential
 * (401 → `McpAuthRequiredError`) — expired without a known `expiresAt`, or
 * revoked — tries ONE forced refresh-token exchange and retries. If that is
 * not possible or also fails, the token is cleared and the connection marked
 * `needs_auth` (so `isConnected` turns false and callers can re-run login),
 * then the auth error is rethrown.
 */
async function withAuthRecovery<T>(
    connection: McpConnection,
    op: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
    const headers = await buildAuthHeaders(connection);
    if (connection.authStrategy !== 'none' && !headers.Authorization) {
        throw new McpAuthRequiredError(connection.slug, 'Authentication required');
    }
    try {
        return await op(headers);
    } catch (err) {
        if (!(err instanceof McpAuthRequiredError) || connection.authStrategy === 'none') throw err;
        const bundle = await getTokens(connection.slug).catch(() => null);
        if (bundle?.refreshToken) {
            const refreshed = await refreshTokens(connection, bundle);
            if (refreshed.accessToken && refreshed.accessToken !== bundle.accessToken) {
                resetSession(connection.mcpUrl);
                try {
                    return await op({ Authorization: `Bearer ${refreshed.accessToken}` });
                } catch (retryErr) {
                    if (!(retryErr instanceof McpAuthRequiredError)) throw retryErr;
                }
            }
        }
        await invalidateAuth(connection);
        throw err;
    }
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
        return { success: false, slug, error: t('mcpErrorConnectionNotFound') };
    }

    // A token supplied for a non-bearer connection means the user is telling
    // us this server uses an API key (e.g. it rejected us with 401 but
    // publishes no OAuth metadata) — switch the strategy so it sticks.
    if (opts.bearerToken && connection.authStrategy !== 'bearer') {
        await setConnectionAuthStrategy(slug, 'bearer');
        connection = { ...connection, authStrategy: 'bearer' };
    }

    try {
        if (connection.authStrategy === 'none') {
            await setConnectionStatus(slug, 'connected');
            void warmToolCache(slug);
            return { success: true, slug };
        }

        if (connection.authStrategy === 'bearer') {
            if (!opts.bearerToken) return { success: false, slug, error: t('mcpErrorTokenRequired') };
            await saveTokens(slug, { accessToken: opts.bearerToken, tokenType: 'Bearer' });
            await setConnectionTokenRef(slug, tokenRefFor(slug));
            await setConnectionStatus(slug, 'connected', opts.accountLabel ?? null);
            resetSession(connection.mcpUrl);
            void warmToolCache(slug);
            return { success: true, slug, accountLabel: opts.accountLabel };
        }

        // OAuth
        const authMeta = await resolveAuthServerMeta(connection);
        if (!authMeta) {
            // Server does not publish OAuth metadata. It may be public: probe it.
            try {
                const tools = await clientListTools(connection.mcpUrl, { headers: {} });
                await cacheTools(slug, tools);
                // Persist that this server is public: otherwise `isConnected`
                // (which requires a token for non-`none` strategies) would
                // report false and every spell call would re-prompt login.
                await setConnectionAuthStrategy(slug, 'none');
                await setConnectionStatus(slug, 'connected');
                return { success: true, slug };
            } catch (probeErr) {
                if (probeErr instanceof McpAuthRequiredError) {
                    await setConnectionStatus(slug, 'needs_auth');
                    return { success: false, slug, error: t('mcpErrorAuthRequired') };
                }
                await setConnectionStatus(slug, 'error');
                return { success: false, slug, error: probeErr instanceof Error ? probeErr.message : t('mcpErrorConnectionFailed') };
            }
        }
        await setConnectionAuthMeta(slug, authMeta);
        connection = (await getConnection(slug))!;

        // OAuth redirect strategy — generic for ANY MCP server:
        // default is the loopback http redirect (RFC 8252 §7.3), the same
        // mechanism desktop MCP clients use; servers that reject custom
        // URI schemes at DCR accept it. A provider descriptor may instead
        // register an https relay (`redirectUri`) or opt out of loopback
        // (`useLoopbackRedirect: false`) to fall back to the custom scheme.
        const descriptor = providerOrConnection as McpProvider;
        let redirectUri = descriptor.redirectUri;
        if (!redirectUri) {
            try {
                redirectUri = require('./curatedCatalog').getCuratedProvider(slug)?.redirectUri;
            } catch {
                // ignore
            }
        }
        const loopback = redirectUri ? false : descriptor.useLoopbackRedirect ?? true;

        const bundle = await runOAuthFlow(connection, { scopes: opts.scopes, redirectUri, loopback });
        await saveTokens(slug, bundle);
        await setConnectionTokenRef(slug, tokenRefFor(slug));
        if (bundle.clientId) await setConnectionClientId(slug, bundle.clientId);
        await setConnectionStatus(slug, 'connected', opts.accountLabel ?? null);
        resetSession(connection.mcpUrl);
        void warmToolCache(slug);
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
    const tools = await withAuthRecovery(connection, headers => clientListTools(connection.mcpUrl, { headers }));
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

    // Guardrail: when the schema is cached, fail fast on missing required
    // arguments with an actionable message instead of an opaque server error.
    // Lenient: unknown/schema-less tools pass through (stale cache must not
    // break working calls).
    const cached = await getCachedTools(slug).catch(() => []);
    const cachedTool = cached.find(t => t?.name === tool);
    if (cachedTool) {
        const missing = missingRequiredArgs(cachedTool, args ?? {});
        if (missing.length) {
            throw new Error(t('mcpErrorMissingArgs', { tool, args: missing.join(', ') }));
        }
    }

    const result = await withAuthRecovery(connection, async headers => {
        await ensureSession(connection.mcpUrl, { headers });
        return clientCallTool(connection.mcpUrl, tool, args ?? {}, { headers });
    });
    await touchConnection(slug);
    // Learn the observed response shape for future spell generations.
    // Fire-and-forget: never blocks or fails the tool call.
    recordToolShape(slug, tool, result);
    return result;
}

/**
 * Reads a resource (`resources/read`) on a connection. Throws
 * `McpAuthRequiredError` when the server requires OAuth and no valid token
 * is available.
 */
export async function readProviderResource(slug: string, uri: string): Promise<McpResourceResult> {
    const connection = await getConnection(slug);
    if (!connection) throw new McpAuthRequiredError(slug, 'Unknown provider');
    const result = await withAuthRecovery(connection, async headers => {
        await ensureSession(connection.mcpUrl, { headers });
        return clientReadResource(connection.mcpUrl, uri, { headers });
    });
    await touchConnection(slug);
    return result;
}

/** Persists a compact shape of a successful payload (best-effort). */
function recordToolShape(slug: string, tool: string, result: McpCallResult): void {
    if (result.isError) return;
    const raw = result.raw;
    if (!raw || typeof raw !== 'object') return; // only structural payloads are useful
    try {
        saveToolShape(slug, tool, extractShape(raw))
            .then(() => {
                if (__DEV__) console.warn(`[MCP shape] ${slug}.${tool} → ${extractShape(raw).slice(0, 160)}`);
            })
            .catch(() => undefined);
    } catch {
        // Never surface shape-recording failures.
    }
}

export { parseScopes };
