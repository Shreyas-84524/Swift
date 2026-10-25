package com.multi.encription.sms.worker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.multi.encription.sms.R
import com.multi.encription.sms.engine.DrainSource
import com.multi.encription.sms.engine.JobDrainEngine
import java.util.concurrent.TimeUnit

class JobDrainWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    companion object {
        const val UNIQUE_WORK_NAME = "swift_expedited_job_drain"
        private const val TAG = "JobDrainWorker"
        private const val NOTIFICATION_ID = 2001
        private const val CHANNEL_ID = "swift_job_drain_channel"
        const val MAX_EXECUTION_ATTEMPTS = 3

        fun hasRetryAttemptsRemaining(runAttemptCount: Int): Boolean =
            runAttemptCount < MAX_EXECUTION_ATTEMPTS - 1

        fun enqueueExpedited(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val workRequest = OneTimeWorkRequestBuilder<JobDrainWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setConstraints(constraints)
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    10,
                    TimeUnit.SECONDS
                )
                .addTag("fcm_push_wake")
                .build()

            WorkManager.getInstance(context).enqueueUniqueWork(
                UNIQUE_WORK_NAME,
                ExistingWorkPolicy.KEEP,
                workRequest
            )
        }
    }

    override suspend fun doWork(): Result {
        Log.i(TAG, "JobDrainWorker executing expedited queue drain (attempt=$runAttemptCount)")

        val engine = JobDrainEngine.getInstance(applicationContext)
        val summary = engine.drainQueue(DrainSource.FCM_PUSH)

        Log.i(TAG, "JobDrainWorker finished: Dispatched=${summary.jobsDispatched}, Claimed=${summary.jobsClaimed}, Duplicates=${summary.duplicatesSkipped}")

        if (summary.retryRecommended) {
            if (!hasRetryAttemptsRemaining(runAttemptCount)) {
                Log.w(TAG, "JobDrainWorker reached $MAX_EXECUTION_ATTEMPTS executions; yielding to 15m periodic recovery")
                return Result.failure()
            }
            return Result.retry()
        }

        return Result.success()
    }

    override suspend fun getForegroundInfo(): ForegroundInfo {
        createNotificationChannel()
        val notification: Notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setContentTitle("Swift SMS Gateway")
            .setContentText("Processing incoming SMS dispatch queue...")
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        return ForegroundInfo(NOTIFICATION_ID, notification)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Swift Queue Drain",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Temporary notification while processing SMS dispatch jobs"
                setShowBadge(false)
            }
            val nm = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }
}
