import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const E2E_BACKEND_PORT = 5501;
const E2E_API_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}`;

async function seedElectronConnections(
  page: Page,
  options: {
    activeId: string;
    connections: Array<{ id: string; name: string; url: string }>;
  },
): Promise<void> {
  await page.addInitScript(({ activeId, connections }) => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        isElectron: true,
        managesPackagedBackend: false,
        platform: "darwin",
      },
    });

    window.localStorage.setItem(
      "viewer.connections",
      JSON.stringify({
        activeId,
        connections: connections.map((connection) => ({
          ...connection,
          createdAt: Date.now(),
        })),
      }),
    );
    window.localStorage.setItem(
      "viewer.auth.connection-auth",
      JSON.stringify(
        Object.fromEntries(
          connections.map((connection) => [
            connection.id,
            {
              accessToken: `token-${connection.id}`,
              accessExpiresAt: Date.now() + 15 * 60 * 1000,
              refreshToken: `refresh-${connection.id}`,
              sessionId: `session-${connection.id}`,
            },
          ]),
        ),
      ),
    );
  }, options);
}

async function mockHomeConnectionApi(
  page: Page,
  options: {
    url: string;
    expectedToken: string;
    onSessionList?: () => void;
  },
): Promise<void> {
  const escapedUrl = options.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.route(new RegExp(`^${escapedUrl}/api/.*`), async (route) => {
    const request = route.request();
    const headers = {
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Origin": "*",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }

    const requestUrl = new URL(request.url());
    const authorization = request.headers().authorization;
    if (
      requestUrl.pathname !== "/api/auth/verify" &&
      authorization !== `Bearer ${options.expectedToken}`
    ) {
      await route.fulfill({
        status: 401,
        headers,
        json: { message: "Wrong token" },
      });
      return;
    }

    if (requestUrl.pathname === "/api/auth/verify") {
      await route.fulfill({
        status: 200,
        headers,
        json: { valid: true },
      });
      return;
    }

    if (requestUrl.pathname === "/api/session") {
      options.onSessionList?.();
      await route.fulfill({
        status: 200,
        headers,
        json: [],
      });
      return;
    }

    if (requestUrl.pathname === "/api/session/cdp-endpoint-default") {
      await route.fulfill({
        status: 200,
        headers,
        json: { endpoint: null },
      });
      return;
    }

    await route.fulfill({
      status: 404,
      headers,
      json: { message: "Not mocked" },
    });
  });
}

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
  const payload = (await response.json()) as {
    accessToken: string;
    expiresIn: number;
    sessionId: string;
  };

  await page.addInitScript(({ accessToken, expiresIn, sessionId }) => {
    const session = {
      accessToken,
      accessExpiresAt: Date.now() + expiresIn * 1000,
      sessionId,
    };
    window.localStorage.setItem("viewer.auth.token", JSON.stringify(session));
  }, payload);

  return payload.accessToken;
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

test("switches Electron connections on home without reusing the previous token", async ({
  page,
}) => {
  const connectionA = {
    id: "connection-a",
    name: "Connection A",
    url: "http://home-a.test",
  };
  const connectionB = {
    id: "connection-b",
    name: "Connection B",
    url: "http://home-b.test",
  };
  let listedConnectionB = false;

  await seedElectronConnections(page, {
    activeId: connectionA.id,
    connections: [connectionA, connectionB],
  });
  await mockHomeConnectionApi(page, {
    url: connectionA.url,
    expectedToken: `token-${connectionA.id}`,
  });
  await mockHomeConnectionApi(page, {
    url: connectionB.url,
    expectedToken: `token-${connectionB.id}`,
    onSessionList: () => {
      listedConnectionB = true;
    },
  });

  await page.goto("/");
  await expect(page.getByText("Browser Viewer")).toBeVisible();
  await expect(page.getByRole("button", { name: /Connection A/ })).toBeVisible();

  await page.getByRole("button", { name: /Connection A/ }).click();
  await page.getByRole("menuitem", { name: /Connection B/ }).click();

  await expect(page.getByRole("button", { name: /Connection B/ })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
  await expect.poll(() => listedConnectionB).toBe(true);
});
