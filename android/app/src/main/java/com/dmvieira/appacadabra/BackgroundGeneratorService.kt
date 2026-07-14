package ai.appacadabra.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Runs the BYOK spell-generation pipeline as a foreground service so an
 * in-flight `create` / `edit` job survives backgrounding. The pipeline itself
 * is the same TypeScript code the app uses in the foreground — we just host
 * it via HeadlessJsTaskService so RN keeps the JS thread alive with a visible
 * ongoing notification (Play Store policy requirement for FGS).
 *
 * Phase 1 does not survive swipe-kill — the JS context dies with the process.
 * That case is handled by the persisted state machine + WorkManager retry
 * planned for Phase 3.
 */
class BackgroundGeneratorService : HeadlessJsTaskService() {

    companion object {
        const val CHANNEL_ID = "spell_generation"
        const val NOTIFICATION_ID = 4242
        const val EXTRA_TASK_KEY = "taskKey"
        const val EXTRA_PARAMS_JSON = "paramsJson"
        const val EXTRA_TITLE = "title"
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundWithNotification(intent?.getStringExtra(EXTRA_TITLE))
        return super.onStartCommand(intent, flags, startId)
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val extras = intent?.extras ?: return null
        val taskKey = extras.getString(EXTRA_TASK_KEY) ?: return null
        val paramsJson = extras.getString(EXTRA_PARAMS_JSON) ?: "{}"

        val data = Arguments.createMap().apply {
            putString("taskKey", taskKey)
            putString("paramsJson", paramsJson)
        }

        // 15-minute cap matches the outer retry budget of the TS pipeline
        // (planner + coder + fix-loop x2 + outer retry x3 at reasoning=high).
        return HeadlessJsTaskConfig(
            "BackgroundGeneratorTask",
            data,
            15L * 60L * 1000L,
            true,
        )
    }

    private fun startForegroundWithNotification(title: String?) {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Spell generation",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Ongoing while Appacadabra generates a spell"
                setShowBadge(false)
            }
            nm.createNotificationChannel(channel)
        }

        val contentIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pending = if (contentIntent != null) {
            PendingIntent.getActivity(
                this,
                0,
                contentIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        } else null

        // Localized title comes from JS (t('generatingApp')/t('updatingApp')).
        // We fall back to the app label rather than an untranslated English
        // string when the caller doesn't provide one.
        val fallbackTitle = try {
            applicationInfo.loadLabel(packageManager).toString()
        } catch (_: Exception) {
            "Appacadabra"
        }
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.notification_icon)
            .setContentTitle(title ?: fallbackTitle)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(pending)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }
}
