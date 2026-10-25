import { NextRequest, NextResponse } from 'next/server';
import { authenticateGateway } from '@/lib/auth/middleware';
import { JobQueue } from '@/lib/queue/job-queue';
import { GatewayJobsResponse } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateGateway(request);
  if (!auth.success) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // Verify that gateway worker functionality is not administratively paused
  if (auth.context.gateway.worker_enabled === false) {
    return NextResponse.json(
      { error: 'Gateway worker functionality is administratively disabled' },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(request.url);
  const rawLimit = searchParams.get('limit') || '1';
  const rawLeaseSeconds = searchParams.get('lease_seconds') || '60';
  if (!/^\d+$/.test(rawLimit) || !/^\d+$/.test(rawLeaseSeconds)) {
    return NextResponse.json({ error: 'limit and lease_seconds must be integers' }, { status: 400 });
  }
  const parsedLimit = Number(rawLimit);
  const parsedLeaseSeconds = Number(rawLeaseSeconds);
  if (parsedLimit < 1 || parsedLimit > 10 || parsedLeaseSeconds < 30 || parsedLeaseSeconds > 180) {
    return NextResponse.json(
      { error: 'limit must be 1-10 and lease_seconds must be 30-180' },
      { status: 400 }
    );
  }
  const limit = parsedLimit;
  const leaseSeconds = parsedLeaseSeconds;

  try {
    const jobs = await JobQueue.claimJobs(auth.context.gateway.id, limit, leaseSeconds);

    const response: GatewayJobsResponse = {
      success: true,
      data: {
        jobs,
      },
    };

    return NextResponse.json(response, { status: 200 });
  } catch {
    console.error('[API /api/v1/gateway/jobs] Internal error');
    return NextResponse.json(
      { error: 'Internal error claiming queued jobs' },
      { status: 500 }
    );
  }
}
