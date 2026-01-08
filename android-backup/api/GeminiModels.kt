package com.example.appacadabra.api

import com.google.firebase.Firebase
import com.google.firebase.ai.ai
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.Tool

/**
 * Shared Gemini models for use across the app.
 * Provides modular access to AI models with consistent configuration.
 */
object GeminiModels {
    
    // Primary model: gemini-3-flash-preview (without tools)
    val primary by lazy {
        Firebase.ai(backend = GenerativeBackend.googleAI())
            .generativeModel("gemini-3-flash-preview")
    }
    
    // Fallback model: gemma-3-27b-it (without tools, for rate limits)
    val fallback by lazy {
        Firebase.ai(backend = GenerativeBackend.googleAI())
            .generativeModel("gemma-3-27b-it")
    }
    
    // Search model: gemini-2.5-flash with Google Search grounding
    val search by lazy {
        Firebase.ai(backend = GenerativeBackend.googleAI()).generativeModel(
            modelName = "gemini-2.5-flash",
            tools = listOf(Tool.googleSearch())
        )
    }
    
    // Check if error is rate limit related
    fun isRateLimitError(e: Exception): Boolean {
        val message = e.message?.lowercase() ?: ""
        return message.contains("rate limit") || 
               message.contains("quota") || 
               message.contains("resource exhausted") ||
               message.contains("429") ||
               message.contains("too many requests")
    }
}
