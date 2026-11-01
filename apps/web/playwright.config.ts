import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against the real stack. The API (with a seeded database) must be running on
 * :4000; Playwright starts the Vite dev server, which proxies /api same-origin.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: { command: "pnpm vite --port 5173 --strictPort", url: "http://localhost:5173", reuseExistingServer: !process.env.CI },
});
