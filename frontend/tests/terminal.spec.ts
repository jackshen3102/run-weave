import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const E2E_BACKEND_PORT = 5501;
const E2E_API_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}`;
const TERMINAL_PREFERENCES_KEY = `viewer.terminal.preferences.${E2E_API_BASE}`;
const E2E_HOOK_TOKEN = "e2e-hook-token";

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
  options: {
    command?: string;
    args?: string[];
    projectId?: string;
    cwd?: string;
    runtimePreference?: "auto" | "tmux" | "pty";
  } = {},
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
      runtimePreference: options.runtimePreference,
    },
  });

  if (!response.ok()) {
    expect(response.ok(), await response.text()).toBe(true);
  }
  return (await response.json()) as {
    terminalSessionId: string;
    terminalUrl: string;
  };
}

async function createTerminalProject(
  request: APIRequestContext,
  token: string,
  name: string,
  projectPath?: string,
): Promise<{ projectId: string }> {
  const response = await request.post(`${E2E_API_BASE}/api/terminal/project`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    data: {
      name,
      path: projectPath,
    },
  });

  expect(response.ok()).toBe(true);
  return (await response.json()) as { projectId: string };
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

async function getRenderedTerminalSpanColor(
  page: Page,
  text: string,
): Promise<string | null> {
  return page.locator(".xterm-rows span").evaluateAll((spans, targetText) => {
    const matchingSpans = spans.filter((candidate) =>
      candidate.textContent?.includes(targetText),
    );
    const span = matchingSpans[matchingSpans.length - 1];
    return span ? getComputedStyle(span).color : null;
  }, text);
}

async function installTerminalEventsSocketTracker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type TrackedWindow = Window & {
      __runweaveTerminalEventSockets?: WebSocket[];
      __runweaveTerminalEventSocketTrackingInstalled?: boolean;
    };
    const trackedWindow = window as TrackedWindow;
    if (trackedWindow.__runweaveTerminalEventSocketTrackingInstalled) {
      return;
    }

    const NativeWebSocket = window.WebSocket;
    trackedWindow.__runweaveTerminalEventSockets = [];
    trackedWindow.__runweaveTerminalEventSocketTrackingInstalled = true;

    function TrackingWebSocket(
      this: WebSocket,
      url: string | URL,
      protocols?: string | string[],
    ): WebSocket {
      const socket =
        protocols === undefined
          ? new NativeWebSocket(url)
          : new NativeWebSocket(url, protocols);
      if (String(url).includes("/ws/terminal-events")) {
        trackedWindow.__runweaveTerminalEventSockets?.push(socket);
      }
      return socket;
    }

    TrackingWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(TrackingWebSocket, NativeWebSocket);
    window.WebSocket = TrackingWebSocket as typeof WebSocket;
  });
}

async function closeLatestTerminalEventsSocket(page: Page): Promise<void> {
  await page.evaluate(() => {
    const trackedWindow = window as Window & {
      __runweaveTerminalEventSockets?: WebSocket[];
    };
    const sockets = trackedWindow.__runweaveTerminalEventSockets ?? [];
    const socket = sockets[sockets.length - 1];
    if (!socket) {
      throw new Error("No terminal-events WebSocket was opened");
    }
    socket.close();
  });
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

test("terminal sessions drop backend color suppression env and render ANSI color", async ({
  page,
  request,
}) => {
  const token = await loginAndSeedToken(request, page);
  const session = await createTerminalSession(request, token, {
    runtimePreference: "tmux",
  });
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

  await page.keyboard.type(
    `printf 'no_color=%s force_color=%s clicolor=%s colorterm=%s\\n' "\${NO_COLOR-unset}" "\${FORCE_COLOR-unset}" "\${CLICOLOR-unset}" "\${COLORTERM-unset}"`,
  );
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => {
      return await getLiveTerminalText(page);
    })
    .toContain(
      "no_color=unset force_color=unset clicolor=unset colorterm=truecolor",
    );

  const marker = "terminal-color-e2e-red";
  await page.keyboard.type(`printf '\\033[31m${marker}\\033[0m\\n'`);
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => {
      return await getLiveTerminalText(page);
    })
    .toContain(marker);
  await expect
    .poll(async () => (await getRenderedTerminalSpanColor(page, marker)) ?? "")
    .not.toBe("");

  const renderedColor = await getRenderedTerminalSpanColor(page, marker);
  expect(renderedColor).not.toBe("rgb(226, 232, 240)");
});

test("does not duplicate committed IME text", async ({ page, request }) => {
  const token = await loginAndSeedToken(request, page);
  const session = await createTerminalSession(request, token, {
    command: "/bin/bash",
    runtimePreference: "pty",
  });
  await page.addInitScript((preferencesKey) => {
    window.localStorage.setItem(
      preferencesKey,
      JSON.stringify({ renderer: "dom", screenReaderMode: true }),
    );
  }, TERMINAL_PREFERENCES_KEY);

  await page.goto(session.terminalUrl);
  await expect(page.getByLabel("Terminal emulator")).toBeVisible();
  await page.getByLabel("Terminal emulator").click({ force: true });

  const inputMessages = await page.evaluate(async () => {
    const helperTextarea =
      document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (!helperTextarea) {
      throw new Error("Missing xterm helper textarea");
    }

    const sentInputs: string[] = [];
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedSend(
      data: string | ArrayBufferLike | Blob | ArrayBufferView,
    ) {
      try {
        const parsed = JSON.parse(String(data)) as { type?: string; data?: string };
        if (parsed.type === "input" && typeof parsed.data === "string") {
          sentInputs.push(parsed.data);
        }
      } catch {
        // Ignore non-JSON WebSocket frames.
      }
      return originalSend.call(this, data);
    };

    const dispatch = (event: Event): void => {
      helperTextarea.dispatchEvent(event);
    };

    helperTextarea.focus();
    helperTextarea.value = "";
    dispatch(
      new CompositionEvent("compositionstart", {
        data: "",
        bubbles: true,
        cancelable: true,
      }),
    );
    dispatch(
      new CompositionEvent("compositionupdate", {
        data: "中",
        bubbles: true,
        cancelable: true,
      }),
    );
    helperTextarea.value = "中";
    dispatch(
      new InputEvent("beforeinput", {
        inputType: "insertCompositionText",
        data: "中",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );
    dispatch(
      new InputEvent("input", {
        inputType: "insertCompositionText",
        data: "中",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );
    dispatch(
      new CompositionEvent("compositionupdate", {
        data: "中文",
        bubbles: true,
        cancelable: true,
      }),
    );
    helperTextarea.value = "中文";
    dispatch(
      new InputEvent("beforeinput", {
        inputType: "insertCompositionText",
        data: "文",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );
    dispatch(
      new InputEvent("input", {
        inputType: "insertCompositionText",
        data: "文",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );
    dispatch(
      new CompositionEvent("compositionend", {
        data: "中文",
        bubbles: true,
        cancelable: true,
      }),
    );
    helperTextarea.value = "中文";
    dispatch(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: "中文",
        bubbles: true,
        cancelable: true,
        isComposing: false,
      }),
    );
    dispatch(
      new InputEvent("input", {
        inputType: "insertText",
        data: "中文",
        bubbles: true,
        cancelable: true,
        isComposing: false,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 80));
    WebSocket.prototype.send = originalSend;
    return sentInputs;
  });

  expect(inputMessages).toEqual(["中文"]);
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

test("merges terminal event catchup without duplicate projects or tabs", async ({
  page,
  request,
}) => {
  await installTerminalEventsSocketTracker(page);
  const token = await loginAndSeedToken(request, page);
  const suffix = `${Date.now()}`;
  const initialProject = await createTerminalProject(
    request,
    token,
    `Catchup Initial ${suffix}`,
  );
  const initialCwd = await mkdtemp(
    path.join(os.tmpdir(), `catchup-initial-${suffix}-`),
  );
  const externalCwd = await mkdtemp(
    path.join(os.tmpdir(), `catchup-external-${suffix}-`),
  );
  const externalProjectName = `Catchup External ${suffix}`;
  const externalLabel = path.basename(externalCwd);

  try {
    const initialSession = await createTerminalSession(request, token, {
      projectId: initialProject.projectId,
      cwd: initialCwd,
      runtimePreference: "pty",
    });
    const eventsTicketResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/terminal/events/ws-ticket") &&
        response.status() === 200,
    );
    await page.goto(initialSession.terminalUrl);
    await eventsTicketResponse;
    await closeLatestTerminalEventsSocket(page);

    const externalProject = await createTerminalProject(
      request,
      token,
      externalProjectName,
    );
    const externalSession = await createTerminalSession(request, token, {
      projectId: externalProject.projectId,
      cwd: externalCwd,
      runtimePreference: "pty",
    });

    await expect(
      page.getByRole("button", { name: externalProjectName, exact: true }),
    ).toHaveCount(1);
    await page
      .getByRole("button", { name: externalProjectName, exact: true })
      .click();
    await expect(
      page.locator(
        `[data-terminal-session-id="${externalSession.terminalSessionId}"]`,
      ),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: escapedPrefixPattern(externalLabel) }),
    ).toHaveCount(1);
  } finally {
    await rm(initialCwd, { force: true, recursive: true });
    await rm(externalCwd, { force: true, recursive: true });
  }
});

test("does not switch the active terminal for live external terminal events", async ({
  page,
  request,
}) => {
  const token = await loginAndSeedToken(request, page);
  const suffix = `${Date.now()}`;
  const activeProject = await createTerminalProject(
    request,
    token,
    `Live Active ${suffix}`,
  );
  const externalProject = await createTerminalProject(
    request,
    token,
    `Live External ${suffix}`,
  );
  const activeCwd = await mkdtemp(
    path.join(os.tmpdir(), `live-active-${suffix}-`),
  );
  const externalCwd = await mkdtemp(
    path.join(os.tmpdir(), `live-external-${suffix}-`),
  );

  try {
    const activeSession = await createTerminalSession(request, token, {
      projectId: activeProject.projectId,
      cwd: activeCwd,
      runtimePreference: "pty",
    });
    const eventsTicketResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/terminal/events/ws-ticket") &&
        response.status() === 200,
    );
    await page.goto(activeSession.terminalUrl);
    await eventsTicketResponse;

    const externalSession = await createTerminalSession(request, token, {
      projectId: externalProject.projectId,
      cwd: externalCwd,
      runtimePreference: "pty",
    });

    await expect(
      page.getByRole("button", {
        name: `Live External ${suffix}`,
        exact: true,
      }),
    ).toBeVisible();
    expect(externalSession.terminalSessionId).toBeTruthy();
    await expect(page).toHaveURL(
      new RegExp(`/terminal/${activeSession.terminalSessionId}$`),
    );
  } finally {
    await rm(activeCwd, { force: true, recursive: true });
    await rm(externalCwd, { force: true, recursive: true });
  }
});

test("merges terminal state events without losing existing projects or tabs", async ({
  page,
  request,
}) => {
  const token = await loginAndSeedToken(request, page);
  const suffix = `${Date.now()}`;
  const projectName = `State Event ${suffix}`;
  const project = await createTerminalProject(request, token, projectName);
  const cwd = await mkdtemp(path.join(os.tmpdir(), `state-event-${suffix}-`));

  try {
    const fakeCodexPath = path.join(cwd, "codex");
    await writeFile(fakeCodexPath, "#!/usr/bin/env bash\nsleep 30\n", {
      mode: 0o755,
    });
    const session = await createTerminalSession(request, token, {
      projectId: project.projectId,
      command: fakeCodexPath,
      cwd,
      runtimePreference: "pty",
    });

    const eventsTicketResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/terminal/events/ws-ticket") &&
        response.status() === 200,
    );
    await page.goto(session.terminalUrl);
    await eventsTicketResponse;

    const projectButton = page.getByRole("button", {
      name: projectName,
      exact: true,
    });
    const sessionTab = page.locator(
      `[data-terminal-session-id="${session.terminalSessionId}"]`,
    );
    await expect(projectButton).toHaveCount(1);
    await expect(sessionTab).toHaveCount(1);
    await expect(projectButton.locator(".shimmer-invert")).toHaveCount(0);

    const hookResponse = await request.post(
      `${E2E_API_BASE}/internal/terminal/agent-hook`,
      {
        headers: {
          "X-Runweave-Hook-Token": E2E_HOOK_TOKEN,
        },
        data: {
          terminalSessionId: session.terminalSessionId,
          projectId: project.projectId,
          agent: "codex",
          hookEvent: "UserPromptSubmit",
        },
      },
    );
    expect(hookResponse.status()).toBe(202);

    await expect(projectButton.locator(".shimmer-invert")).toBeVisible();
    await expect(sessionTab.locator(".shimmer-invert")).toBeVisible();
    await expect(projectButton).toHaveCount(1);
    await expect(sessionTab).toHaveCount(1);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("removes externally deleted terminal tabs from terminal events", async ({
  page,
  request,
}) => {
  const token = await loginAndSeedToken(request, page);
  const suffix = `${Date.now()}`;
  const project = await createTerminalProject(
    request,
    token,
    `External Delete ${suffix}`,
  );
  const firstCwd = await mkdtemp(
    path.join(os.tmpdir(), `external-delete-a-${suffix}-`),
  );
  const secondCwd = await mkdtemp(
    path.join(os.tmpdir(), `external-delete-b-${suffix}-`),
  );
  const secondLabel = path.basename(secondCwd);

  try {
    const firstSession = await createTerminalSession(request, token, {
      projectId: project.projectId,
      cwd: firstCwd,
      runtimePreference: "pty",
    });
    const secondSession = await createTerminalSession(request, token, {
      projectId: project.projectId,
      cwd: secondCwd,
      runtimePreference: "pty",
    });

    const eventsTicketResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/terminal/events/ws-ticket") &&
        response.status() === 200,
    );
    await page.goto(firstSession.terminalUrl);
    await eventsTicketResponse;

    const secondTab = page.getByRole("button", {
      name: escapedPrefixPattern(secondLabel),
    });
    await expect(secondTab).toBeVisible();

    const deleteResponse = await request.delete(
      `${E2E_API_BASE}/api/terminal/session/${encodeURIComponent(secondSession.terminalSessionId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );
    expect(deleteResponse.status()).toBe(204);

    await expect(secondTab).not.toBeVisible();
  } finally {
    await rm(firstCwd, { force: true, recursive: true });
    await rm(secondCwd, { force: true, recursive: true });
  }
});

test("marks a background project from an explicit codex completion event", async ({
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

  const projectAName = `Completion A ${suffix}`;
  const projectBName = `Completion B ${suffix}`;
  const projectA = await createTerminalProject(request, token, projectAName);
  const projectB = await createTerminalProject(request, token, projectBName);
  const cwdA = await mkdtemp(path.join(os.tmpdir(), `completion-a-${suffix}-`));
  const cwdB = await mkdtemp(path.join(os.tmpdir(), `completion-b-${suffix}-`));

  try {
    const fakeCodexPath = path.join(cwdA, "codex");
    await writeFile(fakeCodexPath, "#!/usr/bin/env bash\nsleep 30\n", {
      mode: 0o755,
    });

    const sessionA = await createTerminalSession(request, token, {
      projectId: projectA.projectId,
      command: fakeCodexPath,
      cwd: cwdA,
      runtimePreference: "pty",
    });
    const sessionB = await createTerminalSession(request, token, {
      projectId: projectB.projectId,
      cwd: cwdB,
    });

    const eventsTicketResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/terminal/events/ws-ticket") &&
        response.status() === 200,
    );
    await page.goto(sessionA.terminalUrl);
    await eventsTicketResponse;
    await expect(
      page.getByRole("button", { name: projectAName, exact: true }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: projectBName, exact: true })
      .click();
    await expect
      .poll(() => page.url())
      .toContain(`/terminal/${sessionB.terminalSessionId}`);

    const projectADot = page
      .getByRole("button", { name: projectAName, exact: true })
      .locator("span")
      .last();

    await expect
      .poll(async () => (await projectADot.getAttribute("class")) ?? "")
      .not.toContain("bg-emerald-400");

    const recordResponse = await request.post(
      `${E2E_API_BASE}/internal/terminal-completion`,
      {
        headers: {
          "X-Runweave-Hook-Token": E2E_HOOK_TOKEN,
        },
        data: {
          terminalSessionId: sessionA.terminalSessionId,
          source: "codex",
          completionReason: "hook_stop",
          commandName: "codex",
          rawHookEvent: "Stop",
          cwd: cwdA,
        },
      },
    );
    expect(recordResponse.status()).toBe(202);
    await expect(recordResponse.json()).resolves.toMatchObject({
      event: {
        kind: "completion",
        terminalSessionId: sessionA.terminalSessionId,
        payload: {
          source: "codex",
          completionReason: "hook_stop",
          commandName: "codex",
          rawHookEvent: "Stop",
        },
      },
    });

    await expect
      .poll(async () => (await projectADot.getAttribute("class")) ?? "", {
        timeout: 1_500,
      })
      .toContain("bg-emerald-400");

    await page
      .getByRole("button", { name: projectAName, exact: true })
      .click();
    await expect
      .poll(() => page.url())
      .toContain(`/terminal/${sessionA.terminalSessionId}`);
    await expect
      .poll(async () => (await projectADot.getAttribute("class")) ?? "")
      .not.toContain("bg-emerald-400");

    const activeRecordResponse = await request.post(
      `${E2E_API_BASE}/internal/terminal-completion`,
      {
        headers: {
          "X-Runweave-Hook-Token": E2E_HOOK_TOKEN,
        },
        data: {
          terminalSessionId: sessionA.terminalSessionId,
          source: "codex",
          completionReason: "hook_stop",
          commandName: "codex",
          rawHookEvent: "Stop",
          cwd: cwdA,
        },
      },
    );
    expect(activeRecordResponse.status()).toBe(202);
    await expect
      .poll(async () => (await projectADot.getAttribute("class")) ?? "", {
        timeout: 1_000,
      })
      .not.toContain("bg-emerald-400");
  } finally {
    await rm(cwdA, { force: true, recursive: true });
    await rm(cwdB, { force: true, recursive: true });
  }
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
