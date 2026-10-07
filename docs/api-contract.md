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
