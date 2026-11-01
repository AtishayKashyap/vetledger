import { describe, expect, it } from "vitest";
import { animalCreateSchema, animalUpdateSchema, batchReceiveSchema, loginSchema, ownerCreateSchema, productCreateSchema } from "./index.js";

describe("shared contracts", () => {
  it("normalises emails and trims names", () => {
    expect(loginSchema.parse({ email: "Vet@Clinic.VET", password: "longenough" }).email).toBe("vet@clinic.vet");
    expect(ownerCreateSchema.parse({ fullName: "  Asha Rao  ", email: "A@B.com" })).toEqual({ fullName: "Asha Rao", email: "a@b.com" });
  });

  it("rejects bad input with field paths", () => {
    const r = animalCreateSchema.safeParse({ ownerId: "x", name: "", species: "dragon", weightKg: -1 });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path[0]).sort()).toEqual(["name", "ownerId", "species", "weightKg"]);
  });

  it("defaults sex to unknown and allows partial updates without ownerId", () => {
    const a = animalCreateSchema.parse({ ownerId: "6f1c6a1e-9b0b-4c8a-8d55-2f6d5b1f0c11", name: "Bruno", species: "dog" });
    expect(a.sex).toBe("unknown");
    expect(animalUpdateSchema.parse({ weightKg: 12 })).toEqual({ weightKg: 12 });
    expect(animalUpdateSchema.safeParse({ ownerId: "6f1c6a1e-9b0b-4c8a-8d55-2f6d5b1f0c11" }).data).toEqual({});
  });

  it("validates SKUs, dates and quantities", () => {
    expect(productCreateSchema.safeParse({ sku: "bad sku", name: "x", kind: "drug", unit: "ml" }).success).toBe(false);
    expect(productCreateSchema.parse({ sku: "DRG-1", name: "x", kind: "drug", unit: "ml" }).reorderLevel).toBe(0);
    const base = { productId: "6f1c6a1e-9b0b-4c8a-8d55-2f6d5b1f0c11", lotNumber: "L1", quantity: 5 };
    expect(batchReceiveSchema.safeParse({ ...base, expiresOn: "2027-02-30" }).success).toBe(false);
    expect(batchReceiveSchema.safeParse({ ...base, expiresOn: "2027-02-28", quantity: 0 }).success).toBe(false);
  });
});
