import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const E2E_BACKEND_PORT = 5501;
const E2E_API_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}`;
const TERMINAL_PREFERENCES_KEY = `viewer.terminal.preferences.${E2E_API_BASE}`;

interface TerminalSessionStatusResponse {
  terminalSessionId: string;
  projectId: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  scrollback: string;
  status: "running" | "exited";
  createdAt: string;
  exitCode?: number;
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

async function createTerminalSession(
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

async function getTerminalSession(
  request: APIRequestContext,
  token: string,
  terminalSessionId: string,
): Promise<TerminalSessionStatusResponse> {
  const response = await request.get(
    `${E2E_API_BASE}/api/terminal/session/${encodeURIComponent(terminalSessionId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  expect(response.ok()).toBe(true);
  return (await response.json()) as TerminalSessionStatusResponse;
}

async function getVisibleTerminalText(page: Page): Promise<string> {
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

  return (await page.getByLabel("Terminal output").first().textContent()) ?? "";
}

test("keeps live output when delayed HTTP snapshot returns", async ({
  page,
  request,
}) => {
  const token = await loginAndSeedToken(request, page);
  const suffix = `${Date.now()}`;
  const liveMarker = `snapshot-race-live-${suffix}`;
  const staleMarker = `snapshot-race-stale-${suffix}`;
  const session = await createTerminalSession(request, token, `race-${suffix}`);
  const initialStatus = await getTerminalSession(
    request,
    token,
    session.terminalSessionId,
  );

  await page.addInitScript((preferencesKey) => {
    window.localStorage.setItem(
      preferencesKey,
      JSON.stringify({ renderer: "dom", screenReaderMode: true }),
    );
  }, TERMINAL_PREFERENCES_KEY);

  let releaseHttpSnapshot!: () => void;
  const releaseHttpSnapshotPromise = new Promise<void>((resolve) => {
    releaseHttpSnapshot = resolve;
  });
  let markHttpSnapshotReturned!: () => void;
  const httpSnapshotReturnedPromise = new Promise<void>((resolve) => {
    markHttpSnapshotReturned = resolve;
  });

  await page.route(
    `${E2E_API_BASE}/api/terminal/session/${encodeURIComponent(session.terminalSessionId)}`,
    async (route) => {
      await releaseHttpSnapshotPromise;
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          ...initialStatus,
          scrollback: `${staleMarker}\n`,
        } satisfies TerminalSessionStatusResponse),
      });
      markHttpSnapshotReturned();
    },
  );

  await page.goto(session.terminalUrl);
  await expect(page.getByLabel("Terminal emulator").first()).toBeVisible();
  await page.getByLabel("Terminal emulator").first().click({ force: true });
  await page.keyboard.type(`printf '${liveMarker}\\n'`);
  await page.keyboard.press("Enter");

  await expect.poll(() => getVisibleTerminalText(page)).toContain(liveMarker);

  releaseHttpSnapshot();
  await httpSnapshotReturnedPromise;

  const terminalTextAfterHttpSnapshot = await getVisibleTerminalText(page);
  expect(terminalTextAfterHttpSnapshot).toContain(liveMarker);
  expect(terminalTextAfterHttpSnapshot).not.toContain(staleMarker);
});
