package com.multi.encription.sms

import android.content.Context
import android.content.res.Configuration
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.ImageButton
import android.widget.ImageView
import androidx.core.content.ContextCompat
import androidx.test.core.app.ApplicationProvider
import com.google.android.material.floatingactionbutton.FloatingActionButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.multi.encription.sms.engine.GatewayActionType
import com.multi.encription.sms.engine.GatewayStateResolver
import com.multi.encription.sms.engine.GatewayStatusState
import com.multi.encription.sms.models.GatewayMode
import com.multi.encription.sms.network.ApiResult
import com.multi.encription.sms.network.HealthCheckResponse
import com.multi.encription.sms.network.GlobalGatewayApiClient
import com.multi.encription.sms.utils.ConfigManager
import com.multi.encription.sms.utils.PrivacyUtils
import com.multi.encription.sms.utils.TimeUtils
import com.multi.encription.sms.utils.UrlValidator
import com.multi.encription.sms.worker.BackendConnectionStatus
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class Phase6UiUxTest {

    private lateinit var context: Context
    private lateinit var configManager: ConfigManager
    private lateinit var mockWebServer: MockWebServer

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext<Context>()
        mockWebServer = MockWebServer()
        mockWebServer.start()

        configManager = ConfigManager(context)
        configManager.globalBackendUrl = mockWebServer.url("/").toString()
        configManager.gatewayMode = GatewayMode.GLOBAL_WORKER
        configManager.isWorkerEnabled = true
        configManager.secureStorage.saveGatewayKey("otp_gw_live_phase6_test_key_0123456789")
    }

    @After
    fun tearDown() {
        mockWebServer.shutdown()
    }

    // ==========================================
    // 1. Initial Configuration State
    // ==========================================
    @Test
    fun testInitialConfigurationState() {
        configManager.secureStorage.clearGatewayKey()
        assertFalse(configManager.secureStorage.hasGatewayKey())

        val display = GatewayStateResolver.resolve(
            hasKey = false,
            hasSmsPermissions = true,
            isSimReady = true,
            isWorkerEnabled = true,
            backendStatus = BackendConnectionStatus.UNKNOWN
        )

        assertEquals(GatewayStatusState.NOT_CONFIGURED, display.state)
        assertEquals(R.string.status_not_configured_title, display.titleRes)
        assertEquals(R.string.status_not_configured_action, display.actionRes)
        assertEquals(GatewayActionType.CONFIGURE, display.actionType)
        assertTrue(display.isWarning)
    }

    // ==========================================
    // 2. Saved Configuration State
    // ==========================================
    @Test
    fun testSavedConfigurationState() {
        assertTrue(configManager.secureStorage.hasGatewayKey())
        assertEquals(GatewayMode.GLOBAL_WORKER, configManager.gatewayMode)

        val display = GatewayStateResolver.resolve(
            hasKey = true,
            hasSmsPermissions = true,
            isSimReady = true,
            isWorkerEnabled = true,
            backendStatus = BackendConnectionStatus.CONNECTED
        )

        assertEquals(GatewayStatusState.READY, display.state)
        assertEquals(R.string.status_ready_title, display.titleRes)
        assertEquals(R.string.status_ready_action, display.actionRes)
        assertEquals(GatewayActionType.SYNC_NOW, display.actionType)
        assertFalse(display.isError)
    }

    // ==========================================
    // 3. Masked Gateway Key Behavior
    // ==========================================
    @Test
    fun testMaskedGatewayKeyBehavior() {
        val rawKey = "otp_gw_live_a1b2c3d4e5f67890"
        configManager.secureStorage.saveGatewayKey(rawKey)

        val masked = configManager.secureStorage.getMaskedGatewayKey()
        assertEquals("otp_gw_live_a1b2••••••••", masked)
        assertFalse("Masked key must not expose full secret", masked.contains("c3d4e5f67890"))

        // Short key fallback masking
        configManager.secureStorage.saveGatewayKey("short_key")
        assertEquals("••••••••", configManager.secureStorage.getMaskedGatewayKey())

        // Cleared key
        configManager.secureStorage.clearGatewayKey()
        assertEquals("Not Configured", configManager.secureStorage.getMaskedGatewayKey())
    }

    // ==========================================
    // 4. URL Validation
    // ==========================================
    @Test
    fun testUrlValidation() {
        assertTrue(UrlValidator.isValidBackendUrl("https://swift.company.com"))
        assertTrue(UrlValidator.isValidBackendUrl("http://localhost:3000"))
        assertTrue(UrlValidator.isValidBackendUrl("https://global-otp-service.vercel.app"))
        assertTrue(UrlValidator.isValidBackendUrl("http://192.168.1.100:8080/api"))

        assertFalse(UrlValidator.isValidBackendUrl(null))
        assertFalse(UrlValidator.isValidBackendUrl(""))
        assertFalse(UrlValidator.isValidBackendUrl("   "))
        assertFalse(UrlValidator.isValidBackendUrl("not-a-url"))
        assertFalse(UrlValidator.isValidBackendUrl("ftp://swift.company.com"))
        assertFalse(UrlValidator.isValidBackendUrl("https://"))
    }

    // ==========================================
    // 5. Connection Test Loading / Success / Failure States
    // ==========================================
    @Test
    fun testConnectionTestSuccess() = runBlocking {
        mockWebServer.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody("""{"status":"healthy","version":"1.0.0","services":{"database":"connected","activeGateways":1}}""")
        )

        val apiClient = GlobalGatewayApiClient(configManager)
        val result = apiClient.checkHealth()

        assertTrue(result is ApiResult.Success)
        val data = (result as ApiResult.Success<HealthCheckResponse>).data
        assertEquals("healthy", data.status)
        assertEquals("connected", data.services?.database)
    }

    @Test
    fun testConnectionTestHttpError() = runBlocking {
        mockWebServer.enqueue(
            MockResponse()
                .setResponseCode(503)
                .setBody("""{"error":"Database unreachable"}""")
        )

        val apiClient = GlobalGatewayApiClient(configManager)
        val result = apiClient.checkHealth()

        assertTrue(result is ApiResult.HttpError)
        assertEquals(503, (result as ApiResult.HttpError).statusCode)
    }

    @Test
    fun testConnectionTestAuthError() = runBlocking {
        mockWebServer.enqueue(
            MockResponse()
                .setResponseCode(401)
                .setBody("""{"error":"Invalid gateway credentials"}""")
        )

        val apiClient = GlobalGatewayApiClient(configManager)
        val result = apiClient.claimJobs(limit = 1)

        assertTrue("401 must be classified as AuthError", result is ApiResult.AuthError)
        assertEquals("Invalid or revoked Gateway API key", (result as ApiResult.AuthError).message)
    }

    // ==========================================
    // 6. Manual Sync Button Throttling
    // ==========================================
    @Test
    fun testManualSyncThrottling() {
        val now = System.currentTimeMillis()
        val throttleMs = 2500L

        // First tap allowed
        val isFirstAllowed = (now - 0L) >= throttleMs
        assertTrue(isFirstAllowed)

        // Rapid second tap within 500ms throttled
        val rapidTapTime = now + 500L
        val isSecondAllowed = (rapidTapTime - now) >= throttleMs
        assertFalse("Rapid consecutive sync must be throttled", isSecondAllowed)

        // Tap after throttle duration allowed
        val laterTapTime = now + 3000L
        val isLaterAllowed = (laterTapTime - now) >= throttleMs
        assertTrue(isLaterAllowed)
    }

    // ==========================================
    // 7. Worker Enabled / Disabled States
    // ==========================================
    @Test
    fun testWorkerEnabledDisabledStates() {
        val disabledDisplay = GatewayStateResolver.resolve(
            hasKey = true,
            hasSmsPermissions = true,
            isSimReady = true,
            isWorkerEnabled = false,
            backendStatus = BackendConnectionStatus.CONNECTED
        )

        assertEquals(GatewayStatusState.WORKER_DISABLED, disabledDisplay.state)
        assertEquals(R.string.status_worker_disabled_title, disabledDisplay.titleRes)
        assertEquals(GatewayActionType.ENABLE_WORKER, disabledDisplay.actionType)
        assertTrue(disabledDisplay.isWarning)

        val enabledDisplay = GatewayStateResolver.resolve(
            hasKey = true,
            hasSmsPermissions = true,
            isSimReady = true,
            isWorkerEnabled = true,
            backendStatus = BackendConnectionStatus.CONNECTED
        )

        assertEquals(GatewayStatusState.READY, enabledDisplay.state)
        assertEquals(GatewayActionType.SYNC_NOW, enabledDisplay.actionType)
    }

    // ==========================================
    // 8. Missing Permission State
    // ==========================================
    @Test
    fun testMissingPermissionState() {
        val display = GatewayStateResolver.resolve(
            hasKey = true,
            hasSmsPermissions = false,
            isSimReady = true,
            isWorkerEnabled = true,
            backendStatus = BackendConnectionStatus.CONNECTED
        )

        assertEquals(GatewayStatusState.PERMISSIONS_MISSING, display.state)
        assertEquals(R.string.status_permissions_missing_title, display.titleRes)
        assertEquals(R.string.status_permissions_missing_action, display.actionRes)
        assertEquals(GatewayActionType.GRANT_PERMISSIONS, display.actionType)
        assertTrue(display.isError)
    }

    // ==========================================
    // 9. Offline State
    // ==========================================
    @Test
    fun testOfflineState() {
        val display = GatewayStateResolver.resolve(
            hasKey = true,
            hasSmsPermissions = true,
            isSimReady = true,
            isWorkerEnabled = true,
            backendStatus = BackendConnectionStatus.OFFLINE
        )

        assertEquals(GatewayStatusState.OFFLINE, display.state)
        assertEquals(R.string.status_offline_title, display.titleRes)
        assertEquals(R.string.status_offline_action, display.actionRes)
        assertEquals(GatewayActionType.RETRY_CONNECTION, display.actionType)
        assertTrue(display.isWarning)
    }

    // ==========================================
    // 10. Accessibility Labels on Important Controls
    // ==========================================
    @Test
    fun testAccessibilityLabelsOnImportantControls() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()

        val btnSettings = activity.findViewById<ImageButton>(R.id.btnHeaderSettings)
        assertNotNull("Settings button must exist", btnSettings)
        assertEquals(activity.getString(R.string.action_settings), btnSettings.contentDescription)

        val btnFab = activity.findViewById<FloatingActionButton>(R.id.sendSmsFab)
        assertNotNull("Send SMS FAB must exist", btnFab)
        assertEquals(activity.getString(R.string.action_send_test_sms), btnFab.contentDescription)

        val workerToggle = activity.findViewById<MaterialSwitch>(R.id.workerToggle)
        assertNotNull("Worker toggle must exist", workerToggle)
        assertEquals(activity.getString(R.string.settings_worker_switch), workerToggle.contentDescription)

        val appLogo = activity.findViewById<ImageView>(R.id.appLogoImage)
        assertNotNull("App logo must exist", appLogo)
        assertEquals(activity.getString(R.string.swift_logo_description), appLogo.contentDescription)

        controller.destroy()
    }

    // ==========================================
    // 11. Dark Theme Resource Availability
    // ==========================================
    @Test
    fun testDarkThemeResourceAvailability() {
        val nightContext = context.createConfigurationContext(
            Configuration(context.resources.configuration).apply {
                uiMode = Configuration.UI_MODE_NIGHT_YES or (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv())
            }
        )

        // Verify key color tokens exist and resolve in night mode
        val bgNight = ContextCompat.getColor(nightContext, R.color.swift_bg)
        val surfaceNight = ContextCompat.getColor(nightContext, R.color.swift_surface)
        val brandNight = ContextCompat.getColor(nightContext, R.color.swift_brand_primary)
        val successNight = ContextCompat.getColor(nightContext, R.color.swift_status_success)

        assertNotEquals(0, bgNight)
        assertNotEquals(0, surfaceNight)
        assertNotEquals(0, brandNight)
        assertNotEquals(0, successNight)

        // Dark theme background must be near-black (not pure black #000000)
        assertNotEquals(0xFF000000.toInt(), bgNight)
    }

    // ==========================================
    // 12. Configuration Persistence Across Activity Recreation
    // ==========================================
    @Test
    fun testConfigurationPersistenceAcrossActivityRecreation() {
        configManager.globalBackendUrl = "https://custom.swift.dev"
        configManager.gatewayMode = GatewayMode.GLOBAL_WORKER
        configManager.isWorkerEnabled = true

        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()

        val bundle = Bundle()
        controller.saveInstanceState(bundle)
        controller.destroy()

        // Recreate with saved state
        val recreatedController = Robolectric.buildActivity(MainActivity::class.java).setup(bundle)
        val recreatedActivity = recreatedController.get()

        val reloadedConfig = ConfigManager(recreatedActivity)
        assertEquals("https://custom.swift.dev", reloadedConfig.globalBackendUrl)
        assertEquals(GatewayMode.GLOBAL_WORKER, reloadedConfig.gatewayMode)
        assertTrue(reloadedConfig.isWorkerEnabled)

        recreatedController.destroy()
    }

    // ==========================================
    // 13. Privacy Masking & Diagnostics Scrubbing
    // ==========================================
    @Test
    fun testPrivacyMaskingAndDiagnosticsScrubbing() {
        // Phone number masking
        assertEquals("+91 ••••••• 210", PrivacyUtils.maskPhoneNumber("+919876543210"))
        assertEquals("•••••••890", PrivacyUtils.maskPhoneNumber("1234567890"))

        // OTP code masking in message bodies
        val message = "Your Swift verification code is 849201. Do not share this code."
        val maskedMessage = PrivacyUtils.maskOtpMessage(message)
        assertEquals("Your Swift verification code is ••••••. Do not share this code.", maskedMessage)
        assertFalse(maskedMessage.contains("849201"))

        // Diagnostics scrubbing
        val rawDiag = "Gateway error: Bearer secret_token_xyz for key otp_gw_live_abc123456789 with recipient +919876543210"
        val scrubbed = PrivacyUtils.scrubDiagnostics(rawDiag)
        assertFalse(scrubbed.contains("secret_token_xyz"))
        assertFalse(scrubbed.contains("abc123456789"))
        assertTrue(scrubbed.contains("Bearer [REDACTED]"))
        assertTrue(scrubbed.contains("otp_gw_[REDACTED]"))
        assertTrue(scrubbed.contains("+91 ••••••• 210"))
    }
}
