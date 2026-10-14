/**
 * Runtime guardrail for MCP tool calls: validates arguments against the
 * tool's cached inputSchema so missing required fields fail fast with an
 * actionable message instead of an opaque server-side error.
 *
 * Pure and dependency-free. Lenient by design: only enforces what the cached
 * schema explicitly requires — unknown tools and schema-less tools pass
 * through so stale caches never break working calls.
 */

import type { McpTool } from './types';

/** Required argument names declared by the tool's inputSchema (may be empty). */
function requiredArgs(tool: McpTool): string[] {
    const schema = tool.inputSchema as { required?: unknown } | undefined;
    const required = schema?.required;
    if (!Array.isArray(required)) return [];
    return required.filter((name): name is string => typeof name === 'string');
}

/**
 * Returns the names of required arguments missing from `args`.
 * Empty when the tool is unknown, has no schema, or nothing is missing.
 */
export function missingRequiredArgs(tool: McpTool | undefined, args: Record<string, unknown>): string[] {
    if (!tool || !args || typeof args !== 'object') return [];
    return requiredArgs(tool).filter(name => !(name in args));
}
