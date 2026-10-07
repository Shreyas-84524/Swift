import assert from 'node:assert/strict';
import type { User } from '@supabase/supabase-js';
import { getOwner, normalizeAdminEmail, ownerFromUser } from '../src/lib/admin/owner';
import { getSupabaseConfig } from '../src/lib/supabase/config';
import { POST as register } from '../src/app/api/v1/admin/setup/route';

async function main() {
  process.env.SWIFT_OWNER_EMAIL='owner@example.com';
  process.env.SWIFT_OWNER_USER_ID='11111111-1111-4111-8111-111111111111';
  process.env.SUPABASE_URL='https://example.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY='sb_publishable_test';
  const user={id:process.env.SWIFT_OWNER_USER_ID,email:'owner@example.com',email_confirmed_at:new Date().toISOString(),is_anonymous:false} as User;
  assert.equal(ownerFromUser(user)?.id,user.id);
  assert.equal(normalizeAdminEmail(' OWNER@EXAMPLE.COM '),'owner@example.com');
  assert.equal(ownerFromUser({...user,id:'22222222-2222-4222-8222-222222222222'}),null);
  assert.equal(ownerFromUser({...user,email:'other@example.com'}),null);
  assert.equal(ownerFromUser({...user,is_anonymous:true}),null);
  assert.equal(ownerFromUser({...user,email_confirmed_at:undefined}),null);
  assert.equal(ownerFromUser(null),null);
  assert.equal((await register()).status,403);
  process.env.SWIFT_OWNER_USER_ID='';
  process.env.SWIFT_OWNER_PASSWORD_HASH='legacy-hash-must-not-be-used';
  assert.equal(getOwner(),null);
  assert.equal(ownerFromUser(user),null);
  assert.ok(getSupabaseConfig());
  process.env.SUPABASE_URL='http://unsafe.example';
  assert.equal(getSupabaseConfig(),null);
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  assert.equal(getSupabaseConfig(),null);
  console.log('Supabase owner authorization checks passed: immutable ID, email, confirmed account, anonymous rejection, registration disabled, and no custom-auth fallback.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
