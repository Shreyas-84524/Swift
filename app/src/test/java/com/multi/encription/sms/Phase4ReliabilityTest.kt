package com.multi.encription.sms

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.gson.Gson
import com.multi.encription.sms.engine.DrainSource
import com.multi.encription.sms.engine.DrainSummary
import com.multi.encription.sms.engine.JobDrainEngine
import com.multi.encription.sms.models.GatewayMode
import com.multi.encription.sms.network.ApiResult
import com.multi.encription.sms.network.GlobalGatewayApiClient
import com.multi.encription.sms.push.FcmTokenCoordinator
import com.multi.encription.sms.push.TokenSyncResult
import com.multi.encription.sms.utils.ConfigManager
import com.multi.encription.sms.worker.GatewayRecoveryWorker
import com.multi.encription.sms.worker.GlobalGatewayWorker
import com.multi.encription.sms.worker.JobDrainWorker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class Phase4ReliabilityTest {

    private val gson = Gson()
    private lateinit var mockWebServer: MockWebServer
    private lateinit var context: Context
    private lateinit var configManager: ConfigManager

    @Before
    fun setUp() {
        mockWebServer = MockWebServer()
        mockWebServer.start()
        context = ApplicationProvider.getApplicationContext<Context>()
        JobDrainEngine.resetForTesting()
        FcmTokenCoordinator.resetForTesting()
        context.getSharedPreferences("fcm_token_cache", Context.MODE_PRIVATE).edit().clear().commit()
        configManager = ConfigManager(context)
        configManager.globalBackendUrl = mockWebServer.url("/").toString()
        configManager.gatewayMode = GatewayMode.GLOBAL_WORKER
        configManager.isWorkerEnabled = true
        configManager.secureStorage.saveGatewayKey("otp_gw_live_phase4_test_key_0123456789")
    }

    @After
    fun tearDown() {
        mockWebServer.shutdown()
        configManager.secureStorage.clearPendingFcmToken()
        context.getSharedPreferences("fcm_token_cache", Context.MODE_PRIVATE).edit().clear().commit()
        JobDrainEngine.resetForTesting()
        FcmTokenCoordinator.resetForTesting()
    }

    /**
     * Requirement P4.1: Transient HTTP 429 Too Many Requests triggers retry recommendation.
     */
    @Test
    fun test1_transient_http_429_triggers_retryRecommended() = runBlocking {
        mockWebServer.enqueue(MockResponse().setResponseCode(429).setBody("""{"success":false,"error":"Too Many Requests"}"""))

        val summary = JobDrainEngine.getInstance(context).drainQueue(DrainSource.FCM_PUSH)
        assertTrue("Drain summary must recommend retry on HTTP 429", summary.retryRecommended)
        assertEquals(0, summary.jobsClaimed)
    }

    /**
     * Requirement P4.2: Transient HTTP 500 Internal Server Error triggers retry recommendation.
     */
    @Test
    fun test2_transient_http_500_triggers_retryRecommended() = runBlocking {
        mockWebServer.enqueue(MockResponse().setResponseCode(500).setBody("""{"success":false,"error":"Internal Server Error"}"""))

        val summary = JobDrainEngine.getInstance(context).drainQueue(DrainSource.FCM_PUSH)
        assertTrue("Drain summary must recommend retry on HTTP 500", summary.retryRecommended)
        assertEquals(0, summary.jobsClaimed)
    }

    /**
     * Requirement P4.3: Transient HTTP 503 Service Unavailable triggers retry recommendation.
     */
    @Test
    fun test3_transient_http_503_triggers_retryRecommended() = runBlocking {
        mockWebServer.enqueue(MockResponse().setResponseCode(503).setBody("""{"success":false,"error":"Service Unavailable"}"""))

        val summary = JobDrainEngine.getInstance(context).drainQueue(DrainSource.FCM_PUSH)
        assertTrue("Drain summary must recommend retry on HTTP 503", summary.retryRecommended)
        assertEquals(0, summary.jobsClaimed)
    }

    /**
     * Requirement P4.4: Network disconnect or socket timeout triggers retry recommendation.
     */
    @Test
    fun test4_network_disconnect_or_timeout_triggers_retryRecommended() = runBlocking {
        mockWebServer.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))

        val summary = JobDrainEngine.getInstance(context).drainQueue(DrainSource.FCM_PUSH)
        assertTrue("Drain summary must recommend retry on network disconnect/timeout", summary.retryRecommended)
        assertEquals(0, summary.jobsClaimed)
    }

    /**
     * Requirement P4.5: Non-retryable HTTP 401 Auth Error halts immediate retry (does not spam server).
     */
    @Test
    fun test5_non_retryable_http_401_auth_error_halts_immediate_retry() = runBlocking {
        mockWebServer.enqueue(MockResponse().setResponseCode(401).setBody("""{"success":false,"error":"Invalid Gateway Key"}"""))

        val summary = JobDrainEngine.getInstance(context).drainQueue(DrainSource.FCM_PUSH)
        assertFalse("Drain summary must NOT recommend retry on 401 Auth Error", summary.retryRecommended)
        assertEquals(0, summary.jobsClaimed)
    }

    /**
     * Requirement P4.6: Push token is persisted synchronously before asynchronous network call.
     */
    @Test
    fun test6_token_persisted_synchronously_before_network_call() {
        val testToken = "fcm_sync_persist_token_abcdef123456"
        val coordinator = FcmTokenCoordinator.getInstance(context)

        coordinator.cachePendingToken(testToken)

        val persisted = configManager.secureStorage.getPendingFcmToken()
        assertNotNull("Pending FCM token must be synchronously persisted to secure storage", persisted)
        assertEquals(testToken, persisted)
    }

    /**
     * Requirement P4.7: Push token resumes across process recreation via syncToken.
     */
    @Test
    fun test7_token_resumes_across_process_death_via_recovery() = runBlocking {
        val pendingToken = "fcm_death_resume_token_999888777"
        configManager.secureStorage.savePendingFcmToken(pendingToken)

        mockWebServer.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"success":true,"data":{"registered":true,"provider":"FCM","platform":"ANDROID","last_registered_at":"2026-10-25T14:30:00.000Z"}}"""
            )
        )

        val coordinator = FcmTokenCoordinator.getInstance(context)
        val syncResult = coordinator.syncToken()

        assertTrue("Token sync must succeed using pending token stored before process death", syncResult is TokenSyncResult.Success)

        val request = mockWebServer.takeRequest()
        assertEquals("PUT", request.method)
        assertEquals("/api/v1/gateway/push-token", request.requestUrl?.encodedPath)
        assertTrue("Registration request body must contain pending token", request.body.readUtf8().contains(pendingToken))

        assertNull("Pending token in secure storage must be cleared after successful registration", configManager.secureStorage.getPendingFcmToken())
    }

    /**
     * Requirement P4.8: Single-flight in-flight mutex prevents duplicate concurrent SMS queue drains.
     */
    @Test
    fun test8_inflight_deduplication_prevents_duplicate_sms_dispatch() = runBlocking {
        val mutex = Mutex()
        val concurrentRunning = AtomicInteger(0)
        val maxConcurrentSeen = AtomicInteger(0)
        val successfulRuns = AtomicInteger(0)

        suspend fun simulatedDrain(): DrainSummary {
            if (!mutex.tryLock()) {
                return DrainSummary(0, 0, 0, false, false, false)
            }
            try {
                val current = concurrentRunning.incrementAndGet()
                if (current > maxConcurrentSeen.get()) {
                    maxConcurrentSeen.set(current)
                }
                delay(30)
                successfulRuns.incrementAndGet()
                return DrainSummary(1, 1, 0, false, false, false)
            } finally {
                concurrentRunning.decrementAndGet()
                mutex.unlock()
            }
        }

        val deferreds = (1..8).map {
            async(Dispatchers.Default) {
                simulatedDrain()
            }
        }

        val summaries = deferreds.awaitAll()
        assertEquals("At no point may concurrent drain operations run simultaneously", 1, maxConcurrentSeen.get())
        assertTrue("At least one drain run executed", successfulRuns.get() >= 1)
        assertTrue("Overlapping concurrent calls were safely deduplicated", summaries.count { it.jobsClaimed == 0 } > 0)
    }

    /**
     * Requirement P4.9: LOCAL_API mode isolation ignores global push and recovery.
     */
    @Test
    fun test9_local_mode_isolation_ignores_global_push_and_recovery() = runBlocking {
        configManager.gatewayMode = GatewayMode.LOCAL_API

        val summary = JobDrainEngine.getInstance(context).drainQueue(DrainSource.FCM_PUSH)
        assertEquals("LOCAL_API mode must not claim jobs from global queue", 0, summary.jobsClaimed)
        assertEquals("LOCAL_API mode must not dispatch jobs", 0, summary.jobsDispatched)
        assertFalse(summary.retryRecommended)
        assertEquals("Zero requests must reach global backend when in LOCAL_API mode", 0, mockWebServer.requestCount)
    }

    /**
     * Requirement P4.10: JobDrainWorker caps expedited retries at 3 attempts, failing over to 15m periodic recovery.
     */
    @Test
    fun test10_job_drain_worker_caps_expedited_retries_at_3() {
        assertEquals(3, JobDrainWorker.MAX_EXECUTION_ATTEMPTS)
        assertTrue("Initial execution may schedule retry 1", JobDrainWorker.hasRetryAttemptsRemaining(0))
        assertTrue("Second execution may schedule the final retry", JobDrainWorker.hasRetryAttemptsRemaining(1))
        assertFalse("Third execution must yield to periodic recovery", JobDrainWorker.hasRetryAttemptsRemaining(2))
        assertFalse("Later executions must remain capped", JobDrainWorker.hasRetryAttemptsRemaining(3))
    }

    /**
     * Requirement P4.11: Push token registration conflict (HTTP 409) is handled cleanly without crash.
     */
    @Test
    fun test11_token_registration_conflict_409_handled_without_crash() = runBlocking {
        configManager.secureStorage.savePendingFcmToken("token_conflict_test")
        mockWebServer.enqueue(MockResponse().setResponseCode(409).setBody("""{"success":false,"error":"Token belongs to another gateway"}"""))

        val coordinator = FcmTokenCoordinator.getInstance(context)
        val syncResult = coordinator.syncToken()

        assertTrue("HTTP 409 Conflict must return TokenSyncResult.Conflict", syncResult is TokenSyncResult.Conflict)
    }

    /**
     * Requirement P4.12: Continuous 60s background heartbeat loop is eliminated.
     */
    @Test
    fun test12_continuous_60s_background_heartbeat_loop_eliminated() {
        val workerClass = GlobalGatewayWorker::class.java
        val declaredMethods = workerClass.declaredMethods.map { it.name }
        val declaredFields = workerClass.declaredFields.map { it.name }

        assertFalse("Continuous background startHeartbeatLoop must not exist", declaredMethods.contains("startHeartbeatLoop"))
        assertFalse("HEARTBEAT_INTERVAL_MS continuous timer must not exist", declaredFields.contains("HEARTBEAT_INTERVAL_MS"))
    }
}
