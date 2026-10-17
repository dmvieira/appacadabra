/**
 * Capability → Familiar mapping: the permissionamento that decides what a
 * spell can take along when imbuida num dispositivo (appa).
 *
 * Source of truth for capability ids: lib/capabilities/index.ts (17 modules).
 * `required_capabilities` in generated_apps stores DISPLAY names ("Sheets"),
 * derived from the HTML by lib/mcp/deriveRequirements.ts — use
 * displayNameToId() to normalize before mapping.
 *
 * Status semantics:
 *  - granted       → the Familiar can serve it; `powers` must be conceded no
 *                    ritual de vínculo (GRANT_POWER) before/during imbuing
 *  - not-supported → fica de fora do encantamento; listed in the bundle as
 *                    CapabilityEntry{status:"not-supported"} so the device and
 *                    the user know what stayed home
 */

import type { CapabilityEntry, DeviceRequirement } from './protocol';

export type CapabilityStatus = 'granted' | 'not-supported';

export interface CapabilityMapping {
    id: string;
    displayName: string;
    status: CapabilityStatus;
    /** Powers do Cofre exigidos quando granted. */
    powers: string[];
    requires: DeviceRequirement[];
    /** Motivo humano quando not-supported (i18n key sufixo ou texto EN). */
    reason?: string;
}

export const CAPABILITY_MAP: Record<string, CapabilityMapping> = {
    ai: { id: 'ai', displayName: 'AI', status: 'granted', powers: ['openrouter'], requires: ['net'] },
    audio: { id: 'audio', displayName: 'Audio', status: 'granted', powers: ['openrouter'], requires: ['speaker', 'net'] },
    sheets: { id: 'sheets', displayName: 'Sheets', status: 'granted', powers: ['google'], requires: ['net'] },
    forms: { id: 'forms', displayName: 'Forms', status: 'granted', powers: ['google'], requires: ['net'] },
    docs: { id: 'docs', displayName: 'Docs', status: 'granted', powers: ['google'], requires: ['net'] },
    calendar: { id: 'calendar', displayName: 'Calendar', status: 'granted', powers: ['google'], requires: ['net'] },
    clipboard: { id: 'clipboard', displayName: 'Clipboard', status: 'not-supported', powers: [], requires: [], reason: 'deviceClipboard' },
    share: { id: 'share', displayName: 'Share', status: 'not-supported', powers: [], requires: [], reason: 'phoneOnly' },
    screen: { id: 'screen', displayName: 'Screen', status: 'not-supported', powers: [], requires: [], reason: 'phoneOnly' },
    device: { id: 'device', displayName: 'Device', status: 'not-supported', powers: [], requires: [], reason: 'phoneOnly' },
    notify: { id: 'notify', displayName: 'Notify', status: 'not-supported', powers: [], requires: [], reason: 'phoneOnly' },
    health: { id: 'health', displayName: 'Health', status: 'not-supported', powers: [], requires: [], reason: 'phoneOnly' },
    contacts: { id: 'contacts', displayName: 'Contacts', status: 'not-supported', powers: [], requires: [], reason: 'phoneOnly' },
    sensors: { id: 'sensors', displayName: 'Sensors', status: 'not-supported', powers: [], requires: [], reason: 'phoneOnly' },
    ui: { id: 'ui', displayName: 'UI', status: 'not-supported', powers: [], requires: [], reason: 'phoneOnly' },
    camera: { id: 'camera', displayName: 'Camera', status: 'not-supported', powers: [], requires: ['camera'], reason: 'noCameraRuntime' },
    mcp: { id: 'mcp', displayName: 'MCP', status: 'not-supported', powers: [], requires: [], reason: 'phoneOnly' },
};

/** Display name ("Sheets", "AI") → id ("sheets", "ai"). Case-insensitive. */
export function displayNameToId(displayName: string): string | null {
    const needle = displayName.trim().toLowerCase();
    for (const m of Object.values(CAPABILITY_MAP)) {
        if (m.displayName.toLowerCase() === needle) return m.id;
    }
    return null;
}

export interface MappingResult {
    entries: CapabilityEntry[];
    /** Powers únicos que precisam ser concedidos no ritual. */
    powersToGrant: string[];
    unsupported: Array<{ id: string; displayName: string; reason?: string }>;
}

/**
 * Maps the capabilities a spell uses (display names or ids, as stored in
 * generated_apps.required_capabilities) into bundle CapabilityEntries plus
 * the powers the ritual must concede.
 */
export function mapRequirements(requiredCapabilities: string[]): MappingResult {
    const seen = new Set<string>();
    const entries: CapabilityEntry[] = [];
    const powers = new Set<string>();
    const unsupported: MappingResult['unsupported'] = [];

    for (const raw of requiredCapabilities) {
        const id = displayNameToId(raw) ?? (/^[a-z][a-z0-9_]{0,30}$/.test(raw) && CAPABILITY_MAP[raw] ? raw : null);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const m = CAPABILITY_MAP[id];
        if (!m) continue;
        entries.push({ id: m.id, status: m.status, powers: m.powers, requires: m.requires });
        if (m.status === 'granted') {
            for (const p of m.powers) powers.add(p);
        } else {
            unsupported.push({ id: m.id, displayName: m.displayName, reason: m.reason });
        }
    }
    return { entries, powersToGrant: [...powers].sort(), unsupported };
}
