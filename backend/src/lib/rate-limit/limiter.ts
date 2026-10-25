import { db } from '../db/client';
import { Project } from '@/types';
import { QueryResult, QueryResultRow } from 'pg';

interface QueryRunner {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  reason?: string;
  retryAfterSeconds?: number;
}

export class RateLimiter {
  /**
   * Locks the project quota first and the recipient quota second. The stable
   * ordering avoids deadlocks while making both limits exact across serverless
   * instances and across different phone numbers in the same project.
   */
  public static async acquireSendLocks(
    projectId: string,
    phone: string,
    client: QueryRunner
  ): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `rate:project:${projectId}`,
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `rate:phone:${projectId}:${phone}`,
    ]);
  }

  /**
   * Checks per-phone cooldown/hourly limits and the project-wide hourly quota.
   * The caller must invoke acquireSendLocks in the same transaction first.
   */
  public static async checkSendLimits(
    projectId: string,
    phone: string,
    projectConfig: Project['config'],
    client?: QueryRunner
  ): Promise<RateLimitCheckResult> {
    const runner = client || db;

    const cooldownSeconds = projectConfig.cooldown_seconds ?? 30;
    const hourlyLimit = projectConfig.hourly_limit ?? 5;
    const projectHourlyLimit = projectConfig.project_hourly_limit ?? 100;

    // 1. Check phone cooldown (e.g., 30s since last challenge creation)
    const cooldownResult = await runner.query<{ created_at: string }>(
      `SELECT created_at FROM otp_challenges
       WHERE project_id = $1 AND phone_number = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [projectId, phone]
    );

    if (cooldownResult.rows.length > 0) {
      const lastCreated = new Date(cooldownResult.rows[0].created_at).getTime();
      const elapsedSeconds = Math.floor((Date.now() - lastCreated) / 1000);

      if (elapsedSeconds < cooldownSeconds) {
        const retryAfter = cooldownSeconds - elapsedSeconds;
        return {
          allowed: false,
          reason: `Please wait ${retryAfter} seconds before requesting a new verification code.`,
          retryAfterSeconds: retryAfter,
        };
      }
    }

    // 2. Check phone hourly limit (e.g., max 5 challenges in the past 1 hour)
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const hourlyCountResult = await runner.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM otp_challenges
       WHERE project_id = $1 AND phone_number = $2 AND created_at >= $3`,
      [projectId, phone, oneHourAgo]
    );

    const count = parseInt(hourlyCountResult.rows[0]?.count || '0', 10);
    if (count >= hourlyLimit) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: Maximum ${hourlyLimit} OTP requests per hour for this phone number.`,
        retryAfterSeconds: 3600,
      };
    }

    // 3. Check project-wide hourly quota if configured
    if (Number.isInteger(projectHourlyLimit) && projectHourlyLimit > 0) {
      const projectHourlyResult = await runner.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM otp_challenges
         WHERE project_id = $1 AND created_at >= $2`,
        [projectId, oneHourAgo]
      );
      const projectCount = parseInt(projectHourlyResult.rows[0]?.count || '0', 10);
      if (projectCount >= projectHourlyLimit) {
        return {
          allowed: false,
          reason: `Project rate limit exceeded: Maximum ${projectHourlyLimit} OTP dispatches per hour reached.`,
          retryAfterSeconds: 3600,
        };
      }
    }

    return { allowed: true };
  }
}
