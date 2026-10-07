# Database Migrations & Schemas

This directory holds the relational database schemas and migration scripts for the **Swift**.

## Files
- `schema.sql`: Complete DDL schema script for PostgreSQL (compatible with Supabase, Neon, or standard PostgreSQL 14+).

## Target Database Platforms
- **Supabase PostgreSQL** (Recommended): Free tier includes pooling via Supavisor / PgBouncer, row-level security, instant dashboard, and REST/GraphQL auto-generation.
- **Neon Serverless PostgreSQL**: Free tier with instant branching and serverless driver support.

*Note: Database migrations and initialization will be executed in Phase 2.*
