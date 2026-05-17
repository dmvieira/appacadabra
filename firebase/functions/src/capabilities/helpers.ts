import { FirebaseCapabilityDoc } from './types';
import { SYSTEM_PREAMBLE } from '../prompts';
import { versionGte } from './index';

/**
 * Maps an Appacadabra API name (e.g. "AppacadabraAI") to a capability id (e.g. "ai").
 * The planner outputs API names in this format inside technicalRequirements.apis[].name.
 */
function apiNameToId(apiName: string): string {
    return apiName.replace(/^Appacadabra/i, '').toLowerCase();
}

/**
 * Returns only the capabilities whose API name the planner selected.
 * Falls back to all available capabilities if nothing matched (safe).
 */
export function getCapabilitiesByApiNames(
    apiNames: string[],
    appVersion: string,
    allCaps: FirebaseCapabilityDoc[],
): FirebaseCapabilityDoc[] {
    if (!apiNames || apiNames.length === 0) return allCaps;
    const selectedIds = new Set(apiNames.map(apiNameToId));
    const available = allCaps.filter(c => versionGte(appVersion, c.minVersion));
    const selected = available.filter(c => selectedIds.has(c.id));
    return selected.length > 0 ? selected : available;
}

/**
 * Builds compact system instructions for the planner step.
 * Each capability is one line: API name + first bullet description.
 * The full docs are withheld — the creator receives them after capability selection.
 */
export function buildPlannerSystemInstructions(
    appVersion: string,
    allCaps: FirebaseCapabilityDoc[],
): string {
    const available = allCaps.filter(c => versionGte(appVersion, c.minVersion));
    const lines = available.map(c => {
        return `- **Appacadabra${c.displayName}**: ${c.description}`;
    });
    const list = [
        '## Available Native APIs',
        '',
        ...lines,
        '',
        '*List the APIs you need in `technicalRequirements.apis`. Full documentation will be provided to the coder for those APIs only.*',
    ].join('\n');
    return SYSTEM_PREAMBLE + '\n\n--- AVAILABLE APIs ---\n\n' + list;
}
