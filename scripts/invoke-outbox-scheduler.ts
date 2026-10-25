/**
 * Swift Outbox Scheduler Dispatch Trigger
 *
 * Standalone automation script to invoke the internal notification outbox dispatcher
 * via external cron schedulers (GitHub Actions scheduled workflow, systemd timer,
 * crontab, pg_cron, or cloud monitoring ping).
 *
 * Usage:
 *   npx tsx scripts/invoke-outbox-scheduler.ts
 *
 * Environment Variables:
 *   SWIFT_BASE_URL          Base URL of the Swift platform (e.g., https://swift.yourdomain.com)
 *   OUTBOX_SCHEDULER_SECRET Secret shared between external scheduler and Swift internal API
 *   BATCH_SIZE              Max number of due outbox records to claim per run (default: 20, max: 50)
 *   MAX_TIME_MS             Serverless execution budget in milliseconds (default: 8000, max: 25000)
 */

interface DispatchResponse {
  success: boolean;
  counts?: {
    claimed: number;
    sent: number;
    failed: number;
    dead_letter: number;
  };
  duration_ms?: number;
  error?: string;
  code?: string;
}

async function main(): Promise<void> {
  const baseUrl = (
    process.env.SWIFT_BASE_URL ||
    process.env.API_BASE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
  ).replace(/\/+$/, '');

  const secret = process.env.OUTBOX_SCHEDULER_SECRET || process.env.CRON_SECRET;
  if (!secret) {
    console.error('❌ Error: Neither OUTBOX_SCHEDULER_SECRET nor CRON_SECRET is configured.');
    console.error('   Please provide the scheduler authorization secret in your environment.');
    process.exit(1);
  }

  const batchSize = Number(process.env.BATCH_SIZE || '20');
  const maxTimeMs = Number(process.env.MAX_TIME_MS || '8000');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
    console.error('❌ Error: BATCH_SIZE must be an integer between 1 and 50.');
    process.exit(1);
  }
  if (!Number.isInteger(maxTimeMs) || maxTimeMs < 100 || maxTimeMs > 30000) {
    console.error('❌ Error: MAX_TIME_MS must be an integer between 100 and 30000.');
    process.exit(1);
  }

  const targetUrl = `${baseUrl}/api/v1/internal/outbox/dispatch`;
  console.log(`[Scheduler] Triggering outbox dispatch: ${targetUrl} (batch_size=${batchSize}, max_time_ms=${maxTimeMs})`);

  const startTime = Date.now();
  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secret}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Swift-Scheduler-Trigger/1.0',
      },
      body: JSON.stringify({
        batch_size: batchSize,
        max_time_ms: maxTimeMs,
      }),
      signal: AbortSignal.timeout(30000),
    });

    const elapsed = Date.now() - startTime;
    const data: DispatchResponse = await response.json().catch(() => ({
      success: false,
      error: `Non-JSON response received (HTTP ${response.status})`,
    }));

    if (!response.ok || !data.success) {
      console.error(`❌ [Scheduler] Dispatch failed with HTTP ${response.status} (${elapsed}ms):`);
      console.error(`   Error code: ${data.code || 'UNKNOWN'}`);
      console.error(`   Message: ${data.error || 'No error message provided'}`);
      process.exit(1);
    }

    console.log(`✅ [Scheduler] Dispatch completed successfully in ${elapsed}ms:`);
    console.log(`   Claimed: ${data.counts?.claimed ?? 0}`);
    console.log(`   Sent: ${data.counts?.sent ?? 0}`);
    console.log(`   Failed: ${data.counts?.failed ?? 0}`);
    console.log(`   Dead-lettered: ${data.counts?.dead_letter ?? 0}`);
    console.log(`   Backend processing duration: ${data.duration_ms ?? 0}ms`);
    process.exit(0);
  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    console.error(`❌ [Scheduler] Network or execution error after ${elapsed}ms: ${error.message}`);
    process.exit(1);
  }
}

main();
