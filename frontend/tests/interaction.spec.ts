import { expect, test } from "@playwright/test";

test("viewer sends input and receives ack", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Target URL").fill("http://127.0.0.1:3100/health");
  await page.getByRole("button", { name: "Create Session" }).click();

  await expect(page.getByRole("button", { name: "Open Viewer" })).toBeVisible({ timeout: 20_000 });

  const [viewerPage] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Open Viewer" }).click(),
  ]);

  await viewerPage.waitForLoadState("domcontentloaded");
  await expect(viewerPage.getByText("Live Viewer")).toBeVisible();
  await expect(viewerPage.getByText("Status: connected")).toBeVisible();

  const canvas = viewerPage.locator("canvas");
  await expect(canvas).toBeVisible();
  await canvas.click({ position: { x: 40, y: 40 } });

  await expect(viewerPage.getByTestId("ws-stats")).toContainText("Sent: 1");
  await expect(viewerPage.getByTestId("ws-stats")).toContainText(/Ack:\s*[1-9]/);
});
