import { GoogleGenerativeAI } from '@google/generative-ai';

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
    tools: [{ googleSearch: {} }, { googleMaps: {} }],
});

// Fallback search model
const searchFallbackModel = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-lite',
    tools: [{ googleSearch: {} }, { googleMaps: {} }],
});

// Audio transcription models
const audioModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
const audioFallbackModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

// JSON models for structured output
const primaryJsonModel = genAI.getGenerativeModel({
    model: 'gemini-3-flash-preview',
    generationConfig: { responseMimeType: 'application/json' },
});

const fallbackJsonModel = genAI.getGenerativeModel({
    model: 'gemma-3-27b-it',
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

📅 CALENDAR INTEGRATION (Use AppacadabraCalendar API only when necessary to schedule events in calendar):
- AppacadabraCalendar.createEvent(title, description, startTimeMs, endTimeMs, callback) - Opens native Calendar app with pre-filled details.
- AppacadabraCalendar.createEventWithReminder(title, description, startMs, endMs, reminderMinutes, callback) - Opens native Calendar with reminder.

IMPORTANT: startTimeMs and endTimeMs must be Unix timestamps in MILLISECONDS (not seconds).
How to create timestamps in JavaScript:
  const startMs = new Date(2024, 0, 15, 14, 30).getTime(); // Jan 15, 2024 at 2:30 PM
  const endMs = new Date(2024, 0, 15, 15, 30).getTime();   // Jan 15, 2024 at 3:30 PM

🔔 NOTIFICATION API (AppacadabraNotify API only when necessary to schedule user notifications outside the app):
- AppacadabraNotify.showNow(title, message, callback) - Show notification immediately
- AppacadabraNotify.scheduleNotification(title, message, delayMinutes, callback) - Schedule notification

🤖 AI API (AppacadabraAI) - use when there it should be better than deterministic approaches:
1. AppacadabraAI.generateText(prompt, callbackName) - Generate text without search (priorize it)
2. AppacadabraAI.generateTextWithSearch(prompt, callbackName) - Generate with web or maps search
3. AppacadabraAI.describeImage(base64, prompt, callbackName) - Describe image
4. AppacadabraAI.transcribeAudio(base64, callbackName) - Transcribe audio
5. AppacadabraAI.extractStructuredData(text, schema, callbackName) - Extract structured JSON data (priorize it)

⚠️ IMPORTANT: All callbacks must be GLOBAL FUNCTIONS referenced by NAME (string).
Example:
  window.handleResult = function(success, data) {
    if (success) console.log(data);
  };
  AppacadabraAI.generateText("Hello", "handleResult");

All callbacks receive: function(success: boolean, result: string)
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

export async function generateApp(description: string): Promise<string> {
    const prompt = `Create a single-file HTML application (including CSS and JS inside <style> and <script> tags) that does the following: ${description}.

    Reflect about the app and try to elaborate de instructions to improve based on the user needs.

${SYSTEM_INSTRUCTIONS}

Return ONLY the HTML code wrapped in a markdown code block \`\`\`html ... \`\`\`.`;

    try {
        const result = await primaryModel.generateContent(prompt);
        const text = result.response.text();
        return extractHtml(text);
    } catch (error) {
        if (isRateLimitError(error)) {
            console.log('Rate limit hit, trying fallback model...');
            const result = await fallbackModel.generateContent(prompt);
            const text = result.response.text();
            return extractHtml(text);
        }
        throw error;
    }
}

export async function editApp(currentCode: string, instructions: string): Promise<string> {
    const prompt = `Here is an existing HTML application:

\`\`\`html
${currentCode}
\`\`\`

Please modify it according to these instructions: ${instructions}

${SYSTEM_INSTRUCTIONS}

Return the full updated single-file HTML code. Wrap it in \`\`\`html ... \`\`\`.`;

    try {
        const result = await primaryModel.generateContent(prompt);
        const text = result.response.text();
        return extractHtml(text);
    } catch (error) {
        if (isRateLimitError(error)) {
            console.log('Rate limit hit, trying fallback model...');
            const result = await fallbackModel.generateContent(prompt);
            const text = result.response.text();
            return extractHtml(text);
        }
        throw error;
    }
}

export async function editAppWithContext(
    currentCode: string,
    instructions: string,
    selectedContext: string,
    previousEdits: { version: number; instruction: string | null }[]
): Promise<string> {
    const historyContext = previousEdits.length > 0
        ? `
IMPORTANT - Previous edits made to this app (DO NOT UNDO these changes):
${previousEdits.map(e => `- v${e.version}: ${e.instruction}`).join('\n')}

Make sure your new edit PRESERVES all the functionality and changes from previous versions.
`
        : '';

    const selectionPart = selectedContext
        ? `The user selected this specific part of the code:
"${selectedContext}"

Please modify ONLY this selected part according to the user's instructions: ${instructions}`
        : `Please modify it according to these instructions: ${instructions}`;

    const prompt = `Here is an HTML application:

\`\`\`html
${currentCode}
\`\`\`
${historyContext}
${selectionPart}

Return the COMPLETE updated HTML code with the modifications. Wrap it in \`\`\`html ... \`\`\`.`;

    try {
        const result = await primaryModel.generateContent(prompt);
        const text = result.response.text();
        return extractHtml(text);
    } catch (error) {
        if (isRateLimitError(error)) {
            console.log('Rate limit hit, trying fallback model...');
            const result = await fallbackModel.generateContent(prompt);
            const text = result.response.text();
            return extractHtml(text);
        }
        throw error;
    }
}

// AI functions for WebView bridge
export async function aiGenerateText(prompt: string): Promise<string> {
    try {
        const result = await fallbackModel.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        if (isRateLimitError(error)) {
            console.log('Rate limit hit, trying primary model...');
            const result = await primaryModel.generateContent(prompt);
            return result.response.text();
        }
        throw error;
    }
}

export async function aiDescribeImage(base64Image: string, prompt: string): Promise<string> {
    const cleanBase64 = base64Image
        .replace(/^data:image\/[^;]+;base64,/, '');

    try {
        const result = await fallbackModel.generateContent([
            {
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: cleanBase64,
                },
            },
            prompt || 'Describe this image in detail.',
        ]);
        return result.response.text();
    } catch (error) {
        if (isRateLimitError(error)) {
            console.log('Rate limit hit, trying primary model for image...');
            const result = await primaryModel.generateContent([
                {
                    inlineData: {
                        mimeType: 'image/jpeg',
                        data: cleanBase64,
                    },
                },
                prompt || 'Describe this image in detail.',
            ]);
            return result.response.text();
        }
        throw error;
    }
}

export async function aiTranscribeAudio(base64Audio: string): Promise<string> {
    // Clean base64 prefix if present (e.g., data:audio/webm;base64,)
    const cleanBase64 = base64Audio
        .replace(/^data:audio\/[^;]+;base64,/, '');

    // Detect mime type from prefix or default to webm
    let mimeType = 'audio/webm';
    const mimeMatch = base64Audio.match(/^data:(audio\/[^;]+);base64,/);
    if (mimeMatch) {
        mimeType = mimeMatch[1];
    }

    try {
        const result = await audioModel.generateContent([
            {
                inlineData: {
                    mimeType: mimeType,
                    data: cleanBase64,
                },
            },
            'Transcribe this audio to text. Return only the transcription, no additional commentary.',
        ]);
        return result.response.text();
    } catch (error) {
        if (isRateLimitError(error)) {
            console.log('Rate limit hit, trying audio fallback model...');
            const result = await audioFallbackModel.generateContent([
                {
                    inlineData: {
                        mimeType: mimeType,
                        data: cleanBase64,
                    },
                },
                'Transcribe this audio to text. Return only the transcription, no additional commentary.',
            ]);
            return result.response.text();
        }
        throw error;
    }
}

export async function aiExtractStructuredData(text: string, schemaJson: string): Promise<string> {
    const prompt = `Extract structured data from this text: "${text}"

Expected JSON schema: ${schemaJson}

Return only the extracted data as valid JSON matching the schema.
If information is missing, use null or empty string.`;

    try {
        const result = await fallbackJsonModel.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        if (isRateLimitError(error)) {
            console.log('Rate limit hit, trying primary model for structured data...');
            const result = await primaryJsonModel.generateContent(prompt);
            return result.response.text();
        }
        throw error;
    }
}

export async function aiGenerateTextWithSearch(prompt: string): Promise<string> {
    try {
        const result = await searchModel.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        if (isRateLimitError(error)) {
            console.log('Rate limit hit on search, trying fallback search model...');
            const result = await searchFallbackModel.generateContent(prompt);
            return result.response.text();
        }
        console.error('AI Search Error:', error);
        throw error;
    }
}

/**
 * Convert a Node/TypeScript project source code to standalone HTML webapp
 */
export async function convertNodeProject(sourceCode: string, frameworkHint: string): Promise<string> {
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

    try {
        const result = await primaryModel.generateContent(prompt);
        const text = result.response.text();
        return extractHtml(text);
    } catch (error) {
        if (isRateLimitError(error)) {
            console.log('Rate limit hit, trying fallback model for project conversion...');
            const result = await fallbackModel.generateContent(prompt);
            const text = result.response.text();
            return extractHtml(text);
        }
        throw error;
    }
}

