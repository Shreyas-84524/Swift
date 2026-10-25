# Android Gateway Worker — Architecture & Execution Strategy

## 1. Background Execution Strategy & Android 15 Hardening

### 1.1 Technical Evaluation of Android Background Mechanisms

| Mechanism | Suitability for OTP Delivery | Latency | Battery Efficiency | Android 14/15 Constraints | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Push-Triggered Worker (FCM High-Priority)** | **Primary Production Mechanism** | Immediate push wake-up (<500ms) on demand | Optimal (zero background CPU/network when idle) | Complies with all Android background & Doze policies | ✅ **Phase 3 Production Implementation** (Event-Driven) |
| **WorkManager (Expedited Worker)** | **Push Execution Host** | Immediate (<100ms) from FCM push service | High (executes single drain pass and finishes) | Subject to OS quota; graceful fallback to in-memory drain | ✅ **Phase 3 Production Implementation** (`JobDrainWorker`) |
| **WorkManager (Periodic 15-min)** | **Durable Recovery Net** | Periodic (15-minute intervals) | Excellent (runs only when device is awake/connected) | Enforced by OS; catches any unhandled or dropped pushes | ✅ **Phase 3 Production Implementation** (`GatewayRecoveryWorker`) |
| **Foreground Service (`dataSync`)** | **Local API / Companion Lifecycle** | No global polling or periodic heartbeat loop | Depends on local-mode use | Cumulative 6h/24h timeout when backgrounded on Android 15 | ✅ Delivery is independent through FCM + WorkManager |
| **Continuous HTTP Polling Loop (3–60s)** | **Obsolete / Inefficient** | Sub-second to 60s | Poor (constant radio wakeups, high battery drain) | Battery optimization aggressively throttles background network | ❌ **Completely Removed in Phase 3** |

---

### 1.2 Android 15 (API Level 35) Foreground Service Limitations

Starting with Android 15 (API level 35 / `targetSdk 35`), Android enforces strict runtime quotas on `dataSync` foreground services:

1. **Cumulative 6-Hour Timeout:**
   - A `dataSync` foreground service is capped at a **cumulative 6 hours within a rolling 24-hour window** while running in the background.
2. **Non-Bypassable OS Restrictions:**
   - `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` does **NOT** remove or extend this FGS timeout.
   - Keeping the phone connected to a charger does **NOT** remove this timeout.
   - Once the 6-hour budget is exhausted, another `dataSync` foreground service cannot be started until the app returns to the foreground and the 24-hour quota resets.
3. **Event-Driven Resilience:**
   - Because Phase 3 eliminated continuous background polling, the gateway no longer depends on an uninterrupted `dataSync` foreground service loop to claim SMS jobs.
   - High-priority FCM data messages wake the device via `GatewayFirebaseMessagingService` even if the screen is off or the foreground service was paused.
   - `SmsGatewayService` implements `override fun onTimeout()` to cleanly stop foreground service components without risking uncatchable `ForegroundServiceDidNotStopInTimeException` crashes.

---

### 1.3 Event-Driven Architecture (Phase 3 Implemented)

The gateway operates on an **event-driven push-wake architecture** where PostgreSQL remains the durable source of truth, and FCM is strictly an ephemeral wake-up signal:

```text
Client Application (CivicFix / Hostix)
        ↓ HTTPS POST /api/v1/otp/send
Swift Cloud Backend
        ↓ 1. Persists challenge & creates sms_job (QUEUED) in PostgreSQL
        ↓ 2. Inserts notification_outbox item & dispatches High-Priority FCM Wakeup
Android Gateway Device (Screen Off / Sleeping)
        ↓ 3. High-priority FCM push (data.type = "JOBS_AVAILABLE") wakes GatewayFirebaseMessagingService
        ↓ 4. Dispatches expedited JobDrainWorker (<500ms) or direct JobDrainEngine
        ↓ 5. Atomic HTTP claim lease: POST /api/v1/gateway/jobs (X-Gateway-Key)
        ↓ 6. Android SmsManager dispatches SMS via physical SIM
        ↓ 7. SmsStatusReceiver captures carrier SENT / DELIVERED broadcasts
        ↓ 8. Updates status via HTTPS POST /api/v1/gateway/jobs/{id}/status
```

**Key Architectural Guarantees:**
- **Zero Polling Battery Drain:** No HTTP polling requests occur when queue is empty.
- **Fast Wakeup:** Device claims queued jobs within hundreds of milliseconds of backend push.
- **Durable Safety Net:** 15-minute periodic `GatewayRecoveryWorker` and manual "Sync Now" ensure zero SMS jobs are lost even if FCM is delayed or unavailable.
- **Single-Flight Concurrency:** Mutex lock and in-flight job ID tracking guarantee only one drain operation runs at any time.

---

## 2. Event-Driven Lifecycle & State Machine

```text
                               ┌──────────────────┐
                               │   Worker State   │
                               │     [ OFF ]      │
                               └────────┬─────────┘
                                        │ User toggles switch ON
                                        ▼
                               ┌──────────────────┐
                               │ Start Foreground │
                               │     Service      │
                               └────────┬─────────┘
                                        │
                         ┌──────────────┴──────────────┐
                         ▼                             ▼
               ┌──────────────────┐          ┌──────────────────┐
               │ Sync Push Token  │          │ Schedule 15-min  │
               │ (FcmCoordinator) │          │ Recovery Worker  │
               └────────┬─────────┘          └──────────────────┘
                        │
         ┌──────────────┴──────────────────────────────┐
         ▼                                             ▼
┌─────────────────────────────────┐          ┌──────────────────┐
│ Event: FCM "JOBS_AVAILABLE"     │          │ Heartbeat Loop   │
│ (GatewayFirebaseMessagingService│          │   (Every 60s)    │
└────────────────┬────────────────┘          └──────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ JobDrainEngine.drainQueue()     │◄─── [ 15-min Recovery Worker / "Sync Now" UI ]
│ (Mutex lock + Single-flight)    │
└────────────────┬────────────────┘
                 │
          Job Claimed?
          ├───────────────┬───────────────┐
          │ YES           │ NO (Empty)    │
          ▼               ▼               ▼
  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
  │ Dispatch via  │ │ Return to     │ │ Drain loop    │
  │ Hardware SIM  │ │ sleep / idle  │ │ completes     │
  └───────┬───────┘ └───────────────┘ └───────────────┘
          │
          │ Broadcast: SMS_SENT / SMS_DELIVERED
          ▼
  ┌───────────────┐
  │ Report Status │
  │ to Backend    │
  └───────────────┘
```

---

## 3. Push Token Lifecycle (`FcmTokenCoordinator`)

Push tokens are coordinated centrally through `FcmTokenCoordinator`:

1. **Fingerprint Identity:** Each installation creates a durable installation fingerprint (`inst_<uuid>`), preserved across token refreshes and stored in private SharedPreferences. A pending raw FCM token is kept with the gateway credential in encrypted storage until registration succeeds.
2. **Registration (`PUT /api/v1/gateway/push-token`):**
   - Transmits `{ token, provider: "FCM", platform: "ANDROID", deviceFingerprint, appVersion }`.
   - Authenticated using `X-Gateway-Key`.
   - Never sends credentials, phone numbers, or OTPs in payload.
3. **Idempotency Cache:**
   - Computes SHA-256 hashes of `(token, gatewayKey, backendUrl, appVersion)`.
   - Skips redundant backend registration calls if all components match cache.
4. **Invalidation (`DELETE /api/v1/gateway/push-token`):**
   - When the user changes or clears their Gateway Key in settings, the old token is invalidated on the backend and local cache is wiped.
5. **Safe Deferral:**
   - Registration is safely deferred if Gateway API Key is missing or if the app is in `LOCAL_API` mode.
6. **Masked Telemetry:**
   - Logs never include push-token or gateway-key fragments. UI state reports only whether registration is active.

---

## 4. Hardware SMS Dispatching Pipeline

```text
  Claimed Job Payload
          │
          ▼
┌────────────────────────────────────────────────────────┐
│               Android SmsManager Wrapper               │
│ - Validates E.164 phone number format                  │
│ - Divides long messages (>160 chars) into multipart    │
│ - Attaches Sent & Delivery PendingIntents              │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│                Cellular Radio (RIL / SIM)              │
└──────────────┬──────────────────────────┬──────────────┘
               │                          │
        Radio Output               Carrier Acknowledgment
               │                          │
               ▼                          ▼
┌─────────────────────────────┐ ┌────────────────────────┐
│ Broadcast: SMS_SENT         │ │ Broadcast: SMS_DELIVER │
│ - RESULT_OK                 │ │ - Result delivered     │
│ - RESULT_ERROR_NO_SERVICE   │ └──────────┬─────────────┘
│ - RESULT_ERROR_RADIO_OFF    │            │
│ - RESULT_ERROR_GENERIC      │            │
└──────────────┬──────────────┘            │
               │                           │
               ▼                           ▼
┌────────────────────────────────────────────────────────┐
│                 Status Sync to Backend                 │
│         POST /api/v1/gateway/jobs/{jobId}/status       │
│                  (SENT / DELIVERED / FAILED)           │
└────────────────────────────────────────────────────────┘
```

---

## 5. UI Architecture & Dashboard

### 5.1 Main Dashboard Layout
```text
+------------------------------------------+
|  Global SMS Gateway           [ v2.0 ]   |
+------------------------------------------+
|                                          |
|  Worker Service                          |
|  [=== ON ===]             Status: ACTIVE |
|                                          |
+------------------------------------------+
|  System Status                           |
|  • Mode:        EVENT-DRIVEN (FCM Wake)  |
|  • Push Token:  Registered (fcm_8a...12) |
|  • Backend:     Connected (Vercel)       |
|  • SIM 1:       Ready (Jio 5G / Airtel)  |
|  • Battery:     88% (Charging)           |
|  • Recovery:    Every 15m (WorkManager)  |
+------------------------------------------+
|  SMS Dispatch Activity                   |
|  • Last SMS:    SENT (+919876543210)     |
|  • Total Sent:  1,420                    |
|  • Pending:     0 jobs in queue          |
|                                          |
|  [ Sync Now ]      [ Gateway Key Settings] |
+------------------------------------------+
|  Recent Transmission History             |
|  • +919876543210  - DELIVERED  (16:15:05)|
|  • +919123456789  - DELIVERED  (16:12:30)|
|  • +919988776655  - SENT       (16:10:12)|
+------------------------------------------+
```

### 5.2 Gateway API Key Settings Screen
```text
+------------------------------------------+
|  <  Gateway API Key Management           |
+------------------------------------------+
|  Configure the credential for this       |
|  device to authenticate with Global OTP. |
|                                          |
|  Backend URL:                            |
|  [ https://global-otp-service.vercel.app]|
|                                          |
|  Gateway API Key:                        |
|  [ otp_gw_live_0a1b2c3d4e5f...34 ]       |
|                                          |
|  [ Test Connection ]   [ Save Settings ] |
|                                          |
|  Key Status:  ACTIVE                     |
|  Push Token:  Registered & Synced        |
|  Device ID:   gw_android_dev_test        |
+------------------------------------------+
```

---

### 1.4 Phase 4 Reliability Hardening

Phase 4 introduces operational resilience against network drops, process death, and continuous radio drain:

1. **WorkManager Exponential Backoff on JobDrainWorker:**
   - `JobDrainWorker.enqueueExpedited` applies `setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)`.
   - In `doWork()`, if transient errors occur (`summary.retryRecommended == true`), retry is permitted up to 3 attempts (`runAttemptCount < 3`).
   - If `runAttemptCount >= 3`, the worker terminates with `Result.failure()` to prevent an infinite expedited work loop, cleanly yielding recovery to the 15-minute periodic `GatewayRecoveryWorker`.

2. **Token Registration Resumption Across Process Death:**
   - Fresh push tokens from Firebase `onNewToken` are persisted synchronously to `EncryptedSharedPreferences` before initiating any network calls.
   - If the application process terminates before server registration succeeds, `GatewayRecoveryWorker` triggers `FcmTokenCoordinator.syncToken()` on its next scheduled 15-minute cycle, ensuring backend registration resumes automatically.

3. **Elimination of Continuous 60s Background Heartbeat:**
   - The repetitive 60-second background polling/heartbeat loop in `GlobalGatewayWorker` has been eliminated.
   - Initial heartbeats occur on worker startup and manual sync requests; periodic health heartbeats are dispatched every 15 minutes by `GatewayRecoveryWorker`.
   - This eliminates continuous radio wakeups and extends battery life substantially.

4. **Single-Flight In-Flight Mutex Deduplication:**
   - Concurrent drain requests from push wakes, periodic recovery, or UI sync are serialized through a single-flight `Mutex` and in-memory in-flight set, completely preventing concurrent duplicate carrier SMS dispatch.

---

## 6. Phase 5 Single-Flight Drain Mutex & Room Deduplication

1. **Single-Flight Mutex**:
   - `JobDrainEngine` utilizes an atomic boolean lock (`drainLock`).
   - If a new FCM wake signal or WorkManager run triggers while draining is in progress, `pendingWorkSignal` is flagged.
   - Upon completing the current batch, the worker inspects `pendingWorkSignal` and automatically continues until the queue is exhausted.

2. **In-Flight Job Deduplication**:
   - An in-memory concurrent set (`inFlightJobIds`) prevents race conditions between simultaneous polling and push wake events.

3. **Room SQLite Cache Guard**:
   - Before handing an SMS job to Android `SmsManager`, the local database is checked.
   - If the job was already dispatched locally (`SENT` or `DELIVERED`), the modem dispatch is skipped and status is re-reported to the server.
