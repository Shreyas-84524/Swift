package com.multi.encription.sms.network

import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonSyntaxException
import com.multi.encription.sms.utils.ConfigManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Robust HTTPS API Client for the Global OTP Gateway Platform.
 * Communicates with the Vercel backend over TLS with structured error handling.
 */
class GlobalGatewayApiClient(private val configManager: ConfigManager) {

    private val gson = Gson()
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    companion object {
        private const val TAG = "GlobalGatewayApiClient"
        private const val HEADER_GATEWAY_KEY = "X-Gateway-Key"
    }

    /**
     * Probes the health check endpoint (GET /api/v1/health).
     * Does not require authentication.
     */
    suspend fun checkHealth(): ApiResult<HealthCheckResponse> = withContext(Dispatchers.IO) {
        val baseUrl = configManager.globalBackendUrl
        val url = "$baseUrl/api/v1/health"

        val request = Request.Builder()
            .url(url)
            .get()
            .build()

        try {
            httpClient.newCall(request).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                if (response.isSuccessful) {
                    val health = gson.fromJson(bodyStr, HealthCheckResponse::class.java)
                    ApiResult.Success(health)
                } else {
                    ApiResult.HttpError(response.code, "Health probe failed with HTTP ${response.code}: $bodyStr")
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "Network failure probing health check: ${e.message}")
            ApiResult.NetworkError(e, "Cannot reach backend: ${e.message}")
        } catch (e: Exception) {
            Log.e(TAG, "Unexpected error probing health check", e)
            ApiResult.NetworkError(e, "Unexpected error: ${e.message}")
        }
    }

    /**
     * Atomically claims pending SMS dispatch jobs from the queue (GET /api/v1/gateway/jobs).
     */
    suspend fun claimJobs(limit: Int = 1, leaseSeconds: Int = 60): ApiResult<List<ClaimedJobDto>> = withContext(Dispatchers.IO) {
        val gatewayKey = configManager.secureStorage.getGatewayKey()
        if (gatewayKey.isNullOrBlank()) {
            return@withContext ApiResult.AuthError(401, "Gateway API key is not configured on this device")
        }

        val baseUrl = configManager.globalBackendUrl
        val url = "$baseUrl/api/v1/gateway/jobs?limit=$limit&lease_seconds=$leaseSeconds"

        val request = Request.Builder()
            .url(url)
            .addHeader(HEADER_GATEWAY_KEY, gatewayKey)
            .get()
            .build()

        try {
            httpClient.newCall(request).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                when {
                    response.isSuccessful -> {
                        val parsed = gson.fromJson(bodyStr, GatewayJobsResponse::class.java)
                        val jobs = parsed.data?.jobs ?: emptyList()
                        ApiResult.Success(jobs)
                    }
                    response.code == 401 || response.code == 403 -> {
                        Log.w(TAG, "Authentication failed during job claim (HTTP ${response.code})")
                        ApiResult.AuthError(response.code, "Invalid or revoked Gateway API key")
                    }
                    else -> {
                        ApiResult.HttpError(response.code, "Failed to claim jobs (HTTP ${response.code})")
                    }
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "Network error claiming jobs: ${e.message}")
            ApiResult.NetworkError(e, "Network unavailable during job claim: ${e.message}")
        } catch (e: Exception) {
            Log.e(TAG, "Error claiming jobs", e)
            ApiResult.NetworkError(e, "Unexpected error: ${e.message}")
        }
    }

    /**
     * Reports SMS delivery state changes back to the cloud (POST /api/v1/gateway/jobs/{jobId}/status).
     */
    suspend fun updateJobStatus(
        jobId: String,
        status: String,
        errorCode: String? = null,
        errorMessage: String? = null
    ): ApiResult<Boolean> = withContext(Dispatchers.IO) {
        val gatewayKey = configManager.secureStorage.getGatewayKey()
        if (gatewayKey.isNullOrBlank()) {
            return@withContext ApiResult.AuthError(401, "Gateway API key is not configured on this device")
        }

        val baseUrl = configManager.globalBackendUrl
        val url = "$baseUrl/api/v1/gateway/jobs/$jobId/status"

        val payload = JobStatusUpdateRequest(
            status = status,
            errorCode = errorCode,
            errorMessage = errorMessage,
            dispatchedAt = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply {
                timeZone = java.util.TimeZone.getTimeZone("UTC")
            }.format(java.util.Date())
        )

        val jsonBody = gson.toJson(payload)
        val request = Request.Builder()
            .url(url)
            .addHeader(HEADER_GATEWAY_KEY, gatewayKey)
            .post(jsonBody.toRequestBody(jsonMediaType))
            .build()

        try {
            httpClient.newCall(request).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                when {
                    response.isSuccessful -> {
                        Log.d(TAG, "Status updated to $status for job $jobId")
                        ApiResult.Success(true)
                    }
                    response.code == 401 || response.code == 403 -> {
                        Log.w(TAG, "Authentication failed during status update for job $jobId (HTTP ${response.code})")
                        ApiResult.AuthError(response.code, "Invalid or revoked Gateway API key")
                    }
                    else -> {
                        Log.w(TAG, "HTTP error updating status for job $jobId: ${response.code} $bodyStr")
                        ApiResult.HttpError(response.code, "Failed status update (HTTP ${response.code})")
                    }
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "Network error updating status for job $jobId: ${e.message}")
            ApiResult.NetworkError(e, "Network error updating status: ${e.message}")
        } catch (e: Exception) {
            Log.e(TAG, "Error updating status for job $jobId", e)
            ApiResult.NetworkError(e, "Unexpected error: ${e.message}")
        }
    }

    /**
     * Sends device health telemetry & heartbeat (POST /api/v1/gateway/heartbeat).
     */
    suspend fun sendHeartbeat(heartbeat: GatewayHeartbeatRequest): ApiResult<HeartbeatData> = withContext(Dispatchers.IO) {
        val gatewayKey = configManager.secureStorage.getGatewayKey()
        if (gatewayKey.isNullOrBlank()) {
            return@withContext ApiResult.AuthError(401, "Gateway API key is not configured on this device")
        }

        val baseUrl = configManager.globalBackendUrl
        val url = "$baseUrl/api/v1/gateway/heartbeat"

        val jsonBody = gson.toJson(heartbeat)
        val request = Request.Builder()
            .url(url)
            .addHeader(HEADER_GATEWAY_KEY, gatewayKey)
            .post(jsonBody.toRequestBody(jsonMediaType))
            .build()

        try {
            httpClient.newCall(request).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                when {
                    response.isSuccessful -> {
                        val parsed = gson.fromJson(bodyStr, GatewayHeartbeatResponse::class.java)
                        ApiResult.Success(parsed.data ?: HeartbeatData())
                    }
                    response.code == 401 || response.code == 403 -> {
                        ApiResult.AuthError(response.code, "Invalid or revoked Gateway API key")
                    }
                    else -> {
                        ApiResult.HttpError(response.code, "Heartbeat failed (HTTP ${response.code})")
                    }
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "Network error sending heartbeat: ${e.message}")
            ApiResult.NetworkError(e, "Network error sending heartbeat: ${e.message}")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending heartbeat", e)
            ApiResult.NetworkError(e, "Unexpected error: ${e.message}")
        }
    }

    /**
     * Registers or rotates the FCM push token for this gateway worker (PUT /api/v1/gateway/push-token).
     */
    suspend fun registerPushToken(request: RegisterPushTokenRequest): ApiResult<RegisterPushTokenData> = withContext(Dispatchers.IO) {
        val gatewayKey = configManager.secureStorage.getGatewayKey()
        if (gatewayKey.isNullOrBlank()) {
            return@withContext ApiResult.AuthError(401, "Gateway API key is not configured on this device")
        }

        val baseUrl = configManager.globalBackendUrl
        val url = "$baseUrl/api/v1/gateway/push-token"

        val jsonBody = gson.toJson(request)
        val httpRequest = Request.Builder()
            .url(url)
            .addHeader(HEADER_GATEWAY_KEY, gatewayKey)
            .put(jsonBody.toRequestBody(jsonMediaType))
            .build()

        try {
            httpClient.newCall(httpRequest).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                when {
                    response.isSuccessful -> {
                        val parsed = gson.fromJson(bodyStr, RegisterPushTokenResponse::class.java)
                        ApiResult.Success(parsed.data ?: RegisterPushTokenData(registered = true))
                    }
                    response.code == 401 || response.code == 403 -> {
                        Log.w(TAG, "Push token registration unauthorized (HTTP ${response.code})")
                        ApiResult.AuthError(response.code, "Invalid or revoked Gateway API key")
                    }
                    response.code == 409 -> {
                        Log.w(TAG, "Push token conflict: token registered to another gateway (HTTP 409)")
                        ApiResult.HttpError(409, "Push token already registered to another gateway device")
                    }
                    else -> {
                        Log.w(TAG, "Push token registration failed with HTTP ${response.code}")
                        ApiResult.HttpError(response.code, "Registration failed (HTTP ${response.code})")
                    }
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "Network error registering push token: ${e.message}")
            ApiResult.NetworkError(e, "Network unavailable during push token registration: ${e.message}")
        } catch (e: Exception) {
            Log.e(TAG, "Unexpected error registering push token", e)
            ApiResult.NetworkError(e, "Unexpected error: ${e.message}")
        }
    }

    /**
     * Invalidates active push tokens for this gateway (DELETE /api/v1/gateway/push-token).
     * Token is never included in the URL to prevent server log leaks.
     */
    suspend fun unregisterPushToken(): ApiResult<UnregisterPushTokenData> = withContext(Dispatchers.IO) {
        val gatewayKey = configManager.secureStorage.getGatewayKey()
        if (gatewayKey.isNullOrBlank()) {
            return@withContext ApiResult.AuthError(401, "Gateway API key is not configured on this device")
        }

        val baseUrl = configManager.globalBackendUrl
        val url = "$baseUrl/api/v1/gateway/push-token"

        val httpRequest = Request.Builder()
            .url(url)
            .addHeader(HEADER_GATEWAY_KEY, gatewayKey)
            .delete()
            .build()

        try {
            httpClient.newCall(httpRequest).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                when {
                    response.isSuccessful -> {
                        val parsed = gson.fromJson(bodyStr, UnregisterPushTokenResponse::class.java)
                        ApiResult.Success(parsed.data ?: UnregisterPushTokenData(invalidated = true))
                    }
                    response.code == 401 || response.code == 403 -> {
                        ApiResult.AuthError(response.code, "Invalid or revoked Gateway API key")
                    }
                    else -> {
                        ApiResult.HttpError(response.code, "Token invalidation failed (HTTP ${response.code})")
                    }
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "Network error invalidating push token: ${e.message}")
            ApiResult.NetworkError(e, "Network error invalidating push token: ${e.message}")
        } catch (e: Exception) {
            Log.e(TAG, "Unexpected error invalidating push token", e)
            ApiResult.NetworkError(e, "Unexpected error: ${e.message}")
        }
    }
}
