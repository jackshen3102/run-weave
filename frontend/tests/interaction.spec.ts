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
  const sourceTab = viewerPage.getByRole("button", {
    name: "Popup Auto Source",
  });
  const childTab = viewerPage.getByRole("button", { name: "Popup Child" });

  await expect(sourceTab).toBeVisible({ timeout: 20_000 });
  await expect(childTab).toBeVisible({ timeout: 20_000 });

  const sourceTabId = await sourceTab.getAttribute("data-tab-id");
  const childTabId = await childTab.getAttribute("data-tab-id");
  if (!sourceTabId || !childTabId) {
    throw new Error("Missing tab id from tab buttons");
  }

  await sourceTab.click();
  await expect(sourceTab).toHaveAttribute("aria-pressed", "true");
  await expect(viewerPage).toHaveURL(new RegExp(`tabId=${sourceTabId}`));

  await childTab.click();
  await expect(childTab).toHaveAttribute("aria-pressed", "true");
  await expect(viewerPage).toHaveURL(new RegExp(`tabId=${childTabId}`));

  const navBar = viewerPage.getByTestId("navigation-bar");
  const backButton = navBar.getByRole("button", { name: "Back" });
  const forwardButton = navBar.getByRole("button", { name: "Forward" });
  const refreshButton = navBar.getByRole("button", { name: "Refresh" });

  await expect(backButton).toBeDisabled();
  await expect(forwardButton).toBeDisabled();

  await sourceTab.click();
  await expect(sourceTab).toHaveAttribute("aria-pressed", "true");
  await expect(viewerPage).toHaveURL(new RegExp(`tabId=${sourceTabId}`));

  const addressInput = viewerPage.getByTestId("address-input");
  await expect(navBar).toBeVisible();
  await expect(addressInput).toHaveValue(/http/);

  await addressInput.fill(`127.0.0.1:${E2E_BACKEND_PORT}/test/child`);
  await addressInput.press("Enter");
  await expect(addressInput).toHaveValue(
    new RegExp(`https?://127\\.0\\.0\\.1:${E2E_BACKEND_PORT}/test/child`),
  );

  await navBar.getByRole("button", { name: "Back" }).click();
  await expect(addressInput).toHaveValue(/popup-auto|child/);

  await navBar.getByRole("button", { name: "Forward" }).click();
  await expect(addressInput).toHaveValue(
    new RegExp(`https?://127\\.0\\.0\\.1:${E2E_BACKEND_PORT}/test/child`),
  );

  await refreshButton.click();

  await canvas.click({ position: { x: 30, y: 30 } });

  await expect(viewerPage.getByTestId("ws-stats")).toContainText(
    /Sent:\s*[3-9]/,
  );
  await expect(viewerPage.getByTestId("ws-stats")).toContainText(
    /Ack:\s*[1-9]/,
  );
});
