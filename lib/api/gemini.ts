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

🤖 AI API (AppacadabraAI) - Fluent Builder Pattern:
Use encadeamento para configurar e chamar:

  AppacadabraAI.generate(prompt, callback)                    // Geração básica de texto
  AppacadabraAI.withSearch().generate(prompt, callback)       // Busca na web/maps + texto
  AppacadabraAI.withSchema(schema).generate(text, callback)   // Extração de JSON estruturado
  AppacadabraAI.fromImage(base64).generate(prompt, callback)  // Análise/descrição de imagem
  AppacadabraAI.fromAudio(base64).generate(callback)          // Transcrição de áudio

Combinações avançadas (podem ser encadeadas):
  AppacadabraAI.withSchema(schema).withSearch().generate(prompt, callback)         // Busca → JSON
  AppacadabraAI.fromImage(base64).withSearch().withSchema(schema).generate(prompt, callback) // Imagem + Web → JSON
  AppacadabraAI.fromAudio(base64).withSearch().withSchema(schema).generate(prompt, callback) // Audio + Web → JSON

Exemplos de schema: { name: "", age: 0, items: [] }

⚠️ IMPORTANT: All callbacks must be GLOBAL FUNCTIONS referenced by NAME (string).
Example:
  window.handleResult = function(success, data) {
    if (success) console.log(data);
  };
  AppacadabraAI.generate("Hello", "handleResult");

All callbacks receive: function(success: boolean, result: string)

📤 SHARE API (AppacadabraShare):
  AppacadabraShare.share(text, url, callback)              // Compartilhar texto/URL
  AppacadabraShare.shareFile(base64, mimeType, filename, callback) // Compartilhar arquivo

📇 CONTACTS API (AppacadabraContacts):
  AppacadabraContacts.getAll(callback)                     // Listar contatos (retorna JSON)
  AppacadabraContacts.search(query, callback)              // Buscar contatos por nome/telefone/email
  AppacadabraContacts.add({name, phone, email}, callback)  // Adicionar contato

🔐 BIOMETRICS API (AppacadabraBiometrics):
  AppacadabraBiometrics.isAvailable(callback)              // Verifica suporte (retorna JSON)
  AppacadabraBiometrics.authenticate(reason, callback)     // Autenticar (Face ID/Touch ID/Fingerprint)

🔑 AUTH API (AppacadabraAuth):
  AppacadabraAuth.openAuthURL(authUrl, redirectUrl, callback) // Abre URL de OAuth no browser

📱 SENSORS API (AppacadabraSensors):
  AppacadabraSensors.startAccelerometer(intervalMs, callback) // Inicia acelerômetro (callback contínuo)
  AppacadabraSensors.startGyroscope(intervalMs, callback)     // Inicia giroscópio (callback contínuo)
  AppacadabraSensors.startMagnetometer(intervalMs, callback)  // Bússola: retorna {x, y, z, heading}
  AppacadabraSensors.stopAccelerometer()                      // Para acelerômetro
  AppacadabraSensors.stopGyroscope()                          // Para giroscópio
  AppacadabraSensors.stopMagnetometer()                       // Para magnetômetro
  AppacadabraSensors.stopAll()                                // Para todos os sensores
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
    Choose a creative, small and original name for the app based on the description and your reflection.
    

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
    // Add instruction to use Google Search for current/real-time information
    const searchPrompt = `Use o Google Search para buscar informações atuais e relevantes para responder: ${prompt}`;

    try {
        console.log('Search: calling searchModel with prompt length:', searchPrompt.length);
        const result = await searchModel.generateContent(searchPrompt);

        // Debug: log response structure
        console.log('Search: response received');
        console.log('Search: candidates count:', result.response.candidates?.length || 0);
        console.log('Search: finish reason:', result.response.candidates?.[0]?.finishReason);
        console.log('Search: promptFeedback:', JSON.stringify(result.response.promptFeedback));

        const text = result.response.text();
        console.log('Search: result text length:', text.length);

        if (!text || text.trim() === '') {
            console.log('Search: Empty result, trying fallback model...');
            const fallbackResult = await searchFallbackModel.generateContent(searchPrompt);
            const fallbackText = fallbackResult.response.text();
            console.log('Search fallback: result length:', fallbackText.length);
            return fallbackText;
        }
        return text;
    } catch (error) {
        console.error('AI Search Error:', error);
        if (isRateLimitError(error)) {
            console.log('Search: Rate limit hit, trying fallback search model...');
            const result = await searchFallbackModel.generateContent(searchPrompt);
            return result.response.text();
        }
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

export async function aiGenerate(options: AIGenerateOptions): Promise<string> {
    const { prompt, search, schema, image, audio } = options;
    const schemaJson = schema ? JSON.stringify(schema) : null;

    // ===== Audio-based flows (1 call - model handles transcription + processing) =====
    if (audio) {
        const cleanBase64 = audio.replace(/^data:audio\/[^;]+;base64,/, '');
        let mimeType = 'audio/webm';
        const mimeMatch = audio.match(/^data:(audio\/[^;]+);base64,/);
        if (mimeMatch) mimeType = mimeMatch[1];
        const audioData = { inlineData: { mimeType, data: cleanBase64 } };

        // Audio + Schema (with or without search): transcribe and extract JSON in one call
        if (schemaJson) {
            const extractPrompt = search
                ? `Transcribe this audio. Use Google Search to enrich the content with context. Then extract structured data.\n${prompt || ''}\n\nExpected JSON schema: ${schemaJson}\nReturn only valid JSON matching the schema.`
                : `Transcribe this audio and extract structured data.\n${prompt || ''}\n\nExpected JSON schema: ${schemaJson}\nReturn only valid JSON matching the schema.`;

            if (search) {
                const result = await searchModel.generateContent([audioData, extractPrompt]);
                return result.response.text();
            }
            const result = await primaryJsonModel.generateContent([audioData, extractPrompt]);
            return result.response.text();
        }

        // Audio + Search: transcribe with web context in one call
        if (search) {
            const searchPrompt = `Transcribe this audio. Use Google Search to find relevant information about the content. ${prompt || 'Provide detailed context.'}`;
            const result = await searchModel.generateContent([audioData, searchPrompt]);
            return result.response.text();
        }

        // Audio only: just transcribe (1 call)
        const transcribePrompt = prompt || 'Transcribe this audio to text. Return only the transcription.';
        const result = await primaryModel.generateContent([audioData, transcribePrompt]);
        return result.response.text();
    }

    // ===== Image-based flows =====
    if (image) {
        const cleanBase64 = image.replace(/^data:image\/[^;]+;base64,/, '');
        const imageData = { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } };

        // Image + Schema (with or without search): describe and extract JSON in one call
        if (schemaJson) {
            const extractPrompt = search
                ? `Analyze this image. Use Google Search to find more information about what you see. Then extract structured data.\n${prompt || ''}\n\nExpected JSON schema: ${schemaJson}\nReturn only valid JSON matching the schema.`
                : `Analyze this image and extract structured data.\n${prompt || ''}\n\nExpected JSON schema: ${schemaJson}\nReturn only valid JSON matching the schema.`;

            if (search) {
                const result = await searchModel.generateContent([imageData, extractPrompt]);
                return result.response.text();
            }
            const result = await primaryJsonModel.generateContent([imageData, extractPrompt]);
            return result.response.text();
        }

        // Image + Search: describe with web context in one call
        if (search) {
            const searchPrompt = `Analyze this image. Use Google Search to find relevant information about what you see. ${prompt || 'Provide detailed context.'}`;
            const result = await searchModel.generateContent([imageData, searchPrompt]);
            return result.response.text();
        }

        // Image only: just describe (1 call)
        return await aiDescribeImage(image, prompt || 'Describe this image in detail.');
    }

    // ===== Text-based flows =====

    // Schema + Search: search and extract JSON in one call using search model with JSON instruction
    if (schemaJson && search) {
        const combinedPrompt = `Use Google Search to find information about: ${prompt || ''}\n\nThen extract structured data matching this JSON schema: ${schemaJson}\nReturn only valid JSON.`;
        const result = await searchModel.generateContent(combinedPrompt);
        return result.response.text();
    }

    // Schema only: extract structured data (1 call)
    if (schemaJson) {
        return await aiExtractStructuredData(prompt || '', schemaJson);
    }

    // Search only: generate with web search (1 call)
    if (search) {
        return await aiGenerateTextWithSearch(prompt || '');
    }

    // Basic text generation (1 call)
    return await aiGenerateText(prompt || '');
}

// Helper for JSON model calls
async function callJsonModel(prompt: string): Promise<string> {
    try {
        const result = await fallbackJsonModel.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        if (isRateLimitError(error)) {
            const result = await primaryJsonModel.generateContent(prompt);
            return result.response.text();
        }
        throw error;
    }
}

