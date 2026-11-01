-- One-time setup for a Neon (free tier) database. Paste into Neon's SQL Editor.
--
-- Neon's default role (neondb_owner) owns the schema and runs migrations
-- (MIGRATION_DATABASE_URL). The API connects as vetledger_app, which owns nothing and
-- is therefore subject to row-level security (DATABASE_URL).
--
-- 1. Replace CHANGE_ME with a long random password (letters and digits only keeps the
--    connection URL simple), and keep it for the DATABASE_URL.
CREATE ROLE vetledger_app LOGIN PASSWORD 'CHANGE_ME';

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Table privileges are granted by the migration runner on every deploy.
