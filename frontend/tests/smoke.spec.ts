import { expect, test } from "@playwright/test";

test("control panel page loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Browser Viewer Control Panel")).toBeVisible();
});
