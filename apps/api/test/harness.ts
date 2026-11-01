import { Redis } from "ioredis";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, type Db } from "../src/db.js";
import { createReminderQueue } from "../src/jobs/reminders.js";
import { createLogger } from "../src/observability/logger.js";
import { createMetrics } from "../src/observability/metrics.js";
import { DEMO_PASSWORD, seed } from "../src/seed.js";
import { TEST_ENV } from "./env.js";

export interface Harness {
  app: Express;
  db: Db;
  owner: Db;
  redis: Redis;
  queries: string[];
  deps: Parameters<typeof createApp>[0];
  login: (email: string) => Promise<string>;
  close: () => Promise<void>;
}

/** Real Postgres + Redis, freshly seeded. Every query the app makes is recorded in `queries`. */
export async function createHarness(opts: { animalsPerClinic?: number } = {}): Promise<Harness> {
  const config = loadConfig({ ...process.env, ...TEST_ENV });
  const queries: string[] = [];
  const { db } = createDb(config.DATABASE_URL, 25, (q) => queries.push(q));
  const { db: owner } = createDb(TEST_ENV.MIGRATION_DATABASE_URL, 2);
  await seed(owner, { animalsPerClinic: opts.animalsPerClinic ?? 12 });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  await redis.flushdb();
  const reminderQueue = createReminderQueue({ url: config.REDIS_URL });
  const deps = { config, db, redis, reminderQueue, metrics: createMetrics(), logger: createLogger("silent") };
  const app = await createApp(deps);
  return {
    app, db, owner, redis, queries, deps,
    login: async (email) => {
      const res = await request(app).post("/api/auth/login").send({ email, password: DEMO_PASSWORD }).expect(200);
      return res.body.accessToken as string;
    },
    close: async () => {
      await reminderQueue.close();
      await redis.quit();
      await db.destroy();
      await owner.destroy();
    },
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
