package com.multi.encription.sms.network

import com.google.gson.annotations.SerializedName

/**
 * Model representing a claimed SMS dispatch job from the global queue.
 */
data class ClaimedJobDto(
    @SerializedName("job_id")
    val jobId: String,

    @SerializedName("phone_number")
    val phoneNumber: String,

    @SerializedName("message")
    val message: String,

    @SerializedName("created_at")
    val createdAt: String,

    @SerializedName("lease_expires_at")
    val leaseExpiresAt: String? = null
)

/**
 * Envelopes for GET /api/v1/gateway/jobs
 */
data class GatewayJobsResponse(
    @SerializedName("success")
    val success: Boolean,

    @SerializedName("data")
    val data: GatewayJobsData? = null,

    @SerializedName("error")
    val error: String? = null
)

data class GatewayJobsData(
    @SerializedName("jobs")
    val jobs: List<ClaimedJobDto> = emptyList()
)

/**
 * Request payload for POST /api/v1/gateway/jobs/{jobId}/status
 */
data class JobStatusUpdateRequest(
    @SerializedName("status")
    val status: String,

    @SerializedName("error_code")
    val errorCode: String? = null,

    @SerializedName("error_message")
    val errorMessage: String? = null,

    @SerializedName("dispatched_at")
    val dispatchedAt: String? = null
)

data class JobStatusUpdateResponse(
    @SerializedName("success")
    val success: Boolean,

    @SerializedName("data")
    val data: Any? = null,

    @SerializedName("error")
    val error: String? = null
)

/**
 * Request payload for POST /api/v1/gateway/heartbeat
 */
data class GatewayHeartbeatRequest(
    @SerializedName("model")
    val model: String? = null,

    @SerializedName("android_sdk")
    val androidSdk: Int? = null,

    @SerializedName("app_version")
    val appVersion: String? = null,

    @SerializedName("sim_status")
    val simStatus: String? = null,

    @SerializedName("battery_pct")
    val batteryPct: Int? = null,

    @SerializedName("worker_enabled")
    val workerEnabled: Boolean? = null
)

data class GatewayHeartbeatResponse(
    @SerializedName("success")
    val success: Boolean,

    @SerializedName("data")
    val data: HeartbeatData? = null,

    @SerializedName("error")
    val error: String? = null
)

data class HeartbeatData(
    @SerializedName("last_seen_at")
    val lastSeenAt: String? = null,

    @SerializedName("backend_timestamp")
    val backendTimestamp: Long? = null
)

/**
 * Response for GET /api/v1/health
 */
data class HealthCheckResponse(
    @SerializedName("status")
    val status: String? = null,

    @SerializedName("version")
    val version: String? = null,

    @SerializedName("timestamp")
    val timestamp: String? = null,

    @SerializedName("services")
    val services: HealthServicesData? = null
)

data class HealthServicesData(
    @SerializedName("database")
    val database: String? = null,

    @SerializedName("queue_depth")
    val queueDepth: Int? = null,

    @SerializedName("active_gateways")
    val activeGateways: Int? = null
)

/**
 * Sealed class representing structured API outcomes for clean UI and worker handling.
 */
sealed class ApiResult<out T> {
    data class Success<out T>(val data: T) : ApiResult<T>()
    data class AuthError(val statusCode: Int, val message: String) : ApiResult<Nothing>()
    data class HttpError(val statusCode: Int, val message: String) : ApiResult<Nothing>()
    data class NetworkError(val exception: Throwable, val message: String) : ApiResult<Nothing>()
}

// ==========================================
// Phase 3: Push Token Models
// ==========================================

data class RegisterPushTokenRequest(
    @SerializedName("token")
    val token: String,

    @SerializedName("provider")
    val provider: String = "FCM",

    @SerializedName("platform")
    val platform: String = "ANDROID",

    @SerializedName("device_fingerprint")
    val deviceFingerprint: String? = null,

    @SerializedName("app_version")
    val appVersion: String? = null
)

data class RegisterPushTokenResponse(
    @SerializedName("success")
    val success: Boolean,

    @SerializedName("data")
    val data: RegisterPushTokenData? = null,

    @SerializedName("error")
    val error: String? = null
)

data class RegisterPushTokenData(
    @SerializedName("registered")
    val registered: Boolean = false,

    @SerializedName("provider")
    val provider: String? = null,

    @SerializedName("platform")
    val platform: String? = null,

    @SerializedName("last_registered_at")
    val lastRegisteredAt: String? = null
)

data class UnregisterPushTokenResponse(
    @SerializedName("success")
    val success: Boolean,

    @SerializedName("data")
    val data: UnregisterPushTokenData? = null,

    @SerializedName("error")
    val error: String? = null
)

data class UnregisterPushTokenData(
    @SerializedName("invalidated")
    val invalidated: Boolean = false,

    @SerializedName("count")
    val count: Int = 0
)
