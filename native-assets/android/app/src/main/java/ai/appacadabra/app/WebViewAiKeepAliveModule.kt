package ai.appacadabra.app

import android.content.Intent
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.atomic.AtomicLong

/**
 * Native module bridge for the WebView AI keep-alive facade. Ref-counts
 * WebViewAiKeepAliveService — the FGS starts on the first acquire and stops
 * after the last release, so concurrent AI calls share the same notification.
 */
class WebViewAiKeepAliveModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private val tokenCounter = AtomicLong(0)
    }

    override fun getName(): String = "WebViewAiKeepAlive"

    @ReactMethod
    fun acquire(reason: String?, title: String?, promise: Promise) {
        try {
            val newCount = WebViewAiKeepAliveService.activeCount.incrementAndGet()
            if (newCount == 1) {
                val intent = Intent(reactContext, WebViewAiKeepAliveService::class.java).apply {
                    putExtra(WebViewAiKeepAliveService.EXTRA_TITLE, title)
                }
                ContextCompat.startForegroundService(reactContext, intent)
            }
            val token = "wka-${tokenCounter.incrementAndGet()}"
            promise.resolve(token)
        } catch (e: Exception) {
            // Best-effort: don't let a keep-alive failure kill the AI call.
            WebViewAiKeepAliveService.activeCount.decrementAndGet()
            promise.resolve("")
        }
    }

    @ReactMethod
    fun release(tokenId: String?, promise: Promise) {
        try {
            val newCount = WebViewAiKeepAliveService.activeCount.decrementAndGet()
            if (newCount <= 0) {
                // Guard against under-flow if release is called more times than acquire.
                WebViewAiKeepAliveService.activeCount.set(0)
                val intent = Intent(reactContext, WebViewAiKeepAliveService::class.java)
                reactContext.stopService(intent)
            }
            promise.resolve(null)
        } catch (e: Exception) {
            promise.resolve(null)
        }
    }
}
