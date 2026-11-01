import { Router } from "express";
import { z } from "zod";
import { principal, requireRole } from "../auth/middleware.js";
import type { Deps } from "../deps.js";
import { withTenant } from "../db.js";
import { conflict, notFound } from "../http/errors.js";
import { audit, send, tenantWrite } from "../http/write.js";

export function adminRouter({ db, reminderQueue }: Deps): Router {
  const r = Router();

  r.get("/reminders", async (req, res) => {
    const { status } = z.object({ status: z.enum(["pending", "queued", "sent", "failed"]).optional() }).parse(req.query);
    const rows = await withTenant(db, principal(req).clinicId, (tx) => {
      let q = tx.selectFrom("reminders as r")
        .innerJoin("animals as a", "a.id", "r.animal_id")
        .innerJoin("owners as o", "o.id", "a.owner_id")
        .select(["r.id", "r.due_on as dueOn", "r.status", "r.attempts", "r.last_error as lastError", "r.sent_at as sentAt",
          "a.id as animalId", "a.name as animalName", "o.full_name as ownerName"])
        .orderBy("r.due_on").limit(200);
      if (status) q = q.where("r.status", "=", status);
      return q.execute();
    });
    const counts = await reminderQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
    res.json({ items: rows, queue: counts });
  });

  /** Dead-letter handling: put a failed reminder back to pending for the next scan. */
  r.post("/reminders/:id/retry", requireRole("admin"), async (req, res) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    send(res, await tenantWrite(db, req, async (tx) => {
      const row = await tx.selectFrom("reminders").select(["status"]).where("id", "=", id).executeTakeFirst();
      if (!row) throw notFound("reminder");
      if (row.status !== "failed") throw conflict(`only failed reminders can be retried (status: ${row.status})`);
      await tx.updateTable("reminders").set({ status: "pending", last_error: null }).where("id", "=", id).execute();
      await audit(tx, req, "retry", "reminder", id);
      return { status: 202, body: { id, status: "pending" } };
    }));
  });

  r.get("/audit", requireRole("admin"), async (req, res) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const rows = await withTenant(db, principal(req).clinicId, (tx) =>
      tx.selectFrom("audit_log as l").leftJoin("users as u", "u.id", "l.actor_id")
        .select(["l.id", "l.at", "l.action", "l.entity", "l.entity_id as entityId", "l.data", "l.request_id as requestId", "u.full_name as actor"])
        .orderBy("l.id", "desc").limit(limit).execute(),
    );
    res.json({ items: rows });
  });

  return r;
}
