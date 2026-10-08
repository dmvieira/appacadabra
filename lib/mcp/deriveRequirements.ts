/**
 * Derives which capabilities and MCP connectors a spell actually uses, by
 * scanning its generated code. Pure and dependency-free so it can run inside
 * the DB layer and tests.
 *
 * - Capabilities: every `Appacadabra<Name>` global referenced (e.g. Camera).
 * - MCP connectors: the slug in every `AppacadabraMCP.<method>("slug", ...)` call.
 */

const CAP_RE = /\bAppacadabra([A-Z][A-Za-z0-9_]*)\b/g;
const MCP_CALL_RE = /\bAppacadabraMCP\s*\.\s*(?:callTool|connect|listTools|isConnected)\s*\(\s*['"]([a-z0-9][a-z0-9\-]*)['"]/g;

export interface SpellRequirements {
    /** Capability display names referenced by the code, e.g. ["Camera","Contacts"]. */
    capabilities: string[];
    /** MCP connector slugs referenced by the code, e.g. ["picpay"]. */
    mcps: string[];
}

export function deriveRequirements(code: string | null | undefined): SpellRequirements {
    const capabilities = new Set<string>();
    const mcps = new Set<string>();
    if (!code || typeof code !== 'string') {
        return { capabilities: [], mcps: [] };
    }

    let m: RegExpExecArray | null;
    CAP_RE.lastIndex = 0;
    while ((m = CAP_RE.exec(code)) !== null) {
        const name = m[1];
        // `MCP` is surfaced through the connectors list instead.
        if (name === 'MCP') continue;
        capabilities.add(name);
    }

    MCP_CALL_RE.lastIndex = 0;
    while ((m = MCP_CALL_RE.exec(code)) !== null) {
        mcps.add(m[1]);
    }

    return {
        capabilities: [...capabilities].sort(),
        mcps: [...mcps].sort(),
    };
}

export function serializeRequirements(req: SpellRequirements): { capabilities: string; mcps: string } {
    return {
        capabilities: JSON.stringify(req.capabilities),
        mcps: JSON.stringify(req.mcps),
    };
}

export function parseRequirements(capabilitiesJson: string | null | undefined, mcpsJson: string | null | undefined): SpellRequirements {
    const parse = (s: string | null | undefined): string[] => {
        if (!s) return [];
        try {
            const v = JSON.parse(s);
            return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        } catch {
            return [];
        }
    };
    return { capabilities: parse(capabilitiesJson), mcps: parse(mcpsJson) };
}
