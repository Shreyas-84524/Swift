import { db } from '../db/client';
import { PoolClient } from 'pg';

export interface SelectedPushGateway {
  gatewayId: string;
  gatewayName: string;
  tokenId: string;
  token: string;
  platform: string;
}

export type GatewaySelectionResult =
  | {
      status: 'SELECTED';
      gateway: SelectedPushGateway;
    }
  | {
      status: 'NO_VALID_TOKEN';
      reasonCode: 'NO_VALID_GATEWAY_TOKEN';
      sanitizedReason: string;
    }
  | {
      status: 'AMBIGUOUS';
      reasonCode: 'AMBIGUOUS_GATEWAY_SELECTION';
      sanitizedReason: string;
    };

/**
 * Deterministic Gateway Selection Rule (Phase 2):
 * 1. An eligible gateway MUST have is_active = TRUE and worker_enabled = TRUE.
 * 2. It MUST have an active, valid push token (provider = 'FCM', platform = 'ANDROID', is_valid = TRUE).
 * 3. Single-Owner Invariant:
 *    - If exactly 1 enabled gateway with a valid FCM token is found, it is SELECTED.
 *    - If 0 gateways match, return NO_VALID_TOKEN. The SMS job is preserved and claimed by polling.
 *    - If > 1 distinct enabled gateways have active FCM tokens, return AMBIGUOUS. Push wake
 *      is suppressed to prevent duplicate SMS dispatch across physical devices, and the SMS job
 *      is safely claimed by the first gateway to poll via atomic row leasing.
 */
export class GatewaySelector {
  public static async selectGateway(client?: PoolClient): Promise<GatewaySelectionResult> {
    const query = `
      SELECT g.id AS gateway_id, g.name AS gateway_name, g.created_at,
             t.id AS token_id, t.token, t.platform, t.last_registered_at
      FROM gateways g
      JOIN gateway_push_tokens t ON t.gateway_id = g.id
      WHERE g.is_active = TRUE
        AND g.worker_enabled = TRUE
        AND t.is_valid = TRUE
        AND t.provider = 'FCM'
        AND t.platform = 'ANDROID'
      ORDER BY t.last_registered_at DESC, g.created_at ASC
    `;

    const result = client
      ? await client.query<{
          gateway_id: string;
          gateway_name: string;
          token_id: string;
          token: string;
          platform: string;
          last_registered_at: string;
        }>(query)
      : await db.query<{
          gateway_id: string;
          gateway_name: string;
          token_id: string;
          token: string;
          platform: string;
          last_registered_at: string;
        }>(query);

    // Group by distinct gateway_id to inspect all active gateways with push tokens
    const distinctGateways = new Map<string, typeof result.rows[0]>();
    for (const row of result.rows) {
      if (!distinctGateways.has(row.gateway_id)) {
        distinctGateways.set(row.gateway_id, row);
      }
    }

    if (distinctGateways.size === 0) {
      return {
        status: 'NO_VALID_TOKEN',
        reasonCode: 'NO_VALID_GATEWAY_TOKEN',
        sanitizedReason: 'No active gateway with a valid FCM push token is registered',
      };
    }

    if (distinctGateways.size > 1) {
      return {
        status: 'AMBIGUOUS',
        reasonCode: 'AMBIGUOUS_GATEWAY_SELECTION',
        sanitizedReason: 'Multiple active gateways registered; push wake suppressed to prevent duplicate delivery',
      };
    }

    const selected = Array.from(distinctGateways.values())[0];
    return {
      status: 'SELECTED',
      gateway: {
        gatewayId: selected.gateway_id,
        gatewayName: selected.gateway_name,
        tokenId: selected.token_id,
        token: selected.token,
        platform: selected.platform || 'ANDROID',
      },
    };
  }
}
