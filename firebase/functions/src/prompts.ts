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

PREFER DETERMINISTIC CODE:
The generated app should use AI when makes sense:
1. USE FIXED MESSAGES: For tips, greetings, feedback - use pre-written strings, not AI generation
2. USE SIMPLE LOGIC: For calculations, sorting, filtering - use JavaScript functions, not AI
3. CACHE AI RESPONSES: If AI is used, store results in localStorage to avoid repeated calls
4. AVOID AI FOR: Random quotes, motivational messages, placeholder text - use arrays with fixed options
5. PREFER LOCAL DATA: Use hardcoded lists/data instead of generating content via AI

⚠️ IMPORTANT: CALLBACK & DATA HANDLING
All API callbacks receive two arguments: \`(success: boolean, result: string)\`
1. \`success\`: Indicates if the COMPONENT/BRIDGE call was executed without system errors.
2. \`result\`: A STRING that usually contains a JSON object. You MUST \`JSON.parse(result)\` to access the actual data.

Example Pattern:
\`\`\`javascript
window.handleAuth = function(success, resultString) {
    if (!success) {
        console.error("System Error:", resultString);
        return;
    }
    try {
        const data = JSON.parse(resultString);
        // NOW check the logical success
        if (data.success) {
             console.log("User Authenticated!");
        } else {
             console.log("Auth Failed:", data.error);
        }
    } catch (e) {
        console.error("JSON Error", e);
    }
};
\`\`\`

--- API DOCUMENTATION ---

📅 CALENDAR (AppacadabraCalendar)
- \`createEvent(title, desc, startMs, endMs, callback)\`
- \`createEventWithReminder(title, desc, startMs, endMs, minutes, callback)\`
- **Return**: "Calendar opened" (string)

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

📇 CONTACTS (AppacadabraContacts)
- \`getAll(callback)\`
    - **Return JSON**: \`[{ "id": "1", "name": "John", "phoneNumbers": [{ "number": "123" }], "emails": [{ "email": "a@b.com" }] }, ...]\`
- \`search(query, callback)\`
    - **Return JSON**: Same array format as getAll.
- \`add(contactObj, callback)\`
    - **Return**: Contact ID (string)
- \`update(contactObj, callback)\`
    - **Return**: Contact ID (string)

🔐 AUTH (AppacadabraAuth)
- \`isAvailable(callback)\`
    - **Return JSON**: \`{ "available": boolean, "types": number[] }\`
- \`authenticate(reason, callback)\`
    - **Return JSON**: \`{ "success": boolean, "error": string, "warning": string }\`
    - **CRITICAL**: The outer callback \`success\` only means the dialog opened. You MUST check \`JSON.parse(result).success\` to see if user passed biometrics.

📱 SENSORS (AppacadabraSensors)
- \`startAccelerometer(intervalMs, callback)\`
    - **Callback Data (JSON)**: \`{ "x": number, "y": number, "z": number }\`
- \`startGyroscope(intervalMs, callback)\`
    - **Callback Data (JSON)**: \`{ "x": number, "y": number, "z": number }\`
- \`startMagnetometer(intervalMs, callback)\`
    - **Callback Data (JSON)**: \`{ "x": number, "y": number, "z": number, "heading": number }\`
`;

// Prompt for generating a new app
export const GENERATE_APP_PROMPT = `
You are an expert mobile app generator. Create a complete, single-file web app using HTML, CSS (internal), and JavaScript (internal).
The app must be modern (use modern browser features), visually appealing with the following design guidelines:
  - Use a dark theme by default, with a modern purple/blue neon styled accent color.
  - The UI must be simple, intuitive, and mobile-friendly (touch targets > 44px, good contrast, no tiny text).
  - Use flexbox or CSS Grid for layout.
  - Add smooth transitions and subtle animations.
  - Use SVG or emoji icons. Do not use external icon libraries.
  - Avoid plain black or white backgrounds. Use dark grays with slight gradients.
  - Fonts: use system fonts or Google Fonts (Inter, Roboto, Outfit).

User's request for the app:
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

// ============= CONTENT MODERATION =============
// Block malicious, harmful, or inappropriate app generation requests

const BLOCKED_PATTERNS = [
    // Malware/hacking
    /keylogger/i,
    /spyware/i,
    /malware/i,
    /ransomware/i,
    /trojan/i,
    /exploit/i,
    /rootkit/i,
    /backdoor/i,

    // Phishing/fraud
    /phishing/i,
    /fake.*login/i,
    /credential.*steal/i,
    /password.*harvest/i,
    /clone.*site/i,
    /imitar.*site/i,
    /roubar.*senha/i,
    /roubar.*dados/i,
    /capturar.*senha/i,
    /clonar.*(instagram|facebook|whatsapp|banco|bank)/i,

    // Data theft
    /steal.*data/i,
    /exfiltrat/i,
    /scrape.*personal/i,
    /harvest.*contact/i,
    /export.*all.*contacts/i,

    // Harassment/illegal
    /stalk/i,
    /track.*without.*consent/i,
    /spy.*on/i,
    /espionar/i,
    /rastrear.*sem.*consen/i,
    /perseguir/i,

    // Explicit/inappropriate
    /porn/i,
    /nsfw/i,
    /nude/i,
    /adult.*content/i,
    /conteúdo.*adulto/i,
    /explicit/i,
    /sexual/i,

    // Violence/weapons
    /bomb.*making/i,
    /weapon.*instructions/i,
    /how.*to.*kill/i,
    /como.*matar/i,
    /fabricar.*bomba/i,
    /arma.*caseira/i,

    // Scam/fraud
    /pyramid.*scheme/i,
    /ponzi/i,
    /esquema.*piramid/i,
    /golpe/i,
    /fraude/i,

    // Code injection attempts
    /eval\s*\(/i,
    /document\.cookie/i,
    /xmlhttprequest.*external/i,
    /send.*to.*server/i,
    /enviar.*para.*servidor/i,
];

const BLOCKED_KEYWORDS = [
    'hack', 'hacker', 'hacking',
    'crack', 'cracker',
    'warez', 'pirat',
    'ddos', 'botnet',
    'phish',
];

export interface ContentValidationResult {
    allowed: boolean;
    reason?: string;
}

export function validateContentRequest(text: string): ContentValidationResult {
    const lowerText = text.toLowerCase();

    // Check patterns
    for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(text)) {
            return {
                allowed: false,
                reason: 'This type of app cannot be created for safety reasons.'
            };
        }
    }

    // Check keywords
    for (const keyword of BLOCKED_KEYWORDS) {
        if (lowerText.includes(keyword)) {
            return {
                allowed: false,
                reason: 'This type of app cannot be created for safety reasons.'
            };
        }
    }

    return { allowed: true };
}
