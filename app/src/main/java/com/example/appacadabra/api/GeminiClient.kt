package com.example.appacadabra.api

import com.google.firebase.ai.type.content
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class GeminiClient {
    
    private val localStorageInstructions = """
IMPORTANT: The app will run in an Android WebView. For data persistence:
- Use localStorage to save any user data, settings, or state
- Example: localStorage.setItem('key', JSON.stringify(data)) and JSON.parse(localStorage.getItem('key'))
- Always load saved data on app startup
- Save data whenever user makes changes
- The localStorage data will persist between app sessions

PREFER DETERMINISTIC CODE:
The generated app should use AI when makes sense:
1. USE FIXED MESSAGES: For tips, greetings, feedback - use pre-written strings, not AI generation
2. USE SIMPLE LOGIC: For calculations, sorting, filtering - use JavaScript functions, not AI
3. CACHE AI RESPONSES: If AI is used, store results in localStorage to avoid repeated calls
4. AVOID AI FOR: Random quotes, motivational messages, placeholder text - use arrays with fixed options
5. PREFER LOCAL DATA: Use hardcoded lists/data instead of generating content via AI

📅 CALENDAR INTEGRATION (CRITICAL: Use AppacadabraCalendar API, NEVER use window.open/links):
- AppacadabraCalendar.createEvent(title, description, startTimeMs, endTimeMs, callback) - Opens native Android Calendar app with pre-filled details.
- AppacadabraCalendar.createEventWithReminder(title, description, startMs, endMs, reminderMinutes, callback) - Opens native Calendar with reminder.
- DO NOT use google.com/calendar links. USE ONLY THESE FUNCTIONS.

IMPORTANT: startTimeMs and endTimeMs must be Unix timestamps in MILLISECONDS (not seconds).
How to create timestamps in JavaScript:
  // From a Date object:
  const startMs = new Date(2024, 0, 15, 14, 30).getTime(); // Jan 15, 2024 at 2:30 PM
  const endMs = new Date(2024, 0, 15, 15, 30).getTime();   // Jan 15, 2024 at 3:30 PM
  
  // From date input values:
  const startMs = new Date(dateInput + 'T' + timeInput).getTime();
  
  // For current time + duration:
  const startMs = Date.now();
  const endMs = startMs + (60 * 60 * 1000); // 1 hour later
  
  // THEN call:
  AppacadabraCalendar.createEvent(title, description, startMs, endMs, function(success, result) {
    console.log(success ? 'Calendar opened!' : 'Error: ' + result);
  });

🔔 NOTIFICATION API (AppacadabraNotify):
- AppacadabraNotify.hasNotificationPermission(callback) - Check permission
- AppacadabraNotify.requestNotificationPermission() - Request permission
- AppacadabraNotify.showNow(title, message, callback) - Show notification immediately
- AppacadabraNotify.scheduleNotification(title, message, delayMinutes, callback) - Schedule notification
- AppacadabraNotify.scheduleNotificationAt(title, message, timeMs, callback) - Schedule at specific time
- AppacadabraNotify.cancelScheduledNotification(workId, callback) - Cancel scheduled notification

🤖 AI API (AppacadabraAI) - use when necessary:
1. AppacadabraAI.generateText(prompt, callbackName) - Generate text
2. AppacadabraAI.generateTextWithSearch(prompt, callbackName) - Generate with web search
3. AppacadabraAI.describeImage(base64, prompt, callbackName) - Describe image
4. AppacadabraAI.transcribeAudio(base64, callbackName) - Transcribe audio
5. AppacadabraAI.extractStructuredData(text, schema, callbackName) - Extract structured JSON data from unstructured text

⚠️ IMPORTANT: All callbacks must be GLOBAL FUNCTIONS referenced by NAME (string).
Example for extractStructuredData:
  const schema = {
    "name": "string - person name",
    "email": "string - email address", 
    "phone": "string - phone number"
  };
  window.handleExtractResult = function(success, data) {
    if (success) {
      const parsed = JSON.parse(data);
      console.log(parsed.name, parsed.email, parsed.phone);
    }
  };
  AppacadabraAI.extractStructuredData(
    "Meu nome é João, email joao@email.com e tel 11999998888",
    JSON.stringify(schema),
    "handleExtractResult"  // ← callback name as STRING
  );

All callbacks receive: function(success: boolean, result: string)
"""

    suspend fun generateApp(description: String): Result<String> {
        return withContext(Dispatchers.IO) {
            val prompt = """Create a single-file HTML application (including CSS and JS inside <style> and <script> tags) that does the following: $description.

$localStorageInstructions

Return ONLY the HTML code wrapped in a markdown code block ```html ... ```."""
            
            try {
                // Try primary model first
                val response = GeminiModels.primary.generateContent(prompt)
                val text = response.text
                if (text != null) {
                    Result.success(text)
                } else {
                    Result.failure(Exception("Empty response from AI"))
                }
            } catch (e: Exception) {
                e.printStackTrace()
                
                // If rate limit error, try fallback model
                if (GeminiModels.isRateLimitError(e)) {
                    println("Rate limit hit on primary model, trying fallback...")
                    try {
                        val fallbackResponse = GeminiModels.fallback.generateContent(prompt)
                        val text = fallbackResponse.text
                        if (text != null) {
                            Result.success(text)
                        } else {
                            Result.failure(Exception("Empty response from fallback AI"))
                        }
                    } catch (fallbackError: Exception) {
                        fallbackError.printStackTrace()
                        Result.failure(fallbackError)
                    }
                } else {
                    Result.failure(e)
                }
            }
        }
    }

    suspend fun editApp(currentCode: String, instructions: String): Result<String> {
        return withContext(Dispatchers.IO) {
             val prompt = content {
                 text("Here is an existing HTML application:")
                 text(currentCode)
                 text("Please modify it according to these instructions: $instructions")
                 text(localStorageInstructions)
                 text("Return the full updated single-file HTML code. Wrap it in ```html ... ```.")
             }

            try {
                // Try primary model first
                val response = GeminiModels.primary.generateContent(prompt)
                val text = response.text
                if (text != null) {
                    Result.success(text)
                } else {
                    Result.failure(Exception("Empty response from AI"))
                }
            } catch (e: Exception) {
                e.printStackTrace()
                
                // If rate limit error, try fallback model
                if (GeminiModels.isRateLimitError(e)) {
                    println("Rate limit hit on primary model, trying fallback...")
                    try {
                        val fallbackResponse = GeminiModels.fallback.generateContent(prompt)
                        val text = fallbackResponse.text
                        if (text != null) {
                            Result.success(text)
                        } else {
                            Result.failure(Exception("Empty response from fallback AI"))
                        }
                    } catch (fallbackError: Exception) {
                        fallbackError.printStackTrace()
                        Result.failure(fallbackError)
                    }
                } else {
                    Result.failure(e)
                }
            }
        }
    }
}
