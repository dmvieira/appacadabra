Route an engineering task to the appropriate AI model or tool based on task domain.

**Task to route:** $ARGUMENTS

## Routing intelligence

You are the Stack Router for Appacadabra's Engineering Agent. Your job is to:
1. Classify the task by domain
2. Route it to the best available model/MCP
3. Execute with the right context injected

## Routing rules

### Route → Firebase MCP (available now)
**Trigger:** Firestore schema questions, Cloud Functions behavior, Firebase rules, log analysis, project configuration, security rules, function deployment status

**Actions to take:**
- Use `mcp__plugin_firebase_firebase__firestore_query_collection` to inspect data shapes
- Use `mcp__plugin_firebase_firebase__functions_get_logs` to check function behavior
- Use `mcp__plugin_firebase_firebase__firebase_read_resources` for project config
- Use `mcp__plugin_firebase_firebase__developerknowledge_search_documents` for Firebase SDK questions

**Context to inject:** Read `firebase/functions/src/index.ts` and `lib/firebase.ts` before answering.

---

### Route → Gemini API MCP (configure to enable)
**Trigger:** Android-native depth (Jetpack Compose, ViewModel lifecycle, Coroutine scopes, Hardware permissions, API 34+ behavior, Gradle dependency resolution), large context Android SDK questions

**To enable this route**, add to `.claude/settings.json` under `mcpServers`:
```json
"gemini": {
  "command": "npx",
  "args": ["-y", "@google/generative-ai-mcp"],
  "env": { "GEMINI_API_KEY": "your-key-here" }
}
```
Once configured, use the `gemini` MCP for:
- Queries about Android hardware permission flows that differ by API level
- Jetpack Compose recomposition behavior with complex state
- Kotlin coroutine scope lifetime in Activity vs. ViewModel
- ProGuard/R8 keep rules for Firebase SDKs
- AndroidManifest.xml attribute semantics

**Without Gemini MCP:** Proceed with Claude + inject `android/` source files as context, but note confidence may be lower for very specific Android edge cases.

---

### Route → OpenRouter MCP (bulk translation — 5+ strings)
**Trigger:** Re-translating multiple existing strings, locale file sweep, back-translation verification across all languages

**To enable**, add to `.claude/settings.json` under `mcpServers`:
```json
"openrouter": {
  "command": "npx",
  "args": ["-y", "@mcpservers/openrouterai"],
  "env": { "OPENROUTER_API_KEY": "sk-or-..." }
}
```

**Package:** `@mcpservers/openrouterai@2.3.0` — confirmed installable. Exposes `chat_completion`, `search_models`, `get_model_info`.

**When configured**, call `openrouter__chat_completion` with:
- **model primário:** `google/gemma-4-26b-a4b-it`
- **model alternativo:** `openai/gpt-oss-120b`
- System prompt must include: Appacadabra's magic/spell tone, the 17 target locales, back-translation instructions for JA, AR, HI, KO
- Pass all source strings in a single batch request; request output as JSON keyed by locale code

**Without OpenRouter MCP:** Fall back to `/add-locale-string` (Claude) with a note that cost will be higher for large batches.

---

### Route → Localization Pipeline (`/add-locale-string`)
**Trigger:** Adding a single new UI string key, one-off translation, adding a new i18n entry

**Action:** Use `/add-locale-string` with the key and English source text. Claude handles all 17 languages natively with high quality for single strings.

---

### Route → Claude (default — TypeScript, React Native, Expo, architecture)
**Trigger:** React Native components, Expo APIs, Zustand store, SQLite queries, WebView bridge logic, TypeScript types, Jest tests, capability module development

**Context to inject:**
- Always read `CLAUDE.md` first for architecture constraints
- Read the specific capability or bridge file being modified
- Check existing test patterns in `lib/capabilities/__tests__/` for test tasks

---

## Execution

After classifying the task above, proceed to execute it using the appropriate route. If the ideal route requires an unconfigured MCP, fall back to Claude with a note explaining what additional setup would improve the answer.

**Classified route for this task:** [determine from task description]
**Executing now with:** [chosen tool/context]
