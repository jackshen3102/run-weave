import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

test("keeps one effective Project ID while switching the frozen Worktree rail", async ({
  page,
}) => {
  const fixtureRoot = mkdtempSync(
    path.join(os.tmpdir(), "runweave-worktree-context-"),
  );
  const projectRoot = path.join(fixtureRoot, "project");
  const outsideRoot = path.join(fixtureRoot, "outside");
  mkdirSync(projectRoot, { recursive: true });
  git(projectRoot, "init", "-b", "main");
  git(projectRoot, "config", "user.email", "runweave@example.invalid");
  git(projectRoot, "config", "user.name", "Runweave");
  writeFileSync(path.join(projectRoot, "context.txt"), "parent-context\n");
  git(projectRoot, "add", "context.txt");
  git(projectRoot, "commit", "-m", "fixture");
  mkdirSync(path.join(projectRoot, ".worktree"), { recursive: true });
  git(
    projectRoot,
    "worktree",
    "add",
    "-b",
    "feat/activity",
    path.join(projectRoot, ".worktree", "activity"),
  );
  git(
    projectRoot,
    "worktree",
    "add",
    "-b",
    "fix/outside",
    outsideRoot,
  );

  try {
    await page.goto("/login");
    await page.getByLabel("Username").fill("runweave-e2e");
    await page.getByLabel("Password").fill("runweave-e2e-password");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/terminal$/);

    await page.getByRole("button", { name: "New Project" }).click();
    await page.getByLabel("Project Name").fill("fixture");
    await page.getByLabel("Project Path").fill(projectRoot);
    await page
      .getByRole("button", { name: "Create Project", exact: true })
      .click();

    const rail = page.getByTestId("terminal-worktree-rail");
    const rows = rail.getByTestId("terminal-worktree-row");
    await expect(rows).toHaveCount(2);
    const primaryRow = rows.filter({ hasText: "fixture" });
    const childRow = rows.filter({ hasText: "activity" });
    await expect(primaryRow).toContainText("main");
    await expect(primaryRow.getByLabel("Permanently pinned")).toBeVisible();
    await expect(childRow).toContainText("feat/activity");
    await expect(rail).not.toContainText("outside");
    await expect(rail).not.toContainText(/changes|clean|ahead|behind/i);

    const childProjectId = await childRow.getAttribute("data-project-id");
    expect(childProjectId).toMatch(/^wt:/);
    await childRow.getByRole("button", { name: /activity/ }).click();
    await expect(childRow).toHaveAttribute("data-active", "true");

    const createSessionRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/terminal/session",
    );
    const createSessionResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/terminal/session",
    );
    await page.getByRole("button", { name: "New Terminal" }).click();
    const requestPayload = (await createSessionRequest).postDataJSON() as {
      projectId?: string;
      worktreeId?: string;
      worktreePath?: string;
    };
    expect(requestPayload.projectId).toBe(childProjectId);
    expect(requestPayload).not.toHaveProperty("worktreeId");
    expect(requestPayload).not.toHaveProperty("worktreePath");
    expect((await createSessionResponse).status()).toBe(201);
    await expect(
      page.getByRole("button", { name: "Close terminal activity" }),
    ).toHaveCount(1);

    await childRow.getByRole("button", { name: "Pin Worktree" }).click();
    await expect(
      childRow.getByRole("button", { name: "Unpin Worktree" }),
    ).toBeVisible();

    const expandedBox = await rail.boundingBox();
    expect(expandedBox?.width).toBeGreaterThanOrEqual(230);
    expect(expandedBox?.width).toBeLessThanOrEqual(242);
    await rail.getByRole("button", { name: "Collapse Worktrees" }).click();
    await expect(rail).toHaveAttribute("data-collapsed", "true");
    await expect
      .poll(async () => (await rail.boundingBox())?.width ?? 0)
      .toBeLessThanOrEqual(38);
    expect((await rail.boundingBox())?.width).toBeGreaterThanOrEqual(34);
    await page.reload();
    await expect(rail).toHaveAttribute("data-collapsed", "true");

    await rail.getByRole("button", { name: "Expand Worktrees" }).click();
    await expect(childRow).toHaveAttribute("data-active", "true");
    git(
      projectRoot,
      "worktree",
      "remove",
      "--force",
      path.join(projectRoot, ".worktree", "activity"),
    );
    await expect(childRow).toContainText("missing", { timeout: 6_000 });
    const rejectedSessionResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/terminal/session",
    );
    await page.getByRole("button", { name: "New Terminal" }).click();
    await expect((await rejectedSessionResponse).status()).toBe(409);
    await expect(
      page.getByRole("button", { name: "Close terminal activity" }),
    ).toHaveCount(1);

    await page
      .getByRole("button", { name: "Close terminal activity" })
      .click();
    await expect(childRow).toHaveCount(0, { timeout: 6_000 });
    await expect(primaryRow).toHaveAttribute("data-active", "true");
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});
