import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
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

async function createPreviewRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "terminal-preview-e2e-"));
  await mkdir(path.join(repo, "docs/architecture"), { recursive: true });
  await mkdir(path.join(repo, "docs/architecture/assets"), { recursive: true });
  await mkdir(path.join(repo, "generated"), { recursive: true });
  await writeFile(path.join(repo, ".gitignore"), "generated/\n");
  await writeFile(
    path.join(repo, "docs/architecture/terminal-code-preview.md"),
    "# Terminal Preview Plan\n\n![Preview screenshot](assets/preview.png)\n",
  );
  await writeFile(
    path.join(repo, "docs/architecture/assets/preview.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lY3pKAAAAABJRU5ErkJggg==",
      "base64",
    ),
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

test("terminal preview opens files and changes", async ({ page, request }) => {
  const repo = await createPreviewRepo();
  try {
    const token = await loginAndSeedToken(request, page);
    const projectResponse = await request.post(
      `${E2E_API_BASE}/api/terminal/project`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        data: {
          name: "Preview Project",
          path: repo,
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
          cwd: repo,
        },
      },
    );
    expect(sessionResponse.ok()).toBe(true);
    const session = (await sessionResponse.json()) as {
      terminalSessionId: string;
    };
    const secondSessionResponse = await request.post(
      `${E2E_API_BASE}/api/terminal/session`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        data: {
          projectId: project.projectId,
          command: "bash",
          cwd: repo,
        },
      },
    );
    expect(secondSessionResponse.ok()).toBe(true);

    let previewFileRequestCount = 0;
    let previewGitChangesRequestCount = 0;
    let previewFileDiffRequestCount = 0;
    await page.route("**/api/terminal/**/preview/file?**", async (route) => {
      previewFileRequestCount += 1;
      await route.continue();
    });
    await page.route("**/api/terminal/**/preview/git-changes", async (route) => {
      previewGitChangesRequestCount += 1;
      await route.continue();
    });
    await page.route("**/api/terminal/**/preview/file-diff?**", async (route) => {
      previewFileDiffRequestCount += 1;
      await route.continue();
    });

    await page.goto(`/terminal/${encodeURIComponent(session.terminalSessionId)}`);
    await expect(
      page.getByRole("button", { name: "Preview", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "Preview", exact: true }),
    ).toHaveAttribute("aria-selected", "true");

    await page
      .getByRole("button", { name: "Open file...", exact: true })
      .first()
      .click();
    await expect(page.getByText("README.md")).toBeVisible();
    await expect(page.getByText("Changed files", { exact: true })).toBeVisible();
    await expect(page.getByText("staged.txt")).toBeVisible();
    await page
      .getByPlaceholder("Search file or paste absolute path...")
      .fill("terminal preview");
    await expect(page.getByText("terminal-code-preview.md")).toBeVisible();
    await expect(page.getByText("terminal-code-preview.js")).not.toBeVisible();
    await page.getByText("terminal-code-preview.md").click();
    await expect(
      page.getByText("docs/architecture/terminal-code-preview.md"),
    ).toBeVisible();
    const terminalBeforeExpand = await page
      .getByLabel("Terminal emulator")
      .boundingBox();
    expect(terminalBeforeExpand).not.toBeNull();

    await page.getByRole("button", { name: "Expand preview" }).click();
    await expect(
      page.getByRole("button", { name: "Restore preview" }),
    ).toBeVisible();

    const terminalAfterExpand = await page.getByLabel("Terminal emulator").boundingBox();
    expect(terminalAfterExpand).not.toBeNull();
    expect(Math.round(terminalAfterExpand!.width)).toBe(
      Math.round(terminalBeforeExpand!.width),
    );

    previewFileRequestCount = 0;
    await page.getByRole("button", { name: "Preview Project" }).click();
    await page.waitForTimeout(500);
    expect(previewFileRequestCount).toBe(0);
    await expect(
      page.getByText("docs/architecture/terminal-code-preview.md"),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Preview: File", exact: true })
      .click();
    await page.getByText("Changes").click();
    await expect(page.getByText("Staged Changes")).toBeVisible();
    await expect.poll(() => previewGitChangesRequestCount).toBe(1);
    await expect.poll(() => previewFileDiffRequestCount).toBe(1);
    await expect(
      page.getByRole("button", { name: /staged\.txt/ }),
    ).toBeVisible();
    await expect(page.getByText("Working Changes")).toBeVisible();
    await expect(page.getByRole("button", { name: /README\.md/ })).toBeVisible();

    await Promise.all([
      page.waitForResponse((response) => {
        return (
          response.url().includes("/preview/file-diff?") &&
          response.url().includes("path=README.md") &&
          response.ok()
        );
      }),
      page.getByRole("button", { name: /README\.md/ }).click(),
    ]);
    expect(previewGitChangesRequestCount).toBe(1);
    await expect.poll(() => previewFileDiffRequestCount).toBe(2);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("terminal markdown preview opens clicked images in a lightbox", async ({
  page,
  request,
}) => {
  const repo = await createPreviewRepo();
  try {
    const token = await loginAndSeedToken(request, page);
    const projectResponse = await request.post(
      `${E2E_API_BASE}/api/terminal/project`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        data: {
          name: "Preview Project",
          path: repo,
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
          cwd: repo,
        },
      },
    );
    expect(sessionResponse.ok()).toBe(true);
    const session = (await sessionResponse.json()) as {
      terminalSessionId: string;
    };

    await page.goto(`/terminal/${encodeURIComponent(session.terminalSessionId)}`);
    await page
      .getByRole("button", { name: "Open file...", exact: true })
      .first()
      .click();
    await page
      .getByPlaceholder("Search file or paste absolute path...")
      .fill("terminal preview");
    await page.getByText("terminal-code-preview.md").click();

    const image = page.getByRole("img", { name: "Preview screenshot" });
    await expect(image).toBeVisible();
    await image.click();

    const lightbox = page.getByRole("dialog", { name: "Image preview" });
    await expect(lightbox).toBeVisible();
    await expect(
      lightbox.getByRole("img", { name: "Preview screenshot" }),
    ).toBeVisible();

    await lightbox.getByRole("button", { name: "Close" }).click();
    await expect(lightbox).not.toBeVisible();
    await expect(
      page.getByRole("img", { name: "Preview screenshot" }).first(),
    ).toBeVisible();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("terminal sidecar browser keeps global tabs in web mode", async ({
  page,
  request,
}) => {
  const repo = await createPreviewRepo();
  try {
    const token = await loginAndSeedToken(request, page);
    const projectResponse = await request.post(
      `${E2E_API_BASE}/api/terminal/project`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        data: {
          name: "Browser Project",
          path: repo,
        },
      },
    );
    expect(projectResponse.ok()).toBe(true);
    const project = (await projectResponse.json()) as { projectId: string };
    const firstSessionResponse = await request.post(
      `${E2E_API_BASE}/api/terminal/session`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        data: {
          projectId: project.projectId,
          command: "bash",
          cwd: repo,
        },
      },
    );
    expect(firstSessionResponse.ok()).toBe(true);
    const firstSession = (await firstSessionResponse.json()) as {
      terminalSessionId: string;
    };
    const secondSessionResponse = await request.post(
      `${E2E_API_BASE}/api/terminal/session`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        data: {
          projectId: project.projectId,
          command: "bash",
          cwd: repo,
        },
      },
    );
    expect(secondSessionResponse.ok()).toBe(true);

    await page.goto(`/terminal/${encodeURIComponent(firstSession.terminalSessionId)}`);
    await page.getByRole("tab", { name: "Browser", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "Browser", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByText("Local browser is available in the desktop app."),
    ).toBeVisible();

    const terminalBeforeResize = await page
      .getByLabel("Terminal emulator")
      .boundingBox();
    expect(terminalBeforeResize).not.toBeNull();
    const resizeHandle = page.getByRole("separator", { name: "Resize sidecar" });
    const resizeHandleBox = await resizeHandle.boundingBox();
    expect(resizeHandleBox).not.toBeNull();
    await page.mouse.move(
      resizeHandleBox!.x + resizeHandleBox!.width / 2,
      resizeHandleBox!.y + resizeHandleBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      resizeHandleBox!.x - 100,
      resizeHandleBox!.y + resizeHandleBox!.height / 2,
      { steps: 5 },
    );
    await page.mouse.up();
    await expect
      .poll(async () => {
        const terminalAfterResize = await page
          .getByLabel("Terminal emulator")
          .boundingBox();
        return terminalAfterResize?.width ?? 0;
      })
      .toBeLessThan(terminalBeforeResize!.width - 50);

    const address = page.getByLabel("Browser address");
    await address.fill("5173");
    await address.press("Enter");
    await expect(address).toHaveValue("http://127.0.0.1:5173/");

    await page.getByRole("button", { name: "New browser tab" }).click();
    await address.fill("localhost:5173");
    await address.press("Enter");
    await expect(address).toHaveValue(
      /^(http:\/\/(localhost|127\.0\.0\.1):5173\/|localhost:5173)$/,
    );
    await expect(page.getByRole("tab", { name: /5173\// })).toHaveCount(2);

    await page
      .locator(`[data-terminal-session-id="${firstSession.terminalSessionId}"]`)
      .click();
    await expect(address).toHaveValue(
      /^(http:\/\/(localhost|127\.0\.0\.1):5173\/|localhost:5173)$/,
    );

    await page.getByRole("button", { name: "Close browser tab" }).last().click();
    await expect(address).toHaveValue("http://127.0.0.1:5173/");
    await page.getByRole("button", { name: "Close browser tab" }).click();
    await expect(address).toHaveValue("http://127.0.0.1:5173");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
