package com.example.appacadabra.api

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

/**
 * JavaScript interface for notifications using WorkManager.
 * Allows HTML apps to schedule notifications.
 * 
 * Usage in JavaScript:
 * AppacadabraNotify.showNow(title, message, callback)
 * AppacadabraNotify.scheduleNotification(title, message, delayMinutes, callback)
 * AppacadabraNotify.cancelNotification(notificationId, callback)
 */
class NotificationJsInterface(
    private val context: Context,
    private val webView: WebView,
    private val scope: CoroutineScope,
    private val requestPermission: () -> Unit
) {
    
    companion object {
        const val CHANNEL_ID = "appacadabra_notifications"
        const val CHANNEL_NAME = "App Notifications"
    }
    
    init {
        createNotificationChannel()
    }
    
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Notifications from Appacadabra apps"
            }
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.createNotificationChannel(channel)
        }
    }
    
    @JavascriptInterface
    fun hasNotificationPermission(callbackName: String) {
        val hasPermission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                context, Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true // No runtime permission needed before Android 13
        }
        callJsCallback(callbackName, true, hasPermission.toString())
    }
    
    @JavascriptInterface
    fun requestNotificationPermission() {
        webView.post { requestPermission() }
    }
    
    /**
     * Show notification immediately
     */
    @JavascriptInterface
    fun showNow(title: String, message: String, callbackName: String) {
        scope.launch {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    if (ContextCompat.checkSelfPermission(
                            context, Manifest.permission.POST_NOTIFICATIONS
                        ) != PackageManager.PERMISSION_GRANTED
                    ) {
                        callJsCallback(callbackName, false, "Notification permission not granted")
                        return@launch
                    }
                }
                
                val notificationId = System.currentTimeMillis().toInt()
                
                val builder = NotificationCompat.Builder(context, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle(title)
                    .setContentText(message)
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                    .setAutoCancel(true)
                
                try {
                    NotificationManagerCompat.from(context).notify(notificationId, builder.build())
                    callJsCallback(callbackName, true, notificationId.toString())
                } catch (e: SecurityException) {
                    callJsCallback(callbackName, false, "Permission denied")
                }
            } catch (e: Exception) {
                callJsCallback(callbackName, false, escapeForJs(e.message ?: "Error"))
            }
        }
    }
    
    /**
     * Schedule a notification using WorkManager
     */
    @JavascriptInterface
    fun scheduleNotification(title: String, message: String, delayMinutes: Long, callbackName: String) {
        scope.launch {
            try {
                val workId = "notification_${System.currentTimeMillis()}"
                
                val inputData = workDataOf(
                    "title" to title,
                    "message" to message,
                    "notificationId" to System.currentTimeMillis().toInt()
                )
                
                val notificationWork = OneTimeWorkRequestBuilder<NotificationWorker>()
                    .setInitialDelay(delayMinutes, TimeUnit.MINUTES)
                    .setInputData(inputData)
                    .addTag(workId)
                    .build()
                
                WorkManager.getInstance(context).enqueue(notificationWork)
                
                callJsCallback(callbackName, true, workId)
            } catch (e: Exception) {
                callJsCallback(callbackName, false, escapeForJs(e.message ?: "Error scheduling"))
            }
        }
    }
    
    /**
     * Schedule notification at specific time
     */
    @JavascriptInterface
    fun scheduleNotificationAt(title: String, message: String, timeMs: Long, callbackName: String) {
        val delayMs = timeMs - System.currentTimeMillis()
        if (delayMs <= 0) {
            showNow(title, message, callbackName)
            return
        }
        
        val delayMinutes = delayMs / 60000
        scheduleNotification(title, message, delayMinutes, callbackName)
    }
    
    /**
     * Cancel a scheduled notification
     */
    @JavascriptInterface
    fun cancelScheduledNotification(workId: String, callbackName: String) {
        scope.launch {
            try {
                WorkManager.getInstance(context).cancelAllWorkByTag(workId)
                callJsCallback(callbackName, true, "Cancelled")
            } catch (e: Exception) {
                callJsCallback(callbackName, false, escapeForJs(e.message ?: "Error"))
            }
        }
    }
    
    /**
     * Cancel a shown notification by ID
     */
    @JavascriptInterface
    fun cancelNotification(notificationId: Int, callbackName: String) {
        try {
            NotificationManagerCompat.from(context).cancel(notificationId)
            callJsCallback(callbackName, true, "Cancelled")
        } catch (e: Exception) {
            callJsCallback(callbackName, false, escapeForJs(e.message ?: "Error"))
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
        return text.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
    }
}

/**
 * Worker class for scheduled notifications
 */
class NotificationWorker(
    private val context: Context,
    params: WorkerParameters
) : Worker(context, params) {
    
    override fun doWork(): Result {
        val title = inputData.getString("title") ?: return Result.failure()
        val message = inputData.getString("message") ?: return Result.failure()
        val notificationId = inputData.getInt("notificationId", System.currentTimeMillis().toInt())
        
        val builder = NotificationCompat.Builder(context, NotificationJsInterface.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(message)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
        
        try {
            NotificationManagerCompat.from(context).notify(notificationId, builder.build())
        } catch (e: SecurityException) {
            return Result.failure()
        }
        
        return Result.success()
    }
}
