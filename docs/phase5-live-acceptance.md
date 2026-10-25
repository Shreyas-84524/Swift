# Swift Phase 5: Live Acceptance & Physical Testing Checklist

This checklist specifies the controlled 8-step test procedure for validating the end-to-end Swift SMS Gateway on real hardware with a physical SIM card and active cellular carrier.

> [!CAUTION]
> Execute these physical tests only with authorized test phone numbers. Do not trigger bulk sends on consumer SIM cards to avoid TRAI and carrier anti-spam throttling.

---

## Pre-Flight Checklist

- [ ] Physical Android device connected to AC power.
- [ ] Active SIM card in Slot 1 with active SMS balance.
- [ ] Device connected to Wi-Fi.
- [ ] Battery optimization set to **Unrestricted**.
- [ ] App permissions granted (`SEND_SMS`, `READ_PHONE_STATE`, `POST_NOTIFICATIONS`).
- [ ] `google-services.json` present in `app/`.
- [ ] Production Vercel deployment online and healthy (`GET /api/v1/health` returns `200`).
- [ ] Database migrations 001–008 applied to PostgreSQL.
- [ ] Active, approved message template configured for the target project.

---

## 8-Step Physical Verification Procedure

### Step 1: Gateway Enrollment & FCM Registration
1. Launch Swift Gateway app on the device.
2. In the Admin Portal, create a gateway entry and issue an active Gateway Key (`otp_gw_live_...`).
3. Enter API URL and Gateway Key into the app; tap **Connect**.
4. **Verification**:
   - Check device UI displays "Connected" and SIM status "READY".
   - In Supabase SQL Editor:
     ```sql
     SELECT * FROM gateway_push_tokens WHERE gateway_id = 'YOUR_GATEWAY_ID' AND is_valid = TRUE;
     ```
   - Confirm exactly 1 valid token exists with `platform = 'ANDROID'` and `provider = 'FCM'`.

---

### Step 2: Screen-Off Sleep Mode Verification
1. Lock the Android device screen.
2. Lock the screen and leave the device idle. Two minutes of screen-off time does not prove Doze; for a controlled engineering test, use Android's documented `adb shell dumpsys deviceidle force-idle` procedure and restore normal state afterward.
3. Keep the device plugged into AC power.

---

### Step 3: Send OTP via Swift API
1. Using an API client (cURL, Postman, or client reference adapter), call:
   ```bash
   curl -X POST https://your-domain.com/api/v1/otp/send \
     -H "X-Project-Key: otp_proj_live_YOUR_KEY" \
     -H "Content-Type: application/json" \
     -d '{"phone": "+919876543210"}'
   ```
2. **Verification**:
   - Response returns `HTTP 200` with `request_id`, `expires_in: 300`, `resend_after: 30`.
   - No plaintext OTP is leaked in response.

---

### Step 4: High-Priority FCM Wake & Modem Dispatch
1. Observe the sleeping Android phone.
2. **Verification**:
   - The background worker normally begins within seconds, but Android, OEM firmware, FCM, and network conditions make this latency non-guaranteed.
   - A data-only FCM wake is not expected to turn on the screen or display a user notification.
   - The device modem transmits the SMS over cellular network.
   - In database:
     ```sql
     SELECT status, attempts, sent_at FROM sms_jobs WHERE challenge_id = 'YOUR_REQUEST_ID';
     ```
   - Confirm job status transitioned: `QUEUED` -> `CLAIMED` -> `SENT`.

---

### Step 5: Cellular Delivery & Template Invariants
1. Check recipient handset for incoming SMS.
2. **Verification**:
   - Record the observed carrier-delivery time; do not treat a 5–15 second range as guaranteed.
   - Message text strictly matches approved template syntax:
     e.g., `Your Swift Platform verification code is 123456. Valid for 5 minutes.`
   - No raw brackets `{{otp}}` remain unreplaced.
   - Extracted OTP is exactly 6 numeric digits.

---

### Step 6: Verify OTP Validation & Anti-Tampering
1. Call the verification endpoint with the extracted OTP:
   ```bash
   curl -X POST https://your-domain.com/api/v1/otp/verify \
     -H "X-Project-Key: otp_proj_live_YOUR_KEY" \
     -H "Content-Type: application/json" \
     -d '{"request_id": "YOUR_REQUEST_ID", "otp": "EXTRACTED_OTP", "phone": "+919876543210"}'
   ```
2. **Verification**:
   - Returns `HTTP 200` with `{"verified": true}`.
   - In database, `otp_challenges.consumed` is `TRUE`.

---

### Step 7: Anti-Replay & Tampering Enforcement
1. Immediately re-send the exact same verification payload.
2. **Verification**:
   - Returns `HTTP 400 Bad Request` with `code: "ALREADY_CONSUMED"`.
3. Try verifying with a mismatched phone number (e.g. `+919876599999`).
   - Returns `HTTP 400 Bad Request` (`Phone number does not match challenge request`).

---

### Step 8: Network Loss & Stale Recovery Test
1. Turn on **Airplane Mode** on the Android gateway device.
2. Send another OTP via `/api/v1/otp/send`.
3. **Verification**:
   - API returns `HTTP 200` with `request_id`.
   - In database, SMS job is safely preserved as `QUEUED`.
   - Notification outbox item transitions to `FAILED` with backoff schedule.
4. Turn **Airplane Mode OFF**.
5. Trigger outbox dispatch or allow periodic recovery:
   - Gateway wakes, claims the queued job, and transmits it over cellular modem.
   - Check recipient receives the queued SMS cleanly without duplicates.

---

## Live Acceptance Sign-Off Matrix

| Test Step | Description | Expected Result | Pass / Fail |
|---|---|---|---|
| Step 1 | Gateway Enrollment | Token synced in DB, status Connected | [ ] PASS |
| Step 2 | Sleep Mode | Device enters screen-off sleep | [ ] PASS |
| Step 3 | Send OTP API | HTTP 200, valid `request_id` | [ ] PASS |
| Step 4 | Push Wake | Phone wakes in 1–3s, claims job | [ ] PASS |
| Step 5 | SMS Delivery | Recipient receives formatted SMS | [ ] PASS |
| Step 6 | Verify OTP | HTTP 200, `verified: true` | [ ] PASS |
| Step 7 | Anti-Replay | HTTP 400 `ALREADY_CONSUMED` | [ ] PASS |
| Step 8 | Network Loss | Job held in QUEUED, recovered on reconnect | [ ] PASS |
