import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
    .getByRole("button", { name: secondLabel, exact: true })
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
    .getByRole("button", { name: backgroundLabel, exact: true })
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
        command: "/bin/bash",
        args: ["-l"],
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
      page.getByRole("button", { name: cwdLabel, exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Terminal emulator")).toBeVisible();
    await page.getByLabel("Terminal emulator").click({ force: true });

    await page.keyboard.type("codex(){ sleep 5; }");
    await page.keyboard.press("Enter");
    await page.keyboard.type("codex");
    await page.keyboard.press("Enter");

    await expect(
      page.getByRole("button", { name: `${cwdLabel}(codex)`, exact: true }),
    ).toBeVisible({ timeout: 3_000 });
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});
