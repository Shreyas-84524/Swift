package com.multi.encription.sms.utils

import android.content.Context
import com.multi.encription.sms.R
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.TimeUnit

/**
 * Clean human-readable time formatting.
 */
object TimeUtils {

    private val fullDateFormat = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault())
    private val timeOnlyFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    fun formatRelativeTime(context: Context, timestampMs: Long): String {
        if (timestampMs <= 0L) return context.getString(R.string.last_sync_never)
        val now = System.currentTimeMillis()
        val diffMs = (now - timestampMs).coerceAtLeast(0L)

        val minutes = TimeUnit.MILLISECONDS.toMinutes(diffMs)
        val hours = TimeUnit.MILLISECONDS.toHours(diffMs)
        val days = TimeUnit.MILLISECONDS.toDays(diffMs)

        return when {
            minutes < 1 -> context.getString(R.string.time_just_now)
            minutes < 60 -> context.getString(R.string.time_minutes_ago, minutes)
            hours < 24 -> context.getString(R.string.time_hours_ago, hours)
            days == 1L -> context.getString(R.string.time_yesterday)
            else -> SimpleDateFormat("MMM dd, HH:mm", Locale.getDefault()).format(Date(timestampMs))
        }
    }

    fun formatFullDateTime(timestampMs: Long): String {
        if (timestampMs <= 0L) return "N/A"
        return fullDateFormat.format(Date(timestampMs))
    }

    fun formatTimeOnly(timestampMs: Long): String {
        if (timestampMs <= 0L) return "Never"
        return timeOnlyFormat.format(Date(timestampMs))
    }
}
