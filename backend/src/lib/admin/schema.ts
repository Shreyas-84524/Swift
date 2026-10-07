import { db } from '../db/client';
let schemaReady = false;
export async function ensureAdminSchema(): Promise<void> {
  if (schemaReady) return;
  // Legacy admin_users rows are never read or accepted by owner authentication.
  await db.query(`CREATE TABLE IF NOT EXISTS admin_login_attempts (
    id BIGSERIAL PRIMARY KEY,
    identity_hash VARCHAR(64) NOT NULL,
    succeeded BOOLEAN NOT NULL DEFAULT FALSE,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_recent ON admin_login_attempts (identity_hash, attempted_at DESC)`);
  schemaReady = true;
}
