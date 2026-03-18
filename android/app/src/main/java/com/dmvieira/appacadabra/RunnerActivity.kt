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

    override fun onResume() {
        super.onResume()
        if (isFirstResume) {
            isFirstResume = false
            return  // Skip initial mount — WebView is already being created
        }
        if (myAppId == -1) return
        try {
            val reactContext = (application as? ReactApplication)
                ?.reactNativeHost?.reactInstanceManager?.currentReactContext
            if (reactContext?.hasActiveReactInstance() == true) {
                val params = Arguments.createMap()
                params.putInt("appId", myAppId)
                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("RUNNER_ACTIVITY_RESUMED", params)
                android.util.Log.d("RunnerActivity", "Emitted RUNNER_ACTIVITY_RESUMED for appId=$myAppId")
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
