package com.multi.encription.sms.ui

import android.content.res.ColorStateList
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.multi.encription.sms.R
import com.multi.encription.sms.database.SmsEntity
import com.multi.encription.sms.database.SmsStatus
import com.multi.encription.sms.utils.PrivacyUtils
import com.multi.encription.sms.utils.TimeUtils

class SmsHistoryAdapter(
    private val onItemClick: (SmsEntity) -> Unit
) : ListAdapter<SmsEntity, SmsHistoryAdapter.SmsViewHolder>(SmsDiffCallback()) {

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): SmsViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_sms_history, parent, false)
        return SmsViewHolder(view, onItemClick)
    }

    override fun onBindViewHolder(holder: SmsViewHolder, position: Int) {
        holder.bind(getItem(position))
    }

    class SmsViewHolder(
        itemView: View,
        private val onItemClick: (SmsEntity) -> Unit
    ) : RecyclerView.ViewHolder(itemView) {

        private val phoneNumberText: TextView = itemView.findViewById(R.id.phoneNumberText)
        private val messageText: TextView = itemView.findViewById(R.id.messageText)
        private val statusText: TextView = itemView.findViewById(R.id.statusText)
        private val timestampText: TextView = itemView.findViewById(R.id.timestampText)
        private val requestIdText: TextView = itemView.findViewById(R.id.requestIdText)

        fun bind(sms: SmsEntity) {
            val context = itemView.context

            // Privacy-aware masked phone number
            phoneNumberText.text = PrivacyUtils.maskPhoneNumber(sms.phoneNumber)

            // Privacy-aware masked OTP preview
            messageText.text = PrivacyUtils.maskOtpMessage(sms.message)

            // Status Badge with semantic tokens
            statusText.text = sms.status.name
            applyStatusColors(sms.status)

            // Human-readable relative time
            timestampText.text = TimeUtils.formatRelativeTime(context, sms.timestamp)

            // Identifier display (Global Job ID takes precedence over local requestId)
            val identifier = sms.globalJobId ?: sms.requestId
            if (!identifier.isNullOrBlank()) {
                requestIdText.text = if (identifier.length > 8) "${identifier.take(8)}…" else identifier
                requestIdText.visibility = View.VISIBLE
            } else {
                requestIdText.visibility = View.GONE
            }

            // Accessible content description for screen readers
            itemView.contentDescription = "${sms.status.name} SMS to ${PrivacyUtils.maskPhoneNumber(sms.phoneNumber)}, ${timestampText.text}"

            itemView.setOnClickListener {
                onItemClick(sms)
            }
        }

        private fun applyStatusColors(status: SmsStatus) {
            val context = itemView.context
            val (bgColorRes, textColorRes) = when (status) {
                SmsStatus.DELIVERED -> Pair(R.color.swift_status_success_container, R.color.swift_status_on_success_container)
                SmsStatus.SENT -> Pair(R.color.swift_brand_container, R.color.swift_brand_on_container)
                SmsStatus.PENDING, SmsStatus.SENDING -> Pair(R.color.swift_status_warning_container, R.color.swift_status_on_warning_container)
                SmsStatus.FAILED -> Pair(R.color.swift_status_error_container, R.color.swift_status_on_error_container)
                SmsStatus.UNKNOWN -> Pair(R.color.swift_status_neutral_container, R.color.swift_status_on_neutral_container)
            }

            val bgColor = ContextCompat.getColor(context, bgColorRes)
            val textColor = ContextCompat.getColor(context, textColorRes)

            statusText.backgroundTintList = ColorStateList.valueOf(bgColor)
            statusText.setTextColor(textColor)
        }
    }

    class SmsDiffCallback : DiffUtil.ItemCallback<SmsEntity>() {
        override fun areItemsTheSame(oldItem: SmsEntity, newItem: SmsEntity): Boolean {
            return oldItem.id == newItem.id
        }

        override fun areContentsTheSame(oldItem: SmsEntity, newItem: SmsEntity): Boolean {
            return oldItem == newItem
        }
    }
}
