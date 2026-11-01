/**
 * Minimal, dependable migration runner: plain .sql files applied in order, each in its
 * own transaction, recorded with a checksum. An advisory lock makes concurrent deploys
 * (two instances booting at once) safe.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrationDatabaseUrl } from "./db.js";

const LOCK_ID = 7_401_337;
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(
  ownerUrl: string,
  appRole: string,
  log = console.log,
  appPassword?: string,
): Promise<string[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) throw new Error(`invalid role name ${appRole}`);
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    const files = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const body = await readFile(path.join(DIR, file), "utf8");
      const sum = createHash("sha256").update(body).digest("hex");
      const prev = done.get(file);
      if (prev) {
        if (prev !== sum) throw new Error(`migration ${file} was edited after being applied`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(body);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, sum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
      log(`applied ${file}`);
    }
    if (appPassword) await ensureAppRole(client, appRole, appPassword);
    await grantAppRole(client, appRole);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
  return applied;
}

/**
 * Create (or re-password) the runtime role. Hosted Postgres such as Neon hands you only
 * an owner role, so the non-owner role RLS depends on is provisioned here. format(%I,%L)
 * quotes the identifier and password safely.
 */
async function ensureAppRole(client: pg.Client, role: string, password: string): Promise<void> {
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  const stmt = exists.rowCount
    ? "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS q"
    : "SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS q";
  const { rows } = await client.query<{ q: string }>(stmt, [role, password]);
  const create = rows[0]?.q;
  if (!create) throw new Error("could not build the role statement");
  try {
    await client.query(create);
  } catch (err) {
    if ((err as { code?: string }).code === "42501") {
      throw new Error(
        `the migration role cannot create "${role}" (needs CREATEROLE; Neon's default owner role has it). ` +
          "Create the role manually with deploy/neon-setup.sql, or unset APP_DB_PASSWORD.",
        { cause: err },
      );
    }
    throw err;
  }
  const grant = await client.query<{ q: string }>(
    "SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text) AS q",
    [role],
  );
  const grantSql = grant.rows[0]?.q;
  if (grantSql) await client.query(grantSql);
}

/** Least privilege for the runtime role. Idempotent, so it runs on every deploy. */
async function grantAppRole(client: pg.Client, role: string): Promise<void> {
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  if (!exists.rowCount) return; // single-role setups (e.g. some free hosts) skip this
  const r = `"${role}"`;
  await client.query(`
    GRANT USAGE ON SCHEMA public TO ${r};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${r};
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ${r};
    REVOKE INSERT, UPDATE, DELETE ON clinics, schema_migrations FROM ${r};
    REVOKE UPDATE, DELETE ON users FROM ${r};
    GRANT UPDATE (full_name, role, is_active) ON users TO ${r};
    GRANT EXECUTE ON FUNCTION auth_find_user(text), auth_user_by_id(uuid),
      claim_due_reminders(date, integer) TO ${r};
  `);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = migrationDatabaseUrl(process.env);
  migrate(url, process.env.APP_DB_ROLE ?? "vetledger_app", console.log, process.env.APP_DB_PASSWORD)
    .then((a) => console.log(a.length ? `done (${a.length} applied)` : "up to date"))
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
