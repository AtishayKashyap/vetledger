/**
 * Hosted-Postgres wiring (Neon): env-var resolution, provisioning the non-owner app
 * role, and the startup guard that refuses a role which would bypass row-level security.
 */
import { afterAll, describe, expect, it } from "vitest";
import { checkRlsEnforced, createDb, migrationDatabaseUrl, runtimeDatabaseUrl, withTenant } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { TEST_ENV } from "./env.js";

const ROLE = "vl_wiring_test_role";
const PASSWORD = "wiring-test-password-0123456789";
const owner = createDb(TEST_ENV.MIGRATION_DATABASE_URL, 2);

afterAll(async () => {
  await owner.pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE}`).catch(() => undefined);
  await owner.pool.query(`REVOKE ALL ON SCHEMA public FROM ${ROLE}`).catch(() => undefined);
  await owner.pool.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${ROLE}`).catch(() => undefined);
  await owner.pool.query(`REVOKE CONNECT ON DATABASE vetledger_test FROM ${ROLE}`).catch(() => undefined);
  await owner.pool.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
  await owner.db.destroy();
});

describe("connection string resolution", () => {
  it("prefers the explicit migration URL, then Neon's unpooled URL, then DATABASE_URL", () => {
    expect(migrationDatabaseUrl({ MIGRATION_DATABASE_URL: "m", DATABASE_URL_UNPOOLED: "u", DATABASE_URL: "d" })).toBe("m");
    expect(migrationDatabaseUrl({ DATABASE_URL_UNPOOLED: "u", DATABASE_URL: "d" })).toBe("u");
    expect(migrationDatabaseUrl({ DATABASE_URL: "d" })).toBe("d");
    expect(() => migrationDatabaseUrl({})).toThrow(/DATABASE_URL/);
  });

  it("keeps Neon's pooled host but swaps in the app role's credentials", () => {
    const neon = "postgresql://neondb_owner:secret@ep-x-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
    const url = new URL(runtimeDatabaseUrl(neon, "vetledger_app", "p@ss/word with space"));
    expect(url.username).toBe("vetledger_app");
    expect(decodeURIComponent(url.password)).toBe("p@ss/word with space");
    expect(url.host).toBe("ep-x-pooler.ap-southeast-1.aws.neon.tech");
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(runtimeDatabaseUrl(neon, "vetledger_app")).toBe(neon); // no password: unchanged
  });
});

describe("app role provisioning + RLS guard", () => {
  it("migrations create the non-owner role idempotently, and only it enforces RLS", async () => {
    await migrate(TEST_ENV.MIGRATION_DATABASE_URL, ROLE, () => undefined, PASSWORD);
    await migrate(TEST_ENV.MIGRATION_DATABASE_URL, ROLE, () => undefined, PASSWORD); // re-run: ALTER, not error

    const appUrl = runtimeDatabaseUrl(TEST_ENV.MIGRATION_DATABASE_URL, ROLE, PASSWORD);
    const app = createDb(appUrl, 2);
    try {
      const report = await checkRlsEnforced(app.db);
      expect(report).toMatchObject({ role: ROLE, superuser: false, bypassRls: false, ownsTenantTables: false, enforced: true });
      // Tenant scope + statement timeout are transaction-local (pooler-safe).
      const rows = await withTenant(app.db, "00000000-0000-4000-8000-000000000000", async (tx) => {
        const { rows: t } = await tx.executeQuery<{ timeout: string }>({ sql: "SELECT current_setting('statement_timeout') AS timeout", parameters: [], query: { kind: "RawNode" } as never, queryId: { queryId: "t" } });
        return t;
      });
      expect(rows[0]!.timeout).toBe("10s");
      const after = await app.pool.query("SELECT current_setting('statement_timeout') AS t");
      expect(after.rows[0].t).not.toBe("10s"); // did not leak past the transaction
    } finally {
      await app.db.destroy();
    }

    const ownerReport = await checkRlsEnforced(owner.db);
    expect(ownerReport.enforced).toBe(false); // owner (or superuser) bypasses RLS -> guard refuses
  });
});
