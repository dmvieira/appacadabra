/**
 * MCP connection persistence (SQLite via getDatabase).
 *
 * Tokens are NOT stored here — see `tokenStorage.ts`. `tokenRef` is just the
 * SecureStore key name.
 */

import { getDatabase } from '../database/db';
import type {
    McpConnection,
    McpConnectionStatus,
    McpProvider,
    McpTool,
    McpTransport,
    McpAuthStrategy,
    McpProviderSource,
} from './types';

function rowToConnection(r: any): McpConnection {
    return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description ?? null,
        mcpUrl: r.mcp_url,
        transport: (r.transport as McpTransport) ?? 'streamable-http',
        authStrategy: (r.auth_strategy as McpAuthStrategy) ?? 'none',
        status: (r.status as McpConnectionStatus) ?? 'needs_auth',
        accountLabel: r.account_label ?? null,
        tokenRef: r.token_ref ?? null,
        clientId: r.client_id ?? null,
        authMeta: r.auth_meta ?? null,
        iconUrl: r.icon_url ?? null,
        source: (r.source as McpProviderSource) ?? 'manual',
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at ?? null,
    };
}

export async function getAllConnections(): Promise<McpConnection[]> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<any>('SELECT * FROM mcp_connections ORDER BY name ASC');
    return rows.map(rowToConnection);
}

export async function getConnection(slug: string): Promise<McpConnection | null> {
    const db = await getDatabase();
    const row = await db.getFirstAsync<any>('SELECT * FROM mcp_connections WHERE slug = ?', [slug]);
    return row ? rowToConnection(row) : null;
}

export interface UpsertConnectionInput {
    slug: string;
    name: string;
    description?: string;
    mcpUrl: string;
    transport?: McpTransport;
    authStrategy?: McpAuthStrategy;
    status?: McpConnectionStatus;
    iconUrl?: string;
    source?: McpProviderSource;
    authMeta?: string | null;
}

export async function upsertConnection(input: UpsertConnectionInput): Promise<void> {
    const db = await getDatabase();
    const now = Date.now();
    await db.runAsync(
        `INSERT INTO mcp_connections
            (slug, name, description, mcp_url, transport, auth_strategy, status, icon_url, source, auth_meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            mcp_url = excluded.mcp_url,
            transport = excluded.transport,
            auth_strategy = excluded.auth_strategy,
            icon_url = excluded.icon_url,
            source = excluded.source,
            auth_meta = excluded.auth_meta`,
        [
            input.slug,
            input.name,
            input.description ?? null,
            input.mcpUrl,
            input.transport ?? 'streamable-http',
            input.authStrategy ?? 'none',
            input.status ?? 'needs_auth',
            input.iconUrl ?? null,
            input.source ?? 'manual',
            input.authMeta ?? null,
            now,
        ],
    );
}

export async function setConnectionStatus(
    slug: string,
    status: McpConnectionStatus,
    accountLabel?: string | null,
): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(
        'UPDATE mcp_connections SET status = ?, account_label = COALESCE(?, account_label) WHERE slug = ?',
        [status, accountLabel ?? null, slug],
    );
}

export async function setConnectionTokenRef(slug: string, tokenRef: string | null): Promise<void> {
    const db = await getDatabase();
    await db.runAsync('UPDATE mcp_connections SET token_ref = ? WHERE slug = ?', [tokenRef, slug]);
}

export async function setConnectionClientId(slug: string, clientId: string | null): Promise<void> {
    const db = await getDatabase();
    await db.runAsync('UPDATE mcp_connections SET client_id = ? WHERE slug = ?', [clientId, slug]);
}

export async function setConnectionAuthMeta(
    slug: string,
    authMeta: string | null,
): Promise<void> {
    const db = await getDatabase();
    await db.runAsync('UPDATE mcp_connections SET auth_meta = ? WHERE slug = ?', [authMeta, slug]);
}

/** Changes how a connection authenticates (e.g. oauth → bearer for API-key servers). */
export async function setConnectionAuthStrategy(
    slug: string,
    authStrategy: McpAuthStrategy,
): Promise<void> {
    const db = await getDatabase();
    await db.runAsync('UPDATE mcp_connections SET auth_strategy = ? WHERE slug = ?', [authStrategy, slug]);
}

export async function touchConnection(slug: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync('UPDATE mcp_connections SET last_used_at = ? WHERE slug = ?', [Date.now(), slug]);
}

export async function deleteConnection(slug: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync('DELETE FROM mcp_connections WHERE slug = ?', [slug]);
    await db.runAsync('DELETE FROM mcp_tool_cache WHERE slug = ?', [slug]);
    await db.runAsync('DELETE FROM mcp_shape_cache WHERE slug = ?', [slug]);
}

export async function cacheTools(slug: string, tools: McpTool[]): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(
        `INSERT INTO mcp_tool_cache (slug, tools_json, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET tools_json = excluded.tools_json, fetched_at = excluded.fetched_at`,
        [slug, JSON.stringify(tools), Date.now()],
    );
}

export async function getCachedTools(slug: string): Promise<McpTool[]> {
    try {
        const db = await getDatabase();
        const row = await db.getFirstAsync<{ tools_json: string }>(
            'SELECT tools_json FROM mcp_tool_cache WHERE slug = ?',
            [slug],
        );
        if (!row) return [];
        const parsed = JSON.parse(row.tools_json);
        return Array.isArray(parsed) ? (parsed as McpTool[]) : [];
    } catch {
        return [];
    }
}

/** Cached tools plus fetch time (epoch ms), for staleness checks. Null when never cached. */
export async function getToolCacheMeta(slug: string): Promise<{ tools: McpTool[]; fetchedAt: number } | null> {
    try {
        const db = await getDatabase();
        const row = await db.getFirstAsync<{ tools_json: string; fetched_at: number }>(
            'SELECT tools_json, fetched_at FROM mcp_tool_cache WHERE slug = ?',
            [slug],
        );
        if (!row) return null;
        const parsed = JSON.parse(row.tools_json);
        return { tools: Array.isArray(parsed) ? (parsed as McpTool[]) : [], fetchedAt: row.fetched_at };
    } catch {
        return null;
    }
}

/** Persists (or refreshes) the observed response shape of one tool. */
export async function saveToolShape(slug: string, tool: string, shape: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(
        `INSERT INTO mcp_shape_cache (slug, tool, shape, observed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(slug, tool) DO UPDATE SET shape = excluded.shape, observed_at = excluded.observed_at`,
        [slug, tool, shape, Date.now()],
    );
}

/** Observed response shapes for a slug, keyed by tool name. Empty when none. */
export async function getShapesForSlug(slug: string): Promise<Record<string, string>> {
    try {
        const db = await getDatabase();
        const rows = await db.getAllAsync<{ tool: string; shape: string }>(
            'SELECT tool, shape FROM mcp_shape_cache WHERE slug = ?',
            [slug],
        );
        const out: Record<string, string> = {};
        for (const r of rows) out[r.tool] = r.shape;
        return out;
    } catch {
        return {};
    }
}

/** Earliest moment a shape was observed for this slug (epoch ms). Null when none. */
export async function getEarliestShapeObservedAt(slug: string): Promise<number | null> {
    try {
        const db = await getDatabase();
        const row = await db.getFirstAsync<{ observed_at: number }>(
            'SELECT MIN(observed_at) AS observed_at FROM mcp_shape_cache WHERE slug = ?',
            [slug],
        );
        return row?.observed_at ?? null;
    } catch {
        return null;
    }
}

/** When the shape of one specific tool was first observed (epoch ms). Null when never. */
export async function getToolShapeObservedAt(slug: string, tool: string): Promise<number | null> {
    try {
        const db = await getDatabase();
        const row = await db.getFirstAsync<{ observed_at: number }>(
            'SELECT observed_at FROM mcp_shape_cache WHERE slug = ? AND tool = ?',
            [slug, tool],
        );
        return row?.observed_at ?? null;
    } catch {
        return null;
    }
}

/** Materializes a provider descriptor into a persisted connection. */
export async function upsertProviderAsConnection(provider: McpProvider): Promise<void> {
    await upsertConnection({
        slug: provider.slug,
        name: provider.name,
        description: provider.description,
        mcpUrl: provider.mcpUrl,
        transport: provider.transport,
        authStrategy: provider.authStrategy,
        iconUrl: provider.iconUrl,
        source: provider.source,
        status: provider.authStrategy === 'none' ? 'connected' : 'needs_auth',
    });
}
