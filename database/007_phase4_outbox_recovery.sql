-- ============================================================================
-- Swift Migration 007: Phase 4 Outbox Recovery, Leases & Concurrency Indexes
-- ============================================================================
-- Adds record-level lease tracking and optimal partial indexes for outbox
-- worker polling, stale lease recovery, and concurrent dispatch safety.

-- 1. Add lease_expires_at column to notification_outbox idempotently
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'notification_outbox' AND column_name = 'lease_expires_at'
    ) THEN
        ALTER TABLE notification_outbox
            ADD COLUMN lease_expires_at TIMESTAMPTZ NULL;
    END IF;
END $$;

-- 2. Partial index for high-throughput polling of due outbox tasks (PENDING or retry FAILED)
CREATE INDEX IF NOT EXISTS idx_notification_outbox_due
    ON notification_outbox (priority DESC, next_attempt_at ASC, created_at ASC)
    WHERE status IN ('PENDING', 'FAILED');

-- 3. Partial index for scanning and reclaiming stale PROCESSING leases
CREATE INDEX IF NOT EXISTS idx_notification_outbox_stale_leases
    ON notification_outbox (lease_expires_at ASC)
    WHERE status = 'PROCESSING';
