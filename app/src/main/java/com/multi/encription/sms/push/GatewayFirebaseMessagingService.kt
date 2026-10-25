package com.multi.encription.sms.push

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.multi.encription.sms.models.GatewayMode
import com.multi.encription.sms.utils.ConfigManager
import com.multi.encription.sms.worker.JobDrainWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class GatewayFirebaseMessagingService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "GatewayFCMService"
        const val EXPECTED_PAYLOAD_TYPE = "JOBS_AVAILABLE"
    }

    private val serviceScope = CoroutineScope(Dispatchers.Default)

    /**
     * Fast-path handler for FCM wake-up data messages (< 500ms execution constraint).
     */
    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val startTime = System.currentTimeMillis()
        val data = remoteMessage.data
        val messageType = data["type"]

        Log.d(TAG, "FCM data message received (type=$messageType, priority=${remoteMessage.priority})")

        // 1. Accept only data messages with type == "JOBS_AVAILABLE"
        if (messageType != EXPECTED_PAYLOAD_TYPE) {
            Log.w(TAG, "Ignoring unrecognized FCM message type: $messageType")
            return
        }

        // 2. Validate gateway worker state
        val configManager = ConfigManager(applicationContext)
        if (configManager.gatewayMode != GatewayMode.GLOBAL_WORKER) {
            Log.d(TAG, "Device in LOCAL_API mode. Dropping push wake signal.")
            return
        }

        if (!configManager.isWorkerEnabled) {
            Log.d(TAG, "Worker toggle is OFF. Dropping push wake signal.")
            return
        }

        if (!configManager.secureStorage.hasGatewayKey()) {
            Log.w(TAG, "No Gateway API key configured. Cannot drain jobs.")
            return
        }

        // 3. Enqueue unique expedited WorkManager task
        JobDrainWorker.enqueueExpedited(applicationContext)

        val duration = System.currentTimeMillis() - startTime
        Log.i(TAG, "FCM onMessageReceived processed and enqueued drain in ${duration}ms")
    }

    /**
     * Invoked when Firebase delivers a new or rotated registration token.
     */
    override fun onNewToken(token: String) {
        Log.i(TAG, "Firebase generated a new push token")
        val coordinator = FcmTokenCoordinator.getInstance(applicationContext)
        coordinator.cachePendingToken(token)
        serviceScope.launch {
            try {
                coordinator.onNewToken(token)
            } catch (e: Exception) {
                Log.e(TAG, "Push-token synchronization failed; the token remains pending")
            }
        }
    }
}
