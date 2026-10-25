package com.multi.encription.sms.engine

import com.multi.encription.sms.R
import com.multi.encription.sms.worker.BackendConnectionStatus

enum class GatewayStatusState {
    NOT_CONFIGURED,
    CONNECTING,
    READY,
    SYNCING,
    OFFLINE,
    AUTH_FAILED,
    SIM_UNAVAILABLE,
    PERMISSIONS_MISSING,
    FCM_UNAVAILABLE,
    WORKER_DISABLED,
    RECOVERY_PENDING
}

enum class GatewayActionType {
    CONFIGURE,
    GRANT_PERMISSIONS,
    CHECK_SIM,
    ENABLE_WORKER,
    SYNC_NOW,
    RETRY_CONNECTION,
    RETRY_PUSH,
    NONE
}

data class GatewayStatusDisplay(
    val state: GatewayStatusState,
    val titleRes: Int,
    val explanationRes: Int,
    val actionRes: Int,
    val actionType: GatewayActionType,
    val isError: Boolean = false,
    val isWarning: Boolean = false
)

object GatewayStateResolver {

    fun resolve(
        hasKey: Boolean,
        hasSmsPermissions: Boolean,
        isSimReady: Boolean,
        isWorkerEnabled: Boolean,
        backendStatus: BackendConnectionStatus,
        isConnecting: Boolean = false,
        isSyncing: Boolean = false,
        isFcmFailed: Boolean = false,
        isRecoveryPending: Boolean = false
    ): GatewayStatusDisplay {
        return when {
            // Priority 1: Key not configured
            !hasKey -> GatewayStatusDisplay(
                state = GatewayStatusState.NOT_CONFIGURED,
                titleRes = R.string.status_not_configured_title,
                explanationRes = R.string.status_not_configured_desc,
                actionRes = R.string.status_not_configured_action,
                actionType = GatewayActionType.CONFIGURE,
                isWarning = true
            )

            // Priority 2: Missing permissions
            !hasSmsPermissions -> GatewayStatusDisplay(
                state = GatewayStatusState.PERMISSIONS_MISSING,
                titleRes = R.string.status_permissions_missing_title,
                explanationRes = R.string.status_permissions_missing_desc,
                actionRes = R.string.status_permissions_missing_action,
                actionType = GatewayActionType.GRANT_PERMISSIONS,
                isError = true
            )

            // Priority 3: SIM unavailable
            !isSimReady -> GatewayStatusDisplay(
                state = GatewayStatusState.SIM_UNAVAILABLE,
                titleRes = R.string.status_sim_unavailable_title,
                explanationRes = R.string.status_sim_unavailable_desc,
                actionRes = R.string.status_sim_unavailable_action,
                actionType = GatewayActionType.CHECK_SIM,
                isError = true
            )

            // Priority 4: Worker is disabled
            !isWorkerEnabled -> GatewayStatusDisplay(
                state = GatewayStatusState.WORKER_DISABLED,
                titleRes = R.string.status_worker_disabled_title,
                explanationRes = R.string.status_worker_disabled_desc,
                actionRes = R.string.status_worker_disabled_action,
                actionType = GatewayActionType.ENABLE_WORKER,
                isWarning = true
            )

            // Priority 5: Authentication failure
            backendStatus == BackendConnectionStatus.AUTH_ERROR -> GatewayStatusDisplay(
                state = GatewayStatusState.AUTH_FAILED,
                titleRes = R.string.status_auth_failed_title,
                explanationRes = R.string.status_auth_failed_desc,
                actionRes = R.string.status_auth_failed_action,
                actionType = GatewayActionType.CONFIGURE,
                isError = true
            )

            // Priority 6: Network Offline
            backendStatus == BackendConnectionStatus.OFFLINE -> GatewayStatusDisplay(
                state = GatewayStatusState.OFFLINE,
                titleRes = R.string.status_offline_title,
                explanationRes = R.string.status_offline_desc,
                actionRes = R.string.status_offline_action,
                actionType = GatewayActionType.RETRY_CONNECTION,
                isWarning = true
            )

            // Priority 7: Active Connection Test / Handshake
            isConnecting -> GatewayStatusDisplay(
                state = GatewayStatusState.CONNECTING,
                titleRes = R.string.status_connecting_title,
                explanationRes = R.string.status_connecting_desc,
                actionRes = R.string.status_connecting_action,
                actionType = GatewayActionType.NONE
            )

            // Priority 8: Active queue sync
            isSyncing -> GatewayStatusDisplay(
                state = GatewayStatusState.SYNCING,
                titleRes = R.string.status_syncing_title,
                explanationRes = R.string.status_syncing_desc,
                actionRes = R.string.status_syncing_action,
                actionType = GatewayActionType.NONE
            )

            // Priority 9: FCM unavailable
            isFcmFailed -> GatewayStatusDisplay(
                state = GatewayStatusState.FCM_UNAVAILABLE,
                titleRes = R.string.status_fcm_unavailable_title,
                explanationRes = R.string.status_fcm_unavailable_desc,
                actionRes = R.string.status_fcm_unavailable_action,
                actionType = GatewayActionType.RETRY_PUSH,
                isWarning = true
            )

            // Priority 10: Recovery pending
            isRecoveryPending -> GatewayStatusDisplay(
                state = GatewayStatusState.RECOVERY_PENDING,
                titleRes = R.string.status_recovery_pending_title,
                explanationRes = R.string.status_recovery_desc,
                actionRes = R.string.status_recovery_pending_action,
                actionType = GatewayActionType.SYNC_NOW
            )

            // Default: Ready & Operational
            else -> GatewayStatusDisplay(
                state = GatewayStatusState.READY,
                titleRes = R.string.status_ready_title,
                explanationRes = R.string.status_ready_desc,
                actionRes = R.string.status_ready_action,
                actionType = GatewayActionType.SYNC_NOW
            )
        }
    }
}
