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

    override fun definition() = ModuleDefinition {
        Name("ShareIntent")

        Events("onShareReceived")

        Function("getSharedContent") {
            return@Function pendingSharedContent
        }

        Function("clearSharedContent") {
            Log.d(TAG, "Clearing pending content")
            pendingSharedContent = null
        }
        
        // No-op for compatibility if JS still calls it
        Function("markAsProcessed") {}

        OnNewIntent {
            Log.d(TAG, "OnNewIntent: " + it?.action)
            // Just update content and emit. 
            // We rely on React Native to handle the event.
            // We rely on 'clearSharedContent' to prevent stale data on reload.
            processIntent(it)
        }

        OnCreate {
            Log.d(TAG, "OnCreate")
            processIntent(null)
        }
    }

    private fun processIntent(intent: Intent?) {
        val currentActivity = appContext.currentActivity
        val targetIntent = intent ?: currentActivity?.intent
        
        Log.d(TAG, "Processing intent: action=" + targetIntent?.action + " type=" + targetIntent?.type)

        if (targetIntent?.action != Intent.ACTION_SEND) {
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
            Log.d(TAG, "Emitting event onShareReceived")
            // Always emit. React side handles duplicates/state if needed, 
            // but usually a user sharing implies they want action.
            sendEvent("onShareReceived", sharedData)
        }
    }
}
