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
  type Locator,
  type Page,
} from "@playwright/test";

const execFileAsync = promisify(execFile);
const E2E_BACKEND_PORT = 5501;
const E2E_API_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}`;
const E2E_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8Dwn4EIwDiqkL4KAd8qAhGqF3tEAAAAAElFTkSuQmCC";
const E2E_PNG_ALT_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFElEQVR42mNgYPj/n4EIwDiqkL4KAeJVAhFZP+6NAAAAAElFTkSuQmCC";

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
  await mkdir(path.join(repo, "assets"), { recursive: true });
  await mkdir(path.join(repo, "generated"), { recursive: true });
  await mkdir(path.join(repo, "scripts"), { recursive: true });
  await mkdir(path.join(repo, "src/search/nested"), { recursive: true });
  await mkdir(path.join(repo, "src/workspaces/needle-room"), {
    recursive: true,
  });
  await writeFile(path.join(repo, ".gitignore"), "generated/\n");
  await writeFile(
    path.join(repo, "docs/architecture/terminal-code-preview.md"),
    "# Terminal Preview Plan\n\nPreview content\n",
  );
  await writeFile(
    path.join(repo, "docs/claude-guide.md"),
    "# Claude Guide\n\nVisible file path match\n",
  );
  await writeFile(
    path.join(repo, "scripts/electron-local-update.mjs"),
    "export const updateScript = true;\n",
  );
  await writeFile(
    path.join(repo, "src/search/quick-target.ts"),
    [
      "export const quickSearchNeedle = 'quick-search-target';",
      "export const visibleSearchValue = quickSearchNeedle;",
      "export const literalSearchPattern = '[literal](value)*';",
      "export const unicodeSearchPattern = '中文needle-after-unicode';",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repo, "src/search/nested/child.ts"),
    "export const nestedChild = true;\n",
  );
  await writeFile(
    path.join(repo, "src/workspaces/needle-room/untitled.ts"),
    "export const unrelatedFile = true;\n",
  );
  await writeFile(
    path.join(repo, "generated/terminal-code-preview.js"),
    "ignored\n",
  );
  await writeFile(
    path.join(repo, "assets/preview-sample.png"),
    Buffer.from(E2E_PNG_BASE64, "base64"),
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
  await mkdir(path.join(repo, "node_modules/hidden"), { recursive: true });
  await mkdir(path.join(repo, "dist"), { recursive: true });
  await writeFile(path.join(repo, ".env.local"), "quick-search-target\n");
  await writeFile(
    path.join(repo, ".env.production.local"),
    "quick-search-target\n",
  );
  await writeFile(path.join(repo, "SECRET.txt"), "quick-search-target\n");
  await writeFile(path.join(repo, ".env.example"), "SAFE_TEMPLATE=1\n");
  await writeFile(
    path.join(repo, "node_modules/hidden/index.js"),
    "quick-search-target\n",
  );
  await writeFile(path.join(repo, "dist/hidden.js"), "quick-search-target\n");
  await writeFile(
    path.join(repo, "assets/preview-sample.png"),
    Buffer.from(E2E_PNG_ALT_BASE64, "base64"),
  );
  await writeFile(path.join(repo, "staged.txt"), "new staged\n");
  await execFileAsync("git", ["add", "staged.txt"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "new readme\n");
  return repo;
}

async function expectPreviewImageVisible(page: Page): Promise<void> {
  await expect(page.locator(".rw-image-preview__image").first()).toBeVisible();
}

async function openPreviewImageLightbox(page: Page): Promise<Locator> {
  await page
    .getByRole("button", { name: /Open image fullscreen:/ })
    .first()
    .click();
  const lightbox = page.locator(".rw-image-lightbox").last();
  await expect(lightbox).toBeVisible();
  return lightbox;
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

test("terminal preview explorer quick search opens files content and folders", async ({
  page,
  request,
}) => {
  const repo = await createPreviewRepo();
  const openFilesShortcut = process.platform === "darwin" ? "Meta+P" : "Control+P";
  const openContentShortcut =
    process.platform === "darwin" ? "Meta+Shift+F" : "Control+Shift+F";

  try {
    const token = await loginAndSeedToken(request, page);
    const session = await createProjectAndSession(request, token, {
      name: "Preview Quick Search Project",
      path: repo,
    });

    await page.goto(
      `/terminal/${encodeURIComponent(session.terminalSessionId)}`,
    );
    await page.getByRole("tab", { name: "Explorer", exact: true }).click();
    const searchButton = page.getByRole("button", {
      name: "Search project files",
    });
    await expect(searchButton).toBeVisible();

    await searchButton.click();
    const dialog = page.getByRole("dialog", {
      name: "Explorer quick search",
    });
    await expect(dialog).toBeVisible();
    const dialogBox = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(dialogBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (dialogBox && viewport) {
      expect(
        Math.abs(dialogBox.x + dialogBox.width / 2 - viewport.width / 2),
      ).toBeLessThan(80);
      expect(Math.abs(dialogBox.y - 80)).toBeLessThan(2);
      expect(
        Math.abs(viewport.height - dialogBox.y - dialogBox.height - 80),
      ).toBeLessThan(2);
    }

    await page
      .getByPlaceholder("Search files by name or path...")
      .fill("terminal preview");
    await expect(
      dialog.getByRole("option", { name: /terminal-code-preview\.md/ }),
    ).toBeVisible();
    await dialog
      .getByRole("option", { name: /terminal-code-preview\.md/ })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("tab", { name: "Explorer", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.locator('[title="docs/architecture/terminal-code-preview.md"]'),
    ).toBeVisible();
    await expect(
      page.getByText("docs/architecture/terminal-code-preview.md"),
    ).toBeVisible();

    await searchButton.click();
    await dialog
      .getByPlaceholder("Search files by name or path...")
      .fill("claude");
    await expect(
      dialog.getByRole("option", { name: /claude-guide\.md/ }),
    ).toBeVisible();
    await expect(dialog.getByText("electron-local-update.mjs")).not.toBeVisible();

    await dialog
      .getByPlaceholder("Search files by name or path...")
      .fill("needle-room");
    await expect(dialog.getByText("untitled.ts")).not.toBeVisible();
    await dialog.getByRole("tab", { name: "Folders" }).click();
    await page.getByPlaceholder("Search folders by path...").fill("needle-room");
    await expect(
      dialog.getByRole("option", { name: /needle-room/ }),
    ).toBeVisible();
    await dialog.getByRole("tab", { name: "Files" }).click();
    await dialog.getByRole("button", { name: "Close" }).click();

    await page.getByRole("tab", { name: "Open", exact: true }).click();
    await page.getByPlaceholder("Search file or paste absolute path...").focus();
    await page.keyboard.press(openFilesShortcut);
    await expect(dialog).not.toBeVisible();
    await page.getByRole("tab", { name: "Open", exact: true }).click();
    await page.getByTitle(repo).click();
    await page.keyboard.press(openFilesShortcut);
    await expect(dialog).toBeVisible();
    await page
      .getByRole("dialog", { name: "Explorer quick search" })
      .getByPlaceholder("Search files by name or path...")
      .fill("staged");
    await dialog.getByRole("option", { name: /staged\.txt/ }).click();
    await expect(
      page.getByRole("tab", { name: "Explorer", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[title="staged.txt"]')).toBeVisible();

    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await page.keyboard.press(openFilesShortcut);
    await expect(dialog).toBeVisible();
    await page
      .getByRole("dialog", { name: "Explorer quick search" })
      .getByPlaceholder("Search files by name or path...")
      .fill("README");
    await dialog.getByRole("option", { name: /README\.md/ }).click();
    await expect(
      page.getByRole("tab", { name: "Explorer", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[title="README.md"]')).toBeVisible();

    await page.keyboard.press(openContentShortcut);
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByPlaceholder("Search text in current project..."),
    ).toBeVisible();
    await page
      .getByRole("dialog", { name: "Explorer quick search" })
      .getByPlaceholder("Search text in current project...")
      .fill("quick-search-target");
    await expect(
      dialog.getByRole("option", { name: /quick-target\.ts/ }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText(".env.local")).not.toBeVisible();
    await expect(dialog.getByText(".env.production.local")).not.toBeVisible();
    await expect(dialog.getByText("SECRET.txt")).not.toBeVisible();
    await expect(dialog.getByText("node_modules/hidden")).not.toBeVisible();
    await expect(dialog.getByText("dist/hidden")).not.toBeVisible();
    await page
      .getByRole("dialog", { name: "Explorer quick search" })
      .getByPlaceholder("Search text in current project...")
      .fill("[literal](value)*");
    await expect(
      dialog.getByRole("option", { name: /quick-target\.ts/ }),
    ).toBeVisible({ timeout: 10_000 });
    await page
      .getByRole("dialog", { name: "Explorer quick search" })
      .getByPlaceholder("Search text in current project...")
      .fill("needle-after-unicode");
    await expect(
      dialog.getByRole("option", { name: /quick-target\.ts/ }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      dialog.locator("mark", { hasText: "needle-after-unicode" }),
    ).toBeVisible();
    await dialog.getByRole("option", { name: /quick-target\.ts/ }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("tab", { name: "Explorer", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[title="src/search/quick-target.ts"]')).toBeVisible();
    await expect(
      page.locator(".monaco-editor .view-line", {
        hasText: "quick-search-target",
      }),
    ).toBeVisible();

    await searchButton.click();
    await dialog.getByRole("tab", { name: "Folders" }).click();
    await page.getByPlaceholder("Search folders by path...").fill("nested");
    await expect(
      dialog.getByRole("option", { name: /nested/ }),
    ).toBeVisible();
    await dialog.getByRole("option", { name: /nested/ }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('[title="src/search/nested"]')).toBeVisible();
    await expect(
      page.getByText("src/search/quick-target.ts"),
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

test("terminal preview zooms image files and image changes", async ({
  page,
  request,
}) => {
  const repo = await createPreviewRepo();
  try {
    const token = await loginAndSeedToken(request, page);
    const session = await createProjectAndSession(request, token, {
      name: "Preview Image Project",
      path: repo,
    });

    await page.goto(
      `/terminal/${encodeURIComponent(session.terminalSessionId)}`,
    );
    await page.getByRole("tab", { name: "Open", exact: true }).click();
    await page
      .getByPlaceholder("Search file or paste absolute path...")
      .fill("preview sample");
    await page.getByText("preview-sample.png").click();
    await expectPreviewImageVisible(page);

    let lightbox = await openPreviewImageLightbox(page);
    await expect(
      lightbox.getByRole("button", { name: "Zoom in" }),
    ).toBeVisible();
    await lightbox.getByRole("button", { name: "Zoom in" }).click();
    await expect(
      lightbox.getByRole("button", { name: "Zoom out" }),
    ).toBeVisible();
    await lightbox.getByRole("button", { name: "Close", exact: true }).click();
    await expect(lightbox).not.toBeVisible();

    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: /preview-sample\.png/ }).click();
    await expectPreviewImageVisible(page);
    lightbox = await openPreviewImageLightbox(page);
    await expect(
      lightbox.getByRole("button", { name: "Zoom in" }),
    ).toBeVisible();
    await lightbox.getByRole("button", { name: "Close", exact: true }).click();
    await expect(lightbox).not.toBeVisible();
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
