package ai.appacadabra.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class AlarmModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "AlarmModule"

    private fun buildPendingIntent(context: Context, id: String, title: String, message: String): PendingIntent {
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            putExtra("id", id)
            putExtra("title", title)
            putExtra("message", message)
        }
        val requestCode = id.hashCode()
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    @ReactMethod
    fun scheduleAlarm(id: String, title: String, message: String, timeMs: Double, promise: Promise) {
        try {
            val context = reactApplicationContext
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pendingIntent = buildPendingIntent(context, id, title, message)

            // setAndAllowWhileIdle: fires even in Doze mode (~15 min tolerance acceptable)
            alarmManager.setAndAllowWhileIdle(
                AlarmManager.RTC_WAKEUP,
                timeMs.toLong(),
                pendingIntent
            )

            promise.resolve(id)
        } catch (e: Exception) {
            promise.reject("ALARM_SCHEDULE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun cancelAlarm(id: String, promise: Promise) {
        try {
            val context = reactApplicationContext
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pendingIntent = buildPendingIntent(context, id, "", "")
            alarmManager.cancel(pendingIntent)
            promise.resolve(id)
        } catch (e: Exception) {
            promise.reject("ALARM_CANCEL_ERROR", e.message, e)
        }
    }
}
