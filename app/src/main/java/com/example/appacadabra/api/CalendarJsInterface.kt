package com.example.appacadabra.api

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.CalendarContract
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.TimeZone

/**
 * JavaScript interface for calendar operations.
 * Allows HTML apps to create calendar events on the device.
 * 
 * Usage in JavaScript:
 * AppacadabraCalendar.createEvent(title, description, startTimeMs, endTimeMs, callback)
 * AppacadabraCalendar.createEventIntent(title, description, startTimeMs, endTimeMs) - Opens calendar app
 * AppacadabraCalendar.hasCalendarPermission(callback)
 */
class CalendarJsInterface(
    private val context: Context,
    private val webView: WebView,
    private val scope: CoroutineScope,
    private val requestPermission: () -> Unit
) {
    private val geminiClient = GeminiClient()
    
    /**
     * Check if calendar permission is granted
     */
    @JavascriptInterface
    fun hasCalendarPermission(callbackName: String) {
        val hasWritePermission = ContextCompat.checkSelfPermission(
            context, Manifest.permission.WRITE_CALENDAR
        ) == PackageManager.PERMISSION_GRANTED
        
        val hasReadPermission = ContextCompat.checkSelfPermission(
            context, Manifest.permission.READ_CALENDAR
        ) == PackageManager.PERMISSION_GRANTED
        
        val hasPermission = hasWritePermission && hasReadPermission
        callJsCallback(callbackName, true, hasPermission.toString())
    }
    
    /**
     * Request calendar permission
     */
    @JavascriptInterface
    fun requestCalendarPermission() {
        webView.post { requestPermission() }
    }
    
    /**
     * Create event using Intent (opens calendar app - more reliable, no permission needed)
     */
    @JavascriptInterface
    fun createEventIntent(
        title: String,
        description: String,
        startTimeMs: Long,
        endTimeMs: Long
    ) {
        webView.post {
            try {
                val intent = Intent(Intent.ACTION_INSERT).apply {
                    data = CalendarContract.Events.CONTENT_URI
                    putExtra(CalendarContract.Events.TITLE, title)
                    putExtra(CalendarContract.Events.DESCRIPTION, description)
                    putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startTimeMs)
                    putExtra(CalendarContract.EXTRA_EVENT_END_TIME, endTimeMs)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }
    
    /**
     * Create event with Intent and reminder
     */
    @JavascriptInterface
    fun createEventIntentWithReminder(
        title: String,
        description: String,
        startTimeMs: Long,
        endTimeMs: Long,
        reminderMinutes: Int
    ) {
        webView.post {
            try {
                val intent = Intent(Intent.ACTION_INSERT).apply {
                    data = CalendarContract.Events.CONTENT_URI
                    putExtra(CalendarContract.Events.TITLE, title)
                    putExtra(CalendarContract.Events.DESCRIPTION, description)
                    putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startTimeMs)
                    putExtra(CalendarContract.EXTRA_EVENT_END_TIME, endTimeMs)
                    putExtra(CalendarContract.Events.HAS_ALARM, true)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }
    
    /**
     * Create a calendar event - always uses Intent for better UX
     */
    @JavascriptInterface
    fun createEvent(
        title: String,
        description: String,
        startTimeMs: Long,
        endTimeMs: Long,
        callbackName: String
    ) {
        // Always use Intent for better UX - no permission/login required
        webView.post {
            try {
                val intent = Intent(Intent.ACTION_INSERT).apply {
                    data = CalendarContract.Events.CONTENT_URI
                    putExtra(CalendarContract.Events.TITLE, title)
                    putExtra(CalendarContract.Events.DESCRIPTION, description)
                    putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startTimeMs)
                    putExtra(CalendarContract.EXTRA_EVENT_END_TIME, endTimeMs)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                callJsCallback(callbackName, true, "Opening calendar app to create event")
            } catch (e: Exception) {
                e.printStackTrace()
                callJsCallback(callbackName, false, escapeForJs(e.message ?: "Error opening calendar"))
            }
        }
    }
    
    /**
     * Create event with reminder (always uses Intent for better UX)
     */
    @JavascriptInterface
    fun createEventWithReminder(
        title: String,
        description: String,
        startTimeMs: Long,
        endTimeMs: Long,
        reminderMinutes: Int,
        callbackName: String
    ) {
        // Always use Intent for better UX
        webView.post {
            try {
                val intent = Intent(Intent.ACTION_INSERT).apply {
                    data = CalendarContract.Events.CONTENT_URI
                    putExtra(CalendarContract.Events.TITLE, title)
                    putExtra(CalendarContract.Events.DESCRIPTION, description)
                    putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startTimeMs)
                    putExtra(CalendarContract.EXTRA_EVENT_END_TIME, endTimeMs)
                    putExtra(CalendarContract.Events.HAS_ALARM, true)
                    // Note: Setting specific reminder time via Intent isn't universally supported
                    // but we set HAS_ALARM to encourage default reminder
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                callJsCallback(callbackName, true, "Opening calendar app to create event")
            } catch (e: Exception) {
                e.printStackTrace()
                callJsCallback(callbackName, false, escapeForJs(e.message ?: "Error opening calendar"))
            }
        }
    }


    
    private fun getDefaultCalendarId(): Long? {
        try {
            val projection = arrayOf(
                CalendarContract.Calendars._ID, 
                CalendarContract.Calendars.ACCOUNT_TYPE,
                CalendarContract.Calendars.IS_PRIMARY
            )
            
            // First try to find a Google calendar
            val cursor = context.contentResolver.query(
                CalendarContract.Calendars.CONTENT_URI,
                projection,
                "${CalendarContract.Calendars.VISIBLE} = 1",
                null,
                null
            )
            
            cursor?.use {
                // Try primary first
                while (it.moveToNext()) {
                    val idIndex = it.getColumnIndex(CalendarContract.Calendars._ID)
                    val primaryIndex = it.getColumnIndex(CalendarContract.Calendars.IS_PRIMARY)
                    
                    if (idIndex >= 0 && primaryIndex >= 0) {
                        val isPrimary = it.getInt(primaryIndex)
                        if (isPrimary == 1) {
                            return it.getLong(idIndex)
                        }
                    }
                }
                
                // Fallback to first visible calendar
                if (it.moveToFirst()) {
                    val idIndex = it.getColumnIndex(CalendarContract.Calendars._ID)
                    if (idIndex >= 0) {
                        return it.getLong(idIndex)
                    }
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        return null
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
    }
}
