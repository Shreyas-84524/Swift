package com.multi.encription.sms.utils

/**
 * Utilities for privacy-aware display and diagnostic sanitization.
 * Prevents plain-text OTPs and full phone numbers from being exposed on dashboard surfaces,
 * and scrubs secrets and PII from exported diagnostics.
 */
object PrivacyUtils {

    private val OTP_PATTERN = Regex("""\b\d{4,8}\b""")
    private val PHONE_PATTERN = Regex("""(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}""")
    private val KEY_PREFIX_PATTERN = Regex("""(otp_[a-zA-Z0-9_]{6,})""")
    private val BEARER_PATTERN = Regex("""Bearer\s+[a-zA-Z0-9_\-\.]+""", RegexOption.IGNORE_CASE)

    /**
     * Masks recipient phone numbers for safe dashboard and list row display.
     * Example: "+919876543210" -> "+91 ••••• ••210"
     * Example: "1234567890" -> "••••••7890"
     */
    fun maskPhoneNumber(rawPhone: String?): String {
        if (rawPhone.isNullOrBlank()) return "Unknown"
        val trimmed = rawPhone.trim()
        if (trimmed.length <= 4) return "••••"

        val visibleDigits = 3
        val prefix = if (trimmed.startsWith("+")) {
            val countryCodeEnd = trimmed.indexOfFirst { it.isDigit() } + 2
            if (countryCodeEnd < trimmed.length - visibleDigits) trimmed.substring(0, countryCodeEnd.coerceAtLeast(3)) else ""
        } else ""

        val suffix = trimmed.takeLast(visibleDigits)
        val maskedLength = (trimmed.length - prefix.length - visibleDigits).coerceAtLeast(4)
        val maskedMiddle = "•".repeat(maskedLength)

        return if (prefix.isNotBlank()) "$prefix $maskedMiddle $suffix" else "$maskedMiddle$suffix"
    }

    /**
     * Masks OTP codes inside message bodies for safe dashboard and history preview.
     * Replaces 4 to 8 digit numbers with bullet points so sensitive OTPs are not read over the shoulder.
     * Example: "Your Swift verification code is 492810. Do not share." -> "Your Swift verification code is ••••••. Do not share."
     */
    fun maskOtpMessage(message: String?): String {
        if (message.isNullOrBlank()) return ""
        return OTP_PATTERN.replace(message) { matchResult ->
            "•".repeat(matchResult.value.length)
        }
    }

    /**
     * Scrubs all sensitive data (PII phone numbers, OTP codes, API keys, Bearer tokens)
     * from diagnostic strings before copying or exporting.
     */
    fun scrubDiagnostics(rawDiagnostics: String?): String {
        if (rawDiagnostics.isNullOrBlank()) return ""
        var scrubbed = rawDiagnostics
        // Scrub Bearer tokens
        scrubbed = BEARER_PATTERN.replace(scrubbed, "Bearer [REDACTED]")
        // Scrub API keys
        scrubbed = KEY_PREFIX_PATTERN.replace(scrubbed) { matchResult ->
            val key = matchResult.value
            if (key.length >= 10) "${key.substring(0, 7)}[REDACTED]" else "[REDACTED]"
        }
        // Scrub phone numbers
        scrubbed = PHONE_PATTERN.replace(scrubbed) { matchResult ->
            maskPhoneNumber(matchResult.value)
        }
        return scrubbed
    }
}
