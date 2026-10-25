import assert from 'assert';
import { NextRequest } from 'next/server';
import { JsonBodyError, readBoundedJsonObject } from '../src/lib/http/json-body';
import { authenticateScheduler } from '../src/lib/auth/internal';
import { RateLimiter } from '../src/lib/rate-limit/limiter';

async function runPhase5AuditHardeningTests(): Promise<void> {
  console.log('===============================================================');
  console.log('       Phase 5 Audit Correction Contract Tests                 ');
  console.log('===============================================================');

  const validRequest = new NextRequest('http://localhost/test', {
    method: 'POST',
    body: JSON.stringify({ phone: '+919876543210' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.deepStrictEqual(await readBoundedJsonObject(validRequest), { phone: '+919876543210' });
  console.log('  ✅ [PASS] Reads a valid bounded JSON object');

  const oversizedRequest = new NextRequest('http://localhost/test', {
    method: 'POST',
    body: JSON.stringify({ value: 'x'.repeat(11 * 1024) }),
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(
    () => readBoundedJsonObject(oversizedRequest),
    (error: unknown) => error instanceof JsonBodyError && error.statusCode === 413
  );
  console.log('  ✅ [PASS] Rejects an oversized actual UTF-8 body');

  const originalOutboxSecret = process.env.OUTBOX_SCHEDULER_SECRET;
  const originalCronSecret = process.env.CRON_SECRET;
  process.env.OUTBOX_SCHEDULER_SECRET = 'outbox_scheduler_secret_1234567890123456';
  process.env.CRON_SECRET = 'vercel_cron_secret_12345678901234567890';
  try {
    for (const token of [process.env.OUTBOX_SCHEDULER_SECRET, process.env.CRON_SECRET]) {
      const request = new NextRequest('http://localhost/api/v1/internal/outbox/dispatch', {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.strictEqual(authenticateScheduler(request).success, true);
    }
    console.log('  ✅ [PASS] Accepts either independently configured scheduler secret');
  } finally {
    if (originalOutboxSecret === undefined) delete process.env.OUTBOX_SCHEDULER_SECRET;
    else process.env.OUTBOX_SCHEDULER_SECRET = originalOutboxSecret;
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
  }

  const lockCalls: Array<{ sql: string; params: unknown[] }> = [];
  const runner = {
    async query(sql: string, params: unknown[] = []) {
      lockCalls.push({ sql, params });
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as any;
    },
  };
  await RateLimiter.acquireSendLocks('project-1', '+919876543210', runner);
  assert.strictEqual(lockCalls.length, 2);
  assert.strictEqual(lockCalls[0].params[0], 'rate:project:project-1');
  assert.strictEqual(lockCalls[1].params[0], 'rate:phone:project-1:+919876543210');
  console.log('  ✅ [PASS] Acquires project then phone advisory locks in stable order');

  console.log('===============================================================\n');
}

runPhase5AuditHardeningTests().catch((error) => {
  console.error('Phase 5 audit hardening tests failed:', error);
  process.exit(1);
});
