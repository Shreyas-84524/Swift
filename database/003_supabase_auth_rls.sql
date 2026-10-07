-- Supabase Auth replaces the legacy browser-login tables.
-- Keep historical records, but prevent Data API access through public roles.
-- No policies are intentionally added: Swift uses server-side PostgreSQL access.
ALTER TABLE IF EXISTS public.admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.admin_login_attempts ENABLE ROW LEVEL SECURITY;
