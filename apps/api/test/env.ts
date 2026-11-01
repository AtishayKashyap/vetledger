/** Test infrastructure URLs: CI provides service containers; locally these defaults match the README setup. */
export const TEST_ENV = {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://vetledger_app:app@localhost:5432/vetledger_test",
  MIGRATION_DATABASE_URL: process.env.TEST_MIGRATION_DATABASE_URL ?? "postgres://vetledger_owner:owner@localhost:5432/vetledger_test",
  REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1",
  JWT_SECRET: "test-secret-test-secret-test-secret-123",
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  RUN_WORKER: "false",
  RATE_LIMIT_PER_MIN: "10000",
  AUTH_RATE_LIMIT_PER_MIN: "10000",
};
