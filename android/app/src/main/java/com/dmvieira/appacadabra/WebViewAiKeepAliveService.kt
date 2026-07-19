package ai.appacadabra.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import java.util.concurrent.atomic.AtomicInteger

/**
 * Lightweight foreground service that keeps the RN process alive while a
 * WebView-initiated AI call (AppacadabraAI.*) is in flight. Unlike
 * BackgroundGeneratorService this is NOT a HeadlessJsTaskService — we don't
 * want to spawn a new JS context, we just want to hold the FGS grip so the
 * existing runner's fetch to OpenRouter isn't trimmed under memory pressure.
 *
 * Ref-counted: multiple concurrent AI calls share the same FGS. The module
 * decides when to start/stop based on the shared `activeCount`.
 */
class WebViewAiKeepAliveService : Service() {

    companion object {
        const val CHANNEL_ID = "webview_ai_keep_alive"
        const val NOTIFICATION_ID = 4243
        const val EXTRA_TITLE = "title"

        // Shared with the module — increments/decrements on acquire/release.
        val activeCount = AtomicInteger(0)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundWithNotification(intent?.getStringExtra(EXTRA_TITLE))
        // NOT_STICKY: if the OS kills the process, we don't want a stale
        // keep-alive to resurrect after the fact — the AI call is dead too.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        dismissNotification()
        super.onDestroy()
    }

    private fun dismissNotification() {
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } catch (_: Exception) {
            // Best effort.
        }
        try {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(NOTIFICATION_ID)
        } catch (_: Exception) {
            // Best effort — some OEM ROMs leave the ongoing notification
            // pinned past stopForeground; explicit cancel is our fallback.
        }
    }

    private fun startForegroundWithNotification(title: String?) {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "AI in progress",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Ongoing while a spell is calling AI"
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
