import { startTracing } from "./observability/tracing.js";
// Tracing must start before express/pg are loaded so they can be instrumented.
const tracing = startTracing();

const { Redis } = await import("ioredis");
const { createApp } = await import("./app.js");
const { loadConfig } = await import("./config.js");
const { createDb } = await import("./db.js");
const { createReminderQueue, startReminderWorker, webhookDeliver } = await import("./jobs/reminders.js");
const { createLogger } = await import("./observability/logger.js");
const { createMetrics } = await import("./observability/metrics.js");

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const { db } = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
// BullMQ requires maxRetriesPerRequest: null on its connections.
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const connection = { url: config.REDIS_URL };
const reminderQueue = createReminderQueue(connection);
const metrics = createMetrics();

const app = await createApp({ config, db, redis, reminderQueue, metrics, logger });
const worker = config.RUN_WORKER
  ? await startReminderWorker({
      db, queue: reminderQueue, connection, metrics, logger,
      deliver: webhookDeliver(config.REMINDER_WEBHOOK_URL, logger),
      scanEveryMs: config.REMINDER_SCAN_EVERY_MS,
    })
  : null;

const server = app.listen(config.PORT, () => logger.info({ port: config.PORT, worker: !!worker }, "vetledger api listening"));

// Graceful shutdown: stop accepting, let in-flight requests and jobs finish, then close.
let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  logger.info({ signal }, "shutting down");
  const force = setTimeout(() => process.exit(1), 15_000).unref();
  server.close();
  await worker?.close();
  await reminderQueue.close();
  await redis.quit();
  await db.destroy();
  await tracing?.shutdown();
  clearTimeout(force);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
