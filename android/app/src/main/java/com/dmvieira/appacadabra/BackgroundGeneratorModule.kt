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
    fun resume(jobId: String, promise: Promise) {
        // Called from JS reconcile at boot when a `processing` pending_jobs
        // row exists but the native side no longer reports the job as
        // running. Starts the FGS with `taskKey='resume'` — the JS-side
        // task reads pending_jobs and re-drives the state machine from the
        // last completed stage.
        try {
            activeJobIds.add(jobId)
            val intent = Intent(reactContext, BackgroundGeneratorService::class.java).apply {
                putExtra(BackgroundGeneratorService.EXTRA_TASK_KEY, "resume")
                putExtra(
                    BackgroundGeneratorService.EXTRA_PARAMS_JSON,
                    org.json.JSONObject().put("jobId", jobId).toString(),
                )
            }
            reactContext.startForegroundService(intent)
            // Re-arm the watchdog so a killed resume also gets retried.
            BackgroundGeneratorWorker.enqueue(reactContext, jobId, null)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("BG_GEN_RESUME", e.message, e)
        }
    }

    @ReactMethod
    fun cancel(jobId: String, promise: Promise) {
        activeJobIds.remove(jobId)
        BackgroundGeneratorWorker.cancel(reactContext, jobId)
        // The JS task checks a cancellation flag between stages once the
        // state machine executor lands. For now the service stops on its own
        // when the task completes.
        promise.resolve(null)
    }

    /**
     * Called from the JS-side task on terminal outcomes (complete/failed) so
     * the WorkManager watchdog doesn't fire uselessly 20 min later. Exposed
     * as a `@ReactMethod` so the HeadlessJS task can invoke it directly.
     */
    @ReactMethod
    fun clearWatchdog(jobId: String, promise: Promise) {
        activeJobIds.remove(jobId)
        BackgroundGeneratorWorker.cancel(reactContext, jobId)
        promise.resolve(null)
    }

    /**
     * Called from the JS store's onCompleted/onFailed handlers to explicitly
     * tear down the FGS. Relying on HeadlessJsTaskService.onHeadlessJsTaskFinish
     * to stop the service (and thus dismiss the ongoing "Conjurando Feitiço"
     * notification) proved unreliable under the New Architecture and on some
     * OEM ROMs — the pipeline finishes but the notification lingers. This
     * mirrors the WebViewAiKeepAliveModule.release() pattern: JS knows exactly
     * when the job is done, so it drives the stopService directly, which
     * triggers Service.onDestroy → dismissNotification synchronously.
     */
    @ReactMethod
    fun finishJob(jobId: String, promise: Promise) {
        activeJobIds.remove(jobId)
        BackgroundGeneratorWorker.cancel(reactContext, jobId)
        val intent = Intent(reactContext, BackgroundGeneratorService::class.java)
        reactContext.stopService(intent)
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
        // Watchdog insurance: if the FGS is killed before it finishes, the
        // worker fires after 20 min and resumes from the last persisted
        // stage. Cancelled from the JS task via `clearWatchdog` on
        // completion/failure so happy-path jobs never hit it.
        BackgroundGeneratorWorker.enqueue(reactContext, jobId, titleHint)
    }
}
