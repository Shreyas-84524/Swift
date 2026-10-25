package com.multi.encription.sms.worker

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.util.Log
import com.multi.encription.sms.engine.DrainSource
import com.multi.encription.sms.engine.JobDrainEngine
import com.multi.encription.sms.network.GatewayHeartbeatRequest
import com.multi.encription.sms.network.GlobalGatewayApiClient
import com.multi.encription.sms.utils.ConfigManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Observable UI state for the Global Worker Dashboard.
 */
data class WorkerUiState(
    val isRunning: Boolean = false,
    val backendStatus: BackendConnectionStatus = BackendConnectionStatus.UNKNOWN,
    val lastSyncTimestamp: Long = 0L,
    val lastClaimedJobId: String? = null,
    val lastSmsStatus: String? = null,
    val simStatus: String = "UNKNOWN",
    val activeJobsInFlight: Int = 0,
    val statusMessage: String = "Idle"
)

enum class BackendConnectionStatus {
    CONNECTED,
    OFFLINE,
    AUTH_ERROR,
    SERVER_ERROR,
    UNKNOWN
}

/**
 * Event-Driven Global Gateway Worker.
 * Handles app-start reconciliation, manual synchronization requests, and periodic health heartbeats.
 * Continuous polling has been removed in favor of high-priority FCM wake-up events.
 */
class GlobalGatewayWorker(
    private val context: Context,
    private val configManager: ConfigManager,
    private val scope: CoroutineScope
) {

    private val apiClient = GlobalGatewayApiClient(configManager)
    private val drainEngine = JobDrainEngine.getInstance(context)

    private var heartbeatJob: Job? = null

    private val _uiState = MutableStateFlow(WorkerUiState())
    val uiState: StateFlow<WorkerUiState> = _uiState.asStateFlow()

    companion object {
        private const val TAG = "GlobalGatewayWorker"
        private const val HEARTBEAT_INTERVAL_MS = 60_000L
    }

    /**
     * Starts the gateway worker in event-driven mode.
     * Executes a one-time reconciliation drain for any pending jobs queued while the device was sleeping/offline,
     * and initializes the background heartbeat loop. Continuous short-interval polling is disabled.
     */
    fun start() {
        if (_uiState.value.isRunning) {
            Log.d(TAG, "Global Gateway Worker is already running")
            return
        }

        Log.i(TAG, "Starting Event-Driven Global Gateway Worker...")
        _uiState.value = _uiState.value.copy(
            isRunning = true,
            statusMessage = "Event-driven mode active (Waiting for FCM push)",
            simStatus = getSimStatusString()
        )

        // Perform one-time app start reconciliation
        scope.launch {
            drainQueuedJobs(DrainSource.APP_START_RECONCILIATION)
        }

        startHeartbeatLoop()
    }

    /**
     * Stops worker and heartbeat coroutines.
     */
    fun stop() {
        Log.i(TAG, "Stopping Global Gateway Worker...")
        heartbeatJob?.cancel()
        heartbeatJob = null

        _uiState.value = _uiState.value.copy(
            isRunning = false,
            statusMessage = "Worker stopped"
        )
    }

    /**
     * Triggers an immediate manual queue drain.
     */
    fun syncNow() {
        scope.launch {
            Log.d(TAG, "Manual Sync requested")
            drainQueuedJobs(DrainSource.MANUAL_SYNC)
        }
    }

    /**
     * Executes single-flight queue draining through the unified JobDrainEngine.
     */
    suspend fun drainQueuedJobs(source: DrainSource = DrainSource.MANUAL_SYNC): Int {
        if (!configManager.secureStorage.hasGatewayKey()) {
            _uiState.value = _uiState.value.copy(
                backendStatus = BackendConnectionStatus.AUTH_ERROR,
                statusMessage = "Missing Gateway API Key"
            )
            return 0
        }

        _uiState.value = _uiState.value.copy(
            statusMessage = "Draining queue ($source)..."
        )

        val summary = drainEngine.drainQueue(source)
        val now = System.currentTimeMillis()

        _uiState.value = _uiState.value.copy(
            backendStatus = BackendConnectionStatus.CONNECTED,
            lastSyncTimestamp = now,
            statusMessage = if (summary.jobsDispatched > 0) {
                "Dispatched ${summary.jobsDispatched} SMS job(s)"
            } else if (summary.duplicatesSkipped > 0) {
                "Skipped ${summary.duplicatesSkipped} duplicate job(s)"
            } else {
                "Connected (Idle - 0 queued jobs)"
            }
        )

        return summary.jobsDispatched
    }

    private fun startHeartbeatLoop() {
        heartbeatJob = scope.launch {
            while (isActive) {
                try {
                    sendHeartbeatInternal()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.w(TAG, "Error during heartbeat: ${e.message}")
                }
                delay(HEARTBEAT_INTERVAL_MS)
            }
        }
    }

    private suspend fun sendHeartbeatInternal() {
        if (!configManager.secureStorage.hasGatewayKey()) return

        val batteryPct = getBatteryPercentage()
        val simStatus = getSimStatusString()

        val heartbeat = GatewayHeartbeatRequest(
            model = "${Build.MANUFACTURER} ${Build.MODEL}",
            androidSdk = Build.VERSION.SDK_INT,
            appVersion = "1.0",
            simStatus = simStatus,
            batteryPct = batteryPct,
            workerEnabled = configManager.isWorkerEnabled
        )

        apiClient.sendHeartbeat(heartbeat)
    }

    private fun getBatteryPercentage(): Int? {
        return try {
            val batteryStatus: Intent? = IntentFilter(Intent.ACTION_BATTERY_CHANGED).let { filter ->
                context.registerReceiver(null, filter)
            }
            val level: Int = batteryStatus?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale: Int = batteryStatus?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            if (level >= 0 && scale > 0) {
                (level * 100 / scale)
            } else null
        } catch (e: Exception) {
            null
        }
    }

    private fun getSimStatusString(): String {
        return try {
            val diag = com.multi.encription.sms.telephony.SubscriptionHelper.getSubscriptionDiagnostics(context, configManager)
            if (diag.resolvedSubId > 0) {
                "${diag.simState} (${diag.carrierName}, Sub: ${diag.resolvedSubId})"
            } else {
                diag.simState
            }
        } catch (e: Exception) {
            "UNKNOWN"
        }
    }
}
