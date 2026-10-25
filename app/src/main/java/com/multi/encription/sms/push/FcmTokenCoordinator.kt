package com.multi.encription.sms.push

import android.annotation.SuppressLint
import android.content.Context
import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import com.multi.encription.sms.BuildConfig
import com.multi.encription.sms.models.GatewayMode
import com.multi.encription.sms.network.ApiResult
import com.multi.encription.sms.network.GlobalGatewayApiClient
import com.multi.encription.sms.network.RegisterPushTokenRequest
import com.multi.encription.sms.utils.ConfigManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.security.MessageDigest
import java.util.UUID
import kotlin.coroutines.resume

sealed class TokenSyncResult {
    object Success : TokenSyncResult()
    object AlreadyUpToDate : TokenSyncResult()
    data class Deferred(val reason: String) : TokenSyncResult()
    data class Error(val code: Int?, val message: String) : TokenSyncResult()
    data class Conflict(val message: String) : TokenSyncResult()
}

data class PushTokenUiState(
    val isRegistered: Boolean = false,
    val tokenMasked: String = "Not Registered",
    val lastRegisteredAt: Long = 0L,
    val statusMessage: String = "Idle"
)

interface IFcmTokenCoordinator {
    val state: StateFlow<PushTokenUiState>
    suspend fun onNewToken(token: String): TokenSyncResult
    suspend fun syncToken(): TokenSyncResult
    suspend fun onGatewayConfigUpdated(): TokenSyncResult
    suspend fun unregisterPushToken(): Boolean
    fun getInstallationFingerprint(): String
}

class FcmTokenCoordinator(
    private val context: Context,
    private val configManager: ConfigManager,
    private val apiClient: GlobalGatewayApiClient
) : IFcmTokenCoordinator {

    companion object {
        @SuppressLint("StaticFieldLeak")
        @Volatile
        private var INSTANCE: FcmTokenCoordinator? = null

        private const val TAG = "FcmTokenCoordinator"
        private const val PREFS_NAME = "fcm_token_cache"
        private const val KEY_CACHED_TOKEN_HASH = "cached_token_hash"
        private const val KEY_CACHED_KEY_HASH = "cached_key_hash"
        private const val KEY_CACHED_BACKEND_URL = "cached_backend_url"
        private const val KEY_CACHED_APP_VERSION = "cached_app_version"
        private const val KEY_LAST_REG_TIMESTAMP = "last_reg_timestamp"
        private const val KEY_INSTALLATION_FP = "installation_fp"

        fun getInstance(
            context: Context,
            configManager: ConfigManager = ConfigManager(context.applicationContext),
            apiClient: GlobalGatewayApiClient = GlobalGatewayApiClient(configManager)
        ): FcmTokenCoordinator {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: FcmTokenCoordinator(
                    context.applicationContext,
                    configManager,
                    apiClient
                ).also { INSTANCE = it }
            }
        }

        @androidx.annotation.VisibleForTesting
        fun resetForTesting() {
            synchronized(this) {
                INSTANCE = null
            }
        }
    }

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val _state = MutableStateFlow(PushTokenUiState())
    override val state: StateFlow<PushTokenUiState> = _state.asStateFlow()

    init {
        // Initialize state from existing cache if present
        val cachedTokenHash = prefs.getString(KEY_CACHED_TOKEN_HASH, null)
        val lastTimestamp = prefs.getLong(KEY_LAST_REG_TIMESTAMP, 0L)
        if (!cachedTokenHash.isNullOrBlank() && lastTimestamp > 0L) {
            _state.value = PushTokenUiState(
                isRegistered = true,
                tokenMasked = "Registered (${cachedTokenHash.take(8)})",
                lastRegisteredAt = lastTimestamp,
                statusMessage = "Active"
            )
        }
    }

    override fun getInstallationFingerprint(): String {
        var fp = prefs.getString(KEY_INSTALLATION_FP, null)
        if (fp.isNullOrBlank()) {
            fp = "inst_" + UUID.randomUUID().toString().replace("-", "").take(32)
            prefs.edit().putString(KEY_INSTALLATION_FP, fp).apply()
        }
        return fp
    }

    override suspend fun onNewToken(token: String): TokenSyncResult {
        Log.i(TAG, "New push token received; registration synchronization requested")
        cachePendingToken(token)
        return performRegistrationInternal(token, isRetry = false)
    }

    /** Persist synchronously before asynchronous work so process death cannot lose a refresh. */
    fun cachePendingToken(token: String) {
        configManager.secureStorage.savePendingFcmToken(token)
    }

    override suspend fun syncToken(): TokenSyncResult {
        val token = getPendingOrCachedToken() ?: fetchTokenFromFirebase()
        if (token.isNullOrBlank()) {
            Log.d(TAG, "No push token available to synchronize")
            return TokenSyncResult.Deferred("No token available")
        }
        return performRegistrationInternal(token, isRetry = false)
    }

    override suspend fun onGatewayConfigUpdated(): TokenSyncResult {
        Log.d(TAG, "Gateway configuration updated, verifying push token synchronization")
        return syncToken()
    }

    private suspend fun fetchTokenFromFirebase(): String? = withContext(Dispatchers.IO) {
        try {
            suspendCancellableCoroutine { continuation ->
                FirebaseMessaging.getInstance().token
                    .addOnCompleteListener { task ->
                        if (task.isSuccessful && task.result != null) {
                            val token = task.result
                            cachePendingToken(token)
                            continuation.resume(token)
                        } else {
                            Log.w(TAG, "Firebase token retrieval incomplete: ${task.exception?.message}")
                            continuation.resume(null)
                        }
                    }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to retrieve Firebase token: ${e.message}")
            null
        }
    }

    private suspend fun performRegistrationInternal(token: String, isRetry: Boolean): TokenSyncResult = withContext(Dispatchers.IO) {
        // 1. Guard: Gateway API key must exist
        val gatewayKey = configManager.secureStorage.getGatewayKey()
        if (gatewayKey.isNullOrBlank()) {
            Log.d(TAG, "Registration deferred: No Gateway API Key configured")
            _state.value = _state.value.copy(
                isRegistered = false,
                statusMessage = "Deferred: Missing Gateway Key"
            )
            return@withContext TokenSyncResult.Deferred("Gateway Key missing")
        }

        // 2. Guard: Mode check (must be GLOBAL_WORKER)
        if (configManager.gatewayMode != GatewayMode.GLOBAL_WORKER) {
            Log.d(TAG, "Registration deferred: Device in LOCAL_API mode")
            return@withContext TokenSyncResult.Deferred("Device in LOCAL_API mode")
        }

        val backendUrl = configManager.globalBackendUrl
        val appVersion = BuildConfig.VERSION_NAME
        val tokenHash = sha256(token)
        val keyHash = sha256(gatewayKey)

        // 3. Idempotency Check: Avoid redundant backend network calls
        val cachedTokenHash = prefs.getString(KEY_CACHED_TOKEN_HASH, null)
        val cachedKeyHash = prefs.getString(KEY_CACHED_KEY_HASH, null)
        val cachedBackendUrl = prefs.getString(KEY_CACHED_BACKEND_URL, null)
        val cachedAppVersion = prefs.getString(KEY_CACHED_APP_VERSION, null)

        if (!isRetry &&
            tokenHash == cachedTokenHash &&
            keyHash == cachedKeyHash &&
            backendUrl == cachedBackendUrl &&
            appVersion == cachedAppVersion
        ) {
            Log.d(TAG, "Push token is already registered with backend; skipping duplicate registration")
            _state.value = _state.value.copy(
                isRegistered = true,
                tokenMasked = "Registered",
                statusMessage = "Synchronized (Cached)"
            )
            return@withContext TokenSyncResult.AlreadyUpToDate
        }

        // 4. Construct Registration Payload (Zero credentials in body)
        val payload = RegisterPushTokenRequest(
            token = token,
            provider = "FCM",
            platform = "ANDROID",
            deviceFingerprint = getInstallationFingerprint(),
            appVersion = appVersion
        )

        Log.i(TAG, "Registering push token with configured backend")

        // 5. Execute API Call
        when (val result = apiClient.registerPushToken(payload)) {
            is ApiResult.Success -> {
                Log.i(TAG, "Push token successfully registered with backend")
                persistSuccessfulRegistration(tokenHash, keyHash, backendUrl, appVersion)
                _state.value = _state.value.copy(
                    isRegistered = true,
                    tokenMasked = "Registered",
                    lastRegisteredAt = System.currentTimeMillis(),
                    statusMessage = "Registered & Active"
                )
                TokenSyncResult.Success
            }
            is ApiResult.HttpError -> {
                if (result.statusCode == 409) {
                    Log.w(TAG, "HTTP 409 Conflict: Token belongs to another gateway")
                    _state.value = _state.value.copy(
                        isRegistered = false,
                        statusMessage = "Token Conflict (Re-registration required)"
                    )
                    TokenSyncResult.Conflict(result.message)
                } else {
                    Log.w(TAG, "Push token registration failed with HTTP ${result.statusCode}")
                    TokenSyncResult.Error(result.statusCode, result.message)
                }
            }
            is ApiResult.AuthError -> {
                Log.w(TAG, "Push token registration rejected: Invalid Gateway Key (HTTP ${result.statusCode})")
                _state.value = _state.value.copy(
                    isRegistered = false,
                    statusMessage = "Auth Error: Invalid Gateway Key"
                )
                TokenSyncResult.Error(result.statusCode, result.message)
            }
            is ApiResult.NetworkError -> {
                Log.w(TAG, "Network error during push token registration: ${result.message}")
                _state.value = _state.value.copy(
                    statusMessage = "Network Offline (Will retry)"
                )
                TokenSyncResult.Error(null, result.message)
            }
        }
    }

    override suspend fun unregisterPushToken(): Boolean = withContext(Dispatchers.IO) {
        val gatewayKey = configManager.secureStorage.getGatewayKey()
        if (gatewayKey.isNullOrBlank()) {
            clearLocalRegistrationCache()
            return@withContext true
        }

        Log.i(TAG, "De-registering push token with backend using active gateway key")
        val result = apiClient.unregisterPushToken()
        clearLocalRegistrationCache()

        when (result) {
            is ApiResult.Success -> {
                Log.i(TAG, "Push token successfully invalidated on backend")
                _state.value = _state.value.copy(
                    isRegistered = false,
                    tokenMasked = "De-registered",
                    statusMessage = "Invalidated"
                )
                true
            }
            else -> {
                Log.w(TAG, "Push token backend de-registration failed, local cache cleared anyway")
                false
            }
        }
    }

    private fun persistSuccessfulRegistration(
        tokenHash: String,
        keyHash: String,
        backendUrl: String,
        appVersion: String
    ) {
        prefs.edit()
            .putString(KEY_CACHED_TOKEN_HASH, tokenHash)
            .putString(KEY_CACHED_KEY_HASH, keyHash)
            .putString(KEY_CACHED_BACKEND_URL, backendUrl)
            .putString(KEY_CACHED_APP_VERSION, appVersion)
            .putLong(KEY_LAST_REG_TIMESTAMP, System.currentTimeMillis())
            .apply()
        configManager.secureStorage.clearPendingFcmToken()
    }

    private fun clearLocalRegistrationCache() {
        prefs.edit()
            .remove(KEY_CACHED_TOKEN_HASH)
            .remove(KEY_CACHED_KEY_HASH)
            .remove(KEY_CACHED_BACKEND_URL)
            .remove(KEY_CACHED_APP_VERSION)
            .remove(KEY_LAST_REG_TIMESTAMP)
            .apply()
        configManager.secureStorage.clearPendingFcmToken()
    }

    private fun getPendingOrCachedToken(): String? {
        return configManager.secureStorage.getPendingFcmToken()
    }

    private fun sha256(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(input.toByteArray(Charsets.UTF_8))
        return hash.joinToString("") { "%02x".format(it) }
    }
}
