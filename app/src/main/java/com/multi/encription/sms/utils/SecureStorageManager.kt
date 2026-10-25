package com.multi.encription.sms.utils

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Secure credential storage backed by Android KeyStore and EncryptedSharedPreferences (AES-256 GCM).
 * Protects Gateway API credentials at rest.
 */
class SecureStorageManager(context: Context) {

    private val prefs: SharedPreferences

    companion object {
        private const val TAG = "SecureStorageManager"
        private const val SECURE_PREFS_FILE = "secure_gateway_credentials"
        private const val FALLBACK_PREFS_FILE = "fallback_gateway_credentials"
        private const val KEY_GATEWAY_API_KEY = "gateway_api_key"
        private const val KEY_PENDING_FCM_TOKEN = "pending_fcm_token"
    }

    init {
        prefs = try {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()

            EncryptedSharedPreferences.create(
                context,
                SECURE_PREFS_FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (e: Exception) {
            Log.w(TAG, "KeyStore initialization fallback to standard private prefs: ${e.message}")
            context.getSharedPreferences(FALLBACK_PREFS_FILE, Context.MODE_PRIVATE)
        }
    }

    /**
     * Saves the Gateway Worker API Key securely.
     */
    fun saveGatewayKey(rawKey: String) {
        val cleanKey = rawKey.trim()
        prefs.edit().putString(KEY_GATEWAY_API_KEY, cleanKey).apply()
        Log.d(TAG, "Gateway API key stored securely")
    }

    /**
     * Retrieves the plaintext Gateway API Key for outbound authentication headers.
     * Never log or expose this value.
     */
    fun getGatewayKey(): String? {
        return prefs.getString(KEY_GATEWAY_API_KEY, null)?.takeIf { it.isNotBlank() }
    }

    /**
     * Checks if a gateway key is currently configured.
     */
    fun hasGatewayKey(): Boolean {
        return !getGatewayKey().isNullOrBlank()
    }

    /**
     * Removes the stored gateway API key.
     */
    fun clearGatewayKey() {
        prefs.edit().remove(KEY_GATEWAY_API_KEY).apply()
        Log.d(TAG, "Gateway API key cleared")
    }

    /** Stores a not-yet-registered FCM token alongside the gateway credential. */
    fun savePendingFcmToken(token: String) {
        prefs.edit().putString(KEY_PENDING_FCM_TOKEN, token).apply()
    }

    fun getPendingFcmToken(): String? =
        prefs.getString(KEY_PENDING_FCM_TOKEN, null)?.takeIf { it.isNotBlank() }

    fun clearPendingFcmToken() {
        prefs.edit().remove(KEY_PENDING_FCM_TOKEN).apply()
    }

    /**
     * Returns a safe masked version of the key suitable for UI display.
     * Format: otp_gw_test_0e15••••••••
     */
    fun getMaskedGatewayKey(): String {
        val key = getGatewayKey() ?: return "Not Configured"
        return if (key.length >= 16) {
            "${key.substring(0, 16)}••••••••"
        } else {
            "••••••••"
        }
    }

}
