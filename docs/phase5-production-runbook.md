# Swift Production Runbook (Phase 5)

This runbook defines the operational procedures for deploying, maintaining, monitoring, and troubleshooting the Swift SMS Gateway platform in production.

---

## 1. Architectural Architecture Overview

Swift is an event-driven SMS and OTP dispatch platform operating on a single-tenant, single-user model:
- **Control & API Plane**: Next.js 14 App Router hosted serverlessly (e.g., on Vercel).
- **Durable State Store**: PostgreSQL (hosted on Supabase) enforcing strict relational invariants, transactional locking, and tamper-resistant deduplication.
- **Push Wake Channel**: Firebase Cloud Messaging (FCM) high-priority data messages waking sleeping Android devices.
- **Modem & Dispatch Node**: Physical Android device running the Swift Android Gateway application communicating with local cellular modems (SIM cards).

PostgreSQL remains the durable source of truth. FCM is strictly a low-latency ephemeral wake-up trigger. If FCM drops or delays, the queued job remains recoverable, but delivery cannot be guaranteed when the gateway is powered off, force-stopped, offline, out of carrier service, or restricted by the OS/OEM.

---

## 2. PostgreSQL / Supabase Migration Sequence

Database migrations must be applied strictly in sequential order. Each migration is additive, backward-compatible, and transactional:

1. `database/schema.sql`: Core schema (projects, project_api_keys, gateways, gateway_api_keys, sms_jobs, otp_challenges).
2. `database/002_admin_portal.sql`: Admin user profile and session tables.
3. `database/003_supabase_auth_rls.sql`: Row-Level Security (RLS) policies binding admin entities.
4. `database/004_phase1_templates_and_push.sql`: Message templates, template versions, gateway push tokens, and notification outbox.
5. `database/005_phase1_corrections.sql`: Strengthened active template version invariant trigger (`fn_check_template_version_active_invariant`).
6. `database/006_phase2_outbox_push.sql`: Outbox deduplication key and unique constraints.
7. `database/007_phase4_outbox_recovery.sql`: Leases (`lease_expires_at`), partial indexes for stale lease recovery, and bounded exponential backoff fields.
8. `database/008_phase5_hardening.sql`: Composite indexes for serialized rate limiting (`idx_otp_challenges_phone_created`, `idx_otp_challenges_project_created`).

> [!IMPORTANT]
> Verify migration invariants after running migrations using the disposable PostgreSQL engine:
> ```bash
> npm --prefix backend run test:pg-invariants
> ```

---

## 3. Production Environment Variables (Vercel / Cloud Run)

Configure the following values in the hosting environment (e.g., Vercel Project Settings > Environment Variables). Do not manually override `NODE_ENV` on Vercel; production deployments set it appropriately:

| Variable | Description | Security Level |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Transaction pooler URL for serverless, port 6543) | Critical Secret |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Public Configuration |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous public key | Public Configuration |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase privileged service role key | Critical Secret |
| `FIREBASE_PROJECT_ID` | Google Cloud / Firebase project ID | Sensitive Secret |
| `FIREBASE_CLIENT_EMAIL` | Firebase Admin Service Account email | Sensitive Secret |
| `FIREBASE_PRIVATE_KEY` | Firebase Admin Service Account RSA private key (with `\n` line breaks) | Critical Secret |
| `OUTBOX_SCHEDULER_SECRET` | Secret token authorizing cron calls to `/api/v1/internal/outbox/dispatch` | Critical Secret |
| `CRON_SECRET` | Vercel Cron secret (automatically verified when Vercel triggers cron) | Critical Secret |
| `NODE_ENV` | Must resolve to `production` in a production deployment; normally supplied by the runtime | Environment Configuration |

---

## 4. Firebase Cloud Messaging (FCM) Setup

1. **Service Account Creation**:
   - In Google Cloud Console, navigate to **IAM & Admin** > **Service Accounts**.
   - Create `swift-fcm-dispatcher` with role `Firebase Cloud Messaging API Admin`.
   - Generate a new JSON key.
2. **Environment Variable Formatting**:
   - Extract `project_id`, `client_email`, and `private_key` from the downloaded JSON.
   - For `FIREBASE_PRIVATE_KEY`, ensure all newline characters are formatted as literal `\n`.
3. **Android Application Credentials**:
   - Download `google-services.json` from Firebase Console.
   - Place into `app/google-services.json`.
   - Never commit `google-services.json` to public version control.

---

## 5. Background Outbox Scheduler

To recover undelivered outbox records when immediate FCM invocations terminate or fail, use a scheduler capable of calling the endpoint every 1–2 minutes. Immediate post-commit FCM remains the normal low-latency path.

### Option A: Vercel Cron (`vercel.json`)
Vercel invokes cron paths with `GET` and sends `CRON_SECRET` as a Bearer token. As of January 2026, Vercel Hobby permits only once-daily cron execution, so it is not suitable for the 1–2 minute recovery objective. A per-minute plan or another trusted scheduler is required. See [Vercel Cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing).

```json
{
  "crons": [
    {
      "path": "/api/v1/internal/outbox/dispatch",
      "schedule": "*/2 * * * *"
    }
  ]
}
```

### Option B: External Trigger / GitHub Actions / Crontab
Execute the standalone scheduler invocation script:
```bash
cd backend
OUTBOX_SCHEDULER_SECRET="your-secret" SWIFT_BASE_URL="https://your-domain.com" npm run outbox:dispatch
```

Configure only the secret required by the selected scheduler where possible. If both `CRON_SECRET` and `OUTBOX_SCHEDULER_SECRET` are present during migration, the endpoint accepts either value independently.

---

## 6. Gateway Device Enrollment & Physical Setup

1. **SIM Card Provisioning**:
   - Insert an active SIM card into SIM Slot 1 with an active SMS pack.
   - Verify SMS sending via native messaging app first.
2. **Device Hardware Configuration**:
   - Connect phone to a dedicated USB power source.
   - Enable Wi-Fi connected to an uninterruptible network.
   - In Android Settings: **Apps** > **Swift Gateway** > **Battery** > Select **Unrestricted**.
   - Disable automatic app hibernation / remove permissions if unused.
3. **Gateway Pairing**:
   - Log into Swift Admin Portal.
   - Navigate to **Gateways** > **Register Gateway**.
   - Name the gateway (e.g. `Pixel-7a-Primary`) and copy the generated `otp_gw_live_...` API key.
   - Open Swift Gateway on the Android phone, enter the server URL (`https://your-domain.com`) and paste the Gateway Key.
   - Tap **Connect**. Verify status changes to **Connected / Idle**.

---

## 7. Health Telemetry & Observability

Monitor outbox and queue health by calling the admin observability endpoint:
```http
GET /api/v1/admin/outbox/health
Cookie: <authenticated owner session cookies>
```

Sample Response:
```json
{
  "success": true,
  "timestamp": "2026-10-26T00:00:00.000Z",
  "data": {
    "outbox": {
      "counts": { "pending": 0, "processing": 0, "sent": 0, "failed": 0, "dead_letter": 0 },
      "oldest_due_age_seconds": null,
      "dead_letter_count": 0,
      "last_wake": null
    },
    "tokens": { "active": 1, "invalid": 0, "gateways_with_active_token": 1 },
    "gateways": { "total_active": 1, "online": 1, "most_recent_seen_at": null },
    "sms_jobs": { "queued": 0, "claimed": 0 }
  }
}
```

---

## 8. Dead-Letter Recovery Procedure

When an outbox wake signal exceeds 5 delivery attempts (e.g. during a prolonged Google Cloud FCM outage), it transitions to `DEAD_LETTER`.

To replay dead-letter items once connectivity is restored:
```http
POST /api/v1/admin/outbox/dead-letter/retry
Content-Type: application/json
Origin: https://your-domain.com

{
  "outbox_ids": ["uuid-1", "uuid-2"]
}
```
*Note: The API automatically verifies the underlying SMS job state. If the SMS job has already been drained and marked `SENT`, the outbox retry is safely suppressed.*

---

## 9. Key Rotation Procedure

To rotate a Project API Key without client downtime:
1. Issue a secondary live key in Admin Portal (`otp_proj_live_...`).
2. Update the consuming application with the new key.
3. Verify successful dispatches under the new key in the dashboard.
4. Revoke the old key in the Admin Portal.

---

## 10. Regulatory & Consumer SIM Limitations (TRAI / DLT)

> [!WARNING]
> **Developer / Self-Hosted Infrastructure Disclaimer**:
> This platform utilizes physical Android devices with SIM cards.
> - **100-message threshold:** Historic TRAI measures limit concessional pricing beyond 100 SMS per SIM per day; they are not accurately described as a universal hard delivery cap. Current plan charges and carrier controls must be confirmed with the access provider.
> - **Bulk sender duties:** TRAI's current sender guidance states that bulk OTP, transactional, service, and commercial senders may need PE registration, a registered header and content template, and transmission of the applicable identifiers.
> - **No circumvention:** Do not rotate SIMs, vary templates, or otherwise attempt to evade DLT, carrier, consent, tariff, or anti-spam controls.
> - **Production scale:** Obtain advice from the carrier/aggregator and qualified Indian telecom counsel before production use. A consumer-SIM Android gateway should be treated as a hackathon, private test, or controlled low-volume system unless explicitly authorized.

Primary references: [TRAI advice to senders](https://www.trai.gov.in/advice-to-senders) and [TRAI's 100-SMS tariff explanation](https://www.trai.gov.in/sites/default/files/2024-09/54Fifty_Fourth_Amendment_05_Nov_2012.pdf). This section is operational guidance, not legal advice.
