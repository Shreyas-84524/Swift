-- Swift — Phase 1 Schema Migration: Message Templates & Gateway Push Architecture
-- Migration: 004_phase1_templates_and_push.sql
-- Safe, additive, idempotent DDL for Supabase / PostgreSQL 14+

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 1. Message Templates Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS message_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(50) NOT NULL,
    template_type VARCHAR(20) NOT NULL DEFAULT 'OTP' 
        CHECK (template_type IN ('OTP', 'TRANSACTIONAL', 'MARKETING', 'NOTIFICATION')),
    description TEXT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'APPROVED', 'ACTIVE', 'ARCHIVED')),
    active_version_id UUID NULL,
    -- Optional regulatory & compliance fields (DLT, sender ID, Principal Entity ID)
    dlt_template_id VARCHAR(50) NULL,
    sender_header VARCHAR(20) NULL,
    pe_id VARCHAR(50) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_project_template_slug UNIQUE (project_id, slug)
);

-- Constraint: Exactly one ACTIVE OTP template allowed per project
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_otp_template_per_project
    ON message_templates (project_id)
    WHERE template_type = 'OTP' AND status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_message_templates_project_status
    ON message_templates (project_id, status);

CREATE INDEX IF NOT EXISTS idx_message_templates_project_type
    ON message_templates (project_id, template_type);

-- ============================================================================
-- 2. Message Template Versions Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS message_template_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    template_id UUID NOT NULL REFERENCES message_templates(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL DEFAULT 1,
    body TEXT NOT NULL,
    variables JSONB NOT NULL DEFAULT '[]'::jsonb,
    character_count INTEGER NOT NULL,
    segment_count INTEGER NOT NULL DEFAULT 1,
    encoding VARCHAR(10) NOT NULL DEFAULT 'GSM_7'
        CHECK (encoding IN ('GSM_7', 'UCS2')),
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'APPROVED', 'ACTIVE', 'ARCHIVED')),
    -- Optional version-level regulatory/audit metadata
    dlt_template_id VARCHAR(50) NULL,
    sender_header VARCHAR(20) NULL,
    pe_id VARCHAR(50) NULL,
    created_by VARCHAR(100) NULL,
    approved_by VARCHAR(100) NULL,
    approved_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at TIMESTAMPTZ NULL,
    CONSTRAINT uq_template_version UNIQUE (template_id, version_number)
);

-- Constraint: Exactly one ACTIVE version per message template
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_version_per_template
    ON message_template_versions (template_id)
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_message_template_versions_lookup
    ON message_template_versions (template_id, status);

-- Add foreign key constraint for active_version_id if not present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_message_templates_active_version'
    ) THEN
        ALTER TABLE message_templates
            ADD CONSTRAINT fk_message_templates_active_version
            FOREIGN KEY (active_version_id)
            REFERENCES message_template_versions(id)
            ON DELETE SET NULL;
    END IF;
END $$;

-- ============================================================================
-- 3. Gateway Push Tokens Table (FCM Wake Tokens)
-- ============================================================================
CREATE TABLE IF NOT EXISTS gateway_push_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gateway_id UUID NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    provider VARCHAR(20) NOT NULL DEFAULT 'FCM'
        CHECK (provider IN ('FCM', 'HMS', 'APNS')),
    platform VARCHAR(20) NOT NULL DEFAULT 'ANDROID'
        CHECK (platform IN ('ANDROID', 'IOS', 'WEB')),
    device_fingerprint VARCHAR(100) NULL,
    is_valid BOOLEAN NOT NULL DEFAULT TRUE,
    last_registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce unique token globally and single active token per provider per device
CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_push_tokens_token 
    ON gateway_push_tokens (token);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_push_tokens_gateway_provider
    ON gateway_push_tokens (gateway_id, provider)
    WHERE is_valid = TRUE;

CREATE INDEX IF NOT EXISTS idx_gateway_push_tokens_active
    ON gateway_push_tokens (gateway_id, is_valid);

-- ============================================================================
-- 4. Notification Outbox Table (Push Wake & Webhook Queue)
-- ============================================================================
CREATE TABLE IF NOT EXISTS notification_outbox (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gateway_id UUID NULL REFERENCES gateways(id) ON DELETE SET NULL,
    job_id UUID NULL REFERENCES sms_jobs(id) ON DELETE CASCADE,
    channel VARCHAR(20) NOT NULL DEFAULT 'FCM'
        CHECK (channel IN ('FCM', 'WEBHOOK', 'SYSTEM')),
    priority VARCHAR(20) NOT NULL DEFAULT 'HIGH'
        CHECK (priority IN ('HIGH', 'NORMAL')),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD_LETTER')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    last_attempt_at TIMESTAMPTZ NULL,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    response_code VARCHAR(50) NULL,
    error_message TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ NULL
);

-- Index for high-throughput transactional outbox polling
CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
    ON notification_outbox (status, next_attempt_at)
    WHERE status IN ('PENDING', 'FAILED');

CREATE INDEX IF NOT EXISTS idx_notification_outbox_job_id
    ON notification_outbox (job_id);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_gateway_id
    ON notification_outbox (gateway_id);

-- ============================================================================
-- 5. Supabase Row Level Security (RLS) Lockdown
-- ============================================================================
-- Maintain the security invariant: zero exposure to public Supabase Data API (PostgREST).
ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 6. Automated Updated_at Timestamp Trigger
-- ============================================================================
CREATE OR REPLACE FUNCTION set_updated_at_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_message_templates_updated_at ON message_templates;
CREATE TRIGGER trg_message_templates_updated_at
    BEFORE UPDATE ON message_templates
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at_timestamp();
