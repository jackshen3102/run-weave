import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

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

async function createNamedTerminalSession(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<{ terminalSessionId: string; terminalUrl: string }> {
  const response = await request.post(`${E2E_API_BASE}/api/terminal/session`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    data: {
      name,
      command: "bash",
      cwd: "/tmp",
    },
  });

  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    terminalSessionId: string;
    terminalUrl: string;
  };
}

test("creates a terminal session and streams command output", async ({
  page,
  request,
}) => {
  await loginAndSeedToken(request, page);
  await page.goto("/");

  await page.getByRole("button", { name: "Open Terminal" }).click();

  await expect(page).toHaveURL(/\/terminal\//);
  await expect(page.getByLabel("Terminal emulator")).toBeVisible();
  await page.getByLabel("Terminal emulator").click({ force: true });

  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => {
      return await page.getByLabel("Terminal output").textContent();
    })
    .toContain("/");

  await page.keyboard.type("printf 'terminal-e2e-ok\\\\n'");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => {
      return await page.getByLabel("Terminal output").textContent();
    })
    .toContain("terminal-e2e-ok");
});

test("keeps the selected terminal tab across refresh and falls back by URL", async ({
  page,
  request,
}) => {
  const token = await loginAndSeedToken(request, page);
  const suffix = `${Date.now()}`;
  const firstSession = await createNamedTerminalSession(
    request,
    token,
    `tab-keep-a-${suffix}`,
  );
  const secondSession = await createNamedTerminalSession(
    request,
    token,
    `tab-keep-b-${suffix}`,
  );

  await page.goto(firstSession.terminalUrl);

  await expect(page).toHaveURL(
    new RegExp(`/terminal/${firstSession.terminalSessionId}$`),
  );

  await page
    .getByRole("button", { name: `tab-keep-b-${suffix}`, exact: true })
    .click();

  await expect
    .poll(() => page.url())
    .toContain(`/terminal/${secondSession.terminalSessionId}`);

  await page.reload();

  await expect
    .poll(() => page.url())
    .toContain(`/terminal/${secondSession.terminalSessionId}`);
});
