import { expect, test } from "@playwright/test";

test("vet registers a patient, vaccinates it and a booster reminder is scheduled", async ({ page }) => {
  const name = `E2E-${Date.now().toString(36)}`;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // Login
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill("vet@sunrise.vet");
  await page.getByLabel("Password").fill("vetledger-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
  await expect(page.getByText("Vaccinations due · next 14 days")).toBeVisible();

  // Register a patient
  await page.getByRole("link", { name: "Patients" }).click();
  await page.getByRole("button", { name: "+ New patient" }).click();
  await page.getByLabel("Owner").selectOption({ index: 1 });
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Species").selectOption("dog");
  await page.getByLabel("Weight (kg)").fill("18.4");
  await page.getByRole("button", { name: "Register" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();

  // Vaccinate with a 21-day booster
  const vaccine = page.getByLabel("Vaccine");
  const rabies = await vaccine.locator("option", { hasText: "Rabies" }).getAttribute("value");
  await vaccine.selectOption(rabies ?? "");
  await page.getByLabel("Booster in (days)").fill("21");
  await page.getByRole("button", { name: "Record vaccination" }).click();
  await expect(page.getByText(/Recorded\. Lot picked FEFO; reminder scheduled/)).toBeVisible();
  await expect(page.getByText("reminder pending")).toBeVisible();

  // The reminder is visible in the reminders pipeline
  await page.getByRole("link", { name: "Reminders" }).click();
  await page.getByRole("tab", { name: "pending" }).click();
  await expect(page.getByRole("link", { name })).toBeVisible();

  // Session survives a reload (in-memory token restored via httpOnly refresh cookie)
  await page.reload();
  await expect(page.getByRole("link", { name })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a technician cannot see admin-only areas, and validation errors are shown inline", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("tech@sunrise.vet");
  await page.getByLabel("Password").fill("vetledger-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Audit log" })).toHaveCount(0);
  await page.getByRole("link", { name: "Patients" }).click();
  await page.getByRole("button", { name: "+ New patient" }).click();
  await page.getByRole("button", { name: "Register" }).click();
  await expect(page.getByText("choose an owner")).toBeVisible();
});

test("wrong password shows a generic error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("vet@sunrise.vet");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText(/invalid email or password/);
});
