import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let vet: string;
let animalId: string;

const day = (o: number) => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);

async function newProduct(kind: "drug" | "vaccine", batches: { lot: string; expires: string; qty: number }[]) {
  const sku = `T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const p = await request(h.app).post("/api/products").set(bearer(admin)).send({ sku, name: `Test ${sku}`, kind, unit: "dose" }).expect(201);
  for (const b of batches) {
    if (b.expires < day(0)) {
      // The API refuses expired stock, so insert it directly as the owner.
      const clinic = await h.owner.selectFrom("products").select("clinic_id").where("id", "=", p.body.id).executeTakeFirstOrThrow();
      await h.owner.insertInto("batches").values({ clinic_id: clinic.clinic_id, product_id: p.body.id, lot_number: b.lot, expires_on: b.expires, quantity: b.qty }).execute();
    } else {
      await request(h.app).post("/api/batches").set(bearer(admin)).send({ productId: p.body.id, lotNumber: b.lot, expiresOn: b.expires, quantity: b.qty }).expect(201);
    }
  }
  return p.body.id as string;
}

const stock = (productId: string) =>
  h.owner.selectFrom("batches").select(["lot_number", "quantity"]).where("product_id", "=", productId).orderBy("lot_number").execute();

beforeAll(async () => {
  h = await createHarness();
  admin = await h.login("admin@sunrise.vet");
  vet = await h.login("vet@sunrise.vet");
  animalId = (await request(h.app).get("/api/animals?limit=1").set(bearer(vet))).body.items[0].id;
});
afterAll(() => h.close());

describe("FEFO dispensing", () => {
  it("drains the earliest-expiring batch first, spans batches, and never touches expired stock", async () => {
    const pid = await newProduct("drug", [
      { lot: "A-LATE", expires: day(200), qty: 10 },
      { lot: "B-SOON", expires: day(5), qty: 4 },
      { lot: "C-EXPIRED", expires: day(-1), qty: 50 },
    ]);
    const res = await request(h.app).post("/api/prescriptions").set(bearer(vet)).send({ animalId, productId: pid, quantity: 6 }).expect(201);
    expect(res.body.allocations.map((a: { quantity: number }) => a.quantity)).toEqual([4, 2]);
    expect(await stock(pid)).toEqual([
      { lot_number: "A-LATE", quantity: 8 },
      { lot_number: "B-SOON", quantity: 0 },
      { lot_number: "C-EXPIRED", quantity: 50 },
    ]);
    const tooMuch = await request(h.app).post("/api/prescriptions").set(bearer(vet)).send({ animalId, productId: pid, quantity: 9 });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body).toMatchObject({ title: "Insufficient Stock", available: 8, requested: 9 });
  });

  it("is race-free: 20 concurrent dispenses against 10 units -> exactly 10 succeed", async () => {
    const pid = await newProduct("drug", [
      { lot: "R1", expires: day(30), qty: 4 },
      { lot: "R2", expires: day(60), qty: 6 },
    ]);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(h.app).post("/api/prescriptions").set(bearer(vet)).send({ animalId, productId: pid, quantity: 1 }),
      ),
    );
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(10);
    expect(codes.filter((c) => c === 409)).toHaveLength(10);
    expect((await stock(pid)).map((b) => b.quantity)).toEqual([0, 0]);
    const allocated = await h.owner.selectFrom("dispense_allocations as d").innerJoin("batches as b", "b.id", "d.batch_id")
      .select((eb) => eb.fn.sum<number>("d.quantity").as("n")).where("b.product_id", "=", pid).executeTakeFirstOrThrow();
    expect(Number(allocated.n)).toBe(10); // no phantom allocations from rolled-back requests
  });

  it("vaccination consumes one dose FEFO, schedules a reminder and supports recall tracing", async () => {
    const pid = await newProduct("vaccine", [{ lot: "VX-1", expires: day(90), qty: 3 }]);
    const v = await request(h.app).post("/api/vaccinations").set(bearer(vet)).send({ animalId, productId: pid, boosterInDays: 21 }).expect(201);
    expect(v.body.nextDueOn).toBe(day(21));
    expect(v.body.reminderId).toBeTruthy();
    const recall = await request(h.app).get(`/api/batches/${v.body.batchId}/recipients`).set(bearer(vet)).expect(200);
    expect(recall.body.items).toEqual([expect.objectContaining({ animalId, quantity: 1 })]);
    const history = await request(h.app).get(`/api/animals/${animalId}/vaccinations`).set(bearer(vet)).expect(200);
    expect(history.body.items[0]).toMatchObject({ lotNumber: "VX-1", reminderStatus: "pending" });
    const drug = await newProduct("drug", [{ lot: "D-1", expires: day(90), qty: 3 }]);
    await request(h.app).post("/api/vaccinations").set(bearer(vet)).send({ animalId, productId: drug }).expect(422);
  });

  it("lists products with live stock aggregates and batches", async () => {
    const pid = await newProduct("drug", [{ lot: "S-1", expires: day(10), qty: 7 }, { lot: "S-0", expires: day(-3), qty: 2 }]);
    const list = await request(h.app).get("/api/products").set(bearer(vet)).expect(200);
    expect(list.body.items.find((p: { id: string }) => p.id === pid)).toMatchObject({ inStock: 7, expired: 2, nextExpiry: day(10) });
    const batches = await request(h.app).get(`/api/products/${pid}/batches`).set(bearer(vet)).expect(200);
    expect(batches.body.items).toHaveLength(2);
    await request(h.app).post("/api/batches").set(bearer(admin)).send({ productId: pid, lotNumber: "OLD", expiresOn: day(-1), quantity: 1 }).expect(422);
  });
});

describe("idempotency keys", () => {
  const body = () => ({ fullName: "Idem Potent", phone: "+91 98765 43210" });

  it("replays the original response for a repeated key, without a second write", async () => {
    const key = `idem-${Date.now()}`;
    const a = await request(h.app).post("/api/owners").set(bearer(vet)).set("Idempotency-Key", key).send(body()).expect(201);
    const b = await request(h.app).post("/api/owners").set(bearer(vet)).set("Idempotency-Key", key).send(body()).expect(201);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(b.body).toEqual(a.body);
    const n = await h.owner.selectFrom("owners").select("id").where("full_name", "=", "Idem Potent").execute();
    expect(n).toHaveLength(1);
  });

  it("rejects reuse of a key with a different payload, and bad key formats", async () => {
    const key = `idem-diff-${Date.now()}`;
    await request(h.app).post("/api/owners").set(bearer(vet)).set("Idempotency-Key", key).send(body()).expect(201);
    await request(h.app).post("/api/owners").set(bearer(vet)).set("Idempotency-Key", key).send({ fullName: "Someone Else" }).expect(422);
    await request(h.app).post("/api/owners").set(bearer(vet)).set("Idempotency-Key", "short").send(body()).expect(400);
  });

  it("concurrent requests with the same new key produce exactly one side effect", async () => {
    const pid = await newProduct("drug", [{ lot: "IDEM", expires: day(30), qty: 100 }]);
    const key = `idem-race-${Date.now()}`;
    const res = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(h.app).post("/api/prescriptions").set(bearer(vet)).set("Idempotency-Key", key).send({ animalId, productId: pid, quantity: 5 }),
      ),
    );
    expect(res.every((r) => [201, 409].includes(r.status))).toBe(true);
    expect((await stock(pid))[0]!.quantity).toBe(95); // dispensed once, not 8 times
  });

  it("keys are scoped per clinic", async () => {
    const deccan = await h.login("admin@deccan.vet");
    const key = `idem-tenant-${Date.now()}`;
    await request(h.app).post("/api/owners").set(bearer(vet)).set("Idempotency-Key", key).send(body()).expect(201);
    const other = await request(h.app).post("/api/owners").set(bearer(deccan)).set("Idempotency-Key", key).send(body()).expect(201);
    expect(other.headers["idempotent-replayed"]).toBeUndefined();
  });
});

describe("optimistic concurrency (If-Match)", () => {
  it("requires If-Match, applies with the right version, and 409s a stale writer", async () => {
    const get = await request(h.app).get(`/api/animals/${animalId}`).set(bearer(vet)).expect(200);
    const etag = get.headers.etag!;
    await request(h.app).patch(`/api/animals/${animalId}`).set(bearer(vet)).send({ weightKg: 10 }).expect(428);
    const ok = await request(h.app).patch(`/api/animals/${animalId}`).set(bearer(vet)).set("If-Match", etag).send({ weightKg: 11.5, breed: "Indie" }).expect(200);
    // Regression: a partial update must not reset fields that have create-time defaults.
    const after = await request(h.app).get(`/api/animals/${animalId}`).set(bearer(vet)).expect(200);
    expect(after.body.sex).toBe(get.body.sex);
    expect(ok.body.version).toBe(get.body.version + 1);
    expect(ok.headers.etag).toBe(`"${get.body.version + 1}"`);
    const stale = await request(h.app).patch(`/api/animals/${animalId}`).set(bearer(vet)).set("If-Match", etag).send({ weightKg: 99 });
    expect(stale.status).toBe(409);
    expect(stale.body.current.version).toBe(get.body.version + 1);
    await request(h.app).patch("/api/animals/00000000-0000-4000-8000-000000000000").set(bearer(vet)).set("If-Match", '"1"').send({ name: "x" }).expect(404);
  });
});
