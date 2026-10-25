package com.multi.encription.sms.api

import android.content.Context
import android.util.Log
import com.multi.encription.sms.utils.ConfigManager
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

class AuthenticationManager(context: Context) {
    
    private val configManager = ConfigManager(context)
    private val rateLimitMap = ConcurrentHashMap<String, RateLimitInfo>()
    
    companion object {
        private const val TAG = "AuthenticationManager"
        private const val HEADER_API_KEY = "X-API-Key"
        private const val HEADER_AUTHORIZATION = "Authorization"
        private const val BEARER_PREFIX = "Bearer "
    }
    
    data class RateLimitInfo(
        val minuteCount: AtomicInteger = AtomicInteger(0),
        val hourCount: AtomicInteger = AtomicInteger(0),
        var lastMinuteReset: Long = System.currentTimeMillis(),
        var lastHourReset: Long = System.currentTimeMillis()
    )
    
    data class AuthResult(
        val isAuthenticated: Boolean,
        val errorMessage: String? = null,
        val rateLimited: Boolean = false
    )
    
    fun authenticate(headers: Map<String, String>): AuthResult {
        try {
            // Extract API key from headers
            val apiKey = extractApiKey(headers)
            if (apiKey.isNullOrBlank()) {
                return AuthResult(false, "Missing API key")
            }
            
            // Validate API key
            if (!isValidApiKey(apiKey)) {
                return AuthResult(false, "Invalid API key")
            }
            
            // Check rate limits
            if (configManager.isRateLimitEnabled) {
                val rateLimitResult = checkRateLimit(apiKey)
                if (!rateLimitResult.isAuthenticated) {
                    return rateLimitResult
                }
            }
            
            Log.d(TAG, "Authentication successful")
            return AuthResult(true)
            
        } catch (e: Exception) {
            Log.e(TAG, "Authentication error", e)
            return AuthResult(false, "Authentication error: ${e.message}")
        }
    }
    
    private fun extractApiKey(headers: Map<String, String>): String? {
        // Try X-API-Key header first
        headers[HEADER_API_KEY]?.let { return it }
        
        // Try Authorization header with Bearer token
        headers[HEADER_AUTHORIZATION]?.let { authHeader ->
            if (authHeader.startsWith(BEARER_PREFIX)) {
                return authHeader.substring(BEARER_PREFIX.length)
            }
        }
        
        // Try case-insensitive search
        headers.entries.forEach { (key, value) ->
            when (key.lowercase()) {
                "x-api-key" -> return value
                "authorization" -> {
                    if (value.lowercase().startsWith("bearer ")) {
                        return value.substring(7)
                    }
                }
            }
        }
        
        return null
    }
    
    private fun isValidApiKey(apiKey: String): Boolean {
        val validApiKey = configManager.apiKey
        return apiKey == validApiKey
    }
    
    private fun checkRateLimit(apiKey: String): AuthResult {
        val now = System.currentTimeMillis()
        val rateLimitInfo = rateLimitMap.getOrPut(apiKey) { RateLimitInfo() }
        
        synchronized(rateLimitInfo) {
            // Reset minute counter if needed
            if (now - rateLimitInfo.lastMinuteReset >= 60_000) {
                rateLimitInfo.minuteCount.set(0)
                rateLimitInfo.lastMinuteReset = now
            }
            
            // Reset hour counter if needed
            if (now - rateLimitInfo.lastHourReset >= 3_600_000) {
                rateLimitInfo.hourCount.set(0)
                rateLimitInfo.lastHourReset = now
            }
            
            // Check minute limit
            val currentMinuteCount = rateLimitInfo.minuteCount.get()
            if (currentMinuteCount >= configManager.rateLimitPerMinute) {
                return AuthResult(
                    false,
                    "Rate limit exceeded: ${configManager.rateLimitPerMinute} requests per minute",
                    true
                )
            }
            
            // Check hour limit
            val currentHourCount = rateLimitInfo.hourCount.get()
            if (currentHourCount >= configManager.rateLimitPerHour) {
                return AuthResult(
                    false,
                    "Rate limit exceeded: ${configManager.rateLimitPerHour} requests per hour",
                    true
                )
            }
            
            // Increment counters
            rateLimitInfo.minuteCount.incrementAndGet()
            rateLimitInfo.hourCount.incrementAndGet()
            
            return AuthResult(true)
        }
    }
    
    fun getRateLimitStatus(apiKey: String): Map<String, Any> {
        val rateLimitInfo = rateLimitMap[apiKey] ?: return mapOf(
            "minute_count" to 0,
            "hour_count" to 0,
            "minute_limit" to configManager.rateLimitPerMinute,
            "hour_limit" to configManager.rateLimitPerHour
        )
        
        return mapOf(
            "minute_count" to rateLimitInfo.minuteCount.get(),
            "hour_count" to rateLimitInfo.hourCount.get(),
            "minute_limit" to configManager.rateLimitPerMinute,
            "hour_limit" to configManager.rateLimitPerHour,
            "minute_reset_time" to rateLimitInfo.lastMinuteReset + 60_000,
            "hour_reset_time" to rateLimitInfo.lastHourReset + 3_600_000
        )
    }
    
    fun clearRateLimits() {
        rateLimitMap.clear()
        Log.d(TAG, "Rate limits cleared")
    }
}
