import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const E2E_BACKEND_PORT = 5501;
const E2E_API_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}`;

type DiagnosticLogStatus = "ready" | "recording" | "ended";

interface DiagnosticLogResult {
  startedAt: string;
  stoppedAt: string;
  logs: Array<{
    at: string;
    source?: string;
    message: string;
    details?: Record<string, unknown>;
  }>;
  files?: {
    dir?: string;
    logsJsonl?: string;
    redactionReportJson?: string;
  };
}

interface AuthPayload {
  accessToken: string;
  expiresIn: number;
  sessionId: string;
}

async function loginForRequest(
  request: APIRequestContext,
): Promise<AuthPayload> {
  const response = await request.post(`${E2E_API_BASE}/api/auth/login`, {
    data: {
      username: "e2e-admin",
      password: "e2e-secret",
    },
  });

  expect(response.ok()).toBe(true);
  return (await response.json()) as AuthPayload;
}

async function loginAndSeedToken(
  request: APIRequestContext,
  page: Page,
): Promise<string> {
  const payload = await loginForRequest(request);

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

async function deleteAllTerminalSessions(
  request: APIRequestContext,
): Promise<void> {
  const { accessToken } = await loginForRequest(request);
  const listResponse = await request.get(
    `${E2E_API_BASE}/api/terminal/session`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
  if (!listResponse.ok()) {
    return;
  }

  const sessions = (await listResponse.json()) as Array<{
    terminalSessionId: string;
  }>;
  for (const session of sessions) {
    await request.delete(
      `${E2E_API_BASE}/api/terminal/session/${encodeURIComponent(
        session.terminalSessionId,
      )}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );
  }
}

async function createProjectAndSession(
  request: APIRequestContext,
  token: string,
): Promise<{ terminalSessionId: string }> {
  const projectResponse = await request.post(
    `${E2E_API_BASE}/api/terminal/project`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      data: {
        name: "Diagnostic Logs Project",
        path: null,
      },
    },
  );
  expect(projectResponse.ok()).toBe(true);
  const project = (await projectResponse.json()) as { projectId: string };

  const sessionResponse = await request.post(
    `${E2E_API_BASE}/api/terminal/session`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      data: {
        projectId: project.projectId,
        command: "bash",
        cwd: "/tmp",
      },
    },
  );
  expect(sessionResponse.ok()).toBe(true);
  return (await sessionResponse.json()) as { terminalSessionId: string };
}

async function installClipboardMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let clipboardText = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          clipboardText = text;
        },
        readText: async () => clipboardText,
      },
    });
  });
}

test.afterEach(async ({ request }) => {
  await deleteAllTerminalSessions(request);
});

async function mockTerminalDiagnosticApi(
  page: Page,
  options: {
    stopResult: DiagnosticLogResult;
  },
): Promise<void> {
  let status: DiagnosticLogStatus = "ready";
  let startedAt: string | null = null;
  let latestResult: DiagnosticLogResult | null = null;
  await page.route("**/api/diagnostic-logs/**", async (route) => {
    const request = route.request();
    const origin = request.headers().origin ?? "http://127.0.0.1:4273";
    const headers = {
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Origin": origin,
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }

    const requestUrl = new URL(request.url());
    if (requestUrl.pathname === "/api/diagnostic-logs/status") {
      await route.fulfill({
        status: 200,
        headers,
        json: { status, startedAt },
      });
      return;
    }

    if (requestUrl.pathname === "/api/diagnostic-logs/result") {
      await route.fulfill({
        status: 200,
        headers,
        json: latestResult,
      });
      return;
    }

    if (requestUrl.pathname === "/api/diagnostic-logs/start") {
      status = "recording";
      startedAt = "2026-06-20T00:00:00.000Z";
      latestResult = null;
      await route.fulfill({
        status: 200,
        headers,
        json: { status, startedAt },
      });
      return;
    }

    if (requestUrl.pathname === "/api/diagnostic-logs/stop") {
      status = "ended";
      startedAt = null;
      latestResult = options.stopResult;
      await route.fulfill({
        status: 200,
        headers,
        json: latestResult,
      });
      return;
    }

    if (requestUrl.pathname === "/api/diagnostic-logs/download") {
      await route.fulfill({
        status: 200,
        headers: {
          ...headers,
          "Content-Type": "application/jsonl",
        },
        body: "",
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

async function openTerminal(
  page: Page,
  terminalSessionId: string,
): Promise<void> {
  await page.goto(
    `/terminal/${encodeURIComponent(terminalSessionId)}`,
  );
  await expect(
    page.getByRole("button", { name: "More actions" }),
  ).toBeVisible();
}

const stopResultWithPath: DiagnosticLogResult = {
  startedAt: "2026-06-20T00:00:00.000Z",
  stoppedAt: "2026-06-20T00:00:05.000Z",
  logs: [
    {
      at: "2026-06-20T00:00:02.000Z",
      source: "frontend",
      message: "diagnostic recording started",
      details: { trigger: "terminal_more_menu" },
    },
  ],
  files: {
    dir: "/tmp/runweave/diagnostic-logs/run-2026",
    logsJsonl: "/tmp/runweave/diagnostic-logs/run-2026/logs.jsonl",
    redactionReportJson:
      "/tmp/runweave/diagnostic-logs/run-2026/redaction-report.json",
  },
};

test("terminal more actions exposes diagnostic log reporting", async ({
  page,
  request,
}) => {
  await installClipboardMock(page);
  const token = await loginAndSeedToken(request, page);
  const session = await createProjectAndSession(request, token);
  await mockTerminalDiagnosticApi(page, {
    stopResult: stopResultWithPath,
  });

  await openTerminal(page, session.terminalSessionId);
  await page.getByRole("button", { name: "More actions" }).click();

  await expect(
    page.getByRole("menuitem", { name: "日志上报" }),
  ).toBeVisible();
});

test("diagnostic log dialog uploads and copies the server log path", async ({
  page,
  request,
}) => {
  await installClipboardMock(page);
  const token = await loginAndSeedToken(request, page);
  const session = await createProjectAndSession(request, token);
  await mockTerminalDiagnosticApi(page, {
    stopResult: stopResultWithPath,
  });

  await openTerminal(page, session.terminalSessionId);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "日志上报" }).click();
  await expect(page.getByRole("dialog", { name: "日志上报" })).toBeVisible();

  await page.getByRole("button", { name: "开始记录" }).click();
  await expect(page.getByText("记录中")).toBeVisible();
  await page.getByRole("button", { name: "结束并上报" }).click();

  const logPath = "/tmp/runweave/diagnostic-logs/run-2026/logs.jsonl";
  await expect(page.getByText(logPath)).toBeVisible();
  await page.getByRole("button", { name: "复制日志路径" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(logPath);
});

test("diagnostic log dialog disables path copy when no server path is returned", async ({
  page,
  request,
}) => {
  await installClipboardMock(page);
  const token = await loginAndSeedToken(request, page);
  const session = await createProjectAndSession(request, token);
  await mockTerminalDiagnosticApi(page, {
    stopResult: {
      startedAt: "2026-06-20T00:00:00.000Z",
      stoppedAt: "2026-06-20T00:00:05.000Z",
      logs: [],
    },
  });

  await openTerminal(page, session.terminalSessionId);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "日志上报" }).click();
  await page.getByRole("button", { name: "开始记录" }).click();
  await page.getByRole("button", { name: "结束并上报" }).click();

  await expect(
    page.getByText("已结束记录，但未返回服务端日志路径。"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "复制日志路径" }),
  ).toBeDisabled();
});
