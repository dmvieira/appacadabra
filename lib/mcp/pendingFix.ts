/**
 * MCP integration pendências ("pending fix") for spells.
 *
 * A spell generated while a referenced MCP server was not connected (or whose
 * declared tools had no observed shapes yet) was coded against guessed field
 * names. Those spells get a persistent flag so the UI can warn the user and
 * offer a one-tap integration update (a regular edit job with a targeted
 * instruction — runs only when the user taps the button).
 *
 * Pure instruction helpers + one async computation. store/manager are required
 * lazily so this module stays importable from the generator pipeline without
 * pulling expo modules into test environments.
 */

/** English, deterministic — the SAME string must be produced by the UI button
 * and recognized by the edit finalizer to clear the flag. Never localized. */
export function buildMcpFixInstruction(slugs: string[]): string {
    const list = slugs.map(s => `\`${s}\``).join(', ');
    return (
        `MCP integration fix: the server(s) ${list} were not connected (or had unknown tool responses) when this spell was generated. ` +
        'Review EVERY AppacadabraMCP.listTools/callTool/callback chain for the listed server(s) against the `Returns (observed)` structures shown in the system prompt ' +
        '— read date and amount fields from the exact paths shown (e.g. raw.dias[0].movimentacoes), never guessed names. ' +
        'Group by day using a container-level date field when present (e.g. iterate dias[] and read dias[].dia). ' +
        'Amounts may be strings like "123.45" — parseFloat before math. Keep all features and localStorage keys unchanged.'
    );
}

/** Matches instructions produced by `buildMcpFixInstruction` (prefix check is
 * enough — slugs vary, the fixed preamble does not). */
export function isMcpFixInstruction(instruction: string | null | undefined): boolean {
    return !!instruction && instruction.startsWith('MCP integration fix:');
}

const CODE_MENTION_RE = /\bAppacadabraMCP\s*\.\s*(?:callTool|connect|listTools|isConnected|readResource)\s*\(\s*['"]([a-z0-9][a-z0-9\-]*)['"]/g;

/** All MCP slugs statically referenced in spell code (any AppacadabraMCP.* call). */
export function extractCodeMcpSlugs(code: string): string[] {
    const out = new Set<string>();
    let m: RegExpExecArray | null;
    const re = new RegExp(CODE_MENTION_RE.source, 'g');
    while ((m = re.exec(code ?? '')) !== null) out.add(m[1]);
    return [...out];
}

/**
 * Pending-fix flag to persist after an EDIT.
 *
 * - The targeted "update integration" edit clears the flag.
 * - Any other edit keeps previously flagged slugs the new code still calls —
 *   a cosmetic edit ("make the header blue") rewrites none of the blind
 *   integration, so connecting the server in the meantime must not silently
 *   clear it — and adds whatever the recomputation flags for the new code.
 *   Slugs the new code no longer calls are dropped.
 */
export function mergeEditPendingFix(opts: {
    instruction: string | null | undefined;
    previous: string[] | null | undefined;
    recomputed: string[];
    code: string;
}): string[] {
    if (isMcpFixInstruction(opts.instruction)) return [];
    const referenced = new Set(extractCodeMcpSlugs(opts.code));
    const out = new Set<string>();
    for (const slug of opts.previous ?? []) if (referenced.has(slug)) out.add(slug);
    for (const slug of opts.recomputed) out.add(slug);
    return [...out];
}

/**
 * Slugs referenced by the request context: declared in
 * `technicalRequirements.mcpTools` or referenced by the code. Deliberately
 * strict — the earlier heuristic that also matched slugs/names as substrings
 * anywhere in prompt/plan/code produced false positives (e.g. CSS
 * `linear-gradient` flagged the `linear` server, and plan text echoing the
 * connector catalog flagged every server at once).
 */
function referencedSlugs(ctx: { prompt: string; plan?: unknown; code?: string }): string[] {
    const out = new Set<string>();
    const { extractPlanMcpTools } = require('./probe');
    for (const slug of extractPlanMcpTools(ctx.plan).keys()) out.add(slug);
    for (const slug of extractCodeMcpSlugs(ctx.code ?? '')) out.add(slug);
    return [...out];
}

/**
 * Slugs whose integration was coded blind, i.e.:
 * - server not connected at generation time, OR
 * - connected but planner-declared tools exist in cache and NONE has an
 *   observed shape yet, OR
 * - connected, undeclared, and the slug has no observed shapes at all.
 *
 * Never flags when at least one declared tool already has a shape — partial
 * knowledge is not a blind guess.
 */
export async function computeMcpPendingFix(ctx: { prompt: string; plan?: unknown; code?: string }): Promise<string[]> {
    try {
        const { isConnected } = require('./manager');
        const { getShapesForSlug, getCachedTools } = require('./store');
        const planTools = (require('./probe') as typeof import('./probe')).extractPlanMcpTools(ctx.plan);

        const flagged: string[] = [];
        for (const slug of referencedSlugs(ctx)) {
            const declared = planTools.get(slug);
            if (declared && !declared.length) continue;
            if (!(await isConnected(slug).catch(() => false))) {
                flagged.push(slug);
                continue;
            }
            const shapes = await getShapesForSlug(slug).catch(() => ({}) as Record<string, string>);
            if (declared?.length) {
                const anyShape = declared.some(t => !!shapes[t]);
                if (!anyShape) flagged.push(slug);
                continue;
            }
            if (Object.keys(shapes).length === 0) {
                // Only flag when the tool cache confirms the server publishes
                // tools at all — an unreachable/empty catalog slug is noise.
                const tools = await getCachedTools(slug).catch(() => [] as { name?: string }[]);
                if (tools.length > 0) flagged.push(slug);
            }
        }
        return flagged;
    } catch {
        return [];
    }
}

/** Static `callTool("slug", "tool", ...)` pairs extractable from spell code.
 * Dynamic tool lookups (`tools.find(...).name`) can't be extracted — the
 * caller falls back to slug-level timing for those. */
const CALL_TOOL_RE = /AppacadabraMCP\s*\.\s*callTool\s*\(\s*['"]([a-z0-9][a-z0-9\-]*)['"]\s*,\s*['"]([A-Za-z0-9_\-\.]+)['"]/g;

export function extractCallToolPairs(code: string): { slug: string; tool: string }[] {
    const out: { slug: string; tool: string }[] = [];
    const re = new RegExp(CALL_TOOL_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) out.push({ slug: m[1], tool: m[2] });
    return out;
}

/**
 * One-time-per-spell retroactive evaluation for spells created BEFORE the
 * shape-capture feature existed (their `mcp_pending_fix` is NULL). A slug is
 * flagged when the server was not connected, has no observed shapes, or the
 * spell predates the first observed shape for the tools its code calls
 * statically — i.e. the integration could only have been written blind.
 * Evaluated rows are written as `[]` (clean) or the flagged slugs, so the
 * scan never repeats for them.
 *
 * Also clears stale flags written by the earlier, looser heuristic (slugs the
 * code never references) via `clearOrphanMcpFixFlags`.
 *
 * Returns how many spells were written. Fire-and-forget safe.
 */
export async function backfillPendingFixFlags(): Promise<number> {
    try {
        const db = require('../database/db') as typeof import('../database/db');
        const { isConnected } = require('./manager');
        const { getShapesForSlug, getEarliestShapeObservedAt, getToolShapeObservedAt } = require('./store');
        const rows = await db.getAppsWithoutMcpFixEvaluation();
        let evaluated = 0;
        for (const row of rows) {
            const pairs = extractCallToolPairs(row.code);
            const flagged: string[] = [];
            for (const slug of row.mcps) {
                if (!(await isConnected(slug).catch(() => false))) {
                    flagged.push(slug);
                    continue;
                }
                const shapes = await getShapesForSlug(slug).catch(() => ({}) as Record<string, string>);
                if (Object.keys(shapes).length === 0) {
                    flagged.push(slug);
                    continue;
                }
                const tools = pairs.filter(p => p.slug === slug).map(p => p.tool);
                if (tools.length === 0) {
                    // No static tool references — fall back to slug-level timing.
                    const earliest = await getEarliestShapeObservedAt(slug).catch(() => null);
                    if (earliest != null && row.createdAt < earliest) flagged.push(slug);
                    continue;
                }
                for (const tool of tools) {
                    const observedAt = await getToolShapeObservedAt(slug, tool).catch(() => null);
                    if (observedAt == null || row.createdAt < observedAt) {
                        flagged.push(slug);
                        break;
                    }
                }
            }
            await db.setMcpPendingFix(row.id, flagged).catch(() => {});
            evaluated++;
        }
        if (evaluated > 0 && __DEV__) {
            console.warn(`[MCP pendingFix] backfill evaluated ${evaluated} legacy spell(s)`);
        }
        // Heal false-positive flags written by the previous heuristic.
        evaluated += await clearOrphanMcpFixFlags();
        return evaluated;
    } catch {
        return 0;
    }
}

/**
 * Clears stale pending-fix flags whose slugs are NOT referenced by the spell's
 * code at all. Earlier heuristics flagged slugs merely mentioned in the
 * prompt/plan or matched inside generated CSS (e.g. `linear-gradient`), so
 * spells that never used MCP got the "integration may be outdated" banner.
 * Partial keeps are allowed: only orphan slugs are removed; a flag whose slugs
 * are all still referenced is left untouched (no rewrite).
 * Fire-and-forget safe.
 */
export async function clearOrphanMcpFixFlags(): Promise<number> {
    try {
        const db = require('../database/db') as typeof import('../database/db');
        const rows = await db.getAppsWithMcpFixFlagged();
        let cleared = 0;
        for (const row of rows) {
            const referenced = new Set(extractCodeMcpSlugs(row.code));
            const keep = row.flagged.filter(s => referenced.has(s));
            if (keep.length === row.flagged.length) continue;
            await db.setMcpPendingFix(row.id, keep).catch(() => {});
            cleared++;
        }
        if (cleared > 0 && __DEV__) {
            console.warn(`[MCP pendingFix] cleared orphan flags on ${cleared} spell(s)`);
        }
        return cleared;
    } catch {
        return 0;
    }
}
