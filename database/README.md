# Database Migrations & Schemas

This directory holds the relational database schemas and migration scripts for the **Swift**.

## Files
- `schema.sql`: Complete DDL schema script for PostgreSQL (compatible with Supabase, Neon, or standard PostgreSQL 14+).
- `003_supabase_auth_rls.sql`: Enables RLS on the retired custom-login tables in existing installations. It preserves all records and adds no public access policies. The equivalent settings have been applied to the Swift Supabase project.

## Target Database Platforms
- **Supabase PostgreSQL** (Recommended): Free tier includes pooling via Supavisor / PgBouncer, row-level security, instant dashboard, and REST/GraphQL auto-generation.
- **Neon Serverless PostgreSQL**: Free tier with instant branching and serverless driver support.

New installations use Supabase Auth for browser login. Run the schema with a database owner account; the backend's `DATABASE_URL` must use a role authorized for server-side access. Anonymous and authenticated Data API clients receive no table access through RLS.
