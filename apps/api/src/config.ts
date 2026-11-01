import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

export function requireTlsForUpstash(url: string): string {
  const u = new URL(url);
  if (u.protocol === "redis:" && u.hostname.endsWith(".upstash.io")) u.protocol = "rediss:";
  return u.toString();
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Connection used by the API: the non-owner role that is subject to RLS. */
  DATABASE_URL: z.string().url(),
  /** Direct (unpooled) connection, as written by `neon env pull`. Used for migrations. */
  DATABASE_URL_UNPOOLED: z.string().url().optional(),
  /** Owner connection, used only by migrations. Defaults to DATABASE_URL_UNPOOLED, then DATABASE_URL. */
  MIGRATION_DATABASE_URL: z.string().url().optional(),
  /**
   * Password for APP_DB_ROLE. When set, the API connects to DATABASE_URL's host as
   * APP_DB_ROLE instead of the URL's (owner) user, and migrations create/update the role.
   */
  APP_DB_PASSWORD: z.string().min(16, "APP_DB_PASSWORD must be at least 16 characters").optional(),
  /** Role that migrations grant table privileges to. */
  APP_DB_ROLE: z.string().regex(/^[a-z_][a-z0-9_]*$/).default("vetledger_app"),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Upstash only accepts TLS; its console shows `redis://` next to `--tls`, so upgrade that. */
  REDIS_URL: z.string().url().default("redis://localhost:6379").transform(requireTlsForUpstash),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(14),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  COOKIE_SECURE: bool.default(false),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  /** Run the BullMQ worker + reminder scheduler inside the API process (free tier). */
  RUN_WORKER: bool.default(true),
  REMINDER_WEBHOOK_URL: z.string().url().optional(),
  REMINDER_SCAN_EVERY_MS: z.coerce.number().int().min(1000).default(15 * 60 * 1000),
  /**
   * Seconds an idle worker blocks waiting for jobs before polling Redis again. The
   * default 5 s is fine locally; 60 s on a metered Redis (Upstash free tier) cuts idle
   * commands ~12x. Reminders aren't latency-sensitive.
   */
  WORKER_DRAIN_DELAY_SEC: z.coerce.number().int().min(1).max(600).default(5),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(300),
  AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(10),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    // Fail fast at boot with every problem listed, instead of crashing on first use.
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
