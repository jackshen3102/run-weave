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

test("control panel page loads", async ({ page, request }) => {
  const token = await loginAndSeedToken(request, page);
  await page.goto("/");
  await expect(page.getByText("Browser Viewer")).toBeVisible();
  await expect(page.getByText("Sessions", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New Browser" })).toBeVisible();

  const createSessionResponse = await request.post(
    `${E2E_API_BASE}/api/session`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      data: {
        url: `http://127.0.0.1:${E2E_BACKEND_PORT}/test/child`,
        source: {
          type: "launch",
          proxyEnabled: false,
        },
      },
    },
  );
  expect(createSessionResponse.ok()).toBe(true);
  const createSessionPayload = (await createSessionResponse.json()) as {
    sessionId: string;
  };

  const qualityResponse = await request.get(
    `${E2E_API_BASE}/api/quality/session/${createSessionPayload.sessionId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
  expect(qualityResponse.status()).toBe(200);
  await expect(qualityResponse.json()).resolves.toMatchObject({
    snapshot: {
      sessionId: createSessionPayload.sessionId,
      journeyStatus: "running",
      viewerConnected: false,
      tabCount: 0,
      milestones: {
        viewerConnected: false,
        firstFrame: false,
        inputAckWorking: false,
        navigationWorking: false,
      },
    },
    timeline: [
      {
        type: "session.created",
      },
    ],
  });

  const deleteSessionResponse = await request.delete(
    `${E2E_API_BASE}/api/session/${createSessionPayload.sessionId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
  expect(deleteSessionResponse.status()).toBe(204);
});
