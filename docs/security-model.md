# Swift — Security & Authentication Model

## 1. Security Architecture Principles

1. **Strict Credential Separation:** Client applications and Android gateway workers operate in strictly isolated trust domains.
2. **Zero Ingress on Gateway:** The Android gateway accepts zero inbound network connections. All traffic is outbound HTTPS initiated by the device.
3. **No Plaintext Key Storage:** All API keys and generated OTP codes are hashed using cryptographic algorithms before persistence.
4. **Defense in Depth:** Rate limiting, IP tracking, maximum verification limits, and short-lived expiration windows protect against brute force and denial of service.

---

## 2. Credential Domains & Isolation

```
┌─────────────────────────────────────────────────────────────┐
│                    Project Client Domain                    │
│ Key format: otp_proj_live_<32 hex> / otp_proj_test_<32 hex>  │
│ Scope: Create OTP challenges, verify OTP codes              │
│ Restrictions: Cannot poll jobs, cannot view gateway status  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                        RESTRICTED WALL
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                    Gateway Worker Domain                    │
│ Key format: otp_gw_live_<32 hex> / otp_gw_test_<32 hex>     │
│ Scope: Poll queued SMS jobs, update dispatch status         │
│ Restrictions: Cannot issue OTPs, cannot verify OTPs         │
└─────────────────────────────────────────────────────────────┘
```

- **Project Credentials:**
  - Used by applications such as CivicFix or Hostix.
  - Scoped strictly to the specific project entity.
  - Applications can never query or access gateway worker credentials.
- **Gateway Credentials:**
  - Assigned exclusively to registered physical Android devices.
  - Can only claim SMS jobs and update transmission status.
  - Gateway workers cannot initiate OTP generation or verify user submissions.

---

## 3. API Key Generation & Storage Specification

### 3.1 Key Format & Entropy
API keys adhere to structured prefixes for instant identification and automated secret scanning:

- **Production Project Key:** `otp_proj_live_` + `32-byte cryptographically secure random hex string` (64 hex characters)
  * Example: `otp_proj_live_9f83a7c61b2e4098d5f36e89012a4b5c7e8d9f0123456789abcdef0123456789`
- **Test Project Key:** `otp_proj_test_` + `32-byte hex`
- **Production Gateway Key:** `otp_gw_live_` + `32-byte hex`
  * Example: `otp_gw_live_0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b`
- **Test Gateway Key:** `otp_gw_test_` + `32-byte hex`

### 3.2 Hashing & Storage Strategy
1. **Raw Key Delivery:** The raw plaintext key is shown **only once** upon generation.
2. **Key Hash Computation:**
   $$\text{Key Hash} = \text{SHA-256}(\text{raw\_key})$$
3. **Database Representation:**
   - `key_prefix`: First 16 characters (e.g., `otp_proj_live_9f83...`) for identification in UI.
   - `key_hash`: 64-character hexadecimal SHA-256 digest.
   - `status`: `ACTIVE` or `REVOKED`.
4. **Validation Procedure:**
   When an incoming request presents `X-Project-Key` or `X-Gateway-Key`, the backend computes the SHA-256 hash of the header value and queries the database for an active matching hash in constant-time comparison.

### 3.3 Key Revocation & Rotation
- An API key can be revoked immediately via the admin API or dashboard.
- Revocation immediately invalidates all active sessions utilizing that key.
- Rotation is zero-downtime: generate a new active key, update the client/worker configuration, then revoke the legacy key.

---

## 4. OTP Challenge Lifecycle & Cryptographic Protection

### 4.1 Token Generation
- Generated via cryptographically secure pseudo-random number generator (CSPRNG, e.g., `crypto.randomInt(100000, 1000000)`).
- 6-digit numeric token with uniform distribution (000000 - 999999 or 100000 - 999999).

### 4.2 Salted Hashing
$$\text{Salt} = \text{CSPRNG}(16\text{ bytes hex})$$
$$\text{OTP Hash} = \text{SHA-256}(\text{Salt} \parallel \text{Plaintext OTP})$$

- Plaintext OTP is embedded into the SMS job payload once, sent to the queue, and discarded from backend memory.
- The database stores only `salt`, `otp_hash`, `expires_at`, and `attempts`.

### 4.3 Expiry & Attempt Limits
- **Time To Live (TTL):** Default 300 seconds (5 minutes). Maximum allowable TTL: 600 seconds.
- **Max Verification Attempts:** Maximum 3 failed attempts per challenge.
- **Consumption:** Upon first successful validation, `consumed` is atomically flipped to `TRUE`. Subsequent validation attempts are rejected immediately.

---

## 5. Gateway Claiming & Concurrency Protection

To ensure zero duplicate SMS transmissions across multiple gateway devices:

1. **Atomic Leasing (`SELECT ... FOR UPDATE SKIP LOCKED`):**
   ```sql
   UPDATE sms_jobs
   SET status = 'CLAIMED',
       assigned_gateway_id = :gatewayId,
       lease_expires_at = NOW() + INTERVAL '60 seconds',
       attempts = attempts + 1
   WHERE id = (
       SELECT id FROM sms_jobs
       WHERE status = 'QUEUED'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
   )
   RETURNING id, phone_number, message;
   ```
2. **Lease Expiration & Recovery:**
   - If a gateway claims a job but experiences network loss before reporting `SENT`, the lease expires after 60 seconds.
   - A background sweeper or subsequent claim query automatically reverts stale `CLAIMED` jobs back to `QUEUED` if `attempts < max_retries` (default: 3).
3. **Idempotency:**
   - Each challenge produces exactly one primary SMS job with a unique job ID.

---

## 6. Threat Modeling & Mitigation Matrix

| Threat | Attack Vector | Mitigation Strategy |
| :--- | :--- | :--- |
| **Brute Force OTP** | Automated guessing of 6-digit OTP | Max 3 attempts per challenge + 5-minute expiry + IP rate limiting |
| **SIM Flooding / Cost Exhaustion** | Rapid requests to single or many phone numbers | Per-phone rate limit (1 OTP / 60s), per-project hourly quotas |
| **Gateway Impersonation** | Attacker trying to drain SMS queue | Dedicated `otp_gw_live_*` key with SHA-256 hash lookup |
| **Eavesdropping on Phone** | Inbound network interception | Zero inbound open ports; pure outbound TLS 1.3 encryption |
| **Database Compromise** | Exposure of DB backup containing OTPs | OTPs are stored as SHA-256 salted hashes; raw tokens cannot be read |
