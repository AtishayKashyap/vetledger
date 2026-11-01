import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./observability/logger.js";
import type { Metrics } from "./observability/metrics.js";

export interface Deps {
  config: Config;
  db: Db;
  redis: Redis;
  reminderQueue: Queue;
  metrics: Metrics;
  logger: Logger;
}
