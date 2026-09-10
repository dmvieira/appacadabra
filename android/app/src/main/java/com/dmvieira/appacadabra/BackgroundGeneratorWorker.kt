package ai.appacadabra.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import androidx.work.ExistingWorkPolicy
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * Watchdog worker that resumes a stuck spell-generation job.
 *
 * Enqueued by `BackgroundGeneratorModule.startCreate` / `startEdit` at job
 * start with a delay of [WATCHDOG_DELAY_MINUTES] minutes. On fire it starts
 * `BackgroundGeneratorService` in **resume mode** (`taskKey='resume'`) with
 * only the jobId in the payload — the JS side reads the persisted
 * state-machine row from `pending_jobs` and continues from the last completed
 * stage.
 *
 * The service is idempotent for resumes: if the pipeline is still running
 * (row is `processing` and native module still reports the jobId as
 * `running`), the JS resume path exits without re-driving the state machine.
 *
 * The worker cancels itself once the job is `complete` or `failed`, so the
 * happy path never runs the resume intent. See `Module.cancelWatchdog`.
 */
class BackgroundGeneratorWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val jobId = inputData.getString(KEY_JOB_ID) ?: return Result.failure()
        val title = inputData.getString(KEY_TITLE)

        // Dedup: if the FGS-driven HeadlessJS task is still active for this
        // jobId, firing a resume intent would spawn a parallel task and the
        // success notification would double-post.
        if (BackgroundGeneratorModule.isJobActive(jobId)) {
            return Result.success()
        }

        val intent = Intent(applicationContext, BackgroundGeneratorService::class.java).apply {
            putExtra(BackgroundGeneratorService.EXTRA_TASK_KEY, "resume")
            putExtra(
                BackgroundGeneratorService.EXTRA_PARAMS_JSON,
                JSONObject().put("jobId", jobId).toString(),
            )
            if (!title.isNullOrBlank()) {
                putExtra(BackgroundGeneratorService.EXTRA_TITLE, title)
            }
        }
        applicationContext.startForegroundService(intent)
        return Result.success()
    }

    override suspend fun getForegroundInfo(): ForegroundInfo {
        val nm = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                BackgroundGeneratorService.CHANNEL_ID,
                "Spell generation",
                NotificationManager.IMPORTANCE_LOW,
            )
            nm.createNotificationChannel(channel)
        }
        val notification = NotificationCompat.Builder(
            applicationContext,
            BackgroundGeneratorService.CHANNEL_ID,
        )
            .setSmallIcon(R.drawable.notification_icon)
            .setContentTitle(
                inputData.getString(KEY_TITLE)
                    ?: applicationContext.applicationInfo.loadLabel(applicationContext.packageManager).toString(),
            )
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ForegroundInfo(
                BackgroundGeneratorService.NOTIFICATION_ID,
                notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            ForegroundInfo(BackgroundGeneratorService.NOTIFICATION_ID, notification)
        }
    }

    companion object {
        const val KEY_JOB_ID = "jobId"
        const val KEY_TITLE = "title"
        private const val WATCHDOG_DELAY_MINUTES = 10L

        fun uniqueWorkName(jobId: String): String = "bggen-watchdog-$jobId"

        fun enqueue(context: Context, jobId: String, title: String?) {
            val data = workDataOf(
                KEY_JOB_ID to jobId,
                KEY_TITLE to title,
            )
            val req = OneTimeWorkRequestBuilder<BackgroundGeneratorWorker>()
                .setInitialDelay(WATCHDOG_DELAY_MINUTES, TimeUnit.MINUTES)
                .setInputData(data)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                uniqueWorkName(jobId),
                ExistingWorkPolicy.REPLACE,
                req,
            )
        }

        fun cancel(context: Context, jobId: String) {
            WorkManager.getInstance(context).cancelUniqueWork(uniqueWorkName(jobId))
        }
    }
}
