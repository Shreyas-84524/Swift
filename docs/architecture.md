# Swift Architecture

## 1. Executive Summary

This document specifies the target architecture for the **Swift**, transitioning from a standalone, local Android HTTP SMS gateway into a multi-project, centralized OTP generation and delivery infrastructure.

In the original implementation, external applications had to reach the Android device directly via LAN IP (`192.168.x.x`) or ephemeral reverse tunnels (e.g., Cloudflare Quick Tunnel `trycloudflare.com`). This created severe operational pain points:
- **Same Wi-Fi dependency** or reliance on temporary tunnels.
- **Laptop requirement** (must remain powered on to run tunnel daemons).
- **Security risks** associated with exposing Android local HTTP servers to public ingress.
- **Single application binding** without multi-tenant authentication, key lifecycle, or rate controls.

The new architecture decouples client applications from the physical Android device by introducing a **Global Cloud Backend** hosted on Vercel with PostgreSQL persistence. The Android device acts strictly as an **Outbound Gateway Worker**, polling for queued SMS jobs and dispatching them via its cellular SIM card.

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
│  │  - Stale lease recovery & Dead-letter handling        │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────┬──────────────────────────────▲───────────────┘
               │                              │
               │ PostgreSQL Queries           │ Outbound Long-Polling /
               │ (Supabase / Neon)            │ HTTPS Fetch & Status Push
               ▼                              │
┌──────────────────────────────┐              │
│       PostgreSQL DB          │              │
│ - projects                   │              │
│ - project_api_keys           │              │
│ - otp_challenges             │              │
│ - sms_jobs                   │              │
│ - gateways                   │              │
│ - gateway_api_keys           │              │
└──────────────────────────────┘              │
                                              │
                      ┌───────────────────────┴───────────────┐
                      │        Android Gateway Worker         │
                      │  (Header: X-Gateway-Key otp_gw_live_*)│
                      │                                       │
                      │  ┌─────────────────────────────────┐  │
                      │  │ Polling Engine / Job Consumer   │  │
                      │  │ - Exponential backoff + jitter  │  │
                      │  │ - Foreground Service (dataSync) │  │
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
- **Communication:** **100% Outbound HTTPS**. No inbound ports opened, no local web server exposed to WAN, no public IP or DDNS needed. Works equally well on Wi-Fi, 4G, or 5G mobile data.
- **Android 15 (API 35) Execution Model:**
  - Operates as a user-started `dataSync` Foreground Service with adaptive polling coroutines for development and testing.
  - Adheres to Android 15's cumulative 6-hour background limit with graceful `Service.onTimeout()` shutdown to prevent OS crash exceptions.
  - Does NOT assume 24/7 unattended background execution on Android 15 in polling mode.
- **Long-Term Production Architecture (Push-Triggered):**
  - Planned transition to high-priority push triggers (FCM): Backend enqueues SMS job $\to$ sends push wake signal $\to$ Android wakes $\to$ fetches job $\to$ sends SMS $\to$ reports status.
- **Responsibilities:**
  1. Poll `GET /api/v1/gateway/jobs` when worker toggle is **ON**.
  2. Acquire job claim leases from backend.
  3. Dispatch SMS through Android `SmsManager` (supporting single-part and multipart SMS).
  4. Capture broadcast intents for transmission success (`SMS_SENT`) and carrier delivery (`SMS_DELIVERED`).
  5. Immediately report delivery status via `POST /api/v1/gateway/jobs/{jobId}/status`.
  6. Completely halt all network requests and background loops when worker toggle is **OFF** or when `onTimeout` triggers.

---

## 4. Architectural Comparison: Legacy vs. Global

| Feature | Legacy Local Gateway | Swift |
| :--- | :--- | :--- |
| **Network Direction** | Inbound HTTP to phone (Port 8080) | Outbound HTTPS polling from phone to cloud |
| **Network Dependency** | Same Wi-Fi or Cloudflare Tunnel | Any internet connection (Wi-Fi or Mobile Data) |
| **Laptop Requirement** | Yes (must run `cloudflared` tunnel) | No (Vercel cloud backend runs 24/7) |
| **Multi-Tenancy** | Single API key in app settings | Multi-project isolation with unique keys & quotas |
| **OTP Security** | Client generated plaintext messages | Backend generates, hashes, and validates OTP |
| **Job Concurrency** | Single device, sequential queue | Multi-worker capable with atomic job leasing |
| **Carrier Delivery** | Local Room DB only | Synced to Global DB with full status lifecycle |
| **Attack Surface** | Exposed mobile HTTP server | Cloud API with strict rate limiting & WAF |

---

## 5. Elimination of Cloudflare Tunnel Dependency

In the legacy setup, Cloudflare Quick Tunnel was required to forward requests from public client web apps to `http://192.168.x.x:8080`. 
This is completely eliminated because:
1. The global backend is hosted on a public domain with automatic TLS managed by Vercel.
2. The phone initiates outbound TLS connections (HTTPS GET/POST) to the backend.
3. NAT traversal, dynamic IPs, and firewall traversal happen transparently over standard HTTPS outbound connections.
