import { expect, test } from "@playwright/test";

const E2E_BACKEND_PORT = 5501;

test("viewer sends input and receives ack", async ({ page }) => {
  await page.goto("/");

  await page
    .getByLabel("Target URL")
    .fill(`http://127.0.0.1:${E2E_BACKEND_PORT}/test/popup-auto`);
  await page.getByRole("button", { name: "Create Session" }).click();

  await expect(page.getByRole("button", { name: "Open Viewer" })).toBeVisible({
    timeout: 20_000,
  });

  const [viewerPage] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Open Viewer" }).click(),
  ]);

  await viewerPage.waitForLoadState("domcontentloaded");
  await expect(viewerPage.getByText("Live Viewer")).toBeVisible();
  await expect(viewerPage.getByText("Status: connected")).toBeVisible();

  const canvas = viewerPage.locator("canvas");
  await expect(canvas).toBeVisible();
  const tabs = viewerPage.getByTestId("tab-list").locator("button");
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });
  const sourceTab = viewerPage.getByRole("button", {
    name: "Popup Auto Source",
  });
  const childTab = viewerPage.getByRole("button", { name: "Popup Child" });

  await expect(sourceTab).toBeVisible();
  await expect(childTab).toBeVisible();

  await expect(sourceTab).toHaveAttribute("aria-pressed", "true");
  await childTab.click();
  await expect(childTab).toHaveAttribute("aria-pressed", "true");
  await sourceTab.click();
  await expect(sourceTab).toHaveAttribute("aria-pressed", "true");

  await canvas.click({ position: { x: 30, y: 30 } });

  await expect(viewerPage.getByTestId("ws-stats")).toContainText(
    /Sent:\s*[3-9]/,
  );
  await expect(viewerPage.getByTestId("ws-stats")).toContainText(
    /Ack:\s*[1-9]/,
  );
});
