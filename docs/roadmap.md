# Swift — Multi-Phase Implementation Roadmap

## Overview

The transformation of the standalone Android SMS gateway into a multi-tenant Swift is organized across five distinct phases.

---

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: Architecture Conversion & Foundation (Completed)   │
│ - Comprehensive audit of existing Android app               │
│ - Global architecture, API contracts, security & data model │
│ - Android worker background strategy                        │
│ - Monorepo structure setup & build verification             │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: Global Cloud Backend & Database Implementation    │
│ - Vercel TypeScript / Next.js Serverless Backend            │
│ - PostgreSQL database migration & pooling setup             │
│ - OTP generation, salted hashing, and challenge lifecycle   │
│ - Job queue engine with atomic leasing & stale sweeper      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 3: Android Gateway Worker Conversion                  │
│ - Implement Outbound Polling Engine & Heartbeat             │
│ - Adapt Foreground Service to work in GLOBAL_WORKER mode    │
│ - Integrate SMS status sync (SENT, DELIVERED, FAILED)       │
│ - Offline buffering and adaptive backoff                    │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 4: Key Management & Admin/Gateway UI                  │
│ - Admin dashboard & project credential provisioning         │
│ - Android Gateway configuration UI (Key pairing, Sync)      │
│ - Rate limiting, quotas, and alerting                       │
│ - Observability & health monitoring dashboards              │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 5: CivicFix Integration & End-to-End Verification     │
│ - CivicFix backend integration with Global OTP API          │
│ - End-to-end verification (Auth flow -> SIM -> SMS delivery)│
│ - Load & stress testing                                     │
│ - Full documentation & production deployment                │
└─────────────────────────────────────────────────────────────┘
```

---

## Detailed Phase Breakdown

### Phase 1: Architecture & Foundation (Current)
- [x] Create dedicated branch `global-otp-service`.
- [x] Complete technical audit of Android codebase (`SmsManager`, Room DB, NanoHTTPD, `SmsGatewayService`).
- [x] Author global architecture specification (`docs/architecture.md`).
- [x] Define versioned REST API contract (`docs/api-contract.md`).
- [x] Design relational data model and DDL schema (`docs/data-model.md`, `database/schema.sql`).
- [x] Design security, hashing, and credential isolation model (`docs/security-model.md`).
- [x] Design Android worker background execution and UI (`docs/android-worker.md`).
- [x] Design migration and backward compatibility plan (`docs/migration-plan.md`).
- [x] Establish monorepo structure without breaking existing Gradle build.
- [x] Verify Android compilation with `./gradlew assembleDebug`.

### Phase 2: Cloud Backend & Database
- Implement Vercel serverless TypeScript backend in `backend/`.
- Deploy PostgreSQL schema on Supabase / Neon.
- Implement `/api/v1/otp/send` and `/api/v1/otp/verify` with CSPRNG and SHA-256 salted hashing.
- Implement `/api/v1/gateway/jobs` with atomic `SKIP LOCKED` job leasing.
- Implement `/api/v1/gateway/jobs/{jobId}/status` and `/api/v1/health`.
- Comprehensive backend unit and integration test suite.

### Phase 3: Android Gateway Worker Conversion (Completed with Phase 3.1 Hardening)
- [x] Add HTTP client library (OkHttp 4.12.0) and Jetpack Security (Keystore encrypted preferences).
- [x] Implement outbound polling worker (`GlobalGatewayWorker`) inside `SmsGatewayService`.
- [x] Wire `SmsStatusReceiver` broadcast events to report back to backend status endpoint.
- [x] Implement Android 15 (`targetSdk 35`) `Service.onTimeout` graceful termination to prevent FGS timeout crashes.
- [x] Preserve legacy `LOCAL_API` mode switch for backward compatibility.

### Phase 4: Key Management, Admin UI & Production Push Architecture
- Implement Project API Key generation with SHA-256 hashing and prefix indexing.
- Implement Gateway pairing workflow with one-time display credentials.
- Build Android device settings screen for entering gateway backend URL and API key.
- Evaluate & design event-driven FCM high-priority push wake mechanism for true 24/7 unattended production gateway operation without background polling timeouts.
- Add quota enforcement and IP-based rate limiting.

### Phase 5: CivicFix Integration & Production Release
- Integrate CivicFix auth pipeline with `POST /api/v1/otp/send` and `POST /api/v1/otp/verify`.
- Validate full live transmission cycle: User requests OTP in CivicFix $\to$ Global Backend $\to$ Android Worker $\to$ SIM $\to$ Cellular Carrier $\to$ User handset.
- Verify fallback and timeout scenarios.
- Release Android APK build and finalize production documentation.
