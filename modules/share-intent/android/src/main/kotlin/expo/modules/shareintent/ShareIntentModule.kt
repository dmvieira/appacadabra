package expo.modules.shareintent

import android.content.Intent
import android.net.Uri
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import androidx.core.content.pm.ShortcutManagerCompat
import android.provider.OpenableColumns
class ShareIntentModule : Module() {
    // Stores content only until it's consumed by JS
    private var pendingSharedContent: Map<String, Any?>? = null
    private val TAG = "ShareIntentModule"
    
    private var lastProcessedIntent: Intent? = null
    private var consumedIntent: Intent? = null

    override fun definition() = ModuleDefinition {
        Name("ShareIntent")

        Events("onShareReceived")

        Function("getSharedContent") {
            return@Function pendingSharedContent
        }

        Function("clearSharedContent") {
            Log.d(TAG, "Clearing pending content and marking intent as consumed")
            pendingSharedContent = null
            // Mark the last processed intent as fully consumed so checking it again won't re-trigger
            consumedIntent = lastProcessedIntent
        }

        Function("getContentFileName") { uri: String ->
            try {
                Log.d(TAG, "Getting content file name for: $uri")
                val parsedUri = Uri.parse(uri)
                return@Function getFileName(parsedUri)
            } catch (e: Exception) {
                Log.e(TAG, "Error parsing URI: $uri", e)
                return@Function null
            }
        }
        
        Function("checkShareIntent") {
            Log.d(TAG, "Manual checkShareIntent triggered")
            processIntent(null, true) // Force re-processing (unless consumed)
        }
        
        // Native function to start RunnerActivity bypassing React Native linking
        // Used by SHARE - reuses existing window for same app
        Function("startRunnerActivity") { appId: Int ->
            Log.d(TAG, "startRunnerActivity called with appId: $appId")
            val currentActivity = appContext.currentActivity ?: return@Function false
            
            try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse("runapp://runner/$appId"))
                intent.setPackage(currentActivity.packageName)
                // NEW_DOCUMENT with same URI = same document task as shortcut/openRunnerWindow
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
                currentActivity.startActivity(intent)
                Log.d(TAG, "startRunnerActivity succeeded")
                return@Function true
            } catch (e: Exception) {
                Log.e(TAG, "startRunnerActivity failed: ${e.message}")
                return@Function false
            }
        }
        
        // Native function to open app in NEW window - used by PLAY button
        // Uses same ACTION_VIEW + URI as shortcuts so Android deduplicates to the same document task
        Function("openRunnerWindow") { appId: Int ->
            Log.d(TAG, "openRunnerWindow called with appId: $appId")
            val currentActivity = appContext.currentActivity ?: return@Function false
            
            try {
                val launchUri = Uri.parse("runapp://runner/$appId")
                val intent = Intent(Intent.ACTION_VIEW, launchUri)
                intent.setPackage(currentActivity.packageName)
                // NEW_DOCUMENT: same URI = same document task, so shortcut and in-app share one window
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
                currentActivity.startActivity(intent)
                Log.d(TAG, "openRunnerWindow succeeded")
                return@Function true
            } catch (e: Exception) {
                Log.e(TAG, "openRunnerWindow failed: ${e.message}")
                return@Function false
            }
        }
        
        // Close specific RunnerActivity to prevent duplicates when sharing
        Function("finishRunnerActivity") { appId: Int ->
            Log.d(TAG, "finishRunnerActivity called for appId: $appId")
            try {
                val context = appContext.reactContext ?: return@Function false
                val intent = Intent("ai.appacadabra.app.FINISH_RUNNER")
                intent.putExtra("appId", appId)
                intent.setPackage(context.packageName)
                context.sendBroadcast(intent)
                Log.d(TAG, "finishRunnerActivity broadcast sent for appId: $appId")
                return@Function true
            } catch (e: Exception) {
                Log.e(TAG, "finishRunnerActivity failed: ${e.message}")
                return@Function false
            }
        }
        
        OnNewIntent {
            Log.d(TAG, "OnNewIntent received")
            consumedIntent = null
            
            // Restore delay to fix race condition where JS isn't ready for the event
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                processIntent(it, true) 
            }, 150)
        }

        OnCreate {
            processIntent(null, false)
        }
    }

    private fun processIntent(intent: Intent?, force: Boolean) {
        val currentActivity = appContext.currentActivity
        val targetIntent = intent ?: currentActivity?.intent
        
        if (targetIntent?.action != Intent.ACTION_SEND) {
            return
        }

        if (targetIntent === consumedIntent) {
            return
        }

        if (!force && targetIntent === lastProcessedIntent) {
            return
        }
        
        val sharedData = mutableMapOf<String, Any?>()
        sharedData["mimeType"] = targetIntent.type ?: "text/plain"

        targetIntent.getStringExtra(Intent.EXTRA_TEXT)?.let {
            sharedData["text"] = it
        }

        targetIntent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { uri ->
            sharedData["uri"] = uri.toString()
            sharedData["fileName"] = getFileName(uri)
        }

        if (sharedData.isNotEmpty()) {
            pendingSharedContent = sharedData
            lastProcessedIntent = targetIntent
            Log.d(TAG, "Emitting onShareReceived")
            sendEvent("onShareReceived", sharedData)
        }
    }
    private fun getFileName(uri: Uri): String? {
        var result: String? = null
        if (uri.scheme == "content") {
            val cursor = appContext.reactContext?.contentResolver?.query(uri, null, null, null, null)
            try {
                if (cursor != null && cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (index >= 0) {
                        result = cursor.getString(index)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to resolve file name: ${e.message}")
            } finally {
                cursor?.close()
            }
        }
        if (result == null) {
            result = uri.path
            val cut = result?.lastIndexOf('/')
            if (cut != null && cut != -1) {
                result = result.substring(cut + 1)
            }
        }
        return result
    }
}
