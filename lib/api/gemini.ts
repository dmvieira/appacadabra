import { GoogleGenerativeAI } from '@google/generative-ai';
import { t } from '../i18n';

// API Key should be set via environment variable EXPO_PUBLIC_GEMINI_API_KEY
const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY || '';

const genAI = new GoogleGenerativeAI(API_KEY);

// Primary model
const primaryModel = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

// Fallback model
const fallbackModel = genAI.getGenerativeModel({ model: 'gemma-3-27b-it' });

// Search model with Google Search and Maps
const searchModel = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    // @ts-ignore - googleMaps exists in API but not in SDK types
    tools: [{ googleSearch: {} }, { googleMaps: {} }],
});

// Fallback search model
const searchFallbackModel = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-lite',
    // @ts-ignore - googleMaps exists in API but not in SDK types
    tools: [{ googleSearch: {} }, { googleMaps: {} }],
});



// JSON models for structured output (must support JSON mode)
const primaryJsonModel = genAI.getGenerativeModel({
    model: 'gemini-3-flash-preview',
    generationConfig: { responseMimeType: 'application/json' },
});

const fallbackJsonModel = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-lite',
    generationConfig: { responseMimeType: 'application/json' },
});

const SYSTEM_INSTRUCTIONS = `
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

function isRateLimitError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('429') ||
        message.includes('quota') ||
        message.includes('rate limit') ||
        message.includes('Resource has been exhausted');
}

function extractHtml(response: string): string {
    // Extract HTML from markdown code block
    const match = response.match(/```html\s*([\s\S]*?)```/);
    if (match) {
        return match[1].trim();
    }
    // If no code block, return as-is (might be raw HTML)
    return response.trim();
}

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
    /rastrear.*pessoa/i,
    /dox/i,

    // Adult/harmful content
    /pornograph/i,
    /nude.*generat/i,
    /deepfake/i,
    /gore/i,
    /self.?harm/i,
    /suicid/i,

    // Violence/weapons
    /bomb.*instruc/i,
    /weapon.*build/i,
    /how.*to.*kill/i,
    /como.*matar/i,
    /fabricar.*arma/i,
    /explosivo/i,

    // Scams
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

interface ContentValidationResult {
    allowed: boolean;
    reason?: string;
}

function validateContentRequest(text: string): ContentValidationResult {
    const lowerText = text.toLowerCase();

    // Check blocked patterns
    for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(text)) {
            console.log('[ContentFilter] Blocked pattern detected:', pattern.source);
            return {
                allowed: false,
                reason: t('contentBlockedReason')
            };
        }
    }

    // Check blocked keywords in context
    for (const keyword of BLOCKED_KEYWORDS) {
        if (lowerText.includes(keyword)) {
            // Check if it's in a harmful context (not just mentioning)
            const harmfulContexts = [
                'criar', 'make', 'build', 'gerar', 'generate', 'app', 'aplicativo',
                'programa', 'code', 'código'
            ];
            const hasHarmfulContext = harmfulContexts.some(ctx => lowerText.includes(ctx));
            if (hasHarmfulContext) {
                console.log('[ContentFilter] Blocked keyword in harmful context:', keyword);
                return {
                    allowed: false,
                    reason: t('contentBlockedReason')
                };
            }
        }
    }

    return { allowed: true };
}

// Export for testing
export { validateContentRequest };

// Helper for retry and timeout
async function runWithRetryAndTimeout<T>(
    operation: () => Promise<T>,
    options: {
        retries?: number;
        timeoutMs?: number;
        delayMs?: number;
        backoffFactor?: number;
        operationName?: string;
    } = {}
): Promise<T> {
    const {
        retries = 1,
        timeoutMs = 30000,
        delayMs = 1000,
        backoffFactor = 2,
        operationName = 'Operation'
    } = options;

    let lastError: any;
    let currentDelay = delayMs;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            // Create a timeout promise
            let timeoutHandle: NodeJS.Timeout;
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    reject(new Error(`${operationName} timed out after ${timeoutMs} ms`));
                }, timeoutMs);
            });

            // Race the operation against the timeout
            const result = await Promise.race([
                operation().finally(() => clearTimeout(timeoutHandle)),
                timeoutPromise
            ]);

            return result;
        } catch (error) {
            lastError = error;
            const isLastAttempt = attempt === retries;

            if (isLastAttempt) {
                console.error(`${operationName} failed after ${retries + 1} attempts.Last error: `, error);
                throw error;
            }

            console.warn(`${operationName} failed attempt ${attempt + 1}/${retries + 1}. Retrying in ${currentDelay}ms... Error:`, error);

            // Wait for delay
            await new Promise(resolve => setTimeout(resolve, currentDelay));
            currentDelay *= backoffFactor;
        }
    }

    throw lastError;
}

export interface GenerationResult {
    text: string;
    usage: {
        promptTokens: number;
        responseTokens: number;
        totalTokens: number;
    };
}

function getUsage(result: any): { promptTokens: number; responseTokens: number; totalTokens: number } {
    const usage = result.response.usageMetadata;
    return {
        promptTokens: usage?.promptTokenCount || 0,
        responseTokens: usage?.candidatesTokenCount || 0,
        totalTokens: usage?.totalTokenCount || 0,
    };
}

// ... helper updates ...

export async function generateApp(description: string): Promise<GenerationResult> {
    // Content moderation check
    const validation = validateContentRequest(description);
    if (!validation.allowed) {
        throw new Error(validation.reason || t('requestBlocked'));
    }

    const prompt = `Create a single-file HTML application (including CSS and JS inside <style> and <script> tags) that does the following: ${description}.

IMPORTANT LANGUAGE RULE: Generate the app's user interface (labels, buttons, messages, placeholder texts) in THE SAME LANGUAGE as the user's description above. If the description is in Portuguese, make the UI in Portuguese. If in Spanish, make it in Spanish. And so on.

Reflect about the app and try to elaborate the instructions to improve based on the user needs.
Choose a creative, short and original name for the app based on the description and your reflection.

${SYSTEM_INSTRUCTIONS}

Return ONLY the HTML code wrapped in a markdown code block \`\`\`html ... \`\`\`.`;

    const runModelCall = async (model: any) => {
        const result = await model.generateContent(prompt);
        return {
            text: extractHtml(result.response.text()),
            usage: getUsage(result)
        };
    };

    try {
        return await runWithRetryAndTimeout(
            () => runModelCall(primaryModel),
            { operationName: 'generateApp (Primary)' }
        );
    } catch (error) {
        if (isRateLimitError(error)) {
            console.log('Rate limit hit, trying fallback model...');
            return await runWithRetryAndTimeout(
                () => runModelCall(fallbackModel),
                { operationName: 'generateApp (Fallback)' }
            );
        }
        throw error;
    }
}

interface Patch {
    startLine: number;
    endLine: number;
    content: string;
}

function applyPatches(sourceCode: string, patches: Patch[]): string {
    // Normalize source to LF and split into lines
    let lines = sourceCode.replace(/\r\n/g, '\n').split('\n');

    // Sort patches descending by startLine to prevent index shifts affecting subsequent patches
    const sortedPatches = [...patches].sort((a, b) => b.startLine - a.startLine);

    for (const patch of sortedPatches) {
        // Validate bounds
        if (patch.startLine < 1 || patch.endLine > lines.length || patch.startLine > patch.endLine) {
            console.warn(`[applyPatches] Invalid range ${patch.startLine}-${patch.endLine} for ${lines.length} lines. Skipping.`);
            continue;
        }

        const startIndex = patch.startLine - 1; // 0-based
        const deleteCount = (patch.endLine - patch.startLine) + 1;

        // Handle content: if empty string and intent is delete, simple split gives [""] (one empty line).
        // This is generally fine (leaves a blank line).
        const newLines = patch.content.replace(/\r\n/g, '\n').split('\n');

        // Special case: if content is exactly empty string, do we delete lines entirely?
        // Let's assume yes if the result of split is just [""] and user asked for empty content?
        // Actually, let's just trust splice. [""] means replacing range with a blank line.

        lines.splice(startIndex, deleteCount, ...newLines);
    }

    return lines.join('\n');
}

const SMART_PATCH_INSTRUCTIONS = `
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

export async function editApp(currentCode: string, instructions: string): Promise<GenerationResult> {
    // Content moderation check
    const validation = validateContentRequest(instructions);
    if (!validation.allowed) {
        throw new Error(validation.reason || t('requestBlocked'));
    }

    // Prepare numbered code for context
    const codeLines = currentCode.replace(/\r\n/g, '\n').split('\n');
    const numberedCode = codeLines.map((line, i) => `${i + 1}| ${line}`).join('\n');

    // 1. Try Smart Patch (Line-Based JSON) with Retry Loop
    const basePatchPrompt = `Here is an existing HTML application with line numbers:

\`\`\`html
${numberedCode}
\`\`\`

User instructions: ${instructions}

${SMART_PATCH_INSTRUCTIONS}
`;

    let lastError: any;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const currentPrompt = attempt === 1
                ? basePatchPrompt
                : `${basePatchPrompt}\n\nIMPORTANT: The previous attempt failed with error: "${lastError?.message || lastError}".\nPlease correct the JSON structure or Line Numbers to resolve this error.`;

            const runPatchParams = async (model: any) => {
                const result = await model.generateContent(currentPrompt);
                const text = result.response.text();
                // With JSON mode, the response should be pure JSON
                const data = JSON.parse(text) as { changes: Patch[] };

                console.log(`[editApp] Attempt ${attempt}: Generated ${data.changes.length} patches.`);

                // Apply patches
                const patchedCode = applyPatches(currentCode, data.changes);

                return {
                    text: patchedCode,
                    usage: getUsage(result)
                };
            };

            // Try primary JSON model, fallback to secondary
            try {
                return await runWithRetryAndTimeout(
                    () => runPatchParams(primaryJsonModel),
                    { operationName: `editApp (Primary Attempt ${attempt})`, retries: 1, timeoutMs: 30000 }
                );
            } catch (primaryError) {
                console.warn(`[editApp] Primary model failed, trying fallback...`, primaryError);
                return await runWithRetryAndTimeout(
                    () => runPatchParams(fallbackJsonModel),
                    { operationName: `editApp (Fallback Attempt ${attempt})`, retries: 1, timeoutMs: 30000 }
                );
            }

        } catch (error) {
            console.warn(`[editApp] Attempt ${attempt} failed:`, error);
            lastError = error;
            if (isRateLimitError(error)) throw error;
        }
    }

    throw new Error(`Failed to edit app. Please try again with clearer instructions. Error: ${lastError?.message || lastError}`);
}



export async function editAppWithContext(
    currentCode: string,
    instructions: string,
    selectedContext: string,
    previousEdits: { version: number; instruction: string | null }[]
): Promise<GenerationResult> {
    // Content moderation check
    const validation = validateContentRequest(instructions);
    if (!validation.allowed) {
        throw new Error(validation.reason || t('requestBlocked'));
    }

    // Prepare numbered code for context
    // Normalize to LF first to ensure consistent line numbering
    const normalizedCode = currentCode.replace(/\r\n/g, '\n');
    const codeLines = normalizedCode.split('\n');
    const numberedCode = codeLines.map((line, i) => `${i + 1}| ${line}`).join('\n');

    const historyContext = previousEdits.length > 0
        ? `
IMPORTANT - Previous edits made to this app(DO NOT UNDO these changes):
${previousEdits.map(e => `- v${e.version}: ${e.instruction}`).join('\n')}
Make sure your new edit PRESERVES all the functionality and changes from previous versions.
`
        : '';

    const selectionPart = selectedContext
        ? `
The user selected this specific part of the code (Focus your edits here):
"""
${selectedContext}
"""
`
        : '';

    // 1. Try Smart Patch (Line-Based JSON) with Retry Loop
    const basePatchPrompt = `Here is an existing HTML application with line numbers:

\`\`\`html
${numberedCode}
\`\`\`

${historyContext}
${selectionPart}

User instructions: ${instructions}

${SMART_PATCH_INSTRUCTIONS}
`;

    let lastError: any;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const currentPrompt = attempt === 1
                ? basePatchPrompt
                : `${basePatchPrompt}\n\nIMPORTANT: The previous attempt failed with error: "${lastError?.message || lastError}".\nPlease correct the JSON structure or Line Numbers to resolve this error.`;

            const runPatchParams = async (model: any) => {
                const result = await model.generateContent(currentPrompt);
                const text = result.response.text();
                // With JSON mode, the response should be pure JSON
                const data = JSON.parse(text) as { changes: Patch[] };

                console.log(`[editAppWithContext] Attempt ${attempt}: Generated ${data.changes.length} patches.`);

                // Apply patches against the normalized code (as applyPatches expects)
                const patchedCode = applyPatches(normalizedCode, data.changes);

                return {
                    text: patchedCode,
                    usage: getUsage(result)
                };
            };

            // Try primary JSON model, fallback to secondary
            try {
                return await runWithRetryAndTimeout(
                    () => runPatchParams(primaryJsonModel),
                    { operationName: `editAppWithContext (Primary Attempt ${attempt})` }
                );
            } catch (primaryError) {
                console.warn(`[editAppWithContext] Primary model failed, trying fallback...`, primaryError);
                return await runWithRetryAndTimeout(
                    () => runPatchParams(fallbackJsonModel),
                    { operationName: `editAppWithContext (Fallback Attempt ${attempt})` }
                );
            }
        } catch (error) {
            console.warn(`[editAppWithContext] Attempt ${attempt} failed:`, error);
            lastError = error;
            if (isRateLimitError(error)) throw error;
        }
    }

    throw new Error(`Failed to edit app with context. Please try again. Error: ${lastError?.message || lastError}`);
}


// AI functions for WebView bridge
export async function aiGenerateText(prompt: string): Promise<string> {
    // Legacy/Bridge wrapper needed? No, we should update this too or wrap it.
    // The bridge expects string. We can keep this returning string for simplicity, OR update bridge.
    // Bridge uses: `aiGenerate` which calls this.
    // Let's update `aiGenerate` to handle costs in `Bridge`?
    // Actually, `aiGenerate` is used by `AppRunner`.
    // Let's keep these returning strings for now IF NOT USED BY STORE directly?
    // `store.ts` uses `generateApp` and `editApp`.
    // `AppRunner` uses `aiGenerate`. We need to handle cost there too.

    const runModelCall = async (model: any) => {
        const result = await model.generateContent(prompt);
        return result.response.text();
    };

    try {
        return await runWithRetryAndTimeout(
            () => runModelCall(fallbackModel),
            { operationName: 'aiGenerateText (Fallback)' }
        );
    } catch (error) {
        if (isRateLimitError(error)) {
            console.log('Rate limit hit, trying primary model...');
            return await runWithRetryAndTimeout(
                () => runModelCall(primaryModel),
                { operationName: 'aiGenerateText (Primary)' }
            );
        }
        throw error;
    }
}

// ... keeping other image funcs as string for now, will update `aiGenerate` ...

export async function aiGenerate(options: AIGenerateOptions): Promise<{ text: string, usage: any }> {
    console.log('[Gemini] aiGenerate called. Options:', JSON.stringify({ ...options, image: options.image ? '<base64>' : null, audio: options.audio ? '<base64>' : null }));
    const { prompt, search, schema, image, audio } = options;
    const schemaJson = schema ? JSON.stringify(schema) : null;

    // Helper to run model call with timeout/retry and fallback
    const runModel = async (model: any, fallbackModel: any | null, args: any, name: string) => {
        const runCall = async (m: any, opName: string) => {
            return runWithRetryAndTimeout(async () => {
                const result = await m.generateContent(args);
                return {
                    text: result.response.text(),
                    usage: getUsage(result)
                };
            }, { operationName: opName });
        };

        try {
            return await runCall(model, name);
        } catch (error) {
            if (fallbackModel && isRateLimitError(error)) {
                console.log(`[Gemini] Rate limit hit for ${name}, using fallback...`);
                return await runCall(fallbackModel, `${name} (Fallback)`);
            }
            throw error;
        }
    };

    // Note: I'm refactoring all returns inside aiGenerate to use runModel and return object

    // ===== Audio-based flows =====
    if (audio) {
        const cleanBase64 = audio.replace(/^data:audio\/[^;]+;base64,/, '');
        let mimeType = 'audio/webm';
        const mimeMatch = audio.match(/^data:(audio\/[^;]+);base64,/);
        if (mimeMatch) mimeType = mimeMatch[1];
        const audioData = { inlineData: { mimeType, data: cleanBase64 } };

        if (schemaJson) {
            const extractPrompt = search
                ? `Transcribe this audio. Use Google Search to enrich the content with context. Then extract structured data.\n${prompt || ''}\n\nExpected JSON schema: ${schemaJson}\nReturn only valid JSON matching the schema.`
                : `Transcribe this audio and extract structured data.\n${prompt || ''}\n\nExpected JSON schema: ${schemaJson}\nReturn only valid JSON matching the schema.`;

            if (search) {
                return runModel(searchModel, searchFallbackModel, [audioData, extractPrompt], 'aiGenerate: Audio+Schema+Search');
            }
            return runModel(primaryJsonModel, fallbackJsonModel, [audioData, extractPrompt], 'aiGenerate: Audio+Schema');
        }

        if (search) {
            const searchPrompt = `Transcribe this audio. Use Google Search to find relevant information about the content. ${prompt || 'Provide detailed context.'}`;
            return runModel(searchModel, searchFallbackModel, [audioData, searchPrompt], 'aiGenerate: Audio+Search');
        }

        const transcribePrompt = prompt || 'Transcribe this audio to text. Return only the transcription.';
        return runModel(primaryModel, fallbackModel, [audioData, transcribePrompt], 'aiGenerate: Audio');
    }

    // ===== Image-based flows =====
    if (image) {
        const cleanBase64 = image.replace(/^data:image\/[^;]+;base64,/, '');
        const imageData = { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } };

        if (schemaJson) {
            const extractPrompt = search
                ? `Analyze this image. Use Google Search to find more information about what you see. Then extract structured data.\n${prompt || ''}\n\nExpected JSON schema: ${schemaJson}\nReturn only valid JSON matching the schema.`
                : `Analyze this image and extract structured data.\n${prompt || ''}\n\nExpected JSON schema: ${schemaJson}\nReturn only valid JSON matching the schema.`;

            if (search) {
                return runModel(searchModel, searchFallbackModel, [imageData, extractPrompt], 'aiGenerate: Image+Schema+Search');
            }
            return runModel(primaryJsonModel, fallbackJsonModel, [imageData, extractPrompt], 'aiGenerate: Image+Schema');
        }

        if (search) {
            const searchPrompt = `Analyze this image. Use Google Search to find relevant information about what you see. ${prompt || 'Provide detailed context.'}`;
            return runModel(searchModel, searchFallbackModel, [imageData, searchPrompt], 'aiGenerate: Image+Search');
        }

        // Simple describe wrap
        return runModel(primaryModel, fallbackModel, [imageData, prompt || 'Describe this image in detail.'], 'aiGenerate: Image');
    }

    // ===== Text-based flows =====

    if (schemaJson && search) {
        const combinedPrompt = `Use Google Search to find information about: ${prompt || ''}\n\nThen extract structured data matching this JSON schema: ${schemaJson}\nReturn only valid JSON.`;
        return runModel(searchModel, searchFallbackModel, combinedPrompt, 'aiGenerate: Schema+Search');
    }

    if (schemaJson) {
        // aiExtractStructuredData returns string, need to wrap or modify it too
        // For simplicity, let's just use runModel here directly
        const extractPrompt = `Extract structured data from this text: "${prompt}"\n\nExpected JSON schema: ${schemaJson}\n\nReturn only the extracted data as valid JSON matching the schema.`;
        return runModel(primaryJsonModel, fallbackJsonModel, extractPrompt, 'aiGenerate: Schema');
    }

    if (search) {
        // aiGenerateTextWithSearch returns string.
        // Let's reimplement call here to get usage
        const searchPrompt = `Use o Google Search para buscar informações atuais e relevantes para responder: ${prompt}`;
        return runModel(searchModel, searchFallbackModel, searchPrompt, 'aiGenerate: Search');
    }

    return runModel(primaryModel, fallbackModel, prompt || '', 'aiGenerate: Text');
}

/**
 * Convert a Node/TypeScript project source code to standalone HTML webapp
 */
export async function convertNodeProject(sourceCode: string, frameworkHint: string): Promise<GenerationResult> {
    const prompt = `You are a code conversion expert. Convert the following ${frameworkHint} project source code into a SINGLE standalone HTML file that works in a WebView.

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

${SYSTEM_INSTRUCTIONS}

SOURCE CODE TO CONVERT:
${sourceCode}

Return ONLY the complete HTML code wrapped in \`\`\`html ... \`\`\`.
The HTML must be fully functional and self-contained.`;

    const runModelCall = async (model: any) => {
        const result = await model.generateContent(prompt);
        return {
            text: extractHtml(result.response.text()),
            usage: getUsage(result)
        };
    };

    try {
        return await runWithRetryAndTimeout(
            () => runModelCall(primaryModel),
            { operationName: 'convertNodeProject (Primary)' }
        );
    } catch (error) {
        if (isRateLimitError(error)) {
            console.log('Rate limit hit, trying fallback model for project conversion...');
            return await runWithRetryAndTimeout(
                () => runModelCall(fallbackModel),
                { operationName: 'convertNodeProject (Fallback)' }
            );
        }
        throw error;
    }
}

/**
 * Unified AI generate function that handles all options from the fluent builder
 */
export interface AIGenerateOptions {
    prompt?: string | null;
    search?: boolean;
    schema?: object | null;
    image?: string | null;
    audio?: string | null;
}




// Helper for JSON model calls
async function callJsonModel(prompt: string): Promise<string> {
    const runCall = async (model: any) => {
        const result = await model.generateContent(prompt);
        return result.response.text();
    };

    try {
        return await runWithRetryAndTimeout(
            () => runCall(fallbackJsonModel),
            { operationName: 'callJsonModel (Fallback)' }
        );
    } catch (error) {
        if (isRateLimitError(error)) {
            return await runWithRetryAndTimeout(
                () => runCall(primaryJsonModel),
                { operationName: 'callJsonModel (Primary)' }
            );
        }
        throw error;
    }
}

