# Swift Architecture

## 1. Executive Summary

This document specifies the target architecture for the **Swift**, transitioning from a standalone, local Android HTTP SMS gateway into a multi-project, centralized OTP generation and delivery infrastructure.

In the original implementation, external applications had to reach the Android device directly via LAN IP (`192.168.x.x`) or ephemeral reverse tunnels (e.g., Cloudflare Quick Tunnel `trycloudflare.com`). This created severe operational pain points:
- **Same Wi-Fi dependency** or reliance on temporary tunnels.
- **Laptop requirement** (must remain powered on to run tunnel daemons).
- **Security risks** associated with exposing Android local HTTP servers to public ingress.
- **Single application binding** without multi-tenant authentication, key lifecycle, or rate controls.

The architecture decouples client applications from the physical Android device through a **Global Cloud Backend** hosted on Vercel with PostgreSQL persistence. The Android device acts as an **Outbound Gateway Worker**: FCM wakes it when work is available, after which it atomically claims queued jobs and dispatches them through its cellular SIM.

---

## 2. High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Projects                        │
│   (CivicFix Web/Mobile, Hostix, Admin Portals, 3rd Party)    │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTPS POST /api/v1/otp/send
                               │ Header: X-Project-Key (otp_proj_live_*)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Global OTP Backend                       │
│                     (Vercel / Node.js)                      │
│                                                             │
│  ┌───────────────────────┐       ┌───────────────────────┐  │
│  │ Project Auth & Quotas │       │  OTP Token Engine     │  │
│  │ - Key validation      │       │  - Secure RNG (6-dig) │  │
│  │ - Rate limiting       │       │  - Hash (SHA-256/Salt)│  │
│  │ - Project scoping     │       │  - Expiry (5-10 min)  │  │
│  └───────────────────────┘       └───────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  SMS Job Queue Engine                 │  │
│  │  - Atomic Job Leasing (CLAIMED with expiration lease) │  │
│  │  - Status Tracking (QUEUED, CLAIMED, SENT, DELIVERED) │  │
│  │  - Notification Outbox & High-Priority FCM Wake-Up    │  │
│  │  - Stale lease recovery & Dead-letter handling        │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────┬──────────────────────────────▲───────────────┘
               │                              │
               │ PostgreSQL Queries           │ FCM Wakeup Trigger +
               │ (Supabase / Neon)            │ HTTPS Outbound Claim & Status
               ▼                              │
┌──────────────────────────────┐              │
│       PostgreSQL DB          │              │
│ - projects                   │              │
│ - project_api_keys           │              │
│ - otp_challenges             │              │
│ - sms_jobs                   │              │
│ - notification_outbox        │              │
│ - gateway_push_tokens        │              │
│ - gateways                   │              │
│ - gateway_api_keys           │              │
└──────────────────────────────┘              │
                                              │
                      ┌───────────────────────┴───────────────┐
                      │        Android Gateway Worker         │
                      │  (Header: X-Gateway-Key otp_gw_live_*)│
                      │                                       │
                      │  ┌─────────────────────────────────┐  │
                      │  │ Firebase Messaging Receiver     │  │
                      │  │ - data.type: "JOBS_AVAILABLE"   │  │
                      │  │ - Instant background wake-up    │  │
                      │  └────────────────┬────────────────┘  │
                      │                   │                   │
                      │  ┌────────────────▼────────────────┐  │
                      │  │ JobDrainEngine (Single-Flight)  │  │
                      │  │ - Mutex lock + In-Flight set    │  │
                      │  │ - WorkManager 15m safety net    │  │
                      │  └────────────────┬────────────────┘  │
                      │                   │                   │
                      │  ┌────────────────▼────────────────┐  │
                      │  │ Android SmsManager Dispatcher   │  │
                      │  │ - Single / Multipart SMS        │  │
                      │  │ - Sent / Delivery Broadcasts    │  │
                      │  └────────────────┬────────────────┘  │
                      │                   │                   │
                      │  ┌────────────────▼────────────────┐  │
                      │  │ Local Room DB & Offline Cache   │  │
                      │  └─────────────────────────────────┘  │
                      └───────────────────┬───────────────────┘
                                          │ Direct Hardware
                                          ▼
                      ┌───────────────────────────────────────┐
                      │          Cellular Carrier SIM         │
                      │            (Carrier SMS)              │
                      └───────────────────┬───────────────────┘
                                          │ GSM/CDMA Network
                                          ▼
                                     User Handset
```

---

## 3. Boundary & Responsibility Definitions

### 3.1 Application Clients (e.g., CivicFix, Hostix)
- **Role:** Consumer of OTP services.
- **Authentication:** Must authenticate exclusively using project-scoped API keys (`otp_proj_live_...`).
- **Isolation:** 
  - Never interact with the Android device or know its network identity/IP.
  - Never possess or manage gateway credentials.
  - Cannot read plaintext OTP tokens from responses (only challenge IDs for verification).
- **Communication:** Outbound HTTPS calls to `https://api.global-otp.yourdomain.com/api/v1/otp/*`.

### 3.2 Global OTP Backend (Vercel Serverless / Edge + PostgreSQL)
- **Role:** Central authority for security, token lifecycle, quotas, and job orchestration.
- **Responsibilities:**
  1. **Authentication & Authorization:** Validate Project API keys and Gateway API keys using SHA-256 cryptographic hashes.
  2. **OTP Generation & Security:** Generate cryptographically secure random codes, store one-way salted hashes, enforce expiry (default 5 minutes), and enforce attempt limits (maximum 3-5 failed verification attempts).
  3. **Job Queue Management:** Transform OTP requests into SMS dispatch jobs in `QUEUED` state.
  4. **Job Claim Protocol:** Atomically assign jobs to active gateway workers with a lease duration (e.g., 60 seconds) to prevent duplicate dispatching.
  5. **Status Aggregation:** Collect delivery and carrier sent status from workers.
  6. **Health & Observability:** Expose system health, queue lag, and worker connectivity metrics.

### 3.3 Android Gateway Worker
- **Role:** Physical SMS transmitter running on dedicated or repurposed Android hardware.
- **Authentication:** Authenticates to the Global Backend using a gateway-specific key (`otp_gw_live_...`).
- **Communication:** **100% Outbound HTTPS** with **Inbound High-Priority FCM Push Wake-up**. No inbound ports opened, no local web server exposed to WAN, no public IP or DDNS needed. Works on Wi-Fi, 4G, or 5G mobile data.
- **Event-Driven Execution Model (Phase 3):**
  - **Zero Polling Loop:** The continuous 3–60s polling loop is completely eliminated.
  - **FCM Wake-Up:** High-priority FCM `JOBS_AVAILABLE` data messages wake `GatewayFirebaseMessagingService` when jobs arrive.
  - **WorkManager Host:** Dispatches `JobDrainWorker` (expedited) to claim and transmit jobs via `JobDrainEngine`.
  - **Durable Safety Net:** A 15-minute periodic `GatewayRecoveryWorker` runs as a safety net reconciliation job.
  - **Foreground Service Independence:** Global delivery no longer depends on a 60-second heartbeat loop or an uninterrupted foreground service. FCM and WorkManager remain the delivery mechanisms if the companion service reaches Android 15's runtime limit.
- **Responsibilities:**
  1. Register and sync FCM push tokens via `PUT /api/v1/gateway/push-token` using `FcmTokenCoordinator`.
  2. Handle `JOBS_AVAILABLE` FCM push wake signals immediately.
  3. Acquire job claim leases from backend via `POST /api/v1/gateway/jobs`.
  4. Dispatch SMS through Android `SmsManager` (supporting single-part and multipart SMS).
  5. Capture broadcast intents for transmission success (`SMS_SENT`) and carrier delivery (`SMS_DELIVERED`).
  6. Immediately report delivery status via `POST /api/v1/gateway/jobs/{jobId}/status`.
  7. Provide manual "Sync Now" button and 15-minute background recovery.

---

## 4. Architectural Comparison: Legacy vs. Global

| Feature | Legacy Local Gateway | Swift (Phase 3) |
| :--- | :--- | :--- |
| **Network Direction** | Inbound HTTP to phone (Port 8080) | Outbound HTTPS + High-Priority FCM Wakeup |
| **Delivery Trigger** | Direct inbound HTTP POST | Event-driven FCM `JOBS_AVAILABLE` push wake |
| **Idle Battery Drain** | High (server listening) | Optimal (zero network/CPU polling when idle) |
| **Network Dependency** | Same Wi-Fi or Cloudflare Tunnel | Any internet connection (Wi-Fi or Mobile Data) |
| **Laptop Requirement** | Yes (must run `cloudflared` tunnel) | No (Vercel cloud backend runs 24/7) |
| **Multi-Tenancy** | Single API key in app settings | Multi-project isolation with unique keys & quotas |
| **OTP Security** | Client generated plaintext messages | Backend generates, hashes, and validates OTP |
| **Job Concurrency** | Single device, sequential queue | Multi-worker capable with atomic job leasing |
| **Queue Resilience** | In-memory / local device | PostgreSQL durable queue + 15m WorkManager recovery |
| **Carrier Delivery** | Local Room DB only | Synced to Global DB with full status lifecycle |
| **Attack Surface** | Exposed mobile HTTP server | Cloud API with strict rate limiting & WAF |

---

## 5. Elimination of Cloudflare Tunnel Dependency

In the legacy setup, Cloudflare Quick Tunnel was required to forward requests from public client web apps to `http://192.168.x.x:8080`. 
This is completely eliminated because:
1. The global backend is hosted on a public domain with automatic TLS managed by Vercel.
2. The phone initiates outbound TLS connections (HTTPS GET/POST) to the backend.
3. NAT traversal, dynamic IPs, and firewall traversal happen transparently over standard HTTPS outbound connections.

---

## 6. Phase 1 Foundations: Safe Message Templates & Push Readiness

Phase 1 introduces the backend foundations for editable message templates and event-driven push delivery without altering current Android polling behavior.

### 6.1 Safe Message Template Engine
- **Strict Placeholder Whitelist:** Templates only permit approved placeholders: `{{otp}}`, `{{app_name}}`, and `{{expiry_minutes}}`. Any disallowed placeholder (e.g. `{{phone}}`, `{{token}}`, `${var}`) or unsafe input (null bytes, control characters, script tags, >500 characters) is rejected at validation.
- **Telecom Segment Estimation:** Computes character counts and segment splits based on 3GPP TS 23.038 standards:
  - **GSM 7-bit:** 160 characters per single SMS; 153 characters per segment for multipart messages. Extended characters (`[`, `]`, `{`, `}`, `^`, `~`, `|`, `\`, `€`) consume 2 septets.
  - **UCS-2 (Unicode):** 70 characters per single SMS; 67 characters per segment for multipart messages.
- **Single Active OTP Template:** Enforced at both database level (`CREATE UNIQUE INDEX ... WHERE template_type = 'OTP' AND status = 'ACTIVE'`) and application level (automatic atomic demotion of previous active template).
- **Template Version History:** Updating a template's body creates an incremental version row in `message_template_versions`, maintaining auditability and rollback capability.
- **DLT Regulatory Support:** Optional future-proof fields for Indian telecom regulations: `dlt_template_id`, `sender_header`, and `pe_id`.

### 6.2 Push Notification Foundation (Readiness for Phase 2)
- **Token Registry (`gateway_push_tokens`):** Stores FCM/HMS/APNS device tokens per gateway with platform and fingerprint metadata.
- **Transactional Outbox (`notification_outbox`):** Implements the Transactional Outbox pattern so that when an SMS job is enqueued, a wake notification can be scheduled atomically with guaranteed delivery.
- **Zero Disruption to Phase 1 Android Execution:** Polling on Android devices continues unchanged while backend tables, admin APIs, and validation systems are primed for push activation in Phase 2.

---

## 7. Phase 2: Transactional FCM Wake-Up Delivery

Phase 2 activates high-priority Firebase Cloud Messaging (FCM HTTP v1) data wake signals to notify registered Android gateway devices when SMS jobs are enqueued, while keeping PostgreSQL as the sole durable source of truth.

### 7.1 Architecture & Transaction Boundary

```text
Client Project
  → POST /api/v1/otp/send
  → Vercel validates project key & quotas
  → BEGIN DB Transaction:
      - INSERT otp_challenges
      - INSERT sms_jobs (QUEUED)
      - INSERT notification_outbox (PENDING / FAILED, dedup_key)
  → COMMIT DB Transaction
  → Post-Commit: PushService.dispatchOutboxItem (Immediate FCM HTTP v1 Wake)
```

- **Strict Invariant:** External network calls (FCM) are **NEVER** made inside a database transaction.
- **Durable First:** The OTP challenge and SMS job are committed to PostgreSQL before attempting FCM delivery.
- **Fail-Safe Delivery:** If FCM delivery fails (network timeout, rate limit, missing credentials, invalid token), the SMS job is **never** rolled back or lost; it remains safely in `QUEUED` status for the 15-minute WorkManager reconciliation or manual sync.

### 7.2 Deterministic Gateway Selection Rule

Swift maintains a single-owner architecture. Gateway selection for push delivery follows this deterministic rule:
1. Query active, enabled gateways (`is_active = TRUE AND worker_enabled = TRUE`) with active, valid push tokens (`provider = 'FCM'`, `platform = 'ANDROID'`, `is_valid = TRUE`).
2. **Exactly 1 Match (`SELECTED`):** The gateway and token are selected. Outbox item is created as `PENDING`, and immediate post-commit push is attempted.
3. **0 Matches (`NO_VALID_GATEWAY_TOKEN`):** No push is attempted. Outbox item is recorded as `FAILED` with sanitized code `NO_VALID_GATEWAY_TOKEN`. The durable SMS job remains queued for WorkManager reconciliation or manual sync.
4. **> 1 Matches (`AMBIGUOUS_GATEWAY_SELECTION`):** Push wake is safely suppressed. Outbox item is recorded as `FAILED` with sanitized code `AMBIGUOUS_GATEWAY_SELECTION`. This prevents waking multiple physical devices simultaneously and causing duplicate carrier SMS dispatches. The queue falls back to atomic row leasing.

### 7.3 Transactional Outbox State Machine & Distributed Recovery

- **States:** `PENDING` → `PROCESSING` → `SENT` / `FAILED` / `DEAD_LETTER`.
- **Atomic Batch Claiming (`FOR UPDATE SKIP LOCKED`):** Migration 007 introduces `idx_notification_outbox_due` and `idx_notification_outbox_stale_leases` to allow concurrent cron dispatchers and worker invocations to claim non-overlapping slices of due outbox records without blocking or serialization conflicts.
- **Distributed Lease Tracking (`lease_expires_at`):** When claimed, `lease_expires_at` is populated (`NOW() + INTERVAL '2 minutes'`). If an invocation crashes or terminates abruptly before clearing the lease, subsequent batch sweeps automatically recover the stale `PROCESSING` record once `lease_expires_at <= NOW()`.
- **Idempotency & Deduplication:** Enforced via `deduplication_key` and its unique index. Client idempotency keys are SHA-256-derived before use as outbox keys, keeping the database key bounded and avoiding storage of a second raw copy.
- **Bounded Exponential Backoff:** Progressive intervals strictly follow `30s` → `60s` → `120s` → `240s` → `480s` (capped at 480 seconds / 8 minutes).
- **Terminal Dead-Letter State:** When `attempts >= max_attempts` (5 attempts), the outbox item moves to `DEAD_LETTER` with response code `MAX_ATTEMPTS_EXCEEDED`. The underlying SMS job remains safely `QUEUED` in PostgreSQL, protected from data loss.
- **Admin Dead-Letter Recovery:** Owner administrators can inspect outbox health via `GET /api/v1/admin/outbox/health` (zero PII) and re-queue dead-lettered wake signals via `POST /api/v1/admin/outbox/dead-letter/retry`.
- **Token Invalidation:** On `UNREGISTERED_TOKEN` (including HTTP 404, `messaging/registration-token-not-registered`), the gateway's token is immediately set to `is_valid = FALSE` in `gateway_push_tokens`. Ambiguous Firebase `invalid-argument` errors do not revoke tokens.

### 7.4 Minimal High-Priority FCM Wake Payload

FCM messages are strictly wake-up triggers, never job carriers.
- **Payload:**
  ```json
  {
    "data": {
      "type": "JOBS_AVAILABLE"
    },
    "android": {
      "priority": "high",
      "ttl": 60000,
      "collapseKey": "swift_jobs_available"
    }
  }
  ```
- **Privacy & Security Guarantee:** The payload contains **ZERO** OTP codes, phone numbers, recipient metadata, SMS message text, or API credentials.
