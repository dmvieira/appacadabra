/**
 * Generation-time shape probing ("cold start" for observed response shapes).
 *
 * Between the planner and coder stages, this calls safe read-only tools on the
 * CONNECTED MCP servers relevant to the request so their response shapes are
 * cached before the coder prompt is built. Never triggers login, never blocks
 * generation: any failure (auth, network, timeout, bad args) is silently
 * skipped — the shape simply stays unknown.
 *
 * Pure heuristics, DB + manager access only. Results persist via
 * `recordToolShape` inside `callProviderTool`, so probing also warms the
 * passive-capture cache.
 */

import { missingRequiredArgs } from './toolArgs';
import type { McpTool } from './types';

// store/manager are required lazily (inside functions) so this module stays
// importable from the generator pipeline without pulling expo modules into
// test environments — same pattern as generationContext.ts.

/** Tools considered safe to call for observation. */
const SAFE_TOOL_RE = /(list|get|search|find|fetch|balance|history|statement|extrato|transac|query|read|show|view)/i;
/** Tools that may mutate state or cost money — never probed. */
const UNSAFE_TOOL_RE = /(create|post|send|pay|delete|remove|update|cancel|transfer|approve|write|set|add|put|patch|mark|complete|toggle|invite|share|auth|login|refresh|subscribe|checkout|refund)/i;

const MAX_SLUGS = 2;
const MAX_TOOLS_PER_SLUG = 4;
const CALL_TIMEOUT_MS = 8_000;
const BUDGET_MS = 12_000;

function isSafeTool(name: string): boolean {
    return SAFE_TOOL_RE.test(name) && !UNSAFE_TOOL_RE.test(name);
}

/**
 * Synthesizes best-effort arguments for a tool call from its input schema.
 * Returns null when a required arg is clearly not synthesizable (opaque id).
 */
function synthesizeArgs(tool: { name: string; inputSchema?: unknown }): Record<string, unknown> | null {
    const schema = tool.inputSchema as
        | {
              properties?: Record<string, { type?: string; enum?: unknown[]; format?: string } | undefined>;
              required?: unknown;
          }
        | undefined;
    const props = schema?.properties;
    const required = Array.isArray(schema?.required)
        ? (schema!.required as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
    if (!props || typeof props !== 'object') return {};

    const now = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const isDateish = (name: string, p: { type?: string; format?: string }) =>
        p.format === 'date' || (/date|day|data|period|from|to|since|until|inicio|fim|final/i.test(name) && p.type !== 'number');

    const args: Record<string, unknown> = {};
    for (const name of required) {
        const p = props[name];
        if (!p) return null;
        if (Array.isArray(p.enum) && p.enum.length) {
            args[name] = p.enum[0];
            continue;
        }
        switch (p.type) {
            case 'boolean':
                args[name] = true;
                continue;
            case 'number':
            case 'integer':
                args[name] = 10;
                continue;
            case 'string': {
                const lower = name.toLowerCase();
                if (isDateish(lower, p)) {
                    if (/start|begin|from|since|initial|inicio|de$/.test(lower)) {
                        args[name] = iso(new Date(now.getTime() - 7 * 86_400_000));
                    } else if (/end|until|fim|final|ate$|until$/.test(lower)) {
                        args[name] = iso(now);
                    } else {
                        args[name] = iso(now);
                    }
                    continue;
                }
                if (/^(id|.*_id|.*Id)$/.test(name)) return null; // opaque identifier — cannot guess
                args[name] = '1';
                continue;
            }
            default:
                return null;
        }
    }
    return args;
}

/** MCP tool declarations the planner writes into the plan. */
export interface PlanMcpServerTools {
    server?: string;
    tools?: unknown;
}

/** Extracts `{slug → tool names[]}` from `plan.technicalRequirements.mcpTools`. */
export function extractPlanMcpTools(plan: unknown): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const mcpTools = (plan as { technicalRequirements?: { mcpTools?: unknown } } | null | undefined)
        ?.technicalRequirements?.mcpTools;
    if (!Array.isArray(mcpTools)) return out;
    for (const entry of mcpTools as PlanMcpServerTools[]) {
        const slug = typeof entry?.server === 'string' ? entry.server.toLowerCase().trim() : '';
        if (!slug) continue;
        const names = Array.isArray(entry.tools) ? entry.tools.filter((t): t is string => typeof t === 'string' && !!t.trim()) : [];
        if (!names.length) continue;
        const merged = new Set([...(out.get(slug) ?? []), ...names.map(n => n.trim())]);
        out.set(slug, [...merged]);
    }
    return out;
}

/** Candidates: connected slugs mentioned in the request/plan text. */
export async function findProbeTargets(haystack: string): Promise<string[]> {
    const { getAllConnections } = require('./store');
    const { isConnected } = require('./manager');
    let rows: { slug: string; name: string; status: string }[] = [];
    try {
        rows = await getAllConnections();
    } catch {
        return [];
    }
    const hay = haystack.toLowerCase();
    const out: string[] = [];
    for (const r of rows) {
        if (r.status !== 'connected') continue;
        if (!hay.includes(r.slug.toLowerCase()) && !hay.includes(String(r.name).toLowerCase())) continue;
        if (await isConnected(r.slug).catch(() => false)) out.push(r.slug);
        if (out.length >= MAX_SLUGS) break;
    }
    return out;
}

async function probeTool(slug: string, tool: { name: string; inputSchema?: unknown }): Promise<boolean> {
    const { callProviderTool } = require('./manager');
    const args = synthesizeArgs(tool);
    if (args === null) return false;
    if (missingRequiredArgs(tool as never, args).length) return false;
    const call = callProviderTool(slug, tool.name, args)
        .then(() => true)
        .catch(() => false);
    const timeout = new Promise<false>(resolve => setTimeout(() => resolve(false), CALL_TIMEOUT_MS));
    return Promise.race([call, timeout]);
}

/**
 * Runs shape probes for the request at hand. Returns how many tools were
 * successfully observed. Best-effort by design — never throws, bounded time.
 *
 * Tool selection precedence:
 * 1. `plan.technicalRequirements.mcpTools` — the planner's explicit declaration
 *    (validated against the cache + safety filter).
 * 2. Fallback: connected slugs mentioned in the request/plan/code, first
 *    shapeless safe tools in cache order.
 * `code` (current spell source, edit flow) is scanned too: slugs referenced by
 * the code matter even when the instruction does not name the server.
 */
export async function probeShapesForGeneration(ctx: { prompt: string; plan?: unknown; code?: string }): Promise<number> {
    try {
        let planText = '';
        if (ctx.plan) {
            try {
                planText = JSON.stringify(ctx.plan);
            } catch {
                planText = '';
            }
        }
        const haystack = `${ctx.prompt}\n${planText}\n${ctx.code ?? ''}`;
        const { getCachedTools, getShapesForSlug } = require('./store') as {
            getCachedTools: (slug: string) => Promise<McpTool[]>;
            getShapesForSlug: (slug: string) => Promise<Record<string, string>>;
        };
        const { isConnected } = require('./manager') as { isConnected: (slug: string) => Promise<boolean> };

        // Candidates in precedence order: planner declaration first.
        const planTools = extractPlanMcpTools(ctx.plan);
        let slugs = [...planTools.keys()];
        if (!slugs.length) slugs = await findProbeTargets(haystack);
        slugs = slugs.slice(0, MAX_SLUGS);

        const deadline = Date.now() + BUDGET_MS;
        const jobs: Promise<boolean>[] = [];
        for (const slug of slugs) {
            if (!(await isConnected(slug).catch(() => false))) continue;
            const [tools, shapes] = await Promise.all([
                getCachedTools(slug).catch(() => [] as McpTool[]),
                getShapesForSlug(slug).catch(() => ({}) as Record<string, string>),
            ]);
            const byName = new Map(tools.filter(t => t?.name).map(t => [t.name, t]));
            const declared = planTools.get(slug);
            let pending: McpTool[];
            if (declared?.length) {
                // Planner-declared tools, cache order among them.
                pending = declared
                    .map(name => byName.get(name))
                    .filter((t): t is McpTool => !!t && isSafeTool(t.name) && !shapes[t.name]);
            } else {
                pending = tools.filter(t => t?.name && isSafeTool(t.name) && !shapes[t.name]);
            }
            pending = pending.slice(0, MAX_TOOLS_PER_SLUG);
            if (pending.length && __DEV__) {
                console.warn(`[MCP probe] ${slug}: probing ${pending.map(t => t.name).join(', ')}`);
            }
            for (const tool of pending) {
                if (Date.now() > deadline) break;
                jobs.push(probeTool(slug, tool));
            }
        }
        const results = await Promise.allSettled(jobs);
        const learned = results.filter(r => r.status === 'fulfilled' && r.value).length;
        if (jobs.length && __DEV__) {
            console.warn(`[MCP probe] ${jobs.length} call(s), ${learned} shape(s) learned`);
        }
        return learned;
    } catch {
        return 0;
    }
}
