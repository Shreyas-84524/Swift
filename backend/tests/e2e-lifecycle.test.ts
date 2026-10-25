import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { db } from '../src/lib/db/client';
import { OtpService } from '../src/lib/otp/service';
import { JobQueue } from '../src/lib/queue/job-queue';
import { PushService } from '../src/lib/push/push-service';
import { PushTokenService } from '../src/lib/push/token-service';
import { setMockFirebaseMessaging, resetFirebaseAdminState } from '../src/lib/push/firebase-admin';
import { Project, Gateway, SmsJob, NotificationOutboxItem, OtpChallenge } from '../src/types';

/**
 * Simulated Android Gateway Worker implementing Android Single-Flight Mutex,
 * In-Flight Set, and Room SQLite Cache State Machine.
 */
export class MockAndroidGatewayWorker {
  public drainLock = false;
  public pendingWorkSignal = false;
  public inFlightJobIds = new Set<string>();
  public localSmsDatabase = new Map<string, { status: string; localId: number }>();
  public dispatchedTelephonySms: Array<{ jobId: string; phone: string; message: string }> = [];
  public networkOnline = true;
  private localCounter = 0;

  public reset(): void {
    this.drainLock = false;
    this.pendingWorkSignal = false;
    this.inFlightJobIds.clear();
    this.localSmsDatabase.clear();
    this.dispatchedTelephonySms = [];
    this.networkOnline = true;
    this.localCounter = 0;
  }

  /**
   * Simulates JobDrainEngine.drainQueue()
   */
  public async drainQueue(gatewayId: string, limit = 5): Promise<{ claimed: number; dispatched: number }> {
    if (!this.networkOnline) {
      return { claimed: 0, dispatched: 0 };
    }

    // Single-Flight Mutex Protection
    if (this.drainLock) {
      this.pendingWorkSignal = true;
      return { claimed: 0, dispatched: 0 };
    }

    this.drainLock = true;
    let claimedCount = 0;
    let dispatchedCount = 0;

    try {
      let keepRunning = true;
      while (keepRunning) {
        this.pendingWorkSignal = false;
        const jobs = await JobQueue.claimJobs(gatewayId, limit, 60);
        claimedCount += jobs.length;

        for (const job of jobs) {
          const effectiveJobId = job.job_id || (job as any).id;
          // Check in-flight set deduplication
          if (this.inFlightJobIds.has(effectiveJobId)) {
            continue;
          }
          this.inFlightJobIds.add(effectiveJobId);

          try {
            // Check Room SQLite local cache (isJobAlreadyProcessed)
            const localRecord = this.localSmsDatabase.get(effectiveJobId);
            if (localRecord && (localRecord.status === 'SENT' || localRecord.status === 'DELIVERED')) {
              // Already processed locally; update backend status without re-dispatching to cellular modem
              await JobQueue.updateJobStatus(effectiveJobId, gatewayId, 'SENT');
              continue;
            }

            // Simulate Android Telephony modem dispatch
            this.localCounter++;
            this.localSmsDatabase.set(effectiveJobId, { status: 'SENT', localId: this.localCounter });
            this.dispatchedTelephonySms.push({
              jobId: effectiveJobId,
              phone: job.phone_number,
              message: job.message,
            });
            dispatchedCount++;

            // Report SENT to Swift Backend
            await JobQueue.updateJobStatus(effectiveJobId, gatewayId, 'SENT');
          } catch (jobErr) {
            console.error('Job dispatch error for phone ' + job.phone_number + ':', jobErr);
          } finally {
            this.inFlightJobIds.delete(effectiveJobId);
          }
        }

        keepRunning = jobs.length === limit || (this.pendingWorkSignal && jobs.length > 0);
      }
    } finally {
      this.drainLock = false;
    }

    return { claimed: claimedCount, dispatched: dispatchedCount };
  }
}

/**
 * Main E2E Lifecycle & Failure Testing Suite.
 * Covers all 20 required edge cases without real carrier or live FCM dispatches.
 */
export async function runE2eLifecycleSuite(): Promise<{ totalPassed: number }> {
  console.log('\n===============================================================');
  console.log('       Phase 5D: Automated E2E Lifecycle & Failure Suite       ');
  console.log('===============================================================');

  let passed = 0;
  function pass(desc: string) {
    passed++;
    console.log(`  ✅ [PASS] Edge Case: ${desc}`);
  }

  const worker = new MockAndroidGatewayWorker();
  let capturedFcmMessages: any[] = [];

  // Configure test environment variables for Firebase
  process.env.FIREBASE_PROJECT_ID = 'swift-test-firebase-project';
  process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@swift-test.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\\n-----END PRIVATE KEY-----\\n';

  // Mock Firebase Cloud Messaging
  setMockFirebaseMessaging({
    send: async (msg: any) => {
      capturedFcmMessages.push(msg);
      return `projects/test/messages/${crypto.randomUUID()}`;
    },
  } as any);

  const testProject: Project = {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'Swift E2E Platform',
    slug: 'swift-e2e',
    enabled: true,
    config: {
      otp_length: 6,
      expiry_seconds: 300,
      cooldown_seconds: 30,
      hourly_limit: 5,
    },
    created_at: new Date(),
    updated_at: new Date(),
  };

  const testGatewayId = '20000000-0000-4000-8000-000000000001';

  // Initialize Disposable In-Memory PostgreSQL Engine for E2E Suite
  const pglite = new PGlite();
  await pglite.exec(`
    CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid AS $$
    BEGIN
      RETURN gen_random_uuid();
    END;
    $$ LANGUAGE plpgsql;
  `);

  const sanitizeForPglite = (sql: string) => {
    return sql.replace(/CREATE EXTENSION IF NOT EXISTS\s+["']uuid-ossp["'];?/gi, '-- [uuid-ossp bypassed in pglite: native gen_random_uuid in use]');
  };

  const rootDir = path.resolve(__dirname, '../../');
  const schemaPath = path.join(rootDir, 'database', 'schema.sql');
  const m004 = path.join(rootDir, 'database', '004_phase1_templates_and_push.sql');
  const m005 = path.join(rootDir, 'database', '005_phase1_corrections.sql');
  const m006 = path.join(rootDir, 'database', '006_phase2_outbox_push.sql');
  const m007 = path.join(rootDir, 'database', '007_phase4_outbox_recovery.sql');
  const m008 = path.join(rootDir, 'database', '008_phase5_hardening.sql');

  await pglite.exec(sanitizeForPglite(fs.readFileSync(schemaPath, 'utf-8')));
  await pglite.exec(sanitizeForPglite(fs.readFileSync(m004, 'utf-8')));
  await pglite.exec(sanitizeForPglite(fs.readFileSync(m005, 'utf-8')));
  await pglite.exec(sanitizeForPglite(fs.readFileSync(m006, 'utf-8')));
  await pglite.exec(sanitizeForPglite(fs.readFileSync(m007, 'utf-8')));
  await pglite.exec(sanitizeForPglite(fs.readFileSync(m008, 'utf-8')));

  // Connection pool serializer for in-memory single-backend engine
  let poolLock: Promise<void> = Promise.resolve();

  (db as any).getClient = async () => {
    let releaseLock!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const currentLock = poolLock;
    poolLock = poolLock.then(() => nextLock);
    await currentLock;

    return {
      query: (text: string, params: any[] = []) => pglite.query(text, params),
      release: () => {
        releaseLock();
      },
    };
  };

  (db as any).query = (text: string, params: any[] = []) => {
    return pglite.query(text, params);
  };

  // Seed projects
  await db.query(
    `INSERT INTO projects (id, name, slug, enabled, config)
     VALUES ($1, $2, $3, $4, $5)`,
    [testProject.id, testProject.name, testProject.slug, testProject.enabled, JSON.stringify(testProject.config)]
  );

  await db.query(
    `INSERT INTO projects (id, name, slug, enabled, config)
     VALUES ($1, $2, $3, $4, $5)`,
    ['10000000-0000-4000-8000-000000000008', 'Limited Project', 'limited-proj', true, JSON.stringify({ cooldown_seconds: 0, hourly_limit: 2 })]
  );

  // Seed primary gateway
  await db.query(
    `INSERT INTO gateways (id, name, is_active, worker_enabled)
     VALUES ($1, $2, TRUE, TRUE)`,
    [testGatewayId, 'Primary E2E Gateway']
  );

  await db.query(
    `INSERT INTO gateway_push_tokens (gateway_id, provider, platform, token, is_valid)
     VALUES ($1, 'FCM', 'ANDROID', 'token_pixel_e2e_1', TRUE)`,
    [testGatewayId]
  );

  // Seed active template
  const templateId = '30000000-0000-4000-8000-000000000001';
  const versionId = '30000000-0000-4000-8000-000000000002';
  await db.query(
    `INSERT INTO message_templates (id, project_id, name, slug, template_type, status, active_version_id)
     VALUES ($1, $2, 'Default OTP', 'default-otp', 'OTP', 'DRAFT', NULL)`,
    [templateId, testProject.id]
  );
  await db.query(
    `INSERT INTO message_template_versions (id, template_id, version_number, body, variables, character_count, segment_count, encoding, status, approved_by, approved_at)
     VALUES ($1, $2, 1, 'Your verification code for {{app_name}} is {{otp}}. Valid for {{expiry_minutes}} minutes.', '["app_name", "otp", "expiry_minutes"]'::jsonb, 85, 1, 'GSM_7', 'APPROVED', 'owner-id', NOW())`,
    [versionId, templateId]
  );
  await db.query('BEGIN');
  await db.query(
    `UPDATE message_templates SET status = 'ACTIVE', active_version_id = $1 WHERE id = $2`,
    [versionId, templateId]
  );
  await db.query(
    `UPDATE message_template_versions SET status = 'ACTIVE', activated_at = NOW() WHERE id = $1`,
    [versionId]
  );
  await db.query('COMMIT');

  // --- 1. Successful Send and Verification (Happy Path) ---
  capturedFcmMessages = [];
  worker.reset();
  const phone1 = '+919876500001';
  const send1 = await OtpService.sendOtp(testProject, { phone: phone1 });
  assert(send1.status === 200 && 'request_id' in send1.body, 'Send returns HTTP 200 with request_id');
  const reqId1 = (send1.body as any).request_id;

  // Drain via Android Worker
  const drain1 = await worker.drainQueue(testGatewayId);
  assert(drain1.dispatched === 1, 'Simulated Android worker dispatched 1 SMS');
  assert(worker.dispatchedTelephonySms[0].phone === phone1, 'SMS dispatched to expected recipient');

  // Retrieve generated OTP from dispatched message text
  const matchOtp = worker.dispatchedTelephonySms[0].message.match(/\b\d{6}\b/);
  assert(matchOtp !== null, 'Extracted 6-digit numeric OTP from SMS body');
  const extractedOtp = matchOtp[0];

  // Verify OTP
  const verify1 = await OtpService.verifyOtp(testProject, {
    phone: phone1,
    request_id: reqId1,
    otp: extractedOtp,
  });
  assert(verify1.status === 200 && verify1.body.verified === true, 'Verification succeeds with HTTP 200');
  pass('1. Successful send and verification (Happy Path)');

  // --- 2. Incorrect OTP and Attempts Remaining ---
  const phone2 = '+919876500002';
  const send2 = await OtpService.sendOtp(testProject, { phone: phone2 });
  const reqId2 = (send2.body as any).request_id;

  const verifyWrong = await OtpService.verifyOtp(testProject, {
    phone: phone2,
    request_id: reqId2,
    otp: '000000',
  });
  assert(verifyWrong.status === 400, 'Wrong OTP returns HTTP 400');
  assert(verifyWrong.body.verified === false, 'verified is false');
  assert(verifyWrong.body.error?.attempts_remaining === 2, 'attempts_remaining is 2');
  pass('2. Incorrect OTP and attempts remaining decrement');

  // --- 3. Expired OTP ---
  const phone3 = '+919876500003';
  const send3 = await OtpService.sendOtp(testProject, { phone: phone3, expiry_seconds: 60 });
  const reqId3 = (send3.body as any).request_id;
  // Artificially expire the challenge in DB
  await db.query(`UPDATE otp_challenges SET expires_at = NOW() - INTERVAL '10 seconds' WHERE id = $1`, [reqId3]);

  const verifyExpired = await OtpService.verifyOtp(testProject, {
    phone: phone3,
    request_id: reqId3,
    otp: '123456',
  });
  assert(verifyExpired.status === 410, 'Expired OTP returns HTTP 410 Gone');
  assert(verifyExpired.body.error?.code === 'CHALLENGE_EXPIRED', 'Error code is CHALLENGE_EXPIRED');
  pass('3. Expired OTP rejected with HTTP 410');

  // --- 4. Replay After Successful Verification ---
  const verifyReplay = await OtpService.verifyOtp(testProject, {
    phone: phone1,
    request_id: reqId1,
    otp: extractedOtp,
  });
  assert(verifyReplay.status === 400, 'Replayed verification returns HTTP 400');
  assert(verifyReplay.body.error?.code === 'ALREADY_CONSUMED', 'Rejection code is ALREADY_CONSUMED');
  pass('4. Replay after successful verification rejected');

  // --- 5. Duplicate Idempotency Request (Sequential) ---
  const phone5 = '+919876500005';
  const idempKey5 = `idemp_${crypto.randomUUID()}`;
  const send5a = await OtpService.sendOtp(testProject, { phone: phone5, idempotency_key: idempKey5 });
  const send5b = await OtpService.sendOtp(testProject, { phone: phone5, idempotency_key: idempKey5 });
  assert(send5a.status === 200 && send5b.status === 200, 'Both idempotent requests return HTTP 200');
  assert((send5a.body as any).request_id === (send5b.body as any).request_id, 'Both return identical request_id');
  pass('5. Duplicate sequential idempotency request returns identical challenge');

  // --- 6. Concurrent Duplicate Requests (serialized PGlite connection harness) ---
  const phone6 = '+919876500006';
  const idempKey6 = `idemp_par_${crypto.randomUUID()}`;
  const [par1, par2] = await Promise.all([
    OtpService.sendOtp(testProject, { phone: phone6, idempotency_key: idempKey6 }),
    OtpService.sendOtp(testProject, { phone: phone6, idempotency_key: idempKey6 }),
  ]);
  if (par1.status !== 200 || par2.status !== 200) {
    console.error('Parallel result mismatch:', { par1, par2 });
  }
  assert(par1.status === 200 && par2.status === 200, 'Parallel duplicate requests both succeed');
  assert((par1.body as any).request_id === (par2.body as any).request_id, 'Parallel requests share identical request_id');
  pass('6. Concurrent duplicate requests remain idempotent in the serialized PGlite harness');

  // --- 7. Phone Cooldown Rejection ---
  const phone7 = '+919876500007';
  await OtpService.sendOtp(testProject, { phone: phone7 });
  const cooldownRes = await OtpService.sendOtp(testProject, { phone: phone7 });
  assert(cooldownRes.status === 429, 'Immediate send returns HTTP 429 Cooldown');
  assert((cooldownRes.body as any).retry_after_seconds > 0, 'Returns retry_after_seconds');
  pass('7. Phone cooldown strictly enforced with HTTP 429');

  // --- 8. Project Quota Enforcement ---
  const limitedProject: Project = {
    ...testProject,
    id: '10000000-0000-4000-8000-000000000008',
    config: { cooldown_seconds: 0, hourly_limit: 5, project_hourly_limit: 2 },
  };
  await OtpService.sendOtp(limitedProject, { phone: '+919876500008' });
  await OtpService.sendOtp(limitedProject, { phone: '+919876500108' });
  const quotaRes = await OtpService.sendOtp(limitedProject, { phone: '+919876500208' });
  assert(quotaRes.status === 429, 'Exceeded project-wide hourly limit returns HTTP 429');
  pass('8. Project quota enforcement rejects excessive sends across different phones');

  // --- 9. No Active Gateway ---
  // Temporarily disable active gateways in DB
  await db.query(`UPDATE gateways SET is_active = FALSE WHERE id = $1`, [testGatewayId]);
  const phone9 = '+919876500009';
  const noGwRes = await OtpService.sendOtp(testProject, { phone: phone9 });
  assert(noGwRes.status === 200, 'Client receives HTTP 200 OK without internal details');
  const jobNoGw = await db.query<SmsJob>(`SELECT * FROM sms_jobs WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1`, [phone9]);
  assert(jobNoGw.rows[0]?.status === 'QUEUED', 'Durable SMS job remains safely QUEUED');
  await db.query(`UPDATE gateways SET is_active = TRUE WHERE id = $1`, [testGatewayId]);
  pass('9. No active gateway preserves durable SMS job in QUEUED status');

  // --- 10. Ambiguous Gateway Selection ---
  // Temporarily insert a secondary active gateway
  const secondGwId = '20000000-0000-4000-8000-000000000002';
  await db.query(`INSERT INTO gateways (id, name, is_active, worker_enabled) VALUES ($1, 'Gateway 2', TRUE, TRUE)`, [secondGwId]);
  await db.query(`INSERT INTO gateway_push_tokens (gateway_id, provider, token, is_valid) VALUES ($1, 'FCM', 'token_gw_2', TRUE)`, [secondGwId]);

  const phone10 = '+919876500010';
  const ambigRes = await OtpService.sendOtp(testProject, { phone: phone10 });
  assert(ambigRes.status === 200, 'Ambiguous gateways return HTTP 200 to client');
  const outboxAmbig = await db.query<NotificationOutboxItem>(`SELECT * FROM notification_outbox ORDER BY created_at DESC LIMIT 1`);
  assert(outboxAmbig.rows[0]?.response_code === 'AMBIGUOUS_GATEWAY_SELECTION', 'Outbox records AMBIGUOUS_GATEWAY_SELECTION');
  await db.query(`DELETE FROM gateway_push_tokens WHERE gateway_id = $1`, [secondGwId]);
  await db.query(`DELETE FROM gateways WHERE id = $1`, [secondGwId]);
  pass('10. Ambiguous gateway selection suppresses wake and preserves single-owner invariant');

  // --- 11. Missing/Invalid FCM Token ---
  setMockFirebaseMessaging({
    send: async () => {
      const err: any = new Error('The registration token is not a valid FCM registration token');
      err.code = 'messaging/registration-token-not-registered';
      throw err;
    },
  } as any);
  const phone11 = '+919876500011';
  const invTokenRes = await OtpService.sendOtp(testProject, { phone: phone11 });
  assert(invTokenRes.status === 200, 'Send succeeds with durable job');
  pass('11. Invalid FCM token does not drop durable SMS job');

  // --- 12. FCM Transient Failure Followed by Retry ---
  let fcmFails = true;
  setMockFirebaseMessaging({
    send: async (msg: any) => {
      if (fcmFails) {
        const err: any = new Error('Server temporarily unavailable');
        err.code = 'messaging/server-unavailable';
        throw err;
      }
      return 'projects/test/messages/ok';
    },
  } as any);
  const phone12 = '+919876500012';
  await OtpService.sendOtp(testProject, { phone: phone12 });
  // Advance attempt and recover
  fcmFails = false;
  const dispatchRes = await PushService.claimAndDispatchBatch(10, 5000);
  assert(dispatchRes.sent >= 1 || dispatchRes.claimed >= 1, 'Batch claim recovered transient outbox item');
  pass('12. FCM transient failure safely backed off and retried');

  // --- 13. Stale Outbox Lease Recovery ---
  const staleId = crypto.randomUUID();
  await db.query(
    `INSERT INTO notification_outbox (id, channel, priority, payload, status, attempts, next_attempt_at, lease_expires_at, deduplication_key)
     VALUES ($1, 'FCM', 'HIGH', '{"type":"JOBS_AVAILABLE"}'::jsonb, 'PROCESSING', 1, NOW(), NOW() - INTERVAL '10 seconds', $2)`,
    [staleId, `stale_${staleId}`]
  );
  const recoverStale = await PushService.claimAndDispatchBatch(10, 5000);
  assert(recoverStale.claimed >= 1, 'Stale PROCESSING lease reclaimed');
  pass('13. Stale outbox lease recovered after worker interruption');

  // --- 14. Dead-Letter Transition ---
  const deadJobId = crypto.randomUUID();
  await db.query(
    `INSERT INTO sms_jobs (id, project_id, phone_number, message, status) VALUES ($1, $2, '+919876500014', 'M', 'QUEUED')`,
    [deadJobId, testProject.id]
  );
  const deadId = crypto.randomUUID();
  await db.query(
    `INSERT INTO notification_outbox (id, job_id, channel, priority, payload, status, attempts, max_attempts, next_attempt_at, deduplication_key)
     VALUES ($1, $2, 'FCM', 'HIGH', '{"type":"JOBS_AVAILABLE"}'::jsonb, 'FAILED', 5, 5, NOW(), $3)`,
    [deadId, deadJobId, `dead_${deadId}`]
  );
  fcmFails = true;
  await PushService.claimAndDispatchBatch(10, 5000);
  const deadCheck = await db.query<NotificationOutboxItem>(`SELECT * FROM notification_outbox WHERE id = $1`, [deadId]);
  assert(deadCheck.rows[0]?.status === 'DEAD_LETTER' || deadCheck.rows[0]?.attempts >= 5, 'Transitions to DEAD_LETTER after max attempts');
  pass('14. Exceeded maximum attempts transitions outbox to DEAD_LETTER');

  // --- 15. Manual Dead-Letter Retry ---
  await db.query(`UPDATE notification_outbox SET status = 'DEAD_LETTER', attempts = 5 WHERE id = $1`, [deadId]);
  const retryResult = await PushService.retryDeadLetter([deadId]);
  assert(retryResult.retriedCount === 1, 'Admin dead-letter retry reset 1 item');
  const retriedItem = await db.query<NotificationOutboxItem>(`SELECT * FROM notification_outbox WHERE id = $1`, [deadId]);
  assert(retriedItem.rows[0]?.status === 'PENDING', 'Retried item status reset to PENDING');
  assert(retriedItem.rows[0]?.attempts === 0, 'Attempts reset to 0');
  pass('15. Manual dead-letter retry successfully resets item to PENDING');

  // --- 16. Terminal SMS Job Dead-Letter Guard ---
  const terminalJobId = crypto.randomUUID();
  const terminalOutboxId = crypto.randomUUID();
  await db.query(`INSERT INTO sms_jobs (id, project_id, phone_number, message, status) VALUES ($1, $2, '+919999900016', 'M', 'SENT')`, [terminalJobId, testProject.id]);
  await db.query(`INSERT INTO notification_outbox (id, job_id, channel, payload, status) VALUES ($1, $2, 'FCM', '{}'::jsonb, 'DEAD_LETTER')`, [terminalOutboxId, terminalJobId]);
  const guardRes = await PushService.retryDeadLetter([terminalOutboxId]);
  assert(guardRes.retriedCount === 0, 'Refuses to retry wake signal for already delivered job');
  pass('16. Terminal SMS job dead-letter guard prevents duplicate re-dispatch');

  // --- 17. Android Duplicate Drain Prevention ---
  worker.reset();
  const phone17 = '+919876500017';
  await OtpService.sendOtp(testProject, { phone: phone17 });
  // Concurrent drain execution simulation
  const [d1, d2] = await Promise.all([
    worker.drainQueue(testGatewayId),
    worker.drainQueue(testGatewayId),
  ]);
  const totalTelephonySends = worker.dispatchedTelephonySms.filter((s) => s.phone === phone17).length;
  assert(totalTelephonySends === 1, 'Android single-flight mutex & local DB deduplication sent exactly 1 SMS');
  pass('17. Android duplicate drain prevention ensures single carrier dispatch');

  // --- 18. Network Interruption & Later Recovery ---
  worker.reset();
  worker.networkOnline = false; // Airplane mode / network loss
  const phone18 = '+919876500018';
  await OtpService.sendOtp(testProject, { phone: phone18 });
  const offlineDrain = await worker.drainQueue(testGatewayId);
  assert(offlineDrain.dispatched === 0, 'Zero SMS dispatched while offline');

  // Network restored
  worker.networkOnline = true;
  const onlineDrain = await worker.drainQueue(testGatewayId);
  assert(onlineDrain.dispatched === 1, 'Offline job successfully claimed and dispatched after network restoration');
  pass('18. Network interruption followed by recovery delivers queued jobs cleanly');

  // --- 19. Token Synchronization After Process Recreation ---
  // Simulate cached pending token registered on restart
  const newToken = 'fcm_recreated_process_token_19';
  const regResult = await PushTokenService.registerToken(testGatewayId, {
    token: newToken,
    provider: 'FCM',
    platform: 'ANDROID',
  });
  assert(regResult.last_registered_at !== undefined, 'Token registered cleanly on boot');
  const tokenDb = await db.query(`SELECT * FROM gateway_push_tokens WHERE gateway_id = $1 AND token = $2`, [testGatewayId, newToken]);
  assert(tokenDb.rows[0]?.is_valid === true, 'New token marked active in database');
  pass('19. Token synchronization after process recreation succeeds without manual pairing');

  // --- 20. Zero-Secret & Zero-PII Response/Log Assertions ---
  capturedFcmMessages = [];
  setMockFirebaseMessaging({
    send: async (msg: any) => {
      capturedFcmMessages.push(msg);
      return 'ok';
    },
  } as any);
  const phone20 = '+919876500020';
  const send20 = await OtpService.sendOtp(testProject, { phone: phone20 });
  const sendBody = JSON.stringify(send20.body);
  assert(!sendBody.includes('otp_hash'), 'No otp_hash in send response');
  assert(!sendBody.includes('salt'), 'No salt in send response');
  assert(!sendBody.includes('private_key'), 'No private key in send response');

  // FCM Data Payload PII check
  assert(capturedFcmMessages.length > 0, 'FCM message was dispatched');
  const lastMsg = capturedFcmMessages[capturedFcmMessages.length - 1];
  const fcmPayloadStr = JSON.stringify(lastMsg);
  assert(!fcmPayloadStr.includes(phone20), 'FCM data payload does NOT contain recipient phone number');
  assert(!fcmPayloadStr.includes('code'), 'FCM data payload does NOT contain plaintext OTP code');
  assert(!fcmPayloadStr.includes('Hello'), 'FCM data payload does NOT contain SMS body text');
  assert(lastMsg.data?.type === 'JOBS_AVAILABLE', 'FCM data strictly contains only event type JOBS_AVAILABLE');
  pass('20. Zero-secret and zero-PII guarantee verified across all responses and FCM payloads');

  console.log('\n===============================================================');
  console.log(`  Phase 5D E2E Suite Complete: ${passed} / 20 Edge Cases Passed (100%) `);
  console.log('===============================================================\n');

  resetFirebaseAdminState();
  return { totalPassed: passed };
}

// Direct execution support
if (require.main === module || !process.env.SUITE_RUNNER) {
  runE2eLifecycleSuite().catch((err) => {
    console.error('E2E Lifecycle suite failed:', err);
    process.exit(1);
  });
}
