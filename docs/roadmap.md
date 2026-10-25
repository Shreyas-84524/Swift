# Swift — Multi-Phase Implementation Roadmap

## Overview

The transformation of the standalone Android SMS gateway into the current single-owner Swift platform is organized across six phases. Multi-user tenancy is explicitly deferred.

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
│ Phase 2: Global Cloud Backend & Database Implementation     │
│ - Vercel TypeScript / Next.js Serverless Backend            │
│ - PostgreSQL database migration & pooling setup             │
│ - OTP generation, salted hashing, and challenge lifecycle   │
│ - Job queue engine with atomic leasing & stale sweeper      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 3: Android Gateway Worker Conversion                  │
│ - Implement event-driven FCM wake and queue draining        │
│ - Add WorkManager recovery for GLOBAL_WORKER mode           │
│ - Integrate SMS status sync (SENT, DELIVERED, FAILED)       │
│ - Offline recovery and bounded backoff                      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 4: Reliable Outbox Recovery & Operations              │
│ - Leased recovery dispatcher and dead-letter workflow       │
│ - Scheduler authentication and health observability         │
│ - Android token resumption and retry hardening              │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 5: Production Hardening, Verification & Release (Completed)│
│ - End-to-end 20-edge-case failure simulation test suite     │
│ - Atomic rate limiting with PostgreSQL advisory locking     │
│ - Server-side session binding client reference SDK          │
│ - Android release hardening (allowBackup=false, log strip)  │
│ - Production deployment runbooks, live acceptance checklist │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 6: Android & Web UI/UX Refinement (Pending)           │
│ - Android mobile application UI/UX overhaul                 │
│ - Web admin portal interface polishing & analytics views    │
└─────────────────────────────────────────────────────────────┘
```

---

## Detailed Phase Breakdown

### Phase 1: Architecture & Foundation (Completed)
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

### Phase 2: Cloud Backend & Database (Completed)
- [x] Implement the Next.js serverless backend in `backend/`.
- [x] Add PostgreSQL schema and additive migration verification.
- [x] Implement OTP send/verify and gateway queue/status APIs.
- [x] Add transactional job/outbox creation and automated tests.

### Phase 3: Android Gateway Worker Conversion (Completed with Phase 3.1 Hardening)
- [x] Add HTTP client library (OkHttp 4.12.0) and Jetpack Security (Keystore encrypted preferences).
- [x] Implement event-driven queue draining with FCM and WorkManager recovery.
- [x] Wire `SmsStatusReceiver` broadcast events to report back to backend status endpoint.
- [x] Implement Android 15 (`targetSdk 35`) `Service.onTimeout` graceful termination to prevent FGS timeout crashes.
- [x] Preserve legacy `LOCAL_API` mode switch for backward compatibility.

### Phase 4: Reliable Outbox Recovery & Production Push Architecture (Completed)
- [x] Implement leased outbox recovery, bounded backoff, and dead-letter handling.
- [x] Add authenticated scheduler and owner observability endpoints.
- [x] Implement event-driven FCM high-priority wake with periodic Android recovery.
- [x] Harden token resumption, WorkManager retry bounds, and single-flight draining.

### Phase 5: Production Integration & Release Readiness (Completed in code; physical acceptance pending)
- [x] Add a server-only TypeScript integration adapter and durable-session pattern.
- [x] Harden concurrent quotas, idempotency, verification, request bounds, and production templates.
- [x] Add mocked lifecycle/failure coverage and operational runbooks.
- [ ] Complete the controlled physical FCM/SIM acceptance checklist and configure production services.

### Phase 6: Android & Website UI/UX Refinement
- Refine the existing Android gateway interface without changing delivery semantics.
- Refine the owner website for responsive, accessible project, template, gateway, and outbox operations.
- Add visual state handling, validation feedback, and release-quality polish.
