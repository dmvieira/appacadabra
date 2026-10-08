/**
 * Minimal MCP client over the Streamable HTTP transport (JSON-RPC 2.0).
 *
 * Remote-only: stdio transport is impossible in React Native. Responses may be
 * a single JSON body or an SSE stream with a `message` event — both are parsed.
 *
 * Auth is injected by the caller as a pre-built header map so this module stays
 * free of SecureStore/Expo dependencies and is trivially testable.
 */

import type { McpCallResult, McpTool } from './types';
import { McpAuthRequiredError, McpHttpError } from './types';

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 60_000;
const CLIENT_INFO = { name: 'appacadabra', version: '1.0.0' };

const SESSION_HEADER = 'mcp-session-id';

/** In-memory session cache: slug → session id. Best-effort; re-init on miss. */
const sessions = new Map<string, string>();

export interface McpRequestOptions {
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
}

interface RpcResponse {
    jsonrpc: '2.0';
    id: number | string;
    result?: any;
    error?: { code: number; message: string; data?: unknown };
}

/** Parses the RFC 9728 resource_metadata URL out of a WWW-Authenticate header. */
export function parseResourceMetadataUrl(wwwAuthenticate?: string | null): string | undefined {
    if (!wwwAuthenticate) return undefined;
    const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(wwwAuthenticate);
    return m ? m[1] : undefined;
}

function parseRpcBody(contentType: string, bodyText: string): RpcResponse | null {
    if (contentType.includes('text/event-stream')) {
        for (const line of bodyText.split('\n')) {
            const trimmed = line.replace(/\r$/, '');
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                const parsed = JSON.parse(payload) as RpcResponse;
                if (parsed && (parsed.result !== undefined || parsed.error)) return parsed;
            } catch {
                // tolerate keepalives / partial frames
            }
        }
        return null;
    }
    try {
        return JSON.parse(bodyText) as RpcResponse;
    } catch {
        return null;
    }
}

async function doFetch(
    url: string,
    body: unknown,
    opts: McpRequestOptions,
    sessionId?: string,
): Promise<{ response: Response; sessionId?: string }> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(opts.headers ?? {}),
    };
    if (sessionId) headers[SESSION_HEADER] = sessionId;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (opts.signal) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (err) {
        clearTimeout(timeout);
        throw new McpHttpError(0, err instanceof Error ? err.message : 'network error');
    }
    clearTimeout(timeout);

    const newSession = response.headers.get(SESSION_HEADER) ?? undefined;
    return { response, sessionId: newSession };
}

async function rpc(
    url: string,
    id: number,
    method: string,
    params: Record<string, unknown>,
    opts: McpRequestOptions,
    sessionId?: string,
): Promise<RpcResponse> {
    const { response, sessionId: newSession } = await doFetch(
        url,
        { jsonrpc: '2.0', id, method, params },
        opts,
        sessionId,
    );

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        const authHeader = response.headers.get('www-authenticate');
        if (response.status === 401) {
            throw new McpAuthRequiredError(url, parseResourceMetadataUrl(authHeader));
        }
        throw new McpHttpError(response.status, body, authHeader ?? undefined);
    }

    if (newSession) sessions.set(url, newSession);

    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    if (!text) return { jsonrpc: '2.0', id, result: null };
    const parsed = parseRpcBody(contentType, text);
    if (!parsed) throw new McpHttpError(response.status, 'Unparseable MCP response');
    if (parsed.error) {
        throw new McpHttpError(response.status, JSON.stringify(parsed.error));
    }
    return parsed;
}

let rpcId = 1;

/** Establishes (or reuses) an MCP session: initialize + notifications/initialized. */
export async function ensureSession(url: string, opts: McpRequestOptions): Promise<string> {
    const existing = sessions.get(url);
    if (existing) return existing;

    const init = await rpc(
        url,
        1,
        'initialize',
        {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: CLIENT_INFO,
        },
        opts,
    );
    const sessionId = sessions.get(url);
    if (!sessionId) {
        // Some servers are stateless and omit the session header. That's fine —
        // use an empty marker so we still send `initialized` and proceed.
        sessions.set(url, '');
    }

    // notifications/initialized has no id and no response body.
    await doFetch(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, opts, sessions.get(url) || undefined).catch(() => undefined);

    void init;
    return sessions.get(url) ?? '';
}

function invalidateSession(url: string): void {
    sessions.delete(url);
}

export async function listTools(url: string, opts: McpRequestOptions): Promise<McpTool[]> {
    const session = await ensureSession(url, opts);
    try {
        const res = await rpc(url, rpcId++, 'tools/list', {}, opts, session || undefined);
        const tools = res.result?.tools;
        return Array.isArray(tools) ? (tools as McpTool[]) : [];
    } catch (err) {
        if (err instanceof McpHttpError && err.status === 400) {
            invalidateSession(url);
        }
        throw err;
    }
}

function extractText(result: any): string {
    if (!result) return '';
    const content = result.content;
    if (Array.isArray(content)) {
        return content
            .map((c: any) => {
                if (!c) return '';
                if (c.type === 'text') return String(c.text ?? '');
                if (c.type === 'resource' && c.resource?.text) return String(c.resource.text);
                try { return JSON.stringify(c); } catch { return ''; }
            })
            .filter(Boolean)
            .join('\n');
    }
    if (typeof result === 'string') return result;
    try { return JSON.stringify(result); } catch { return ''; }
}

export async function callTool(
    url: string,
    name: string,
    args: Record<string, unknown>,
    opts: McpRequestOptions,
): Promise<McpCallResult> {
    const session = await ensureSession(url, opts);
    const res = await rpc(url, rpcId++, 'tools/call', { name, arguments: args ?? {} }, opts, session || undefined);
    const result = res.result ?? {};
    return {
        text: extractText(result),
        raw: result,
        isError: !!result.isError,
    };
}

/** Clears the cached session for a URL (e.g. after logout or re-auth). */
export function resetSession(url: string): void {
    invalidateSession(url);
}
