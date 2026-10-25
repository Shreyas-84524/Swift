import { NextRequest, NextResponse } from 'next/server';
import { AdminService } from '@/lib/admin/service';
import { isAdminUser, requireAdmin } from '@/lib/admin/auth';
import { apiError } from '@/lib/admin/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!isAdminUser(admin)) return admin;

  try {
    const healthData = await AdminService.getOutboxHealth();

    return NextResponse.json(
      {
        success: true,
        timestamp: new Date().toISOString(),
        data: healthData,
      },
      { status: 200 }
    );
  } catch (error) {
    return apiError(error, 'Could not retrieve outbox health');
  }
}
