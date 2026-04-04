package ai.appacadabra.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.ReactApplication
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.bridge.Arguments
import expo.modules.ReactActivityDelegateWrapper
import expo.modules.splashscreen.SplashScreenManager

class RunnerActivity : ReactActivity() {

    companion object {
        @Volatile var justClosedRunnerAppId: Int = -1
        @Volatile var justClosedTimeMs: Long = 0L
    }

    private var myAppId: Int = -1
    private var isFirstResume = true

    private val finishReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, broadcastIntent: Intent?) {
            val targetAppId = broadcastIntent?.getIntExtra("appId", -1) ?: -1
            android.util.Log.d("RunnerActivity", "Received FINISH_RUNNER broadcast for appId: $targetAppId, my appId: $myAppId")
            
            // Only finish if this broadcast is for THIS specific app
            if (targetAppId == myAppId) {
                android.util.Log.d("RunnerActivity", "AppId matches, finishing...")
                // Use finishAndRemoveTask to properly clean up
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    finishAndRemoveTask()
                } else {
                    finish()
                }
            } else {
                android.util.Log.d("RunnerActivity", "AppId doesn't match, ignoring")
            }
        }
    }

    override fun getMainComponentName(): String = "runner"

    override fun createReactActivityDelegate(): ReactActivityDelegate {
        return ReactActivityDelegateWrapper(
            this,
            BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
            object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
                override fun getLaunchOptions(): Bundle? {
                    val bundle = Bundle()
                    // Try to get appId from intent extra first (explicit intent)
                    var appId = intent?.getIntExtra("appId", -1) ?: -1
                    
                    // Fallback to URI path (deep link intent)
                    if (appId == -1) {
                        intent?.data?.let { uri ->
                            appId = uri.lastPathSegment?.toIntOrNull() ?: -1
                        }
                    }
                    
                    myAppId = appId  // Store for broadcast comparison
                    bundle.putInt("appId", appId)
                    android.util.Log.d("RunnerActivity", "getLaunchOptions appId: $appId")
                    return bundle
                }
            }
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // @generated begin expo-splashscreen - expo prebuild (DO NOT MODIFY)
        SplashScreenManager.registerOnActivity(this)
        // @generated end expo-splashscreen
        super.onCreate(null) // Pass null to avoid state restoration crash
        
        // Register receiver to listen for finish broadcast
        val filter = IntentFilter("ai.appacadabra.app.FINISH_RUNNER")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(finishReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(finishReceiver, filter)
        }
    }

    override fun onPause() {
        super.onPause()
        android.util.Log.d("RunnerActivity", "onPause appId=$myAppId isFinishing=$isFinishing")
        if (isFinishing) {
            // This Runner is closing — signal to the Runner that will resume
            justClosedRunnerAppId = myAppId
            justClosedTimeMs = System.currentTimeMillis()
        }
        // Pause native WebViews explicitly — React Native won't do this because the RN
        // process stays active for other Runner Activities sharing the same JS context.
        // Without this, webView.onResume() in onResume() is a no-op (mPaused stays false).
        pauseWebViewsIn(window.decorView)
    }

    private fun pauseWebViewsIn(view: android.view.View) {
        if (view is android.webkit.WebView) {
            view.onPause()
            return
        }
        if (view is android.view.ViewGroup) {
            for (i in 0 until view.childCount) {
                pauseWebViewsIn(view.getChildAt(i))
            }
        }
    }

    override fun onResume() {
        super.onResume()
        android.util.Log.d("RunnerActivity", "onResume appId=$myAppId isFirstResume=$isFirstResume")
        if (isFirstResume) {
            isFirstResume = false
            return  // Skip initial mount — WebView is already being created
        }
        if (myAppId == -1) return
        // Force native WebView repaint for Runner→Runner transitions
        // (AppState doesn't fire, so React Native doesn't call webView.onResume())
        window.decorView.post { resumeWebViewsIn(window.decorView) }
        emitResumedEvent(0)
    }

    private fun resumeWebViewsIn(view: android.view.View) {
        if (view is android.webkit.WebView) {
            view.onResume()
            view.resumeTimers()
            // Force hardware rendering layer recreation.
            // invalidate() alone is insufficient if the layer texture has become invalid.
            // NONE destroys the GPU texture; HARDWARE recreates it, forcing a redraw.
            view.setLayerType(android.view.View.LAYER_TYPE_NONE, null)
            view.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null)
            view.invalidate()
            return
        }
        if (view is android.view.ViewGroup) {
            for (i in 0 until view.childCount) {
                resumeWebViewsIn(view.getChildAt(i))
            }
        }
    }

    private fun emitResumedEvent(attempt: Int) {
        try {
            val reactContext = (application as? ReactApplication)
                ?.reactHost?.currentReactContext
            if (reactContext?.hasActiveReactInstance() == true) {
                // If another Runner closed recently (< 3s), it's a Runner→Runner transition
                val timeSince = System.currentTimeMillis() - justClosedTimeMs
                val isRunnerToRunner = justClosedRunnerAppId != -1 &&
                                        justClosedRunnerAppId != myAppId &&
                                        timeSince < 3000L
                if (isRunnerToRunner || timeSince >= 3000L) {
                    justClosedRunnerAppId = -1  // Reset after consuming
                }
                val params = Arguments.createMap()
                params.putInt("appId", myAppId)
                params.putBoolean("isRunnerToRunner", isRunnerToRunner)
                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("RUNNER_ACTIVITY_RESUMED", params)
                android.util.Log.d("RunnerActivity", "Emitted RUNNER_ACTIVITY_RESUMED appId=$myAppId isRunnerToRunner=$isRunnerToRunner timeSince=${timeSince}ms")
            } else if (attempt < 5) {
                android.util.Log.w("RunnerActivity", "ReactContext not active, retry ${attempt + 1} in 200ms")
                android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                    emitResumedEvent(attempt + 1)
                }, 200)
            } else {
                android.util.Log.e("RunnerActivity", "Gave up emitting RUNNER_ACTIVITY_RESUMED after $attempt attempts")
            }
        } catch (e: Exception) {
            android.util.Log.e("RunnerActivity", "Failed to emit RUNNER_ACTIVITY_RESUMED", e)
        }
    }

    override fun onDestroy() {
        try {
            unregisterReceiver(finishReceiver)
        } catch (e: Exception) {
            // Receiver might not be registered
        }
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }
    
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val intent = Intent(this, MainActivity::class.java)
        intent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        startActivity(intent)
    }
}
