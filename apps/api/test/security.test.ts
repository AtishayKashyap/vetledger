import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/db.js";
import { bearer, createHarness, type Harness } from "./harness.js";

let h: Harness;
let sunrise: string;
let deccan: string;
let sunriseAnimal: { id: string; ownerId: string };

beforeAll(async () => {
  h = await createHarness();
  sunrise = await h.login("admin@sunrise.vet");
  deccan = await h.login("admin@deccan.vet");
  sunriseAnimal = (await request(h.app).get("/api/animals?limit=1").set(bearer(sunrise))).body.items[0];
});
afterAll(() => h.close());

describe("row-level security (tenant isolation enforced by Postgres)", () => {
  it("another clinic's animal is invisible: 404, not 403 (don't confirm it exists)", async () => {
    await request(h.app).get(`/api/animals/${sunriseAnimal.id}`).set(bearer(sunrise)).expect(200);
    await request(h.app).get(`/api/animals/${sunriseAnimal.id}`).set(bearer(deccan)).expect(404);
  });

  it("cannot attach an animal to another clinic's owner", async () => {
    const res = await request(h.app).post("/api/animals").set(bearer(deccan))
      .send({ ownerId: sunriseAnimal.ownerId, name: "Intruder", species: "dog" });
    expect(res.status).toBe(422);
  });

  it("a query with a FORGOTTEN tenant filter still only sees its own clinic", async () => {
    const clinics = await h.owner.selectFrom("clinics").select(["id", "slug"]).execute();
    const total = await h.owner.selectFrom("animals").select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow();
    for (const c of clinics) {
      // Deliberately no WHERE clinic_id = ... : RLS is the only thing scoping this.
      const rows = await withTenant(h.db, c.id, (tx) => tx.selectFrom("animals").select("clinic_id").execute());
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(total.n);
      expect(new Set(rows.map((r) => r.clinic_id))).toEqual(new Set([c.id]));
    }
  });

  it("with no tenant set, the app role sees nothing (fails closed)", async () => {
    const rows = await h.db.selectFrom("animals").selectAll().execute();
    expect(rows).toEqual([]);
  });

  it("writes are checked too: cannot insert a row for another clinic", async () => {
    const [a, b] = await h.owner.selectFrom("clinics").select("id").execute();
    await expect(
      withTenant(h.db, a!.id, (tx) => tx.insertInto("owners").values({ clinic_id: b!.id, full_name: "x" } as never).execute()),
    ).rejects.toThrow(/row-level security/);
  });

  it("audit_log is append-only at the database level", async () => {
    const [c] = await h.owner.selectFrom("clinics").select("id").execute();
    await expect(withTenant(h.db, c!.id, (tx) => tx.updateTable("audit_log").set({ action: "tampered" }).execute()))
      .rejects.toThrow(/permission denied/);
    // Even the owner (which has UPDATE) is stopped by the trigger.
    await expect(h.owner.deleteFrom("audit_log").execute()).rejects.toThrow(/append-only/);
  });
});

describe("authentication", () => {
  it("same error for unknown email and wrong password (no user enumeration)", async () => {
    const a = await request(h.app).post("/api/auth/login").send({ email: "nobody@x.vet", password: "whatever-123" });
    const b = await request(h.app).post("/api/auth/login").send({ email: "admin@sunrise.vet", password: "wrong-password" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.detail).toBe(b.body.detail);
  });

  it("rejects missing, malformed, tampered and alg=none tokens", async () => {
    await request(h.app).get("/api/animals").expect(401);
    await request(h.app).get("/api/animals").set({ Authorization: "Bearer nope" }).expect(401);
    const [head, body] = sunrise.split(".");
    const forged = JSON.parse(Buffer.from(body!, "base64url").toString());
    forged.cid = "00000000-0000-0000-0000-000000000000";
    const tampered = `${head}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sunrise.split(".")[2]}`;
    await request(h.app).get("/api/animals").set(bearer(tampered)).expect(401);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${body}.`;
    await request(h.app).get("/api/animals").set(bearer(none)).expect(401);
  });

  it("rotates refresh tokens and revokes the family on reuse", async () => {
    const agent = request.agent(h.app);
    await agent.post("/api/auth/login").send({ email: "vet@sunrise.vet", password: "vetledger-demo" }).expect(200);
    const first = (await agent.post("/api/auth/login").send({ email: "vet@sunrise.vet", password: "vetledger-demo" })).headers["set-cookie"]![0]!;
    const oldCookie = first.split(";")[0]!;
    await request(h.app).post("/api/auth/refresh").set("Cookie", oldCookie).expect(403); // CSRF header required
    const rotated = await request(h.app).post("/api/auth/refresh").set("Cookie", oldCookie).set("X-Requested-With", "vetledger").expect(200);
    expect(rotated.body.accessToken).toBeTruthy();
    const newCookie = rotated.headers["set-cookie"]![0]!.split(";")[0]!;
    expect(newCookie).not.toBe(oldCookie);
    const reuse = await request(h.app).post("/api/auth/refresh").set("Cookie", oldCookie).set("X-Requested-With", "vetledger");
    expect(reuse.status).toBe(401);
    expect(reuse.body.detail).toMatch(/reused/);
    // The legitimate holder's newer token died with the family.
    await request(h.app).post("/api/auth/refresh").set("Cookie", newCookie).set("X-Requested-With", "vetledger").expect(401);
  });

  it("logout revokes the refresh token; /me works with an access token", async () => {
    const login = await request(h.app).post("/api/auth/login").send({ email: "tech@sunrise.vet", password: "vetledger-demo" });
    const cookie = login.headers["set-cookie"]![0]!.split(";")[0]!;
    const me = await request(h.app).get("/api/auth/me").set(bearer(login.body.accessToken)).expect(200);
    expect(me.body).toMatchObject({ role: "tech", clinicName: "Sunrise Veterinary Hospital" });
    await request(h.app).post("/api/auth/logout").set("Cookie", cookie).expect(204);
    await request(h.app).post("/api/auth/refresh").set("Cookie", cookie).set("X-Requested-With", "vetledger").expect(401);
    await request(h.app).post("/api/auth/refresh").set("X-Requested-With", "vetledger").expect(204); // anonymous
  });

  it("refresh tokens are stored hashed, never in plaintext", async () => {
    const login = await request(h.app).post("/api/auth/login").send({ email: "admin@deccan.vet", password: "vetledger-demo" });
    const token = decodeURIComponent(login.headers["set-cookie"]![0]!.split(";")[0]!.split("=")[1]!);
    const rows = await h.owner.selectFrom("refresh_tokens").select("token_hash").execute();
    expect(rows.some((r) => r.token_hash.toString("base64url") === token || r.token_hash.toString() === token)).toBe(false);
  });

  it("enforces roles", async () => {
    const tech = await h.login("tech@sunrise.vet");
    const res = await request(h.app).post("/api/products").set(bearer(tech))
      .send({ sku: "X-1", name: "x", kind: "drug", unit: "ml" });
    expect(res.status).toBe(403);
    await request(h.app).get("/api/audit").set(bearer(tech)).expect(403);
    const audit = await request(h.app).get("/api/audit").set(bearer(sunrise)).expect(200);
    expect(audit.body.items.some((e: { action: string }) => e.action === "login")).toBe(true);
  });
});

describe("HTTP hygiene", () => {
  it("returns RFC 9457 problem+json for validation errors with field paths", async () => {
    const res = await request(h.app).post("/api/animals").set(bearer(sunrise)).send({ name: "", species: "dragon" });
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(expect.arrayContaining(["ownerId", "name", "species"]));
    expect(res.body.requestId).toBeTruthy();
  });

  it("propagates a caller-supplied request id and sets security headers", async () => {
    const res = await request(h.app).get("/healthz").set("x-request-id", "trace-abc-12345");
    expect(res.headers["x-request-id"]).toBe("trace-abc-12345");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("rejects oversized bodies, unknown routes and bad cursors", async () => {
    await request(h.app).post("/api/owners").set(bearer(sunrise)).send({ fullName: "x".repeat(200_000) }).expect(413);
    await request(h.app).get("/api/nope").set(bearer(sunrise)).expect(404);
    await request(h.app).get("/api/animals?cursor=garbage").set(bearer(sunrise)).expect(400);
  });

  it("exposes health, readiness, metrics and OpenAPI", async () => {
    await request(h.app).get("/readyz").expect(200);
    const m = await request(h.app).get("/metrics").expect(200);
    expect(m.text).toContain("http_request_duration_seconds_bucket");
    expect(m.text).toMatch(/route="\/api\/animals\/:id"/);
    const spec = await request(h.app).get("/api/openapi.json").expect(200);
    expect(spec.body.paths["/api/animals"].post.requestBody.content["application/json"].schema.properties).toHaveProperty("species");
  });

  it("rate-limits login attempts (Redis-backed, shared across instances)", async () => {
    const { createApp } = await import("../src/app.js");
    const strict = await createApp({ ...h.deps, config: { ...h.deps.config, AUTH_RATE_LIMIT_PER_MIN: 3 } });
    await h.redis.del(...(await h.redis.keys("rl:login:*")).concat("rl:none"));
    const codes = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await request(strict).post("/api/auth/login").send({ email: "a@b.vet", password: "wrong-pass" })).status);
    }
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });
});
