import { listTools, callTool, parseResourceMetadataUrl, resetSession } from '../client';
import { McpAuthRequiredError } from '../types';

function fakeResponse(opts: {
    ok?: boolean;
    status?: number;
    contentType?: string;
    body?: string;
    sessionId?: string;
    wwwAuthenticate?: string;
}) {
    const headers = new Map<string, string>();
    if (opts.contentType) headers.set('content-type', opts.contentType);
    if (opts.sessionId) headers.set('mcp-session-id', opts.sessionId);
    if (opts.wwwAuthenticate) headers.set('www-authenticate', opts.wwwAuthenticate);
    return {
        ok: opts.ok ?? true,
        status: opts.status ?? 200,
        headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
        text: () => Promise.resolve(opts.body ?? ''),
    } as unknown as Response;
}

function sse(payload: object): string {
    return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

describe('parseResourceMetadataUrl', () => {
    it('extracts the resource_metadata URL', () => {
        const header = 'Bearer error="invalid_token", resource_metadata="https://x/.well-known/oauth-protected-resource/v2/mcp"';
        expect(parseResourceMetadataUrl(header)).toBe('https://x/.well-known/oauth-protected-resource/v2/mcp');
    });
    it('returns undefined when absent', () => {
        expect(parseResourceMetadataUrl('Bearer')).toBeUndefined();
        expect(parseResourceMetadataUrl(null)).toBeUndefined();
    });
});

describe('MCP client over streamable HTTP', () => {
    const url = 'https://unit-test.example/mcp';
    let calls: Array<{ method: string; id?: number }>;

    beforeEach(() => {
        resetSession(url);
        calls = [];
        (global as any).fetch = jest.fn((_u: string, init: any) => {
            const req = JSON.parse(init.body);
            calls.push({ method: req.method, id: req.id });
            if (req.method === 'initialize') {
                return Promise.resolve(
                    fakeResponse({
                        contentType: 'text/event-stream',
                        sessionId: 'sess-1',
                        body: sse({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } }),
                    }),
                );
            }
            if (req.method === 'notifications/initialized') {
                return Promise.resolve(fakeResponse({ status: 202, body: '' }));
            }
            if (req.method === 'tools/list') {
                return Promise.resolve(
                    fakeResponse({
                        contentType: 'application/json',
                        body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'get_balance', description: 'b' }] } }),
                    }),
                );
            }
            if (req.method === 'tools/call') {
                return Promise.resolve(
                    fakeResponse({
                        contentType: 'application/json',
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            id: req.id,
                            result: { content: [{ type: 'text', text: 'R$ 42,00' }], isError: false },
                        }),
                    }),
                );
            }
            return Promise.resolve(fakeResponse({ body: '{}' }));
        });
    });

    it('initializes once, lists tools and reuses the session', async () => {
        const tools = await listTools(url, { headers: { Authorization: 'Bearer t' } });
        expect(tools).toEqual([{ name: 'get_balance', description: 'b' }]);
        const methods = calls.map(c => c.method);
        expect(methods.filter(m => m === 'initialize')).toHaveLength(1);
        expect(methods).toContain('notifications/initialized');
    });

    it('calls a tool and extracts text', async () => {
        const res = await callTool(url, 'get_balance', {}, { headers: {} });
        expect(res.text).toBe('R$ 42,00');
        expect(res.isError).toBe(false);
    });

    it('raises McpAuthRequiredError on 401 with resource metadata', async () => {
        resetSession(url);
        (global as any).fetch = jest.fn(() =>
            Promise.resolve(
                fakeResponse({
                    ok: false,
                    status: 401,
                    wwwAuthenticate: 'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"',
                    body: '{"error":"invalid_token"}',
                }),
            ),
        );
        await expect(listTools(url, { headers: {} })).rejects.toBeInstanceOf(McpAuthRequiredError);
        await expect(listTools(url, { headers: {} })).rejects.toMatchObject({
            resourceMetadataUrl: 'https://x/.well-known/oauth-protected-resource',
        });
    });
});
