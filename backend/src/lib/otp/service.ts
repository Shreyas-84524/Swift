import { createHash } from 'crypto';
import { db } from '../db/client';
import { createOtpPayload, verifyOtpHash, normalizePhoneNumber } from './generator';
import { RateLimiter } from '../rate-limit/limiter';
import { JobQueue } from '../queue/job-queue';
import { TemplateService } from '../templates/service';
import { renderTemplate } from '../templates/validator';
import { GatewaySelector } from '../push/gateway-selector';
import { PushService } from '../push/push-service';
import {
  Project,
  SendOtpRequest,
  SendOtpResponse,
  VerifyOtpRequest,
  VerifyOtpResponse,
  OtpChallenge,
} from '@/types';

export class OtpService {
  /**
   * Generates, hashes, stores challenge, and enqueues SMS job.
   */
  public static async sendOtp(
    project: Project,
    request: SendOtpRequest
  ): Promise<{ status: number; body: SendOtpResponse | { error: string; retry_after_seconds?: number } }> {
    const idempotencyKey = request.idempotency_key?.trim() || null;
    if (idempotencyKey && idempotencyKey.length > 128) {
      return { status: 400, body: { error: 'Idempotency key cannot exceed 128 characters' } };
    }

    let normalizedPhone: string;
    try {
      normalizedPhone = normalizePhoneNumber(request.phone);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Invalid phone number format';
      return { status: 400, body: { error: errorMsg } };
    }

    // 0. Idempotency Check (if key provided)
    if (idempotencyKey) {
      const existingRes = await db.query<OtpChallenge>(
        `SELECT * FROM otp_challenges
         WHERE project_id = $1 AND idempotency_key = $2 AND consumed = FALSE AND expires_at > NOW()`,
        [project.id, idempotencyKey]
      );

      if (existingRes.rows.length > 0) {
        const existing = existingRes.rows[0];
        const remainingSeconds = Math.max(
          0,
          Math.floor((new Date(existing.expires_at).getTime() - Date.now()) / 1000)
        );
        const cooldownSeconds = project.config.cooldown_seconds ?? 30;

        return {
          status: 200,
          body: {
            success: true,
            request_id: existing.id,
            expires_in: remainingSeconds,
            resend_after: cooldownSeconds,
          },
        };
      }
    }

    // 1. Rate Limiting & Cooldown Check
    const rateCheck = await RateLimiter.checkSendLimits(
      project.id,
      normalizedPhone,
      project.config
    );

    if (!rateCheck.allowed) {
      return {
        status: 429,
        body: {
          error: rateCheck.reason || 'Rate limit exceeded',
          retry_after_seconds: rateCheck.retryAfterSeconds,
        },
      };
    }

    // 2. Generate OTP and Salt
    const codeLength = request.code_length ?? project.config.otp_length ?? 6;
    const expirySeconds = request.expiry_seconds ?? project.config.expiry_seconds ?? 300;
    const cooldownSeconds = project.config.cooldown_seconds ?? 30;

    const { otp, salt, otpHash } = createOtpPayload(codeLength);
    const expiresAt = new Date(Date.now() + expirySeconds * 1000);

    // 3. Render SMS Message from authoritative project configuration or message_templates
    const defaultTemplate =
      'Hello Customer, your CivicFix OTP is {{otp}} and is valid for the next 5 minutes. Thank you for contributing to a better Mumbai. - Team Civic Sense';

    let rawTemplate: string | null = null;
    try {
      const activeOtpTemplate = await TemplateService.getActiveOtpTemplate(project.id);
      if (activeOtpTemplate && activeOtpTemplate.active_version?.body) {
        rawTemplate = activeOtpTemplate.active_version.body;
      }
    } catch (err: unknown) {
      console.error('[OtpService.sendOtp] Failed to query active OTP template:', err);
      return {
        status: 500,
        body: { error: 'Failed to retrieve message template configuration' },
      };
    }

    if (!rawTemplate) {
      rawTemplate =
        project.config.sms_template ||
        project.config.template ||
        defaultTemplate;
    }

    const expiryMinutes = Math.max(1, Math.round(expirySeconds / 60));

    if (rawTemplate.length > 500) {
      return { status: 500, body: { error: 'Configured project SMS template exceeds 500 characters' } };
    }

    const message = renderTemplate(rawTemplate, {
      otp,
      app_name: project.name,
      expiry_minutes: expiryMinutes,
    });

    // 4. Persist Challenge in DB along with SMS Job and Notification Outbox Wake
    const client = await db.getClient();
    let outboxId: string | null = null;
    let shouldDispatchPush = false;

    try {
      await client.query('BEGIN');

      const challengeInsert = `
        INSERT INTO otp_challenges (project_id, phone_number, otp_hash, salt, max_attempts, expires_at, idempotency_key, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
      `;

      const maxAttempts = project.config.max_attempts ?? 3;
      const challengeRes = await client.query<{ id: string }>(challengeInsert, [
        project.id,
        normalizedPhone,
        otpHash,
        salt,
        maxAttempts,
        expiresAt.toISOString(),
        idempotencyKey,
        JSON.stringify(request.metadata || {}),
      ]);

      const challengeId = challengeRes.rows[0].id;

      // 5. Enqueue SMS Job
      const jobRes = await client.query<{ id: string }>(
        `INSERT INTO sms_jobs (project_id, challenge_id, phone_number, message, status)
         VALUES ($1, $2, $3, $4, 'QUEUED')
         RETURNING id`,
        [project.id, challengeId, normalizedPhone, message]
      );
      const jobId = jobRes.rows[0]?.id || challengeId;

      // 6. Transactional Gateway Selection and Notification Outbox Item
      // Evaluates single-owner gateway selection rule without committing or calling network
      const selection = await GatewaySelector.selectGateway(client);
      const dedupKey = idempotencyKey
        ? `idempotency:${createHash('sha256').update(`${project.id}\0${idempotencyKey}`).digest('hex')}`
        : `otp_challenge:${challengeId}`;
      const payloadJson = JSON.stringify({ type: 'JOBS_AVAILABLE' });

      if (selection.status === 'SELECTED') {
        const outboxRes = await client.query<{ id: string }>(
          `INSERT INTO notification_outbox (
             gateway_id, job_id, channel, priority, payload, status,
             attempts, max_attempts, next_attempt_at, deduplication_key
           )
           VALUES ($1, $2, 'FCM', 'HIGH', $3, 'PENDING', 0, 5, NOW(), $4)
           RETURNING id`,
          [selection.gateway.gatewayId, jobId, payloadJson, dedupKey]
        );
        outboxId = outboxRes.rows[0]?.id || null;
        shouldDispatchPush = true;
      } else {
        // Preserves durable SMS job even when no valid push gateway exists or state is ambiguous
        const outboxRes = await client.query<{ id: string }>(
          `INSERT INTO notification_outbox (
             gateway_id, job_id, channel, priority, payload, status,
             attempts, max_attempts, next_attempt_at, response_code, error_message, deduplication_key
           )
           VALUES (NULL, $1, 'FCM', 'HIGH', $2, 'FAILED', 0, 5, NOW(), $3, $4, $5)
           RETURNING id`,
          [jobId, payloadJson, selection.reasonCode, selection.sanitizedReason, dedupKey]
        );
        outboxId = outboxRes.rows[0]?.id || null;
        shouldDispatchPush = false;
      }

      await client.query('COMMIT');

      // 7. Post-commit immediate push dispatch attempt
      // CRITICAL: Network call is strictly executed AFTER database transaction commits.
      // An FCM network failure or invalid token must NEVER rollback the OTP challenge
      // or delete/fail the durable SMS job.
      if (shouldDispatchPush && outboxId) {
        try {
          await PushService.dispatchOutboxItem(outboxId);
        } catch {
          // Push/database errors can carry request parameters in their details.
          // The durable outbox lease will be eligible for recovery after timeout.
          console.error('[OtpService.sendOtp] Immediate push wake attempt failed post-commit');
        }
      }

      // Return challenge ID (never return OTP plaintext or internal gateway state)
      return {
        status: 200,
        body: {
          success: true,
          request_id: challengeId,
          expires_in: expirySeconds,
          resend_after: cooldownSeconds,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Send OTP error:', error);
      return { status: 500, body: { error: 'Failed to create OTP challenge' } };
    } finally {
      client.release();
    }
  }

  /**
   * Verifies candidate OTP against challenge salted hash.
   */
  public static async verifyOtp(
    project: Project,
    request: VerifyOtpRequest
  ): Promise<{ status: number; body: VerifyOtpResponse }> {
    let normalizedPhone: string;
    try {
      normalizedPhone = normalizePhoneNumber(request.phone);
    } catch (err: unknown) {
      return {
        status: 400,
        body: {
          success: false,
          verified: false,
          error: {
            code: 'INVALID_PHONE',
            message: err instanceof Error ? err.message : 'Invalid phone number format',
          },
        },
      };
    }

    if (!request.request_id || !request.otp) {
      return {
        status: 400,
        body: {
          success: false,
          verified: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Both request_id and otp are required',
          },
        },
      };
    }

    const challengeRes = await db.query<OtpChallenge>(
      `SELECT * FROM otp_challenges
       WHERE id = $1 AND project_id = $2`,
      [request.request_id, project.id]
    );

    if (challengeRes.rows.length === 0) {
      return {
        status: 404,
        body: {
          success: false,
          verified: false,
          error: {
            code: 'CHALLENGE_NOT_FOUND',
            message: 'OTP challenge not found or belongs to another project',
          },
        },
      };
    }

    const challenge = challengeRes.rows[0];

    // Check phone binding
    if (challenge.phone_number !== normalizedPhone) {
      return {
        status: 400,
        body: {
          success: false,
          verified: false,
          error: {
            code: 'PHONE_MISMATCH',
            message: 'Phone number does not match challenge recipient',
          },
        },
      };
    }

    // Check if already consumed
    if (challenge.consumed) {
      return {
        status: 400,
        body: {
          success: false,
          verified: false,
          error: {
            code: 'ALREADY_CONSUMED',
            message: 'This OTP verification code has already been used',
          },
        },
      };
    }

    // Check if expired
    const isExpired = new Date(challenge.expires_at).getTime() < Date.now();
    if (isExpired) {
      return {
        status: 410,
        body: {
          success: false,
          verified: false,
          error: {
            code: 'CHALLENGE_EXPIRED',
            message: 'This OTP challenge has expired. Please request a new code.',
          },
        },
      };
    }

    // Check maximum attempts
    if (challenge.attempts >= challenge.max_attempts) {
      return {
        status: 429,
        body: {
          success: false,
          verified: false,
          error: {
            code: 'MAX_ATTEMPTS_EXCEEDED',
            message: 'Maximum verification attempts exceeded. Please request a new code.',
          },
        },
      };
    }

    // Verify Hash
    const isMatch = verifyOtpHash(request.otp, challenge.otp_hash, challenge.salt);

    if (!isMatch) {
      // Increment attempt counter atomically
      const newAttempts = challenge.attempts + 1;
      await db.query(
        `UPDATE otp_challenges SET attempts = $1 WHERE id = $2`,
        [newAttempts, challenge.id]
      );

      const attemptsRemaining = Math.max(0, challenge.max_attempts - newAttempts);
      return {
        status: 400,
        body: {
          success: false,
          verified: false,
          error: {
            code: 'INVALID_OTP',
            message: 'The OTP code entered is incorrect.',
            attempts_remaining: attemptsRemaining,
          },
        },
      };
    }

    // Mark as consumed
    await db.query(
      `UPDATE otp_challenges SET consumed = TRUE WHERE id = $1`,
      [challenge.id]
    );

    return {
      status: 200,
      body: {
        success: true,
        verified: true,
      },
    };
  }
}
