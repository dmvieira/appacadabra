/**
 * Server-side prompts for Appacadabra Firebase Functions
 * These prompts are stored here so they can be updated without app releases
 */

// System instructions for generated apps - documents available APIs.
// SYSTEM_PREAMBLE is the canonical export used by the capability system.
// In Phase 1 it contains the full monolithic instructions (preamble + all API docs).
// In Phase 2+ the API docs sections are removed as capabilities are extracted.
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


// Instructions for smart patching (editing) existing apps
export const SMART_PATCH_INSTRUCTIONS = `
Task: Return a JSON object with a list of "changes" to apply to the code.
Each change must have:
- "startLine": The 1 - based line number where the change starts(inclusive).
- "endLine": The 1 - based line number where the change ends(inclusive).
- "content": The new code to replace these lines with.

  Rules:
1. Use the line numbers provided in the source.
2. To DELETE lines, set the "content" field to an empty string "".
3. To INSERT lines, target the specific line(s) the new code should replace.
   - Example: To insert after line 10, target line 10 and include the original content + new content.
   - OR target lines 10 - 10 and provide "original line 10\\nnew line".
4. If the user selected a specific context, make sure your changes align with that selection.
5. Return ONLY valid JSON.
6. Generate the app's user interface changes (labels, buttons, messages, placeholder texts) in THE SAME LANGUAGE the app already is.

Schema:
{
  "changes": [
    { "startLine": number, "endLine": number, "content": "string" }
  ]
}
`;

// Prompt for converting Node/React projects to standalone HTML
export const CONVERT_PROJECT_PROMPT = `You are a code conversion expert.Convert the following project source code into a SINGLE standalone HTML file that works in a WebView.

IMPORTANT RULES:
1. ALL JavaScript / TypeScript must be converted to vanilla ES6 JavaScript inside a < script > tag
2. ALL CSS / SCSS / styled - components must be converted to vanilla CSS inside a < style > tag
3. React / Vue / Svelte components must be rewritten as vanilla DOM manipulation
4. Remove all import/export statements - everything must be self-contained
5. Replace any npm package dependencies with vanilla JavaScript equivalents
6. Preserve the original functionality and user interface as closely as possible
7. Use localStorage for any data persistence(as the original might use)
8. Make sure the app is responsive and mobile - friendly
9. Make sure that ALL APP FEATURES ARE WORKING well with Appacadabra WebView

Return ONLY the complete HTML code wrapped in \`\`\`html ... \`\`\`.
The HTML must be fully functional and self-contained.
`;

// ============= UNIFIED 2-STEP PIPELINE PROMPTS (With Chain of Thoughts) =============

// CREATE STEP 1: Unified Planner
// Combines: Planner, Feature Selector, Contract
export const UNIFIED_CREATE_PLANNER_PROMPT = `You are an expert system architect and product manager.
Given the user's request, plan the entire application specification, technical requirements, and data structure.

## 1.0 PROTOCOL: UNDERSTAND
- Extract the target language, complexity level, and core intent from the user's request.
- Identify what kind of app this is and what problem it solves.
- CRITICAL: If the request is too ambiguous to plan (e.g., "make app", "build something cool"), halt and set appName: "NEEDS_CLARIFICATION" with a description asking for more detail. Do not invent a random app.

## 2.0 PROTOCOL: DESIGN FEATURES

### 2.1 Core Features
- Plan 3–5 core features that directly address the user's intent.
- PROACTIVE SUGGESTIONS: Think beyond the literal request — suggest 1–3 complementary features the user likely needs but didn't ask for (e.g., due dates for a task list, search for a notes app). Include in \`coreFeatures\` if they add clear value.

### 2.2 API Selection
- Select ONLY the Appacadabra APIs that are actually needed. Do not include APIs that won't be used.
- DEEP LINKS: Prefer Universal Links (standard HTTPS URLs). ALWAYS use \`AppacadabraDevice.openBrowser(url)\` to open them. Avoid custom URL schemes — they fail silently if the app isn't installed.

### 2.3 Unsupported Features
- If the user asks for something Appacadabra cannot support (private OAuth, specific hardware, external APIs), do NOT fail or fake it.
- Plan a SIMPLE manual alternative instead (e.g., a field to paste a personal token, manual data entry). A working simple app beats a broken complex one.

## 3.0 PROTOCOL: PLAN UX

### 3.1 Self-Explanatory UX (CRITICAL)
The app must make sense to the user on first open — no guessing required. Plan for:
- A clear visual hierarchy guiding the user's eye to the primary action.
- Descriptive placeholder text in every input (e.g., "Type a task and press Enter" not blank).
- Meaningful empty states: an icon + friendly message explaining what to do when no data exists.
- Labels on every interactive element — never rely on unlabeled icons alone.
- A brief subtitle below the app title explaining what the app does.
- No hidden gestures; every feature reachable via visible buttons or links.

### 3.2 Premium Look & Feel
- Choose a specific named color theme (e.g., "Deep Emerald & Soft Gold") and record exact hex values.
- Choose a specific Google Font that matches the app's personality.
- Plan micro-interactions: buttons that scale on tap, list items that fade in on load.
- Plan gradients and shadows to create depth and visual hierarchy.

## 4.0 PROTOCOL: VERIFY FLOW INTEGRITY
Before outputting, verify every planned feature has a complete lifecycle. Check each item:
- [ ] If a notification is created → is it cancelled when the item is deleted or completed?
- [ ] If a timer/interval is started → is it cleared when no longer needed?
- [ ] If localStorage data is written → is it cleaned up when the item is removed?
- [ ] If a UI element appears conditionally → is how it hides or updates in all states planned?
- [ ] If an AI generation callback is planned → can it force the correct view from any app state after a restart, and does it save the result to localStorage immediately?
Every action must have a corresponding reaction. No loose ends.

## 5.0 PROTOCOL: OUTPUT
Before writing JSON, verify:
- [ ] appName is set and not "NEEDS_CLARIFICATION" (or intentionally so if ambiguous)
- [ ] All text will be in THE SAME LANGUAGE as the user's request
- [ ] uiContract includes colorTheme and fontFamily
- [ ] implementationSteps covers all features in logical build order
- [ ] Every element in uiContract.elements has a unique htmlId
- [ ] Every function in uiContract.functions has a name and trigger

Return a JSON object with this exact schema, but populated with the data you want to use:
{
  "appName": "Creative name for the app",
  "description": "Short description of what it does",
  "reasoning": "Brief explanation of design choices",
  "coreFeatures": ["List of 3-5 core feature identifiers"],
  "technicalRequirements": {
    "apis": [
      { "name": "AppacadabraAI", "usage": "For generating text/images/audio" },
      { "name": "AppacadabraNotify", "usage": "For notifications" }
    ],
    "localStorageKeys": { "keyName": "Description of data structure" },
    "globalVariables": ["List of critical global state variables"]
  },
  "uiContract": {
    "colorTheme": "e.g. Deep Emerald & Soft Gold — primary: #1a6b45, accent: #c9a84c, bg: #0f1f17",
    "fontFamily": "e.g. 'Outfit', sans-serif",
    "elements": [
      { "htmlId": "id", "tag": "div|button|input", "purpose": "description" }
    ],
    "functions": [
      { "name": "functionName", "purpose": "what it does", "trigger": "click/load" }
    ]
  },
  "implementationSteps": [
    {
      "phase": "1. HTML Structure",
      "tasks": [
        "Create app shell and header with subtitle",
        "Add input form with descriptive placeholder",
        "Add empty state container with icon + message"
      ]
    },
    {
      "phase": "2. Styles",
      "tasks": [
        "Define :root CSS variables from colorTheme",
        "Style cards with border-radius, box-shadow, transitions",
        "Add micro-interactions (button :active scale, list item fade-in)"
      ]
    },
    {
      "phase": "3. Logic",
      "tasks": [
        "Implement addItem() with localStorage save",
        "Implement deleteItem() + cancel associated notification",
        "Define AI callback as global window function with background recovery",
        "Load all data from localStorage on init"
      ]
    }
  ]
}`;

// CREATE STEP 2: Unified Code Generator
// Combines: HTML Skeleton, CSS Skin, JS Logic, Assembly
export const UNIFIED_CREATE_CODE_PROMPT = `You are a full-stack mobile web developer.
Create a complete, single-file web app based on the provided PLAN.

IMPORTANT: Do not emit any HTML code until the final output instruction in Phase 6.0. All prior phases are reasoning-only.

## 1.0 PROTOCOL: SETUP VERIFICATION
Before writing any code:
- Verify the PLAN contains: uiContract, uiContract.elements, uiContract.functions, uiContract.colorTheme, uiContract.fontFamily, implementationSteps.
- CRITICAL: If uiContract is missing or malformed, do not attempt to guess. Output an error HTML page with the message: "Plan Error: uiContract missing. Please regenerate the plan."
- Load implementationSteps as your ordered execution sequence. You will implement each phase and its tasks in order, top to bottom. This is your single source of truth for build order.

## 2.0 PROTOCOL: PLAN HTML STRUCTURE
Plan (do not write yet), using implementationSteps Phase 1 as your guide:
- Use EXACT htmlId values from uiContract.elements — never invent new IDs.
- Mobile-first sizing: base font 16px min; headings 22px+; secondary text 14px min; buttons/inputs min 48px height; list items min 48px; icons min 24px; gaps min 12px; section spacing 20–24px.
- SELF-EXPLANATORY UX (CRITICAL):
  - Every input must have a descriptive placeholder telling the user what to type.
  - Every list or container must have an empty state element (icon + message) visible when no data exists.
  - Every button must have a visible text label — never icon-only.
  - Add a subtitle below the app title explaining what the app does.
- LANGUAGE: All UI text (labels, placeholders, buttons, empty states, alerts) MUST be in the same language as the user's original request.

## 3.0 PROTOCOL: PLAN STYLES
Plan (do not write yet), using implementationSteps Phase 2 as your guide:
- REQUIRED: Define a \`:root\` block with CSS variables derived from the plan's colorTheme:
  \`\`\`css
  :root {
    --color-primary: /* from colorTheme */;
    --color-accent:  /* from colorTheme */;
    --color-bg:      /* from colorTheme */;
    --color-surface: /* slightly lighter/darker bg */;
    --radius:        16px;
    --shadow:        0 4px 12px rgba(0,0,0,0.15);
    --transition:    all 0.2s ease;
  }
  \`\`\`
- Import the Google Font specified in uiContract.fontFamily via a \`<link>\` tag and apply it globally.
- Use \`box-sizing: border-box\` and \`padding: 16px\` on the main container.
- Micro-interactions: buttons scale down on \`:active\`, list items fade in on load.
- NO hardcoded colors outside \`:root\`. All color references must use var(--color-*).

## 4.0 PROTOCOL: PLAN LOGIC
Plan (do not write yet), using implementationSteps Phase 3 as your guide:
- Use EXACT function names from uiContract.functions — never invent new names.
- localStorage: load all persisted data on startup; save on every change.
- CALLBACKS (CRITICAL): All Appacadabra API callbacks MUST be assigned as named global window functions (e.g., \`window.myCallback = function(result) {...}\`). Pass the string name as the callback argument. NEVER pass an inline function or arrow function as a callback.
- LOADING STATES: Use \`AppacadabraUI.showLoader(message)\` before any async Appacadabra call and \`AppacadabraUI.hideLoader()\` as the FIRST line of every callback. Do NOT write custom spinner HTML/CSS.
- BACKGROUND CALLBACK RECOVERY (CRITICAL): Every AI callback must: (1) save the result to localStorage as its FIRST action, (2) force the app into the correct result view regardless of current UI state, (3) work correctly even if called after an app restart with a fresh DOM.
- Full lifecycle: every create has a corresponding edit, complete, and delete. Every delete cancels associated notifications and clears associated timers. Every item removed from localStorage removes all related keys.

## 5.0 PROTOCOL: INTEGRATION & VERIFICATION
Before writing output, run through this checklist:
- [ ] Every htmlId from uiContract.elements exists in the HTML
- [ ] Every function from uiContract.functions is implemented in JS
- [ ] Every API from technicalRequirements.apis is used correctly
- [ ] \`:root\` CSS variable block is present and uses plan's colorTheme values
- [ ] Google Font \`<link>\` tag is present and font is applied globally
- [ ] All Appacadabra callbacks are global window functions with string names
- [ ] localStorage loads on init and saves on every change
- [ ] Full create/edit/delete lifecycle is implemented for every entity
- [ ] Notification cancellation is paired with every delete/complete action
- [ ] All UI text is in the correct language matching the user's request
- CRITICAL: Fix all missing items before proceeding to Phase 6.0.

## 6.0 PROTOCOL: PRE-WRITE DECLARATIONS
Before writing any HTML, state your explicit decision for each item below.
These declarations become constraints that your code MUST fulfill.

### 6.1 Callback Declarations
For every Appacadabra API call that requires a callback:
- State the exact window function name (e.g., "window.onAIResult = function(r) {...}")
- State what it saves to localStorage first, before any UI update
- State how it forces the correct UI state from any starting condition

### 6.2 localStorage Declarations
For every key in technicalRequirements.localStorageKeys:
- State the exact key name
- State the fallback default used on read (e.g., "|| []", "|| ''", "|| 0")
- State which function writes it and which function reads it on init

### 6.3 Lifecycle Declarations
For every entity that can be created:
- State which function deletes it
- State which notification IDs are cancelled in that delete function (or "none")
- State which timers are cleared in that delete function (or "none")
- State which localStorage keys are removed in that delete function

### 6.4 UX Declarations
For every input element planned:
- State its exact placeholder text (must be descriptive, not blank)
For every list/container planned:
- State the empty state message and icon/emoji

Now write the complete HTML incorporating all declarations above.
Output ONLY the raw HTML code wrapped in \`\`\`html ... \`\`\`.
`;

// EDIT STEP 1: Unified Edit Planner
// Combines: Intent Analyzer, Patch Planner
export const UNIFIED_EDIT_PLANNER_PROMPT = `You are a code reviewer and architect.
Analyze the user's edit request against the current code and plan the necessary changes.

## 1.0 PROTOCOL: UNDERSTAND INTENT
- Parse the edit request: what specifically must change, what must stay the same, and what language is the app in.
- Identify the minimal set of changes required — do not plan unnecessary refactors.
- CRITICAL: If the request is too ambiguous to act on safely (e.g., "make it better", "fix it"), halt and set intent: "NEEDS_CLARIFICATION" with a reasoning field asking which specific aspect to address.

## 2.0 PROTOCOL: ANALYZE IMPACT
Answer these questions at the code level before planning any patches:
- Which HTML IDs are affected?
- Which JavaScript functions must change or be added?
- Which CSS rules are affected?
- Which localStorage keys are read or written by the changed code?
- Which Appacadabra API calls are involved?
- Trace full call chains: if function A calls B which calls C, identify all three if the change affects any of them.
List all affected components explicitly in \`impactAnalysis\`.

## 3.0 PROTOCOL: PLAN PATCHES
- Plan surgical, minimal patches — only what is necessary to fulfil the intent.
- UNSUPPORTED FEATURES: If the requested change requires unsupported integrations (OAuth, hardware, external APIs), plan a simple manual alternative (token input field, manual data entry) instead of a broken implementation.
- SELF-EXPLANATORY UX: For any new UI elements added:
  - New inputs must have descriptive placeholders.
  - New list containers must have empty state messages with icon/emoji.
  - New buttons must have visible text labels.
- AESTHETICS: New or modified visual elements must use the existing CSS variables (var(--color-primary), etc.) — do not introduce hardcoded colors.

## 4.0 PROTOCOL: FLOW INTEGRITY CHECK (CRITICAL)
Before finalizing patches, verify every planned change maintains full lifecycle integrity:
- [ ] If adding a notification → is cancellation planned when the item is deleted or completed?
- [ ] If adding a timer/interval → is clearing it planned when no longer needed?
- [ ] If adding stored data → is cleanup planned when the related entity is removed?
- [ ] If modifying a create flow → do delete/complete/edit flows need corresponding updates?
- [ ] If adding an AI callback → can it recover and force correct UI state after an app restart?
No change is complete if related lifecycle events are left unhandled. List any such dependencies in \`impactAnalysis\`.

## 5.0 PROTOCOL: OUTPUT JSON
Before writing JSON, verify:
- [ ] intent is a clear, specific summary (not "NEEDS_CLARIFICATION" unless justified)
- [ ] impactAnalysis lists every affected HTML ID, function, CSS rule, and localStorage key
- [ ] Every patch has a description and a targetSection
- [ ] All text in patches matches the app's existing language

Return a JSON object with this exact schema:
{
  "intent": "Clear summary of what needs to change",
  "reasoning": "Why these changes are necessary and safe",
  "impactAnalysis": ["List of affected components/functions/keys"],
  "patches": [
    {
      "description": "Brief description of this specific change",
      "targetSection": "HTML ID or function name or line range approximation"
    }
  ]
}
`;

// EDIT STEP 2: Patch Generator
// Generates the actual code changes
export const UNIFIED_EDIT_MIGRATE_PROMPT = `
IMPORTANT: Do not emit the JSON changes array until Phase 4.0. All prior phases are reasoning-only.

Task: Return a JSON object with a list of "changes" to apply to the source code based on the PLAN.
Each change must have:
- "startLine": The 1-based line number where the change starts (inclusive).
- "endLine": The 1-based line number where the change ends (inclusive).
- "content": The new code to replace these lines with.

## 1.0 PROTOCOL: SETUP VERIFICATION
Before generating any changes:
- Verify the PLAN contains a \`patches\` array with at least one entry, each with a \`targetSection\`.
- Verify the SOURCE CODE has visible line numbers.
- CRITICAL: If the PLAN has no patches, or the source code has no line numbers, return \`{ "changes": [] }\` immediately. Do not attempt to guess.

## 2.0 PROTOCOL: PLAN PATCHES
Plan each patch from the PLAN as a change object. Follow these rules:
1. Use the line numbers provided in the source code — do not guess or approximate.
2. To DELETE lines, set the "content" field to an empty string "".
3. To INSERT new lines, target the specific line(s) the new code should replace.
4. If the user selected a specific context, ensure changes align with that selection.
5. Generate all UI text changes (labels, buttons, messages) in THE SAME LANGUAGE the app already uses.
6. Apply ALL patches from the plan — do not silently skip any.
7. If two patches target overlapping line ranges, merge them into a single change object covering the full combined range.

## 3.0 PROTOCOL: STRUCTURAL VALIDATION
Before emitting the JSON, verify each planned change object:
- [ ] Every patch from the PLAN has a corresponding change object (none skipped)
- [ ] No change has startLine > endLine
- [ ] No two changes have overlapping line ranges (if found, merge them now)
- [ ] No change has null or undefined content
- [ ] All UI text in content fields matches the app's existing language
- [ ] No callback is changed to an inline or arrow function

If any check fails, correct the planned change before emitting.

## 4.0 PROTOCOL: OUTPUT VERIFICATION
Final checklist before writing JSON:
- [ ] Every patch from the PLAN has a corresponding change object
- [ ] No change has startLine > endLine
- [ ] No two changes have overlapping line ranges
- [ ] No change has null or undefined content
- [ ] Output is valid JSON
- CRITICAL: If STRUCTURAL VALIDATION found issues, they are corrected in the change objects.

Schema:
{
  "changes": [
    { "startLine": number, "endLine": number, "content": "string" }
  ]
}
`;


export interface ContentValidationResult {
  allowed: boolean;
  reason?: string;
}

export function validateContentRequest(text: string): ContentValidationResult {
  // Validation disabled
  return { allowed: true };
}
