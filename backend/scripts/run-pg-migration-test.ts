import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';

async function main() {
  console.log('===============================================================');
  console.log('  Swift — Phase 1 Disposable PostgreSQL Invariant Verification ');
  console.log('===============================================================\n');

  // Initialize fresh in-memory disposable PostgreSQL database
  const db = new PGlite();

  // Query engine version
  const versionRes = await db.query<{ version: string }>('SELECT version();');
  const pgVersion = versionRes.rows[0].version;
  console.log('PostgreSQL Engine Version:');
  console.log(`  ${pgVersion}\n`);

  const rootDir = path.resolve(__dirname, '../../');
  const schemaPath = path.join(rootDir, 'database', 'schema.sql');
  const migration004Path = path.join(rootDir, 'database', '004_phase1_templates_and_push.sql');
  const migration005Path = path.join(rootDir, 'database', '005_phase1_corrections.sql');
  const testScriptPath = path.join(rootDir, 'database', 'test_phase1_invariants.sql');

  // Provide uuid_generate_v4 fallback alias if uuid-ossp extension is missing
  await db.exec(`
    CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid AS $$
    BEGIN
      RETURN gen_random_uuid();
    END;
    $$ LANGUAGE plpgsql;
  `);

  const sanitizeForPglite = (sql: string) => {
    return sql.replace(/CREATE EXTENSION IF NOT EXISTS\s+["']uuid-ossp["'];?/gi, '-- [uuid-ossp bypassed in pglite: native gen_random_uuid in use]');
  };

  // Step 1: Base Schema
  console.log('Applying Base Schema (database/schema.sql)...');
  const schemaSql = sanitizeForPglite(fs.readFileSync(schemaPath, 'utf-8'));
  await db.exec(schemaSql);
  console.log('  ✅ Base schema applied successfully.\n');

  // Step 2: Migration 004
  console.log('Applying Migration 004 (database/004_phase1_templates_and_push.sql)...');
  const migration004Sql = sanitizeForPglite(fs.readFileSync(migration004Path, 'utf-8'));
  await db.exec(migration004Sql);
  console.log('  ✅ Migration 004 applied successfully.\n');

  // Seed legacy data that Migration 004 allowed but Migration 005 must repair.
  // This makes the runner verify the migration's own pre-flight cleanup instead
  // of repeating the cleanup statement inside the post-migration test suite.
  console.log('Seeding legacy orphaned ACTIVE-version state before Migration 005...');
  const legacyProjectId = '00000000-0000-4000-8000-000000000101';
  const legacyTemplateId = '00000000-0000-4000-8000-000000000102';
  const legacyVersionId = '00000000-0000-4000-8000-000000000103';
  await db.query(
    `INSERT INTO projects (id, name, slug) VALUES ($1, $2, $3)`,
    [legacyProjectId, 'Legacy Cleanup Test', 'legacy-cleanup-test']
  );
  await db.query(
    `INSERT INTO message_templates
       (id, project_id, name, slug, template_type, status, active_version_id)
     VALUES ($1, $2, $3, $4, 'OTP', 'APPROVED', NULL)`,
    [legacyTemplateId, legacyProjectId, 'Legacy Template', 'legacy-template']
  );
  await db.query(
    `INSERT INTO message_template_versions
       (id, template_id, version_number, body, variables, character_count, segment_count, encoding, status)
     VALUES ($1, $2, 1, 'Legacy OTP {{otp}}', '["otp"]'::jsonb, 18, 1, 'GSM_7', 'ACTIVE')`,
    [legacyVersionId, legacyTemplateId]
  );
  console.log('  ✅ Legacy inconsistent state seeded.\n');

  // Step 3: Migration 005
  console.log('Applying Migration 005 (database/005_phase1_corrections.sql)...');
  const migration005Sql = sanitizeForPglite(fs.readFileSync(migration005Path, 'utf-8'));
  await db.exec(migration005Sql);
  console.log('  ✅ Migration 005 applied successfully.\n');

  const cleanupResult = await db.query<{ status: string }>(
    `SELECT status FROM message_template_versions WHERE id = $1`,
    [legacyVersionId]
  );
  if (cleanupResult.rows[0]?.status !== 'APPROVED') {
    throw new Error(
      `Migration 005 failed to demote the legacy orphaned ACTIVE version; actual status: ${cleanupResult.rows[0]?.status ?? 'missing'}`
    );
  }
  console.log('  ✅ Migration 005 pre-flight demoted the legacy orphaned ACTIVE version.\n');

  // Remove the pre-migration fixture before the transactional suite so its
  // final zero-record assertion remains meaningful.
  await db.query(`DELETE FROM projects WHERE id = $1`, [legacyProjectId]);

  // Step 4: Execute Invariant Verification Suite
  console.log('Executing Invariant Verification Suite (database/test_phase1_invariants.sql)...');
  const testSql = fs.readFileSync(testScriptPath, 'utf-8');

  try {
    await db.exec(testSql);
    console.log('  ✅ Test 1 Passed: ACTIVE child without an ACTIVE parent pointer is rejected');
    console.log('  ✅ Test 2 Passed: DRAFT template cannot receive a non-null active_version_id');
    console.log('  ✅ Test 3 Passed: APPROVED template cannot receive a non-null active_version_id');
    console.log('  ✅ Test 4 Passed: ACTIVE parent and matching ACTIVE child succeeds');
    console.log('  ✅ Test 5 Passed: ACTIVE child without matching parent pointer correctly rejected');
    console.log('  ✅ Test 5b Passed: Demoting active version while parent points to it correctly rejected');
    console.log('  ✅ Test 6 Passed: Cross-template active_version_id pointer correctly rejected');
    console.log('  ✅ Test 7 Passed: Direct SQL archive safely cleared active_version_id and cascaded to all versions');
    console.log('  ✅ test_phase1_invariants.sql executed with 0 errors.');
  } catch (error: any) {
    console.error('  ❌ Error executing test_phase1_invariants.sql:', error);
    process.exit(1);
  }

  // Step 5: Verify Rollback Confirmation
  console.log('\nVerifying Rollback Confirmation (Zero Records Persisted):');
  const projectCount = await db.query<{ count: string }>('SELECT COUNT(*) as count FROM projects;');
  const templateCount = await db.query<{ count: string }>('SELECT COUNT(*) as count FROM message_templates;');
  const versionCount = await db.query<{ count: string }>('SELECT COUNT(*) as count FROM message_template_versions;');

  const pCount = parseInt(projectCount.rows[0].count, 10);
  const tCount = parseInt(templateCount.rows[0].count, 10);
  const vCount = parseInt(versionCount.rows[0].count, 10);

  console.log(`  Projects count in DB:                  ${pCount}`);
  console.log(`  Message templates count in DB:         ${tCount}`);
  console.log(`  Message template versions count in DB:  ${vCount}`);

  if (pCount === 0 && tCount === 0 && vCount === 0) {
    console.log('  ✅ CONFIRMED: Rollback executed cleanly. Zero test records remain.\n');
  } else {
    console.error('  ❌ FAILURE: Test records were not rolled back!');
    process.exit(1);
  }

  await db.close();
  console.log('===============================================================');
  console.log('  Phase 1 PostgreSQL Invariant Verification PASSED (100%)       ');
  console.log('===============================================================\n');
}

main().catch((err) => {
  console.error('Fatal error during PostgreSQL verification:', err);
  process.exit(1);
});
