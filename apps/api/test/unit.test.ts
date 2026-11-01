import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { decodeCursor, encodeCursor } from "../src/http/pagination.js";
import { requestHash } from "../src/http/write.js";
import { signAccessToken, verifyAccessToken } from "../src/auth/tokens.js";
import { allocateFefo, InsufficientStockError } from "../src/services/fefo.js";
import { depthLimit, typeDefs } from "../src/graphql/index.js";
import { buildSchema, parse, validate } from "graphql";

const TODAY = "2026-06-01";

describe("allocateFefo", () => {
  const batches = [
    { id: "b", quantity: 5, expiresOn: "2026-09-01" },
    { id: "a", quantity: 3, expiresOn: "2026-06-15" },
    { id: "x", quantity: 99, expiresOn: "2026-05-31" }, // expired yesterday
    { id: "z", quantity: 0, expiresOn: "2026-06-02" },
  ];
  it("takes earliest expiry first and spans batches", () => {
    expect(allocateFefo(batches, 4, TODAY)).toEqual([{ batchId: "a", quantity: 3 }, { batchId: "b", quantity: 1 }]);
    expect(allocateFefo(batches, 3, TODAY)).toEqual([{ batchId: "a", quantity: 3 }]);
  });
  it("a batch expiring today is still usable; expired stock never counts", () => {
    expect(allocateFefo([{ id: "t", quantity: 1, expiresOn: TODAY }], 1, TODAY)).toHaveLength(1);
    expect(() => allocateFefo(batches, 9, TODAY)).toThrow(InsufficientStockError);
  });
  it("breaks expiry ties deterministically by id (same lock order everywhere)", () => {
    const tie = [{ id: "2", quantity: 1, expiresOn: TODAY }, { id: "1", quantity: 1, expiresOn: TODAY }];
    expect(allocateFefo(tie, 1, TODAY)[0]!.batchId).toBe("1");
  });
  it("validates the requested quantity", () => {
    expect(() => allocateFefo(batches, 0, TODAY)).toThrow(RangeError);
    expect(() => allocateFefo(batches, 1.5, TODAY)).toThrow(RangeError);
  });
});

describe("helpers", () => {
  it("round-trips keyset cursors and rejects garbage", () => {
    const d = new Date("2026-01-02T03:04:05.000Z");
    const id = "6f1c6a1e-9b0b-4c8a-8d55-2f6d5b1f0c11";
    expect(decodeCursor(encodeCursor(d, id))).toEqual({ createdAt: d.toISOString(), id });
    expect(() => decodeCursor("not-a-cursor")).toThrow(/invalid cursor/);
    expect(() => decodeCursor(Buffer.from('["x","y"]').toString("base64url"))).toThrow();
  });

  it("hashes requests by method, url and body", () => {
    const base = { method: "POST", originalUrl: "/api/owners", body: { a: 1 } };
    expect(requestHash(base)).toBe(requestHash({ ...base }));
    expect(requestHash(base)).not.toBe(requestHash({ ...base, body: { a: 2 } }));
  });

  it("signs and verifies access tokens; rejects wrong secrets", () => {
    const p = { userId: "u1", clinicId: "c1", role: "vet" as const };
    const t = signAccessToken(p, "s".repeat(32), 60);
    expect(verifyAccessToken(t, "s".repeat(32))).toEqual(p);
    expect(() => verifyAccessToken(t, "x".repeat(32))).toThrow(/invalid/);
  });

  it("config fails fast with every problem listed", () => {
    expect(() => loadConfig({ DATABASE_URL: "nope", JWT_SECRET: "short" })).toThrow(/DATABASE_URL[\s\S]*JWT_SECRET/);
    const c = loadConfig({ DATABASE_URL: "postgres://a@b/c", JWT_SECRET: "x".repeat(32), RUN_WORKER: "0", COOKIE_SECURE: "true" });
    expect(c).toMatchObject({ RUN_WORKER: false, COOKIE_SECURE: true, PORT: 4000, WORKER_DRAIN_DELAY_SEC: 5 });
    expect(() => loadConfig({ DATABASE_URL: "postgres://a@b/c", JWT_SECRET: "x".repeat(32), WORKER_DRAIN_DELAY_SEC: "0" })).toThrow(/WORKER_DRAIN_DELAY_SEC/);
  });

  it("GraphQL depth limit rejects deeply nested queries", () => {
    const schema = buildSchema(typeDefs);
    const ok = validate(schema, parse("{ animals { owner { fullName } } }"), [depthLimit(3)]);
    const bad = validate(schema, parse("{ dashboard { upcomingVaccinations { animal { owner { fullName } } } } }"), [depthLimit(3)]);
    expect(ok).toHaveLength(0);
    expect(bad[0]?.message).toMatch(/exceeds limit of 3/);
  });
});
