import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const execFileAsync = promisify(execFile);
const E2E_BACKEND_PORT = 5501;
const E2E_API_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}`;

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
  options: {
    name: string;
    path?: string | null;
    cwd?: string;
  },
): Promise<{ terminalSessionId: string }> {
  const projectResponse = await request.post(
    `${E2E_API_BASE}/api/terminal/project`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      data: {
        name: options.name,
        path: options.path,
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
        cwd: options.cwd ?? options.path ?? "/tmp",
      },
    },
  );
  expect(sessionResponse.ok()).toBe(true);
  return (await sessionResponse.json()) as { terminalSessionId: string };
}

async function setLatestMonacoEditorValue(
  page: Page,
  content: string,
): Promise<void> {
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const monacoWindow = window as unknown as {
          monaco?: {
            editor: {
              getEditors: () => unknown[];
            };
          };
        };
        return monacoWindow.monaco?.editor.getEditors().length ?? 0;
      }),
    )
    .toBeGreaterThan(0);

  await page.evaluate((nextContent) => {
    const monacoWindow = window as unknown as {
      monaco?: {
        editor: {
          getEditors: () => Array<{
            focus: () => void;
            setValue: (value: string) => void;
          }>;
        };
      };
    };
    const editor = monacoWindow.monaco?.editor.getEditors().at(-1);
    if (!editor) {
      throw new Error("No Monaco editor is available");
    }
    editor.focus();
    editor.setValue(nextContent);
  }, content);
}

test.afterEach(async ({ request }) => {
  await deleteAllTerminalSessions(request);
});

async function createPreviewRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "terminal-preview-e2e-"));
  await mkdir(path.join(repo, "docs/architecture"), { recursive: true });
  await mkdir(path.join(repo, "generated"), { recursive: true });
  await writeFile(path.join(repo, ".gitignore"), "generated/\n");
  await writeFile(
    path.join(repo, "docs/architecture/terminal-code-preview.md"),
    "# Terminal Preview Plan\n\nPreview content\n",
  );
  await writeFile(
    path.join(repo, "generated/terminal-code-preview.js"),
    "ignored\n",
  );
  await writeFile(path.join(repo, "README.md"), "old readme\n");
  await writeFile(path.join(repo, "staged.txt"), "old staged\n");
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  await execFileAsync("git", ["config", "user.name", "Terminal Preview Test"], {
    cwd: repo,
  });
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
  await writeFile(path.join(repo, "staged.txt"), "new staged\n");
  await execFileAsync("git", ["add", "staged.txt"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "new readme\n");
  return repo;
}

test("terminal preview opens project files and git changes", async ({
  page,
  request,
}) => {
  const repo = await createPreviewRepo();
  try {
    const token = await loginAndSeedToken(request, page);
    const session = await createProjectAndSession(request, token, {
      name: "Preview Project",
      path: repo,
    });

    await page.goto(
      `/terminal/${encodeURIComponent(session.terminalSessionId)}`,
    );
    await expect(
      page.getByRole("tab", { name: "Preview", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("tab", { name: "Changes", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Staged Changes")).toBeVisible();
    await expect(page.getByText("Working Changes")).toBeVisible();

    await page.getByRole("tab", { name: "Open", exact: true }).click();
    await page
      .getByPlaceholder("Search file or paste absolute path...")
      .fill("terminal preview");
    await expect(page.getByText("terminal-code-preview.md")).toBeVisible();
    await expect(page.getByText("terminal-code-preview.js")).not.toBeVisible();
    await page.getByText("terminal-code-preview.md").click();
    await expect(
      page.getByText("docs/architecture/terminal-code-preview.md"),
    ).toBeVisible();
    await page.getByRole("button", { name: "source" }).click();
    await expect(
      page.locator(".monaco-editor .view-line").first(),
    ).toContainText("# Terminal Preview Plan");

    await page
      .getByRole("tab", { name: "Changes", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /staged\.txt/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /README\.md/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /README\.md/ }).click();
    await expect(
      page.locator(".monaco-diff-editor .modified .view-line", {
        hasText: "new readme",
      }),
    ).toBeVisible();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("terminal preview saves files and protects unsaved drafts", async ({
  page,
  request,
}) => {
  const repo = await createPreviewRepo();
  try {
    const token = await loginAndSeedToken(request, page);
    const session = await createProjectAndSession(request, token, {
      name: "Preview Save Project",
      path: repo,
    });

    await page.goto(
      `/terminal/${encodeURIComponent(session.terminalSessionId)}`,
    );
    await page.getByRole("tab", { name: "Open", exact: true }).click();
    await page.getByRole("option", { name: /README\.md/ }).click();
    await page.getByRole("button", { name: "source" }).click();

    await setLatestMonacoEditorValue(page, "updated from preview\n");
    await expect(
      page.locator("aside").getByText("Unsaved", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Save preview file" }).click();
    await expect(
      page.locator("aside").getByText("Saved", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const savedContent = await readFile(
          path.join(repo, "README.md"),
          "utf8",
        );
        return savedContent.includes("updated from preview");
      })
      .toBe(true);

    await setLatestMonacoEditorValue(page, "unsaved from preview\n");
    await expect(
      page.locator("aside").getByText("Unsaved", { exact: true }),
    ).toBeVisible();

    let dismissedMessage = "";
    page.once("dialog", async (dialog) => {
      dismissedMessage = dialog.message();
      await dialog.dismiss();
    });
    await page
      .getByRole("tab", { name: "Changes", exact: true })
      .click();
    expect(dismissedMessage).toBe("Discard unsaved Preview changes?");
    await expect(
      page.locator("aside").getByText("Unsaved", { exact: true }),
    ).toBeVisible();

    let acceptedMessage = "";
    page.once("dialog", async (dialog) => {
      acceptedMessage = dialog.message();
      await dialog.accept();
    });
    await page
      .getByRole("tab", { name: "Changes", exact: true })
      .click();
    expect(acceptedMessage).toBe("Discard unsaved Preview changes?");
    await expect(page.getByText("Staged Changes")).toBeVisible();

    const savedContent = await readFile(path.join(repo, "README.md"), "utf8");
    expect(savedContent).toContain("updated from preview");
    expect(savedContent).not.toContain("unsaved from preview");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("terminal preview enforces project path boundaries", async ({
  page,
  request,
}) => {
  const repo = await createPreviewRepo();
  const outsideDir = await mkdtemp(
    path.join(os.tmpdir(), "terminal-preview-outside-"),
  );
  const outsideFile = path.join(outsideDir, "OUTSIDE.md");
  await writeFile(outsideFile, "outside preview file\n");

  try {
    const token = await loginAndSeedToken(request, page);
    const repoSession = await createProjectAndSession(request, token, {
      name: "Preview Boundary Project",
      path: repo,
    });

    await page.goto(
      `/terminal/${encodeURIComponent(repoSession.terminalSessionId)}`,
    );
    await page.getByRole("tab", { name: "Open", exact: true }).click();
    await page
      .getByPlaceholder("Search file or paste absolute path...")
      .fill(outsideFile);
    await expect(page.getByText("Press Enter to open this path")).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(page.getByText("outside preview file")).toBeVisible();
    await expect(page.getByText("Read only")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save preview file" }),
    ).not.toBeVisible();

    const noPathSession = await createProjectAndSession(request, token, {
      name: "Preview No Path Project",
      path: null,
      cwd: "/tmp",
    });

    await page.goto(
      `/terminal/${encodeURIComponent(noPathSession.terminalSessionId)}`,
    );
    await expect(
      page.getByText("Set a project path to use Preview"),
    ).toBeVisible();
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
