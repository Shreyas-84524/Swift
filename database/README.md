# Database Migrations & Schemas

This directory holds the relational database schemas and migration scripts for the **Swift**.

## Files
- `schema.sql`: Complete DDL schema script for PostgreSQL (compatible with Supabase, Neon, or standard PostgreSQL 14+).
- `003_supabase_auth_rls.sql`: Enables RLS on the retired custom-login tables in existing installations. It preserves all records and adds no public access policies. The equivalent settings have been applied to the Swift Supabase project.
- `004_phase1_templates_and_push.sql`: Phase 1 additive migration introducing `message_templates`, `message_template_versions`, `gateway_push_tokens`, and `notification_outbox` with strict RLS and unique active OTP template constraints.
- `005_phase1_corrections.sql`: Corrective migration enforcing:
  1. Idempotent pre-flight data sanitization: demotes duplicate active OTP templates and their versions to APPROVED, clears orphaned `active_version_id` pointers, and demotes every ACTIVE version that is not the deployed version of an ACTIVE parent template to APPROVED.
  2. Audit columns (`approved_by`, `approved_at`) on `message_template_versions`.
  3. Composite foreign key `(id, active_version_id) REFERENCES message_template_versions(template_id, id)` preventing cross-template pointer hijacking.
  4. Bidirectional deferred constraint triggers (`trg_enforce_template_active_version`, `trg_enforce_version_active_invariant`) enforcing strict 1:1 synchronization between active template and active version. Rejects DRAFT, APPROVED, or ARCHIVED templates containing a non-null `active_version_id`.
  5. Safe non-recursive archive triggers (`trg_before_template_archive_clear_pointer` BEFORE trigger clearing `active_version_id := NULL` + `trg_cascade_template_archive` AFTER trigger cascading `ARCHIVED` status to child versions).
- `test_phase1_invariants.sql`: Executable PostgreSQL test script verifying pre-flight orphan demotion, rejection of non-null pointers on DRAFT/APPROVED templates, cross-template pointer rejection, deferred atomic activation success, active-version demotion rejection, direct SQL archive cascading, and complete transactional rollback.

Run `npm run test:pg-invariants` from `backend/` to apply the base schema plus migrations 004 and 005 to a disposable PGlite PostgreSQL instance. The runner seeds legacy inconsistent data before Migration 005, verifies the migration repairs it, executes `test_phase1_invariants.sql`, and confirms that the transactional test suite leaves no records behind.

## Target Database Platforms
- **Supabase PostgreSQL** (Recommended): Free tier includes pooling via Supavisor / PgBouncer, row-level security, instant dashboard, and REST/GraphQL auto-generation.
- **Neon Serverless PostgreSQL**: Free tier with instant branching and serverless driver support.

New installations use Supabase Auth for browser login. Run the schema with a database owner account; the backend's `DATABASE_URL` must use a role authorized for server-side access. Anonymous and authenticated Data API clients receive no table access through RLS.
