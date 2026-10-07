import { NextRequest, NextResponse } from 'next/server';
import { isSameOrigin } from '@/lib/admin/auth';
import { getOwner, normalizeAdminEmail, ownerFromUser } from '@/lib/admin/owner';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  try {
    const owner = getOwner();
    const supabase = createSupabaseServerClient();
    if (!owner || !supabase) return NextResponse.json({ error: 'Supabase owner access is not configured' }, { status: 503 });
    const body = await request.json();
    const email = normalizeAdminEmail(body?.email);
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password || password.length > 256) return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return NextResponse.json({ error: error.status === 429 ? 'Too many attempts. Please try again later.' : 'Invalid email or password' }, { status: error.status === 429 ? 429 : 401 });
    const user = ownerFromUser(data.user);
    if (!user) {
      await supabase.auth.signOut({ scope: 'local' });
      return NextResponse.json({ error: 'This account cannot access the Swift workspace' }, { status: 403 });
    }
    return NextResponse.json({ success: true, user: { id: user.id, email: user.email, display_name: user.display_name } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof SyntaxError ? 'Invalid JSON payload' : 'Sign-in is temporarily unavailable' }, { status: error instanceof SyntaxError ? 400 : 503 });
  }
}
