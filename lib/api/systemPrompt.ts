/**
 * System instructions for the AI, built client-side from
 * `lib/capabilities/*` — the single source of truth for capability docs.
 *
 * Direct port of `firebase/functions/src/capabilities/index.ts:buildSystemInstructions`
 * and `firebase/functions/src/prompts.ts:SYSTEM_PREAMBLE`.
 *
 * Phase 1 keeps the server file alive (the server still serves jobs); the
 * `prompts.parity` Jest snapshot pins these strings against the server copy so
 * any drift fails CI explicitly.
 */

import { ALL_CAPABILITIES } from '../capabilities';
import type { CapabilityModule } from '../capabilities/types';

// Byte-for-byte copy of firebase/functions/src/prompts.ts:SYSTEM_PREAMBLE.
// DO NOT EDIT without also updating the server file and the parity snapshot.
export const SYSTEM_PREAMBLE = `
IMPORTANT: The app will run in a WebView. For data persistence:
- Use localStorage to save any user data, settings, or state
- Example: localStorage.setItem('key', JSON.stringify(data)) and JSON.parse(localStorage.getItem('key'))
- Always load saved data on app startup
- Save data whenever user makes changes
- The localStorage data will persist between app sessions
- Always use console.log e console.error for debugging to help us understand what's happening
- NEVER return undefined, null or empty strings for user interface because user is not technical and will not understand what's happening
- Build simple to use interfaces with clear instructions, simple UI and feedback
- **AESTHETICS ARE CRITICAL**: The app must look premium, modern, and beautiful. Use:
    - Curated, harmonious color palettes (avoid generic red/blue/green)
    - Modern typography (e.g., Google Fonts like Inter, Outfit, or Roboto)
    - Smooth gradients, subtle shadows, and generous whitespace
    - Glassmorphism effects (backdrop-filter: blur) where appropriate
    - Micro-animations for interactions (hover, active, transitions)
    - Border-radius: 12px to 24px for a soft, modern feel

PREFER DETERMINISTIC CODE:
The generated app should use AI and other Appacadabra APIs when makes sense:
1. USE FIXED MESSAGES: For tips, greetings, feedback - use pre-written strings, not AI generation
2. USE SIMPLE LOGIC: For calculations, sorting, filtering - use JavaScript functions, not AI
3. CACHE AI RESPONSES: If AI is used, store results in localStorage to avoid repeated calls
4. AVOID AI FOR: Random quotes, motivational messages, placeholder text - use arrays with fixed options
5. PREFER LOCAL DATA: Use hardcoded lists/data instead of generating content via AI
6. USE BUILT-IN UI Appacadabra HELPERS (saves lots of lines per app)

⚠️ CRITICAL: CALLBACK PATTERN (READ CAREFULLY)
All Appacadabra API callbacks MUST be global functions on \`window\`.

⚠️ SUPER CRITICAL: BACKGROUND CALLBACK RECOVERY
Because AI generation can take a long time, the user might close the app and reopen it later. When they reopen the app, your callback might be executed *out of nowhere* while the app is completely reset on its default "Home" screen!
YOUR CALLBACK MUST BE BULLETPROOF:
1. It must independently force the UI to switch to the correct "Result" screen or state, regardless of where the user currently is. (e.g., hide home screen, show result container).
2. It must save the result to \`localStorage\` IMMEDIATELY inside the callback so it isn't lost if they refresh again.
3. Never assume the UI is still on a "Loading" screen when the callback fires. Assume the app might be completely fresh.
4. Ensure target DOM elements exist or handle updates safely.
5. ALWAYS check \`localStorage\` on app initialization to see if there is data from a previous background AI generation that the user hasn't seen yet, and restore the UI.

✅ CORRECT PATTERN:
\`\`\`javascript
// ✅ CORRECT: Use AppacadabraUI for loading states — no custom spinner needed
AppacadabraUI.showLoader("Analyzing...");
AppacadabraAI.generate("Hello", "handleAIResult");

window.handleAIResult = function(success, data) {
    AppacadabraUI.hideLoader();  // hides loader (even if called after app restart)
    if (!success) { AppacadabraUI.toast(data, "error"); return; }
    localStorage.setItem('my_app_latest_result', JSON.stringify(data));
    // force correct UI state — data is already a JS object, use directly:
    document.getElementById('output').innerText = data.text;
};
\`\`\`

❌ WRONG PATTERNS (DO NOT USE):
\`\`\`javascript
// WRONG: Inline anonymous function
AppacadabraAI.generate("Hello", function(success, result) { ... });

// WRONG: Arrow function
AppacadabraAI.generate("Hello", (success, result) => { ... });

// WRONG: Direct function reference
AppacadabraAI.generate("Hello", handleResult);

// ❌ WRONG: Wrapping a callback in a Promise breaks background recovery
async function callAI(prompt) {
    return new Promise(resolve => {
        window.onResult = (s, d) => resolve(d);
        AppacadabraAI.generate(prompt, "onResult"); // Promise dies on app restart!
    });
}
const result = await callAI(prompt); // NEVER works after background recovery
\`\`\`

⚠️ CALLBACK DATA CONVENTION (CRITICAL)
All Appacadabra API callbacks follow: \`callback(success, data)\`
- \`success\` (boolean): true if the operation succeeded, false on error
- \`data\`: **already a JavaScript value** (object, array, string, or number) — NEVER a JSON string
- When \`success\` is false, \`data\` is an error message string
- **NEVER call JSON.parse() on callback data** — it is already the correct type. Use it directly:
  \`\`\`javascript
  window.onSteps = function(success, data) {
    if (!success) return;
    var steps = data.totalSteps;           // ✅ Direct property access
    // var steps = JSON.parse(data).totalSteps; ❌ WRONG — will throw error
  };
  \`\`\`

✅ STANDARD WEB APIS (Supported Natively)
- **Audio/Video**: Use HTML5 \`<audio>\` and \`<video>\` tags.
- **Geolocation**: Use \`navigator.geolocation.getCurrentPosition()\` (permission handled).
- **LocalStorage**: Use \`localStorage.setItem/getItem\` (persisted automatically).
- **File Picker**: Use \`<input type="file">\` (file access enabled).
`;

/** Semver comparison: returns true if appVersion >= minVersion. */
export function versionGte(appVersion: string, minVersion: string): boolean {
    const parse = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0);
    const [maj1 = 0, min1 = 0, pat1 = 0] = parse(appVersion);
    const [maj2 = 0, min2 = 0, pat2 = 0] = parse(minVersion);
    if (maj1 !== maj2) return maj1 > maj2;
    if (min1 !== min2) return min1 > min2;
    return pat1 >= pat2;
}

/**
 * Builds the full system prompt for a given app version. Mirrors the server
 * function exactly so generation quality stays identical post-BYOK.
 * Filters capabilities by minVersion gate.
 */
export function buildSystemInstructions(
    appVersion: string,
    caps: CapabilityModule[] = ALL_CAPABILITIES,
): string {
    if (caps.length === 0) {
        return SYSTEM_PREAMBLE;
    }
    const available = caps.filter(c => versionGte(appVersion, c.minVersion));
    if (available.length === 0) {
        return SYSTEM_PREAMBLE;
    }
    return SYSTEM_PREAMBLE + '\n\n--- API DOCUMENTATION ---\n\n' + available.map(c => c.docs).join('\n\n');
}

/** Maps an API name like "AppacadabraAI" → id "ai". */
function apiNameToId(apiName: string): string {
    return apiName.replace(/^Appacadabra/i, '').toLowerCase();
}

/**
 * Returns only the capabilities whose API name the planner selected.
 * Falls back to all available capabilities if nothing matched (safe).
 * Port of `firebase/functions/src/capabilities/helpers.ts:getCapabilitiesByApiNames`.
 */
export function getCapabilitiesByApiNames(
    apiNames: string[],
    appVersion: string,
    allCaps: CapabilityModule[] = ALL_CAPABILITIES,
): CapabilityModule[] {
    if (!apiNames || apiNames.length === 0) return allCaps;
    const selectedIds = new Set(apiNames.map(apiNameToId));
    const available = allCaps.filter(c => versionGte(appVersion, c.minVersion));
    const selected = available.filter(c => selectedIds.has(c.id));
    return selected.length > 0 ? selected : available;
}

/**
 * Compact system instructions for the planner step. One line per capability:
 * API name + one-sentence description. Full docs are withheld until the coder
 * step (see `buildSystemInstructions`). Port of the server's helper.
 */
export function buildPlannerSystemInstructions(
    appVersion: string,
    allCaps: CapabilityModule[] = ALL_CAPABILITIES,
): string {
    const available = allCaps.filter(c => versionGte(appVersion, c.minVersion));
    const lines = available.map(c => `- **Appacadabra${c.displayName}**: ${c.description}`);
    const list = [
        '## Available Native APIs',
        '',
        ...lines,
        '',
        '*List the APIs you need in `technicalRequirements.apis`. Full documentation will be provided to the coder for those APIs only.*',
    ].join('\n');
    return SYSTEM_PREAMBLE + '\n\n--- AVAILABLE APIs ---\n\n' + list;
}
