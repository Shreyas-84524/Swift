-- ============================================================================
-- Swift Migration 006: Phase 2 Push Wake & Outbox Deduplication
-- ============================================================================
-- Adds deduplication support and relational uniqueness guarantees to the
-- notification outbox for transactional FCM push wake delivery.

-- 1. Add deduplication_key column to notification_outbox if not present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'notification_outbox' AND column_name = 'deduplication_key'
    ) THEN
        ALTER TABLE notification_outbox
            ADD COLUMN deduplication_key VARCHAR(128) NULL;
    END IF;
END $$;

-- 2. Enforce deduplication key uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_outbox_dedup
    ON notification_outbox (deduplication_key)
    WHERE deduplication_key IS NOT NULL;

-- 3. Enforce single notification outbox record per SMS job per channel
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_outbox_job_channel
    ON notification_outbox (job_id, channel)
    WHERE job_id IS NOT NULL;
