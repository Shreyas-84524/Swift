# Swift Phase 5: Production Rollback & Contingency Plan

This document outlines the four-tier operational rollback procedures to restore known-good states during production incidents.

---

## Rollback Severity Tiers

| Tier | Scope | Target Recovery Time (RTO) | Action |
|---|---|---|---|
| **Level 1** | Application Deployment Rollback | < 2 minutes | Revert Vercel deployment to previous build |
| **Level 2** | Database Compatibility Response | Incident-dependent | Keep additive migrations; roll application code forward or back after compatibility review |
| **Level 3** | Scheduler & Dispatcher Circuit Breaker | < 1 minute | Pause cron or rotate `OUTBOX_SCHEDULER_SECRET` |
| **Level 4** | Android Gateway Client Rollback | < 15 minutes | Re-deploy previous APK build or toggle polling mode |

---

## Level 1: Instant Vercel Deployment Rollback

If a new backend deployment introduces unexpected runtime errors or latency spikes:

1. Open [Vercel Dashboard](https://vercel.com/dashboard) > **Swift Project**.
2. Navigate to the **Deployments** tab.
3. Locate the previous stable production deployment (e.g., Phase 4 commit `cd0aabf` or Phase 3 commit `74e9ca6`).
4. Click the three dots `...` next to that deployment > Select **Promote to Production**.
5. **Confirmation**:
   - Vercel routes 100% of incoming production traffic to the previous deployment within 15–30 seconds.
   - Zero database records are altered.

---

## Level 2: Database Compatibility Response

Migrations 004–008 are additive and older application builds tolerate their added tables, columns, and indexes. During an incident, prefer application rollback while leaving these migrations installed. Do not drop outbox, push-token, or template tables as an emergency response: doing so destroys durable state and can make rollback less safe.

If Migration 008 itself is proven to cause a database problem, take a backup, confirm no deployment depends on the indexes, and consider removing only these non-unique performance indexes during a controlled maintenance window:
```sql
DROP INDEX IF EXISTS idx_otp_challenges_phone_created;
DROP INDEX IF EXISTS idx_otp_challenges_project_created;
```

Any rollback of Migrations 004–007 requires a separately reviewed restore plan and verified backup; it is not part of this routine runbook.

---

## Level 3: Background Scheduler Circuit Breaker

If external cron calls are overloading the database or Firebase quotas:

1. **Option A: Rotate Scheduler Secret**:
   - In the hosting environment, rotate the active scheduler secret to a new value and redeploy. Do not set an empty value if another scheduler secret remains valid.
   - Redeploy or trigger environment sync.
   - Any external callers or compromised cron pings are immediately rejected with `HTTP 401`.
2. **Option B: Vercel Cron Suspension**:
   - Disable the cron job in Vercel or remove the cron entry from `vercel.json` and redeploy:
     ```json
     {
       "crons": []
     }
     ```
   - Deploy the change to halt automated serverless execution.

---

## Level 4: Android Gateway Client Fallback

If high-priority FCM wake signals fail due to regional Google outages or battery optimization changes:

1. **Durable Database Safety**:
   - Even if FCM push wakes fail completely, SMS jobs remain durably stored in PostgreSQL with status `QUEUED`.
   - No SMS messages are dropped or lost.
2. **Manual Drain via WorkManager**:
   - Android WorkManager periodic backup sync continues executing periodically (every 15–30 minutes) as long as the device is connected.
3. **Emergency APK Rollback**:
   - If a client-side regression occurs, install the previous stable debug/release APK build via `adb install -r -d app-previous.apk`.
   - The device will re-register its push token upon launch and resume draining queued jobs.
