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
   * Concurrency-safe at the PostgreSQL level via transactional advisory locking
   * and idempotency conflict handling.
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

    // 0. Idempotency Pre-Check (fast path)
    if (idempotencyKey) {
      const existingRes = await db.query<OtpChallenge>(
        `SELECT * FROM otp_challenges
         WHERE project_id = $1 AND idempotency_key = $2`,
        [project.id, idempotencyKey]
      );

      if (existingRes.rows.length > 0) {
        const existing = existingRes.rows[0];
        if (existing.consumed || new Date(existing.expires_at).getTime() <= Date.now()) {
          return {
            status: 409,
            body: { error: 'Idempotency key has already been consumed or expired' },
          };
        }

        if (existing.phone_number !== normalizedPhone) {
          return {
            status: 400,
            body: { error: 'Idempotency key was previously used with a different phone number' },
          };
        }

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

    // 1. Validate Expiry & Code Length Bounds
    const codeLength = request.code_length ?? project.config.otp_length ?? 6;
    if (!Number.isInteger(codeLength) || codeLength < 4 || codeLength > 10) {
      return { status: 400, body: { error: 'code_length must be between 4 and 10' } };
    }

    const expirySeconds = request.expiry_seconds ?? project.config.expiry_seconds ?? 300;
    if (!Number.isInteger(expirySeconds) || expirySeconds < 60 || expirySeconds > 1800) {
      return { status: 400, body: { error: 'expiry_seconds must be between 60 and 1800 (1 to 30 minutes)' } };
    }
    const cooldownSeconds = project.config.cooldown_seconds ?? 30;

    // Validate metadata bounds
    if (request.metadata !== undefined && request.metadata !== null) {
      if (typeof request.metadata !== 'object' || Array.isArray(request.metadata)) {
        return { status: 400, body: { error: 'metadata must be a JSON object' } };
      }
      const serialized = JSON.stringify(request.metadata);
      if (serialized.length > 2048) {
        return { status: 400, body: { error: 'metadata exceeds maximum allowed size of 2KB' } };
      }
      if (Object.keys(request.metadata).length > 10) {
        return { status: 400, body: { error: 'metadata cannot contain more than 10 keys' } };
      }
    }

    // 2. Resolve Message Template (Fail Closed in Production)
    let rawTemplate: string | null = null;
    try {
      const activeOtpTemplate = await TemplateService.getActiveOtpTemplate(project.id);
      if (activeOtpTemplate && activeOtpTemplate.active_version?.body) {
        rawTemplate = activeOtpTemplate.active_version.body;
      }
    } catch {
      console.error('[OtpService.sendOtp] Template lookup query failed');
      return {
        status: 500,
        body: { error: 'Failed to retrieve message template configuration' },
      };
    }

    if (!rawTemplate) {
      if (process.env.NODE_ENV === 'production') {
        // Fail closed: Production strictly requires an active approved template
        return {
          status: 422,
          body: { error: 'No active approved message template is configured for this project. Production requires an approved template.' },
        };
      } else {
        // Legacy project config is development-only. Production requires an
        // explicitly approved and activated template version.
        rawTemplate = project.config.sms_template || project.config.template ||
          'Your {{app_name}} verification code is {{otp}}. Valid for {{expiry_minutes}} minutes.';
      }
    }

    if (rawTemplate.length > 500) {
      return { status: 500, body: { error: 'Configured project SMS template exceeds 500 characters' } };
    }

    const { otp, salt, otpHash } = createOtpPayload(codeLength);
    const expiresAt = new Date(Date.now() + expirySeconds * 1000);
    const expiryMinutes = Math.max(1, Math.round(expirySeconds / 60));

    const message = renderTemplate(rawTemplate, {
      otp,
      app_name: project.name,
      expiry_minutes: expiryMinutes,
    });

    // 3. Transactional Challenge Creation with PostgreSQL Advisory Lock Serialization
    const client = await db.getClient();
    let outboxId: string | null = null;
    let shouldDispatchPush = false;
    let challengeId: string | null = null;

    try {
      await client.query('BEGIN');

      // Fail closed if PostgreSQL cannot acquire the transaction-level locks.
      // The project lock makes the project-wide quota exact across recipients;
      // the phone lock serializes idempotency, cooldown, and phone limits.
      await RateLimiter.acquireSendLocks(project.id, normalizedPhone, client);

      // In-transaction idempotency re-check after acquiring advisory lock
      if (idempotencyKey) {
        const existingTxRes = await client.query<OtpChallenge>(
          `SELECT * FROM otp_challenges WHERE project_id = $1 AND idempotency_key = $2`,
          [project.id, idempotencyKey]
        );
        if (existingTxRes.rows.length > 0) {
          const existing = existingTxRes.rows[0];
          if (existing.phone_number !== normalizedPhone) {
            await client.query('ROLLBACK');
            return {
              status: 400,
              body: { error: 'Idempotency key was previously used with a different phone number' },
            };
          }
          if (existing.consumed || new Date(existing.expires_at).getTime() <= Date.now()) {
            await client.query('ROLLBACK');
            return {
              status: 409,
              body: { error: 'Idempotency key has already been consumed or expired' },
            };
          }
          const remainingSeconds = Math.max(
            0,
            Math.floor((new Date(existing.expires_at).getTime() - Date.now()) / 1000)
          );
          await client.query('COMMIT');
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

      const rateCheck = await RateLimiter.checkSendLimits(
        project.id,
        normalizedPhone,
        project.config,
        client
      );

      if (!rateCheck.allowed) {
        await client.query('ROLLBACK');
        return {
          status: 429,
          body: {
            error: rateCheck.reason || 'Rate limit exceeded',
            retry_after_seconds: rateCheck.retryAfterSeconds,
          },
        };
      }

      // 4. Insert OTP Challenge
      const maxAttempts = project.config.max_attempts ?? 3;
      await client.query('SAVEPOINT sp_otp_challenge');
      try {
        const challengeRes = await client.query<{ id: string }>(
          `INSERT INTO otp_challenges (project_id, phone_number, otp_hash, salt, max_attempts, expires_at, idempotency_key, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            project.id,
            normalizedPhone,
            otpHash,
            salt,
            maxAttempts,
            expiresAt.toISOString(),
            idempotencyKey,
            JSON.stringify(request.metadata || {}),
          ]
        );
        challengeId = challengeRes.rows[0].id;
        await client.query('RELEASE SAVEPOINT sp_otp_challenge');
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT sp_otp_challenge');
        // Handle PostgreSQL unique constraint violation on idempotency_key (code 23505)
        if (err.code === '23505' && idempotencyKey && (err.message?.includes('idx_otp_challenges_idempotency') || err.constraint === 'idx_otp_challenges_idempotency')) {
          const existingRes = await client.query<OtpChallenge>(
            `SELECT * FROM otp_challenges WHERE project_id = $1 AND idempotency_key = $2`,
            [project.id, idempotencyKey]
          );
          if (existingRes.rows.length > 0) {
            const existing = existingRes.rows[0];
            if (existing.phone_number !== normalizedPhone) {
              await client.query('ROLLBACK');
              return {
                status: 400,
                body: { error: 'Idempotency key was previously used with a different phone number' },
              };
            }
            if (existing.consumed || new Date(existing.expires_at).getTime() <= Date.now()) {
              await client.query('ROLLBACK');
              return {
                status: 409,
                body: { error: 'Idempotency key has already been consumed or expired' },
              };
            }
            const remainingSeconds = Math.max(
              0,
              Math.floor((new Date(existing.expires_at).getTime() - Date.now()) / 1000)
            );
            await client.query('COMMIT');
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
        throw err;
      }

      // 5. Enqueue SMS Job
      const jobRes = await client.query<{ id: string }>(
        `INSERT INTO sms_jobs (project_id, challenge_id, phone_number, message, status)
         VALUES ($1, $2, $3, $4, 'QUEUED')
         RETURNING id`,
        [project.id, challengeId, normalizedPhone, message]
      );
      const jobId = jobRes.rows[0]?.id || challengeId;

      // 6. Transactional Gateway Selection and Notification Outbox Item
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
           ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
           RETURNING id`,
          [selection.gateway.gatewayId, jobId, payloadJson, dedupKey]
        );
        outboxId = outboxRes.rows[0]?.id || null;
        shouldDispatchPush = outboxId !== null;
      } else {
        const outboxRes = await client.query<{ id: string }>(
          `INSERT INTO notification_outbox (
             gateway_id, job_id, channel, priority, payload, status,
             attempts, max_attempts, next_attempt_at, response_code, error_message, deduplication_key
           )
           VALUES (NULL, $1, 'FCM', 'HIGH', $2, 'FAILED', 0, 5, NOW(), $3, $4, $5)
           ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
           RETURNING id`,
          [jobId, payloadJson, selection.reasonCode, selection.sanitizedReason, dedupKey]
        );
        outboxId = outboxRes.rows[0]?.id || null;
        shouldDispatchPush = false;
      }

      await client.query('COMMIT');

      // 7. Post-commit immediate push dispatch attempt (strictly after commit)
      if (shouldDispatchPush && outboxId) {
        try {
          await PushService.dispatchOutboxItem(outboxId);
        } catch {
          console.error('[OtpService.sendOtp] Post-commit push dispatch attempt failed; outbox will recover');
        }
      }

      return {
        status: 200,
        body: {
          success: true,
          request_id: challengeId!,
          expires_in: expirySeconds,
          resend_after: cooldownSeconds,
        },
      };
    } catch {
      await client.query('ROLLBACK');
      console.error('[OtpService.sendOtp] Transaction failed');
      return { status: 500, body: { error: 'Failed to create OTP challenge' } };
    } finally {
      client.release();
    }
  }

  /**
   * Verifies candidate OTP against challenge salted hash.
   * Atomic attempt decrement and consumption via PostgreSQL row lock (FOR UPDATE).
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

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // 1. Lock challenge row FOR UPDATE to prevent race conditions on verification attempts and consumption
      const challengeRes = await client.query<OtpChallenge>(
        `SELECT * FROM otp_challenges
         WHERE id = $1 AND project_id = $2
         FOR UPDATE`,
        [request.request_id, project.id]
      );

      if (challengeRes.rows.length === 0) {
        await client.query('ROLLBACK');
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

      // 2. Check phone binding
      if (challenge.phone_number !== normalizedPhone) {
        await client.query('ROLLBACK');
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

      // 3. Check if already consumed
      if (challenge.consumed) {
        await client.query('ROLLBACK');
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

      // 4. Check if expired
      const isExpired = new Date(challenge.expires_at).getTime() < Date.now();
      if (isExpired) {
        await client.query('ROLLBACK');
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

      // 5. Check maximum attempts
      if (challenge.attempts >= challenge.max_attempts) {
        await client.query('ROLLBACK');
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

      // 6. Verify Hash
      const isMatch = verifyOtpHash(request.otp, challenge.otp_hash, challenge.salt);

      if (!isMatch) {
        // Increment attempts atomically
        const newAttempts = challenge.attempts + 1;
        await client.query(
          `UPDATE otp_challenges SET attempts = $1 WHERE id = $2`,
          [newAttempts, challenge.id]
        );
        await client.query('COMMIT');

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

      // 7. Mark as consumed atomically
      await client.query(
        `UPDATE otp_challenges SET consumed = TRUE WHERE id = $1`,
        [challenge.id]
      );
      await client.query('COMMIT');

      return {
        status: 200,
        body: {
          success: true,
          verified: true,
        },
      };
    } catch {
      await client.query('ROLLBACK');
      console.error('[OtpService.verifyOtp] Verification transaction failed');
      return {
        status: 500,
        body: {
          success: false,
          verified: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Internal error verifying OTP code',
          },
        },
      };
    } finally {
      client.release();
    }
  }
}
