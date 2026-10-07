-- Global OTP Platform Database Schema (PostgreSQL)
-- Version: 1.0.0

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Projects Table
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(50) UNIQUE NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Project API Keys Table
CREATE TABLE IF NOT EXISTS project_api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key_prefix VARCHAR(20) NOT NULL,
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL DEFAULT 'Default Key',
    environment VARCHAR(20) NOT NULL DEFAULT 'live',
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ NULL
);

-- 3. Gateways Table
CREATE TABLE IF NOT EXISTS gateways (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    device_id VARCHAR(100) UNIQUE NULL,
    model VARCHAR(100) NULL,
    android_sdk INTEGER NULL,
    app_version VARCHAR(20) NULL,
    sim_status VARCHAR(20) DEFAULT 'UNKNOWN',
    battery_pct INTEGER DEFAULT NULL,
    worker_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_seen_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Gateway API Keys Table
CREATE TABLE IF NOT EXISTS gateway_api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gateway_id UUID NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
    key_prefix VARCHAR(20) NOT NULL,
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL DEFAULT 'Primary Device Key',
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ NULL
);

-- 5. Browser login uses a single server-configured owner.
-- Store only the login-attempt audit/rate-limit records in PostgreSQL.
CREATE TABLE IF NOT EXISTS admin_login_attempts (
    id BIGSERIAL PRIMARY KEY,
    identity_hash VARCHAR(64) NOT NULL,
    succeeded BOOLEAN NOT NULL DEFAULT FALSE,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. OTP Challenges Table
CREATE TABLE IF NOT EXISTS otp_challenges (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    phone_number VARCHAR(20) NOT NULL,
    otp_hash VARCHAR(64) NOT NULL,
    salt VARCHAR(32) NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed BOOLEAN NOT NULL DEFAULT FALSE,
    idempotency_key VARCHAR(128) NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. SMS Jobs Table
CREATE TABLE IF NOT EXISTS sms_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    challenge_id UUID NULL REFERENCES otp_challenges(id) ON DELETE SET NULL,
    assigned_gateway_id UUID NULL REFERENCES gateways(id) ON DELETE SET NULL,
    phone_number VARCHAR(20) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TIMESTAMPTZ NULL,
    failure_reason TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    picked_up_at TIMESTAMPTZ NULL,
    sent_at TIMESTAMPTZ NULL,
    delivered_at TIMESTAMPTZ NULL,
    failed_at TIMESTAMPTZ NULL
);

-- Indexes for optimal performance
CREATE INDEX IF NOT EXISTS idx_sms_jobs_queued ON sms_jobs (status, created_at) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS idx_sms_jobs_stale_claims ON sms_jobs (status, lease_expires_at) WHERE status = 'CLAIMED';
CREATE INDEX IF NOT EXISTS idx_project_api_keys_hash ON project_api_keys (key_hash, status);
CREATE INDEX IF NOT EXISTS idx_gateway_api_keys_hash ON gateway_api_keys (key_hash, status);
CREATE INDEX IF NOT EXISTS idx_otp_challenges_verify ON otp_challenges (id, consumed, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_otp_challenges_idempotency ON otp_challenges (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_jobs_phone ON sms_jobs (phone_number, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_recent ON admin_login_attempts (identity_hash, attempted_at DESC);

