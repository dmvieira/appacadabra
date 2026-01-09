package com.dmvieira.appacadabra

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class RunnerActivity : ReactActivity() {

    override fun getMainComponentName(): String = "runner"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
            override fun getLaunchOptions(): Bundle? {
                val bundle = Bundle()
                // Extract app ID from intent data
                intent?.data?.let { uri ->
                    val appId = uri.lastPathSegment?.toIntOrNull() ?: -1
                    bundle.putInt("appId", appId)
                }
                return bundle
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }
}
