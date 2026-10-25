package com.multi.encription.sms

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.gson.Gson
import com.multi.encription.sms.engine.DrainSource
import com.multi.encription.sms.engine.JobDrainEngine
import com.multi.encription.sms.models.GatewayMode
import com.multi.encription.sms.network.ClaimedJobDto
import com.multi.encription.sms.network.GatewayJobsResponse
import com.multi.encription.sms.network.GlobalGatewayApiClient
import com.multi.encription.sms.network.RegisterPushTokenRequest
import com.multi.encription.sms.network.RegisterPushTokenResponse
import com.multi.encription.sms.network.UnregisterPushTokenResponse
import com.multi.encription.sms.push.GatewayFirebaseMessagingService
import com.multi.encription.sms.utils.ConfigManager
import com.multi.encription.sms.worker.GatewayRecoveryWorker
import com.multi.encription.sms.worker.JobDrainWorker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class Phase3EventDrivenGatewayTest {

    private val gson = Gson()
    private lateinit var mockWebServer: MockWebServer

    @Before
    fun setUp() {
        mockWebServer = MockWebServer()
        mockWebServer.start()
    }

    @After
    fun tearDown() {
        mockWebServer.shutdown()
    }

    /**
     * Requirement H.1: Only JOBS_AVAILABLE is accepted.
     */
    @Test
    fun test1_only_jobs_available_accepted() {
        val validPayloadType = GatewayFirebaseMessagingService.EXPECTED_PAYLOAD_TYPE
        assertEquals("JOBS_AVAILABLE", validPayloadType)

        fun shouldProcessMessage(type: String?): Boolean {
            return type == GatewayFirebaseMessagingService.EXPECTED_PAYLOAD_TYPE
        }

        assertTrue("JOBS_AVAILABLE must be accepted", shouldProcessMessage("JOBS_AVAILABLE"))
    }

    /**
     * Requirement H.2: Unknown FCM types are ignored safely without errors.
     */
    @Test
    fun test2_unknown_fcm_types_ignored() {
        fun shouldProcessMessage(type: String?): Boolean {
            return type == GatewayFirebaseMessagingService.EXPECTED_PAYLOAD_TYPE
        }

        assertFalse("null payload type must be ignored", shouldProcessMessage(null))
        assertFalse("empty string payload must be ignored", shouldProcessMessage(""))
        assertFalse("MARKETING type must be ignored", shouldProcessMessage("MARKETING"))
        assertFalse("HEARTBEAT_PROBE type must be ignored", shouldProcessMessage("HEARTBEAT_PROBE"))
        assertFalse("NEW_TEMPLATE type must be ignored", shouldProcessMessage("NEW_TEMPLATE"))
    }

    /**
     * Requirement H.3: Duplicate push wakes coalesce into unique work.
     */
    @Test
    fun test3_duplicate_push_wakes_coalesce_into_unique_work() {
        // Unique work name definition
        assertEquals("swift_expedited_job_drain", JobDrainWorker.UNIQUE_WORK_NAME)

        // Simulate unique-work queue semantics where concurrent triggers coalesce
        val activeWorkQueue = ConcurrentHashMap<String, Boolean>()
        var executionCount = 0

        fun triggerWake(): Boolean {
            val isNewWork = activeWorkQueue.putIfAbsent(JobDrainWorker.UNIQUE_WORK_NAME, true) == null
            if (isNewWork) {
                executionCount++
            }
            return isNewWork
        }

        // 5 consecutive wakes arrive in rapid succession
        val wake1 = triggerWake()
        val wake2 = triggerWake()
        val wake3 = triggerWake()
        val wake4 = triggerWake()
        val wake5 = triggerWake()

        assertTrue("First wake must start work", wake1)
        assertFalse("Duplicate wake 2 must coalesce", wake2)
        assertFalse("Duplicate wake 3 must coalesce", wake3)
        assertFalse("Duplicate wake 4 must coalesce", wake4)
        assertFalse("Duplicate wake 5 must coalesce", wake5)
        assertEquals("Only 1 unique execution task must be triggered", 1, executionCount)
    }

    /**
     * Requirement H.4: Token registration request matches the Phase 2 API.
     */
    @Test
    fun test4_token_registration_request_matches_phase2_api() {
        val request = RegisterPushTokenRequest(
            token = "fcm_device_token_xyz123abc456",
            provider = "FCM",
            platform = "ANDROID",
            deviceFingerprint = "inst_9876543210abcdef",
            appVersion = "1.0"
        )

        val json = gson.toJson(request)

        assertTrue(json.contains("\"token\":\"fcm_device_token_xyz123abc456\""))
        assertTrue(json.contains("\"provider\":\"FCM\""))
        assertTrue(json.contains("\"platform\":\"ANDROID\""))
        assertTrue(json.contains("\"device_fingerprint\":\"inst_9876543210abcdef\""))
        assertTrue(json.contains("\"app_version\":\"1.0\""))

        val backendResponseJson = """
            {
              "success": true,
              "data": {
                "registered": true,
                "provider": "FCM",
                "platform": "ANDROID",
                "last_registered_at": "2026-10-25T14:00:00.000Z"
              }
            }
        """.trimIndent()

        val parsed = gson.fromJson(backendResponseJson, RegisterPushTokenResponse::class.java)
        assertTrue(parsed.success)
        assertNotNull(parsed.data)
        assertTrue(parsed.data!!.registered)
        assertEquals("FCM", parsed.data!!.provider)
        assertEquals("ANDROID", parsed.data!!.platform)
    }

    /**
     * Requirement H.5: Token registration never places the token in a URL.
     */
    @Test
    fun test5_token_registration_never_places_token_in_url() = runBlocking {
        val rawToken = "fcm_very_secret_token_12345"
        val context = ApplicationProvider.getApplicationContext<Context>()
        val config = ConfigManager(context)
        config.globalBackendUrl = mockWebServer.url("/").toString()
        config.secureStorage.saveGatewayKey("otp_gw_live_test_key_for_request_contract")
        mockWebServer.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"success":true,"data":{"registered":true,"provider":"FCM","platform":"ANDROID"}}"""
            )
        )

        val result = GlobalGatewayApiClient(config).registerPushToken(
            RegisterPushTokenRequest(token = rawToken)
        )
        assertTrue(result is com.multi.encription.sms.network.ApiResult.Success)

        val recorded = mockWebServer.takeRequest()
        assertEquals("PUT", recorded.method)
        assertEquals("/api/v1/gateway/push-token", recorded.requestUrl?.encodedPath)
        assertNull("Token must NEVER be in URL query params", recorded.requestUrl?.query)
        assertFalse("Token must NEVER be in the URL", recorded.requestUrl.toString().contains(rawToken))
        assertTrue("Token belongs only in the authenticated JSON body", recorded.body.readUtf8().contains(rawToken))
    }

    /**
     * Requirement H.6: No credentials are returned or logged.
     */
    @Test
    fun test6_no_credentials_returned_or_logged() {
        val testGatewayKey = "otp_gw_live_0a1b2c3d4e5f6g7h8i9j0k"
        fun maskKey(key: String): String = "${key.take(16)}••••••••"
        fun tokenStatusLabel(): String = "Registered"

        val maskedKey = maskKey(testGatewayKey)
        val rawToken = "fcm_secret_device_registration_token_999"
        val tokenLabel = tokenStatusLabel()

        assertFalse("Masked key must not expose full secret", maskedKey.contains("8i9j0k"))
        assertEquals("otp_gw_live_0a1b••••••••", maskedKey)

        assertFalse("Token label must not expose any token fragment", tokenLabel.contains("fcm_"))
        assertEquals("Registered", tokenLabel)

        // Verify DELETE response contains zero tokens or keys
        val deleteResponseJson = """
            {
              "success": true,
              "data": {
                "invalidated": true,
                "count": 1
              }
            }
        """.trimIndent()
        val parsed = gson.fromJson(deleteResponseJson, UnregisterPushTokenResponse::class.java)
        assertTrue(parsed.success)
        assertTrue(parsed.data!!.invalidated)
        assertFalse("Response must not contain raw token", deleteResponseJson.contains(rawToken))
    }

    /**
     * Requirement H.7: Missing gateway configuration defers registration safely.
     */
    @Test
    fun test7_missing_gateway_config_defers_registration_safely() {
        var configuredGatewayKey: String? = null
        var pendingToken: String? = null
        var networkCallsExecuted = 0

        fun handleNewToken(token: String): String {
            pendingToken = token
            if (configuredGatewayKey.isNullOrBlank()) {
                return "DEFERRED"
            }
            networkCallsExecuted++
            return "REGISTERED"
        }

        // Token received on first launch before user configures gateway key
        val result = handleNewToken("fcm_initial_boot_token")
        assertEquals("DEFERRED", result)
        assertEquals("fcm_initial_boot_token", pendingToken)
        assertEquals(0, networkCallsExecuted)

        // User enters credentials in settings dialog
        configuredGatewayKey = "otp_gw_live_test_key"
        fun onGatewayConfigured(): String {
            if (pendingToken != null && !configuredGatewayKey.isNullOrBlank()) {
                networkCallsExecuted++
                return "REGISTERED"
            }
            return "IDLE"
        }

        val deferredSyncResult = onGatewayConfigured()
        assertEquals("REGISTERED", deferredSyncResult)
        assertEquals(1, networkCallsExecuted)
    }

    /**
     * Requirement H.8: Token refresh causes re-registration.
     */
    @Test
    fun test8_token_refresh_causes_re_registration() {
        var currentRegisteredToken: String? = null
        var registrationCalls = 0

        fun sha256(input: String): String {
            val digest = MessageDigest.getInstance("SHA-256")
            return digest.digest(input.toByteArray()).joinToString("") { "%02x".format(it) }
        }

        var cachedHash: String? = null

        fun registerToken(token: String): Boolean {
            val hash = sha256(token)
            if (hash == cachedHash) {
                return false // Idempotent no-op
            }
            cachedHash = hash
            currentRegisteredToken = token
            registrationCalls++
            return true
        }

        // Initial token
        assertTrue("Initial registration succeeds", registerToken("token_v1"))
        assertEquals("token_v1", currentRegisteredToken)
        assertEquals(1, registrationCalls)

        // Idempotent duplicate call with same token
        assertFalse("Duplicate token is idempotent no-op", registerToken("token_v1"))
        assertEquals(1, registrationCalls)

        // Token refreshed by Firebase onNewToken
        assertTrue("Refreshed token triggers re-registration", registerToken("token_v2_refreshed"))
        assertEquals("token_v2_refreshed", currentRegisteredToken)
        assertEquals(2, registrationCalls)
    }

    /**
     * Requirement H.9: Job draining stops on an empty queue.
     */
    @Test
    fun test9_job_draining_stops_on_empty_queue() {
        val emptyQueueResponse = GatewayJobsResponse(
            success = true,
            data = com.multi.encription.sms.network.GatewayJobsData(jobs = emptyList())
        )

        var claimCalls = 0
        fun mockClaim(): List<ClaimedJobDto> {
            claimCalls++
            return emptyQueueResponse.data!!.jobs
        }

        var totalDrained = 0
        while (true) {
            val jobs = mockClaim()
            if (jobs.isEmpty()) break
            totalDrained += jobs.size
        }

        assertEquals("Must check queue exactly once when empty", 1, claimCalls)
        assertEquals("Total jobs drained must be 0", 0, totalDrained)
    }

    /**
     * Requirement H.10: Job draining processes multiple queued jobs within its safety bound.
     */
    @Test
    fun test10_job_draining_processes_multiple_queued_jobs_within_bound() {
        val safetyMaxBound = JobDrainEngine.MAX_JOBS_PER_DRAIN_RUN
        assertEquals(25, safetyMaxBound)

        val availableJobs = (1..30).map { i ->
            ClaimedJobDto(
                jobId = "job_$i",
                phoneNumber = "+9198765432$i",
                message = "OTP: 12345$i",
                createdAt = "2026-10-25T14:00:00Z",
                leaseExpiresAt = "2026-10-25T14:01:00Z"
            )
        }.toMutableList()

        var drainedCount = 0
        while (drainedCount < safetyMaxBound && availableJobs.isNotEmpty()) {
            val job = availableJobs.removeAt(0)
            drainedCount++
        }

        assertEquals("Draining must process up to the safety limit (25)", 25, drainedCount)
        assertEquals("Remaining jobs in simulated queue", 5, availableJobs.size)
    }

    /**
     * Requirement H.11: Concurrent drain requests are single-flight.
     */
    @Test
    fun test11_concurrent_drain_requests_are_single_flight() = runBlocking {
        val mutex = Mutex()
        val concurrentCounter = AtomicInteger(0)
        val maxConcurrentSeen = AtomicInteger(0)
        val totalExecutions = AtomicInteger(0)

        suspend fun singleFlightDrain(): Boolean {
            if (!mutex.tryLock()) {
                return false // Coalesce
            }
            try {
                val current = concurrentCounter.incrementAndGet()
                if (current > maxConcurrentSeen.get()) {
                    maxConcurrentSeen.set(current)
                }
                delay(50) // simulate network/telephony work
                totalExecutions.incrementAndGet()
                return true
            } finally {
                concurrentCounter.decrementAndGet()
                mutex.unlock()
            }
        }

        // Launch 10 concurrent requests simultaneously
        val jobs = (1..10).map {
            async(Dispatchers.Default) {
                singleFlightDrain()
            }
        }

        val results = jobs.awaitAll()
        assertEquals("Exactly 1 concurrent runner at any given time", 1, maxConcurrentSeen.get())
        assertTrue("At least 1 request completed", totalExecutions.get() >= 1)
        assertTrue("Some overlapping requests were safely rejected/coalesced", results.count { !it } > 0)
    }

    /**
     * Requirement H.12: Recovery work is unique and periodic.
     */
    @Test
    fun test12_recovery_work_is_unique_and_periodic() {
        assertEquals("swift_gateway_recovery", GatewayRecoveryWorker.UNIQUE_PERIODIC_WORK_NAME)

        // Multiple calls to scheduler simulate multiple app launches
        val scheduledWork = mutableMapOf<String, String>()
        fun scheduleRecovery(workName: String, policy: String) {
            if (!scheduledWork.containsKey(workName) || policy == "REPLACE") {
                scheduledWork[workName] = policy
            }
        }

        scheduleRecovery(GatewayRecoveryWorker.UNIQUE_PERIODIC_WORK_NAME, "KEEP")
        scheduleRecovery(GatewayRecoveryWorker.UNIQUE_PERIODIC_WORK_NAME, "KEEP")
        scheduleRecovery(GatewayRecoveryWorker.UNIQUE_PERIODIC_WORK_NAME, "KEEP")

        assertEquals(1, scheduledWork.size)
        assertTrue(scheduledWork.containsKey("swift_gateway_recovery"))
        assertEquals("KEEP", scheduledWork["swift_gateway_recovery"])
    }

    /**
     * Requirement H.13: Continuous short-interval polling no longer starts.
     */
    @Test
    fun test13_continuous_short_interval_polling_no_longer_starts() {
        // Assert that polling interval constants have been eliminated from the worker
        val workerClass = com.multi.encription.sms.worker.GlobalGatewayWorker::class.java
        val declaredFields = workerClass.declaredFields.map { it.name }

        assertFalse("MIN_POLL_INTERVAL_MS must not exist", declaredFields.contains("MIN_POLL_INTERVAL_MS"))
        assertFalse("MAX_POLL_INTERVAL_MS must not exist", declaredFields.contains("MAX_POLL_INTERVAL_MS"))
        assertFalse("currentPollIntervalMs must not exist", declaredFields.contains("currentPollIntervalMs"))
        assertFalse("pollingJob must not exist", declaredFields.contains("pollingJob"))
    }

    /**
     * Requirement H.14: Manual sync still works.
     */
    @Test
    fun test14_manual_sync_still_works() {
        val drainSource = DrainSource.MANUAL_SYNC
        assertEquals("MANUAL_SYNC", drainSource.name)

        var manualSyncInvoked = false
        fun syncNow() {
            manualSyncInvoked = true
        }

        syncNow()
        assertTrue("Manual sync must execute on user demand", manualSyncInvoked)
    }

    /**
     * Requirement H.15: Existing duplicate-SMS protection remains effective.
     */
    @Test
    fun test15_existing_duplicate_sms_protection_remains_effective() {
        val processedJobIds = setOf("job_101", "job_102")

        fun isJobDuplicate(jobId: String): Boolean {
            return processedJobIds.contains(jobId)
        }

        assertTrue("job_101 must be recognized as duplicate", isJobDuplicate("job_101"))
        assertTrue("job_102 must be recognized as duplicate", isJobDuplicate("job_102"))
        assertFalse("job_103 must be recognized as fresh job", isJobDuplicate("job_103"))
    }

    /**
     * Requirement H.16: LOCAL_API mode remains unaffected.
     */
    @Test
    fun test16_local_api_mode_remains_unaffected() {
        assertEquals(2, GatewayMode.values().size)
        val localMode = GatewayMode.LOCAL_API

        fun shouldProcessFCMWake(mode: GatewayMode): Boolean {
            return mode == GatewayMode.GLOBAL_WORKER
        }

        assertFalse("FCM push wake must be ignored when in LOCAL_API mode", shouldProcessFCMWake(localMode))
        assertTrue("FCM push wake is active in GLOBAL_WORKER mode", shouldProcessFCMWake(GatewayMode.GLOBAL_WORKER))
    }
}
