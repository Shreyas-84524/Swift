import { db } from '../db/client';
import { RegisterPushTokenRequest } from '@/types';

export class TokenValidationError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
    this.name = 'TokenValidationError';
  }
}

export class PushTokenService {
  private static readonly MIN_TOKEN_LENGTH = 10;
  private static readonly MAX_TOKEN_LENGTH = 4096;

  /**
   * Validates registration request fields.
   */
  public static validateRequest(request: RegisterPushTokenRequest): void {
    if (!request || typeof request !== 'object') {
      throw new TokenValidationError('Request body must be a valid JSON object');
    }

    if (!request.token || typeof request.token !== 'string') {
      throw new TokenValidationError('Token is required and must be a string');
    }

    const trimmed = request.token.trim();
    if (
      trimmed.length < this.MIN_TOKEN_LENGTH ||
      trimmed.length > this.MAX_TOKEN_LENGTH
    ) {
      throw new TokenValidationError(
        `Token length must be between ${this.MIN_TOKEN_LENGTH} and ${this.MAX_TOKEN_LENGTH} characters`
      );
    }

    if (request.provider !== 'FCM') {
      throw new TokenValidationError("Push provider must be 'FCM'");
    }

    if (request.platform !== 'ANDROID') {
      throw new TokenValidationError("Platform must be 'ANDROID'");
    }

    if (
      request.device_fingerprint !== undefined &&
      typeof request.device_fingerprint !== 'string'
    ) {
      throw new TokenValidationError('device_fingerprint must be a string');
    }

    if (request.device_fingerprint && request.device_fingerprint.trim().length > 100) {
      throw new TokenValidationError('device_fingerprint cannot exceed 100 characters');
    }

    if (
      request.app_version !== undefined &&
      typeof request.app_version !== 'string'
    ) {
      throw new TokenValidationError('app_version must be a string');
    }

    if (request.app_version && request.app_version.trim().length > 20) {
      throw new TokenValidationError('app_version cannot exceed 20 characters');
    }
  }

  /**
   * Registers or rotates a push token for an authenticated gateway.
   * Ensures idempotency for repeated tokens and prevents silent cross-gateway hijacking.
   */
  public static async registerToken(
    gatewayId: string,
    request: RegisterPushTokenRequest
  ): Promise<{ last_registered_at: string }> {
    this.validateRequest(request);

    const token = request.token.trim();
    const fingerprint = request.device_fingerprint?.trim() || null;
    const appVersion = request.app_version?.trim() || null;

    // Check if token already exists in database
    const existing = await db.query<{ id: string; gateway_id: string; is_valid: boolean }>(
      `SELECT id, gateway_id, is_valid FROM gateway_push_tokens WHERE token = $1`,
      [token]
    );

    if (existing.rows.length > 0) {
      const record = existing.rows[0];

      // Security check: Reject if token is assigned to a different gateway
      if (record.gateway_id !== gatewayId) {
        throw new TokenValidationError(
          'Push token is already registered to another gateway device',
          409
        );
      }

      // If token belongs to this gateway and is already active: idempotent success
      if (record.is_valid) {
        await db.query(
          `UPDATE gateway_push_tokens 
           SET last_registered_at = NOW(),
               device_fingerprint = COALESCE($2, device_fingerprint)
           WHERE id = $1`,
          [record.id, fingerprint]
        );

        if (appVersion) {
          await db.query(
            `UPDATE gateways SET app_version = $2 WHERE id = $1`,
            [gatewayId, appVersion]
          );
        }

        return { last_registered_at: new Date().toISOString() };
      }
    }

    // Transactional rotation:
    // 1. Invalidate all existing FCM tokens for this gateway
    // 2. Insert or reactivate the current token (enforcing gateway ownership atomically)
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Invalidate existing active tokens for this gateway
      await client.query(
        `UPDATE gateway_push_tokens 
         SET is_valid = FALSE 
         WHERE gateway_id = $1 AND provider = 'FCM' AND is_valid = TRUE`,
        [gatewayId]
      );

      // Insert new token or reactivate existing entry for this gateway
      // WHERE condition ensures cross-gateway conflict is rejected atomically
      const upsertRes = await client.query<{ id: string }>(
        `INSERT INTO gateway_push_tokens (
           gateway_id, token, provider, platform, device_fingerprint, is_valid, last_registered_at
         )
         VALUES ($1, $2, 'FCM', 'ANDROID', $3, TRUE, NOW())
         ON CONFLICT (token) DO UPDATE
           SET is_valid = TRUE,
               last_registered_at = NOW(),
               device_fingerprint = COALESCE(EXCLUDED.device_fingerprint, gateway_push_tokens.device_fingerprint)
           WHERE gateway_push_tokens.gateway_id = EXCLUDED.gateway_id
         RETURNING id`,
        [gatewayId, token, fingerprint]
      );

      if (upsertRes.rowCount === 0) {
        throw new TokenValidationError(
          'Push token is already registered to another gateway device',
          409
        );
      }

      if (appVersion) {
        await client.query(
          `UPDATE gateways SET app_version = $2 WHERE id = $1`,
          [gatewayId, appVersion]
        );
      }

      await client.query('COMMIT');

      return { last_registered_at: new Date().toISOString() };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof TokenValidationError) {
        throw error;
      }
      // Do not log the raw database error: unique-constraint details can contain
      // the FCM token supplied in the INSERT statement.
      console.error('[PushTokenService.registerToken] Database token rotation failed');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Invalidates active push tokens for an authenticated gateway (e.g. on logout or invalidation).
   */
  public static async invalidateGatewayTokens(
    gatewayId: string,
    specificToken?: string
  ): Promise<number> {
    if (specificToken) {
      const res = await db.query(
        `UPDATE gateway_push_tokens 
         SET is_valid = FALSE 
         WHERE gateway_id = $1 AND token = $2 AND is_valid = TRUE`,
        [gatewayId, specificToken.trim()]
      );
      return res.rowCount ?? 0;
    }

    const res = await db.query(
      `UPDATE gateway_push_tokens 
       SET is_valid = FALSE 
       WHERE gateway_id = $1 AND is_valid = TRUE`,
      [gatewayId]
    );
    return res.rowCount ?? 0;
  }
}
