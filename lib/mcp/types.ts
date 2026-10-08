/**
 * MCP (Model Context Protocol) core types.
 *
 * Remote-only by design: the app runs on Android/iOS where stdio MCP servers
 * (npx/python processes) cannot be spawned. Only `streamable-http` (and legacy
 * `sse`) transports are supported.
 */

export type McpTransport = 'streamable-http' | 'sse';

/**
 * How the user authenticates to a server.
 * - `oauth`: standard MCP OAuth 2.1 (RFC 9728 discovery + RFC 8414 metadata +
 *   DCR + PKCE). Detected from a 401 `WWW-Authenticate` header.
 * - `bearer`: a static bearer token/API key provided by the user.
 * - `none`: public server, no credentials.
 */
export type McpAuthStrategy = 'oauth' | 'bearer' | 'none';

export type McpConnectionStatus = 'connected' | 'needs_auth' | 'error';

export type McpProviderSource = 'curated' | 'registry' | 'manual';

/** Lightweight provider descriptor (catalog / discovery / manual entry). */
export interface McpProvider {
    /** Stable id used in generated code, e.g. "picpay". Lowercase [a-z0-9-]. */
    slug: string;
    name: string;
    description?: string;
    mcpUrl: string;
    transport: McpTransport;
    authStrategy: McpAuthStrategy;
    iconUrl?: string;
    websiteUrl?: string;
    source: McpProviderSource;
    /** OAuth scopes the server advertises (from RFC 9728 metadata). */
    scopes?: string[];
}

/** A tool exposed by an MCP server. Mirrors the MCP `tools/list` shape. */
export interface McpTool {
    name: string;
    title?: string;
    description?: string;
    /** JSON Schema for the tool arguments. */
    inputSchema?: unknown;
}

/** Persisted connection (row in `mcp_connections`). */
export interface McpConnection {
    id: number;
    slug: string;
    name: string;
    description?: string | null;
    mcpUrl: string;
    transport: McpTransport;
    authStrategy: McpAuthStrategy;
    status: McpConnectionStatus;
    accountLabel?: string | null;
    /** SecureStore key holding the token bundle. Never the token itself. */
    tokenRef?: string | null;
    clientId?: string | null;
    /** JSON blob of authorization-server metadata (endpoints, scopes). */
    authMeta?: string | null;
    iconUrl?: string | null;
    source: McpProviderSource;
    createdAt: number;
    lastUsedAt?: number | null;
}

/** Token bundle persisted in SecureStore. */
export interface McpTokenBundle {
    accessToken: string;
    refreshToken?: string;
    tokenType?: string;
    /** Epoch ms at which the access token expires (best-effort). */
    expiresAt?: number;
    clientId?: string;
    clientSecret?: string;
}

export interface McpCallResult {
    /** Text extracted from the MCP result content blocks. */
    text: string;
    /** Raw MCP result payload. */
    raw: unknown;
    isError: boolean;
}

export class McpHttpError extends Error {
    readonly status: number;
    readonly body: string;
    readonly wwwAuthenticate?: string;
    constructor(status: number, body: string, wwwAuthenticate?: string) {
        super(`MCP HTTP ${status}: ${body.slice(0, 300)}`);
        this.name = 'McpHttpError';
        this.status = status;
        this.body = body;
        this.wwwAuthenticate = wwwAuthenticate;
    }
}

/** Raised when a server requires OAuth and no valid token is available. */
export class McpAuthRequiredError extends Error {
    readonly slug: string;
    readonly resourceMetadataUrl?: string;
    constructor(slug: string, resourceMetadataUrl?: string) {
        super('MCP authentication required');
        this.name = 'McpAuthRequiredError';
        this.slug = slug;
        this.resourceMetadataUrl = resourceMetadataUrl;
    }
}
