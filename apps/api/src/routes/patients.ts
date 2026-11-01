import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { animalCreateSchema, animalUpdateSchema, listQuerySchema, ownerCreateSchema, visitCreateSchema } from "@vetledger/shared";
import { principal, requireRole } from "../auth/middleware.js";
import type { Deps } from "../deps.js";
import { withTenant } from "../db.js";
import { AppError, conflict, notFound } from "../http/errors.js";
import { decodeCursor, encodeCursor } from "../http/pagination.js";
import { audit, send, tenantWrite } from "../http/write.js";

const uuidParam = z.object({ id: z.uuid() });

export function patientsRouter({ db }: Deps): Router {
  const r = Router();

  // ---- owners ----------------------------------------------------------------------
  r.get("/owners", async (req, res) => {
    const { q, limit } = listQuerySchema.parse(req.query);
    const rows = await withTenant(db, principal(req).clinicId, (tx) => {
      let query = tx.selectFrom("owners").select(["id", "full_name as fullName", "email", "phone"]).orderBy("full_name").limit(limit);
      if (q) query = query.where(sql<boolean>`lower(full_name) LIKE ${`%${q.toLowerCase()}%`}`);
      return query.execute();
    });
    res.json({ items: rows });
  });

  r.post("/owners", async (req, res) => {
    const input = ownerCreateSchema.parse(req.body);
    send(res, await tenantWrite(db, req, async (tx) => {
      const owner = await tx
        .insertInto("owners")
        .values({ full_name: input.fullName, email: input.email ?? null, phone: input.phone ?? null })
        .returning(["id", "full_name as fullName", "email", "phone"])
        .executeTakeFirstOrThrow();
      await audit(tx, req, "create", "owner", owner.id);
      return { status: 201, body: owner };
    }));
  });

  // ---- animals ---------------------------------------------------------------------
  const animalCols = [
    "animals.id", "animals.name", "animals.species", "animals.breed", "animals.sex",
    "animals.birth_date as birthDate", "animals.weight_kg as weightKg", "animals.tag_number as tagNumber",
    "animals.owner_id as ownerId", "animals.version", "animals.created_at as createdAt",
  ] as const;

  r.get("/animals", async (req, res) => {
    const { q, limit, cursor } = listQuerySchema.parse(req.query);
    const rows = await withTenant(db, principal(req).clinicId, (tx) => {
      let query = tx
        .selectFrom("animals")
        .innerJoin("owners", "owners.id", "animals.owner_id")
        .select([...animalCols, "owners.full_name as ownerName"])
        .orderBy("animals.created_at", "desc")
        .orderBy("animals.id", "desc")
        .limit(limit + 1); // fetch one extra to know if there's a next page
      if (q) query = query.where(sql<boolean>`lower(animals.name) LIKE ${`${q.toLowerCase()}%`}`);
      if (cursor) {
        const c = decodeCursor(cursor);
        query = query.where(sql<boolean>`(animals.created_at, animals.id) < (${c.createdAt}::timestamptz, ${c.id}::uuid)`);
      }
      return query.execute();
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    res.json({ items: page, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null });
  });

  r.get("/animals/:id", async (req, res) => {
    const { id } = uuidParam.parse(req.params);
    const animal = await withTenant(db, principal(req).clinicId, (tx) =>
      tx.selectFrom("animals").innerJoin("owners", "owners.id", "animals.owner_id")
        .select([...animalCols, "owners.full_name as ownerName", "owners.phone as ownerPhone"])
        .where("animals.id", "=", id).executeTakeFirst(),
    );
    if (!animal) throw notFound("animal");
    res.setHeader("ETag", `"${animal.version}"`);
    res.json(animal);
  });

  r.post("/animals", async (req, res) => {
    const a = animalCreateSchema.parse(req.body);
    send(res, await tenantWrite(db, req, async (tx) => {
      // The owner lookup runs under RLS: another clinic's ownerId is simply "not found".
      const owner = await tx.selectFrom("owners").select("id").where("id", "=", a.ownerId).executeTakeFirst();
      if (!owner) throw new AppError(422, "Unprocessable Entity", "ownerId does not exist");
      const animal = await tx
        .insertInto("animals")
        .values({
          owner_id: a.ownerId, name: a.name, species: a.species, breed: a.breed ?? null, sex: a.sex,
          birth_date: a.birthDate ?? null, weight_kg: a.weightKg ?? null, tag_number: a.tagNumber ?? null,
        })
        .returning(["id", "name", "species", "version"])
        .executeTakeFirstOrThrow();
      await audit(tx, req, "create", "animal", animal.id, { name: a.name, species: a.species });
      return { status: 201, body: animal };
    }));
  });

  /** Optimistic concurrency: the client must send the version it edited (If-Match). */
  r.patch("/animals/:id", async (req, res) => {
    const { id } = uuidParam.parse(req.params);
    const ifMatch = req.get("If-Match")?.replaceAll('"', "");
    if (!ifMatch || !/^\d+$/.test(ifMatch)) throw new AppError(428, "Precondition Required", "send If-Match with the animal's version");
    const patch = animalUpdateSchema.parse(req.body);
    const result = await tenantWrite(db, req, async (tx) => {
      const updated = await tx
        .updateTable("animals")
        .set({
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.species !== undefined && { species: patch.species }),
          ...(patch.breed !== undefined && { breed: patch.breed }),
          ...(patch.sex !== undefined && { sex: patch.sex }),
          ...(patch.birthDate !== undefined && { birth_date: patch.birthDate }),
          ...(patch.weightKg !== undefined && { weight_kg: patch.weightKg }),
          ...(patch.tagNumber !== undefined && { tag_number: patch.tagNumber }),
          version: sql`version + 1`,
          updated_at: sql`now()`,
        })
        .where("id", "=", id)
        .where("version", "=", Number(ifMatch)) // compare-and-swap in a single statement
        .returning(["id", "name", "version"])
        .executeTakeFirst();
      if (!updated) {
        const current = await tx.selectFrom("animals").select(["id", "name", "version"]).where("id", "=", id).executeTakeFirst();
        if (!current) throw notFound("animal");
        throw conflict("animal was modified by someone else; reload and retry", { current });
      }
      await audit(tx, req, "update", "animal", id, { fields: Object.keys(patch) });
      return { status: 200, body: updated };
    });
    res.setHeader("ETag", `"${result.body.version}"`);
    send(res, result);
  });

  // ---- visits ----------------------------------------------------------------------
  r.get("/animals/:id/visits", async (req, res) => {
    const { id } = uuidParam.parse(req.params);
    const rows = await withTenant(db, principal(req).clinicId, (tx) =>
      tx.selectFrom("visits").innerJoin("users", "users.id", "visits.vet_id")
        .select(["visits.id", "visits.visited_at as visitedAt", "visits.reason", "visits.notes", "visits.weight_kg as weightKg", "users.full_name as vetName"])
        .where("visits.animal_id", "=", id).orderBy("visits.visited_at", "desc").limit(100).execute(),
    );
    res.json({ items: rows });
  });

  r.post("/visits", requireRole("vet", "admin"), async (req, res) => {
    const v = visitCreateSchema.parse(req.body);
    send(res, await tenantWrite(db, req, async (tx) => {
      const visit = await tx
        .insertInto("visits")
        .values({
          animal_id: v.animalId, vet_id: principal(req).userId, reason: v.reason, notes: v.notes ?? null,
          weight_kg: v.weightKg ?? null, ...(v.visitedAt && { visited_at: v.visitedAt }),
        })
        .returning(["id", "visited_at as visitedAt"])
        .executeTakeFirstOrThrow();
      if (v.weightKg !== undefined) {
        await tx.updateTable("animals").set({ weight_kg: v.weightKg, version: sql`version + 1`, updated_at: sql`now()` }).where("id", "=", v.animalId).execute();
      }
      await audit(tx, req, "create", "visit", visit.id, { animalId: v.animalId });
      return { status: 201, body: visit };
    }));
  });

  return r;
}
