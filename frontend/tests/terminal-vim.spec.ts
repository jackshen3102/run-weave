import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const E2E_BACKEND_PORT = 5501;
const E2E_API_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}`;
const TERMINAL_PREFERENCES_KEY = `viewer.terminal.preferences.${E2E_API_BASE}`;

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

async function createTerminalSession(
  request: APIRequestContext,
  token: string,
): Promise<{ terminalSessionId: string; terminalUrl: string }> {
  const response = await request.post(`${E2E_API_BASE}/api/terminal/session`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    data: {
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

async function getLiveTerminalText(page: Page): Promise<string> {
  const rowTexts = await page.locator(".xterm-rows").evaluateAll((elements) => {
    return elements
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left >= 0
        );
      })
      .map((element) => element.textContent ?? "");
  });
  if (rowTexts.length > 0) {
    return rowTexts.join("\n");
  }

  return (await page.getByLabel("Terminal output").textContent()) ?? "";
}

test("supports vim write/exit and preserves interaction through resize", async ({
  page,
  request,
}) => {
  const targetPath = "/tmp/viewer-vim-e2e.txt";

  const token = await loginAndSeedToken(request, page);
  const session = await createTerminalSession(request, token);
  await page.addInitScript((preferencesKey) => {
    window.localStorage.setItem(
      preferencesKey,
      JSON.stringify({ renderer: "dom", screenReaderMode: true }),
    );
  }, TERMINAL_PREFERENCES_KEY);

  await page.goto(session.terminalUrl);
  await expect(page).toHaveURL(/\/terminal\//);
  await page.getByLabel("Terminal emulator").click({ force: true });

  await page.keyboard.type(`vim ${targetPath}`);
  await page.keyboard.press("Enter");

  await page.keyboard.press("i");
  await page.keyboard.type("viewer-vim-e2e");
  await page.setViewportSize({ width: 1180, height: 840 });
  await page.keyboard.type("-after-resize");
  await page.keyboard.press("Escape");
  await page.keyboard.type(":wq");
  await page.keyboard.press("Enter");

  await page.keyboard.type(`cat ${targetPath}`);
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => {
      return await getLiveTerminalText(page);
    })
    .toContain("viewer-vim-e2e-after-resize");
});

test("preserves vim screen and input after page refresh", async ({
  page,
  request,
}) => {
  const targetPath = `/tmp/viewer-vim-refresh-e2e-${Date.now()}.txt`;

  const token = await loginAndSeedToken(request, page);
  const session = await createTerminalSession(request, token);
  await page.addInitScript((preferencesKey) => {
    window.localStorage.setItem(
      preferencesKey,
      JSON.stringify({ renderer: "dom", screenReaderMode: true }),
    );
  }, TERMINAL_PREFERENCES_KEY);

  await page.goto(session.terminalUrl);
  await expect(page).toHaveURL(/\/terminal\//);
  await page.getByLabel("Terminal emulator").click({ force: true });

  await page.keyboard.type(`vim ${targetPath}`);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => {
      return await getLiveTerminalText(page);
    })
    .toContain(pathBasename(targetPath));

  await page.keyboard.press("i");
  await expect
    .poll(async () => {
      return await getLiveTerminalText(page);
    })
    .toContain("INSERT");
  await page.keyboard.type("viewer-vim-refresh");
  await expect
    .poll(async () => {
      return await getLiveTerminalText(page);
    })
    .toContain("viewer-vim-refresh");

  await page.reload();
  await expect(page).toHaveURL(/\/terminal\//);
  await expect
    .poll(async () => {
      return await getLiveTerminalText(page);
    })
    .toContain("viewer-vim-refresh");

  await page.getByLabel("Terminal emulator").click({ force: true });
  await page.keyboard.type("-after-page-reload");
  await page.keyboard.press("Escape");
  await page.keyboard.type(":wq");
  await page.keyboard.press("Enter");

  await page.keyboard.type(`cat ${targetPath}`);
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => {
      return await getLiveTerminalText(page);
    })
    .toContain("viewer-vim-refresh-after-page-reload");
});

function pathBasename(value: string): string {
  return value.split("/").at(-1) ?? value;
}
