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
  await writeFile(
    path.join(repo, "docs/architecture/terminal-code-preview.md"),
    "# Terminal Preview Plan\n",
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
          name: "Terminal One",
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
          name: "Terminal Two",
          command: "bash",
          cwd: repo,
        },
      },
    );
    expect(secondSessionResponse.ok()).toBe(true);

    let previewFileRequestCount = 0;
    await page.route("**/api/terminal/**/preview/file?**", async (route) => {
      previewFileRequestCount += 1;
      await route.continue();
    });

    await page.goto(`/terminal/${encodeURIComponent(session.terminalSessionId)}`);
    await expect(
      page.getByRole("button", { name: "Preview", exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.getByText("Open file...").click();
    await page
      .getByPlaceholder("Search file or paste absolute path...")
      .fill("terminal preview");
    await page.getByText("terminal-code-preview.md").click();
    await expect(
      page.getByText("docs/architecture/terminal-code-preview.md"),
    ).toBeVisible();

    previewFileRequestCount = 0;
    await page
      .getByRole("button", { name: path.basename(repo), exact: true })
      .nth(1)
      .click();
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
    await expect(
      page.getByRole("button", { name: /staged\.txt/ }),
    ).toBeVisible();
    await expect(page.getByText("Working Changes")).toBeVisible();
    await expect(page.getByRole("button", { name: /README\.md/ })).toBeVisible();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
