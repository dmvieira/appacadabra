import { searchRegistry, searchProviders, providerFromUrl } from '../discovery';
import { CURATED_PROVIDERS } from '../curatedCatalog';

function registryResponse(servers: any[]) {
    return { ok: true, status: 200, json: () => Promise.resolve({ servers }) };
}

describe('MCP discovery', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('maps registry entries with remotes and filters stdio-only', async () => {
        (global as any).fetch = jest.fn(() =>
            Promise.resolve(
                registryResponse([
                    {
                        server: {
                            name: 'io.github.foo/remote',
                            title: 'Foo Remote',
                            description: 'remote server',
                            remotes: [{ type: 'streamable-http', url: 'https://foo.example/mcp' }],
                        },
                    },
                    {
                        server: {
                            name: 'io.github.bar/stdio',
                            packages: [{ registryType: 'npm', identifier: 'bar' }],
                        },
                    },
                ]),
            ),
        );
        const out = await searchRegistry('foo');
        expect(out).toHaveLength(1);
        expect(out[0].mcpUrl).toBe('https://foo.example/mcp');
        expect(out[0].transport).toBe('streamable-http');
    });

    it('normalizes sse remotes', async () => {
        (global as any).fetch = jest.fn(() =>
            Promise.resolve(
                registryResponse([
                    { server: { name: 'x/y', remotes: [{ type: 'sse', url: 'https://x.example/sse' }] } },
                ]),
            ),
        );
        const out = await searchRegistry('x');
        expect(out[0].transport).toBe('sse');
    });

    it('returns [] on network failure', async () => {
        (global as any).fetch = jest.fn(() => Promise.reject(new Error('offline')));
        expect(await searchRegistry('anything')).toEqual([]);
    });

    it('merges curated with registry and dedupes by URL', async () => {
        (global as any).fetch = jest.fn(() => Promise.resolve(registryResponse([])));
        const out = await searchProviders('picpay');
        expect(out.some(p => p.slug === 'picpay')).toBe(true);
        expect(out.every(p => typeof p.mcpUrl === 'string')).toBe(true);
    });

    it('returns curated providers for an empty query', async () => {
        (global as any).fetch = jest.fn(() => Promise.resolve(registryResponse([])));
        const out = await searchProviders('');
        expect(out.length).toBeGreaterThanOrEqual(CURATED_PROVIDERS.length);
    });

    it('builds a provider from a URL', () => {
        const p = providerFromUrl('https://mcp.svc.picpay.com/v2/mcp');
        expect(p.mcpUrl).toBe('https://mcp.svc.picpay.com/v2/mcp');
        expect(p.source).toBe('manual');
        expect(p.authStrategy).toBe('oauth');
    });
});
