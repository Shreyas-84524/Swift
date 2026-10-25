import { db } from '../db/client';
import { generateProjectKey, generateGatewayKey } from '../auth/keys';
import { Project, Gateway, KeyEnvironment, OutboxHealthResponse } from '@/types';

export class AdminService {
  /**
   * Creates a new client project.
   */
  public static async createProject(
    name: string,
    slug: string,
    config: Record<string, unknown> = {}
  ): Promise<Project> {
    const result = await db.query<Project>(
      `INSERT INTO projects (name, slug, config)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, slug, JSON.stringify(config)]
    );

    return result.rows[0];
  }

  public static async setProjectEnabled(projectId: string, enabled: boolean): Promise<boolean> {
    const result = await db.query(
      `UPDATE projects SET enabled = $2, updated_at = NOW() WHERE id = $1`,
      [projectId, enabled]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Generates a new Project API Key.
   * Returns plaintext key ONCE.
   */
  public static async createProjectKey(
    projectId: string,
    name = 'Primary Key',
    environment: KeyEnvironment = 'live'
  ): Promise<{ keyId: string; rawKey: string; keyPrefix: string }> {
    const { rawKey, keyPrefix, keyHash } = generateProjectKey(environment);

    const result = await db.query<{ id: string }>(
      `INSERT INTO project_api_keys (project_id, key_prefix, key_hash, name, environment, status)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
       RETURNING id`,
      [projectId, keyPrefix, keyHash, name, environment]
    );

    return {
      keyId: result.rows[0].id,
      rawKey,
      keyPrefix,
    };
  }

  /**
   * Revokes a Project API Key.
   */
  public static async revokeProjectKey(keyId: string): Promise<boolean> {
    const result = await db.query(
      `UPDATE project_api_keys
       SET status = 'REVOKED', revoked_at = NOW()
       WHERE id = $1`,
      [keyId]
    );

    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Registers a new physical Android Gateway device.
   */
  public static async registerGateway(
    name: string,
    deviceId?: string,
    model?: string
  ): Promise<Gateway> {
    const result = await db.query<Gateway>(
      `INSERT INTO gateways (name, device_id, model)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, deviceId || null, model || null]
    );

    return result.rows[0];
  }

  public static async setGatewayActive(gatewayId: string, active: boolean): Promise<boolean> {
    const result = await db.query(
      `UPDATE gateways SET is_active = $2, worker_enabled = $2 WHERE id = $1`,
      [gatewayId, active]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Generates a new Gateway API Key.
   * Returns plaintext key ONCE.
   */
  public static async createGatewayKey(
    gatewayId: string,
    name = 'Device Key'
  ): Promise<{ keyId: string; rawKey: string; keyPrefix: string }> {
    const { rawKey, keyPrefix, keyHash } = generateGatewayKey('live');

    const result = await db.query<{ id: string }>(
      `INSERT INTO gateway_api_keys (gateway_id, key_prefix, key_hash, name, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE')
       RETURNING id`,
      [gatewayId, keyPrefix, keyHash, name]
    );

    return {
      keyId: result.rows[0].id,
      rawKey,
      keyPrefix,
    };
  }

  /**
   * Revokes a Gateway API Key.
   */
  public static async revokeGatewayKey(keyId: string): Promise<boolean> {
    const result = await db.query(
      `UPDATE gateway_api_keys
       SET status = 'REVOKED', revoked_at = NOW()
       WHERE id = $1`,
      [keyId]
    );

    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Lists all projects with key counts.
   */
  public static async listProjects(): Promise<Array<Project & { key_count: number; active_keys: string[] }>> {
    const result = await db.query<Project & { key_count: string; active_prefixes: string | null }>(
      `SELECT p.*,
              COUNT(k.id) AS key_count,
              STRING_AGG(CASE WHEN k.status = 'ACTIVE' THEN k.key_prefix ELSE NULL END, ', ') AS active_prefixes
       FROM projects p
       LEFT JOIN project_api_keys k ON k.project_id = p.id
       GROUP BY p.id
       ORDER BY p.created_at DESC`
    );

    return result.rows.map((row) => ({
      ...row,
      key_count: parseInt(row.key_count as unknown as string, 10) || 0,
      active_keys: (row as any).active_prefixes ? (row as any).active_prefixes.split(', ') : [],
    }));
  }

  /**
   * Retrieves all API keys for a project (safe metadata only).
   */
  public static async getProjectKeys(
    projectId: string
  ): Promise<Array<{ id: string; key_prefix: string; name: string; environment: string; status: string; created_at: Date; revoked_at: Date | null }>> {
    const result = await db.query<{ id: string; key_prefix: string; name: string; environment: string; status: string; created_at: Date; revoked_at: Date | null }>(
      `SELECT id, key_prefix, name, environment, status, created_at, revoked_at
       FROM project_api_keys
       WHERE project_id = $1
       ORDER BY created_at DESC`,
      [projectId]
    );

    return result.rows;
  }

  /**
   * Lists all registered gateways with computed online status (last seen within 2 mins).
   */
  public static async listGateways(): Promise<Array<Gateway & { is_online: boolean; key_count: number }>> {
    const result = await db.query<Gateway & { is_online: boolean; key_count: string }>(
      `SELECT g.*,
              (g.last_seen_at IS NOT NULL AND g.last_seen_at > NOW() - INTERVAL '2 minutes') AS is_online,
              COUNT(k.id) AS key_count
       FROM gateways g
       LEFT JOIN gateway_api_keys k ON k.gateway_id = g.id
       GROUP BY g.id
       ORDER BY g.created_at DESC`
    );

    return result.rows.map((row) => ({
      ...row,
      key_count: parseInt(row.key_count as unknown as string, 10) || 0,
    }));
  }

  /**
   * Retrieves all API keys for a gateway (safe metadata only).
   */
  public static async getGatewayKeys(
    gatewayId: string
  ): Promise<Array<{ id: string; key_prefix: string; name: string; status: string; created_at: Date; revoked_at: Date | null }>> {
    const result = await db.query<{ id: string; key_prefix: string; name: string; status: string; created_at: Date; revoked_at: Date | null }>(
      `SELECT id, key_prefix, name, status, created_at, revoked_at
       FROM gateway_api_keys
       WHERE gateway_id = $1
       ORDER BY created_at DESC`,
      [gatewayId]
    );

    return result.rows;
  }

  /**
   * Gets queue metrics (queued, claimed, sent, delivered, failed counts and oldest queued job).
   */
  public static async getQueueMetrics(): Promise<{
    queued: number;
    claimed: number;
    sent: number;
    delivered: number;
    failed: number;
    oldest_queued_at: Date | null;
  }> {
    const countsRes = await db.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) AS count
       FROM sms_jobs
       GROUP BY status`
    );

    const counts: Record<string, number> = {};
    for (const row of countsRes.rows) {
      counts[row.status] = parseInt(row.count, 10) || 0;
    }

    const oldestRes = await db.query<{ created_at: Date }>(
      `SELECT created_at FROM sms_jobs
       WHERE status = 'QUEUED'
       ORDER BY created_at ASC
       LIMIT 1`
    );

    return {
      queued: counts['QUEUED'] || 0,
      claimed: counts['CLAIMED'] || 0,
      sent: counts['SENT'] || 0,
      delivered: counts['DELIVERED'] || 0,
      failed: counts['FAILED'] || 0,
      oldest_queued_at: oldestRes.rows.length > 0 ? oldestRes.rows[0].created_at : null,
    };
  }
  /**
   * Retrieves aggregated health and queue statistics for push notifications and outbox.
   * Zero sensitive data (tokens, keys, phone numbers, OTPs) included.
   */
  public static async getOutboxHealth(): Promise<OutboxHealthResponse['data']> {
    const [countsRes, oldestDueRes, lastWakeRes, tokensRes, gatewaysRes, jobsRes] = await Promise.all([
      db.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*) AS count
         FROM notification_outbox
         GROUP BY status`
      ),
      db.query<{ age_seconds: string }>(
        `SELECT EXTRACT(EPOCH FROM (NOW() - next_attempt_at)) AS age_seconds
         FROM notification_outbox
         WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at ASC
         LIMIT 1`
      ),
      db.query<{ created_at: Date; status: string; response_code: string | null; age_seconds: string }>(
        `SELECT created_at, status, response_code, EXTRACT(EPOCH FROM (NOW() - created_at)) AS age_seconds
         FROM notification_outbox
         WHERE status IN ('SENT', 'FAILED', 'DEAD_LETTER')
         ORDER BY created_at DESC
         LIMIT 1`
      ),
      db.query<{ active: string; invalid: string; gateways_with_active_token: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE is_valid = true) AS active,
           COUNT(*) FILTER (WHERE is_valid = false) AS invalid,
           COUNT(DISTINCT gateway_id) FILTER (WHERE is_valid = true) AS gateways_with_active_token
         FROM gateway_push_tokens`
      ),
      db.query<{ total_active: string; online: string; most_recent_seen_at: Date | null }>(
        `SELECT
           COUNT(*) FILTER (WHERE is_active = true) AS total_active,
           COUNT(*) FILTER (
             WHERE is_active = true
               AND last_seen_at IS NOT NULL
               AND last_seen_at > NOW() - INTERVAL '2 minutes'
           ) AS online,
           MAX(last_seen_at) AS most_recent_seen_at
         FROM gateways`
      ),
      db.query<{ queued: string; claimed: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'QUEUED') AS queued,
           COUNT(*) FILTER (WHERE status = 'CLAIMED') AS claimed
         FROM sms_jobs`
      ),
    ]);

    const outboxCounts = {
      pending: 0,
      processing: 0,
      sent: 0,
      failed: 0,
      dead_letter: 0,
    };
    for (const row of countsRes.rows) {
      const key = row.status.toLowerCase() as keyof typeof outboxCounts;
      if (key in outboxCounts) {
        outboxCounts[key] = parseInt(row.count, 10) || 0;
      }
    }

    const oldestDueAge = oldestDueRes.rows.length > 0 && oldestDueRes.rows[0].age_seconds != null
      ? Math.max(0, Math.floor(parseFloat(oldestDueRes.rows[0].age_seconds) || 0))
      : null;

    const lastWakeRow = lastWakeRes.rows[0];
    const lastWake = lastWakeRow
      ? {
          timestamp: lastWakeRow.created_at ? new Date(lastWakeRow.created_at).toISOString() : null,
          status: lastWakeRow.status,
          response_code: lastWakeRow.response_code || null,
          age_seconds: lastWakeRow.age_seconds != null
            ? Math.max(0, Math.floor(parseFloat(lastWakeRow.age_seconds) || 0))
            : null,
        }
      : null;

    const tokensRow = tokensRes.rows[0];
    const gatewaysRow = gatewaysRes.rows[0];
    const jobsRow = jobsRes.rows[0];

    return {
      outbox: {
        counts: outboxCounts,
        oldest_due_age_seconds: oldestDueAge,
        dead_letter_count: outboxCounts.dead_letter,
        last_wake: lastWake,
      },
      tokens: {
        active: parseInt(tokensRow?.active ?? '0', 10) || 0,
        invalid: parseInt(tokensRow?.invalid ?? '0', 10) || 0,
        gateways_with_active_token: parseInt(tokensRow?.gateways_with_active_token ?? '0', 10) || 0,
      },
      gateways: {
        total_active: parseInt(gatewaysRow?.total_active ?? '0', 10) || 0,
        online: parseInt(gatewaysRow?.online ?? '0', 10) || 0,
        most_recent_seen_at: gatewaysRow?.most_recent_seen_at
          ? new Date(gatewaysRow.most_recent_seen_at).toISOString()
          : null,
      },
      sms_jobs: {
        queued: parseInt(jobsRow?.queued ?? '0', 10) || 0,
        claimed: parseInt(jobsRow?.claimed ?? '0', 10) || 0,
      },
    };
  }
}
