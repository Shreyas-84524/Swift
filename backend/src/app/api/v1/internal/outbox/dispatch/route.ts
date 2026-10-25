import { NextRequest, NextResponse } from 'next/server';
import { authenticateScheduler } from '@/lib/auth/internal';
import { PushService } from '@/lib/push/push-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  } catch {
    console.error('Outbox dispatch batch failed');
    return NextResponse.json(
      { success: false, error: 'Internal outbox dispatch failure' },
      { status: 500 }
    );
  }
}
