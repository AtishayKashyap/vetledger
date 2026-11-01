import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { batchReceiveSchema, prescriptionCreateSchema, productCreateSchema, vaccinationCreateSchema } from "@vetledger/shared";
import { principal, requireRole } from "../auth/middleware.js";
import type { Deps } from "../deps.js";
import { withTenant } from "../db.js";
import { AppError, notFound } from "../http/errors.js";
import { audit, send, tenantWrite } from "../http/write.js";
import { dispenseFefo, todayUtc } from "../services/inventory.js";

const uuidParam = z.object({ id: z.uuid() });

export function inventoryRouter({ db, metrics }: Deps): Router {
  const r = Router();

  /** Products with live stock: total usable units, expired units, nearest expiry. */
  r.get("/products", async (req, res) => {
    const today = todayUtc();
    const rows = await withTenant(db, principal(req).clinicId, (tx) =>
      tx
        .selectFrom("products as p")
        .leftJoin("batches as b", "b.product_id", "p.id")
        .select([
          "p.id", "p.sku", "p.name", "p.kind", "p.unit", "p.reorder_level as reorderLevel",
          sql<number>`coalesce(sum(b.quantity) FILTER (WHERE b.expires_on >= ${today}), 0)::int`.as("inStock"),
          sql<number>`coalesce(sum(b.quantity) FILTER (WHERE b.expires_on < ${today}), 0)::int`.as("expired"),
          sql<string | null>`min(b.expires_on) FILTER (WHERE b.quantity > 0 AND b.expires_on >= ${today})`.as("nextExpiry"),
        ])
        .groupBy("p.id")
        .orderBy("p.name")
        .execute(),
    );
    res.json({ items: rows });
  });

  r.post("/products", requireRole("admin"), async (req, res) => {
    const p = productCreateSchema.parse(req.body);
    send(res, await tenantWrite(db, req, async (tx) => {
      const product = await tx
        .insertInto("products")
        .values({ sku: p.sku, name: p.name, kind: p.kind, unit: p.unit, reorder_level: p.reorderLevel })
        .returning(["id", "sku", "name"])
        .executeTakeFirstOrThrow();
      await audit(tx, req, "create", "product", product.id, { sku: p.sku });
      return { status: 201, body: product };
    }));
  });

  r.get("/products/:id/batches", async (req, res) => {
    const { id } = uuidParam.parse(req.params);
    const rows = await withTenant(db, principal(req).clinicId, (tx) =>
      tx.selectFrom("batches")
        .select(["id", "lot_number as lotNumber", "expires_on as expiresOn", "quantity", "received_at as receivedAt"])
        .where("product_id", "=", id).orderBy("expires_on").execute(),
    );
    res.json({ items: rows });
  });

  r.post("/batches", requireRole("admin"), async (req, res) => {
    const b = batchReceiveSchema.parse(req.body);
    if (b.expiresOn < todayUtc()) throw new AppError(422, "Unprocessable Entity", "cannot receive an already-expired batch");
    send(res, await tenantWrite(db, req, async (tx) => {
      const batch = await tx
        .insertInto("batches")
        .values({ product_id: b.productId, lot_number: b.lotNumber, expires_on: b.expiresOn, quantity: b.quantity })
        .returning(["id", "lot_number as lotNumber", "expires_on as expiresOn", "quantity"])
        .executeTakeFirstOrThrow();
      await audit(tx, req, "receive", "batch", batch.id, { productId: b.productId, quantity: b.quantity });
      return { status: 201, body: batch };
    }));
  });

  /** Recall trace: every animal that received doses from a batch. */
  r.get("/batches/:id/recipients", async (req, res) => {
    const { id } = uuidParam.parse(req.params);
    const rows = await withTenant(db, principal(req).clinicId, (tx) =>
      tx
        .selectFrom("dispense_allocations as d")
        .leftJoin("prescriptions as p", "p.id", "d.prescription_id")
        .leftJoin("vaccinations as v", "v.id", "d.vaccination_id")
        .innerJoin("animals as a", (j) => j.on(sql<boolean>`a.id = coalesce(p.animal_id, v.animal_id)`))
        .innerJoin("owners as o", "o.id", "a.owner_id")
        .select([
          "a.id as animalId", "a.name as animalName", "o.full_name as ownerName", "o.phone as ownerPhone",
          "d.quantity", sql<Date>`coalesce(p.created_at, v.administered_at)`.as("at"),
        ])
        .where("d.batch_id", "=", id)
        .orderBy("at", "desc")
        .execute(),
    );
    res.json({ items: rows });
  });

  r.post("/prescriptions", requireRole("vet"), async (req, res) => {
    const p = prescriptionCreateSchema.parse(req.body);
    send(res, await tenantWrite(db, req, async (tx) => {
      const product = await tx.selectFrom("products").select(["id", "kind"]).where("id", "=", p.productId).executeTakeFirst();
      if (!product) throw notFound("product");
      const allocations = await dispenseFefo(tx, p.productId, p.quantity);
      const rx = await tx
        .insertInto("prescriptions")
        .values({ animal_id: p.animalId, product_id: p.productId, quantity: p.quantity, instructions: p.instructions ?? null, prescribed_by: principal(req).userId })
        .returning(["id", "created_at as createdAt"])
        .executeTakeFirstOrThrow();
      await tx.insertInto("dispense_allocations")
        .values(allocations.map((a) => ({ prescription_id: rx.id, batch_id: a.batchId, quantity: a.quantity })))
        .execute();
      await audit(tx, req, "dispense", "prescription", rx.id, { productId: p.productId, quantity: p.quantity, allocations });
      metrics.dispensed.inc(p.quantity);
      return { status: 201, body: { ...rx, allocations } };
    }));
  });

  r.post("/vaccinations", requireRole("vet", "tech"), async (req, res) => {
    const v = vaccinationCreateSchema.parse(req.body);
    send(res, await tenantWrite(db, req, async (tx) => {
      const product = await tx.selectFrom("products").select(["id", "kind"]).where("id", "=", v.productId).executeTakeFirst();
      if (!product) throw notFound("product");
      if (product.kind !== "vaccine") throw new AppError(422, "Unprocessable Entity", "product is not a vaccine");
      const [alloc] = await dispenseFefo(tx, v.productId, 1);
      if (!alloc) throw new AppError(409, "Insufficient Stock", "no usable dose in stock");
      const administeredAt = v.administeredAt ? new Date(v.administeredAt) : new Date();
      const nextDue = v.boosterInDays ? todayUtc(new Date(administeredAt.getTime() + v.boosterInDays * 86_400_000)) : null;
      const vacc = await tx
        .insertInto("vaccinations")
        .values({ animal_id: v.animalId, product_id: v.productId, batch_id: alloc.batchId, administered_at: administeredAt, administered_by: principal(req).userId, next_due_on: nextDue })
        .returning(["id", "administered_at as administeredAt", "next_due_on as nextDueOn", "batch_id as batchId"])
        .executeTakeFirstOrThrow();
      await tx.insertInto("dispense_allocations").values({ vaccination_id: vacc.id, batch_id: alloc.batchId, quantity: 1 }).execute();
      let reminderId: string | null = null;
      if (nextDue) {
        reminderId = (await tx.insertInto("reminders").values({ vaccination_id: vacc.id, animal_id: v.animalId, due_on: nextDue })
          .returning("id").executeTakeFirstOrThrow()).id;
      }
      await audit(tx, req, "vaccinate", "vaccination", vacc.id, { animalId: v.animalId, batchId: alloc.batchId });
      metrics.dispensed.inc(1);
      return { status: 201, body: { ...vacc, reminderId } };
    }));
  });

  r.get("/animals/:id/vaccinations", async (req, res) => {
    const { id } = uuidParam.parse(req.params);
    const rows = await withTenant(db, principal(req).clinicId, (tx) =>
      tx.selectFrom("vaccinations as v")
        .innerJoin("products as p", "p.id", "v.product_id")
        .innerJoin("batches as b", "b.id", "v.batch_id")
        .leftJoin("reminders as r", "r.vaccination_id", "v.id")
        .select(["v.id", "p.name as product", "b.lot_number as lotNumber", "v.administered_at as administeredAt",
          "v.next_due_on as nextDueOn", "r.status as reminderStatus"])
        .where("v.animal_id", "=", id).orderBy("v.administered_at", "desc").execute(),
    );
    res.json({ items: rows });
  });

  return r;
}
