import { db } from '../db/client';
import { FcmSender } from './fcm-sender';
import { PushTokenService } from './token-service';
import { GatewaySelector } from './gateway-selector';

export interface OutboxDispatchResult {
  outboxId: string;
  status: 'SENT' | 'FAILED' | 'DEAD_LETTER' | 'SKIPPED';
  responseCode: string;
  errorMessage?: string;
}

export interface OutboxBatchDispatchResult {
  claimed: number;
  sent: number;
  failed: number;
  dead_letter: number;
  skipped: number;
  duration_ms: number;
}

export class PushService {
  private static readonly BACKOFF_INTERVALS = [30, 60, 120, 240, 480];

  public static retryDelaySeconds(attempts: number): number {
    const index = Math.max(0, Math.min(attempts - 1, this.BACKOFF_INTERVALS.length - 1));
    return this.BACKOFF_INTERVALS[index];
  }

  /**
   * Atomically claims and dispatches a single outbox wake item to FCM.
   * Uses atomic state transition (`status = 'PROCESSING'`) to strictly prevent
   * concurrent duplicate dispatch across worker threads or serverless invocations.
   */
  public static async dispatchOutboxItem(outboxId: string): Promise<OutboxDispatchResult> {
    const claimRes = await db.query<{
      id: string;
      gateway_id: string | null;
      attempts: number;
      max_attempts: number;
    }>(
      `UPDATE notification_outbox
       SET status = 'PROCESSING',
           last_attempt_at = NOW(),
           lease_expires_at = NOW() + INTERVAL '2 minutes',
           attempts = attempts + 1
       WHERE id = $1
         AND (
           (status IN ('PENDING', 'FAILED') AND next_attempt_at <= NOW())
           OR
           (status = 'PROCESSING' AND (lease_expires_at <= NOW() OR (lease_expires_at IS NULL AND last_attempt_at < NOW() - INTERVAL '5 minutes')))
         )
       RETURNING id, gateway_id, attempts, max_attempts`,
      [outboxId]
    );

    if (claimRes.rows.length === 0) {
      return {
        outboxId,
        status: 'SKIPPED',
        responseCode: 'CONCURRENT_CLAIM_SKIPPED',
        errorMessage: 'Outbox record is already being processed or completed',
      };
    }

    const row = claimRes.rows[0];
    return this.processClaimedOutboxRow(row);
  }

  /**
   * Atomically claims a batch of due outbox records using FOR UPDATE SKIP LOCKED
   * and dispatches them within the provided execution time budget.
   */
  public static async claimAndDispatchBatch(
    batchSize = 20,
    maxTimeMs = 8000
  ): Promise<OutboxBatchDispatchResult> {
    const startTime = Date.now();
    const boundedLimit = Math.max(1, Math.min(batchSize, 50));

    // 1. Atomically claim batch
    const claimRes = await db.query<{
      id: string;
      gateway_id: string | null;
      attempts: number;
      max_attempts: number;
    }>(
      `WITH due_items AS (
         SELECT id
         FROM notification_outbox
         WHERE (
           (status IN ('PENDING', 'FAILED') AND next_attempt_at <= NOW())
           OR
           (status = 'PROCESSING' AND (lease_expires_at <= NOW() OR (lease_expires_at IS NULL AND last_attempt_at < NOW() - INTERVAL '5 minutes')))
         )
         ORDER BY priority DESC, next_attempt_at ASC, created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE notification_outbox
       SET status = 'PROCESSING',
           last_attempt_at = NOW(),
           lease_expires_at = NOW() + INTERVAL '2 minutes',
           attempts = attempts + 1
       FROM due_items
       WHERE notification_outbox.id = due_items.id
       RETURNING notification_outbox.id, notification_outbox.gateway_id,
                 notification_outbox.attempts, notification_outbox.max_attempts`,
      [boundedLimit]
    );

    const counts: OutboxBatchDispatchResult = {
      claimed: claimRes.rows.length,
      sent: 0,
      failed: 0,
      dead_letter: 0,
      skipped: 0,
      duration_ms: 0,
    };

    if (claimRes.rows.length === 0) {
      counts.duration_ms = Date.now() - startTime;
      return counts;
    }

    // 2. Dispatch claimed records respecting time budget
    for (let i = 0; i < claimRes.rows.length; i++) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= maxTimeMs) {
        // Time budget exceeded: release remaining claimed records back to PENDING
        const remainingIds = claimRes.rows.slice(i).map((r) => r.id);
        if (remainingIds.length > 0) {
          await db.query(
            `UPDATE notification_outbox
             SET status = 'PENDING',
                 lease_expires_at = NULL,
                 attempts = GREATEST(0, attempts - 1)
             WHERE id = ANY($1::uuid[])`,
            [remainingIds]
          );
          counts.skipped += remainingIds.length;
        }
        break;
      }

      const row = claimRes.rows[i];
      try {
        const result = await this.processClaimedOutboxRow(row);
        if (result.status === 'SENT') counts.sent++;
        else if (result.status === 'DEAD_LETTER') counts.dead_letter++;
        else if (result.status === 'FAILED') counts.failed++;
        else counts.skipped++;
      } catch {
        // Isolate one failed dispatch from the rest of the batch. Raw provider or
        // database errors are deliberately not logged because they can contain tokens.
        console.error(`Outbox item dispatch failed unexpectedly (id=${row.id})`);
        const terminal = row.attempts >= row.max_attempts;
        const backoffSeconds = this.retryDelaySeconds(row.attempts);
        await db.query(
          `UPDATE notification_outbox
           SET status = $2,
               lease_expires_at = NULL,
               response_code = 'INTERNAL_DISPATCH_ERROR',
               error_message = 'Unexpected internal wake dispatch failure',
               next_attempt_at = CASE
                 WHEN $2 = 'FAILED' THEN NOW() + ($3::text || ' seconds')::INTERVAL
                 ELSE next_attempt_at
               END
           WHERE id = $1 AND status = 'PROCESSING'`,
          [row.id, terminal ? 'DEAD_LETTER' : 'FAILED', backoffSeconds]
        );
        if (terminal) counts.dead_letter++;
        else counts.failed++;
      }
    }

    counts.duration_ms = Date.now() - startTime;
    return counts;
  }

  /**
   * Resets selected dead-lettered wake entries to PENDING for re-dispatch.
   * Safety invariant: Refuses to retry wake records for SMS jobs already in terminal states (SENT, DELIVERED, EXPIRED).
   */
  public static async retryDeadLetter(
    outboxIds: string[],
    projectId?: string
  ): Promise<{ retriedCount: number; retriedIds: string[] }> {
    if (!outboxIds || outboxIds.length === 0) {
      return { retriedCount: 0, retriedIds: [] };
    }

    const uniqueIds = Array.from(new Set(outboxIds)).slice(0, 50);
    const query = `
      UPDATE notification_outbox no
      SET status = 'PENDING',
          attempts = 0,
          next_attempt_at = NOW(),
          last_attempt_at = NULL,
          lease_expires_at = NULL,
          error_message = NULL,
          response_code = 'MANUAL_RETRY_PENDING',
          gateway_id = NULL
      FROM sms_jobs sj
      WHERE no.id = ANY($1::uuid[])
        AND no.job_id = sj.id
        AND no.status = 'DEAD_LETTER'
        AND sj.status NOT IN ('SENT', 'DELIVERED', 'EXPIRED')
        AND ($2::uuid IS NULL OR sj.project_id = $2::uuid)
      RETURNING no.id;
    `;

    const res = await db.query<{ id: string }>(query, [uniqueIds, projectId || null]);
    const retriedIds = res.rows.map((r) => r.id);
    return {
      retriedCount: retriedIds.length,
      retriedIds,
    };
  }

  /**
   * Internal processing logic for a claimed outbox record.
   */
  private static async processClaimedOutboxRow(row: {
    id: string;
    gateway_id: string | null;
    attempts: number;
    max_attempts: number;
  }): Promise<OutboxDispatchResult> {
    const outboxId = row.id;

    // 1. Gateway Resolution
    if (!row.gateway_id) {
      const selection = await GatewaySelector.selectGateway();
      if (selection.status === 'SELECTED') {
        row.gateway_id = selection.gateway.gatewayId;
        await db.query(
          `UPDATE notification_outbox SET gateway_id = $1 WHERE id = $2`,
          [selection.gateway.gatewayId, outboxId]
        );
      } else {
        if (row.attempts >= row.max_attempts) {
          await db.query(
            `UPDATE notification_outbox
             SET status = 'DEAD_LETTER',
                 lease_expires_at = NULL,
                 response_code = $2,
                 error_message = $3
             WHERE id = $1`,
            [outboxId, selection.reasonCode, selection.sanitizedReason]
          );
          return {
            outboxId,
            status: 'DEAD_LETTER',
            responseCode: selection.reasonCode,
            errorMessage: selection.sanitizedReason,
          };
        }

        const backoffSeconds = this.retryDelaySeconds(row.attempts);
        await db.query(
          `UPDATE notification_outbox
           SET status = 'FAILED',
               lease_expires_at = NULL,
               response_code = $2,
               error_message = $3,
               next_attempt_at = NOW() + ($4::text || ' seconds')::INTERVAL
           WHERE id = $1`,
          [outboxId, selection.reasonCode, selection.sanitizedReason, backoffSeconds]
        );
        return {
          outboxId,
          status: 'FAILED',
          responseCode: selection.reasonCode,
          errorMessage: selection.sanitizedReason,
        };
      }
    }

    // 2. Fetch active FCM token for target gateway
    const tokenRes = await db.query<{ token: string }>(
      `SELECT token FROM gateway_push_tokens
       WHERE gateway_id = $1 AND is_valid = TRUE AND provider = 'FCM'
       ORDER BY last_registered_at DESC
       LIMIT 1`,
      [row.gateway_id]
    );

    if (tokenRes.rows.length === 0) {
      if (row.attempts >= row.max_attempts) {
        await db.query(
          `UPDATE notification_outbox
           SET status = 'DEAD_LETTER',
               lease_expires_at = NULL,
               response_code = 'NO_VALID_GATEWAY_TOKEN',
               error_message = 'No active FCM token found for target gateway after maximum attempts'
           WHERE id = $1`,
          [outboxId]
        );
        return {
          outboxId,
          status: 'DEAD_LETTER',
          responseCode: 'NO_VALID_GATEWAY_TOKEN',
        };
      }

      const backoffSeconds = this.retryDelaySeconds(row.attempts);
      await db.query(
        `UPDATE notification_outbox
         SET status = 'FAILED',
             lease_expires_at = NULL,
             response_code = 'NO_VALID_GATEWAY_TOKEN',
             error_message = 'No active FCM token found for target gateway',
             next_attempt_at = NOW() + ($2::text || ' seconds')::INTERVAL
         WHERE id = $1`,
        [outboxId, backoffSeconds]
      );
      return {
        outboxId,
        status: 'FAILED',
        responseCode: 'NO_VALID_GATEWAY_TOKEN',
      };
    }

    const targetToken = tokenRes.rows[0].token;

    // 3. Send high-priority FCM wake signal
    const sendResult = await FcmSender.sendWakeSignal(targetToken);

    // 4. Success State
    if (sendResult.success) {
      await db.query(
        `UPDATE notification_outbox
         SET status = 'SENT',
             sent_at = NOW(),
             lease_expires_at = NULL,
             response_code = 'SENT',
             error_message = NULL
         WHERE id = $1`,
        [outboxId]
      );

      await db.query(
        `UPDATE gateway_push_tokens
         SET last_used_at = NOW()
         WHERE gateway_id = $1 AND token = $2`,
        [row.gateway_id, targetToken]
      );

      return {
        outboxId,
        status: 'SENT',
        responseCode: 'SENT',
      };
    }

    // 5. Invalid Token State
    if (sendResult.isInvalidToken) {
      await PushTokenService.invalidateGatewayTokens(row.gateway_id, targetToken);

      if (row.attempts >= row.max_attempts) {
        await db.query(
          `UPDATE notification_outbox
           SET status = 'DEAD_LETTER',
               lease_expires_at = NULL,
               response_code = $2,
               error_message = $3
           WHERE id = $1`,
          [outboxId, sendResult.responseCode, sendResult.errorMessage || 'Invalid push token']
        );
        return {
          outboxId,
          status: 'DEAD_LETTER',
          responseCode: sendResult.responseCode,
          errorMessage: sendResult.errorMessage,
        };
      }

      const backoffSeconds = this.retryDelaySeconds(row.attempts);
      await db.query(
        `UPDATE notification_outbox
         SET status = 'FAILED',
             lease_expires_at = NULL,
             response_code = $2,
             error_message = $3,
             next_attempt_at = NOW() + ($4::text || ' seconds')::INTERVAL
         WHERE id = $1`,
        [outboxId, sendResult.responseCode, sendResult.errorMessage || 'Invalid push token', backoffSeconds]
      );

      return {
        outboxId,
        status: 'FAILED',
        responseCode: sendResult.responseCode,
        errorMessage: sendResult.errorMessage,
      };
    }

    // 6. Transient Failure State
    if (sendResult.isTransient) {
      if (row.attempts >= row.max_attempts) {
        await db.query(
          `UPDATE notification_outbox
           SET status = 'DEAD_LETTER',
               lease_expires_at = NULL,
               response_code = 'MAX_ATTEMPTS_EXCEEDED',
               error_message = $2
           WHERE id = $1`,
          [outboxId, sendResult.errorMessage || 'Exceeded maximum delivery attempts']
        );

        return {
          outboxId,
          status: 'DEAD_LETTER',
          responseCode: 'MAX_ATTEMPTS_EXCEEDED',
        };
      }

      const backoffSeconds = this.retryDelaySeconds(row.attempts);
      await db.query(
        `UPDATE notification_outbox
         SET status = 'FAILED',
             lease_expires_at = NULL,
             response_code = $2,
             error_message = $3,
             next_attempt_at = NOW() + ($4::text || ' seconds')::INTERVAL
         WHERE id = $1`,
        [outboxId, sendResult.responseCode, sendResult.errorMessage, backoffSeconds]
      );

      return {
        outboxId,
        status: 'FAILED',
        responseCode: sendResult.responseCode,
        errorMessage: sendResult.errorMessage,
      };
    }

    // 7. Permanent / Config Failure
    if (row.attempts >= row.max_attempts) {
      await db.query(
        `UPDATE notification_outbox
         SET status = 'DEAD_LETTER',
             lease_expires_at = NULL,
             response_code = $2,
             error_message = $3
         WHERE id = $1`,
        [outboxId, sendResult.responseCode, sendResult.errorMessage]
      );
      return {
        outboxId,
        status: 'DEAD_LETTER',
        responseCode: sendResult.responseCode,
        errorMessage: sendResult.errorMessage,
      };
    }

    const backoffSeconds = this.retryDelaySeconds(row.attempts);
    await db.query(
      `UPDATE notification_outbox
       SET status = 'FAILED',
           lease_expires_at = NULL,
           response_code = $2,
           error_message = $3,
           next_attempt_at = NOW() + ($4::text || ' seconds')::INTERVAL
       WHERE id = $1`,
      [outboxId, sendResult.responseCode, sendResult.errorMessage, backoffSeconds]
    );

    return {
      outboxId,
      status: 'FAILED',
      responseCode: sendResult.responseCode,
      errorMessage: sendResult.errorMessage,
    };
  }
}
