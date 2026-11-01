import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import { sql } from "kysely";
import { withTenant, type Db } from "../db.js";
import type { Logger } from "../observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import { todayUtc } from "../services/inventory.js";

export const QUEUE = "reminders";
export const SEND_ATTEMPTS = 5;

export interface SendJob {
  reminderId: string;
  clinicId: string;
}

export interface ReminderMessage {
  reminderId: string;
  clinic: string;
  animal: string;
  species: string;
  owner: string;
  ownerEmail: string | null;
  ownerPhone: string | null;
  vaccine: string;
  dueOn: string;
}

/** Delivery channel. A webhook in production; tests inject their own. */
export type Deliver = (msg: ReminderMessage) => Promise<void>;

export function webhookDeliver(url: string | undefined, log: Logger): Deliver {
  return async (msg) => {
    if (!url) {
      // No channel configured (e.g. local dev): record that we would have sent it.
      log.info({ reminder: msg }, "reminder delivered (log channel)");
      return;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": msg.reminderId },
      body: JSON.stringify({ type: "vaccination.reminder", ...msg }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  };
}

export function createReminderQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: SEND_ATTEMPTS,
      backoff: { type: "exponential", delay: 30_000 }, // 30s, 1m, 2m, 4m
      removeOnComplete: { count: 1000 },
      removeOnFail: false, // keep failed jobs: they are the dead-letter record
    },
  });
}

/**
 * Claim due reminders (atomically, across all clinics, via a SECURITY DEFINER function
 * that uses FOR UPDATE SKIP LOCKED) and enqueue one job each. jobId = reminder id, so
 * even if two scans overlap, BullMQ refuses the duplicate and the owner gets one message.
 */
export async function scanDueReminders(db: Db, queue: Queue, today = todayUtc(), limit = 500): Promise<number> {
  const { rows } = await sql<{ id: string; clinic_id: string }>`
    SELECT id, clinic_id FROM claim_due_reminders(${today}::date, ${limit})`.execute(db);
  if (rows.length === 0) return 0;
  await queue.addBulk(
    rows.map((r) => ({ name: "send", data: { reminderId: r.id, clinicId: r.clinic_id } satisfies SendJob, opts: { jobId: `reminder-${r.id}` } })),
  );
  return rows.length;
}

export async function loadMessage(db: Db, job: SendJob): Promise<ReminderMessage | null> {
  return withTenant(db, job.clinicId, async (tx) => {
    const row = await tx
      .selectFrom("reminders as r")
      .innerJoin("animals as a", "a.id", "r.animal_id")
      .innerJoin("owners as o", "o.id", "a.owner_id")
      .innerJoin("vaccinations as v", "v.id", "r.vaccination_id")
      .innerJoin("products as p", "p.id", "v.product_id")
      .innerJoin("clinics as c", "c.id", "r.clinic_id")
      .select(["r.id", "r.status", "r.due_on", "a.name as animal", "a.species", "o.full_name as owner", "o.email", "o.phone", "p.name as vaccine", "c.name as clinic"])
      .where("r.id", "=", job.reminderId)
      .executeTakeFirst();
    if (!row || row.status === "sent") return null; // already handled: idempotent no-op
    return {
      reminderId: row.id, clinic: row.clinic, animal: row.animal, species: row.species, owner: row.owner,
      ownerEmail: row.email, ownerPhone: row.phone, vaccine: row.vaccine, dueOn: row.due_on,
    };
  });
}

export async function processSend(db: Db, deliver: Deliver, job: Pick<Job<SendJob>, "data" | "attemptsMade">): Promise<"sent" | "skipped"> {
  const msg = await loadMessage(db, job.data);
  if (!msg) return "skipped";
  try {
    await deliver(msg);
  } catch (err) {
    await withTenant(db, job.data.clinicId, (tx) =>
      tx.updateTable("reminders")
        .set({ attempts: sql`attempts + 1`, last_error: String((err as Error).message).slice(0, 500) })
        .where("id", "=", job.data.reminderId).execute(),
    );
    throw err; // let BullMQ schedule the retry with backoff
  }
  await withTenant(db, job.data.clinicId, (tx) =>
    tx.updateTable("reminders")
      .set({ status: "sent", sent_at: sql`now()`, attempts: sql`attempts + 1`, last_error: null })
      .where("id", "=", job.data.reminderId).execute(),
  );
  return "sent";
}

/** After the final retry, move the reminder to `failed` (the dead-letter state). */
export async function markFailed(db: Db, data: SendJob, error: string): Promise<void> {
  await withTenant(db, data.clinicId, (tx) =>
    tx.updateTable("reminders").set({ status: "failed", last_error: error.slice(0, 500) })
      .where("id", "=", data.reminderId).where("status", "!=", "sent").execute(),
  );
}

export interface ReminderWorkerOptions {
  db: Db;
  queue: Queue;
  connection: ConnectionOptions;
  deliver: Deliver;
  logger: Logger;
  metrics: Metrics;
  scanEveryMs: number;
}

export async function startReminderWorker(o: ReminderWorkerOptions): Promise<Worker> {
  // A BullMQ job scheduler (stored in Redis) rather than setInterval: exactly one scan
  // fires per interval no matter how many API instances are running.
  await o.queue.upsertJobScheduler("scan-due-reminders", { every: o.scanEveryMs }, { name: "scan" });

  const worker = new Worker<SendJob | Record<string, never>>(
    QUEUE,
    async (job) => {
      if (job.name === "scan") {
        const n = await scanDueReminders(o.db, o.queue);
        if (n) o.logger.info({ claimed: n }, "reminders enqueued");
        return n;
      }
      const outcome = await processSend(o.db, o.deliver, job as Job<SendJob>);
      o.metrics.remindersSent.inc({ outcome });
      return outcome;
    },
    { connection: o.connection, concurrency: 5 },
  );

  worker.on("failed", (job, err) => {
    if (!job || job.name !== "send") return;
    const final = job.attemptsMade >= (job.opts.attempts ?? 1);
    o.metrics.remindersSent.inc({ outcome: final ? "dead_letter" : "retry" });
    o.logger.warn({ jobId: job.id, attempt: job.attemptsMade, final, err: err.message }, "reminder delivery failed");
    if (final) void markFailed(o.db, job.data as SendJob, err.message).catch((e: unknown) => o.logger.error({ err: e }, "markFailed"));
  });

  // Queue depth gauge for /metrics (alert if `waiting` keeps growing).
  const depth = setInterval(() => {
    o.queue.getJobCounts("waiting", "active", "delayed", "failed").then((c) => {
      for (const [state, n] of Object.entries(c)) o.metrics.queueDepth.set({ state }, n);
    }).catch(() => undefined);
  }, 15_000);
  depth.unref();
  worker.on("closed", () => clearInterval(depth));
  return worker;
}
