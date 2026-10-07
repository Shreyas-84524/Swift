# Android Gateway Worker — Architecture & Execution Strategy

## 1. Background Execution Strategy & Android 15 Hardening

### 1.1 Technical Evaluation of Android Background Mechanisms

| Mechanism | Suitability for OTP Delivery | Latency | Battery Efficiency | Android 14/15 Constraints | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **WorkManager** (Periodic) | **Unsuitable** | Minimum 15-minute interval enforced by Android OS | Excellent | Doze mode delays execution; cannot meet OTP latency (<10s) | ❌ Incompatible with OTP requirements |
| **AlarmManager + Broadcast** | **Poor** | Exact alarms require `SCHEDULE_EXACT_ALARM` user grant | Moderate | Battery optimization aggressively throttles alarms; brittle on OEM ROMs | ❌ Unreliable for long-running service |
| **Foreground Service + Polling Loop** (`dataSync`) | **Development / Short-Duration Dedicated** | Sub-second to 3s polling / near real-time response | High (adaptive backoff) | **Android 15 Cumulative 6h/24h timeout** while backgrounded | ✅ **Current Phase 3 Implementation** (User-started, Development/Testing) |
| **Push-Triggered Worker (FCM High-Priority)** | **Preferred Long-Term Production** | Immediate push notification wakeup on demand | Optimal (zero background CPU when idle) | Complies with all Android background & Doze policies | 🔮 **Target Long-Term Architecture (Phase 4/5)** |

---

### 1.2 Android 15 (API Level 35) Foreground Service Limitations

Starting with Android 15 (API level 35 / `targetSdk 35`), Android enforces strict runtime quotas on `dataSync` foreground services:

1. **Cumulative 6-Hour Timeout:**
   - A `dataSync` foreground service is capped at a **cumulative 6 hours within a rolling 24-hour window** while running in the background.
2. **Non-Bypassable OS Restrictions:**
   - `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` does **NOT** remove or extend this FGS timeout.
   - Keeping the phone connected to a charger does **NOT** remove this timeout.
   - Developer option "Stay awake while charging" does **NOT** remove this background service timeout.
   - Once the 6-hour budget is exhausted, another `dataSync` foreground service cannot be started until the app returns to the foreground and the 24-hour quota resets.
3. **Graceful Degradation (`Service.onTimeout`):**
   - When the 6-hour limit is reached, Android 15 invokes the `Service.onTimeout(int startId, int fgsType)` callback.
   - If the app fails to call `stopSelf(startId)`, Android terminates the process with an uncatchable `ForegroundServiceDidNotStopInTimeException` crash.
   - `SmsGatewayService` implements `override fun onTimeout()` to immediately cancel worker coroutines, stop polling, update the notification, and cleanly call `stopSelf(startId)`.

---

### 1.3 Current Operational Mode & Limitations

> [!IMPORTANT]
> **CURRENT MODE:**  
> User-started outbound polling worker, suitable for development, staging, and shorter-duration dedicated gateway operation.
> 
> **NOT YET GUARANTEED:**  
> 24/7 unattended Android 15 operation.

---

### 1.4 Future Long-Term Production Architecture (Push-Triggered Dispatch)

To achieve true, reliable 24/7 operation on consumer and dedicated devices without running into `dataSync` timeouts, the preferred production design will transition from continuous polling to an **event-driven push-wake architecture**:

```text
Client Application (CivicFix / Hostix)
        ↓ HTTPS POST /api/v1/otp/send
Swift Cloud Backend
        ↓ 1. Persists challenge & creates sms_job (QUEUED)
        ↓ 2. Sends High-Priority FCM Push Wake Signal (containing jobId)
Android Gateway Device
        ↓ 3. High-priority push wakes background receiver
        ↓ 4. Android worker fetches exact queued job via HTTPS GET /jobs/{id}
        ↓ 5. Android SmsManager dispatches SMS via physical SIM
        ↓ 6. SmsStatusReceiver captures carrier SENT / DELIVERED broadcasts
        ↓ 7. Worker updates status via HTTPS POST /jobs/{id}/status
        ↓
(Periodic reconciliation polling runs as low-frequency fallback only)
```

**Benefits of Push-Triggered Design:**
- **Zero Background Polling Battery Drain:** No continuous HTTP requests when no OTPs are requested.
- **Instantaneous Dispatch:** Push wake happens in 100–500ms upon OTP request creation.
- **100% Compliant with Android 15+:** Does not require continuous long-running `dataSync` foreground services.

---

## 2. Current Worker Lifecycle & State Machine (Polling Mode)

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
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
       ┌──────────────────┐            ┌──────────────────┐
       │ Poll Backend For │            │ Send Heartbeat   │
       │    SMS Jobs      │            │   (Every 60s)    │
       └────────┬─────────┘            └──────────────────┘
                │
         Job Available?
         ├───────────────┬───────────────┬───────────────────────────────┐
         │ YES           │ NO            │ Android 15 Timeout (6h limit) │ User toggles switch OFF
         ▼               ▼               ▼                               ▼
 ┌───────────────┐ ┌───────────────┐ ┌───────────────────────────┐ ┌───────────────┐
 │ Claim Job &   │ │ Adaptive      │ │ Service.onTimeout()       │ │ Cancel Loops  │
 │ Send via SIM  │ │ Backoff Delay │ │ Graceful stopSelf()       │ │ Stop Service  │
 └───────┬───────┘ └───────┬───────┘ └───────────────────────────┘ └───────────────┘
         │                 │
         │ SMS_SENT /      │
         │ SMS_DELIVERED   │
         ▼                 │
 ┌───────────────┐         │
 │ Update Status │─────────┘
 │ on Backend    │
 └───────────────┘
```

---

## 3. Worker ON vs. Worker OFF Operational Behaviors

### 3.1 Worker ON State
- Foreground Service runs with persistent notification: *"SMS Gateway Worker Active — Connected to Global Backend"*.
- Coroutine supervisor loop actively polls `GET /api/v1/gateway/jobs`.
- Outbound requests include `X-Gateway-Key` authentication header.
- Captures telephony status and reports to `POST /api/v1/gateway/jobs/{jobId}/status`.
- Periodic background heartbeat every 60 seconds updating battery, network type, and SIM status.

### 3.2 Worker OFF State
- **Immediate Cancellation:** Cancels the coroutine supervisor scope and all pending polling jobs.
- **Service Termination:** Calls `stopForeground(true)` and `stopSelf()`.
- **Zero Background Activity:** Completely ceases network traffic, prevents CPU wakeups, and releases all held resources.
- **UI Reflection:** Dashboard indicates `Worker: OFF`, `Backend: Disconnected`, `Sync: Inactive`.

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
|  • Backend:     Connected (Vercel)       |
|  • SIM 1:       Ready (Jio 5G / Airtel)  |
|  • Battery:     88% (Charging)           |
|  • Last Sync:   3 seconds ago            |
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
|  Key Status: ACTIVE                      |
|  Device ID:  gw_android_dev_test         |
+------------------------------------------+
```
