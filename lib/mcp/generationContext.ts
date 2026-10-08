/**
 * MCP context injected into the AI generation/editing prompts.
 *
 * Kept dependency-free and synchronous so it can be called from the generator
 * pipeline (and tests) without pulling in Expo/SQLite. The app hydrates the
 * "connected" set via `hydrateMcpGenerationContext()` when connections change;
 * curated seeds are always present so the coder knows valid slugs and the
 * discovery-first pattern.
 */

import { CURATED_PROVIDERS } from './curatedCatalog';

interface McpContextEntry {
    slug: string;
    name: string;
    description?: string;
    connected: boolean;
}

let connectedSlugs = new Set<string>();

/** Records which providers the user currently has connected. */
export function setConnectedMcpSlugs(slugs: string[]): void {
    connectedSlugs = new Set(slugs);
}

/** Reads the DB (best-effort) to refresh the connected set. Never throws. */
export async function hydrateMcpGenerationContext(): Promise<void> {
    try {
        const { getAllConnections } = require('./store');
        const rows = await getAllConnections();
        setConnectedMcpSlugs(rows.filter((r: { status: string }) => r.status === 'connected').map((r: { slug: string }) => r.slug));
    } catch {
        // Leave the previous snapshot in place.
    }
}

function entries(): McpContextEntry[] {
    const out: McpContextEntry[] = [];
    for (const p of CURATED_PROVIDERS) {
        out.push({ slug: p.slug, name: p.name, description: p.description, connected: connectedSlugs.has(p.slug) });
    }
    return out;
}

/**
 * Markdown block appended to the coder system prompt when MCP is relevant.
 * Returns '' when there is nothing useful to add.
 */
export function getMcpPromptBlock(): string {
    const list = entries();
    if (!list.length) return '';
    const lines = list.map(e => {
        const status = e.connected ? ' (connected)' : '';
        return `- \`${e.slug}\` — ${e.name}${status}: ${e.description ?? ''}`;
    });
    return [
        '--- MCP CONNECTORS ---',
        'The user can connect external MCP servers. Prefer the slugs below when the request needs an external service. Use `AppacadabraMCP.listTools(slug, cb)` to discover tool names, then `AppacadabraMCP.callTool(slug, tool, args, cb)`. If a needed connector is not connected yet, the app will ask the user to log in automatically on first use.',
        '',
        ...lines,
    ].join('\n');
}

/** One-line hint for the planner stage. */
export function getMcpPlannerLine(): string {
    return '- **AppacadabraMCP**: call tools on external MCP connectors (e.g. PicPay, Notion, Stripe, Context7). List it in `technicalRequirements.apis` when the request depends on an external service.';
}
