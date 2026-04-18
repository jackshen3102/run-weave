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

async function createNamedTerminalSession(
  request: APIRequestContext,
  token: string,
  name: string,
  options: { command?: string; args?: string[]; projectId?: string } = {},
): Promise<{ terminalSessionId: string; terminalUrl: string }> {
  const response = await request.post(`${E2E_API_BASE}/api/terminal/session`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    data: {
      projectId: options.projectId,
      name,
      command: options.command ?? "bash",
      args: options.args,
      cwd: "/tmp",
    },
  });

  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    terminalSessionId: string;
    terminalUrl: string;
  };
}

async function getTerminalScrollback(
  request: APIRequestContext,
  token: string,
  terminalSessionId: string,
): Promise<string> {
  const response = await request.get(
    `${E2E_API_BASE}/api/terminal/session/${encodeURIComponent(terminalSessionId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as { scrollback: string };
  return payload.scrollback;
}

async function getLiveTerminalText(page: Page): Promise<string> {
  const rowTexts = await page.locator(".xterm-rows").evaluateAll((elements) => {
    return elements
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left >= 0;
      })
      .map((element) => element.textContent ?? "");
  });
  if (rowTexts.length > 0) {
    return rowTexts.join("\n");
  }

  return (await page.getByLabel("Terminal output").textContent()) ?? "";
}

test("creates a terminal session and streams command output", async ({
  page,
  request,
}) => {
  const token = await loginAndSeedToken(request, page);
  const session = await createNamedTerminalSession(
    request,
    token,
    `stream-${Date.now()}`,
  );
  await page.addInitScript((preferencesKey) => {
    window.localStorage.setItem(
      preferencesKey,
      JSON.stringify({ renderer: "dom", screenReaderMode: true }),
    );
  }, TERMINAL_PREFERENCES_KEY);

  await page.goto(session.terminalUrl);
  await expect(page).toHaveURL(/\/terminal\//);
  await expect(page.getByLabel("Terminal emulator")).toBeVisible();
  await page.getByLabel("Terminal emulator").click({ force: true });

  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => {
      return await getLiveTerminalText(page);
    })
    .toContain("/");

  await page.keyboard.type("printf 'terminal-e2e-ok\\\\n'");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => {
      return await getLiveTerminalText(page);
    })
    .toContain("terminal-e2e-ok");
});

test("fits the terminal pane to the available viewport", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1780, height: 900 });
  const token = await loginAndSeedToken(request, page);
  const session = await createNamedTerminalSession(
    request,
    token,
    `fit-${Date.now()}`,
  );
  await page.addInitScript((preferencesKey) => {
    window.localStorage.setItem(
      preferencesKey,
      JSON.stringify({ renderer: "dom", screenReaderMode: true }),
    );
  }, TERMINAL_PREFERENCES_KEY);

  await page.goto(session.terminalUrl);
  await page.getByLabel("Terminal emulator").click({ force: true });
  await page.keyboard.type("printf '__SIZE__ '; stty size; printf '__END__\\n'");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => {
      const text = await getLiveTerminalText(page);
      const match = text.match(/__SIZE__\s+(\d+)\s+(\d+)/);
      if (!match) {
        return null;
      }
      return {
        rows: Number(match[1]),
        cols: Number(match[2]),
      };
    })
    .toEqual(
      expect.objectContaining({
        rows: expect.any(Number),
        cols: expect.any(Number),
      }),
    );

  const text = await getLiveTerminalText(page);
  const match = text.match(/__SIZE__\s+(\d+)\s+(\d+)/);
  expect(match).not.toBeNull();
  const rows = Number(match?.[1]);
  const cols = Number(match?.[2]);
  expect(rows).toBeGreaterThan(30);
  expect(cols).toBeGreaterThan(120);
});

test("keeps the selected terminal tab across refresh and falls back by URL", async ({
  page,
  request,
}) => {
  const token = await loginAndSeedToken(request, page);
  const suffix = `${Date.now()}`;
  const projectResponse = await request.post(`${E2E_API_BASE}/api/terminal/project`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    data: {
      name: `Tab Keep Project ${suffix}`,
    },
  });
  expect(projectResponse.ok()).toBe(true);
  const project = (await projectResponse.json()) as { projectId: string };
  const firstSession = await createNamedTerminalSession(
    request,
    token,
    `tab-keep-a-${suffix}`,
    { projectId: project.projectId, command: "tail", args: ["-f", "/dev/null"] },
  );
  const secondSession = await createNamedTerminalSession(
    request,
    token,
    `tab-keep-b-${suffix}`,
    { projectId: project.projectId, command: "tail", args: ["-f", "/dev/null"] },
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

test("restores deferred background terminal output when selected", async ({
  page,
  request,
}) => {
  const token = await loginAndSeedToken(request, page);
  const suffix = `${Date.now()}`;
  const backgroundMarker = `inactive-restore-${suffix}`;
  await page.addInitScript((preferencesKey) => {
    window.localStorage.setItem(
      preferencesKey,
      JSON.stringify({ renderer: "dom", screenReaderMode: true }),
    );
  }, TERMINAL_PREFERENCES_KEY);
  const activeSession = await createNamedTerminalSession(
    request,
    token,
    `inactive-active-${suffix}`,
  );
  const backgroundSession = await createNamedTerminalSession(
    request,
    token,
    `inactive-bg-${suffix}`,
    {
      command: "bash",
      args: ["-lc", `printf '${backgroundMarker}\\n'; sleep 60`],
    },
  );

  await expect
    .poll(() =>
      getTerminalScrollback(request, token, backgroundSession.terminalSessionId),
    )
    .toContain(backgroundMarker);

  await page.goto(activeSession.terminalUrl);
  await expect(page.getByLabel("Terminal emulator").first()).toBeVisible();

  await page
    .getByRole("button", { name: `inactive-bg-${suffix}`, exact: true })
    .click();
  await expect
    .poll(() => page.url())
    .toContain(`/terminal/${backgroundSession.terminalSessionId}`);

  await expect.poll(() => getLiveTerminalText(page)).toContain(backgroundMarker);
});
