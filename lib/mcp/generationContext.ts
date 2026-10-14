/**
 * MCP context injected into the AI generation/editing prompts.
 *
 * Kept dependency-free and synchronous so it can be called from the generator
 * pipeline (and tests) without pulling in Expo/SQLite. The app hydrates the
 * "connected" set + cached tool schemas via `hydrateMcpGenerationContext()`;
 * curated seeds are always present so the coder knows valid slugs and the
 * discovery-first pattern.
 *
 * Layer 1 (schemas in prompts): connected servers expose a compact tool index
 * so the model can generate correct list→detail chains and required arguments
 * without runtime guessing.
 * Layer 2 (cache pre-warm): hydrate kickstarts a background refresh of
 * empty/stale tool caches so future generations see fresh schemas.
 */

import { CURATED_PROVIDERS } from './curatedCatalog';
import type { McpTool } from './types';

interface McpContextEntry {
    slug: string;
    name: string;
    description?: string;
    connected: boolean;
}

let connectedSlugs = new Set<string>();
/** Cached tool schemas per connected slug (hydrated from mcp_tool_cache). */
let toolsBySlug = new Map<string, McpTool[]>();
/** Observed response shapes per connected slug, keyed by tool name (mcp_shape_cache). */
let shapesBySlug = new Map<string, Record<string, string>>();

/** Records which providers the user currently has connected. */
export function setConnectedMcpSlugs(slugs: string[]): void {
    connectedSlugs = new Set(slugs);
}

/** Replaces the tool-schema snapshot (hydrate + test seam). */
export function setCachedMcpTools(tools: Record<string, McpTool[]>): void {
    toolsBySlug = new Map(Object.entries(tools));
}

/** Replaces the observed-shapes snapshot (hydrate + test seam). */
export function setCachedMcpShapes(shapes: Record<string, Record<string, string>>): void {
    shapesBySlug = new Map(Object.entries(shapes));
}

/** Reads the DB (best-effort) to refresh the connected set + snapshots. Never throws. */
export async function hydrateMcpGenerationContext(): Promise<void> {
    let connected: string[] = [];
    try {
        const { getAllConnections, getToolCacheMeta, getShapesForSlug } = require('./store');
        const rows = await getAllConnections();
        connected = rows
            .filter((r: { status: string }) => r.status === 'connected')
            .map((r: { slug: string }) => r.slug);
        setConnectedMcpSlugs(connected);
        // Snapshot whatever is cached right now — instant, no network.
        const snapshot: Record<string, McpTool[]> = {};
        const shapeSnapshot: Record<string, Record<string, string>> = {};
        for (const slug of connected) {
            const meta = await getToolCacheMeta(slug).catch(() => null);
            if (meta?.tools.length) snapshot[slug] = meta.tools;
            const shapes = await getShapesForSlug(slug).catch(() => ({}));
            if (Object.keys(shapes).length) shapeSnapshot[slug] = shapes;
        }
        setCachedMcpTools(snapshot);
        setCachedMcpShapes(shapeSnapshot);
    } catch {
        // Leave the previous snapshot in place.
    }
    // Background refresh of empty/stale caches so the NEXT generation sees
    // fresh schemas. Fire-and-forget — never blocks or throws.
    void prewarmToolCaches(connected).catch(() => undefined);
}

const TOOL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function prewarmToolCaches(slugs: string[]): Promise<void> {
    if (!slugs.length) return;
    const { getToolCacheMeta } = require('./store');
    const manager = require('./manager');
    for (const slug of slugs) {
        try {
            const meta = await getToolCacheMeta(slug);
            if (meta?.tools.length && Date.now() - meta.fetchedAt < TOOL_CACHE_TTL_MS) continue;
            await manager.listProviderTools(slug, { forceRefresh: true });
        } catch {
            // Auth required or offline — leave the cache as is.
        }
    }
}

function entries(): McpContextEntry[] {
    const out: McpContextEntry[] = [];
    for (const p of CURATED_PROVIDERS) {
        out.push({ slug: p.slug, name: p.name, description: p.description, connected: connectedSlugs.has(p.slug) });
    }
    // Connected servers outside the curated catalog (added by URL) still
    // deserve a prompt entry when they publish cached tools.
    for (const slug of connectedSlugs) {
        if (!out.some(e => e.slug === slug)) out.push({ slug, name: slug, connected: true });
    }
    return out;
}

const DESCRIPTION_LIMIT = 140;
const MAX_TOOLS_PER_SERVER = 25;
const SHAPE_LIMIT = 600;
const MAX_OUTPUT_FIELDS = 12;

function summarizeDescription(tool: McpTool): string {
    const base = (tool.title ? `${tool.title} — ` : '') + (tool.description ?? '');
    const flat = base.replace(/\s+/g, ' ').trim();
    return flat.length > DESCRIPTION_LIMIT ? `${flat.slice(0, DESCRIPTION_LIMIT)}…` : flat;
}

/** Compact arg signature: `name (type|enum)*` — * marks required. */
function summarizeArgs(tool: McpTool): string {
    const schema = tool.inputSchema as
        | { properties?: Record<string, { type?: string; enum?: string[] } | undefined>; required?: unknown }
        | undefined;
    const props = schema?.properties;
    if (!props || typeof props !== 'object') return '';
    const required = Array.isArray(schema?.required) ? (schema!.required as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const requiredSet = new Set(required);
    const parts = Object.keys(props).map(name => {
        const p = props[name] ?? {};
        const type = typeof p.type === 'string' ? p.type : 'any';
        const enumPart = Array.isArray(p.enum) && p.enum.length ? `: ${p.enum.slice(0, 6).join('|')}` : '';
        return `${name} (${type}${enumPart})${requiredSet.has(name) ? '*' : ''}`;
    });
    return parts.length ? ` Args: ${parts.join(', ')} (* = required).` : '';
}

/**
 * Authoritative return structure from the server's published `outputSchema`
 * (rare): `{field: type, ...}`. Empty string when absent.
 */
function summarizeOutputSchema(tool: McpTool): string {
    const schema = tool.outputSchema as
        | { properties?: Record<string, { type?: string } | undefined> }
        | undefined;
    const props = schema?.properties;
    if (!props || typeof props !== 'object') return '';
    const parts = Object.keys(props).slice(0, MAX_OUTPUT_FIELDS).map(name => {
        const p = props[name] ?? {};
        return `${name}: ${typeof p.type === 'string' ? p.type : 'any'}`;
    });
    const hidden = Object.keys(props).length - Math.min(Object.keys(props).length, MAX_OUTPUT_FIELDS);
    if (hidden > 0) parts.push(`…+${hidden} more`);
    return parts.length ? ` Returns (schema): {${parts.join(', ')}}.` : '';
}

/** Observed return structure from real calls, with example values. */
function summarizeObservedShape(tool: McpTool, shapes: Record<string, string> | undefined): string {
    const shape = shapes?.[tool.name];
    if (!shape) return '';
    const flat = shape.replace(/\s+/g, ' ').trim();
    return ` Returns (observed — \`raw\` follows exactly this structure): ${flat.length > SHAPE_LIMIT ? `${flat.slice(0, SHAPE_LIMIT)}…` : flat}`;
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
    // Layer 1: real tool schemas for connected servers (cache-only — building
    // the prompt never touches the network).
    // Layer 3: observed response shapes so the coder reads the right fields.
    const toolSections: string[] = [];
    for (const e of list) {
        if (!e.connected) continue;
        const tools = toolsBySlug.get(e.slug) ?? [];
        if (!tools.length) continue;
        const shapes = shapesBySlug.get(e.slug);
        const shown = tools.slice(0, MAX_TOOLS_PER_SERVER);
        toolSections.push(
            `  Available tools on \`${e.slug}\` — chain LIST → DETAIL when an arg takes an identifier, and pass identifiers exactly as returned:`,
            ...shown.map(t =>
                `  * \`${t.name}\` — ${summarizeDescription(t)}.${summarizeArgs(t)}${summarizeOutputSchema(t)}${summarizeObservedShape(t, shapes)}`,
            ),
            ...(tools.length > shown.length ? [`  * … +${tools.length - shown.length} more (discover at runtime with listTools)`] : []),
        );
    }
    return [
        '--- MCP CONNECTORS ---',
        'The user can connect external MCP servers. Prefer the slugs below when the request needs an external service. Use `AppacadabraMCP.listTools(slug, cb)` to discover tool names, then `AppacadabraMCP.callTool(slug, tool, args, cb)`. If a needed connector is not connected yet, the app will ask the user to log in automatically on first use.',
        'When a tool lists an observed return structure below, its `raw` result matches EXACTLY that structure — read fields from it (dates, amounts) instead of guessing. Amounts may be strings (e.g. "123.45"); parse with parseFloat before math.',
        'Each observed return structure below applies ONLY to its own tool — never reuse one tool\'s field names for another. To group by day, prefer a container-level date field when present (e.g. the payload is already split per day: iterate `dias[]` and read `dias[].dia` instead of parsing each movement\'s datetime).',
        '',
        ...lines,
        ...(toolSections.length ? ['', ...toolSections] : []),
    ].join('\n');
}

/**
 * Planner guidance: connected servers with their tool names so the planner can
 * declare `technicalRequirements.mcpTools` — the exact tools the spell will
 * call. Curated-but-disconnected servers are listed as possibilities (the app
 * asks for login on first use at runtime) but without tool names, since
 * `tools/list` requires auth on most servers.
 */
export function getMcpPlannerLine(): string {
    const list = entries();
    if (!list.length) {
        return '- **AppacadabraMCP**: call tools on external MCP connectors (e.g. PicPay, Notion, Stripe, Context7). List it in `technicalRequirements.apis` when the request depends on an external service.';
    }
    const lines: string[] = [];
    for (const e of list) {
        const tools = toolsBySlug.get(e.slug) ?? [];
        const shapeless = !e.connected || !tools.length;
        if (shapeless) {
            lines.push(`  * \`${e.slug}\` — ${e.name}${e.connected ? '' : ' (not connected — the app asks the user to log in on first use)'}: ${e.description ?? ''}`);
        } else {
            const names = tools.slice(0, MAX_TOOLS_PER_SERVER).map(t => {
                const desc = summarizeDescription(t);
                return `${t.name} (${desc})`;
            }).join('; ');
            lines.push(`  * \`${e.slug}\` — ${e.name} (connected): ${e.description ?? ''}. Tools: ${names}`);
        }
    }
    return [
        '- **AppacadabraMCP**: call tools on external MCP connectors. List it in `technicalRequirements.apis` when the request depends on an external service.',
        '  Also declare EXACTLY which tools the app will call, so the coder receives their real input/output structures:',
        '  ```json',
        '  "mcpTools": [{ "server": "example", "tools": ["list_items", "get_details"] }]',
        '  ```',
        '  Use the exact tool names below — never invent names. For connectors marked "not connected", omit `mcpTools` (tools are discovered at runtime via listTools).',
        ...lines.map(l => `  ${l}`),
    ].join('\n');
}
