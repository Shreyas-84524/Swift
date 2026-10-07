# Integrate Swift into a website, mobile app, or backend

Swift is an SMS verification service. Your backend calls two endpoints: send a code, then verify it. An online Android gateway sends the SMS through its SIM.

Production base URL: `https://global-otp-service.vercel.app`. For self-hosting, substitute your own deployment URL. The owner console is `/admin`; the public browser guide is `/integration`.

## 1. Provision a project

The Swift owner signs in with their email and password, creates a project under **Projects**, and generates an API key. Copy the raw key immediately; Swift shows it once. Create separate projects or keys for unrelated applications and environments. A test-prefixed key is not a simulated SMS sandbox: use a separate test deployment/device if you must avoid real messages.

The owner then registers an Android device under **Gateways**, generates a gateway key, configures the app with the same Swift base URL, grants the required permissions, and enables global worker mode. Verify it is online and has a working SIM.

Keep these credentials distinct:

| Credential | Where it belongs |
| --- | --- |
| Owner email and password | Private console sign-in only |
| Project API key | Your application's backend secrets |
| Gateway API key | Swift Android gateway only |

Do not embed project or gateway keys in React/Vue browser bundles, Flutter/Dart apps, Android/iOS binaries, desktop clients, or public repositories. Use a backend or serverless function you control.

## 2. Configure your backend

```dotenv
SWIFT_BASE_URL=https://global-otp-service.vercel.app
SWIFT_PROJECT_KEY=your_project_api_key
```

All requests use HTTPS, `Content-Type: application/json`, and `X-Project-Key: <key>`. Use E.164 phone numbers such as `+919876543210` consistently for send and verify.

## 3. Send a code

```sh
curl -X POST "$SWIFT_BASE_URL/api/v1/otp/send" \
  -H "Content-Type: application/json" \
  -H "X-Project-Key: $SWIFT_PROJECT_KEY" \
  -H "Idempotency-Key: unique-per-phone-and-attempt" \
  -d '{"phone":"+919876543210"}'
```

An HTTP 200 response includes:

```json
{
  "success": true,
  "request_id": "challenge-uuid",
  "challenge_id": "challenge-uuid",
  "expires_in": 300,
  "resend_after": 30,
  "data": {
    "challenge_id": "challenge-uuid",
    "phone_number": "+919876543210",
    "status": "QUEUED",
    "expires_in": 300,
    "retry_after_seconds": 30
  }
}
```

Expiry and cooldown depend on project configuration. Save `request_id` and the phone in the pending verification session on your backend. Display a resend countdown from `resend_after`. The raw OTP is never returned. `QUEUED` does not mean delivered.

Reuse an idempotency key only for a retry of the exact same send attempt and phone. Generate a new unique key for each new attempt. Do not reuse one fixed key for all users.

## 4. Verify the code

```sh
curl -X POST "$SWIFT_BASE_URL/api/v1/otp/verify" \
  -H "Content-Type: application/json" \
  -H "X-Project-Key: $SWIFT_PROJECT_KEY" \
  -d '{"phone":"+919876543210","request_id":"challenge-uuid","otp":"123456"}'
```

Successful verification returns HTTP 200 with `success: true` and `verified: true`. It also includes `data.verified`, `data.challenge_id`, and `data.verified_at`.

Only your backend should decide whether verification succeeded. Read the phone and request ID from the pending session rather than trusting client-supplied replacements. After successful verification, consume that pending session and create your own application session or update the intended user's verified phone. Swift verifies phone possession; it does not create your application's login session.

Compatibility aliases are `phone_number` for `phone`, `challenge_id` for `request_id`, and `code` for `otp`. Use the canonical fields shown above in new integrations. Keep the OTP as a string to preserve leading zeros.

## 5. Node.js / Next.js backend example

This module runs on your server, never in a client component:

```js
import { randomUUID } from 'node:crypto';

async function swift(path, payload, idempotencyKey) {
  const response = await fetch(`${process.env.SWIFT_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Project-Key': process.env.SWIFT_PROJECT_KEY,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = typeof data.error === 'string'
      ? data.error : data.error?.message || 'Verification request failed';
    throw Object.assign(new Error(message), { status: response.status, data });
  }
  return data;
}

// Persist attemptKey before calling; reuse it only for retrying this same attempt.
export async function sendCode(phone, attemptKey = randomUUID()) {
  return swift('/api/v1/otp/send', { phone }, attemptKey);
}

export async function verifyCode(pendingSession, code) {
  const result = await swift('/api/v1/otp/verify', {
    phone: pendingSession.phone,
    request_id: pendingSession.requestId,
    otp: code,
  });
  return result.verified === true;
}
```

Expose your own `/auth/send-code` and `/auth/verify-code` routes to clients. Validate inputs, protect session state, apply per-user/IP rate limits, and handle errors without exposing credentials. Persist the returned request ID in a server-side session associated with the user's attempt.

## 6. Python backend example

```python
import os
import requests

BASE = os.environ['SWIFT_BASE_URL'].rstrip('/')
HEADERS = {'X-Project-Key': os.environ['SWIFT_PROJECT_KEY']}

def send_code(phone, attempt_key):
    response = requests.post(
        BASE + '/api/v1/otp/send',
        headers={**HEADERS, 'Idempotency-Key': attempt_key},
        json={'phone': phone}, timeout=10,
    )
    response.raise_for_status()
    return response.json()  # Save request_id alongside phone in server session.

def verify_code(pending_session, code):
    response = requests.post(
        BASE + '/api/v1/otp/verify', headers=HEADERS,
        json={'phone': pending_session['phone'],
              'request_id': pending_session['request_id'], 'otp': code},
        timeout=10,
    )
    response.raise_for_status()
    return response.json().get('verified') is True
```

Catch `requests.HTTPError` and inspect `response.status_code` and the error body to show a useful message and resend countdown. Catch timeouts separately; do not retry indefinitely.

## 7. Flutter / mobile / browser clients

Call **your own backend**, which holds the Swift key. For Flutter with the `http` package:

```dart
final response = await http.post(
  Uri.parse('$yourBackendUrl/auth/send-code'),
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $yourPendingSessionToken',
  },
  body: jsonEncode({'phone': phone}),
).timeout(const Duration(seconds: 10));
// Handle non-2xx responses; display the countdown returned by your backend.
```

Submit the code to your own `/auth/verify-code` route with the same pending-session token. Your backend resolves the correct phone and Swift request ID. These `/auth/*` paths and pending-session tokens are examples to implement in your app, not endpoints supplied by Swift. The same architecture applies to React Native, native mobile apps, games, desktop tools, and browser frontends.

## Templates

Set the project SMS template in the console:

```text
Your {PROJECT_NAME} verification code is {OTP}. It expires in {EXPIRY_MINUTES} minutes.
```

Use single braces and the exact uppercase placeholders. The server chooses the authoritative project template. Do not send arbitrary SMS content from a public client. The configured template is limited to 300 characters; long project names and Unicode may still increase carrier SMS segments and costs.

## Errors and retry behavior

| Status | Meaning / action |
| --- | --- |
| 400 | Invalid input, wrong code, phone mismatch, or already-consumed code; inspect the response. Verification errors contain `error.code` and `error.message`. |
| 401 | Missing, invalid, or revoked project key; check server configuration. |
| 403 | Project access disabled; ask the owner to check project status. |
| 404 | Challenge not found for this project; check the pending session. |
| 410 | Expired challenge; start a fresh verification. |
| 429 | Send rate limit or maximum verification attempts reached; honor `retry_after_seconds` where provided. |
| 500/503 | Service/database problem; retry only with bounded backoff and monitor gateway health. |

Send errors commonly use a string `error`; verify errors use an object. Do not assume every error has the same shape. Preserve `error.attempts_remaining` when returned. A request accepted into the queue may remain queued if all gateways are offline.

## Before going live

1. Create a separate key for the application and store it in server secrets.
2. Confirm the gateway is online and send a code to a phone you control.
3. Verify a correct code; check that a wrong code and replay are rejected.
4. Test expiration, resend countdown, network failure, and offline-gateway behavior.
5. Confirm no API keys, OTPs, or passwords are in client bundles or logs.
6. Rotate a project key by issuing a replacement, updating your backend, then revoking the old key.

The owner password is never an API credential and is not included in this guide.
