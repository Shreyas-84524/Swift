-- Swift — Phase 1 Schema Corrective Migration
-- Migration: 005_phase1_corrections.sql
-- Safe, additive, idempotent DDL for Supabase / PostgreSQL 14+
-- Strengthens relational invariants for message templates, version ownership, and tenant isolation.

-- ============================================================================
-- 1. Idempotent Pre-flight Data Sanitization
-- ============================================================================
DO $$
BEGIN
    -- 1.1 Demote duplicate active OTP templates per project (keep newest)
    -- Demote their versions to APPROVED and clear active_version_id
    WITH ranked_otp AS (
        SELECT id, project_id,
               ROW_NUMBER() OVER (
                   PARTITION BY project_id 
                   ORDER BY updated_at DESC, created_at DESC
               ) AS rn
        FROM message_templates
        WHERE template_type = 'OTP' AND status = 'ACTIVE'
    ),
    demoted_templates AS (
        SELECT id FROM ranked_otp WHERE rn > 1
    )
    UPDATE message_template_versions v
    SET status = 'APPROVED'
    FROM demoted_templates d
    WHERE v.template_id = d.id AND v.status = 'ACTIVE';

    WITH ranked_otp AS (
        SELECT id, project_id,
               ROW_NUMBER() OVER (
                   PARTITION BY project_id 
                   ORDER BY updated_at DESC, created_at DESC
               ) AS rn
        FROM message_templates
        WHERE template_type = 'OTP' AND status = 'ACTIVE'
    )
    UPDATE message_templates t
    SET status = 'APPROVED',
        active_version_id = NULL,
        updated_at = NOW()
    FROM ranked_otp r
    WHERE t.id = r.id AND r.rn > 1;

    -- 1.2 Demote duplicate active versions per template (keep newest)
    WITH ranked_versions AS (
        SELECT id, template_id,
               ROW_NUMBER() OVER (
                   PARTITION BY template_id 
                   ORDER BY activated_at DESC NULLS LAST, created_at DESC, version_number DESC
               ) AS rn
        FROM message_template_versions
        WHERE status = 'ACTIVE'
    )
    UPDATE message_template_versions v
    SET status = 'APPROVED'
    FROM ranked_versions r
    WHERE v.id = r.id AND r.rn > 1;

    -- 1.3 Nullify any active_version_id referencing a version belonging to another template
    UPDATE message_templates t
    SET active_version_id = NULL,
        status = CASE WHEN t.status = 'ACTIVE' THEN 'DRAFT' ELSE t.status END,
        updated_at = NOW()
    WHERE active_version_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM message_template_versions v
          WHERE v.id = t.active_version_id AND v.template_id = t.id
      );

    -- 1.4 If an ACTIVE template has no active version, align or demote to DRAFT
    UPDATE message_templates t
    SET status = 'DRAFT', updated_at = NOW()
    WHERE t.status = 'ACTIVE'
      AND (
          t.active_version_id IS NULL
          OR NOT EXISTS (
              SELECT 1 FROM message_template_versions v
              WHERE v.id = t.active_version_id AND v.status = 'ACTIVE'
          )
      );

    -- 1.5 Clear active_version_id on any template that is NOT ACTIVE
    UPDATE message_templates
    SET active_version_id = NULL, updated_at = NOW()
    WHERE status <> 'ACTIVE' AND active_version_id IS NOT NULL;

    -- 1.6 Demote every ACTIVE version that is not the deployed version of an ACTIVE parent template
    -- A message_template_version may have status ACTIVE if and only if:
    --   1) its parent template has status ACTIVE, and
    --   2) its parent template's active_version_id equals that version's ID.
    -- Existing orphaned ACTIVE versions are changed to APPROVED.
    -- Covers:
    --   - non-ACTIVE parent with ACTIVE child
    --   - ACTIVE parent whose pointer references a different version
    --   - ACTIVE parent demoted during duplicate-template cleanup
    --   - duplicate ACTIVE versions where the retained version is not the parent pointer
    UPDATE message_template_versions v
    SET status = 'APPROVED'
    WHERE v.status = 'ACTIVE'
      AND NOT EXISTS (
          SELECT 1 
          FROM message_templates t
          WHERE t.id = v.template_id 
            AND t.status = 'ACTIVE' 
            AND t.active_version_id = v.id
      );
END $$;

-- ============================================================================
-- 2. Audit Columns
-- ============================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'message_template_versions' AND column_name = 'approved_by'
    ) THEN
        ALTER TABLE message_template_versions ADD COLUMN approved_by VARCHAR(100);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'message_template_versions' AND column_name = 'approved_at'
    ) THEN
        ALTER TABLE message_template_versions ADD COLUMN approved_at TIMESTAMPTZ;
    END IF;
END $$;

-- ============================================================================
-- 3. Partial Unique Indexes: Single Active OTP & Single Active Version
-- ============================================================================
-- Exactly one ACTIVE OTP template allowed per project
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_otp_template_per_project
    ON message_templates (project_id)
    WHERE template_type = 'OTP' AND status = 'ACTIVE';

-- Exactly one ACTIVE version allowed per message template
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_version_per_template
    ON message_template_versions (template_id)
    WHERE status = 'ACTIVE';

-- ============================================================================
-- 4. Composite Foreign Key for Template Version Ownership
-- ============================================================================
-- 4.1 Unique constraint on (template_id, id) in message_template_versions
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'uq_message_template_versions_template_id_id'
    ) THEN
        ALTER TABLE message_template_versions
            ADD CONSTRAINT uq_message_template_versions_template_id_id 
            UNIQUE (template_id, id);
    END IF;
END $$;

-- 4.2 Composite FK: message_templates (id, active_version_id) -> message_template_versions (template_id, id)
-- MATCH SIMPLE permits active_version_id to be NULL for DRAFT/APPROVED/ARCHIVED templates.
-- DEFERRABLE INITIALLY DEFERRED enables multi-step activation transactions.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'fk_message_templates_active_version_ownership'
    ) THEN
        ALTER TABLE message_templates
            ADD CONSTRAINT fk_message_templates_active_version_ownership
            FOREIGN KEY (id, active_version_id)
            REFERENCES message_template_versions(template_id, id)
            ON DELETE NO ACTION
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
END $$;

-- ============================================================================
-- 5. Constraint Triggers: Bidirectional Status Invariant & Cross-Table State Integrity
-- ============================================================================
-- 5.1 Enforce parent template active invariants
CREATE OR REPLACE FUNCTION fn_check_template_active_version_invariant()
RETURNS TRIGGER AS $$
DECLARE
    v_curr RECORD;
    v_ver RECORD;
BEGIN
    SELECT status, active_version_id, name INTO v_curr FROM message_templates WHERE id = NEW.id;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- 1. If active_version_id IS NULL, template status must not be ACTIVE.
    IF v_curr.active_version_id IS NULL THEN
        IF v_curr.status = 'ACTIVE' THEN
            RAISE EXCEPTION 'Template "%" (%) cannot have status ACTIVE while active_version_id is NULL',
                v_curr.name, NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    -- 2. If active_version_id IS NOT NULL:
    -- Template status must be ACTIVE (reject DRAFT, APPROVED or ARCHIVED templates with non-null pointer)
    IF v_curr.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Template "%" (%) cannot have active_version_id % while in status "%" (only ACTIVE templates may specify an active_version_id)',
            v_curr.name, NEW.id, v_curr.active_version_id, v_curr.status
            USING ERRCODE = 'check_violation';
    END IF;

    -- 3. Verify referenced version existence and ownership
    SELECT id, template_id, status INTO v_ver
    FROM message_template_versions
    WHERE id = v_curr.active_version_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Template "%" (%) references non-existent active_version_id %',
            v_curr.name, NEW.id, v_curr.active_version_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_ver.template_id <> NEW.id THEN
        RAISE EXCEPTION 'active_version_id % belongs to template %, not template %',
            v_curr.active_version_id, v_ver.template_id, NEW.id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- 4. Referenced version must have status ACTIVE
    IF v_ver.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Template "%" (%) cannot be ACTIVE while active version % has status "%" (expected ACTIVE)',
            v_curr.name, NEW.id, v_curr.active_version_id, v_ver.status
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_template_active_version ON message_templates;
CREATE CONSTRAINT TRIGGER trg_enforce_template_active_version
    AFTER INSERT OR UPDATE ON message_templates
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION fn_check_template_active_version_invariant();

-- 5.2 Enforce version active invariants (bidirectional)
CREATE OR REPLACE FUNCTION fn_check_template_version_active_invariant()
RETURNS TRIGGER AS $$
DECLARE
    v_tmpl RECORD;
    v_curr_status VARCHAR;
BEGIN
    -- Check current state of this version at constraint evaluation time
    SELECT status INTO v_curr_status FROM message_template_versions WHERE id = NEW.id;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- Condition A: When a version is currently ACTIVE, parent template MUST exist, be ACTIVE, and point to it
    IF v_curr_status = 'ACTIVE' THEN
        SELECT id, name, status, active_version_id INTO v_tmpl
        FROM message_templates
        WHERE id = NEW.template_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Version % references non-existent parent template %',
                NEW.id, NEW.template_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        IF v_tmpl.status <> 'ACTIVE' OR v_tmpl.active_version_id IS NULL OR v_tmpl.active_version_id <> NEW.id THEN
            RAISE EXCEPTION 'Version % cannot have status ACTIVE unless parent template "%" (%) is ACTIVE and points to it via active_version_id',
                NEW.id, v_tmpl.name, v_tmpl.id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- Condition B: When an ACTIVE version is demoted or transferred, parent must no longer be ACTIVE pointing to it
    IF (TG_OP = 'UPDATE' AND OLD.status = 'ACTIVE' AND v_curr_status <> 'ACTIVE') THEN
        SELECT id, name, status, active_version_id INTO v_tmpl
        FROM message_templates
        WHERE id = OLD.template_id;

        IF FOUND AND v_tmpl.status = 'ACTIVE' AND v_tmpl.active_version_id = OLD.id THEN
            RAISE EXCEPTION 'Cannot demote active version % while parent template "%" (%) is currently ACTIVE and pointing to it',
                OLD.id, v_tmpl.name, v_tmpl.id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_version_active_invariant ON message_template_versions;
CREATE CONSTRAINT TRIGGER trg_enforce_version_active_invariant
    AFTER INSERT OR UPDATE ON message_template_versions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION fn_check_template_version_active_invariant();

-- ============================================================================
-- 6. Safe Non-Recursive Archive Triggers (BEFORE pointer clear + AFTER child archival)
-- ============================================================================
-- 6.1 BEFORE UPDATE: Clear active_version_id to NULL before template is stored as ARCHIVED
CREATE OR REPLACE FUNCTION fn_before_template_archive_clear_pointer()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'ARCHIVED' THEN
        NEW.active_version_id := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_before_template_archive_clear_pointer ON message_templates;
CREATE TRIGGER trg_before_template_archive_clear_pointer
    BEFORE UPDATE OF status ON message_templates
    FOR EACH ROW
    WHEN (NEW.status = 'ARCHIVED')
    EXECUTE FUNCTION fn_before_template_archive_clear_pointer();

-- 6.2 AFTER UPDATE: Cascade ARCHIVED status to all non-archived versions
CREATE OR REPLACE FUNCTION fn_cascade_template_archive()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE message_template_versions
    SET status = 'ARCHIVED'
    WHERE template_id = NEW.id
      AND status <> 'ARCHIVED';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cascade_template_archive ON message_templates;
CREATE TRIGGER trg_cascade_template_archive
    AFTER UPDATE OF status ON message_templates
    FOR EACH ROW
    WHEN (NEW.status = 'ARCHIVED')
    EXECUTE FUNCTION fn_cascade_template_archive();

-- ============================================================================
-- 7. Row Level Security Lockdown
-- ============================================================================
ALTER TABLE IF EXISTS message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS message_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS gateway_push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS notification_outbox ENABLE ROW LEVEL SECURITY;
