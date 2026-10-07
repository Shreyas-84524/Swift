import { NextResponse } from 'next/server';
import { getOwner } from '@/lib/admin/owner';
import { getSupabaseConfig } from '@/lib/supabase/config';
export const dynamic = 'force-dynamic';
export async function GET() {
  return NextResponse.json({ success: true, configured: Boolean(getOwner() && getSupabaseConfig()), registration: false });
}
export async function POST() {
  return NextResponse.json({ success: false, error: 'Public account creation is disabled. The owner must be provisioned through Supabase Auth.' }, { status: 403 });
}
