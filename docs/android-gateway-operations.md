# Android SMS Gateway — Operations & Deployment Guide

This guide details the setup, maintenance, carrier considerations, and Android runtime architecture for operating an Android device as a **Global SMS Gateway Worker**.

---

## 1. Gateway Worker Architecture

The Android Gateway application acts as a secure, outbound-only client worker that polls the central Global OTP Backend, claims pending SMS jobs, and dispatches them via the device's physical cellular modem.

```text
+-----------------------------------------------------------------------------------+
| Android Gateway Phone (e.g., Xiaomi Redmi Note 13 5G)                             |
|                                                                                   |
|  +-----------------------------------------------------------------------------+  |
|  | SmsGatewayService (Foreground Service, type="dataSync")                     |  |
|  |                                                                             |  |
|  |  +---------------------+        +--------------------+                      |  |
|  |  | Worker Polling Loop |        | Service.onTimeout  | (Graceful halt       |  |
|  |  | (5s poll interval)  |        | Handler (API 35+)  |  on Android 15)      |  |
|  |  +----------+----------+        +--------------------+                      |  |
|  |             |                                                               |  |
|  |             v                                                               |  |
|  |  +-----------------------------------------------------------------------+  |  |
|  |  | SmsSender Engine                                                      |  |  |
|  |  | - Resolves explicit Subscription ID via SubscriptionManager           |  |  |
|  |  | - Instantiates SmsManager via context.getSystemService(SmsManager)    |  |  |
|  |  | - Uses Sent PendingIntent with BroadcastReceiver tracking             |  |  |
|  |  | - Omits Delivery PendingIntent (avoids TP-SRR carrier rejection)      |  |  |
|  |  | - Decodes RIL status codes via SmsErrorDecoder                        |  |  |
|  |  +-----------------------------------+-----------------------------------+  |  |
|  +--------------------------------------|--------------------------------------+  |
+-----------------------------------------|-----------------------------------------+
                                          |
                      +-------------------+-------------------+
                      |                                       |
                      v                                       v
          +-----------------------+               +-----------------------+
          | Global OTP Backend    |               | Physical Carrier SIM  |
          | (HTTPS Outbound API)  |               | (Airtel / Jio 4G/5G)  |
          +-----------------------+               +-----------------------+
```

---

## 2. Hardware & Carrier Requirements

### Recommended Device Specifications
- **Operating System:** Android 10 (API 29) to Android 15 (API 35).
- **Network Connectivity:** Uninterrupted Wi-Fi or Active 4G/5G Mobile Data.
- **Physical SIM Slot:** Active SIM in Slot 1 (Subscription ID $\ge 1$).

### Carrier Configuration (India — Airtel / Jio)
1. **SMS Pack / Outgoing SMS Allowance:**
   - Ensure the SIM plan includes active outgoing SMS balance/validity. Many base data-only recharge plans in India do **not** include outgoing SMS.
2. **Single SIM vs Multi-SIM:**
   - In single-SIM setups, ensure the default SMS subscription is assigned to the active SIM in Android Settings (`Settings -> SIM cards & mobile networks -> Default for Calls/SMS`).
   - The app dynamically queries `SubscriptionManager.getActiveSubscriptionInfoList()` and falls back gracefully to `SmsManager.getDefault()`.
3. **DLT / SMS Content Filtering:**
   - Indian carriers enforce DLT (Distributed Ledger Technology) filters on automated SMS. Commercial traffic without registered headers may be blocked.
   - For internal/testing usage, pre-approved customer notification templates are utilized.

---

## 3. Modem Dispatch & Error Handling

### Avoiding Carrier RIL Rejection (Error 124)
- **Root Cause:** Passing a non-null `deliveredIntent` instructs `SmsManager` to set the `TP-SRR` (Status Report Request) bit in the SMS PDU. Certain consumer carrier SMSCs (e.g. Airtel India) reject consumer PDU status report requests with internal modem error code `124` (`RESULT_RIL_INVALID_ARGUMENTS` / `RESULT_UNKNOWN_124`).
- **Solution:** The gateway sets `deliveredIntent = null` and `requestDeliveryReports = false`. The dispatch status is governed solely by the authoritative modem transmission result (`sentIntent`).

### `SmsErrorDecoder` Mapping
The gateway inspects Android modem result codes:

| Result Code | Error Name | Category | Description / Action |
| :---: | :--- | :--- | :--- |
| `-1` | `RESULT_OK` | Success | Successfully transmitted to carrier tower. Job marked `SENT`. |
| `1` | `RESULT_ERROR_GENERIC_FAILURE` | Failure | Generic radio/telephony failure. Check signal or plan balance. |
| `2` | `RESULT_ERROR_RADIO_OFF` | Failure | Airplane mode is ON or radio is turned off. |
| `3` | `RESULT_ERROR_NULL_PDU` | Failure | PDU creation failed. Check message text encoding. |
| `4` | `RESULT_ERROR_NO_SERVICE` | Failure | No cellular reception or network registration failed. |
| `100–127` | `RESULT_RIL_*` | Carrier / RIL | Telephony radio interface layer error (e.g. code 124: carrier rejected flags). |

---

## 4. Android 15 Background Execution Hardening

### The 6-Hour Cumulative `dataSync` Timeout
Android 15 (targetSdk 35) introduces strict background execution limits:
- `foregroundServiceType="dataSync"` services are restricted to a **cumulative 6 hours per 24 hours** while the app is in the background.
- **Critical Policy Fact:** Neither battery optimization whitelists (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`), charging states, nor Developer "Stay Awake" settings override this operating-system timeout.
- Once the 6-hour quota is exhausted, Android forcibly terminates the service.

### Graceful Shutdown via `Service.onTimeout(int, int)`
To prevent OS-level ANRs (Application Not Responding) or abrupt process kills, the gateway implements `onTimeout`:

```kotlin
@RequiresApi(Build.VERSION_CODES.VANILLA_ICE_CREAM)
override fun onTimeout(startId: Int, fgsType: Int) {
    Log.w(TAG, "Android 15 Foreground Service timeout reached for type $fgsType. Stopping gracefully.")
    stopPolling()
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf(startId)
}
```

### Production 24/7 Operations Architecture
For long-term, continuous 24/7 unattended production operation on Android 15:
1. **Event-Driven Push (FCM / High-Priority):** Cloud backend issues a silent high-priority FCM data message when an OTP job is enqueued. The Android app wakes up on-demand, claims the job, sends the SMS, and returns to sleep (0 foreground service quota consumed).
2. **Periodic Fallback Worker:** `WorkManager` scheduled periodically (every 15 minutes) to sweep any orphaned queue jobs.

---

## 5. Daily Operations & Troubleshooting Runbook

### Starting the Worker
1. Launch the **Swift** app on the Android phone.
2. Verify Gateway Settings:
   - **Mode:** `GLOBAL_WORKER`
   - **Backend URL:** `https://global-otp-service.vercel.app`
   - **Gateway Key:** `otp_gw_live_...`
3. Tap **Start Service**.
4. A persistent notification titled **"SMS Gateway Active (Global Worker)"** will appear in the notification shade.

### Inspecting Live Logs
Connect the device via ADB to monitor real-time polling and dispatch logs:
```bash
adb logcat -s SmsGatewayService:V SmsSender:V GlobalWorkerManager:V
```

Expected healthy log output:
```text
D/GlobalWorkerManager: Polling for SMS jobs...
D/GlobalWorkerManager: Claimed 1 jobs from backend.
D/SmsSender: Dispatching SMS to +919876543210 (Subscription ID: 1)
D/SmsSender: Broadcast received: resultCode=-1 (RESULT_OK)
D/GlobalWorkerManager: Reported job 7e43b6a2 as SENT.
```

### Common Issues & Remedies

1. **Messages stuck in queue (`QUEUED` / not claiming):**
   - Verify Android phone has internet access (Wi-Fi or mobile data).
   - Check if the persistent notification is active. If killed by Android 15 quota, reopen the app to reset the foreground window.
   - Verify Gateway Key matches the registered hash in the database.

2. **Modem returns `RESULT_ERROR_GENERIC_FAILURE` (Code 1):**
   - Check cellular signal bars.
   - Verify carrier balance has outgoing SMS quota.
   - Check if the destination phone number requires country code format (`+91...`).

3. **Modem returns `RESULT_UNKNOWN_124`:**
   - Verify that `requestDeliveryReports` is set to `false` and `deliveredIntent` is `null` in the build.
