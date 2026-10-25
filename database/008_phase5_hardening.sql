-- ============================================================================
-- Migration 008: Phase 5 Production Hardening & Rate-Limiting Performance
-- Description:
--   1. Adds composite index on otp_challenges (project_id, phone_number, created_at DESC)
--      for concurrency-safe, high-throughput phone cooldown and hourly rate limit checks.
--   2. Adds index on otp_challenges (project_id, created_at DESC)
--      for project-wide hourly quota enforcement.
-- Invariants:
--   - Additive and idempotent only; safe to run against production Supabase instances.
--   - Never drops or alters existing columns or foreign keys.
-- ============================================================================

-- 1. High-throughput phone rate-limiting & cooldown index
CREATE INDEX IF NOT EXISTS idx_otp_challenges_phone_created
ON otp_challenges (project_id, phone_number, created_at DESC);

-- 2. Project-level rate-limiting & quota index
CREATE INDEX IF NOT EXISTS idx_otp_challenges_project_created
ON otp_challenges (project_id, created_at DESC);
