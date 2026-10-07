# Swift

<img src="images/swift-logo.png" alt="Swift: a white bird facing right on black" width="128" />

Swift connects your website or app to SMS verification through your own Android gateway. A Next.js API generates and verifies codes, PostgreSQL manages the queue, and an Android device delivers messages through its SIM.

- **Website:** https://global-otp-service.vercel.app
- **Repository:** https://github.com/Shreyas-84524/Swift
- **Developer guide:** [Integrate Swift into any project](docs/integration-guide.md)
- **Browser guide:** `/integration` on your deployment

## The workspace

The console provides project-specific API keys, gateway registration, queue counts, and integration examples. Its visual identity uses the right-facing white bird with obsidian (`#101110`), ivory (`#F5F3EE`), champagne (`#B69B68`), and warm stone (`#706B63`). Status colors remain distinct from the brand palette.

The browser console uses **Supabase Auth only**, with one allowed owner identified by their Supabase user ID and email. The account appears under Supabase → Authentication → Users. Supabase handles password verification, sessions, refresh, and sign-out. There is no custom password hash or custom session-signing fallback, and no public sign-up in Swift. Passwords and raw API keys must never appear in this README, application source, or browser bundles.

## Architecture

```text
Website / mobile app → Your backend → Swift API → PostgreSQL queue
                                                    ↑
                                          Android gateway + SIM
                                                    ↓
                                              Recipient phone
```

A send response confirms that a message was queued; it does not guarantee carrier delivery. Your gateway must be online, permitted to send SMS, and have an active SIM plan.

## Run locally

Requirements: Node.js with npm, PostgreSQL, and an Android device for actual SMS delivery.

```sh
cd backend
npm ci
# Copy .env.example to .env.local and set DATABASE_URL.
npm run owner:configure
npm run dev
```

Before `owner:configure`, set `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SWIFT_OWNER_EMAIL`, and `SWIFT_OWNER_PASSWORD` in the current process environment. The command creates (or updates) that owner through the Supabase Auth Admin API and writes only the returned user ID to ignored `.env.local`. Clear the temporary secret key and password afterward. Never pass them as command-line arguments.

In Supabase Auth settings, disable public sign-ups for this private owner project. Add your production site URL to URL Configuration. Existing unrelated Auth users are not deleted; the server UUID allowlist prevents them accessing Swift.

Apply `database/schema.sql` to a new database. Supabase Auth provides login rate limiting and authentication audit logs. The historical `002_admin_portal.sql` describes the retired phone-based login and is not needed for a new installation.

Open http://localhost:3000/admin and sign in with the configured owner email and password. Each external application gets its own **project API key**; external users do not receive owner accounts.

## Deploy the backend

Deploy `backend/` as the Next.js project on Vercel. Configure these **server-only** variables for the target environment:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection URL |
| `SWIFT_OWNER_EMAIL` | Sole owner email |
| `SWIFT_OWNER_NAME` | Owner display name |
| `SWIFT_OWNER_USER_ID` | Supabase Auth UUID of the sole owner |
| `SUPABASE_URL` | Existing Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Project publishable key (legacy anon key also works) |
| `ADMIN_SECRET_KEY` | Separate CLI infrastructure secret if CLI provisioning is used |

The runtime uses the publishable key, never a Supabase secret/service-role key. Do not deploy `SUPABASE_SECRET_KEY` or `SWIFT_OWNER_PASSWORD`. Remove retired `SWIFT_OWNER_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`, and `ADMIN_SETUP_TOKEN` variables. Redeploy after changing the Supabase URL, key, or owner allowlist.

Owner sessions are Supabase-issued and refreshed through Next.js middleware. Every private API request validates the user with Supabase Auth and checks the exact owner UUID and confirmed email. Legacy phone-based records and custom session cookies no longer authorize access. Existing projects, API keys, gateways, and OTP data remain intact.

## Android gateway

```powershell
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest
```

Install the debug APK from `app/build/outputs/apk/debug/`. In the web console, register a gateway and save its gateway key once. Configure the API base URL and gateway key in Swift on Android, grant SMS and phone permissions, select the SIM, and enable global worker mode. See [Android operations](docs/android-gateway-operations.md).

## Validation

```sh
cd backend
npm test
npm run test:owner
npm run build
```

These checks cover OTP/queue behavior, owner authentication, and production compilation. Actual carrier delivery still needs a connected physical gateway.

## Project layout

| Directory | Contents |
| --- | --- |
| `app/` | Android gateway application |
| `backend/` | Website, owner console, API, and tests |
| `database/` | PostgreSQL schema and historical migrations |
| `docs/` | Integration, operations, and architecture documentation |
| `images/` | Swift logo and brand notes |

[MIT License](LICENSE).
