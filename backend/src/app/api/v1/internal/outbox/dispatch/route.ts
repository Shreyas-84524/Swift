import { NextRequest, NextResponse } from 'next/server';
import { authenticateScheduler } from '@/lib/auth/internal';
import { PushService } from '@/lib/push/push-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handleDispatch(
  batchSize: number,
  maxTimeMs: number
): Promise<NextResponse> {
  const result = await PushService.claimAndDispatchBatch(batchSize, maxTimeMs);

  return NextResponse.json(
    {
      success: true,
      counts: {
        claimed: result.claimed,
        sent: result.sent,
        failed: result.failed,
        dead_letter: result.dead_letter,
      },
      duration_ms: result.duration_ms,
    },
    { status: 200 }
  );
}

/**
 * POST /api/v1/internal/outbox/dispatch
 * Scheduled or manual background trigger for outbox claim and dispatch.
 */
export async function POST(request: NextRequest) {
  const auth = authenticateScheduler(request);
  if (!auth.success) {
    return auth.response;
  }

  try {
    let batchSize = 25;
    let maxTimeMs = 10000;

    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        const body = (await request.json()) as { batch_size?: number; max_time_ms?: number };
        if (body.batch_size !== undefined) {
          if (!Number.isInteger(body.batch_size) || body.batch_size < 1 || body.batch_size > 50) {
            return NextResponse.json(
              { success: false, error: 'batch_size must be an integer between 1 and 50' },
              { status: 400 }
            );
          }
          batchSize = body.batch_size;
        }
        if (body.max_time_ms !== undefined) {
          if (!Number.isInteger(body.max_time_ms) || body.max_time_ms < 100 || body.max_time_ms > 30000) {
            return NextResponse.json(
              { success: false, error: 'max_time_ms must be an integer between 100 and 30000' },
              { status: 400 }
            );
          }
          maxTimeMs = body.max_time_ms;
        }
      } catch {
        return NextResponse.json(
          { success: false, error: 'Invalid JSON request body' },
          { status: 400 }
        );
      }
    }

    return await handleDispatch(batchSize, maxTimeMs);
  } catch {
    console.error('[Internal Outbox Dispatcher] Dispatch batch failed');
    return NextResponse.json(
      { success: false, error: 'Internal outbox dispatch failure' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/v1/internal/outbox/dispatch
 * Native support for Vercel Cron and standard GET-only webhook schedulers.
 * Protected by Authorization: Bearer <OUTBOX_SCHEDULER_SECRET> or <CRON_SECRET>.
 */
export async function GET(request: NextRequest) {
  const auth = authenticateScheduler(request);
  if (!auth.success) {
    return auth.response;
  }

  try {
    let batchSize = 25;
    let maxTimeMs = 10000;

    const searchParams = request.nextUrl.searchParams;
    const rawBatchSize = searchParams.get('batch_size');
    const rawMaxTimeMs = searchParams.get('max_time_ms');

    if (rawBatchSize) {
      if (!/^\d+$/.test(rawBatchSize)) {
        return NextResponse.json(
          { success: false, error: 'batch_size query parameter must be an integer between 1 and 50' },
          { status: 400 }
        );
      }
      const parsed = Number(rawBatchSize);
      if (parsed < 1 || parsed > 50) {
        return NextResponse.json(
          { success: false, error: 'batch_size query parameter must be an integer between 1 and 50' },
          { status: 400 }
        );
      }
      batchSize = parsed;
    }

    if (rawMaxTimeMs) {
      if (!/^\d+$/.test(rawMaxTimeMs)) {
        return NextResponse.json(
          { success: false, error: 'max_time_ms query parameter must be an integer between 100 and 30000' },
          { status: 400 }
        );
      }
      const parsed = Number(rawMaxTimeMs);
      if (parsed < 100 || parsed > 30000) {
        return NextResponse.json(
          { success: false, error: 'max_time_ms query parameter must be an integer between 100 and 30000' },
          { status: 400 }
        );
      }
      maxTimeMs = parsed;
    }

    return await handleDispatch(batchSize, maxTimeMs);
  } catch {
    console.error('[Internal Outbox Dispatcher] Dispatch GET batch failed');
    return NextResponse.json(
      { success: false, error: 'Internal outbox dispatch failure' },
      { status: 500 }
    );
  }
}
