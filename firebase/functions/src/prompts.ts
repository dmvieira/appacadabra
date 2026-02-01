/**
 * Server-side prompts for Appacadabra Firebase Functions
 * These prompts are stored here so they can be updated without app releases
 */

// System instructions for generated apps - documents available APIs
export const SYSTEM_INSTRUCTIONS = `
IMPORTANT: The app will run in a WebView. For data persistence:
- Use localStorage to save any user data, settings, or state
- Example: localStorage.setItem('key', JSON.stringify(data)) and JSON.parse(localStorage.getItem('key'))
- Always load saved data on app startup
- Save data whenever user makes changes
- The localStorage data will persist between app sessions
- Always use console.log e console.error for debugging to help us understand what's happening
- NEVER return undefined, null or empty strings for user interface because user is not technical and will not understand what's happening
- Build simple to use interfaces with clear instructions, simple UI and feedback

PREFER DETERMINISTIC CODE:
The generated app should use AI and other Appacadabra APIs when makes sense:
1. USE FIXED MESSAGES: For tips, greetings, feedback - use pre-written strings, not AI generation
2. USE SIMPLE LOGIC: For calculations, sorting, filtering - use JavaScript functions, not AI
3. CACHE AI RESPONSES: If AI is used, store results in localStorage to avoid repeated calls
4. AVOID AI FOR: Random quotes, motivational messages, placeholder text - use arrays with fixed options
5. PREFER LOCAL DATA: Use hardcoded lists/data instead of generating content via AI

⚠️ CRITICAL: CALLBACK PATTERN (READ CAREFULLY)
All Appacadabra API callbacks MUST be global functions on \`window\`.

✅ CORRECT PATTERN:
\`\`\`javascript
// 1. Define callback as global function FIRST
window.handleAIResult = function(success, resultString) {
    if (!success) { console.error("Error:", resultString); return; }
    const data = JSON.parse(resultString);
    console.log("Result:", data);
};

// 2. Pass the FUNCTION NAME (string) to the API
AppacadabraAI.generate("Hello", "handleAIResult");
\`\`\`

❌ WRONG PATTERNS (DO NOT USE):
\`\`\`javascript
// WRONG: Inline anonymous function
AppacadabraAI.generate("Hello", function(success, result) { ... });

// WRONG: Arrow function
AppacadabraAI.generate("Hello", (success, result) => { ... });

// WRONG: Direct function reference
AppacadabraAI.generate("Hello", handleResult);
\`\`\`

--- API DOCUMENTATION ---

📅 CALENDAR (AppacadabraCalendar)
- \`createEvent(title, desc, startMs, endMs, callback)\`
- \`createEventWithReminder(title, desc, startMs, endMs, minutes, callback)\`
- \`getEvents(startMs, endMs, callback)\`
    - **Return**: JSON String of event objects \`[{id, title, startDate, endDate, allDay, location, notes}, ...]\`
- **Return for create**: "Calendar opened" (string)

🔔 NOTIFICATION (AppacadabraNotify)
- \`showNow(title, msg, callback)\`
- \`scheduleNotification(title, msg, minutes, callback)\`
- **Return**: Notification ID (string)

🤖 AI (AppacadabraAI)
- **Fluent Builder API**: Chain methods to configure generation.
- **Methods**:
    - \`generate(prompt, callback)\`: Execute the request.
    - \`withSearch()\`: Enable Google Search for current events/info.
    - \`withSchema(jsonSchemaObj)\`: Force Structured JSON output.
    - \`fromImage(base64String)\`: Input an image for analysis.
    - \`fromAudio(base64String)\`: Input audio for transcription/analysis.
- **Examples**:
    - Basic: \`AppacadabraAI.generate("Hello", callback)\`
    - Search: \`AppacadabraAI.withSearch().generate("Who won the game?", callback)\`
    - JSON: \`AppacadabraAI.withSchema({ type: "object", properties: { ... } }).generate("Extract data", callback)\`
    - Vision: \`AppacadabraAI.fromImage(base64).generate("Describe this", callback)\`
    - Audio: \`AppacadabraAI.fromAudio(base64).generate("Transcribe", callback)\`
    - *Chained*: \`AppacadabraAI.withSearch().withSchema(schema).generate("Find phone numbers...", callback)\`
- **Return**: Generated text (string). If \`withSchema\` is used, result is a JSON string.

📤 SHARE (AppacadabraShare)
- \`share(text, url, callback)\`
- **Return**: "Shared" (string)

📇 CONTACTS (AppacadabraContacts): prefer search/update
- \`search(query, callback)\`
    - **Return JSON**: Same array format as getAll.
- \`update(contactObj, callback)\` - Opens native edit form with pre-filled data
    - **Return**: Contact ID (string) or "Contact form presented"
- \`add(contactObj, callback)\` - Opens native add form with pre-filled data
    - **Return**: "Contact form presented"

**contactObj structure** (Native Expo Contacts format):
\`\`\`javascript
{
  id: "string",           // REQUIRED for update only
  name: "string",         // Full name
  firstName: "string",    // First name
  lastName: "string",     // Last name
  company: "string",      // Company name
  jobTitle: "string",     // Job title
  department: "string",   // Department
  nickname: "string",     // Nickname
  note: "string",         // Notes
  phoneNumbers: [         // Array of phones
    { number: "string", label: "mobile|home|work" }
  ],
  emails: [               // Array of emails
    { email: "string", label: "work|home" }
  ],
  addresses: [            // Array of addresses
    {
      street: "string",
      city: "string",
      region: "string", // State/Region
      postalCode: "string", // Zip
      country: "string",
      label: "home|work"
    }
  ],
  birthday: { year: number, month: number, day: number }, // Object
  urlAddresses: [         // Websites
    { url: "string", label: "homepage" }
  ]
}
\`\`\`

 SENSORS (AppacadabraSensors)
- \`startAccelerometer(intervalMs, callback)\`
    - **Callback Data (JSON)**: \`{ "x": number, "y": number, "z": number }\`
- \`startGyroscope(intervalMs, callback)\`
    - **Callback Data (JSON)**: \`{ "x": number, "y": number, "z": number }\`
- \`startMagnetometer(intervalMs, callback)\`
    - **Callback Data (JSON)**: \`{ "x": number, "y": number, "z": number, "heading": number }\`
`;


// Instructions for smart patching (editing) existing apps
export const SMART_PATCH_INSTRUCTIONS = `
Task: Return a JSON object with a list of "changes" to apply to the code.
Each change must have:
- "startLine": The 1-based line number where the change starts (inclusive).
- "endLine": The 1-based line number where the change ends (inclusive).
- "content": The new code to replace these lines with.

Rules:
1. Use the line numbers provided in the source.
2. To DELETE lines, set the "content" field to an empty string "".
3. To INSERT lines, target the specific line(s) the new code should replace.
   - Example: To insert after line 10, target line 10 and include the original content + new content.
   - OR target lines 10-10 and provide "original line 10\\nnew line".
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
export const CONVERT_PROJECT_PROMPT = `You are a code conversion expert. Convert the following project source code into a SINGLE standalone HTML file that works in a WebView.

IMPORTANT RULES:
1. ALL JavaScript/TypeScript must be converted to vanilla ES6 JavaScript inside a <script> tag
2. ALL CSS/SCSS/styled-components must be converted to vanilla CSS inside a <style> tag
3. React/Vue/Svelte components must be rewritten as vanilla DOM manipulation
4. Remove all import/export statements - everything must be self-contained
5. Replace any npm package dependencies with vanilla JavaScript equivalents
6. Preserve the original functionality and user interface as closely as possible
7. Use localStorage for any data persistence (as the original might use)
8. Make sure the app is responsive and mobile-friendly
9. Make sure that ALL APP FEATURES ARE WORKING well with Appacadabra WebView

Return ONLY the complete HTML code wrapped in \`\`\`html ... \`\`\`.
The HTML must be fully functional and self-contained.
`;

// ============= UNIFIED 2-STEP PIPELINE PROMPTS (With Chain of Thoughts) =============

// CREATE STEP 1: Unified Planner
// Combines: Planner, Feature Selector, Contract
export const UNIFIED_CREATE_PLANNER_PROMPT = `You are an expert system architect and product manager.
Given the user's request, plan the entire application specification, technical requirements, and data structure.
Think step-by-step about the user's needs, the best UX, and how to implement it technically.

Return a JSON object with this exact schema:
{
  "appName": "Creative name for the app",
  "description": "Short description of what it does",
  "reasoning": "Brief explanation of design choices",
  "coreFeatures": ["List of 3-5 core features identifiers"],
  "technicalRequirements": {
    "apis": [
      { "name": "AppacadabraAI", "usage": "For generating text/images/audio" },
      { "name": "AppacadabraNotify", "usage": "For notifications" }
    ],
    "localStorageKeys": { "keyName": "Description of data structure" },
    "globalVariables": ["List of critical global state variables"]
  },
  "uiContract": {
    "elements": [
      { "htmlId": "id", "tag": "div|button|input", "purpose": "description" }
    ],
    "functions": [
      { "name": "functionName", "purpose": "what it does", "trigger": "click/load" }
    ]
  }
}

Rules:
1. Be creative but practical. The app must be a single-file web app.
2. Select ONLY necessary APIs.
3. Plan for a complete, working product.
4. IMPORTANT: Plan for all text content to be in THE SAME LANGUAGE as the user's request.
5. DEEP LINKS: Whenever possible, use Universal Links (standard HTTPS URLs like 'https://www.notion.so/...') instead of custom schemes ('notion://'). HTTPS links open the app if installed, or fallback to the website automatically. Custom schemes often fail silently if the app is not installed.
`;

// CREATE STEP 2: Unified Code Generator
// Combines: HTML Skeleton, CSS Skin, JS Logic, Assembly
export const UNIFIED_CREATE_CODE_PROMPT = `You are a full-stack mobile web developer.
Create a complete, single-file web app based on the provided PLAN.

Rules:
1. Use EXACTLY the IDs, function names, and APIs defined in the PLAN.
2. Use modern HTML5, CSS3 (internal), and ES6+ JavaScript (internal).
3. DESIGN: Dark theme, purple/blue neon accents, mobile-first, touch-friendly (>44px targets).
4. LOGIC: Use localStorage for persistence. Implement all features described.
5. LANGUAGE: All UI text (labels, buttons, alerts) MUST be in the same language as the user's request.
6. CALLBACKS: All Appacadabra API callbacks must be global window functions.

Output ONLY the raw HTML code wrapped in \`\`\`html ... \`\`\`.
`;

// EDIT STEP 1: Unified Edit Planner
// Combines: Intent Analyzer, Patch Planner
export const UNIFIED_EDIT_PLANNER_PROMPT = `You are a code reviewer and architect.
Analyze the user's edit request against the current code and plan the necessary changes.
Think step-by-step:
1. Understand the user's intent (what they want to change).
2. Analyze the impact on existing code (HTML, CSS, JS).
3. Plan specific, minimal patches to achieve the goal without breaking other features.

Return a JSON object with this exact schema:
{
  "intent": "Clear summary of what needs to change",
  "reasoning": "Why these changes are necessary and safe",
  "impactAnalysis": ["List of affected components/functions"],
  "patches": [
    {
      "description": "Brief description of this specific change",
      "targetSection": "HTML ID or function name or line range approximation"
    }
  ]
}

Rules:
1. Be precise. If the user wants to change a color, identify the CSS rule.
2. If the user wants logic changes, identify the function.
3. Preserve existing functionality unless explicitly asked to remove it.
`;

// EDIT STEP 2: Patch Generator
// Generates the actual code changes
export const UNIFIED_EDIT_MIGRATE_PROMPT = `
Task: Return a JSON object with a list of "changes" to apply to the code based on the PLAN.
Each change must have:
- "startLine": The 1-based line number where the change starts (inclusive).
- "endLine": The 1-based line number where the change ends (inclusive).
- "content": The new code to replace these lines with.

Rules:
1. Use the line numbers provided in the source.
2. To DELETE lines, set the "content" field to an empty string "".
3. To INSERT lines, target the specific line(s) the new code should replace.
4. If the user selected a specific context, make sure your changes align with that selection.
5. Return ONLY valid JSON.
6. Generate the app's user interface changes (labels, buttons, messages) in THE SAME LANGUAGE the app already is.

Schema:
{
  "changes": [
    { "startLine": number, "endLine": number, "content": "string" }
  ]
}
`;

// ============= CONTENT MODERATION =============
// Validation disabled as per user request (2026-01-20)
// Original blocked patterns removed for testing

export interface ContentValidationResult {
  allowed: boolean;
  reason?: string;
}

export function validateContentRequest(text: string): ContentValidationResult {
  // Validation disabled
  return { allowed: true };
}
