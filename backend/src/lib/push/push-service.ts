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

export class PushService {
  private static readonly RETRY_BACKOFF_BASE_SECONDS = 30;
  private static readonly RETRY_BACKOFF_MAX_SECONDS = 15 * 60;

  private static retryDelaySeconds(attempts: number): number {
    const exponent = Math.max(0, attempts - 1);
    return Math.min(
      this.RETRY_BACKOFF_BASE_SECONDS * (2 ** exponent),
      this.RETRY_BACKOFF_MAX_SECONDS
    );
  }

  /**
   * Atomically claims and dispatches an outbox wake item to FCM.
   * Uses atomic state transition (`status = 'PROCESSING'`) to strictly prevent
   * concurrent duplicate dispatch across worker threads or serverless invocations.
   */
  public static async dispatchOutboxItem(outboxId: string): Promise<OutboxDispatchResult> {
    // 1. Claim only due work. A stale PROCESSING lease is reclaimable so an
    // interrupted serverless invocation cannot strand a wake forever.
    const claimRes = await db.query<{
      id: string;
      gateway_id: string | null;
      attempts: number;
      max_attempts: number;
    }>(
      `UPDATE notification_outbox
       SET status = 'PROCESSING',
           last_attempt_at = NOW(),
           attempts = attempts + 1
       WHERE id = $1
         AND (
           (status IN ('PENDING', 'FAILED') AND next_attempt_at <= NOW())
           OR
           (status = 'PROCESSING' AND last_attempt_at < NOW() - INTERVAL '5 minutes')
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

    // If no gateway assigned to outbox record, attempt to select one now
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

    // 2. Fetch active FCM token for the gateway
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

    // 3. Send high-priority FCM wake
    const sendResult = await FcmSender.sendWakeSignal(targetToken);

    // 4. Handle FCM response states
    if (sendResult.success) {
      await db.query(
        `UPDATE notification_outbox
         SET status = 'SENT',
             sent_at = NOW(),
             response_code = 'SENT',
             error_message = NULL
         WHERE id = $1`,
        [outboxId]
      );

      // Update last_used_at on the token
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

    // 5. Failure Handling
    if (sendResult.isInvalidToken) {
      // Invalidate the token immediately
      await PushTokenService.invalidateGatewayTokens(row.gateway_id, targetToken);

      if (row.attempts >= row.max_attempts) {
        await db.query(
          `UPDATE notification_outbox
           SET status = 'DEAD_LETTER',
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

    // Transient failure with retry scheduling
    if (sendResult.isTransient) {
      if (row.attempts >= row.max_attempts) {
        await db.query(
          `UPDATE notification_outbox
           SET status = 'DEAD_LETTER',
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

    // Permanent/configuration failures may be fixed operationally. Retry them
    // with the same bounded policy, then stop at the configured attempt limit.
    if (row.attempts >= row.max_attempts) {
      await db.query(
        `UPDATE notification_outbox
         SET status = 'DEAD_LETTER',
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
