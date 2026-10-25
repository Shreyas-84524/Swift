package com.multi.encription.sms.utils

import java.net.URI

/**
 * URL validation helper for gateway backend endpoint.
 */
object UrlValidator {

    /**
     * Validates whether a given string is a syntactically valid HTTP or HTTPS URL.
     */
    fun isValidBackendUrl(rawUrl: String?): Boolean {
        if (rawUrl.isNullOrBlank()) return false
        val trimmed = rawUrl.trim()
        return try {
            val uri = URI(trimmed)
            val scheme = uri.scheme?.lowercase()
            val host = uri.host
            (scheme == "https" || scheme == "http") && !host.isNullOrBlank()
        } catch (e: Exception) {
            false
        }
    }
}
