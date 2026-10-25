# Swift — Migration & Backward Compatibility Plan

## 1. Migration Overview

To ensure zero downtime and prevent accidental disruption to existing testing or local development workflows, the transformation from **Local Inbound Gateway** to **Global Outbound Worker** follows a progressive, multi-phase migration strategy.

---

## 2. Dual-Mode Coexistence Architecture

During the transition (Phases 1 through 4), the Android application will support two switchable operational modes configured in `ConfigManager`:

```
                    ┌───────────────────────────────┐
                    │     Android Gateway App       │
                    │        Operation Mode         │
                    └───────┬───────────────┬───────┘
                            │               │
            Mode: LOCAL_API │               │ Mode: GLOBAL_WORKER
                            ▼               ▼
      ┌──────────────────────────┐    ┌──────────────────────────┐
      │  Legacy Inbound Server   │    │  Global Outbound Worker  │
      │  - NanoHTTPD Port 8080   │    │  - Event-driven FCM wake │
      │  - LAN / Tunnel ingress  │    │  - Periodic recovery     │
      │  - Local key validation  │    │  - No open ports         │
      └──────────────────────────┘    └──────────────────────────┘
```

### 2.1 Mode Definitions
1. **`LOCAL_API` (Legacy / Development Mode):**
   - Keeps the embedded `NanoHTTPD` web server running on port 8080.
   - Handles `/api/send`, `/api/status`, `/api/history` directly on the local network.
   - Preserves compatibility for quick offline testing or direct LAN integrations.
2. **`GLOBAL_WORKER` (Production Target Mode):**
   - Disables local HTTP listener completely (freeing port 8080 and eliminating inbound attack surface).
   - Uses outbound HTTPS, an FCM wake signal, and periodic WorkManager recovery to connect to the global backend.
   - Authenticates using `otp_gw_live_*` gateway credentials.

---

## 3. Migration Roadmap by Component

| Component | Current State (Phase 1) | Intermediate State (Phase 2-4) | Final Target State (Phase 5) |
| :--- | :--- | :--- | :--- |
| **Client Apps (CivicFix, etc.)** | Call Cloudflare Tunnel / LAN IP directly | Dual client adapter (can target Local or Global) | Call Global Backend exclusively (`/api/v1/otp/*`) |
| **Android Gateway** | Standalone HTTP server (Port 8080) | Mode switch toggle (`LOCAL_API` vs `GLOBAL_WORKER`) | Pure Outbound Worker (`GLOBAL_WORKER`) |
| **Network Ingress** | Required (Cloudflare tunnel / port forward) | Optional (only for legacy local mode) | Completely eliminated (Zero ingress) |
| **OTP State** | Managed on caller side (unhashed) | Backend-managed challenge lifecycle | Fully managed with rate limits, salt & hashing |
| **Carrier Status** | Local Room DB only | Synced to Global PostgreSQL DB | Real-time delivery webhook / status lifecycle |

---

## 4. Decommissioning Cloudflare Quick Tunnel

Once the Global Backend is deployed and the Android Gateway Worker is validated:
1. **Decommission Tunnel Daemons:** Terminate `cloudflared` tunnel processes on development laptops.
2. **Update Client SDKs:** Point client projects to the global production URL (`https://api.global-otp.yourdomain.com`).
3. **Deprecate Local Ingress in Android:** Remove external domain configuration dialogs and reverse proxy guides from the mobile UI.

---

## 5. Rollback & Failsafe Plan

- If the Global Backend experiences outages or database connectivity issues during rollout:
  - The Android app can immediately be toggled back to `LOCAL_API` mode.
  - Client applications can temporarily utilize local fallback endpoints if necessary.
- The existing codebase structure is strictly preserved to ensure seamless reversion if required.

---

## 5. Phase 5 Database Hardening Migrations

### 5.1 Migration 008: Composite Rate-Limiting Indexes
Migration `database/008_phase5_hardening.sql` introduces composite B-tree indexes to optimize transactional rate-limiting queries during high-concurrency burst traffic:
- `idx_otp_challenges_phone_created` on `(project_id, phone_number, created_at DESC)`
- `idx_otp_challenges_project_created` on `(project_id, created_at DESC)`

These indexes support rate-limit queries while PostgreSQL advisory locks serialize quota decisions. Actual latency depends on database size, cache state, region, plan, and load; the PGlite migration test verifies structure rather than production latency.
