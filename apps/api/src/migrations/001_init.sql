-- vetledger schema.
-- Runs as the OWNER role. The API connects as `vetledger_app`, which owns nothing and
-- is subject to row-level security: tenant isolation is enforced by Postgres itself,
-- so a forgotten WHERE clause in application code cannot leak another clinic's data.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------------
-- Tenancy helper: the current clinic, set per transaction with
--   SELECT set_config('app.clinic_id', $1, true)
-- NULLIF turns "unset" into NULL, and `clinic_id = NULL` matches no rows: fail closed.
CREATE FUNCTION app_clinic_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.clinic_id', true), '')::uuid $$;

CREATE TABLE clinics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinics(id),
  email          citext NOT NULL UNIQUE,
  full_name      text NOT NULL,
  role           text NOT NULL CHECK (role IN ('admin', 'vet', 'tech')),
  password_hash  text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON users (clinic_id);

-- Refresh tokens: opaque, stored as SHA-256. `family_id` groups a rotation chain so
-- that reuse of a rotated token can revoke the whole chain (token theft detection).
CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id    uuid NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  rotated_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_tokens (family_id);

CREATE TABLE owners (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  full_name   text NOT NULL,
  email       citext,
  phone       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON owners (clinic_id, full_name);

CREATE TABLE animals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  owner_id    uuid NOT NULL REFERENCES owners(id),
  name        text NOT NULL,
  species     text NOT NULL,
  breed       text,
  sex         text NOT NULL DEFAULT 'unknown' CHECK (sex IN ('male', 'female', 'unknown')),
  birth_date  date,
  weight_kg   numeric(7, 2) CHECK (weight_kg > 0),
  tag_number  text,
  version     integer NOT NULL DEFAULT 1,       -- optimistic concurrency (If-Match)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON animals (clinic_id, created_at DESC, id DESC);  -- keyset pagination
CREATE INDEX ON animals (owner_id);
CREATE INDEX animals_name_lower ON animals (clinic_id, lower(name) text_pattern_ops);

CREATE TABLE visits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  animal_id   uuid NOT NULL REFERENCES animals(id),
  vet_id      uuid NOT NULL REFERENCES users(id),
  visited_at  timestamptz NOT NULL DEFAULT now(),
  reason      text NOT NULL,
  notes       text,
  weight_kg   numeric(7, 2) CHECK (weight_kg > 0)
);
CREATE INDEX ON visits (animal_id, visited_at DESC);

CREATE TABLE products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  sku            text NOT NULL,
  name           text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('drug', 'vaccine')),
  unit           text NOT NULL,
  reorder_level  integer NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, sku)
);

-- Stock lives in batches (lot + expiry). The CHECK is the last line of defence: even a
-- buggy allocator cannot drive stock negative.
CREATE TABLE batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  product_id   uuid NOT NULL REFERENCES products(id),
  lot_number   text NOT NULL,
  expires_on   date NOT NULL,
  quantity     integer NOT NULL CHECK (quantity >= 0),
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, lot_number)
);
-- FEFO lookup: available batches of a product, earliest expiry first.
CREATE INDEX batches_fefo ON batches (product_id, expires_on, id) WHERE quantity > 0;

CREATE TABLE prescriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  animal_id      uuid NOT NULL REFERENCES animals(id),
  product_id     uuid NOT NULL REFERENCES products(id),
  quantity       integer NOT NULL CHECK (quantity > 0),
  instructions   text,
  prescribed_by  uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON prescriptions (animal_id);

-- Which batches a prescription was dispensed from: needed for product recalls.
CREATE TABLE dispense_allocations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  prescription_id  uuid REFERENCES prescriptions(id),
  vaccination_id   uuid,
  batch_id         uuid NOT NULL REFERENCES batches(id),
  quantity         integer NOT NULL CHECK (quantity > 0)
);
CREATE INDEX ON dispense_allocations (batch_id);

CREATE TABLE vaccinations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  animal_id        uuid NOT NULL REFERENCES animals(id),
  product_id       uuid NOT NULL REFERENCES products(id),
  batch_id         uuid NOT NULL REFERENCES batches(id),
  administered_at  timestamptz NOT NULL DEFAULT now(),
  administered_by  uuid NOT NULL REFERENCES users(id),
  next_due_on      date
);
CREATE INDEX ON vaccinations (animal_id, administered_at DESC);
ALTER TABLE dispense_allocations
  ADD FOREIGN KEY (vaccination_id) REFERENCES vaccinations(id);

CREATE TABLE reminders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  vaccination_id  uuid NOT NULL UNIQUE REFERENCES vaccinations(id),
  animal_id       uuid NOT NULL REFERENCES animals(id),
  due_on          date NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'queued', 'sent', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- The scheduler's hot path: pending reminders by due date.
CREATE INDEX reminders_due ON reminders (due_on) WHERE status = 'pending';

CREATE TABLE idempotency_keys (
  clinic_id     uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  key           text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash  text NOT NULL,
  status_code   integer NOT NULL,
  response      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, key)
);

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  data        jsonb NOT NULL DEFAULT '{}',
  request_id  text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (clinic_id, at DESC);

-- Append-only: rejected at the database, not just "not exposed" by the API.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- ---------------------------------------------------------------------------------
-- Row-level security on every tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['owners', 'animals', 'visits', 'products', 'batches',
    'prescriptions', 'dispense_allocations', 'vaccinations', 'reminders',
    'idempotency_keys', 'audit_log', 'users']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (clinic_id = app_clinic_id()) '
      'WITH CHECK (clinic_id = app_clinic_id())', t);
  END LOOP;
END $$;

-- Clinics: a tenant can see only itself.
ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_clinic ON clinics USING (id = app_clinic_id());

-- ---------------------------------------------------------------------------------
-- Narrow, audited escape hatches for work that happens BEFORE a tenant is known.
-- SECURITY DEFINER runs as the owner (which bypasses RLS); search_path is pinned so
-- a malicious object in another schema can't hijack them.

-- Login: look a user up by email (the clinic is unknown until we find them).
CREATE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (id uuid, clinic_id uuid, role text, full_name text, password_hash text, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, clinic_id, role, full_name, password_hash, is_active FROM users WHERE email = p_email
$$;

-- Token refresh: resolve the user behind a refresh token.
CREATE FUNCTION auth_user_by_id(p_id uuid)
RETURNS TABLE (id uuid, clinic_id uuid, role text, full_name text, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, clinic_id, role, full_name, is_active FROM users WHERE id = p_id
$$;

-- Reminder scheduler: atomically claim due reminders across ALL clinics.
-- Here SKIP LOCKED is exactly right (unlike FEFO dispensing): two scheduler instances
-- must each claim *different* rows, never wait on or double-claim the same one.
CREATE FUNCTION claim_due_reminders(p_today date, p_limit integer)
RETURNS TABLE (id uuid, clinic_id uuid, animal_id uuid, due_on date)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE reminders r SET status = 'queued'
  WHERE r.id IN (
    SELECT id FROM reminders
    WHERE status = 'pending' AND due_on <= p_today
    ORDER BY due_on
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING r.id, r.clinic_id, r.animal_id, r.due_on
$$;

-- SECURITY DEFINER functions are callable by PUBLIC by default; lock them down.
-- migrate.ts grants EXECUTE to the application role only.
REVOKE ALL ON FUNCTION auth_find_user(text), auth_user_by_id(uuid),
  claim_due_reminders(date, integer) FROM PUBLIC;
