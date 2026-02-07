package expo.modules.shareintent

import android.content.Intent
import android.net.Uri
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

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
                // FLAG_ACTIVITY_NEW_TASK: Start in a new task
                // FLAG_ACTIVITY_CLEAR_TOP: If activity exists, destroy all on top and deliver to it
                // FLAG_ACTIVITY_SINGLE_TOP: Don't recreate if already at top
                intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or 
                               Intent.FLAG_ACTIVITY_CLEAR_TOP or 
                               Intent.FLAG_ACTIVITY_SINGLE_TOP
                currentActivity.startActivity(intent)
                Log.d(TAG, "startRunnerActivity succeeded")
                return@Function true
            } catch (e: Exception) {
                Log.e(TAG, "startRunnerActivity failed: ${e.message}")
                return@Function false
            }
        }
        
        // Native function to open app in NEW window - used by PLAY button
        // Creates separate windows per app using explicit class intent (no URI to intercept)
        Function("openRunnerWindow") { appId: Int ->
            Log.d(TAG, "openRunnerWindow called with appId: $appId")
            val currentActivity = appContext.currentActivity ?: return@Function false
            
            try {
                // Use explicit class intent to avoid any URI-based interception
                val intent = Intent()
                intent.setClassName(currentActivity.packageName, "ai.appacadabra.app.RunnerActivity")
                intent.putExtra("appId", appId)
                // NEW_DOCUMENT creates separate tasks per unique data URI
                // documentLaunchMode="intoExisting" in manifest reuses existing task for same URI
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
                // Set the data URI - same appId = same document = reuse window
                intent.data = Uri.parse("runapp://runner/$appId")
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
        }

        if (sharedData.isNotEmpty()) {
            pendingSharedContent = sharedData
            lastProcessedIntent = targetIntent
            Log.d(TAG, "Emitting onShareReceived")
            sendEvent("onShareReceived", sharedData)
        }
    }
}
