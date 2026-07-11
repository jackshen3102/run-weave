import { expect, test } from "@playwright/test";

test("logs in and opens the terminal workspace", async ({ page }) => {
  await page.goto("/login");

  await page.getByLabel("Username").fill("runweave-e2e");
  await page.getByLabel("Password").fill("runweave-e2e-password");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(/\/terminal$/);
  await expect(
    page.getByRole("button", { name: "New Terminal" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "New Project" })).toBeVisible();
});
