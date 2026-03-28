import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const E2E_BACKEND_PORT = 5501;
const E2E_API_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}`;

async function loginAndSeedToken(
  request: APIRequestContext,
  page: Page,
): Promise<string> {
  const response = await request.post(`${E2E_API_BASE}/api/auth/login`, {
    data: {
      username: "e2e-admin",
      password: "e2e-secret",
    },
  });

  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as { token: string };

  await page.addInitScript((token: string) => {
    window.localStorage.setItem("viewer.auth.token", token);
  }, payload.token);

  return payload.token;
}

test("viewer sends input and receives ack", async ({ page, request }) => {
  const token = await loginAndSeedToken(request, page);
  await page.goto("/");

  await page.getByRole("button", { name: "New Browser" }).click();
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(page).toHaveURL(/\/viewer\//);
  const sessionId = new URL(page.url()).pathname.split("/viewer/")[1];
  if (!sessionId) {
    throw new Error("Missing session id in viewer URL");
  }

  const viewerPage = page;
  await expect(viewerPage.getByRole("button", { name: "Home" })).toBeVisible();

  const canvas = viewerPage.locator("canvas");
  await expect(canvas).toBeVisible();

  await viewerPage.getByRole("button", { name: "More actions" }).click();
  await viewerPage.getByRole("button", { name: "Show address bar" }).click();

  const navBar = viewerPage.getByTestId("navigation-bar");
  const addressInput = viewerPage.getByTestId("address-input");
  await expect(navBar).toBeVisible();
  await addressInput.fill(`http://127.0.0.1:${E2E_BACKEND_PORT}/test/popup-auto`);
  await addressInput.press("Enter");

  const tabButtons = viewerPage.getByTestId("tab-list").getByRole("button");
  await expect(tabButtons).toHaveCount(3, { timeout: 20_000 });
  const sourceTab = tabButtons.nth(1);
  const childTab = tabButtons.nth(2);

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

  const backButton = navBar.getByRole("button", { name: "Back" });
  const forwardButton = navBar.getByRole("button", { name: "Forward" });
  const refreshButton = navBar.getByRole("button", { name: "Refresh" });

  await expect(backButton).toBeDisabled();
  await expect(forwardButton).toBeDisabled();

  await sourceTab.click();
  await expect(sourceTab).toHaveAttribute("aria-pressed", "true");
  await expect(viewerPage).toHaveURL(new RegExp(`tabId=${sourceTabId}`));

  await expect(addressInput).toHaveValue(/http/);

  await addressInput.fill(`http://127.0.0.1:${E2E_BACKEND_PORT}/test/child`);
  await addressInput.press("Enter");
  await expect(addressInput).toHaveValue(
    new RegExp(`http://127\\.0\\.0\\.1:${E2E_BACKEND_PORT}/test/child`),
  );

  await navBar.getByRole("button", { name: "Back" }).click();
  await expect(addressInput).toHaveValue(/popup-auto|child/);
  await expect(refreshButton).toBeVisible();

  await canvas.click({ position: { x: 30, y: 30 } });

  await expect
    .poll(async () => {
      const response = await request.get(
        `${E2E_API_BASE}/api/quality/session/${sessionId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );
      if (!response.ok()) {
        return null;
      }

      return (await response.json()) as {
        snapshot: {
          activeTabId: string | null;
          tabCount: number;
          reconnectCount: number;
          viewerConnected: boolean;
          milestones: Record<string, boolean>;
          firstFrameAt: string | null;
          lastAckAt: string | null;
          lastNavigationSettledAt: string | null;
          journeyStatus: string;
        };
      };
    })
    .toMatchObject({
      snapshot: {
        viewerConnected: true,
        tabCount: 3,
        milestones: {
          tabsInitialized: true,
          viewerConnected: true,
          firstFrame: true,
          inputAckWorking: true,
          navigationWorking: true,
        },
        journeyStatus: "healthy",
      },
    });

  const connectionsResponse = await request.get(
    `${E2E_API_BASE}/api/quality/session/${sessionId}/connections`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
  expect(connectionsResponse.status()).toBe(200);
  const connectionsText = await connectionsResponse.text();
  const connectionsPayload = JSON.parse(connectionsText) as {
    connectionCount?: number;
  };
  expect(typeof connectionsPayload.connectionCount).toBe("number");
  expect(connectionsPayload.connectionCount).toBeGreaterThan(0);

  const disconnectResponse = await request.post(
    `${E2E_API_BASE}/api/quality/session/${sessionId}/disconnect`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
  expect(disconnectResponse.status()).toBe(202);

  await expect(viewerPage.getByText("Reconnecting...")).toBeVisible();

  await expect.poll(async () => {
    const response = await request.get(
      `${E2E_API_BASE}/api/quality/session/${sessionId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );
    if (!response.ok()) {
      return false;
    }

    const payload = (await response.json()) as {
      snapshot: {
        reconnectCount: number;
        viewerConnected: boolean;
        milestones: Record<string, boolean>;
        journeyStatus: string;
      };
    };

    return (
      payload.snapshot.reconnectCount >= 1 &&
      payload.snapshot.viewerConnected === true &&
      payload.snapshot.milestones.reconnectRecovered === true &&
      payload.snapshot.journeyStatus === "healthy"
    );
  }).toBe(true);
});
