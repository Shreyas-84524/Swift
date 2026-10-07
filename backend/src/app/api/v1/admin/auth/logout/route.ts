import { NextRequest, NextResponse } from 'next/server';
import { isSameOrigin } from '@/lib/admin/auth';
import { createSupabaseServerClient } from '@/lib/supabase/server';
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  const supabase = createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase Auth is not configured' }, { status: 503 });
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) return NextResponse.json({ error: 'Sign-out failed. Please retry.' }, { status: 503 });
  const response = NextResponse.json({ success: true });
  response.cookies.set('otp_admin_session', '', { maxAge: 0, path: '/' });
  return response;
}
