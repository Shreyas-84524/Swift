package com.multi.encription.sms.models

import com.google.gson.annotations.SerializedName
import com.multi.encription.sms.database.SmsStatus

data class SmsResponse(
    @SerializedName("success")
    val success: Boolean,
    
    @SerializedName("message")
    val message: String,
    
    @SerializedName("sms_id")
    val smsId: Long? = null,
    
    @SerializedName("request_id")
    val requestId: String? = null,
    
    @SerializedName("status")
    val status: String? = null,
    
    @SerializedName("timestamp")
    val timestamp: Long = System.currentTimeMillis(),
    
    @SerializedName("error_code")
    val errorCode: String? = null
)

data class BulkSmsResponse(
    @SerializedName("success")
    val success: Boolean,
    
    @SerializedName("message")
    val message: String,
    
    @SerializedName("results")
    val results: List<SmsResponse>,
    
    @SerializedName("total_count")
    val totalCount: Int,
    
    @SerializedName("success_count")
    val successCount: Int,
    
    @SerializedName("failed_count")
    val failedCount: Int
)

data class SmsStatusResponse(
    @SerializedName("success")
    val success: Boolean,
    
    @SerializedName("sms_id")
    val smsId: Long,
    
    @SerializedName("request_id")
    val requestId: String?,
    
    @SerializedName("phone_number")
    val phoneNumber: String,
    
    @SerializedName("message")
    val message: String,
    
    @SerializedName("status")
    val status: String,
    
    @SerializedName("timestamp")
    val timestamp: Long,
    
    @SerializedName("delivery_timestamp")
    val deliveryTimestamp: Long?,
    
    @SerializedName("error_message")
    val errorMessage: String?
)

data class ApiInfoResponse(
    @SerializedName("app_name")
    val appName: String = "Swift",
    
    @SerializedName("version")
    val version: String = "1.0.0",
    
    @SerializedName("status")
    val status: String = "active",
    
    @SerializedName("endpoints")
    val endpoints: List<String> = listOf(
        "/api/send",
        "/api/send-bulk",
        "/api/status",
        "/api/history",
        "/api/info"
    ),
    
    @SerializedName("server_time")
    val serverTime: Long = System.currentTimeMillis()
)

data class ErrorResponse(
    @SerializedName("success")
    val success: Boolean = false,
    
    @SerializedName("error")
    val error: String,
    
    @SerializedName("error_code")
    val errorCode: String,
    
    @SerializedName("timestamp")
    val timestamp: Long = System.currentTimeMillis()
)
