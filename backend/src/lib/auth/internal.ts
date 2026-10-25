import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Dedicated internal authorization for background outbox schedulers (Vercel Cron, Supabase Cron, etc.).
 *
 * Security Requirements:
 * 1. Dedicated secret: process.env.OUTBOX_SCHEDULER_SECRET
 * 2. Header-only authorization: Authorization: Bearer <secret>
 * 3. Constant-time comparison using crypto.timingSafeEqual with SHA-256 pre-hashing
 * 4. Strict rejection if query parameters attempt to supply secrets
 * 5. Rejection with HTTP 401 on missing or invalid secret
 */

export function verifySchedulerSecret(providedToken: string, expectedSecret: string): boolean {
  if (!providedToken || !expectedSecret) return false;
  const hashProvided = crypto.createHash('sha256').update(providedToken, 'utf8').digest();
  const hashExpected = crypto.createHash('sha256').update(expectedSecret, 'utf8').digest();
  return crypto.timingSafeEqual(hashProvided, hashExpected);
}

export function authenticateScheduler(request: NextRequest): { success: true } | { success: false; response: NextResponse } {
  // 1. Strict Query Parameter Inspection: Never permit credentials in URL
  const searchParams = request.nextUrl.searchParams;
  const sensitiveParamKeys = ['secret', 'token', 'key', 'auth', 'authorization', 'scheduler_secret'];
  for (const key of sensitiveParamKeys) {
    if (searchParams.has(key)) {
      return {
        success: false,
        response: NextResponse.json(
          { success: false, error: 'Credentials must not be supplied in query parameters' },
          { status: 400 }
        ),
      };
    }
  }

  // 2. Secret Retrieval
  const expectedSecret = process.env.OUTBOX_SCHEDULER_SECRET;
  if (!expectedSecret) {
    return {
      success: false,
      response: NextResponse.json(
        { success: false, error: 'Scheduler authentication is not configured on server' },
        { status: 401 }
      ),
    };
  }

  // 3. Header Extraction
  const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      success: false,
      response: NextResponse.json(
        { success: false, error: 'Authorization header with Bearer token is required' },
        { status: 401 }
      ),
    };
  }

  const providedToken = authHeader.substring(7).trim();
  if (!verifySchedulerSecret(providedToken, expectedSecret)) {
    return {
      success: false,
      response: NextResponse.json(
        { success: false, error: 'Invalid scheduler credentials' },
        { status: 401 }
      ),
    };
  }

  return { success: true };
}
