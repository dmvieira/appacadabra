package ai.appacadabra.app

import android.content.Intent
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import org.json.JSONObject

/**
 * Bridge that store.ts calls to schedule spell generation as a foreground
 * job. The Kotlin side does not touch OpenRouter directly — the actual
 * pipeline runs in the JS thread hosted by BackgroundGeneratorService via
 * HeadlessJsTaskService, so we don't need a second implementation of the
 * planner/coder loop or of the BYOK key handling.
 *
 * Currently tracks liveness only via the service lifecycle; per-job stage
 * state lives in `pending_jobs` (see lib/database/db.ts).
 */
class BackgroundGeneratorModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val activeJobIds = mutableSetOf<String>()

    override fun getName(): String = "BackgroundGenerator"

    @ReactMethod
    fun startCreate(params: ReadableMap, promise: Promise) {
        try {
            val jobId = params.getString("jobId")
                ?: return promise.reject("BG_GEN_ARGS", "jobId is required")
            val title = params.getString("notificationTitle") ?: params.getString("prompt")?.take(60)
            startService("create", jobId, params, title)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("BG_GEN_START_CREATE", e.message, e)
        }
    }

    @ReactMethod
    fun startEdit(params: ReadableMap, promise: Promise) {
        try {
            val jobId = params.getString("jobId")
                ?: return promise.reject("BG_GEN_ARGS", "jobId is required")
            val title = params.getString("notificationTitle") ?: params.getString("instruction")?.take(60)
            startService("edit", jobId, params, title)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("BG_GEN_START_EDIT", e.message, e)
        }
    }

    @ReactMethod
    fun cancel(jobId: String, promise: Promise) {
        activeJobIds.remove(jobId)
        // The JS task checks a cancellation flag between stages once the
        // state machine executor lands. For now the service stops on its own
        // when the task completes.
        promise.resolve(null)
    }

    @ReactMethod
    fun status(jobId: String, promise: Promise) {
        val map: WritableMap = Arguments.createMap()
        if (activeJobIds.contains(jobId)) {
            map.putString("state", "running")
        } else {
            map.putString("state", "not-found")
        }
        promise.resolve(map)
    }

    private fun startService(taskKey: String, jobId: String, params: ReadableMap, titleHint: String?) {
        activeJobIds.add(jobId)
        val json = JSONObject(params.toHashMap()).toString()
        val intent = Intent(reactContext, BackgroundGeneratorService::class.java).apply {
            putExtra(BackgroundGeneratorService.EXTRA_TASK_KEY, taskKey)
            putExtra(BackgroundGeneratorService.EXTRA_PARAMS_JSON, json)
            if (!titleHint.isNullOrBlank()) {
                putExtra(BackgroundGeneratorService.EXTRA_TITLE, titleHint)
            }
        }
        reactContext.startForegroundService(intent)
    }
}
