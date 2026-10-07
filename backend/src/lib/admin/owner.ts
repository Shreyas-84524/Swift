import type { User } from '@supabase/supabase-js';

export function normalizeAdminEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function getOwner() {
  const email = normalizeAdminEmail(process.env.SWIFT_OWNER_EMAIL);
  const id = process.env.SWIFT_OWNER_USER_ID;
  if (!email || !id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return { id, email, display_name: process.env.SWIFT_OWNER_NAME?.trim() || 'Swift Owner', enabled: true };
}

/** Authorization follows a user verified by Supabase Auth, never client metadata. */
export function ownerFromUser(user: User | null) {
  const owner = getOwner();
  if (!owner || !user || user.is_anonymous || !user.email_confirmed_at) return null;
  if (user.id !== owner.id || normalizeAdminEmail(user.email) !== owner.email) return null;
  return owner;
}
