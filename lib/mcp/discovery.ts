/**
 * MCP server discovery.
 *
 * Sources:
 *   - Official MCP Registry REST API (unauthenticated):
 *       GET https://registry.modelcontextprotocol.io/v0.1/servers?search=&limit=
 *     Only servers exposing a remote transport (`remotes[]`) are usable on
 *     mobile; package/stdio-only servers are filtered out.
 *   - Curated seed catalog (see curatedCatalog.ts).
 *
 * Additional aggregators (Smithery, PulseMCP, Glama) can be layered in later
 * behind `searchAggregators` without changing callers.
 */

import type { McpProvider, McpTransport } from './types';
import { CURATED_PROVIDERS, slugFromUrl, slugify } from './curatedCatalog';

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const DISCOVERY_TIMEOUT_MS = 20_000;

interface RegistryRemote {
    type?: string;
    url?: string;
}

interface RegistryServer {
    name: string;
    title?: string;
    description?: string;
    remotes?: RegistryRemote[];
    repository?: { url?: string };
}

function normalizeTransport(type?: string): McpTransport {
    if (!type) return 'streamable-http';
    const t = type.toLowerCase();
    if (t.includes('sse')) return 'sse';
    return 'streamable-http';
}

function registryServerToProvider(entry: RegistryServer): McpProvider | null {
    const remote = entry.remotes?.find(r => !!r.url);
    if (!remote?.url) return null;
    const httpish = normalizeTransport(remote.type);
    const slug = slugFromUrl(remote.url);
    return {
        slug,
        name: entry.title || entry.name.split('/').pop() || slug,
        description: entry.description,
        mcpUrl: remote.url,
        transport: httpish,
        // Registry metadata does not advertise auth strategy reliably; default
        // to oauth detection at connect time (a public server that never 401s
        // is treated as `none` after a successful probe).
        authStrategy: 'oauth',
        source: 'registry',
    };
}

export async function searchRegistry(query: string, limit = 20): Promise<McpProvider[]> {
    const url = `${REGISTRY_BASE}?search=${encodeURIComponent(query)}&limit=${limit}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) return [];
        const json = (await res.json()) as { servers?: Array<{ server?: RegistryServer } | RegistryServer> };
        const items = json.servers ?? [];
        const out: McpProvider[] = [];
        for (const raw of items) {
            const entry = ('server' in raw && raw.server ? raw.server : (raw as RegistryServer));
            const provider = registryServerToProvider(entry);
            if (provider) out.push(provider);
        }
        return out;
    } catch {
        return [];
    } finally {
        clearTimeout(timeout);
    }
}

function curatedMatch(query: string): McpProvider[] {
    const q = query.trim().toLowerCase();
    if (!q) return CURATED_PROVIDERS;
    return CURATED_PROVIDERS.filter(
        p =>
            p.name.toLowerCase().includes(q) ||
            p.slug.includes(q) ||
            (p.description ?? '').toLowerCase().includes(q),
    );
}

/** Merges curated + registry results, deduped by URL. */
export async function searchProviders(query: string, limit = 20): Promise<McpProvider[]> {
    const curated = curatedMatch(query);
    const registry = query.trim() ? await searchRegistry(query, limit) : [];
    const seen = new Set<string>();
    const merged: McpProvider[] = [];
    for (const p of [...curated, ...registry]) {
        const key = p.mcpUrl.replace(/\/$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(p);
    }
    return merged;
}

/** Providers to surface to the generation pipeline as "available". */
export function getGenerationProviders(): McpProvider[] {
    return CURATED_PROVIDERS;
}

/** Builds a provider descriptor for a manually entered URL. */
export function providerFromUrl(url: string, name?: string): McpProvider {
    const slug = slugFromUrl(url);
    return {
        slug: slug || slugify(name || url),
        name: name || slug,
        mcpUrl: url,
        transport: 'streamable-http',
        authStrategy: 'oauth',
        source: 'manual',
    };
}
