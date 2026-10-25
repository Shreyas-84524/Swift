package com.multi.encription.sms

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.telephony.TelephonyManager
import android.view.LayoutInflater
import android.view.View
import android.widget.*
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButtonToggleGroup
import com.google.android.material.card.MaterialCardView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.floatingactionbutton.FloatingActionButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.snackbar.Snackbar
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import com.multi.encription.sms.core.SmsManager
import com.multi.encription.sms.database.SmsDatabase
import com.multi.encription.sms.database.SmsEntity
import com.multi.encription.sms.database.SmsStatus
import com.multi.encription.sms.engine.DrainSource
import com.multi.encription.sms.engine.GatewayActionType
import com.multi.encription.sms.engine.GatewayStateResolver
import com.multi.encription.sms.engine.GatewayStatusDisplay
import com.multi.encription.sms.engine.GatewayStatusState
import com.multi.encription.sms.engine.JobDrainEngine
import com.multi.encription.sms.models.GatewayMode
import com.multi.encription.sms.network.ApiResult
import com.multi.encription.sms.network.GlobalGatewayApiClient
import com.multi.encription.sms.push.FcmTokenCoordinator
import com.multi.encription.sms.push.PushTokenUiState
import com.multi.encription.sms.service.SmsGatewayService
import com.multi.encription.sms.telephony.SubscriptionHelper
import com.multi.encription.sms.ui.SmsHistoryAdapter
import com.multi.encription.sms.utils.ConfigManager
import com.multi.encription.sms.utils.PermissionHelper
import com.multi.encription.sms.utils.PrivacyUtils
import com.multi.encription.sms.utils.TimeUtils
import com.multi.encription.sms.utils.UrlValidator
import com.multi.encription.sms.worker.BackendConnectionStatus
import com.multi.encription.sms.worker.WorkerUiState
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.net.NetworkInterface
import java.text.SimpleDateFormat
import java.util.*

class MainActivity : AppCompatActivity() {

    private lateinit var configManager: ConfigManager
    private lateinit var smsManager: SmsManager
    private lateinit var database: SmsDatabase
    private lateinit var smsHistoryAdapter: SmsHistoryAdapter
    private lateinit var apiClient: GlobalGatewayApiClient

    // Top Coordinator & Scroll
    private lateinit var mainCoordinator: View

    // Hero Status Card Views
    private lateinit var heroStatusCard: MaterialCardView
    private lateinit var heroStatusIcon: ImageView
    private lateinit var heroStatusTitle: TextView
    private lateinit var heroProgressBar: ProgressBar
    private lateinit var heroStatusDescription: TextView
    private lateinit var heroLastSyncText: TextView
    private lateinit var heroPrimaryActionButton: Button
    private lateinit var heroConfigureButton: Button

    // Secondary Health Indicator Views
    private lateinit var healthCloudStatusText: TextView
    private lateinit var healthPushStatusText: TextView
    private lateinit var healthSimStatusText: TextView
    private lateinit var healthWorkerStatusText: TextView

    // Settings Views
    private lateinit var modeToggleGroup: MaterialButtonToggleGroup
    private lateinit var workerToggle: MaterialSwitch
    private lateinit var batteryStatusText: TextView
    private lateinit var btnBatteryOptimization: Button

    // Diagnostics Views
    private lateinit var diagnosticsAppVersionText: TextView
    private lateinit var diagnosticsPushTokenText: TextView
    private lateinit var diagnosticsDetailText: TextView
    private lateinit var btnTestConnection: Button
    private lateinit var btnCopyDiagnostics: Button

    // Legacy Local API Views
    private lateinit var legacyLocalApiContainer: View
    private lateinit var serverStatusText: TextView
    private lateinit var serverToggle: MaterialSwitch
    private lateinit var apiKeyText: TextView
    private lateinit var portText: TextView
    private lateinit var apiUrlsText: TextView
    private lateinit var testApiButton: Button
    private lateinit var externalDomainButton: Button

    // History Views
    private lateinit var historyCountText: TextView
    private lateinit var btnClearHistory: Button
    private lateinit var historyEmptyView: View
    private lateinit var smsHistoryRecyclerView: RecyclerView
    private lateinit var sendSmsFab: FloatingActionButton

    // State Tracking
    private var currentWorkerState: WorkerUiState = WorkerUiState()
    private var currentFcmState: PushTokenUiState = PushTokenUiState()
    private var isTestingConnection: Boolean = false
    private var isDrainingQueue: Boolean = false
    private var lastRecordedDiagnostics: String? = null
    private var lastManualSyncTimestamp: Long = 0L

    companion object {
        private const val SYNC_THROTTLE_MS = 2500L
        private const val KEY_LAST_SYNC_TS = "state_last_sync_ts"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContentView(R.layout.activity_main)

        mainCoordinator = findViewById(R.id.mainCoordinator)
        ViewCompat.setOnApplyWindowInsetsListener(mainCoordinator) { v, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            insets
        }

        if (savedInstanceState != null) {
            lastManualSyncTimestamp = savedInstanceState.getLong(KEY_LAST_SYNC_TS, 0L)
        }

        initializeComponents()
        setupUI()
        observeWorkerState()
        observeFcmState()
        checkPermissions()
        refreshDashboard()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putLong(KEY_LAST_SYNC_TS, lastManualSyncTimestamp)
    }

    override fun onResume() {
        super.onResume()
        refreshDashboard()
    }

    private fun initializeComponents() {
        configManager = ConfigManager(this)
        smsManager = SmsManager(this)
        database = SmsDatabase.getDatabase(this)
        apiClient = GlobalGatewayApiClient(configManager)

        // Header
        findViewById<View>(R.id.btnHeaderSettings).setOnClickListener {
            findViewById<View>(R.id.settingsCard).requestFocus()
            findViewById<androidx.core.widget.NestedScrollView>(R.id.mainScrollView).smoothScrollTo(
                0,
                findViewById<View>(R.id.settingsCard).top
            )
        }

        // Hero Card
        heroStatusCard = findViewById(R.id.heroStatusCard)
        heroStatusIcon = findViewById(R.id.heroStatusIcon)
        heroStatusTitle = findViewById(R.id.heroStatusTitle)
        heroProgressBar = findViewById(R.id.heroProgressBar)
        heroStatusDescription = findViewById(R.id.heroStatusDescription)
        heroLastSyncText = findViewById(R.id.heroLastSyncText)
        heroPrimaryActionButton = findViewById(R.id.heroPrimaryActionButton)
        heroConfigureButton = findViewById(R.id.heroConfigureButton)

        // Secondary Health Tiles
        healthCloudStatusText = findViewById(R.id.healthCloudStatusText)
        healthPushStatusText = findViewById(R.id.healthPushStatusText)
        healthSimStatusText = findViewById(R.id.healthSimStatusText)
        healthWorkerStatusText = findViewById(R.id.healthWorkerStatusText)

        // Settings
        modeToggleGroup = findViewById(R.id.modeToggleGroup)
        workerToggle = findViewById(R.id.workerToggle)
        batteryStatusText = findViewById(R.id.batteryStatusText)
        btnBatteryOptimization = findViewById(R.id.btnBatteryOptimization)

        // Diagnostics
        diagnosticsAppVersionText = findViewById(R.id.diagnosticsAppVersionText)
        diagnosticsPushTokenText = findViewById(R.id.diagnosticsPushTokenText)
        diagnosticsDetailText = findViewById(R.id.diagnosticsDetailText)
        btnTestConnection = findViewById(R.id.btnTestConnection)
        btnCopyDiagnostics = findViewById(R.id.btnCopyDiagnostics)

        // Legacy Local API
        legacyLocalApiContainer = findViewById(R.id.legacyLocalApiContainer)
        serverStatusText = findViewById(R.id.serverStatusText)
        serverToggle = findViewById(R.id.serverToggle)
        apiKeyText = findViewById(R.id.apiKeyText)
        portText = findViewById(R.id.portText)
        apiUrlsText = findViewById(R.id.apiUrlsText)
        testApiButton = findViewById(R.id.testApiButton)
        externalDomainButton = findViewById(R.id.externalDomainButton)

        // History
        historyCountText = findViewById(R.id.historyCountText)
        btnClearHistory = findViewById(R.id.btnClearHistory)
        historyEmptyView = findViewById(R.id.historyEmptyView)
        smsHistoryRecyclerView = findViewById(R.id.smsHistoryRecyclerView)
        sendSmsFab = findViewById(R.id.sendSmsFab)
    }

    private fun setupUI() {
        // App Version
        diagnosticsAppVersionText.text = getString(
            R.string.diagnostics_app_version,
            BuildConfig.VERSION_NAME,
            BuildConfig.VERSION_CODE
        )

        // Setup History Adapter & RecyclerView
        smsHistoryAdapter = SmsHistoryAdapter { sms ->
            showSmsDetails(sms)
        }
        smsHistoryRecyclerView.apply {
            layoutManager = LinearLayoutManager(this@MainActivity)
            adapter = smsHistoryAdapter
            isNestedScrollingEnabled = false
        }

        database.smsDao().getAllSmsLiveData().observe(this) { smsList ->
            smsHistoryAdapter.submitList(smsList)
            historyCountText.text = getString(R.string.history_count_format, smsList.size)
            if (smsList.isEmpty()) {
                historyEmptyView.visibility = View.VISIBLE
                smsHistoryRecyclerView.visibility = View.GONE
            } else {
                historyEmptyView.visibility = View.GONE
                smsHistoryRecyclerView.visibility = View.VISIBLE
            }
            updateLatestDiagnostics(smsList)
        }

        // Configure Buttons
        heroConfigureButton.setOnClickListener {
            showGlobalGatewayConfigDialog()
        }

        // Mode Selection
        if (configManager.gatewayMode == GatewayMode.GLOBAL_WORKER) {
            modeToggleGroup.check(R.id.btnModeGlobal)
            legacyLocalApiContainer.visibility = View.GONE
        } else {
            modeToggleGroup.check(R.id.btnModeLocal)
            legacyLocalApiContainer.visibility = View.VISIBLE
        }

        modeToggleGroup.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (isChecked) {
                val newMode = if (checkedId == R.id.btnModeGlobal) GatewayMode.GLOBAL_WORKER else GatewayMode.LOCAL_API
                if (newMode != configManager.gatewayMode) {
                    confirmSwitchMode(newMode)
                }
            }
        }

        // Worker Switch with Confirmation on Disable
        workerToggle.isChecked = configManager.isWorkerEnabled
        workerToggle.setOnClickListener {
            val willBeEnabled = workerToggle.isChecked
            if (!willBeEnabled) {
                // Confirm disable
                confirmDisableWorker()
            } else {
                configManager.isWorkerEnabled = true
                SmsGatewayService.startService(this)
                refreshDashboard()
            }
        }

        // Battery Optimization
        btnBatteryOptimization.setOnClickListener {
            requestIgnoreBatteryOptimizations()
        }

        // Clear History with Confirmation
        btnClearHistory.setOnClickListener {
            confirmClearHistory()
        }

        // Test Connection Button
        btnTestConnection.setOnClickListener {
            runConnectionTest()
        }

        // Copy Diagnostics
        btnCopyDiagnostics.setOnClickListener {
            val diag = lastRecordedDiagnostics ?: getString(R.string.diagnostics_no_data)
            val scrubbed = PrivacyUtils.scrubDiagnostics(diag)
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("SMS Diagnostics", scrubbed))
            Snackbar.make(mainCoordinator, R.string.diagnostics_copied, Snackbar.LENGTH_SHORT).show()
        }

        // Send Test SMS FAB
        sendSmsFab.setOnClickListener {
            showSendSmsDialog()
        }

        // Legacy Local API Setup
        setupLegacyLocalApi()
    }

    private fun observeWorkerState() {
        lifecycleScope.launch {
            val worker = SmsGatewayService.instance?.getGlobalWorker()
            worker?.uiState?.collectLatest { state ->
                currentWorkerState = state
                refreshDashboard()
            }
        }
    }

    private fun observeFcmState() {
        lifecycleScope.launch {
            FcmTokenCoordinator.getInstance(this@MainActivity).state.collectLatest { fcmState ->
                currentFcmState = fcmState
                diagnosticsPushTokenText.text = "FCM Push: ${fcmState.tokenMasked} (${fcmState.statusMessage})"
                refreshDashboard()
            }
        }
    }

    private fun refreshDashboard() {
        val hasKey = configManager.secureStorage.hasGatewayKey()
        val hasSmsPerms = PermissionHelper.hasSmsPermissions(this)
        val isSimReady = checkSimReady()
        val isWorkerEnabled = configManager.isWorkerEnabled
        val isFcmFailed = !currentFcmState.isRegistered && currentFcmState.statusMessage.contains("Failed", ignoreCase = true)

        val display = GatewayStateResolver.resolve(
            hasKey = hasKey,
            hasSmsPermissions = hasSmsPerms,
            isSimReady = isSimReady,
            isWorkerEnabled = isWorkerEnabled,
            backendStatus = currentWorkerState.backendStatus,
            isConnecting = isTestingConnection,
            isSyncing = isDrainingQueue,
            isFcmFailed = isFcmFailed,
            isRecoveryPending = false
        )

        updateHeroCard(display)
        updateSecondaryHealth(hasKey, hasSmsPerms, isSimReady, isWorkerEnabled)
        updateBatteryStatus()
    }

    private fun updateHeroCard(display: GatewayStatusDisplay) {
        heroStatusTitle.setText(display.titleRes)
        heroStatusDescription.setText(display.explanationRes)
        heroPrimaryActionButton.setText(display.actionRes)

        // Status Icon & Tinting
        val (iconRes, tintColorRes) = when (display.state) {
            GatewayStatusState.READY -> Pair(R.drawable.ic_status_ready, R.color.swift_status_success)
            GatewayStatusState.SYNCING -> Pair(R.drawable.ic_status_syncing, R.color.swift_brand_primary)
            GatewayStatusState.CONNECTING -> Pair(R.drawable.ic_status_syncing, R.color.swift_brand_primary)
            GatewayStatusState.OFFLINE -> Pair(R.drawable.ic_status_offline, R.color.swift_status_warning)
            GatewayStatusState.AUTH_FAILED -> Pair(R.drawable.ic_status_error, R.color.swift_status_error)
            GatewayStatusState.SIM_UNAVAILABLE, GatewayStatusState.PERMISSIONS_MISSING -> Pair(R.drawable.ic_status_error, R.color.swift_status_error)
            GatewayStatusState.NOT_CONFIGURED, GatewayStatusState.WORKER_DISABLED, GatewayStatusState.FCM_UNAVAILABLE, GatewayStatusState.RECOVERY_PENDING -> Pair(R.drawable.ic_status_warning, R.color.swift_status_warning)
        }

        heroStatusIcon.setImageResource(iconRes)
        heroStatusIcon.imageTintList = ColorStateList.valueOf(ContextCompat.getColor(this, tintColorRes))

        // Progress bar for active states
        if (display.state == GatewayStatusState.SYNCING || display.state == GatewayStatusState.CONNECTING) {
            heroProgressBar.visibility = View.VISIBLE
        } else {
            heroProgressBar.visibility = View.GONE
        }

        // Last Sync Timestamp
        if (currentWorkerState.lastSyncTimestamp > 0L) {
            heroLastSyncText.text = getString(
                R.string.last_sync_format,
                TimeUtils.formatRelativeTime(this, currentWorkerState.lastSyncTimestamp)
            )
        } else {
            heroLastSyncText.text = getString(R.string.last_sync_never)
        }

        // Primary Action Click Dispatcher
        heroPrimaryActionButton.setOnClickListener {
            when (display.actionType) {
                GatewayActionType.CONFIGURE -> showGlobalGatewayConfigDialog()
                GatewayActionType.GRANT_PERMISSIONS -> checkPermissions()
                GatewayActionType.CHECK_SIM -> showSimDiagnosticsDialog()
                GatewayActionType.ENABLE_WORKER -> {
                    configManager.isWorkerEnabled = true
                    workerToggle.isChecked = true
                    SmsGatewayService.startService(this)
                    refreshDashboard()
                }
                GatewayActionType.SYNC_NOW -> triggerManualSync()
                GatewayActionType.RETRY_CONNECTION -> runConnectionTest()
                GatewayActionType.RETRY_PUSH -> {
                    lifecycleScope.launch {
                        FcmTokenCoordinator.getInstance(this@MainActivity).syncToken()
                    }
                }
                GatewayActionType.NONE -> { /* Ongoing action */ }
            }
        }
    }

    private fun updateSecondaryHealth(
        hasKey: Boolean,
        hasSmsPerms: Boolean,
        isSimReady: Boolean,
        isWorkerEnabled: Boolean
    ) {
        // Cloud Backend Link
        val (cloudTextRes, cloudColorRes) = when (currentWorkerState.backendStatus) {
            BackendConnectionStatus.CONNECTED -> Pair(R.string.health_cloud_connected, R.color.swift_status_success)
            BackendConnectionStatus.OFFLINE -> Pair(R.string.health_cloud_offline, R.color.swift_status_warning)
            BackendConnectionStatus.AUTH_ERROR, BackendConnectionStatus.SERVER_ERROR -> Pair(R.string.health_cloud_error, R.color.swift_status_error)
            BackendConnectionStatus.UNKNOWN -> {
                if (!hasKey) Pair(R.string.health_cloud_offline, R.color.swift_status_neutral)
                else Pair(R.string.health_cloud_checking, R.color.swift_text_secondary)
            }
        }
        healthCloudStatusText.setText(cloudTextRes)
        healthCloudStatusText.setTextColor(ContextCompat.getColor(this, cloudColorRes))

        // FCM Push Wake
        val (pushTextRes, pushColorRes) = when {
            currentFcmState.isRegistered -> Pair(R.string.health_push_active, R.color.swift_status_success)
            currentFcmState.statusMessage.contains("Failed", ignoreCase = true) -> Pair(R.string.health_push_unavailable, R.color.swift_status_error)
            else -> Pair(R.string.health_push_pending, R.color.swift_status_warning)
        }
        healthPushStatusText.setText(pushTextRes)
        healthPushStatusText.setTextColor(ContextCompat.getColor(this, pushColorRes))

        // Cellular SIM
        val (simTextRes, simColorRes) = if (isSimReady) {
            Pair(R.string.health_sim_ready, R.color.swift_status_success)
        } else {
            Pair(R.string.health_sim_missing, R.color.swift_status_error)
        }
        healthSimStatusText.setText(simTextRes)
        healthSimStatusText.setTextColor(ContextCompat.getColor(this, simColorRes))

        // Worker Service
        val (workerTextRes, workerColorRes) = if (isWorkerEnabled) {
            Pair(R.string.health_worker_active, R.color.swift_status_success)
        } else {
            Pair(R.string.health_worker_paused, R.color.swift_status_neutral)
        }
        healthWorkerStatusText.setText(workerTextRes)
        healthWorkerStatusText.setTextColor(ContextCompat.getColor(this, workerColorRes))
    }

    private fun checkSimReady(): Boolean {
        return try {
            val telephonyManager = getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
            telephonyManager.simState == TelephonyManager.SIM_STATE_READY
        } catch (e: Exception) {
            false
        }
    }

    private fun updateBatteryStatus() {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        val isIgnoring = powerManager.isIgnoringBatteryOptimizations(packageName)
        if (isIgnoring) {
            batteryStatusText.setText(R.string.settings_battery_unrestricted)
            batteryStatusText.setTextColor(ContextCompat.getColor(this, R.color.swift_status_success))
            btnBatteryOptimization.visibility = View.GONE
        } else {
            batteryStatusText.setText(R.string.settings_battery_optimized)
            batteryStatusText.setTextColor(ContextCompat.getColor(this, R.color.swift_status_warning))
            btnBatteryOptimization.visibility = View.VISIBLE
        }
    }

    @SuppressLint("BatteryLife")
    private fun requestIgnoreBatteryOptimizations() {
        try {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            startActivity(intent)
        } catch (e: Exception) {
            try {
                val fallbackIntent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                startActivity(fallbackIntent)
            } catch (ex: Exception) {
                Snackbar.make(mainCoordinator, "Unable to open battery optimization settings", Snackbar.LENGTH_SHORT).show()
            }
        }
    }

    /**
     * Throttled Manual Queue Drain.
     * Prevents rapid repeated taps and provides clear feedback.
     */
    private fun triggerManualSync() {
        val now = System.currentTimeMillis()
        if (now - lastManualSyncTimestamp < SYNC_THROTTLE_MS) {
            Snackbar.make(mainCoordinator, R.string.msg_sync_throttled, Snackbar.LENGTH_SHORT).show()
            return
        }

        lastManualSyncTimestamp = now
        isDrainingQueue = true
        heroPrimaryActionButton.isEnabled = false
        refreshDashboard()

        lifecycleScope.launch {
            try {
                val summary = JobDrainEngine.getInstance(applicationContext)
                    .drainQueue(DrainSource.MANUAL_SYNC)
                val msg = getString(R.string.msg_sync_summary, summary.jobsDispatched, summary.duplicatesSkipped)
                Snackbar.make(mainCoordinator, msg, Snackbar.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Snackbar.make(mainCoordinator, "Sync error: ${e.message}", Snackbar.LENGTH_LONG).show()
            } finally {
                isDrainingQueue = false
                heroPrimaryActionButton.isEnabled = true
                refreshDashboard()
            }
        }
    }

    /**
     * First-Run / Edit Gateway Configuration Dialog.
     * Masked key by default, show/hide toggle, paste support, URL validation, and clear confirmation.
     */
    private fun showGlobalGatewayConfigDialog() {
        val dialogView = LayoutInflater.from(this).inflate(R.layout.dialog_global_gateway_config, null)
        val backendUrlLayout = dialogView.findViewById<TextInputLayout>(R.id.backendUrlInputLayout)
        val backendUrlEditText = dialogView.findViewById<TextInputEditText>(R.id.backendUrlEditText)
        val gatewayKeyLayout = dialogView.findViewById<TextInputLayout>(R.id.gatewayKeyInputLayout)
        val gatewayKeyEditText = dialogView.findViewById<TextInputEditText>(R.id.gatewayKeyEditText)
        val currentKeyMaskedText = dialogView.findViewById<TextView>(R.id.currentKeyMaskedText)
        val btnPasteKey = dialogView.findViewById<Button>(R.id.btnPasteKey)
        val btnClearKey = dialogView.findViewById<Button>(R.id.btnClearKeyInDialog)

        backendUrlEditText.setText(configManager.globalBackendUrl)
        currentKeyMaskedText.text = getString(
            R.string.setup_current_key_format,
            configManager.secureStorage.getMaskedGatewayKey()
        )

        // Paste action
        btnPasteKey.setOnClickListener {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val item = clipboard.primaryClip?.getItemAt(0)
            val pastedText = item?.text?.toString()?.trim()
            if (!pastedText.isNullOrBlank()) {
                gatewayKeyEditText.setText(pastedText)
                gatewayKeyEditText.setSelection(pastedText.length)
            }
        }

        val dialog = MaterialAlertDialogBuilder(this)
            .setView(dialogView)
            .setPositiveButton(R.string.action_save, null)
            .setNegativeButton(R.string.action_cancel, null)
            .create()

        // Clear key inside dialog
        btnClearKey.setOnClickListener {
            confirmClearKey {
                currentKeyMaskedText.text = getString(
                    R.string.setup_current_key_format,
                    configManager.secureStorage.getMaskedGatewayKey()
                )
                gatewayKeyEditText.text = null
            }
        }

        dialog.show()

        // Custom validation on positive button to prevent dismiss on invalid URL
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val newUrl = backendUrlEditText.text?.toString()?.trim().orEmpty()
            val newKey = gatewayKeyEditText.text?.toString()?.trim().orEmpty()

            // Validate URL
            if (!UrlValidator.isValidBackendUrl(newUrl)) {
                backendUrlLayout.error = getString(R.string.setup_backend_url_error)
                return@setOnClickListener
            } else {
                backendUrlLayout.error = null
            }

            // Validate Key Format if entered
            if (newKey.isNotBlank() && !newKey.startsWith("otp_gw_")) {
                gatewayKeyLayout.error = getString(R.string.setup_gateway_key_error)
                return@setOnClickListener
            } else {
                gatewayKeyLayout.error = null
            }

            // Save and apply
            val previousUrl = configManager.globalBackendUrl
            val previousKey = configManager.secureStorage.getGatewayKey()
            val normalizedNewUrl = configManager.normalizeBackendUrl(newUrl)
            val credentialsChanged = (newKey.isNotBlank() && newKey != previousKey) || normalizedNewUrl != previousUrl

            lifecycleScope.launch {
                val coordinator = FcmTokenCoordinator.getInstance(this@MainActivity)
                if (!previousKey.isNullOrBlank() && credentialsChanged) {
                    coordinator.unregisterPushToken()
                }

                configManager.globalBackendUrl = newUrl
                if (newKey.isNotBlank()) {
                    configManager.secureStorage.saveGatewayKey(newKey)
                }

                coordinator.onGatewayConfigUpdated()
                Snackbar.make(mainCoordinator, R.string.msg_config_updated, Snackbar.LENGTH_SHORT).show()
                refreshDashboard()
            }

            dialog.dismiss()
        }
    }

    /**
     * Connection link test separating health reachability from gateway key authentication.
     */
    private fun runConnectionTest() {
        val progressDialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.test_connection_title)
            .setMessage(getString(R.string.test_connection_progress))
            .setCancelable(false)
            .create()

        progressDialog.show()
        isTestingConnection = true
        refreshDashboard()

        lifecycleScope.launch {
            val healthRes = apiClient.checkHealth()
            val claimRes = apiClient.claimJobs(limit = 1, leaseSeconds = 30)

            isTestingConnection = false
            progressDialog.dismiss()
            refreshDashboard()

            val sb = StringBuilder()
            sb.append("🌐 ").append(configManager.globalBackendUrl).append("\n\n")

            // Health Status
            when (healthRes) {
                is ApiResult.Success -> {
                    val h = healthRes.data
                    sb.append("✅ ").append(getString(R.string.test_health_success)).append("\n")
                    sb.append("• Platform: ").append(h.status).append("\n")
                    sb.append("• Database: ").append(h.services?.database ?: "connected").append("\n")
                    sb.append("• Active Gateways: ").append(h.services?.activeGateways ?: 0).append("\n\n")
                }
                is ApiResult.HttpError -> {
                    sb.append("❌ ").append(getString(R.string.test_health_failed, healthRes.statusCode)).append("\n\n")
                }
                is ApiResult.NetworkError -> {
                    sb.append("❌ ").append(getString(R.string.test_health_network_error, healthRes.message)).append("\n\n")
                }
                is ApiResult.AuthError -> {
                    sb.append("❌ Health Auth Error: ").append(healthRes.message).append("\n\n")
                }
            }

            // Gateway Key Auth Status
            when (claimRes) {
                is ApiResult.Success -> {
                    sb.append("✅ ").append(getString(R.string.test_auth_success)).append("\n")
                    sb.append("• Key: ").append(configManager.secureStorage.getMaskedGatewayKey()).append("\n")
                    sb.append("• Queue Claim: Verified (Available: ").append(claimRes.data.size).append(")\n")
                }
                is ApiResult.AuthError -> {
                    sb.append("❌ ").append(getString(R.string.test_auth_failed)).append("\n")
                    sb.append("• Message: ").append(claimRes.message).append("\n")
                }
                is ApiResult.HttpError -> {
                    sb.append("⚠️ Queue Probe HTTP ").append(claimRes.statusCode).append(": ").append(claimRes.message).append("\n")
                }
                is ApiResult.NetworkError -> {
                    sb.append("❌ Queue Network Error: ").append(claimRes.message).append("\n")
                }
            }

            MaterialAlertDialogBuilder(this@MainActivity)
                .setTitle(R.string.test_connection_result_title)
                .setMessage(sb.toString())
                .setPositiveButton(R.string.action_close, null)
                .show()
        }
    }

    /**
     * Confirmation Dialogs for Security-Sensitive and Destructive Actions
     */
    private fun confirmClearKey(onCleared: (() -> Unit)? = null) {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.confirm_clear_key_title)
            .setMessage(R.string.confirm_clear_key_message)
            .setPositiveButton(R.string.action_confirm) { _, _ ->
                lifecycleScope.launch {
                    FcmTokenCoordinator.getInstance(this@MainActivity).unregisterPushToken()
                    configManager.secureStorage.clearGatewayKey()
                    Snackbar.make(mainCoordinator, R.string.msg_key_cleared, Snackbar.LENGTH_SHORT).show()
                    onCleared?.invoke()
                    refreshDashboard()
                }
            }
            .setNegativeButton(R.string.action_cancel, null)
            .show()
    }

    private fun confirmSwitchMode(targetMode: GatewayMode) {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.confirm_switch_mode_title)
            .setMessage(R.string.confirm_switch_mode_message)
            .setPositiveButton(R.string.action_confirm) { _, _ ->
                configManager.gatewayMode = targetMode
                if (targetMode == GatewayMode.GLOBAL_WORKER) {
                    legacyLocalApiContainer.visibility = View.GONE
                } else {
                    legacyLocalApiContainer.visibility = View.VISIBLE
                }
                SmsGatewayService.instance?.applyCurrentMode()
                refreshDashboard()
            }
            .setNegativeButton(R.string.action_cancel) { _, _ ->
                // Revert toggle
                if (configManager.gatewayMode == GatewayMode.GLOBAL_WORKER) {
                    modeToggleGroup.check(R.id.btnModeGlobal)
                } else {
                    modeToggleGroup.check(R.id.btnModeLocal)
                }
            }
            .show()
    }

    private fun confirmDisableWorker() {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.confirm_disable_worker_title)
            .setMessage(R.string.confirm_disable_worker_message)
            .setPositiveButton(R.string.action_confirm) { _, _ ->
                configManager.isWorkerEnabled = false
                workerToggle.isChecked = false
                SmsGatewayService.instance?.applyCurrentMode()
                refreshDashboard()
            }
            .setNegativeButton(R.string.action_cancel) { _, _ ->
                workerToggle.isChecked = true
            }
            .show()
    }

    private fun confirmClearHistory() {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.confirm_clear_history_title)
            .setMessage(R.string.confirm_clear_history_message)
            .setPositiveButton(R.string.action_confirm) { _, _ ->
                lifecycleScope.launch {
                    database.smsDao().deleteAllSms()
                    Snackbar.make(mainCoordinator, R.string.msg_history_cleared, Snackbar.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton(R.string.action_cancel, null)
            .show()
    }

    private fun showSimDiagnosticsDialog() {
        val diag = SubscriptionHelper.getSubscriptionDiagnostics(this).toSummaryString()
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.health_sim_label)
            .setMessage(diag)
            .setPositiveButton(R.string.action_close, null)
            .show()
    }

    private fun updateLatestDiagnostics(smsList: List<SmsEntity>) {
        val latestSms = smsList.firstOrNull()
        if (latestSms != null) {
            val diag = latestSms.diagnosticInfo
            if (!diag.isNullOrBlank()) {
                lastRecordedDiagnostics = diag
                diagnosticsDetailText.text = PrivacyUtils.scrubDiagnostics(diag)
                return
            }
            if (latestSms.errorMessage != null) {
                val summary = "Status: ${latestSms.status}\nError: ${latestSms.errorMessage}\nSub ID: ${latestSms.subscriptionId ?: "Default"}\nRadio Error: ${latestSms.radioErrorCode ?: "N/A"}"
                lastRecordedDiagnostics = summary
                diagnosticsDetailText.text = summary
                return
            }
        }
        val simDiag = SubscriptionHelper.getSubscriptionDiagnostics(this).toSummaryString()
        lastRecordedDiagnostics = simDiag
        diagnosticsDetailText.text = simDiag
    }

    private fun showSmsDetails(sms: SmsEntity) {
        val dialogView = LayoutInflater.from(this).inflate(R.layout.dialog_sms_details, null)
        val detailPhoneText = dialogView.findViewById<TextView>(R.id.detailPhoneText)
        val detailStatusText = dialogView.findViewById<TextView>(R.id.detailStatusText)
        val detailMessageText = dialogView.findViewById<TextView>(R.id.detailMessageText)
        val detailTimestampText = dialogView.findViewById<TextView>(R.id.detailTimestampText)
        val detailJobIdText = dialogView.findViewById<TextView>(R.id.detailJobIdText)
        val detailJobIdLabel = dialogView.findViewById<TextView>(R.id.detailJobIdLabel)
        val detailDiagLabel = dialogView.findViewById<TextView>(R.id.detailDiagnosticsLabel)
        val detailDiagText = dialogView.findViewById<TextView>(R.id.detailDiagnosticsText)

        detailPhoneText.text = sms.phoneNumber
        detailStatusText.text = sms.status.name
        detailMessageText.text = sms.message
        detailTimestampText.text = TimeUtils.formatFullDateTime(sms.timestamp)

        if (!sms.globalJobId.isNullOrBlank()) {
            detailJobIdText.text = sms.globalJobId
            detailJobIdLabel.visibility = View.VISIBLE
            detailJobIdText.visibility = View.VISIBLE
        } else if (!sms.requestId.isNullOrBlank()) {
            detailJobIdText.text = sms.requestId
            detailJobIdLabel.text = "Request ID"
            detailJobIdLabel.visibility = View.VISIBLE
            detailJobIdText.visibility = View.VISIBLE
        } else {
            detailJobIdLabel.visibility = View.GONE
            detailJobIdText.visibility = View.GONE
        }

        val diag = sms.diagnosticInfo ?: sms.errorMessage
        if (!diag.isNullOrBlank()) {
            detailDiagLabel.visibility = View.VISIBLE
            detailDiagText.visibility = View.VISIBLE
            detailDiagText.text = PrivacyUtils.scrubDiagnostics(diag)
        } else {
            detailDiagLabel.visibility = View.GONE
            detailDiagText.visibility = View.GONE
        }

        MaterialAlertDialogBuilder(this)
            .setView(dialogView)
            .setPositiveButton(R.string.action_close, null)
            .setNeutralButton(R.string.action_copy_diagnostics) { _, _ ->
                val scrubbed = PrivacyUtils.scrubDiagnostics(diag ?: sms.message)
                val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("SMS Diagnostics", scrubbed))
                Snackbar.make(mainCoordinator, R.string.diagnostics_copied, Snackbar.LENGTH_SHORT).show()
            }
            .show()
    }

    private fun checkPermissions() {
        if (!PermissionHelper.hasSmsPermissions(this)) {
            if (PermissionHelper.shouldShowSmsPermissionRationale(this)) {
                showPermissionRationaleDialog()
            } else {
                PermissionHelper.requestSmsPermissions(this)
            }
        }

        if (!PermissionHelper.hasNotificationPermission(this)) {
            PermissionHelper.requestNotificationPermission(this)
        }
    }

    private fun showPermissionRationaleDialog() {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.status_permissions_missing_title)
            .setMessage(R.string.status_permissions_missing_desc)
            .setPositiveButton(R.string.action_grant_permissions) { _, _ ->
                PermissionHelper.requestSmsPermissions(this)
            }
            .setNegativeButton(R.string.action_cancel, null)
            .show()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        PermissionHelper.handlePermissionResult(
            requestCode = requestCode,
            permissions = permissions,
            grantResults = grantResults,
            onSmsPermissionGranted = {
                Snackbar.make(mainCoordinator, "SMS permissions granted", Snackbar.LENGTH_SHORT).show()
                refreshDashboard()
            },
            onSmsPermissionDenied = {
                Snackbar.make(mainCoordinator, "SMS permissions denied. Cellular dispatch disabled.", Snackbar.LENGTH_LONG).show()
                refreshDashboard()
            },
            onNotificationPermissionGranted = {
                refreshDashboard()
            },
            onNotificationPermissionDenied = {
                refreshDashboard()
            }
        )
    }

    private fun showSendSmsDialog() {
        if (!PermissionHelper.hasSmsPermissions(this)) {
            Snackbar.make(mainCoordinator, R.string.status_permissions_missing_desc, Snackbar.LENGTH_LONG).show()
            return
        }

        val dialogView = LayoutInflater.from(this).inflate(R.layout.dialog_send_sms, null)
        val phoneEditText = dialogView.findViewById<EditText>(R.id.phoneEditText)
        val messageEditText = dialogView.findViewById<EditText>(R.id.messageEditText)

        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.action_send_test_sms)
            .setView(dialogView)
            .setPositiveButton(R.string.action_send_test_sms) { _, _ ->
                val phone = phoneEditText.text.toString().trim()
                val message = messageEditText.text.toString().trim()
                if (phone.isBlank() || message.isBlank()) {
                    Snackbar.make(mainCoordinator, "Please enter phone and message", Snackbar.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                lifecycleScope.launch {
                    val result = smsManager.sendSms(phone, message)
                    if (result.isSuccess) {
                        Snackbar.make(mainCoordinator, "SMS queued for cellular dispatch", Snackbar.LENGTH_SHORT).show()
                    } else {
                        val err = result.exceptionOrNull()?.message ?: "Unknown error"
                        Snackbar.make(mainCoordinator, "Failed: $err", Snackbar.LENGTH_LONG).show()
                    }
                }
            }
            .setNegativeButton(R.string.action_cancel, null)
            .show()
    }

    // ==========================================
    // Legacy Local API Setup
    // ==========================================
    private fun setupLegacyLocalApi() {
        serverToggle.isChecked = configManager.isServerEnabled
        serverToggle.setOnCheckedChangeListener { _, isChecked ->
            configManager.isServerEnabled = isChecked
            if (isChecked) {
                SmsGatewayService.startService(this)
            } else {
                SmsGatewayService.instance?.applyCurrentMode()
            }
            updateLocalServerDisplay()
        }

        apiKeyText.setOnClickListener { showLegacyApiKeyDialog() }
        portText.setOnClickListener { showLegacyPortDialog() }
        testApiButton.setOnClickListener { showLegacyTestApiDialog() }
        externalDomainButton.setOnClickListener { showLegacyExternalDomainDialog() }

        updateLocalServerDisplay()
    }

    private fun updateLocalServerDisplay() {
        val isRunning = configManager.isServerEnabled && configManager.gatewayMode == GatewayMode.LOCAL_API
        serverStatusText.text = if (isRunning) {
            getString(R.string.legacy_server_status_running, configManager.serverPort)
        } else {
            getString(R.string.legacy_server_status_stopped)
        }

        apiKeyText.text = getString(R.string.legacy_api_key_format, "${configManager.apiKey.take(8)}••••")
        portText.text = getString(R.string.legacy_port_format, configManager.serverPort)

        val deviceIp = getDeviceIpAddress()
        val baseUrl = configManager.getApiBaseUrl(deviceIp)
        apiUrlsText.text = "Base URL: $baseUrl\nPOST $baseUrl/api/send\nGET $baseUrl/api/status"
        externalDomainButton.text = if (configManager.useExternalDomain) "Ext: ${configManager.externalDomain}" else getString(R.string.legacy_external_domain)
    }

    private fun getDeviceIpAddress(): String {
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val iface = interfaces.nextElement()
                if (!iface.isLoopback && iface.isUp) {
                    val addrs = iface.inetAddresses
                    while (addrs.hasMoreElements()) {
                        val addr = addrs.nextElement()
                        if (!addr.isLoopbackAddress && addr.hostAddress?.contains(':') == false) {
                            return addr.hostAddress ?: "192.168.1.100"
                        }
                    }
                }
            }
        } catch (e: Exception) {
            // Ignored
        }
        return "192.168.1.100"
    }

    private fun showLegacyApiKeyDialog() {
        val editText = EditText(this).apply {
            setText(configManager.apiKey)
            selectAll()
        }
        MaterialAlertDialogBuilder(this)
            .setTitle("Local API Key")
            .setView(editText)
            .setPositiveButton("Regenerate") { _, _ ->
                configManager.regenerateApiKey()
                updateLocalServerDisplay()
                Snackbar.make(mainCoordinator, "New local API key generated", Snackbar.LENGTH_SHORT).show()
            }
            .setNegativeButton(R.string.action_close, null)
            .show()
    }

    private fun showLegacyPortDialog() {
        val editText = EditText(this).apply {
            setText(configManager.serverPort.toString())
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
        }
        MaterialAlertDialogBuilder(this)
            .setTitle("Server Port")
            .setView(editText)
            .setPositiveButton(R.string.action_save) { _, _ ->
                val port = editText.text.toString().toIntOrNull()
                if (port != null && port in 1024..65535) {
                    configManager.serverPort = port
                    updateLocalServerDisplay()
                    if (configManager.isServerEnabled && configManager.gatewayMode == GatewayMode.LOCAL_API) {
                        SmsGatewayService.stopService(this)
                        SmsGatewayService.startService(this)
                    }
                }
            }
            .setNegativeButton(R.string.action_cancel, null)
            .show()
    }

    private fun showLegacyTestApiDialog() {
        val dialogView = LayoutInflater.from(this).inflate(R.layout.dialog_test_api, null)
        val phoneEditText = dialogView.findViewById<EditText>(R.id.testPhoneEditText)
        val messageEditText = dialogView.findViewById<EditText>(R.id.testMessageEditText)

        phoneEditText.hint = "e.g. +919876543210"
        messageEditText.setText("Test message from local API")

        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.legacy_test_api)
            .setView(dialogView)
            .setPositiveButton("Send Test SMS") { _, _ ->
                val phone = phoneEditText.text.toString().trim()
                val message = messageEditText.text.toString().trim()
                if (phone.isNotBlank() && message.isNotBlank()) {
                    lifecycleScope.launch {
                        smsManager.sendSms(phone, message, configManager.apiKey, "test-${System.currentTimeMillis()}")
                        Snackbar.make(mainCoordinator, "SMS queued for local sending", Snackbar.LENGTH_SHORT).show()
                    }
                }
            }
            .setNegativeButton(R.string.action_close, null)
            .show()
    }

    private fun showLegacyExternalDomainDialog() {
        val dialogView = LayoutInflater.from(this).inflate(R.layout.dialog_external_domain, null)
        val domainEditText = dialogView.findViewById<EditText>(R.id.domainEditText)
        val enableSwitch = dialogView.findViewById<MaterialSwitch>(R.id.enableExternalDomainSwitch)

        domainEditText.setText(configManager.externalDomain)
        enableSwitch.isChecked = configManager.useExternalDomain

        MaterialAlertDialogBuilder(this)
            .setTitle("External Domain Setup")
            .setView(dialogView)
            .setPositiveButton(R.string.action_save) { _, _ ->
                configManager.externalDomain = domainEditText.text.toString().trim()
                configManager.useExternalDomain = enableSwitch.isChecked
                updateLocalServerDisplay()
            }
            .setNegativeButton(R.string.action_cancel, null)
            .show()
    }
}
