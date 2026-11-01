import { migrate } from "../src/migrate.js";
import { TEST_ENV } from "./env.js";

export default async function setup() {
  await migrate(TEST_ENV.MIGRATION_DATABASE_URL, "vetledger_app", () => undefined);
}
