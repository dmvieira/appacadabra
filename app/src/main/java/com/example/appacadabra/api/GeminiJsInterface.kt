package com.example.appacadabra.api

import android.graphics.BitmapFactory
import android.util.Base64
import android.webkit.JavascriptInterface
import com.google.firebase.Firebase
import com.google.firebase.ai.ai
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.Schema
import com.google.firebase.ai.type.content
import com.google.firebase.ai.type.generationConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * JavaScript interface that allows HTML apps running in WebView to use Gemini AI.
 * 
 * Available functions in JavaScript:
 * - AppacadabraAI.generateText(prompt, callbackName) - Generate text from a prompt
 * - AppacadabraAI.generateTextWithSearch(prompt, callbackName) - Generate text with web search grounding
 * - AppacadabraAI.describeImage(base64Image, prompt, callbackName) - Describe an image
 * - AppacadabraAI.transcribeAudio(base64Audio, callbackName) - Transcribe audio to text
 * - AppacadabraAI.chat(message, callbackName) - Chat with AI
 * - AppacadabraAI.extractStructuredData(text, schemaJson, callbackName) - Extract structured JSON data
 * 
 * All callbacks must be GLOBAL FUNCTIONS referenced by NAME (string).
 */
class GeminiJsInterface(
    private val webView: android.webkit.WebView,
    private val scope: CoroutineScope
) {
    
    /**
     * Helper function that wraps AI calls with consistent error handling and callback execution.
     */
    private fun executeAiCall(callbackName: String, block: suspend () -> String) {
        scope.launch(Dispatchers.Main) {
            try {
                val result = block()
                callJsCallback(callbackName, true, escapeForJs(result))
            } catch (e: Exception) {
                e.printStackTrace()
                // Try fallback if rate limit
                if (GeminiModels.isRateLimitError(e)) {
                    try {
                        // Re-run with fallback - but since block captures primary, we just report error for now
                        callJsCallback(callbackName, false, escapeForJs("Rate limit exceeded. Please try again."))
                    } catch (fallbackError: Exception) {
                        callJsCallback(callbackName, false, escapeForJs(fallbackError.message ?: "Error"))
                    }
                } else {
                    callJsCallback(callbackName, false, escapeForJs(e.message ?: "Error"))
                }
            }
        }
    }
    
    @JavascriptInterface
    fun generateText(prompt: String, callbackName: String) {
        executeAiCall(callbackName) {
            val response = GeminiModels.primary.generateContent(prompt)
            response.text ?: ""
        }
    }
    
    /**
     * Generate text with Google Search grounding for up-to-date information.
     */
    @JavascriptInterface
    fun generateTextWithSearch(prompt: String, callbackName: String) {
        executeAiCall(callbackName) {
            val response = GeminiModels.search.generateContent(prompt)
            response.text ?: ""
        }
    }
    
    @JavascriptInterface
    fun describeImage(base64Image: String, prompt: String, callbackName: String) {
        executeAiCall(callbackName) {
            // Remove data URL prefix if present
            val cleanBase64 = base64Image
                .replace("data:image/png;base64,", "")
                .replace("data:image/jpeg;base64,", "")
                .replace("data:image/jpg;base64,", "")
                .replace("data:image/webp;base64,", "")
            
            val imageBytes = Base64.decode(cleanBase64, Base64.DEFAULT)
            val bitmap = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size)
                ?: throw Exception("Failed to decode image")
            
            val contentInput = content {
                image(bitmap)
                text(prompt.ifEmpty { "Describe this image in detail." })
            }
            
            val response = GeminiModels.primary.generateContent(contentInput)
            response.text ?: ""
        }
    }
    
    @JavascriptInterface
    fun transcribeAudio(base64Audio: String, callbackName: String) {
        executeAiCall(callbackName) {
            // Remove data URL prefix if present
            val cleanBase64 = base64Audio
                .replace(Regex("data:audio/[^;]+;base64,"), "")
            
            val audioBytes = Base64.decode(cleanBase64, Base64.DEFAULT)
            
            val contentInput = content {
                inlineData(audioBytes, "audio/wav")
                text("Transcribe this audio to text. Return only the transcription, nothing else.")
            }
            
            val response = GeminiModels.primary.generateContent(contentInput)
            response.text ?: ""
        }
    }
    
    /**
     * Extract structured data from unstructured text using AI with native JSON output.
     * Uses generationConfig with responseMimeType = "application/json" for guaranteed JSON output.
     */
    @JavascriptInterface
    fun extractStructuredData(text: String, schemaJson: String, callbackName: String) {
        executeAiCall(callbackName) {
            // Create a model configured for JSON output
            val jsonModel = Firebase.ai(backend = GenerativeBackend.googleAI()).generativeModel(
                modelName = "gemini-2.5-flash",
                generationConfig = generationConfig {
                    responseMimeType = "application/json"
                }
            )
            
            val prompt = """
                Extract structured data from this text according to the JSON schema.
                
                Text: "$text"
                
                Expected JSON schema: $schemaJson
                
                Return only the extracted data as valid JSON matching the schema.
                If information is missing, use null or empty string.
            """.trimIndent()
            
            val response = jsonModel.generateContent(prompt)
            response.text ?: "{}"
        }
    }
    
    private fun callJsCallback(callbackName: String, success: Boolean, data: String) {
        val js = """
            (function() {
                if (typeof $callbackName === 'function') {
                    $callbackName($success, "$data");
                }
            })();
        """.trimIndent()
        
        webView.post {
            webView.evaluateJavascript(js, null)
        }
    }
    
    private fun escapeForJs(text: String): String {
        return text
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
    }
}
