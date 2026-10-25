package com.multi.encription.sms.telephony

import android.annotation.SuppressLint
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.telephony.SmsManager as AndroidSmsManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.multi.encription.sms.utils.ConfigManager

/**
 * Non-sensitive diagnostic summary of active cellular subscriptions.
 */
data class SubscriptionDiagnostics(
    val resolvedSubId: Int,
    val defaultSmsSubId: Int,
    val activeSubscriptionCount: Int,
    val slotIndex: Int,
    val carrierName: String,
    val simState: String,
    val isMultiSim: Boolean,
    val selectionSource: String // "DEFAULT_SMS_SUB", "SOLE_ACTIVE_SIM", "USER_PREFERRED", "FIRST_ACTIVE", "FALLBACK_DEFAULT"
) {
    fun toSummaryString(): String {
        return "SubId=$resolvedSubId, Slot=$slotIndex, Carrier='$carrierName', SIMState=$simState, ActiveCount=$activeSubscriptionCount, Source=$selectionSource"
    }
}

object SubscriptionHelper {

    private const val TAG = "SubscriptionHelper"

    /**
     * Resolves the target subscription ID using the strict priority hierarchy:
     * 1. Priority A: SubscriptionManager.getDefaultSmsSubscriptionId() (if valid > 0)
     * 2. Priority B: Inspect activeSubscriptionInfoList:
     *    - If exactly one active SIM exists -> use that subscriptionId
     *    - If multiple active SIMs exist -> check user preference in ConfigManager, else first active SIM
     * 3. Fallback: INVALID_SUBSCRIPTION_ID (-1)
     */
    fun resolveSubscriptionId(context: Context, configManager: ConfigManager? = null): Int {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            val subManager = context.getSystemService(SubscriptionManager::class.java)
            if (subManager != null) {
                // Priority A: Default SMS Subscription ID
                val defaultSubId = SubscriptionManager.getDefaultSmsSubscriptionId()
                if (defaultSubId != SubscriptionManager.INVALID_SUBSCRIPTION_ID && defaultSubId > 0) {
                    return defaultSubId
                }

                // Priority B: Inspect active subscriptions list
                if (hasReadPhoneStatePermission(context)) {
                    try {
                        val activeList = subManager.activeSubscriptionInfoList
                        if (!activeList.isNullOrEmpty()) {
                            if (activeList.size == 1) {
                                return activeList[0].subscriptionId
                            }

                            // Multiple SIMs detected
                            val preferred = configManager?.preferredSubscriptionId
                            if (preferred != null && preferred != SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
                                val found = activeList.find { it.subscriptionId == preferred }
                                if (found != null) {
                                    return found.subscriptionId
                                }
                            }

                            // Default to first active SIM
                            return activeList[0].subscriptionId
                        }
                    } catch (e: SecurityException) {
                        Log.w(TAG, "SecurityException while reading active subscription info list", e)
                    } catch (e: Exception) {
                        Log.w(TAG, "Error accessing active subscription info list", e)
                    }
                }
            }
        }
        return SubscriptionManager.INVALID_SUBSCRIPTION_ID
    }

    /**
     * Resolves an explicit Android SmsManager bound to the resolved subscription ID.
     */
    fun getSmsManagerForSubscription(context: Context, subscriptionId: Int): AndroidSmsManager {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val systemSmsManager = context.getSystemService(AndroidSmsManager::class.java)
            if (subscriptionId != SubscriptionManager.INVALID_SUBSCRIPTION_ID && subscriptionId > 0) {
                systemSmsManager.createForSubscriptionId(subscriptionId)
            } else {
                systemSmsManager
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            if (subscriptionId != SubscriptionManager.INVALID_SUBSCRIPTION_ID && subscriptionId > 0) {
                @Suppress("DEPRECATION")
                AndroidSmsManager.getSmsManagerForSubscriptionId(subscriptionId)
            } else {
                @Suppress("DEPRECATION")
                AndroidSmsManager.getDefault()
            }
        } else {
            @Suppress("DEPRECATION")
            AndroidSmsManager.getDefault()
        }
    }

    /**
     * Extracts non-sensitive subscription telemetry for diagnostics and logging.
     * Never logs IMSI, ICCID, phone numbers, or credentials.
     */
    @SuppressLint("MissingPermission")
    fun getSubscriptionDiagnostics(context: Context, configManager: ConfigManager? = null): SubscriptionDiagnostics {
        var defaultSmsSubId = SubscriptionManager.INVALID_SUBSCRIPTION_ID
        var activeCount = 0
        var resolvedSubId = SubscriptionManager.INVALID_SUBSCRIPTION_ID
        var slotIndex = -1
        var carrierName = "Unknown"
        var source = "FALLBACK_DEFAULT"

        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        val simState = when (tm?.simState) {
            TelephonyManager.SIM_STATE_READY -> "READY"
            TelephonyManager.SIM_STATE_ABSENT -> "NO_SIM"
            TelephonyManager.SIM_STATE_PIN_REQUIRED -> "PIN_REQUIRED"
            TelephonyManager.SIM_STATE_PUK_REQUIRED -> "PUK_REQUIRED"
            TelephonyManager.SIM_STATE_NETWORK_LOCKED -> "NETWORK_LOCKED"
            else -> "UNKNOWN"
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            val subManager = context.getSystemService(SubscriptionManager::class.java)
            if (subManager != null) {
                defaultSmsSubId = SubscriptionManager.getDefaultSmsSubscriptionId()

                if (hasReadPhoneStatePermission(context)) {
                    try {
                        val activeList = subManager.activeSubscriptionInfoList
                        activeCount = activeList?.size ?: 0

                        if (!activeList.isNullOrEmpty()) {
                            // Find target sub info
                            var targetInfo: SubscriptionInfo? = null

                            if (defaultSmsSubId != SubscriptionManager.INVALID_SUBSCRIPTION_ID && defaultSmsSubId > 0) {
                                targetInfo = activeList.find { it.subscriptionId == defaultSmsSubId }
                                if (targetInfo != null) {
                                    resolvedSubId = defaultSmsSubId
                                    source = "DEFAULT_SMS_SUB"
                                }
                            }

                            if (targetInfo == null) {
                                if (activeList.size == 1) {
                                    targetInfo = activeList[0]
                                    resolvedSubId = targetInfo.subscriptionId
                                    source = "SOLE_ACTIVE_SIM"
                                } else {
                                    val preferred = configManager?.preferredSubscriptionId
                                    val preferredInfo = if (preferred != null) activeList.find { it.subscriptionId == preferred } else null
                                    if (preferredInfo != null) {
                                        targetInfo = preferredInfo
                                        resolvedSubId = preferredInfo.subscriptionId
                                        source = "USER_PREFERRED"
                                    } else {
                                        targetInfo = activeList[0]
                                        resolvedSubId = targetInfo.subscriptionId
                                        source = "FIRST_ACTIVE"
                                    }
                                }
                            }

                            if (targetInfo != null) {
                                slotIndex = targetInfo.simSlotIndex
                                carrierName = targetInfo.carrierName?.toString()?.take(32) ?: "Carrier (Slot $slotIndex)"
                            }
                        }
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed reading subscription diagnostics", e)
                    }
                } else {
                    if (defaultSmsSubId != SubscriptionManager.INVALID_SUBSCRIPTION_ID && defaultSmsSubId > 0) {
                        resolvedSubId = defaultSmsSubId
                        source = "DEFAULT_SMS_SUB"
                    }
                }
            }
        }

        return SubscriptionDiagnostics(
            resolvedSubId = resolvedSubId,
            defaultSmsSubId = defaultSmsSubId,
            activeSubscriptionCount = activeCount,
            slotIndex = slotIndex,
            carrierName = carrierName,
            simState = simState,
            isMultiSim = activeCount > 1,
            selectionSource = source
        )
    }

    private fun hasReadPhoneStatePermission(context: Context): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.READ_PHONE_STATE
        ) == PackageManager.PERMISSION_GRANTED
    }
}
