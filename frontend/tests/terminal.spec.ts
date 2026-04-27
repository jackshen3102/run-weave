import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const E2E_BACKEND_PORT = 5501;
const E2E_API_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}`;
const TERMINAL_PREFERENCES_KEY = `viewer.terminal.preferences.${E2E_API_BASE}`;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

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

async function mockTerminalConnectionApi(
  page: Page,
  options: {
    url: string;
    projectId: string;
    projectName: string;
    terminalSessionId?: string;
    cwd?: string;
    delay?: Deferred;
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
    if (options.delay && requestUrl.pathname !== "/api/auth/verify") {
      await options.delay.promise;
    }

    if (requestUrl.pathname === "/api/auth/verify") {
      await route.fulfill({
        status: 200,
        headers,
        json: { valid: true },
      });
      return;
    }

    if (requestUrl.pathname === "/api/terminal/project") {
      await route.fulfill({
        status: 200,
        headers,
        json: options.terminalSessionId
          ? [
              {
                projectId: options.projectId,
                name: options.projectName,
                path: null,
                createdAt: new Date().toISOString(),
              },
            ]
          : [],
      });
      return;
    }

    if (requestUrl.pathname === "/api/terminal/session") {
      await route.fulfill({
        status: 200,
        headers,
        json: options.terminalSessionId
          ? [
              {
                terminalSessionId: options.terminalSessionId,
                projectId: options.projectId,
                command: "bash",
                args: [],
                cwd: options.cwd ?? `/${options.projectName}`,
                activeCommand: null,
                status: "running",
                createdAt: new Date().toISOString(),
              },
            ]
          : [],
      });
      return;
    }

    if (requestUrl.pathname.endsWith("/ws-ticket")) {
      await route.fulfill({
        status: 200,
        headers,
        json: {
          ticket: "mock-ticket",
          expiresIn: 30,
        },
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

async function createTerminalSession(
  request: APIRequestContext,
  token: string,
  options: { command?: string; args?: string[]; projectId?: string; cwd?: string } = {},
): Promise<{ terminalSessionId: string; terminalUrl: string }> {
  const response = await request.post(`${E2E_API_BASE}/api/terminal/session`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    data: {
      projectId: options.projectId,
      command: options.command ?? "bash",
      args: options.args,
      cwd: options.cwd ?? "/tmp",
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

function escapedPrefixPattern(value: string): RegExp {
  return new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}

test("creates a terminal session and streams command output", async ({
  page,
  request,
}) => {
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
  const session = await createTerminalSession(request, token);
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
  expect(cols).toBeGreaterThan(80);
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
  const firstCwd = await mkdtemp(path.join(os.tmpdir(), `tab-keep-a-${suffix}-`));
  const secondCwd = await mkdtemp(path.join(os.tmpdir(), `tab-keep-b-${suffix}-`));
  const secondLabel = path.basename(secondCwd);
  const firstSession = await createTerminalSession(request, token, {
    projectId: project.projectId,
    command: "tail",
    args: ["-f", "/dev/null"],
    cwd: firstCwd,
  });
  const secondSession = await createTerminalSession(request, token, {
    projectId: project.projectId,
    command: "tail",
    args: ["-f", "/dev/null"],
    cwd: secondCwd,
  });

  await page.goto(firstSession.terminalUrl);

  await expect(page).toHaveURL(
    new RegExp(`/terminal/${firstSession.terminalSessionId}$`),
  );

  await page
    .getByRole("button", { name: escapedPrefixPattern(secondLabel) })
    .click();

  await expect
    .poll(() => page.url())
    .toContain(`/terminal/${secondSession.terminalSessionId}`);

  await page.reload();

  await expect
    .poll(() => page.url())
    .toContain(`/terminal/${secondSession.terminalSessionId}`);

  await rm(firstCwd, { force: true, recursive: true });
  await rm(secondCwd, { force: true, recursive: true });
});

test("switches Electron terminal connections and ignores stale session loads", async ({
  page,
}) => {
  const connectionA = {
    id: "connection-a",
    name: "Connection A",
    url: "http://connection-a.test",
  };
  const connectionB = {
    id: "connection-b",
    name: "Connection B",
    url: "http://connection-b.test",
  };
  const connectionC = {
    id: "connection-c",
    name: "Connection C",
    url: "http://connection-c.test",
  };
  const delayedA = createDeferred();
  const delayedB = createDeferred();

  await seedElectronConnections(page, {
    activeId: connectionA.id,
    connections: [connectionA, connectionB, connectionC],
  });
  await mockTerminalConnectionApi(page, {
    url: connectionA.url,
    projectId: "project-a",
    projectName: "Project A",
    terminalSessionId: "terminal-a",
    delay: delayedA,
  });
  await mockTerminalConnectionApi(page, {
    url: connectionB.url,
    projectId: "project-b",
    projectName: "Project B",
    terminalSessionId: "terminal-b",
    delay: delayedB,
  });
  await mockTerminalConnectionApi(page, {
    url: connectionC.url,
    projectId: "project-c",
    projectName: "Project C",
    terminalSessionId: "terminal-c",
  });

  await page.goto("/terminal/terminal-a");
  await page.getByRole("button", { name: /Connection A/ }).click();
  await page.getByRole("menuitem", { name: /Connection B/ }).click();
  await page.getByRole("button", { name: /Connection B/ }).click();
  await page.getByRole("menuitem", { name: /Connection C/ }).click();

  await expect(page.getByRole("button", { name: "Project C" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Connection C/ })).toBeVisible();
  await expect.poll(() => page.url()).toContain("/terminal/terminal-c");

  delayedA.resolve();
  delayedB.resolve();
  await page.waitForTimeout(100);

  await expect(page.getByRole("button", { name: "Project C" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Project A" }).first()).toBeHidden();
  await expect(page.getByRole("button", { name: "Project B" }).first()).toBeHidden();
  await expect.poll(() => page.url()).toContain("/terminal/terminal-c");
});

test("keeps terminal context when switched Electron connection has no sessions", async ({
  page,
}) => {
  const connectionA = {
    id: "connection-a",
    name: "Connection A",
    url: "http://empty-a.test",
  };
  const connectionB = {
    id: "connection-b",
    name: "Connection B",
    url: "http://empty-b.test",
  };

  await seedElectronConnections(page, {
    activeId: connectionA.id,
    connections: [connectionA, connectionB],
  });
  await mockTerminalConnectionApi(page, {
    url: connectionA.url,
    projectId: "project-a",
    projectName: "Project A",
    terminalSessionId: "terminal-a",
  });
  await mockTerminalConnectionApi(page, {
    url: connectionB.url,
    projectId: "project-b",
    projectName: "Project B",
  });

  await page.goto("/terminal/terminal-a");
  await expect(page.getByRole("button", { name: "Project A" }).first()).toBeVisible();

  await page.getByRole("button", { name: /Connection A/ }).click();
  await page.getByRole("menuitem", { name: /Connection B/ }).click();

  await expect(page.getByText("No terminal tab yet. Create one to start.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Connection B/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "New Terminal" })).toBeVisible();
  await expect.poll(() => page.url()).toMatch(/\/terminal$/);
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
  const activeCwd = await mkdtemp(path.join(os.tmpdir(), `inactive-active-${suffix}-`));
  const backgroundCwd = await mkdtemp(path.join(os.tmpdir(), `inactive-bg-${suffix}-`));
  const backgroundLabel = path.basename(backgroundCwd);
  const activeSession = await createTerminalSession(request, token, {
    cwd: activeCwd,
  });
  const backgroundSession = await createTerminalSession(request, token, {
    command: "bash",
    args: ["-lc", `printf '${backgroundMarker}\\n'; sleep 60`],
    cwd: backgroundCwd,
  });

  await expect
    .poll(() =>
      getTerminalScrollback(request, token, backgroundSession.terminalSessionId),
    )
    .toContain(backgroundMarker);

  await page.goto(activeSession.terminalUrl);
  await expect(page.getByLabel("Terminal emulator").first()).toBeVisible();

  await page
    .getByRole("button", { name: escapedPrefixPattern(backgroundLabel) })
    .click();
  await expect
    .poll(() => page.url())
    .toContain(`/terminal/${backgroundSession.terminalSessionId}`);

  await expect.poll(() => getLiveTerminalText(page)).toContain(backgroundMarker);

  await rm(activeCwd, { force: true, recursive: true });
  await rm(backgroundCwd, { force: true, recursive: true });
});

test("keeps cached background terminal state without snapshot restore", async ({
  page,
  request,
}) => {
  const token = await loginAndSeedToken(request, page);
  const suffix = `${Date.now()}`;
  await page.addInitScript((preferencesKey) => {
    window.localStorage.setItem(
      preferencesKey,
      JSON.stringify({ renderer: "dom", screenReaderMode: true }),
    );
  }, TERMINAL_PREFERENCES_KEY);
  const activeCwd = await mkdtemp(path.join(os.tmpdir(), `cached-active-${suffix}-`));
  const backgroundCwd = await mkdtemp(path.join(os.tmpdir(), `cached-bg-${suffix}-`));
  const backgroundTriggerPath = path.join(backgroundCwd, "go");
  const backgroundDonePath = path.join(backgroundCwd, "done");
  const activeLabel = path.basename(activeCwd);
  const backgroundLabel = path.basename(backgroundCwd);
  const activeSession = await createTerminalSession(request, token, {
    cwd: activeCwd,
  });
  const backgroundSession = await createTerminalSession(request, token, {
    command: "python3",
    args: [
      "-c",
      [
        "import os, sys, time",
        "sys.stdout.write('\\x1b[?1049h\\x1b[2J')",
        "sys.stdout.write('\\x1b[Hcached background tui ready\\n')",
        "sys.stdout.write('left column 000000')",
        "sys.stdout.flush()",
        `trigger_path = ${JSON.stringify(backgroundTriggerPath)}`,
        `done_path = ${JSON.stringify(backgroundDonePath)}`,
        "while not os.path.exists(trigger_path):",
        "    time.sleep(0.05)",
        "for index in range(3500):",
        "    sys.stdout.write('\\x1b[Hcached background tui frame %06d\\n' % index)",
        "    sys.stdout.write('left column %06d' % index)",
        "    sys.stdout.write('\\x1b[10;60Hright column %06d' % index)",
        "    sys.stdout.write('\\x1b[20;10Hbottom marker %06d' % index)",
        "    if index % 20 == 0:",
        "        sys.stdout.flush()",
        "with open(done_path, 'w') as done_file:",
        "    done_file.write('done')",
        "sys.stdout.write('\\x1b[Hcached background tui frame final\\n')",
        "sys.stdout.write('left column final')",
        "sys.stdout.write('\\x1b[10;60Hright column final')",
        "sys.stdout.write('\\x1b[20;10Hbottom marker final')",
        "sys.stdout.flush()",
        "time.sleep(10)",
      ].join("\n"),
    ],
    cwd: backgroundCwd,
  });

  await page.goto(backgroundSession.terminalUrl);
  await expect(page.getByLabel("Terminal emulator").first()).toBeVisible();
  await expect.poll(() => getLiveTerminalText(page)).toContain(
    "cached background tui ready",
  );

  await page.getByRole("button", { name: escapedPrefixPattern(activeLabel) }).click();
  await expect
    .poll(() => page.url())
    .toContain(`/terminal/${activeSession.terminalSessionId}`);
  await page.waitForTimeout(300);
  await writeFile(backgroundTriggerPath, "go");
  await expect
    .poll(async () => {
      try {
        await access(backgroundDonePath);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
  await page
    .getByRole("button", { name: escapedPrefixPattern(backgroundLabel) })
    .click();
  await expect
    .poll(() => page.url())
    .toContain(`/terminal/${backgroundSession.terminalSessionId}`);
  await expect.poll(() => getLiveTerminalText(page)).toMatch(
    /cached background tui (ready|frame)|bottom marker (final|\d{6})|right column (final|\d{6})/,
  );
  const visibleText = await getLiveTerminalText(page);
  expect(visibleText).not.toMatch(/left column \d{6}left column \d{6}/);
  expect(visibleText).not.toMatch(/right column \d{6}right column \d{6}/);

  await rm(activeCwd, { force: true, recursive: true });
  await rm(backgroundCwd, { force: true, recursive: true });
});

test("tmux tab name follows the foreground command like pty", async ({
  page,
  request,
}) => {
  const token = await loginAndSeedToken(request, page);
  const cwd = await mkdtemp(path.join(os.tmpdir(), "runweave-e2e-tmux-"));
  const cwdLabel = path.basename(cwd);
  await page.addInitScript((preferencesKey) => {
    window.localStorage.setItem(
      preferencesKey,
      JSON.stringify({ renderer: "dom", screenReaderMode: true }),
    );
  }, TERMINAL_PREFERENCES_KEY);

  try {
    const response = await request.post(`${E2E_API_BASE}/api/terminal/session`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      data: {
        command: "/bin/sleep",
        args: ["30"],
        cwd,
        runtimePreference: "tmux",
      },
    });
    expect(response.ok()).toBe(true);
    const session = (await response.json()) as {
      terminalSessionId: string;
      terminalUrl: string;
    };

    await page.goto(session.terminalUrl);
    await expect(
      page.getByRole("button", {
        name: new RegExp(
          `^${cwdLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(sleep\\)$`,
        ),
      }),
    ).toBeVisible({ timeout: 5_000 });
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});
