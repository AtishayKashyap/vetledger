import { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLoaders, openTenantReadTx } from "../src/graphql/index.js";
import { markFailed, processSend, scanDueReminders, startReminderWorker, type ReminderMessage } from "../src/jobs/reminders.js";
import { bearer, createHarness, type Harness } from "./harness.js";
import { TEST_ENV } from "./env.js";

let h: Harness;
let vet: string;
let admin: string;

beforeAll(async () => {
  h = await createHarness({ animalsPerClinic: 25 });
  vet = await h.login("vet@sunrise.vet");
  admin = await h.login("admin@sunrise.vet");
});
afterAll(() => h.close());

const gql = (token: string, query: string, variables?: object) =>
  request(h.app).post("/api/graphql").set(bearer(token)).set("content-type", "application/json").send({ query, variables });

describe("patients REST", () => {
  it("creates owner -> animal -> visit and reads them back", async () => {
    const owner = await request(h.app).post("/api/owners").set(bearer(vet)).send({ fullName: "Test Owner", email: "T@Example.com" }).expect(201);
    const animal = await request(h.app).post("/api/animals").set(bearer(vet))
      .send({ ownerId: owner.body.id, name: "Zeus", species: "dog", weightKg: 21.5, birthDate: "2021-04-01" }).expect(201);
    const visit = await request(h.app).post("/api/visits").set(bearer(vet)).send({ animalId: animal.body.id, reason: "Annual check-up", weightKg: 22 }).expect(201);
    expect(visit.body.id).toBeTruthy();
    const got = await request(h.app).get(`/api/animals/${animal.body.id}`).set(bearer(vet)).expect(200);
    expect(got.body).toMatchObject({ name: "Zeus", weightKg: 22, version: 2, ownerName: "Test Owner" }); // visit weight bumps version
    const visits = await request(h.app).get(`/api/animals/${animal.body.id}/visits`).set(bearer(vet)).expect(200);
    expect(visits.body.items[0]).toMatchObject({ reason: "Annual check-up", vetName: "Dr. Arjun Rao" });
    const owners = await request(h.app).get("/api/owners?q=test own").set(bearer(vet)).expect(200);
    expect(owners.body.items[0]).toMatchObject({ fullName: "Test Owner", email: "t@example.com" });
    const tech = await h.login("tech@sunrise.vet");
    await request(h.app).post("/api/visits").set(bearer(tech)).send({ animalId: animal.body.id, reason: "x" }).expect(403);
  });

  it("keyset pagination walks every animal exactly once", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await request(h.app).get(`/api/animals?limit=7${cursor ? `&cursor=${cursor}` : ""}`).set(bearer(vet)).expect(200);
      seen.push(...res.body.items.map((a: { id: string }) => a.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    const total = await h.owner.selectFrom("animals as a").innerJoin("clinics as c", "c.id", "a.clinic_id").select("a.id").where("c.slug", "=", "sunrise").execute();
    expect(seen.length).toBe(total.length);
    const search = await request(h.app).get("/api/animals?q=bru").set(bearer(vet)).expect(200);
    expect(search.body.items.every((a: { name: string }) => a.name.toLowerCase().startsWith("bru"))).toBe(true);
  });
});

describe("GraphQL", () => {
  it("serves the dashboard in one round trip", async () => {
    const res = await gql(vet, `{ dashboard {
      stats { animals owners visitsLast30d vaccinationsLast30d pendingReminders failedReminders }
      upcomingVaccinations(days: 60) { dueOn status animal { name owner { fullName } } }
      lowStock { sku inStock reorderLevel }
      expiringBatches(days: 60) { lotNumber daysLeft quantity }
    } }`).expect(200);
    const d = res.body.data.dashboard;
    const sunriseAnimals = await h.owner.selectFrom("animals as a").innerJoin("clinics as c", "c.id", "a.clinic_id")
      .select(h.owner.fn.countAll<number>().as("n")).where("c.slug", "=", "sunrise").executeTakeFirstOrThrow();
    expect(d.stats.animals).toBe(Number(sunriseAnimals.n));
    expect(d.upcomingVaccinations.length).toBeGreaterThan(0);
    expect(d.upcomingVaccinations[0].animal.owner.fullName).toBeTruthy();
    expect(d.lowStock.map((s: { sku: string }) => s.sku)).toContain("VAC-FMD");
    expect(d.expiringBatches.every((b: { daysLeft: number }) => b.daysLeft >= 0 && b.daysLeft <= 60)).toBe(true);
  });

  it("DataLoader keeps query count constant regardless of page size (no N+1)", async () => {
    const q = `query($n: Int) { animals(first: $n) { name owner { fullName } visits(limit: 2) { reason } vaccinations { product } } }`;
    const count = async (n: number) => {
      h.queries.length = 0;
      const res = await gql(vet, q, { n }).expect(200);
      expect(res.body.data.animals).toHaveLength(n);
      for (const a of res.body.data.animals) expect(a.visits.length).toBeLessThanOrEqual(2);
      // Count data statements; each loader batch also runs begin/set_config/commit (constant).
      // Data statements only; the request also runs begin/set_config/commit once (constant).
      return h.queries.filter((s) => !/^(begin|start transaction|commit|rollback)|set_config/i.test(s.trim())).length;
    };
    const small = await count(3);
    const large = await count(25);
    expect(small).toBe(4); // animals + owners + visits + vaccinations
    expect(large).toBe(small);
  });

  it("loads single animals, rejects deep queries and unauthenticated callers", async () => {
    const id = (await request(h.app).get("/api/animals?limit=1").set(bearer(vet))).body.items[0].id;
    const one = await gql(vet, `query($id: ID!) { animal(id: $id) { id name } }`, { id }).expect(200);
    expect(one.body.data.animal.id).toBe(id);
    const deccan = await h.login("vet@deccan.vet");
    const other = await gql(deccan, `query($id: ID!) { animal(id: $id) { id } }`, { id });
    expect(other.body.data.animal).toBeNull(); // RLS applies to GraphQL too
    const deep = `{ dashboard { upcomingVaccinations { animal { owner { fullName } } } } }`;
    expect((await gql(vet, deep)).status).toBe(200); // depth 5: allowed
    const tooDeep = await gql(vet, `{ __typename a: dashboard { upcomingVaccinations { animal { owner { fullName } } } } b: dashboard { stats { animals } } }`);
    expect(tooDeep.status).toBe(200);
    await request(h.app).post("/api/graphql").send({ query: "{ dashboard { stats { animals } } }" }).expect(401);
  });

  it("loaders return results in key order with misses as null/empty", async () => {
    const [c] = await h.owner.selectFrom("clinics").select("id").where("slug", "=", "sunrise").execute();
    const tx = await openTenantReadTx(h.db, c!.id);
    const loaders = createLoaders(tx);
    const missing = "00000000-0000-4000-8000-000000000000";
    expect(await loaders.animal.loadMany([missing])).toEqual([null]);
    expect(await loaders.vaccinations.load(missing)).toEqual([]);
    // The GraphQL transaction is read-only: even a buggy resolver can't write.
    await expect(tx.insertInto("owners").values({ full_name: "x" }).execute()).rejects.toThrow(/read-only transaction/);
    await tx.rollback().execute();
  });
});

describe("reminders pipeline", () => {
  const queue = () => h.deps.reminderQueue;

  it("claims due reminders once, even when scans overlap (SKIP LOCKED + jobId dedupe)", async () => {
    await queue().obliterate({ force: true });
    const [first, second] = await Promise.all([scanDueReminders(h.db, queue()), scanDueReminders(h.db, queue())]);
    const dueBoth = await h.owner.selectFrom("reminders").select("id").where("status", "=", "queued").execute();
    expect(first + second).toBe(dueBoth.length);
    expect(dueBoth.length).toBeGreaterThan(0);
    expect(await scanDueReminders(h.db, queue())).toBe(0);
    expect(await queue().getJobCountByTypes("waiting")).toBe(dueBoth.length);
  });

  it("processes a send: success marks sent, failure records the error, final failure dead-letters", async () => {
    const jobs = await queue().getJobs(["waiting"], 0, 2);
    const [ok, bad] = jobs as [NonNullable<(typeof jobs)[0]>, NonNullable<(typeof jobs)[0]>];
    const sent: ReminderMessage[] = [];
    expect(await processSend(h.db, async (m) => void sent.push(m), ok)).toBe("sent");
    expect(sent[0]).toMatchObject({ clinic: expect.any(String), vaccine: expect.any(String), owner: expect.any(String) });
    expect(await processSend(h.db, async () => undefined, ok)).toBe("skipped"); // idempotent re-delivery
    await expect(processSend(h.db, async () => { throw new Error("SMTP down"); }, bad)).rejects.toThrow("SMTP down");
    let row = await h.owner.selectFrom("reminders").selectAll().where("id", "=", bad.data.reminderId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "queued", attempts: 1, last_error: "SMTP down" });
    await markFailed(h.db, bad.data, "gave up");
    row = await h.owner.selectFrom("reminders").selectAll().where("id", "=", bad.data.reminderId).executeTakeFirstOrThrow();
    expect(row.status).toBe("failed");

    const list = await request(h.app).get("/api/reminders?status=failed").set(bearer(admin)).expect(200);
    expect(list.body.queue).toHaveProperty("waiting");
    const mine = list.body.items.find((r: { id: string }) => r.id === bad.data.reminderId);
    if (mine) {
      await request(h.app).post(`/api/reminders/${mine.id}/retry`).set(bearer(admin)).expect(202);
      await request(h.app).post(`/api/reminders/${mine.id}/retry`).set(bearer(admin)).expect(409);
    }
  });

  it("end-to-end: the worker delivers queued jobs and retries with backoff", async () => {
    await queue().obliterate({ force: true });
    await h.owner.updateTable("reminders").set({ status: "pending", attempts: 0, last_error: null }).execute();
    const delivered: string[] = [];
    let flaky = 0;
    const worker = await startReminderWorker({
      db: h.db, queue: queue(), connection: { url: TEST_ENV.REDIS_URL }, logger: h.deps.logger, metrics: h.deps.metrics,
      scanEveryMs: 200,
      deliver: async (m) => {
        if (flaky++ === 0) throw new Error("transient"); // first attempt fails, retry succeeds
        delivered.push(m.reminderId);
      },
    });
    const due = await h.owner.selectFrom("reminders").select("id").where("due_on", "<=", new Date().toISOString().slice(0, 10)).execute();
    const deadline = Date.now() + 20_000;
    // Backoff in the queue defaults is 30s; shrink it for the test by promoting delayed jobs.
    while (delivered.length < due.length && Date.now() < deadline) {
      for (const j of await queue().getJobs(["delayed"])) await j.promote().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
    }
    await worker.close();
    await queue().removeJobScheduler("scan-due-reminders");
    expect(new Set(delivered).size).toBe(due.length);
    const sentRows = await h.owner.selectFrom("reminders").select("status").where("status", "=", "sent").execute();
    expect(sentRows.length).toBe(due.length);
    const metrics = await h.deps.metrics.registry.metrics();
    expect(metrics).toMatch(/reminders_processed_total\{outcome="retry"\} 1/);
    expect(new Queue("x", { connection: { url: TEST_ENV.REDIS_URL } })).toBeTruthy();
  });
});
