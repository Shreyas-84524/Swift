import { NextRequest, NextResponse } from 'next/server';
import { authenticateGateway } from '@/lib/auth/middleware';
import { JobQueue } from '@/lib/queue/job-queue';
import { JsonBodyError, readBoundedJsonObject } from '@/lib/http/json-body';
import { UpdateJobStatusRequest } from '@/types';

export const dynamic = 'force-dynamic';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_STATUSES = ['SENDING', 'SENT', 'DELIVERED', 'FAILED'] as const;

export async function POST(
  request: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const auth = await authenticateGateway(request);
  if (!auth.success) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { jobId } = params;
  if (!jobId || !UUID_REGEX.test(jobId)) {
    return NextResponse.json(
      { error: 'Invalid jobId parameter; must be a valid UUID' },
      { status: 400 }
    );
  }

  try {
    let body: UpdateJobStatusRequest;
    try {
      body = (await readBoundedJsonObject(request)) as unknown as UpdateJobStatusRequest;
    } catch (error) {
      if (error instanceof JsonBodyError) {
        return NextResponse.json({ error: error.message }, { status: error.statusCode });
      }
      throw error;
    }

    if (!body || !body.status) {
      return NextResponse.json({ error: 'Field "status" is required' }, { status: 400 });
    }

    if (!ALLOWED_STATUSES.includes(body.status as any)) {
      return NextResponse.json(
        { error: `Invalid status: "${body.status}". Allowed: ${ALLOWED_STATUSES.join(', ')}` },
        { status: 400 }
      );
    }

    let failureReason = body.error_message || body.error_code;
    if (failureReason) {
      failureReason = String(failureReason).replace(/[\0\r\n]/g, ' ').substring(0, 255);
    }

    const result = await JobQueue.updateJobStatus(
      jobId,
      auth.context.gateway.id,
      body.status,
      failureReason
    );

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      data: {
        job_id: jobId,
        updated_status: result.status,
        acknowledged_at: new Date().toISOString(),
      },
    });
  } catch {
    console.error('[API /api/v1/gateway/jobs/:id/status] Internal error');
    return NextResponse.json(
      { error: 'Internal error updating job status' },
      { status: 500 }
    );
  }
}
