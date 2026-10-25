-- Swift — Phase 1 Relational Invariants Verification Suite
-- File: database/test_phase1_invariants.sql
-- Executable against PostgreSQL 14+ / Supabase to verify all invariant requirements.
-- Uses isolated transaction with ROLLBACK so zero state is permanently written.

BEGIN;

DO $$
DECLARE
    v_proj_id UUID := gen_random_uuid();
    v_tmpl_a UUID := gen_random_uuid();
    v_tmpl_b UUID := gen_random_uuid();
    v_ver_a1 UUID := gen_random_uuid();
    v_ver_a2 UUID := gen_random_uuid();
    v_ver_b1 UUID := gen_random_uuid();
BEGIN
    RAISE NOTICE '=== Running Phase 1 PostgreSQL Invariant Verifications ===';

    -- Setup dummy project
    INSERT INTO projects (id, name, slug)
    VALUES (v_proj_id, 'Invariant Test Project', 'invariant-test');

    -- Setup template A and version A1 (both DRAFT)
    INSERT INTO message_templates (id, project_id, name, slug, template_type, status, active_version_id)
    VALUES (v_tmpl_a, v_proj_id, 'Template A', 'template-a', 'OTP', 'DRAFT', NULL);

    INSERT INTO message_template_versions (id, template_id, version_number, body, variables, character_count, segment_count, encoding, status)
    VALUES (v_ver_a1, v_tmpl_a, 1, 'Your OTP is {{otp}}', '["otp"]'::jsonb, 18, 1, 'GSM_7', 'DRAFT');

    -- Setup template B and version B1
    INSERT INTO message_templates (id, project_id, name, slug, template_type, status, active_version_id)
    VALUES (v_tmpl_b, v_proj_id, 'Template B', 'template-b', 'OTP', 'DRAFT', NULL);

    INSERT INTO message_template_versions (id, template_id, version_number, body, variables, character_count, segment_count, encoding, status)
    VALUES (v_ver_b1, v_tmpl_b, 1, 'Code is {{otp}}', '["otp"]'::jsonb, 15, 1, 'GSM_7', 'DRAFT');

    -- ------------------------------------------------------------------------
    -- Test 1: An orphaned ACTIVE child cannot be created after the migration
    -- ------------------------------------------------------------------------
    BEGIN
        UPDATE message_template_versions SET status = 'ACTIVE' WHERE id = v_ver_a1;
        SET CONSTRAINTS ALL IMMEDIATE;
        RAISE EXCEPTION 'TEST 1 FAILED: Orphaned ACTIVE child should have been rejected';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '✅ Test 1 Passed: ACTIVE child without an ACTIVE parent pointer is rejected';
    END;

    SET CONSTRAINTS ALL DEFERRED;

    -- ------------------------------------------------------------------------
    -- Test 2: DRAFT template cannot receive a non-null active_version_id
    -- ------------------------------------------------------------------------
    BEGIN
        -- Attempt to assign active_version_id to a DRAFT template
        UPDATE message_templates SET active_version_id = v_ver_a1 WHERE id = v_tmpl_a;
        SET CONSTRAINTS ALL IMMEDIATE;
        RAISE EXCEPTION 'TEST 2 FAILED: DRAFT template received non-null active_version_id without error';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '✅ Test 2 Passed: DRAFT template cannot receive a non-null active_version_id';
    END;

    -- Roll back partial mutation by re-clearing active_version_id on Template A
    UPDATE message_templates SET active_version_id = NULL WHERE id = v_tmpl_a;
    SET CONSTRAINTS ALL DEFERRED;

    -- ------------------------------------------------------------------------
    -- Test 3: APPROVED template cannot receive a non-null active_version_id
    -- ------------------------------------------------------------------------
    -- Set Template A to APPROVED with active_version_id = NULL
    UPDATE message_templates SET status = 'APPROVED', active_version_id = NULL WHERE id = v_tmpl_a;
    UPDATE message_template_versions SET status = 'APPROVED' WHERE id = v_ver_a1;
    SET CONSTRAINTS ALL IMMEDIATE;

    BEGIN
        -- Attempt to assign active_version_id to an APPROVED template
        UPDATE message_templates SET active_version_id = v_ver_a1 WHERE id = v_tmpl_a;
        SET CONSTRAINTS ALL IMMEDIATE;
        RAISE EXCEPTION 'TEST 3 FAILED: APPROVED template received non-null active_version_id without error';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '✅ Test 3 Passed: APPROVED template cannot receive a non-null active_version_id';
    END;

    UPDATE message_templates SET active_version_id = NULL WHERE id = v_tmpl_a;
    SET CONSTRAINTS ALL DEFERRED;

    -- ------------------------------------------------------------------------
    -- Test 4: ACTIVE parent and matching ACTIVE child succeeds
    -- ------------------------------------------------------------------------
    -- Atomic deferred activation
    UPDATE message_template_versions SET status = 'ACTIVE' WHERE id = v_ver_a1;
    UPDATE message_templates SET status = 'ACTIVE', active_version_id = v_ver_a1 WHERE id = v_tmpl_a;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE NOTICE '✅ Test 4 Passed: ACTIVE parent and matching ACTIVE child succeeds';

    SET CONSTRAINTS ALL DEFERRED;

    -- ------------------------------------------------------------------------
    -- Test 5: ACTIVE child without matching parent pointer fails
    -- ------------------------------------------------------------------------
    BEGIN
        -- Insert a second version for Template A and set to ACTIVE (parent still points to v_ver_a1)
        INSERT INTO message_template_versions (id, template_id, version_number, body, variables, character_count, segment_count, encoding, status)
        VALUES (v_ver_a2, v_tmpl_a, 2, 'V2 OTP is {{otp}}', '["otp"]'::jsonb, 17, 1, 'GSM_7', 'ACTIVE');
        SET CONSTRAINTS ALL IMMEDIATE;
        RAISE EXCEPTION 'TEST 5 FAILED: ACTIVE child without matching parent pointer should have failed';
    EXCEPTION WHEN check_violation OR unique_violation THEN
        RAISE NOTICE '✅ Test 5 Passed: ACTIVE child without matching parent pointer correctly rejected';
    END;

    -- Remove v_ver_a2
    DELETE FROM message_template_versions WHERE id = v_ver_a2;
    SET CONSTRAINTS ALL DEFERRED;

    -- Also verify active-version demotion while parent still points to it fails
    BEGIN
        UPDATE message_template_versions SET status = 'APPROVED' WHERE id = v_ver_a1;
        SET CONSTRAINTS ALL IMMEDIATE;
        RAISE EXCEPTION 'TEST 5b FAILED: Demoting active version while parent points to it should have failed';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '✅ Test 5b Passed: Demoting active version while parent points to it correctly rejected';
    END;

    UPDATE message_template_versions SET status = 'ACTIVE' WHERE id = v_ver_a1;
    SET CONSTRAINTS ALL DEFERRED;

    -- ------------------------------------------------------------------------
    -- Test 6: Cross-template pointer fails (FK or trigger)
    -- ------------------------------------------------------------------------
    BEGIN
        -- Attempt to set Template A active_version_id to Version B1 (belongs to Template B)
        UPDATE message_templates SET status = 'ACTIVE', active_version_id = v_ver_b1 WHERE id = v_tmpl_a;
        SET CONSTRAINTS ALL IMMEDIATE;
        RAISE EXCEPTION 'TEST 6 FAILED: Cross-template pointer should have failed';
    EXCEPTION WHEN foreign_key_violation OR check_violation THEN
        RAISE NOTICE '✅ Test 6 Passed: Cross-template active_version_id pointer correctly rejected';
    END;

    UPDATE message_templates SET active_version_id = v_ver_a1 WHERE id = v_tmpl_a;
    SET CONSTRAINTS ALL DEFERRED;

    -- ------------------------------------------------------------------------
    -- Test 7: Direct SQL Archive clears pointer and cascades to child versions
    -- ------------------------------------------------------------------------
    -- Template A is currently ACTIVE with active_version_id = v_ver_a1
    UPDATE message_templates SET status = 'ARCHIVED' WHERE id = v_tmpl_a;
    SET CONSTRAINTS ALL IMMEDIATE;

    -- Verify pointer cleared
    IF EXISTS (SELECT 1 FROM message_templates WHERE id = v_tmpl_a AND active_version_id IS NOT NULL) THEN
        RAISE EXCEPTION 'TEST 7 FAILED: Template active_version_id was not cleared to NULL on archive';
    END IF;

    -- Verify child versions cascaded to ARCHIVED
    IF EXISTS (SELECT 1 FROM message_template_versions WHERE template_id = v_tmpl_a AND status <> 'ARCHIVED') THEN
        RAISE EXCEPTION 'TEST 7 FAILED: Child versions were not cascaded to ARCHIVED';
    END IF;

    RAISE NOTICE '✅ Test 7 Passed: Direct SQL archive safely cleared active_version_id and cascaded to all versions';

    RAISE NOTICE '=== All Phase 1 Relational Invariants Verified Successfully ===';
END $$;

ROLLBACK;
