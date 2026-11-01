import { Kysely, PostgresDialect, sql, type Generated, type Transaction, type ColumnType } from "kysely";
import pg from "pg";

// Return DATE columns as 'YYYY-MM-DD' strings and NUMERIC as numbers: JS Date for a
// calendar date invites off-by-one timezone bugs, and our numerics are small (weights).
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Uuid = Generated<string>;
type TenantId = ColumnType<string, string | undefined, never>;

export interface DB {
  clinics: { id: Uuid; name: string; slug: string; created_at: Timestamp };
  users: {
    id: Uuid; clinic_id: TenantId; email: string; full_name: string; role: "admin" | "vet" | "tech";
    password_hash: string; is_active: Generated<boolean>; created_at: Timestamp;
  };
  refresh_tokens: {
    id: Uuid; user_id: string; family_id: string; token_hash: Buffer; expires_at: Timestamp;
    rotated_at: Date | null; revoked_at: Date | null; created_at: Timestamp;
  };
  owners: {
    id: Uuid; clinic_id: TenantId; full_name: string; email: string | null; phone: string | null;
    created_at: Timestamp;
  };
  animals: {
    id: Uuid; clinic_id: TenantId; owner_id: string; name: string; species: string;
    breed: string | null; sex: Generated<string>; birth_date: string | null; weight_kg: number | null;
    tag_number: string | null; version: Generated<number>; created_at: Timestamp; updated_at: Timestamp;
  };
  visits: {
    id: Uuid; clinic_id: TenantId; animal_id: string; vet_id: string; visited_at: Timestamp;
    reason: string; notes: string | null; weight_kg: number | null;
  };
  products: {
    id: Uuid; clinic_id: TenantId; sku: string; name: string; kind: "drug" | "vaccine"; unit: string;
    reorder_level: Generated<number>; created_at: Timestamp;
  };
  batches: {
    id: Uuid; clinic_id: TenantId; product_id: string; lot_number: string; expires_on: string;
    quantity: number; received_at: Timestamp;
  };
  prescriptions: {
    id: Uuid; clinic_id: TenantId; animal_id: string; product_id: string; quantity: number;
    instructions: string | null; prescribed_by: string; created_at: Timestamp;
  };
  dispense_allocations: {
    id: Uuid; clinic_id: TenantId; prescription_id: string | null; vaccination_id: string | null;
    batch_id: string; quantity: number;
  };
  vaccinations: {
    id: Uuid; clinic_id: TenantId; animal_id: string; product_id: string; batch_id: string;
    administered_at: Timestamp; administered_by: string; next_due_on: string | null;
  };
  reminders: {
    id: Uuid; clinic_id: TenantId; vaccination_id: string; animal_id: string; due_on: string;
    status: Generated<"pending" | "queued" | "sent" | "failed">; attempts: Generated<number>;
    last_error: string | null; sent_at: Date | null; created_at: Timestamp;
  };
  idempotency_keys: {
    clinic_id: TenantId; key: string; request_hash: string; status_code: number; response: unknown;
    created_at: Timestamp;
  };
  audit_log: {
    id: Generated<number>; clinic_id: TenantId; actor_id: string | null; action: string;
    entity: string; entity_id: string | null; data: unknown; request_id: string | null; at: Timestamp;
  };
}

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;

export function createDb(
  connectionString: string,
  max = 10,
  onQuery?: (sql: string) => void,
): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString,
    max,
    // Fail fast instead of piling up requests when the database is unreachable.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
  });
  return {
    db: new Kysely<DB>({
      dialect: new PostgresDialect({ pool }),
      // Hook used by tests to count round trips (e.g. proving DataLoader prevents N+1).
      ...(onQuery && { log: (e) => { if (e.level === "query") onQuery(e.query.sql); } }),
    }),
    pool,
  };
}

/**
 * Run `fn` in a transaction scoped to one clinic. `set_config(..., true)` is
 * transaction-local (like SET LOCAL), so the setting can never leak to the next request
 * that reuses this pooled connection. Every tenant query MUST go through here; RLS
 * returns zero rows for anything that doesn't.
 */
export async function withTenant<T>(db: Db, clinicId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`SELECT set_config('app.clinic_id', ${clinicId}, true)`.execute(tx);
    return fn(tx);
  });
}
