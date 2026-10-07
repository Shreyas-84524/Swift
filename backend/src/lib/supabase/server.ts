import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { authCookieOptions, getSupabaseConfig } from './config';

export function createSupabaseServerClient() {
  const config = getSupabaseConfig();
  if (!config) return null;
  const cookieStore = cookies();
  return createServerClient(config.url, config.key, {
    cookieOptions: authCookieOptions,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (values) => { values.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); },
    },
  });
}
