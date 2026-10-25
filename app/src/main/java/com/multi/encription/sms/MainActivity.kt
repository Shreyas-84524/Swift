package com.multi.encription.sms

import android.content.Context
import android.os.Bundle
import android.view.View
import android.widget.*
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButtonToggleGroup
import com.google.android.material.card.MaterialCardView
import com.google.android.material.floatingactionbutton.FloatingActionButton
import com.google.android.material.switchmaterial.SwitchMaterial
import com.google.android.material.textfield.TextInputEditText
import com.multi.encription.sms.core.SmsManager
import com.multi.encription.sms.database.SmsDatabase
import com.multi.encription.sms.database.SmsEntity
import com.multi.encription.sms.models.GatewayMode
import com.multi.encription.sms.network.ApiResult
import com.multi.encription.sms.network.GlobalGatewayApiClient
import com.multi.encription.sms.service.SmsGatewayService
import com.multi.encription.sms.ui.SmsHistoryAdapter
import com.multi.encription.sms.utils.ConfigManager
import com.multi.encription.sms.utils.PermissionHelper
import com.multi.encription.sms.worker.BackendConnectionStatus
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

class MainActivity : AppCompatActivity() {

    private lateinit var configManager: ConfigManager
    private lateinit var smsManager: SmsManager
    private lateinit var database: SmsDatabase
    private lateinit var smsHistoryAdapter: SmsHistoryAdapter
    private lateinit var apiClient: GlobalGatewayApiClient

    // Mode Selection UI
    private lateinit var modeToggleGroup: MaterialButtonToggleGroup
    private lateinit var globalWorkerCard: MaterialCardView
    private lateinit var localApiCard: MaterialCardView

    // Global Worker Dashboard UI
    private lateinit var workerToggle: SwitchMaterial
    private lateinit var workerBackendStatusText: TextView
    private lateinit var workerSimStatusText: TextView
    private lateinit var workerLastSyncText: TextView
    private lateinit var workerLastJobText: TextView
    private lateinit var btnSyncNow: Button
    private lateinit var btnTestConnection: Button
    private lateinit var btnConfigGateway: Button

    // Diagnostics UI
    private lateinit var diagnosticsCard: MaterialCardView
    private lateinit var diagnosticsTitleText: TextView
    private lateinit var diagnosticsDetailText: TextView
    private lateinit var btnCopyDiagnostics: Button
    private var lastRecordedDiagnostics: String? = null

    // Local API UI (Legacy)
    private lateinit var serverStatusText: TextView
    private lateinit var serverToggle: SwitchMaterial
    private lateinit var apiKeyText: TextView
    private lateinit var portText: TextView
    private lateinit var apiUrlsText: TextView
    private lateinit var testApiButton: Button
    private lateinit var externalDomainButton: Button

    // Shared UI
    private lateinit var smsHistoryRecyclerView: RecyclerView
    private lateinit var sendSmsFab: FloatingActionButton

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContentView(R.layout.activity_main)

        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.main)) { v, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            insets
        }

        initializeComponents()
        setupUI()
        observeWorkerState()
        checkPermissions()
    }

    private fun initializeComponents() {
        configManager = ConfigManager(this)
        smsManager = SmsManager(this)
        database = SmsDatabase.getDatabase(this)
        apiClient = GlobalGatewayApiClient(configManager)

        // Mode views
        modeToggleGroup = findViewById(R.id.modeToggleGroup)
        globalWorkerCard = findViewById(R.id.globalWorkerCard)
        localApiCard = findViewById(R.id.localApiCard)

        // Global Worker views
        workerToggle = findViewById(R.id.workerToggle)
        workerBackendStatusText = findViewById(R.id.workerBackendStatusText)
        workerSimStatusText = findViewById(R.id.workerSimStatusText)
        workerLastSyncText = findViewById(R.id.workerLastSyncText)
        workerLastJobText = findViewById(R.id.workerLastJobText)
        btnSyncNow = findViewById(R.id.btnSyncNow)
        btnTestConnection = findViewById(R.id.btnTestConnection)
        btnConfigGateway = findViewById(R.id.btnConfigGateway)

        // Diagnostics views
        diagnosticsCard = findViewById(R.id.diagnosticsCard)
        diagnosticsTitleText = findViewById(R.id.diagnosticsTitleText)
        diagnosticsDetailText = findViewById(R.id.diagnosticsDetailText)
        btnCopyDiagnostics = findViewById(R.id.btnCopyDiagnostics)

        btnCopyDiagnostics.setOnClickListener {
            val diag = lastRecordedDiagnostics
            if (!diag.isNullOrBlank()) {
                val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                val clip = android.content.ClipData.newPlainText("SMS Diagnostics", diag)
                clipboard.setPrimaryClip(clip)
                Toast.makeText(this, "Diagnostics copied to clipboard", Toast.LENGTH_SHORT).show()
            }
        }

        // Local API views
        serverStatusText = findViewById(R.id.serverStatusText)
        serverToggle = findViewById(R.id.serverToggle)
        apiKeyText = findViewById(R.id.apiKeyText)
        portText = findViewById(R.id.portText)
        apiUrlsText = findViewById(R.id.apiUrlsText)
        testApiButton = findViewById(R.id.testApiButton)
        externalDomainButton = findViewById(R.id.externalDomainButton)

        // History and FAB
        smsHistoryRecyclerView = findViewById(R.id.smsHistoryRecyclerView)
        sendSmsFab = findViewById(R.id.sendSmsFab)
    }

    private fun setupUI() {
        // Setup RecyclerView
        smsHistoryAdapter = SmsHistoryAdapter { sms ->
            showSmsDetails(sms)
        }

        smsHistoryRecyclerView.apply {
            layoutManager = LinearLayoutManager(this@MainActivity)
            adapter = smsHistoryAdapter
        }

        database.smsDao().getAllSmsLiveData().observe(this) { smsList ->
            smsHistoryAdapter.submitList(smsList)
            updateLatestDiagnostics(smsList)
        }

        // Setup Mode Toggle
        if (configManager.gatewayMode == GatewayMode.GLOBAL_WORKER) {
            modeToggleGroup.check(R.id.btnModeGlobal)
            showGlobalWorkerCard()
        } else {
            modeToggleGroup.check(R.id.btnModeLocal)
            showLocalApiCard()
        }

        modeToggleGroup.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (isChecked) {
                when (checkedId) {
                    R.id.btnModeGlobal -> {
                        configManager.gatewayMode = GatewayMode.GLOBAL_WORKER
                        showGlobalWorkerCard()
                        SmsGatewayService.instance?.applyCurrentMode()
                    }
                    R.id.btnModeLocal -> {
                        configManager.gatewayMode = GatewayMode.LOCAL_API
                        showLocalApiCard()
                        SmsGatewayService.instance?.applyCurrentMode()
                    }
                }
            }
        }

        // Global Worker Toggle
        workerToggle.isChecked = configManager.isWorkerEnabled
        workerToggle.setOnCheckedChangeListener { _, isChecked ->
            configManager.isWorkerEnabled = isChecked
            if (isChecked) {
                SmsGatewayService.startService(this)
            } else {
                SmsGatewayService.instance?.applyCurrentMode()
            }
        }

        btnSyncNow.setOnClickListener {
            val worker = SmsGatewayService.instance?.getGlobalWorker()
            if (worker != null) {
                worker.syncNow()
                Toast.makeText(this, "Manual sync triggered", Toast.LENGTH_SHORT).show()
            } else {
                lifecycleScope.launch {
                    val summary = com.multi.encription.sms.engine.JobDrainEngine.getInstance(applicationContext)
                        .drainQueue(com.multi.encription.sms.engine.DrainSource.MANUAL_SYNC)
                    Toast.makeText(this@MainActivity, "Manual sync: ${summary.jobsDispatched} sent, ${summary.duplicatesSkipped} skipped", Toast.LENGTH_SHORT).show()
                }
            }
        }

        btnTestConnection.setOnClickListener {
            runConnectionTest()
        }

        btnConfigGateway.setOnClickListener {
            showGlobalGatewayConfigDialog()
        }

        // Local Server Toggle
        serverToggle.isChecked = configManager.isServerEnabled
        serverToggle.setOnCheckedChangeListener { _, isChecked ->
            configManager.isServerEnabled = isChecked
            if (isChecked) {
                SmsGatewayService.startService(this)
            } else {
                SmsGatewayService.instance?.applyCurrentMode()
            }
            updateLocalServerStatus()
            updateApiUrls()
        }

        // Setup FAB for manual SMS testing
        sendSmsFab.setOnClickListener {
            showSendSmsDialog()
        }

        // Setup Legacy Click Listeners
        apiKeyText.setOnClickListener { showApiKeyDialog() }
        portText.setOnClickListener { showPortDialog() }
        apiUrlsText.setOnClickListener { showApiUrlsDialog() }
        testApiButton.setOnClickListener { showTestApiDialog() }
        externalDomainButton.setOnClickListener { showExternalDomainDialog() }

        updateLocalServerStatus()
        updateApiKeyDisplay()
        updatePortDisplay()
        updateApiUrls()
        updateExternalDomainButton()
    }

    private fun showGlobalWorkerCard() {
        globalWorkerCard.visibility = View.VISIBLE
        localApiCard.visibility = View.GONE
    }

    private fun showLocalApiCard() {
        globalWorkerCard.visibility = View.GONE
        localApiCard.visibility = View.VISIBLE
    }

    private fun observeWorkerState() {
        lifecycleScope.launch {
            val worker = SmsGatewayService.instance?.getGlobalWorker()
            worker?.uiState?.collectLatest { state ->
                updateWorkerDashboard(state)
            }
        }
    }

    private fun updateWorkerDashboard(state: com.multi.encription.sms.worker.WorkerUiState) {
        val backendStatusStr = when (state.backendStatus) {
            BackendConnectionStatus.CONNECTED -> "🟢 Connected (${configManager.globalBackendUrl})"
            BackendConnectionStatus.AUTH_ERROR -> "🔴 Authentication Error (Invalid Key)"
            BackendConnectionStatus.OFFLINE -> "🟠 Offline / Unreachable"
            BackendConnectionStatus.SERVER_ERROR -> "🔴 Server Error"
            BackendConnectionStatus.UNKNOWN -> "⚪ Status: ${state.statusMessage}"
        }
        workerBackendStatusText.text = backendStatusStr

        workerSimStatusText.text = "SIM Status: ${state.simStatus}"

        val lastSyncStr = if (state.lastSyncTimestamp > 0) {
            val dateStr = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(state.lastSyncTimestamp))
            "Last Sync: $dateStr (${state.statusMessage})"
        } else {
            "Last Sync: Never (${state.statusMessage})"
        }
        workerLastSyncText.text = lastSyncStr

        val lastJobStr = if (state.lastClaimedJobId != null) {
            "Last Job: ${state.lastClaimedJobId.take(12)}... | Status: ${state.lastSmsStatus ?: "IDLE"}"
        } else {
            "Last Job: None | Status: ${state.statusMessage}"
        }
        workerLastJobText.text = lastJobStr
    }

    private fun runConnectionTest() {
        val progressDialog = AlertDialog.Builder(this)
            .setTitle("Testing Connection")
            .setMessage("Contacting backend at ${configManager.globalBackendUrl}...")
            .setCancelable(false)
            .create()

        progressDialog.show()

        lifecycleScope.launch {
            val healthRes = apiClient.checkHealth()
            val claimRes = apiClient.claimJobs(limit = 1, leaseSeconds = 30)

            progressDialog.dismiss()

            val sb = StringBuilder()
            sb.append("🌐 Backend URL:\n${configManager.globalBackendUrl}\n\n")

            // Health Status
            when (healthRes) {
                is ApiResult.Success -> {
                    val h = healthRes.data
                    sb.append("✅ Health Check: HTTP 200 OK\n")
                    sb.append("• Platform Status: ${h.status}\n")
                    sb.append("• Database: ${h.services?.database ?: "connected"}\n")
                    sb.append("• Active Gateways: ${h.services?.activeGateways ?: 0}\n\n")
                }
                is ApiResult.HttpError -> {
                    sb.append("❌ Health Check Failed: HTTP ${healthRes.statusCode}\n\n")
                }
                is ApiResult.NetworkError -> {
                    sb.append("❌ Network Error: ${healthRes.message}\n\n")
                }
                is ApiResult.AuthError -> {
                    sb.append("❌ Health Probe Auth Error: ${healthRes.message}\n\n")
                }
            }

            // Gateway Authentication Status
            when (claimRes) {
                is ApiResult.Success -> {
                    sb.append("✅ Gateway Authentication: SUCCESS\n")
                    sb.append("• Masked Key: ${configManager.secureStorage.getMaskedGatewayKey()}\n")
                    sb.append("• Queue Status: Accessible (Jobs in batch: ${claimRes.data.size})\n")
                }
                is ApiResult.AuthError -> {
                    sb.append("❌ Gateway Authentication: FAILED\n")
                    sb.append("• Error: ${claimRes.message}\n")
                    sb.append("• Please re-enter or replace your Gateway API Key.\n")
                }
                is ApiResult.HttpError -> {
                    sb.append("⚠️ Gateway Queue Probe HTTP ${claimRes.statusCode}: ${claimRes.message}\n")
                }
                is ApiResult.NetworkError -> {
                    sb.append("❌ Gateway Queue Network Error: ${claimRes.message}\n")
                }
            }

            AlertDialog.Builder(this@MainActivity)
                .setTitle("Connection Test Results")
                .setMessage(sb.toString())
                .setPositiveButton("OK", null)
                .show()
        }
    }

    private fun showGlobalGatewayConfigDialog() {
        val dialogView = layoutInflater.inflate(R.layout.dialog_global_gateway_config, null)
        val backendUrlEditText = dialogView.findViewById<TextInputEditText>(R.id.backendUrlEditText)
        val gatewayKeyEditText = dialogView.findViewById<TextInputEditText>(R.id.gatewayKeyEditText)
        val currentKeyMaskedText = dialogView.findViewById<TextView>(R.id.currentKeyMaskedText)

        backendUrlEditText.setText(configManager.globalBackendUrl)
        currentKeyMaskedText.text = "Current Key: ${configManager.secureStorage.getMaskedGatewayKey()}"

        AlertDialog.Builder(this)
            .setTitle("Configure Global Gateway")
            .setView(dialogView)
            .setPositiveButton("Save") { _, _ ->
                val newUrl = backendUrlEditText.text?.toString()?.trim() ?: ""
                val newKey = gatewayKeyEditText.text?.toString()?.trim() ?: ""
                val previousUrl = configManager.globalBackendUrl
                val previousKey = configManager.secureStorage.getGatewayKey()
                lifecycleScope.launch {
                    val coordinator = com.multi.encription.sms.push.FcmTokenCoordinator.getInstance(this@MainActivity)
                    val normalizedNewUrl = if (newUrl.isBlank()) previousUrl else configManager.normalizeBackendUrl(newUrl)
                    val credentialsChanged =
                        (newKey.isNotBlank() && newKey != previousKey) || normalizedNewUrl != previousUrl

                    // Invalidate the old registration while the old URL/key are still active.
                    if (!previousKey.isNullOrBlank() && credentialsChanged) {
                        coordinator.unregisterPushToken()
                    }

                    if (newUrl.isNotBlank()) {
                        configManager.globalBackendUrl = newUrl
                    }
                    if (newKey.isNotBlank()) {
                        configManager.secureStorage.saveGatewayKey(newKey)
                        if (!newKey.startsWith("otp_gw_")) {
                            Toast.makeText(this@MainActivity, "Warning: Key format should be otp_gw_...", Toast.LENGTH_LONG).show()
                        }
                    }

                    coordinator.onGatewayConfigUpdated()
                    Toast.makeText(this@MainActivity, "Configuration updated", Toast.LENGTH_SHORT).show()
                }
            }
            .setNeutralButton("Clear Key") { _, _ ->
                lifecycleScope.launch {
                    com.multi.encription.sms.push.FcmTokenCoordinator.getInstance(this@MainActivity).unregisterPushToken()
                    configManager.secureStorage.clearGatewayKey()
                    Toast.makeText(this@MainActivity, "Gateway key cleared and push token invalidated", Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton("Cancel", null)
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
        AlertDialog.Builder(this)
            .setTitle("SMS Permissions Required")
            .setMessage("This app requires SMS permissions to send messages via your cellular SIM. Please grant permissions to continue.")
            .setPositiveButton("Grant Permissions") { _, _ ->
                PermissionHelper.requestSmsPermissions(this)
            }
            .setNegativeButton("Cancel") { dialog, _ ->
                dialog.dismiss()
            }
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
                Toast.makeText(this, "SMS permissions granted", Toast.LENGTH_SHORT).show()
            },
            onSmsPermissionDenied = {
                Toast.makeText(this, "SMS permissions denied. Cellular dispatch disabled.", Toast.LENGTH_LONG).show()
            },
            onNotificationPermissionGranted = {
                Toast.makeText(this, "Notification permission granted", Toast.LENGTH_SHORT).show()
            },
            onNotificationPermissionDenied = {
                Toast.makeText(this, "Notifications disabled. Foreground service status will not be visible in status bar.", Toast.LENGTH_LONG).show()
            }
        )
    }

    private fun updateLocalServerStatus() {
        val isRunning = configManager.isServerEnabled && configManager.gatewayMode == GatewayMode.LOCAL_API
        serverStatusText.text = if (isRunning) {
            "Server Status: Running on port ${configManager.serverPort}"
        } else {
            "Server Status: Stopped"
        }
    }

    private fun updateApiKeyDisplay() {
        val apiKey = configManager.apiKey
        apiKeyText.text = "API Key: ${apiKey.take(10)}... (tap to view/change)"
    }

    private fun updatePortDisplay() {
        portText.text = "Port: ${configManager.serverPort} (tap to change)"
    }

    private fun updateApiUrls() {
        val deviceIp = getDeviceIpAddress()
        val baseUrl = configManager.getApiBaseUrl(deviceIp)
        val accessType = if (configManager.useExternalDomain) "External Domain" else "Local Network"

        val urlsText = """
            API Base URL ($accessType): $baseUrl

            Main Endpoints:
            • Send SMS: POST $baseUrl/api/send
            • Check Status: GET $baseUrl/api/status
            • SMS History: GET $baseUrl/api/history
            • Server Info: GET $baseUrl/api/info
        """.trimIndent()

        apiUrlsText.text = urlsText
    }

    private fun getDeviceIpAddress(): String {
        try {
            val interfaces = java.net.NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val networkInterface = interfaces.nextElement()
                if (!networkInterface.isLoopback && networkInterface.isUp) {
                    val addresses = networkInterface.inetAddresses
                    while (addresses.hasMoreElements()) {
                        val address = addresses.nextElement()
                        if (!address.isLoopbackAddress && address.hostAddress?.contains(':') == false) {
                            return address.hostAddress ?: "192.168.1.100"
                        }
                    }
                }
            }
        } catch (e: Exception) {
            // Fallback
        }
        return "192.168.1.100"
    }

    private fun showSendSmsDialog() {
        if (!PermissionHelper.hasSmsPermissions(this)) {
            Toast.makeText(this, "SMS permissions required", Toast.LENGTH_SHORT).show()
            return
        }

        val dialogView = layoutInflater.inflate(R.layout.dialog_send_sms, null)
        val phoneEditText = dialogView.findViewById<EditText>(R.id.phoneEditText)
        val messageEditText = dialogView.findViewById<EditText>(R.id.messageEditText)

        AlertDialog.Builder(this)
            .setTitle("Send Test SMS via SIM")
            .setView(dialogView)
            .setPositiveButton("Send") { _, _ ->
                val phone = phoneEditText.text.toString().trim()
                val message = messageEditText.text.toString().trim()

                if (phone.isBlank() || message.isBlank()) {
                    Toast.makeText(this, "Please fill in all fields", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }

                sendSms(phone, message)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun sendSms(phoneNumber: String, message: String) {
        lifecycleScope.launch {
            try {
                val result = smsManager.sendSms(phoneNumber, message)
                if (result.isSuccess) {
                    Toast.makeText(this@MainActivity, "SMS queued for cellular sending", Toast.LENGTH_SHORT).show()
                } else {
                    val error = result.exceptionOrNull()
                    Toast.makeText(this@MainActivity, "Failed to send SMS: ${error?.message}", Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun updateLatestDiagnostics(smsList: List<SmsEntity>) {
        val latestSms = smsList.firstOrNull()
        if (latestSms != null) {
            val diag = latestSms.diagnosticInfo
            if (!diag.isNullOrBlank()) {
                lastRecordedDiagnostics = diag
                diagnosticsTitleText.text = "Latest Dispatch Status: ${latestSms.status}"
                diagnosticsDetailText.text = diag
                return
            }
            if (latestSms.errorMessage != null) {
                val summary = "Status: ${latestSms.status}\nError: ${latestSms.errorMessage}\nSub ID: ${latestSms.subscriptionId ?: "Default"}\nRadio Error: ${latestSms.radioErrorCode ?: "N/A"}"
                lastRecordedDiagnostics = summary
                diagnosticsTitleText.text = "Latest Dispatch Status: ${latestSms.status}"
                diagnosticsDetailText.text = summary
                return
            }
        }
        val simDiag = com.multi.encription.sms.telephony.SubscriptionHelper.getSubscriptionDiagnostics(this).toSummaryString()
        lastRecordedDiagnostics = simDiag
        diagnosticsTitleText.text = "Modem / SIM Diagnostics"
        diagnosticsDetailText.text = simDiag
    }

    private fun showSmsDetails(sms: SmsEntity) {
        val message = """
            Phone: ${sms.phoneNumber}
            Message: ${sms.message}
            Status: ${sms.status}
            Timestamp: ${SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date(sms.timestamp))}
            ${if (sms.deliveryTimestamp != null) "Delivered: ${SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date(sms.deliveryTimestamp))}\n" else ""}${if (sms.globalJobId != null) "Global Job ID: ${sms.globalJobId}\n" else ""}${if (sms.subscriptionId != null) "Subscription ID: ${sms.subscriptionId}\n" else ""}${if (sms.radioErrorCode != null) "Radio Error Code: ${sms.radioErrorCode}\n" else ""}${if (sms.errorMessage != null) "Error: ${sms.errorMessage}\n" else ""}${if (sms.diagnosticInfo != null) "\nDiagnostics:\n${sms.diagnosticInfo}\n" else ""}${if (sms.requestId != null) "Request ID: ${sms.requestId}" else ""}
        """.trimIndent()

        AlertDialog.Builder(this)
            .setTitle("SMS Dispatch Details")
            .setMessage(message)
            .setPositiveButton("OK", null)
            .setNeutralButton("Copy Diagnostics") { _, _ ->
                val diagText = sms.diagnosticInfo ?: message
                copyToClipboard("SMS Diagnostics", diagText)
            }
            .show()
    }

    private fun showApiKeyDialog() {
        val currentApiKey = configManager.apiKey
        val editText = EditText(this).apply {
            setText(currentApiKey)
            selectAll()
        }

        AlertDialog.Builder(this)
            .setTitle("Local API Key")
            .setMessage("Current Local API Key:")
            .setView(editText)
            .setPositiveButton("Generate New") { _, _ ->
                val newApiKey = configManager.regenerateApiKey()
                updateApiKeyDisplay()
                Toast.makeText(this, "New local API key generated", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun showPortDialog() {
        val editText = EditText(this).apply {
            setText(configManager.serverPort.toString())
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
        }

        AlertDialog.Builder(this)
            .setTitle("Server Port")
            .setMessage("Enter the port number for the local API server:")
            .setView(editText)
            .setPositiveButton("Save") { _, _ ->
                val portText = editText.text.toString()
                val port = portText.toIntOrNull()

                if (port != null && port in 1024..65535) {
                    configManager.serverPort = port
                    updatePortDisplay()
                    updateApiUrls()

                    if (configManager.isServerEnabled && configManager.gatewayMode == GatewayMode.LOCAL_API) {
                        SmsGatewayService.stopService(this)
                        SmsGatewayService.startService(this)
                    }

                    Toast.makeText(this, "Port updated to $port", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this, "Please enter a valid port number (1024-65535)", Toast.LENGTH_LONG).show()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showApiUrlsDialog() {
        val deviceIp = getDeviceIpAddress()
        val port = configManager.serverPort
        val apiKey = configManager.apiKey
        val baseUrl = "http://$deviceIp:$port"

        val message = """
            📡 Local SMS Gateway API Endpoints

            Base URL: $baseUrl
            API Key: $apiKey

            🔗 Available Endpoints:
            • POST $baseUrl/api/send
            • GET $baseUrl/api/status?sms_id=123
            • GET $baseUrl/api/history?limit=10
            • GET $baseUrl/api/info
        """.trimIndent()

        AlertDialog.Builder(this)
            .setTitle("Local API Endpoints")
            .setMessage(message)
            .setPositiveButton("Copy URL", { _, _ -> copyToClipboard("Base URL", baseUrl) })
            .setNeutralButton("Copy Key", { _, _ -> copyToClipboard("API Key", apiKey) })
            .setNegativeButton("Close", null)
            .show()
    }

    private fun showTestApiDialog() {
        if (!configManager.isServerEnabled || configManager.gatewayMode != GatewayMode.LOCAL_API) {
            Toast.makeText(this, "Please switch to Local API mode and enable server first", Toast.LENGTH_SHORT).show()
            return
        }

        val dialogView = layoutInflater.inflate(R.layout.dialog_test_api, null)
        val phoneEditText = dialogView.findViewById<EditText>(R.id.testPhoneEditText)
        val messageEditText = dialogView.findViewById<EditText>(R.id.testMessageEditText)

        phoneEditText.hint = "e.g. +919876543210"
        messageEditText.setText("Test OTP verification message from Gateway")

        AlertDialog.Builder(this)
            .setTitle("Test Local API - Send SMS")
            .setView(dialogView)
            .setPositiveButton("Send Test SMS") { _, _ ->
                val phone = phoneEditText.text.toString().trim()
                val message = messageEditText.text.toString().trim()

                if (phone.isBlank() || message.isBlank()) {
                    Toast.makeText(this, "Please fill in all fields", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }

                lifecycleScope.launch {
                    try {
                        val result = smsManager.sendSms(phone, message, configManager.apiKey, "test-${System.currentTimeMillis()}")
                        if (result.isSuccess) {
                            Toast.makeText(this@MainActivity, "SMS queued for local sending", Toast.LENGTH_SHORT).show()
                        } else {
                            Toast.makeText(this@MainActivity, "Error: ${result.exceptionOrNull()?.message}", Toast.LENGTH_LONG).show()
                        }
                    } catch (e: Exception) {
                        Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_LONG).show()
                    }
                }
            }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun copyToClipboard(label: String, text: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val clip = android.content.ClipData.newPlainText(label, text)
        clipboard.setPrimaryClip(clip)
        Toast.makeText(this, "$label copied to clipboard", Toast.LENGTH_SHORT).show()
    }

    private fun updateExternalDomainButton() {
        val buttonText = if (configManager.useExternalDomain) {
            "External: ${configManager.externalDomain}"
        } else {
            "Setup External Domain"
        }
        externalDomainButton.text = buttonText
    }

    private fun showExternalDomainDialog() {
        val dialogView = layoutInflater.inflate(R.layout.dialog_external_domain, null)
        val domainEditText = dialogView.findViewById<EditText>(R.id.domainEditText)
        val enableSwitch = dialogView.findViewById<Switch>(R.id.enableExternalDomainSwitch)

        domainEditText.setText(configManager.externalDomain)
        enableSwitch.isChecked = configManager.useExternalDomain

        AlertDialog.Builder(this)
            .setTitle("External Domain Setup (Legacy)")
            .setView(dialogView)
            .setPositiveButton("Save") { _, _ ->
                val domain = domainEditText.text.toString().trim()
                val enabled = enableSwitch.isChecked

                configManager.externalDomain = domain
                configManager.useExternalDomain = enabled

                updateApiUrls()
                updateExternalDomainButton()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }
}
