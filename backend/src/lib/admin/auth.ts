import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '../supabase/server';
import { ownerFromUser } from './owner';

export interface AdminUser { id: string; email: string; display_name: string; enabled: boolean }

export async function getAdminFromRequest(_request: NextRequest): Promise<AdminUser | null> {
  const supabase = createSupabaseServerClient();
  if (!supabase) return null;
  // getUser verifies the session with Supabase; never trust an unverified cookie.
  const { data: { user }, error } = await supabase.auth.getUser();
  return error ? null : ownerFromUser(user);
}
export async function requireAdmin(request: NextRequest): Promise<AdminUser | NextResponse> {
  const user = await getAdminFromRequest(request);
  return user ?? NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 });
}
export function isAdminUser(value: AdminUser | NextResponse): value is AdminUser {
  return !(value instanceof NextResponse);
}
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  return !origin || origin === request.nextUrl.origin;
}
