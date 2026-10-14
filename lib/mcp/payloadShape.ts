/**
 * Compacts an arbitrary JSON payload into a compact "observed shape" string
 * for injection into AI prompts: real field names + truncated example values
 * so the model maps the server's actual structure instead of guessing.
 *
 * Pure and dependency-free. Budgeted: bounded depth, first array item only,
 * truncated strings, overall size cap — cycle-safe.
 */

const MAX_DEPTH = 5;
const VALUE_LIMIT = 24;
const MAX_ITEMS_SHOWN = 1;
const TOTAL_LIMIT = 1500;

function truncate(value: string): string {
    return value.length > VALUE_LIMIT ? `${value.slice(0, VALUE_LIMIT)}…` : value;
}

/** Renders a compact JSON-ish shape string. Internal recursion is cycle-safe via `seen`. */
function shape(payload: unknown, depth: number, seen: Set<object>): string {
    if (payload === null) return 'null';
    if (payload === undefined) return 'undefined';

    const type = typeof payload;
    if (type === 'string') return `"${truncate(payload as string)}"`;
    if (type === 'number' || type === 'boolean') return String(payload);

    if (type !== 'object') return type; // functions etc. — never expected from JSON

    const obj = payload as object;
    if (seen.has(obj)) return '[circular]';
    if (depth >= MAX_DEPTH) return Array.isArray(obj) ? '[…]' : '{…}';

    seen.add(obj);
    try {
        if (Array.isArray(obj)) {
            if (obj.length === 0) return '[]';
            const head = obj.slice(0, MAX_ITEMS_SHOWN).map(item => shape(item, depth + 1, seen));
            const more = obj.length > MAX_ITEMS_SHOWN ? `, …+${obj.length - MAX_ITEMS_SHOWN}` : '';
            return `[${head.join(', ')}${more}]`;
        }
        const keys = Object.keys(obj).slice(0, 20);
        const body = keys.map(k => `${k}:${shape((obj as Record<string, unknown>)[k], depth + 1, seen)}`);
        const hidden = Object.keys(obj).length - keys.length;
        if (hidden > 0) body.push(`…+${hidden} more`);
        return `{${body.join(', ')}}`;
    } finally {
        seen.delete(obj);
    }
}

/**
 * Public entry: compacts a payload into a shape string with example values.
 * Applies the overall size cap on top of the structural limits.
 */
export function extractShape(payload: unknown): string {
    const full = shape(payload, 0, new Set());
    return full.length > TOTAL_LIMIT ? `${full.slice(0, TOTAL_LIMIT)}…` : full;
}
