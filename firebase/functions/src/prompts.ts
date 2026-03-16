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

⚠️ CRITICAL: CALLBACK PATTERN (READ CAREFULLY)
All Appacadabra API callbacks MUST be global functions on \`window\`.

✅ CORRECT PATTERN:
\`\`\`javascript
// 1. Define callback as global function FIRST always with 2 parameters: success (boolean) and resultString (string)
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
    - **Return**: JSON String of event objects \`[{id, title, startDate, endDate, allDay, location, notes, calendarId, calendarName, attendees: [{name, email, status, isCurrentUser}]}, ...]\`
- \`deleteEvent(eventId, callback)\`
    - **Return**: "Event deleted" (string)
- **Return for create**: "Calendar opened" (string)

🔔 NOTIFICATION (AppacadabraNotify) **Native Protection**: Auto-deduplicates identical title+body. Max 10 per app. Use \`id\` to update existing notification.
- \`showNow(title, msg, callback)\` - Show notification immediately
    - **Return**: Notification ID (string)
- \`schedule(title, msg, delayMinutes, callback, id?)\` - Schedule after delay
    - **Return**: Notification ID (string)
- \`scheduleAt(title, msg, timeMs, callback, id?)\` - Schedule at specific time
    - **Return**: Notification ID (string)
- \`getScheduled(callback)\` - List pending notifications
    - **Return**: JSON \`[{id, title, body, trigger: { type: "timeInterval"|"date", value: number }}]\` (value is seconds for interval, or timestamp for date)
- \`cancel(id, callback)\` - Cancel notification by ID
    - **Return**: "Cancelled" (string)
- \`cancelAll(callback)\` - Cancel all notifications from this app
    - **Return**: "All cancelled" (string)
- \`alert(message)\` - Show custom alert dialog (Promise<void>)
- \`confirm(message)\` - Show custom confirm dialog (Promise<boolean>)
- \`prompt(message, defaultValue)\` - Show custom prompt dialog (Promise<string|null>)

💪 HEALTH (AppacadabraHealth)
- \`getSteps(startMs, endMs, callback)\` - Get step count
    - **Return**: JSON Object: \`{ "totalSteps": number, "records": [{ "startTime": "ISO String", "endTime": "ISO String", "count": number }] }\`
- \`getHeartRate(startMs, endMs, callback)\` - Get heart rate
    - **Return**: JSON Array of objects: \`[{ "startTime": "ISO String", "endTime": "ISO String", "samples": [{ "time": "ISO String", "beatsPerMinute": number }] }]\`
- \`getExercise(startMs, endMs, callback)\` - Get exercise sessions. **Crucial**:
    - **Return**: JSON Array: \`[{ "startTime": "ISO", "endTime": "ISO", "exerciseTypeName": "ROWING"|"WALKING"|..., "exerciseType": number, "title": string|null (often null! use typeName), "notes": string|null, "metadata": {...} }]\`
    - **Note**: \`title\` is often null. Display \`exerciseTypeName\` as label. \`exerciseType\` 46 is "ROWING". Ignore internal metadata.
- \`getSleep(startMs, endMs, callback)\` - Get sleep sessions
    - **Return**: JSON Array of objects: \`[{ "startTime": "ISO String", "endTime": "ISO String", "title": string|null, "notes": string|null, "stages": [{ "startTime": "ISO String", "endTime": "ISO String", "stage": "AWAKE"|"LIGHT"|"DEEP"|"REM"|"UNKNOWN" }] }]\`
- \`getCalories(startMs, endMs, callback)\` - Get calories burned (Active + Basal)
    - **Return**: JSON Object: \`{ "totalCalories": number, "records": [{ "startTime": "ISO", "endTime": "ISO", "energy": { "inKilocalories": number } }] }\`

🤖 AI (AppacadabraAI)
- **Fluent Builder API**: Chain methods to configure AI generation.
- **Builder Methods** (chainable — call \`generate()\` last):
    - \`generate(prompt, callback)\`: Execute the AI request with the configured options.
    - \`withSearch()\`: Enable Google Search grounding for real-time info.
    - \`withSchema(jsonSchemaObj)\`: Force structured JSON output matching the schema.
    - \`fromImage(input)\`: Attach image(s) for vision analysis or image generation. Accepts a single Base64 string OR an array (up to 14). Typically the base64 comes from \`AppacadabraCamera.takePhoto()\`.
    - \`fromVideo(input)\`: Attach video(s) for analysis/summarization. Accepts a single Base64 string OR an array. Typically the base64 comes from \`AppacadabraCamera.recordVideo()\`.
    - \`fromAudio(input)\`: Attach audio(s) for transcription/analysis. Accepts a single Base64 string (from \`AppacadabraAudio.recordStop\`) OR an array.
    - \`generateVideo(prompt, callback)\`: Generate a video from text (standalone) OR animate up to 3 reference images (chained). Returns base64 MP4. When chained with \`fromImage\`, the first image becomes the starting frame and up to 2 additional images serve as style references. The callback receives \`(success, videoBase64, thumbnailBase64)\` — \`thumbnailBase64\` is always a JPEG base64: the first frame of the video when extraction succeeds, or a static dark placeholder with a play icon when it fails. Ready to use as an \`<img>\` preview while the video loads.
    - \`generateImage(prompt, callback)\`: Generate an image from text (standalone) OR edit/remix up to 14 input images (chained with \`fromImage\`). Returns base64 PNG.
    - **Standalone-only Methods** (NOT chainable — call directly on \`AppacadabraAI\`):
    - \`similarity(itemsArray, callback)\`: Compute semantic similarity between 2+ text strings. Returns a JSON object with a pairwise similarity \`matrix\` (values 0.0-1.0) and \`count\`.
- **Examples**:
    - Basic: \`AppacadabraAI.generate("Hello", callback)\`
    - Search: \`AppacadabraAI.withSearch().generate("Who won the game?", callback)\`
    - JSON: \`AppacadabraAI.withSchema({ type: "object", properties: { ... } }).generate("Extract data", callback)\`
    - Single image: \`AppacadabraAI.fromImage(base64).generate("Describe this", callback)\`
    - Multiple images: \`AppacadabraAI.fromImage([img1, img2, img3]).generate("Compare these images", callback)\`
    - Single video: \`AppacadabraAI.fromVideo(videoBase64).generate("Summarize this video", callback)\`
    - Single audio: \`AppacadabraAI.fromAudio(base64).generate("Transcribe this", callback)\`
    - Multiple audios: \`AppacadabraAI.fromAudio([audio1, audio2]).generate("Compare these recordings", callback)\`
    - *Chained*: \`AppacadabraAI.withSearch().withSchema(schema).generate("Find data...", callback)\`
    - Image Gen: \`AppacadabraAI.generateImage("A cute cat wearing a hat", "onImageReady")\`
    - Image edit (from takePhoto): \`AppacadabraAI.fromImage(photoBase64).generateImage("Make the sky purple", "onImageReady")\`
    - Image remix (multiple): \`AppacadabraAI.fromImage([img1, img2]).generateImage("Blend these styles", "onImageReady")\`
    - Video Gen: \`AppacadabraAI.generateVideo("A cinematic drone shot of a beach", "onVideoReady")\`
    - Image-to-video: \`AppacadabraAI.fromImage(photoBase64).generateVideo("Bring this photo to life with gentle movement", "onVideoReady")\`
    - Multi-image-to-video: \`AppacadabraAI.fromImage([img1, img2]).generateVideo("Animate blending these scenes", "onVideoReady")\`
    - Similarity (2 items): \`AppacadabraAI.similarity(["cat", "kitten"], "onResult")\` → \`{ matrix: [[1, 0.87], [0.87, 1]], vectors: [[0.1, ...], [0.12, ...]], count: 2 }\`
    - Similarity (3+ items): \`AppacadabraAI.similarity(["dog", "puppy", "car"], "onResult")\` → \`{ matrix: [[1, 0.91, 0.12], [0.91, 1, 0.10], [0.12, 0.10, 1]], vectors: [...], count: 3 }\`
- **Return (generate)**: Generated text (string). If \`withSchema\` is used, result is a JSON string.
- **Return (generateImage)**: Complete DataURI string (e.g. \`data:image/png;base64,...\`). Use directly as img src (do NOT append prefixes manually).
- **Return (generateVideo)**: Callback receives \`(success, videoDataUri, thumbnailDataUri)\`. Use directly as src. Example: \`function onVideoReady(ok, videoUri, thumbUri) { if (thumbUri) img.src = thumbUri; vid.src = videoUri; }\`
- **Return (similarity)**: JSON string \`{ matrix: number[][], vectors: number[][], count: number }\`. \`matrix\` = pairwise cosine similarity (symmetric, 1.0 on diagonal, 0.0-1.0). \`vectors\` = raw embedding arrays (optional, for advanced use like caching or custom distance).

📤 SHARE (AppacadabraShare)
- \`share(text, url, callback)\`
- \`shareFile(base64, mimeType, filename, callback)\`
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
- **IMPORTANT**: All sensor callbacks must be GLOBAL function names (strings).
- \`startAccelerometer(intervalMs, callbackName)\`
    - **Callback**: Global function name (string).
    - **Data**: \`{ "x": number, "y": number, "z": number }\` (in Gs)
- \`startGyroscope(intervalMs, callbackName)\`
    - **Data**: \`{ "x": number, "y": number, "z": number }\` (rotation rate in rad/s)
- \`startCompass(intervalMs, callbackName)\`
    - **Data**: \`{ "heading": number, "x": number, "y": number, "z": number }\`
    - **Note**: \`heading\` is relative to North (0-360).
- \`startPedometer(callbackName)\`
    - **Data**: \`{ "steps": number }\`
    - **Tip**: Takes 10-20 steps to start triggering events.
- \`startSpeedometer(callbackName)\`
    - **Data**: \`{ "speed": number }\` (in km/h)
- \`startGPS(callbackName)\`
    - **Data**: \`{ "latitude": number, "longitude": number, "altitude": number, "heading": number, "speed": number }\`
- \`stopAll()\`
    - **Note**: Stops ALL active sensors. ALWAYS call this when leaving the screen or pausing.

📋 CLIPBOARD (AppacadabraClipboard)
- \`setString(text)\` - Copy text to clipboard
- \`getString(callback)\` - Get text from clipboard
    - **Return**: Clipboard text (string)

📱 DEVICE (AppacadabraDevice)
- \`vibrate(pattern)\` - Vibrate device (number or array of numbers). **No callback**.
- \`cancelVibration()\` - Stop vibration. **No callback**.
- \`getBatteryLevel(callback)\` - Get battery level.
    - **Callback Data**: Battery level (number 0.0 - 1.0)
- \`isCharging(callback)\` - Check if charging.
    - **Callback Data**: Charging status (boolean)
- \`isOnline(callback)\` - Check if online.
    - **Callback Data**: \`true\` or \`false\` (boolean)
- \`getNetworkType(callback)\` - Get connection info.
    - **Callback Data**: Connection type string ('wifi', 'cellular', 'none', 'unknown')
- \`language\` - **Property** (string). Device language (e.g. "en-US")
- \`userAgent\` - **Property** (string). User agent string
- \`openBrowser(url)\` - Open URL in system browser

🎨 SCREEN (AppacadabraScreen)
- \`print()\` - Open native print dialog
- \`capture(callback)\` - Capture screenshot of current view
    - **Callback Data (string)**: Base64 encoded PNG image
    - **Example**: \`AppacadabraScreen.capture("onScreenshotTaken")\`

📸 CAMERA (AppacadabraCamera)
- \`takePhoto(callback)\` - Take a photo using the device camera
    - **Callback Data (string)**: Complete DataURI string (\`data:image/jpeg;base64,...\`). Use directly as img src (do NOT append prefixes manually).
    - **Example**: \`AppacadabraCamera.takePhoto("onPhotoTaken")\`
- \`recordVideo(options, callback)\` - Record a video using the device camera
    - **options** (object, optional): \`{ maxDuration?: number (seconds, default 60, max 300), quality?: "high"|"low" }\`
    - **Callback Data (string)**: Complete DataURI string (\`data:video/mp4;base64,...\`). Use with \`AppacadabraAI.fromVideo(uri).generate(...)\`.
    - **Example**: \`AppacadabraCamera.recordVideo({ maxDuration: 30 }, "onVideoRecorded")\`
    - **Example (no options)**: \`AppacadabraCamera.recordVideo("onVideoRecorded")\`
- \`playVideo(base64, options, callback)\` - Play a video from base64 data
    - **options** (object, optional): \`{ mimeType?: "video/mp4"|"video/webm" }\`
    - **Return**: "Playing" (string)
    - **Example**: \`AppacadabraCamera.playVideo(videoBase64, "onPlaying")\`
- \`stopPlaying(callback)\` - Stop current video playback
    - **Return**: "Stopped" (string)
- \`isPlaying(callback)\` - Check if video is currently playing
    - **Return**: "true" or "false" (string)
- \`scan(callback)\` - Open QR/Barcode scanner overlay
    - **Callback Data (string)**: Scanned content string
    - **Example**: \`AppacadabraCamera.scan("onCodeScanned")\`

🎙️ AUDIO (AppacadabraAudio)
- \`recordStart(callback)\` - Start audio recording (M4A/AAC)
    - **Return**: "Recording started"
- \`recordStop(callback)\` - Stop recording and get result
    - **Callback Data (string)**: Complete DataURI string (\`data:audio/m4a;base64,...\`). **CRITICAL**: Use this string immediately with \`AppacadabraAI.fromAudio(uri).generate(...)\` or in an \`<audio>\` tag. do NOT append prefixes.
    - **Example**: \`AppacadabraAudio.recordStop("onAudioRecorded")\`
- \`speak(text, options, callback)\` - Speak text aloud using device TTS engine (free)
    - **options** (object, optional): \`{ language?: "en-US"|"pt-BR"|..., pitch?: 0.5-2.0, rate?: 0.5-2.0, volume?: 0.0-1.0 }\`
    - **Return**: "Speaking" (string)
    - **Example**: \`AppacadabraAudio.speak("Hello world", { language: "en-US", rate: 1.0 }, "onSpeakDone")\`
- \`speakAI(text, options, callback)\` - Generate high-quality AI voice using Gemini TTS (costs Mana ⚡)
    - **options** (object, optional): \`{ voice?: "Aoede"|"Charon"|"Fenrir"|"Kore"|"Puck"|"Orbit"|"Zephyr", language?: "en-US"|"pt-BR"|... }\`
    - Default voice: "Aoede". Cost: ~0.01–0.05 Mana per sentence (depends on text length)
    - Use \`speak()\` for free device TTS; use \`speakAI()\` when voice quality matters
    - **Return**: "Speaking" (string) — callback called when audio starts playing
    - **Example**: \`AppacadabraAudio.speakAI("Welcome to your spell!", { voice: "Kore" }, "onSpeakDone")\`
- \`stopSpeaking(callback)\` - Stop ALL speech (current + queued)
    - **Return**: "Stopped" (string)
- \`isSpeaking(callback)\` - Check if currently speaking
    - **Return**: "true" or "false" (string)

--- VOICE INPUT WORKFLOW (EXAMPLE) ---
\`\`\`javascript
function onMicrophoneClick() {
  if (!isRecording) {
    AppacadabraAudio.recordStart("onStart");
  } else {
    AppacadabraAudio.recordStop("onAudioResult");
  }
}

window.onAudioResult = function(success, base64) {
  if (success) {
    AppacadabraAI.fromAudio(base64)
      .withSchema(mySchema)
      .generate("Extract data from this audio", "onAIProcessed");
  }
}
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
5. DEEP LINKS: Whenever possible, use Universal Links (standard HTTPS URLs like 'https://www.notion.so/...'). HTTPS links open the app if installed, or fallback to the website automatically. Custom schemes often fail silently if the app is not installed. ALWAYS use \`AppacadabraDevice.openBrowser(url)\` to open these links.
6. UNSUPPORTED FEATURES: If the user asks for a feature not supported by Appacadabra APIs (e.g., accessing private GitHub repos, external OAuth, specific hardware), DO NOT fail or fake it. Instead, suggest a SIMPLE alternative, like manual data entry, inputting a personal token/key, or a simplified manual version of the feature. Prioritize a working app over a broken complex one.
7. SELF-EXPLANATORY UX (CRITICAL): The app must immediately make sense to the user on first open. Plan for:
   - A clear visual hierarchy that guides the user's eye to the primary action.
   - Descriptive placeholder text in inputs (e.g., "Type a task and press Enter" instead of empty fields).
   - Meaningful empty states: when there's no data yet, show a friendly message explaining what to do (e.g., an icon + "No items yet. Tap + to add your first one.").
   - Labels and icons on every interactive element — never rely on unlabeled icons alone.
   - If the app has multiple steps or sections, include a brief subtitle or inline hint explaining the purpose of each area.
   - Avoid hidden gestures or non-obvious interactions; every feature should be reachable via visible buttons or links.
   - The app should feel complete and usable from the very first second, with no guessing required.
8. PREMIUM LOOK & FEEL: Plan for a high-end visual experience. Include:
   - A cohesive color theme (e.g., "Deep Emerald & Soft Gold", "Midnight Slate & Electric Blue").
   - A specific Google Font that matches the app's personality.
   - Micro-interactions (e.g., buttons that scale slightly on tap, list items that fade in).
   - Use of gradients and shadows to create depth and hierarchy.
9. PROACTIVE FEATURE SUGGESTIONS: Based on the user's intent, think beyond the literal request and suggest 1-3 useful complementary features the user likely needs but didn't explicitly ask for (e.g., if they asked for a task list, suggest due dates or reminders; if they asked for a notes app, suggest search or categories). Include these in \`coreFeatures\` if they add clear value.
10. END-TO-END FLOW INTEGRITY (CRITICAL): Every feature must be planned with its full lifecycle. If a feature creates something, plan what happens when it is edited, completed, and deleted. No loose ends allowed. Examples:
    - If you plan a notification for a task → plan canceling/removing that notification when the task is deleted or completed.
    - If you plan a recurring timer or interval → plan clearing it when no longer needed.
    - If you plan localStorage data → plan cleanup when the related item is removed.
    - If you plan a UI element that appears conditionally → plan how it disappears or updates in all states.
    Every action must have a corresponding reaction. Think: "What happens to everything related to this item when it changes or goes away?"
`;

// CREATE STEP 2: Unified Code Generator
// Combines: HTML Skeleton, CSS Skin, JS Logic, Assembly
export const UNIFIED_CREATE_CODE_PROMPT = `You are a full-stack mobile web developer.
Create a complete, single-file web app based on the provided PLAN.

Rules:
1. Use EXACTLY the IDs, function names, and APIs defined in the PLAN.
2. Use modern HTML5, CSS3 (internal), and ES6+ JavaScript (internal).
3. DESIGN: mobile-first, touch-friendly. Use generous sizing:
   - Base font: 16px minimum; headings: 22px+; secondary text: 14px minimum.
   - Buttons/interactive targets: min 48px height, 12-16px padding, font-size 16px.
   - Inputs: min 48px height, font-size 16px (prevents iOS auto-zoom), comfortable padding.
   - List items: min 48px tall. Icons: min 24px.
   - Gaps/margins: at least 12px between elements. Sections: 20-24px vertical spacing.
   - Overall: spacious, breathing layout — never cramped.
4. LOGIC: Use localStorage for persistence. Implement all features described.
5. LANGUAGE: All UI text (labels, buttons, alerts) MUST be in the same language as the user's request.
6. CALLBACKS: All Appacadabra API callbacks must be global window functions.
7. SELF-EXPLANATORY UX: Implement the UX clarity from the PLAN:
   - Every input must have a descriptive placeholder that tells the user what to type.
   - Empty states must show a helpful message with an icon/emoji explaining what to do next.
   - Buttons must have text labels (not just icons). If using an icon, always pair it with a short text label.
   - Add a small subtitle or helper text below the app title briefly explaining what the app does.
   - Use visual affordances: shadows on buttons, underlines on links, clear hover/active states.
   - On first load with no data, the UI should clearly guide the user to the first action.
8. SIZING & AESTHETICS:
   - Base font: 16px; headings: 22px+; interactive targets: min 48px height.
   - Use \`box-sizing: border-box;\` and \`padding: 16px;\` on the main container.
   - **Modern CSS**: Use CSS variables for colors, \`border-radius: 16px\`, \`box-shadow: 0 4px 12px rgba(0,0,0,0.1)\`, and \`transition: all 0.2s ease\`.
   - **Typography**: Import a modern font from Google Fonts (e.g., \`<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">\`) and apply it.
   - **Colors**: Use a premium, curated palette. No browser-default blue/purple.

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
4. END-TO-END FLOW INTEGRITY (CRITICAL): Before finalizing patches, verify that every planned change maintains full lifecycle integrity:
   - If adding a notification → ensure it is also cancelled/removed when the triggering item is deleted or completed.
   - If adding a timer/interval → ensure it is cleared when no longer needed.
   - If adding stored data → ensure it is cleaned up when the related entity is removed.
   - If modifying a create flow → check if the delete/complete/edit flows need corresponding updates.
   No change is complete if related lifecycle events are left unhandled. List any such dependencies explicitly in \`impactAnalysis\`.
5. SELF-EXPLANATORY UX: Implement the UX clarity from the PLAN:
   - Every input must have a descriptive placeholder that tells the user what to type.
   - Empty states must show a helpful message with an icon/emoji explaining what to do next.
   - Buttons must have text labels (not just icons). If using an icon, always pair it with a short text label.
   - Add a small subtitle or helper text below the app title briefly explaining what the app does.
   - Use visual affordances: shadows on buttons, underlines on links, clear hover/active states.
   - On first load with no data, the UI should clearly guide the user to the first action.
6. SIZING & AESTHETICS:
   - Base font: 16px; headings: 22px+; interactive targets: min 48px height.
   - Use \`box-sizing: border-box;\` and \`padding: 16px;\` on the main container.
   - **Modern CSS**: Use CSS variables for colors, \`border-radius: 16px\`, \`box-shadow: 0 4px 12px rgba(0,0,0,0.1)\`, and \`transition: all 0.2s ease\`.
   - **Typography**: Import a modern font from Google Fonts (e.g., \`<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">\`) and apply it.
   - **Colors**: Use a premium, curated palette. No browser-default blue/purple.

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
4. UNSUPPORTED FEATURES: If the requested change requires unsupported integrations, propose a simple manual alternative (e.g., input fields for tokens/keys, manual data entry) instead of breaking the app. Keep it simple and functional.
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


export interface ContentValidationResult {
  allowed: boolean;
  reason?: string;
}

export function validateContentRequest(text: string): ContentValidationResult {
  // Validation disabled
  return { allowed: true };
}
