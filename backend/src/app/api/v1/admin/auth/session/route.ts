import { NextRequest, NextResponse } from 'next/server';
import { getAdminFromRequest } from '@/lib/admin/auth';

export async function GET(request: NextRequest) {
  const user = await getAdminFromRequest(request);
  if (!user) return NextResponse.json({ success: false, authenticated: false }, { status: 401 });
  return NextResponse.json({
    success: true,
    authenticated: true,
    user: { id: user.id, email: user.email, display_name: user.display_name },
  });
}
