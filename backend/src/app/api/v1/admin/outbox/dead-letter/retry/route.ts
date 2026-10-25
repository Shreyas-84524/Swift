import { NextRequest, NextResponse } from 'next/server';
import { authorizeAdminMutation, apiError, isAdminUser } from '@/lib/admin/http';
import { PushService } from '@/lib/push/push-service';
import { RetryDeadLetterRequest } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const admin = await authorizeAdminMutation(request);
  if (!isAdminUser(admin)) return admin;

  try {
    let body: RetryDeadLetterRequest;
    try {
      body = (await request.json()) as RetryDeadLetterRequest;
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON request body' },
        { status: 400 }
      );
    }

    const targetIds: string[] = [];
    if (typeof body.outbox_id === 'string' && body.outbox_id.trim().length > 0) {
      targetIds.push(body.outbox_id.trim());
    }
    if (Array.isArray(body.outbox_ids)) {
      for (const id of body.outbox_ids) {
        if (typeof id === 'string' && id.trim().length > 0 && !targetIds.includes(id.trim())) {
          targetIds.push(id.trim());
        }
      }
    }

    if (targetIds.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Provide at least one outbox_id or non-empty outbox_ids array' },
        { status: 400 }
      );
    }
    if (targetIds.length > 50) {
      return NextResponse.json(
        { success: false, error: 'A maximum of 50 outbox IDs may be retried at once' },
        { status: 400 }
      );
    }
    if (targetIds.some((id) => !UUID_PATTERN.test(id))) {
      return NextResponse.json(
        { success: false, error: 'Every outbox ID must be a valid UUID' },
        { status: 400 }
      );
    }

    const projectId = typeof body.project_id === 'string' && body.project_id.trim().length > 0
      ? body.project_id.trim()
      : undefined;
    if (projectId && !UUID_PATTERN.test(projectId)) {
      return NextResponse.json(
        { success: false, error: 'project_id must be a valid UUID' },
        { status: 400 }
      );
    }

    const result = await PushService.retryDeadLetter(targetIds, projectId);

    return NextResponse.json(
      {
        success: true,
        retried_count: result.retriedCount,
        retried_ids: result.retriedIds,
      },
      { status: 200 }
    );
  } catch (error) {
    return apiError(error, 'Could not retry dead-letter outbox records');
  }
}
