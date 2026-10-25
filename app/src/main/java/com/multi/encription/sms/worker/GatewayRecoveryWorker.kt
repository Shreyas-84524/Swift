package com.multi.encription.sms.worker

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.multi.encription.sms.engine.DrainSource
import com.multi.encription.sms.engine.JobDrainEngine
import com.multi.encription.sms.models.GatewayMode
import com.multi.encription.sms.network.GatewayHeartbeatRequest
import com.multi.encription.sms.network.GlobalGatewayApiClient
import com.multi.encription.sms.push.FcmTokenCoordinator
import com.multi.encription.sms.utils.ConfigManager
import java.util.concurrent.TimeUnit

class GatewayRecoveryWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    companion object {
        const val UNIQUE_PERIODIC_WORK_NAME = "swift_gateway_recovery"
        private const val TAG = "GatewayRecoveryWorker"

        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            // 15 minutes is the minimum interval enforced by Android WorkManager
            val periodicRequest = PeriodicWorkRequestBuilder<GatewayRecoveryWorker>(
                15, TimeUnit.MINUTES,
                5, TimeUnit.MINUTES
            )
                .setConstraints(constraints)
                .addTag("recovery_fallback")
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_PERIODIC_WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                periodicRequest
            )
            Log.i(TAG, "Scheduled 15-minute periodic recovery worker with ExistingPeriodicWorkPolicy.KEEP")
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_PERIODIC_WORK_NAME)
            Log.i(TAG, "Cancelled periodic recovery worker")
        }
    }

    override suspend fun doWork(): Result {
        val configManager = ConfigManager(applicationContext)

        // Safety guard: only execute recovery if in GLOBAL_WORKER mode and worker is enabled
        if (configManager.gatewayMode != GatewayMode.GLOBAL_WORKER || !configManager.isWorkerEnabled) {
            Log.d(TAG, "Skipping periodic recovery: gateway is disabled or in LOCAL_API mode")
            return Result.success()
        }

        if (!configManager.secureStorage.hasGatewayKey()) {
            Log.w(TAG, "Skipping periodic recovery: no Gateway API key configured")
            return Result.success()
        }

        // Resumes push token registration if a token was received before network connection or across process death
        try {
            val tokenCoordinator = FcmTokenCoordinator.getInstance(applicationContext)
            tokenCoordinator.syncToken()
        } catch (e: Exception) {
            Log.w(TAG, "Non-critical: Token sync during recovery sweep failed: ${e.message}")
        }

        Log.i(TAG, "Executing 15-minute periodic queue recovery sweep...")
        val engine = JobDrainEngine.getInstance(applicationContext)
        val summary = engine.drainQueue(DrainSource.PERIODIC_RECOVERY)

        // Also send periodic heartbeat to backend
        try {
            val apiClient = GlobalGatewayApiClient(configManager)
            apiClient.sendHeartbeat(
                GatewayHeartbeatRequest(
                    model = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}",
                    androidSdk = android.os.Build.VERSION.SDK_INT,
                    appVersion = com.multi.encription.sms.BuildConfig.VERSION_NAME,
                    workerEnabled = true
                )
            )
        } catch (e: Exception) {
            Log.w(TAG, "Non-critical: Heartbeat during recovery sweep failed: ${e.message}")
        }

        Log.i(TAG, "Periodic recovery sweep complete: Claimed=${summary.jobsClaimed}, Dispatched=${summary.jobsDispatched}")
        return if (summary.retryRecommended) Result.retry() else Result.success()
    }
}
