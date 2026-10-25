package com.multi.encription.sms.engine

import android.annotation.SuppressLint
import android.content.Context
import android.util.Log
import com.multi.encription.sms.core.SmsManager
import com.multi.encription.sms.database.SmsDatabase
import com.multi.encription.sms.network.ApiResult
import com.multi.encription.sms.network.ClaimedJobDto
import com.multi.encription.sms.network.GlobalGatewayApiClient
import com.multi.encription.sms.utils.ConfigManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

enum class DrainSource {
    FCM_PUSH,
    PERIODIC_RECOVERY,
    MANUAL_SYNC,
    APP_START_RECONCILIATION
}

data class DrainSummary(
    val jobsClaimed: Int,
    val jobsDispatched: Int,
    val duplicatesSkipped: Int,
    val emptyQueueReached: Boolean,
    val hitSafetyBound: Boolean,
    val retryRecommended: Boolean = false
)

class JobDrainEngine private constructor(private val appContext: Context) {

    private val configManager = ConfigManager(appContext)
    private val apiClient = GlobalGatewayApiClient(configManager)
    private val smsManager = SmsManager(appContext, configManager)
    private val database = SmsDatabase.getDatabase(appContext)
    private val smsDao = database.smsDao()

    private val drainMutex = Mutex()
    private val pendingWorkSignal = AtomicBoolean(false)
    private val inFlightJobIds = ConcurrentHashMap.newKeySet<String>()

    companion object {
        private const val TAG = "JobDrainEngine"
        const val MAX_JOBS_PER_DRAIN_RUN = 25 // Safety bound to prevent runaway loops

        @SuppressLint("StaticFieldLeak")
        @Volatile
        private var INSTANCE: JobDrainEngine? = null

        fun getInstance(context: Context): JobDrainEngine {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: JobDrainEngine(context.applicationContext).also { INSTANCE = it }
            }
        }

        @androidx.annotation.VisibleForTesting
        fun resetForTesting() {
            synchronized(this) {
                INSTANCE = null
            }
        }
    }

    suspend fun drainQueue(source: DrainSource): DrainSummary {
        // Mode & enabled guard: only drain in GLOBAL_WORKER mode when enabled
        if (configManager.gatewayMode != com.multi.encription.sms.models.GatewayMode.GLOBAL_WORKER || !configManager.isWorkerEnabled) {
            Log.d(TAG, "[$source] Skipping drain: gateway is disabled or in LOCAL_API mode")
            return DrainSummary(0, 0, 0, emptyQueueReached = false, hitSafetyBound = false, retryRecommended = false)
        }

        // Enforce single-flight execution
        if (!drainMutex.tryLock()) {
            Log.d(TAG, "[$source] Drain already in progress. Setting pendingWorkSignal = true.")
            pendingWorkSignal.set(true)
            return DrainSummary(0, 0, 0, emptyQueueReached = false, hitSafetyBound = false)
        }

        try {
            var totalClaimed = 0
            var totalDispatched = 0
            var totalDuplicates = 0
            var emptyReached = false
            var hitBound = false
            var retryRecommended = false

            Log.i(TAG, "[$source] Starting single-flight job drain cycle...")

            var keepRunning = true
            while (keepRunning) {
                var cycleJobsCount = 0

                while (cycleJobsCount < MAX_JOBS_PER_DRAIN_RUN) {
                    if (!configManager.secureStorage.hasGatewayKey()) {
                        Log.w(TAG, "[$source] Aborting drain: missing Gateway API key")
                        return DrainSummary(totalClaimed, totalDispatched, totalDuplicates, emptyReached, hitBound)
                    }

                    // 1. Claim single job atomically (lease 60 seconds)
                    val claimResult = apiClient.claimJobs(limit = 1, leaseSeconds = 60)
                    when (claimResult) {
                        is ApiResult.Success -> {
                            val jobs = claimResult.data
                            if (jobs.isEmpty()) {
                                Log.d(TAG, "[$source] Queue drained to 0 jobs.")
                                emptyReached = true
                                break
                            }

                            val job = jobs.first()
                            totalClaimed++
                            cycleJobsCount++

                            // 2. Process job with in-memory & Room deduplication
                            val wasDispatched = processSingleJob(job)
                            if (wasDispatched) {
                                totalDispatched++
                            } else {
                                totalDuplicates++
                            }
                        }
                        is ApiResult.AuthError -> {
                            Log.e(TAG, "[$source] Gateway authentication failed during drain: ${claimResult.message}")
                            return DrainSummary(totalClaimed, totalDispatched, totalDuplicates, emptyReached, hitBound)
                        }
                        is ApiResult.HttpError -> {
                            Log.w(TAG, "[$source] Server HTTP error ${claimResult.statusCode} while claiming a job")
                            retryRecommended = claimResult.statusCode == 429 || claimResult.statusCode >= 500
                            break
                        }
                        is ApiResult.NetworkError -> {
                            Log.w(TAG, "[$source] Network error while claiming a job")
                            retryRecommended = true
                            break
                        }
                    }
                }

                if (cycleJobsCount >= MAX_JOBS_PER_DRAIN_RUN) {
                    Log.w(TAG, "[$source] Reached safety bound of $MAX_JOBS_PER_DRAIN_RUN jobs per drain run.")
                    hitBound = true
                }

                // Check if another wake-up arrived while we were processing this cycle
                keepRunning = pendingWorkSignal.getAndSet(false) && !hitBound
                if (keepRunning) {
                    Log.i(TAG, "[$source] Pending work flag detected. Starting follow-up drain cycle...")
                }
            }

            Log.i(TAG, "[$source] Drain cycle complete: Claimed=$totalClaimed, Dispatched=$totalDispatched, Duplicates=$totalDuplicates")
            return DrainSummary(totalClaimed, totalDispatched, totalDuplicates, emptyReached, hitBound, retryRecommended)

        } catch (e: CancellationException) {
            Log.i(TAG, "[$source] Drain execution cancelled")
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "[$source] Unexpected error during drain execution")
            return DrainSummary(0, 0, 0, emptyQueueReached = false, hitSafetyBound = false, retryRecommended = true)
        } finally {
            drainMutex.unlock()
        }
    }

    private suspend fun processSingleJob(job: ClaimedJobDto): Boolean {
        // Privacy Guard: Never log recipient phone number, OTP, or complete message body
        Log.i(TAG, "Processing claimed job: ${job.jobId} (created: ${job.createdAt})")

        // 1. In-flight memory check to eliminate race conditions
        if (!inFlightJobIds.add(job.jobId)) {
            Log.w(TAG, "Job ${job.jobId} is currently in flight in local memory. Skipping duplicate dispatch.")
            return false
        }

        try {
            // 2. Room database deduplication check
            val alreadyProcessed = smsDao.isJobAlreadyProcessed(job.jobId)
            if (alreadyProcessed) {
                Log.w(TAG, "Job ${job.jobId} already recorded as SENT/DELIVERED in local database. Skipping duplicate dispatch.")
                apiClient.updateJobStatus(job.jobId, "SENT")
                return false
            }

            // 3. Update backend status to SENDING
            apiClient.updateJobStatus(job.jobId, "SENDING")

            // 4. Dispatch SMS via telephony manager
            val sendResult = smsManager.sendSms(
                phoneNumber = job.phoneNumber,
                message = job.message,
                requestId = job.jobId,
                globalJobId = job.jobId
            )

            return if (sendResult.isSuccess) {
                val smsId = sendResult.getOrThrow()
                Log.d(TAG, "Job ${job.jobId} handed to Android telephony stack (local SMS ID: $smsId)")
                true
            } else {
                Log.e(TAG, "Telephony dispatch failed for job ${job.jobId}")
                apiClient.updateJobStatus(
                    job.jobId,
                    "FAILED",
                    "LOCAL_DISPATCH_EXCEPTION",
                    "Telephony dispatch failed locally"
                )
                false
            }
        } finally {
            inFlightJobIds.remove(job.jobId)
        }
    }
}
