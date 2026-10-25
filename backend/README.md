# Swift backend

Next.js website, Supabase Auth owner login, and OTP/gateway API.

See the root [README](../README.md) for setup, deployment, and validation; the [integration guide](../docs/integration-guide.md) covers client applications.

Commands: `npm run dev`, `npm run build`, `npm test`, `npm run test:owner`, `npm run owner:configure`.

Runtime: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SWIFT_OWNER_USER_ID`, `SWIFT_OWNER_EMAIL`. Exactly one confirmed Supabase user UUID is authorized for the console. Public registration and custom password authentication are disabled.

### Push Wake Delivery (Firebase Cloud Messaging)

Swift uses Firebase Cloud Messaging (FCM HTTP v1) solely as an ephemeral wake-up signal to notify registered Android gateway devices of available jobs. PostgreSQL remains the durable source of truth.

Server environment variables:
- `FIREBASE_PROJECT_ID`: The Firebase Google Cloud Project ID.
- `FIREBASE_CLIENT_EMAIL`: The service account email (e.g., `firebase-adminsdk-xxxxx@project.iam.gserviceaccount.com`).
- `FIREBASE_PRIVATE_KEY`: The PEM-encoded service account private key (escaped newlines `\n` are supported).

When Firebase credentials are not configured, the backend records a sanitized outbox failure state and leaves the durable SMS job queued for Android polling fallback.
