# Swift — API Contract Specification

**Version:** 1.0.0  
**Base URL:** `https://<backend-domain>/api/v1`  
**Content-Type:** `application/json`  

---

## 1. Authentication Headers

The API enforces strict separation between **Client Application Keys** and **Gateway Worker Keys**:

| Role | Header | Key Format | Description |
| :--- | :--- | :--- | :--- |
| **Project Client** | `X-Project-Key` or `Authorization: Bearer <key>` | `otp_proj_live_<32_hex>` | Authenticates applications requesting or verifying OTPs |
| **Gateway Worker** | `X-Gateway-Key` or `Authorization: Bearer <key>` | `otp_gw_live_<32_hex>` | Authenticates Android gateway devices polling or updating jobs |
| **Admin Operations** | `X-Admin-Key` or `Authorization: Bearer <key>` | `otp_admin_live_<32_hex>` | Controls project and gateway credential lifecycles |

---

## 2. Client Application Endpoints

### 2.1 Send OTP Challenge
Generates a cryptographically random OTP, creates a salted hash, persists the challenge, queues an SMS job, and returns the challenge identifier.

- **Method:** `POST`
- **Path:** `/api/v1/otp/send`
- **Auth:** `X-Project-Key` required

#### Request Body
```json
{
  "phone_number": "+919876543210",
  "template": "Your verification code is {code}. Valid for 5 minutes.",
  "code_length": 6,
  "expiry_seconds": 300,
  "metadata": {
    "user_id": "usr_99812",
    "purpose": "login"
  }
}
```

#### Success Response (`201 Created`)
```json
{
  "success": true,
  "data": {
    "challenge_id": "ch_8f9c2d1b7a6e4f3c",
    "phone_number": "+919876543210",
    "status": "QUEUED",
    "expires_at": "2026-09-27T16:20:00.000Z",
    "retry_after_seconds": 30
  }
}
```

#### Error Responses
- `400 Bad Request`: Invalid phone format or template missing `{code}`
- `401 Unauthorized`: Invalid or revoked project key
- `429 Too Many Requests`: Project quota or phone rate-limit exceeded

---

### 2.2 Verify OTP Challenge
Validates a candidate code against the stored salted hash, checks expiration, and enforces maximum attempt limits.

- **Method:** `POST`
- **Path:** `/api/v1/otp/verify`
- **Auth:** `X-Project-Key` required

#### Request Body
```json
{
  "challenge_id": "ch_8f9c2d1b7a6e4f3c",
  "code": "492815"
}
```

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "verified": true,
    "challenge_id": "ch_8f9c2d1b7a6e4f3c",
    "verified_at": "2026-09-27T16:16:45.120Z"
  }
}
```

#### Verification Failure Responses
- **Incorrect Code (`400 Bad Request`):**
```json
{
  "success": false,
  "error": {
    "code": "INVALID_OTP",
    "message": "The OTP entered is incorrect.",
    "attempts_remaining": 2
  }
}
```
- **Expired or Max Attempts Exceeded (`410 Gone` / `429 Too Many Requests`):**
```json
{
  "success": false,
  "error": {
    "code": "CHALLENGE_EXPIRED",
    "message": "The OTP challenge has expired or exceeded maximum verification attempts."
  }
}
```

---

## 3. Gateway Worker Endpoints

### 3.1 Poll & Claim Queued SMS Jobs
Atomically retrieves and locks up to `batch_size` pending SMS jobs for the authenticated gateway.

- **Method:** `GET`
- **Path:** `/api/v1/gateway/jobs`
- **Auth:** `X-Gateway-Key` required
- **Query Parameters:**
  - `limit` (optional, default: 1, max: 10)
  - `lease_seconds` (optional, default: 60, max: 180)

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "jobs": [
      {
        "job_id": "job_01h8a9bc7ef12345",
        "phone_number": "+919876543210",
        "message": "Your verification code is 492815. Valid for 5 minutes.",
        "created_at": "2026-09-27T16:15:02.000Z",
        "lease_expires_at": "2026-09-27T16:16:02.000Z"
      }
    ]
  }
}
```
*Note: If no jobs are queued, `jobs` is an empty array `[]`.*

---

### 3.2 Update Job Status
Reports hardware transmission result (`SENT`, `FAILED`) and carrier delivery acknowledgment (`DELIVERED`).

- **Method:** `POST`
- **Path:** `/api/v1/gateway/jobs/{jobId}/status`
- **Auth:** `X-Gateway-Key` required

#### Request Body
```json
{
  "status": "SENT",
  "carrier_message_ref": "part1_ref102",
  "error_code": null,
  "error_message": null,
  "dispatched_at": "2026-09-27T16:15:05.340Z"
}
```

*For failures:*
```json
{
  "status": "FAILED",
  "error_code": "RESULT_ERROR_NO_SERVICE",
  "error_message": "SIM card reported no cellular carrier service",
  "dispatched_at": "2026-09-27T16:15:05.340Z"
}
```

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "job_id": "job_01h8a9bc7ef12345",
    "updated_status": "SENT",
    "acknowledged_at": "2026-09-27T16:15:05.800Z"
  }
}
```

---

### 3.3 Gateway Heartbeat
Reports gateway device metadata, SIM readiness, battery state, and active worker toggle status.

- **Method:** `POST`
- **Path:** `/api/v1/gateway/heartbeat`
- **Auth:** `X-Gateway-Key` required

#### Request Body
```json
{
  "device_model": "Pixel 7a",
  "android_version": 14,
  "app_version": "2.0.0",
  "battery_percentage": 92,
  "is_charging": true,
  "sim_state": "READY",
  "network_type": "WIFI",
  "worker_active": true
}
```

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "last_seen_at": "2026-09-27T16:15:00.000Z",
    "backend_timestamp": 1790525700
  }
}
```

---

## 4. System & Health Endpoints

### 4.1 System Health
Public or authenticated health probe for uptime monitors and status badges.

- **Method:** `GET`
- **Path:** `/api/v1/health`
- **Auth:** None

#### Success Response (`200 OK`)
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "timestamp": "2026-09-27T16:15:00.000Z",
  "services": {
    "database": "connected",
    "queue_lag_seconds": 1.2,
    "active_gateways": 1
  }
}
```

---

## 5. Administrative & Key Management Endpoints

### 5.1 Create Project
- **Method:** `POST`
- **Path:** `/api/v1/projects`
- **Auth:** `X-Admin-Key`

### 5.2 Generate Project API Key
- **Method:** `POST`
- **Path:** `/api/v1/projects/{projectId}/keys`
- **Auth:** `X-Admin-Key`
- **Response:** Returns the newly generated plaintext key ONCE along with its prefix and ID.

### 5.3 Revoke Project API Key
- **Method:** `DELETE`
- **Path:** `/api/v1/projects/{projectId}/keys/{keyId}`
- **Auth:** `X-Admin-Key`

### 5.4 Generate Gateway API Key
- **Method:** `POST`
- **Path:** `/api/v1/gateway/keys`
- **Auth:** `X-Admin-Key`

### 5.5 Revoke Gateway API Key
- **Method:** `DELETE`
- **Path:** `/api/v1/gateway/keys/{keyId}`
- **Auth:** `X-Admin-Key`

---

## 6. Message Templates & Push Foundation Endpoints (Phase 1)

All endpoints in this section require Admin authentication via Supabase JWT session cookie or `Authorization: Bearer <token>`.

### 6.1 List Templates for Project
- **Method:** `GET`
- **Path:** `/api/v1/admin/projects/{projectId}/templates`
- **Description:** Returns all templates for the given project, including their currently active version details.
- **Success Response (`200 OK`):**
```json
{
  "success": true,
  "templates": [
    {
      "id": "tpl_7f8a9b",
      "project_id": "proj_123",
      "name": "User Registration OTP",
      "slug": "user-reg-otp",
      "template_type": "OTP",
      "status": "ACTIVE",
      "active_version": {
        "id": "ver_9a8b7c",
        "version_number": 1,
        "body": "Your {{app_name}} verification code is {{otp}}. Valid for {{expiry_minutes}} minutes.",
        "variables": ["app_name", "otp", "expiry_minutes"],
        "character_count": 81,
        "segment_count": 1,
        "encoding": "GSM_7",
        "status": "ACTIVE"
      }
    }
  ]
}
```

### 6.2 Create Message Template
- **Method:** `POST`
- **Path:** `/api/v1/admin/projects/{projectId}/templates`
- **Description:** Validates approved placeholders (`{{otp}}`, `{{app_name}}`, `{{expiry_minutes}}`), verifies safety, calculates character/segment metrics, and creates initial version v1 in `DRAFT` status. Direct creation as `ACTIVE` is forbidden (returns HTTP 400 `DIRECT_ACTIVE_FORBIDDEN`).
- **Request Body:**
```json
{
  "name": "Login OTP Template",
  "slug": "login-otp",
  "template_type": "OTP",
  "body": "Your {{app_name}} OTP is {{otp}}. Valid for {{expiry_minutes}} mins.",
  "dlt_template_id": "1107161234567890123",
  "sender_header": "SWIFTG",
  "pe_id": "1201159876543210987"
}
```
- **Success Response (`201 Created`):** Returns the created template with `status: "DRAFT"` and version v1 with `status: "DRAFT"`.

### 6.3 Get Template Details & Version History
- **Method:** `GET`
- **Path:** `/api/v1/admin/projects/{projectId}/templates/{templateId}`
- **Description:** Retrieves the template, its current active version (if `ACTIVE`), its latest version, and complete historical versions list ordered by `version_number DESC`.

### 6.4 Update Template / Create New Version
- **Method:** `PATCH`
- **Path:** `/api/v1/admin/projects/{projectId}/templates/{templateId}`
- **Description:** Updates metadata (`name`, `description`, `dlt_template_id`, `sender_header`, `pe_id`). If `body` is provided and differs from latest version, creates a new `DRAFT` version (e.g. v2). If the template is currently `ACTIVE`, it remains live with its existing active version until the new draft version is explicitly approved and activated. Direct activation via update is rejected (returns HTTP 400).

### 6.5 Approve Template Version
- **Method:** `POST`
- **Path:** `/api/v1/admin/projects/{projectId}/templates/{templateId}/approve`
- **Description:** Explicit owner action to approve a `DRAFT` version before activation. Records `approved_by` and `approved_at` audit metadata.
- **Request Body (optional):**
```json
{
  "version_id": "ver_uuid_optional"
}
```
- **Success Response (`200 OK`):** Returns updated template with target version in `APPROVED` status.

### 6.6 Activate Template Version
- **Method:** `POST`
- **Path:** `/api/v1/admin/projects/{projectId}/templates/{templateId}/activate`
- **Description:** Transitions template status to `ACTIVE`. Accepts **ONLY** an `APPROVED` version (rejects `DRAFT` with HTTP 409 `MUST_BE_APPROVED`, rejects `ARCHIVED` with HTTP 409 `ARCHIVED_TEMPLATE`). Records `activated_at`. Atomically demotes any previously active OTP templates and versions in the same project to `APPROVED`, enforcing exactly one active OTP template per project.
- **Request Body (optional):**
```json
{
  "version_id": "ver_uuid_optional"
}
```
- **Success Response (`200 OK`):** Returns activated template with `active_version` populated.

### 6.7 Archive Template
- **Method:** `DELETE` on `/api/v1/admin/projects/{projectId}/templates/{templateId}` or `POST` on `/api/v1/admin/projects/{projectId}/templates/{templateId}/archive`
- **Description:** Soft-deletes template and cascades `ARCHIVED` status to all its versions. Verifies project ownership inside a single transaction using `SELECT ... FOR UPDATE`. If `projectId` does not match, performs zero mutations and returns HTTP 404.
- **Success Response (`200 OK`):** `{ "success": true, "message": "Template archived" }`


### 6.7 Preview Template & Segment Estimation
- **Method:** `POST`
- **Path:** `/api/v1/admin/projects/{projectId}/templates/preview`
- **Description:** Renders template text with sample variables, detects GSM 7-bit vs UCS-2 encoding, and calculates telecom segment counts according to 3GPP standards.
- **Request Body:**
```json
{
  "body": "Your {{app_name}} OTP is {{otp}}. Valid for {{expiry_minutes}} mins.",
  "sample_variables": {
    "app_name": "SwiftApp",
    "otp": "839201",
    "expiry_minutes": 5
  }
}
```
- **Success Response (`200 OK`):**
```json
{
  "success": true,
  "data": {
    "rendered_text": "Your SwiftApp OTP is 839201. Valid for 5 mins.",
    "variables": {
      "app_name": "SwiftApp",
      "otp": "839201",
      "expiry_minutes": "5"
    },
    "encoding": "GSM_7",
    "character_count": 46,
    "raw_length": 46,
    "segment_count": 1,
    "max_characters_per_segment": 160,
    "remaining_in_current_segment": 114
  }
}
```

### 6.8 Preview Saved Template
- **Method:** `GET` / `POST`
- **Path:** `/api/v1/admin/projects/{projectId}/templates/{templateId}/preview`
- **Description:** Renders and calculates telecom metrics for an existing saved template using its active version body and optional variable overrides.

---

## 7. Gateway Push Token Endpoints (Phase 2)

All endpoints in this section require Gateway authentication via the `X-Gateway-Key` header.
Tokens and sensitive payload details are never exposed to clients or logged.

### 7.1 Register or Rotate Gateway Push Token
Registers or rotates the FCM device push token for the authenticated gateway worker. Invalidates any previously active FCM tokens registered to this gateway.

- **Method:** `PUT`
- **Path:** `/api/v1/gateway/push-token`
- **Auth:** `X-Gateway-Key` required
- **Content-Type:** `application/json`

#### Request Body
```json
{
  "token": "dK3j8...fcm_device_token...x9P",
  "provider": "FCM",
  "platform": "ANDROID",
  "device_fingerprint": "a1b2c3d4e5f6",
  "app_version": "2.1.0"
}
```

- **Fields:**
  - `token` (string, required): Firebase Cloud Messaging registration token (min 10, max 4096 chars).
  - `provider` (string, required): Must be `"FCM"`.
  - `platform` (string, required): Must be `"ANDROID"`.
  - `device_fingerprint` (string, optional): Unique device hardware identifier (max 100 chars).
  - `app_version` (string, optional): Android gateway app release version (max 20 chars).

#### Responses
- **`200 OK` (Registration / Rotation Succeeded):**
```json
{
  "success": true,
  "data": {
    "registered": true,
    "provider": "FCM",
    "platform": "ANDROID",
    "last_registered_at": "2026-10-25T14:00:00.000Z"
  }
}
```
*Note: The response never echoes the raw push token.*

- **`400 Bad Request` (Validation Error or Malformed JSON):**
```json
{
  "error": "Invalid JSON request body"
}
```
*Or validation failures, e.g.:*
```json
{
  "error": "Token is required and must be a string"
}
```

- **`401 Unauthorized` (Missing or Invalid Gateway Key):**
```json
{
  "error": "Missing X-Gateway-Key header"
}
```

- **`409 Conflict` (Cross-Gateway Token Hijack Prevented):**
Returned if the token is already registered and assigned to another distinct gateway device.
```json
{
  "error": "Push token is already registered to another gateway device"
}
```

- **`500 Internal Server Error` (Database or Server Failure):**
```json
{
  "error": "Internal server error processing push token registration"
}
```

---

### 7.2 Invalidate Gateway Push Token(s)
Invalidates push tokens for the authenticated gateway (e.g., on gateway logout, worker disablement, or token decommissioning).

- **Method:** `DELETE`
- **Path:** `/api/v1/gateway/push-token`
- **Auth:** `X-Gateway-Key` required

All active tokens belonging to the authenticated gateway are invalidated. The raw token is intentionally never accepted in the URL, where access logs could expose it.

#### Responses
- **`200 OK` (Invalidation Succeeded):**
```json
{
  "success": true,
  "data": {
    "invalidated": true,
    "count": 1
  }
}
```

- **`401 Unauthorized` (Missing or Invalid Gateway Key):**
```json
{
  "error": "Invalid gateway key"
}
```

- **`500 Internal Server Error`:**
```json
{
  "error": "Internal server error invalidating push token"
}
```


---

## 8. Outbox Recovery & Observability Endpoints (Phase 4)

### 8.1 Internal Batch Dispatcher
Automated cron/scheduler invocation endpoint for processing queued wake items and recovering stale leases.

- **Method:** `POST`
- **Path:** `/api/v1/internal/outbox/dispatch`
- **Auth:** `Authorization: Bearer <OUTBOX_SCHEDULER_SECRET>` (Header ONLY. Query params strictly rejected with 400).
- **Runtime:** Node.js (Vercel Serverless / Scheduled Cron)

#### Request Body (Optional)
```json
{
  "batch_size": 25,
  "max_time_ms": 10000
}
```

- `batch_size`: integer from 1 through 50.
- `max_time_ms`: integer from 100 through 30000.
- Malformed JSON or out-of-range values return `400 Bad Request`.
- Unexpected internal failures return a generic `500` response without database or Firebase details.

#### Response (`200 OK`)
```json
{
  "success": true,
  "counts": {
    "claimed": 5,
    "sent": 5,
    "failed": 0,
    "dead_letter": 0
  },
  "duration_ms": 142
}
```

---

### 8.2 Outbox Health & Observability
Aggregated system telemetry for monitoring push health, token statuses, gateways, and queue depths. Zero PII/credentials exposed.

- **Method:** `GET`
- **Path:** `/api/v1/admin/outbox/health`
- **Auth:** Authenticated Admin Session / Owner (`requireAdmin`)

#### Response (`200 OK`)
```json
{
  "success": true,
  "timestamp": "2026-10-25T16:00:00.000Z",
  "data": {
    "outbox": {
      "counts": {
        "pending": 0,
        "processing": 0,
        "sent": 1420,
        "failed": 2,
        "dead_letter": 1
      },
      "oldest_due_age_seconds": null,
      "dead_letter_count": 1,
      "last_wake": {
        "timestamp": "2026-10-25T15:59:45.000Z",
        "status": "SENT",
        "response_code": "SENT",
        "age_seconds": 15
      }
    },
    "tokens": {
      "active": 1,
      "invalid": 0,
      "gateways_with_active_token": 1
    },
    "gateways": {
      "total_active": 1,
      "online": 1,
      "most_recent_seen_at": "2026-10-25T15:59:30.000Z"
    },
    "sms_jobs": {
      "queued": 0,
      "claimed": 0
    }
  }
}
```

---

### 8.3 Dead-Letter Outbox Recovery
Allows administrative re-dispatch of stalled or dead-lettered wake signals.
**Safety Guard:** Refuses to retry wake signals if the underlying SMS job has already achieved a terminal state (`SENT`, `DELIVERED`, or `EXPIRED`).

- **Method:** `POST`
- **Path:** `/api/v1/admin/outbox/dead-letter/retry`
- **Auth:** Authenticated Admin Session (`authorizeAdminMutation`, CSRF Protected)

#### Request Body
```json
{
  "outbox_id": "outbox_uuid_123",
  "outbox_ids": ["outbox_uuid_456"],
  "project_id": "optional_project_uuid"
}
```

#### Response (`200 OK`)
```json
{
  "success": true,
  "retried_count": 1,
  "retried_ids": ["outbox_uuid_123"]
}
```
