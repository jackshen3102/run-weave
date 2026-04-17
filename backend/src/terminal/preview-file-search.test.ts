import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearPreviewFileSearchCache, searchPreviewFiles } from "./preview";

const tempDirs: string[] = [];

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "preview-search-"));
  tempDirs.push(projectPath);
  return projectPath;
}

describe("preview file search", () => {
  afterEach(async () => {
    clearPreviewFileSearchCache();
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("respects gitignore when searching files", async () => {
    const projectPath = await createProject();
    await mkdir(path.join(projectPath, "src"), { recursive: true });
    await mkdir(path.join(projectPath, "generated"), { recursive: true });
    await writeFile(path.join(projectPath, ".gitignore"), "generated/\n");
    await writeFile(path.join(projectPath, "src/terminal-preview.ts"), "export {};\n");
    await writeFile(path.join(projectPath, "generated/terminal-preview.js"), "ignored\n");

    const payload = await searchPreviewFiles({
      projectId: "project-1",
      projectPath,
      query: "terminal preview",
      limit: 20,
    });

    expect(payload.items.map((item) => item.path)).toContain(
      "src/terminal-preview.ts",
    );
    expect(payload.items.map((item) => item.path)).not.toContain(
      "generated/terminal-preview.js",
    );
  });

  it("excludes sensitive env files while keeping safe env templates searchable", async () => {
    const projectPath = await createProject();
    await writeFile(path.join(projectPath, ".env"), "SECRET=1\n");
    await writeFile(path.join(projectPath, ".env.local"), "SECRET=2\n");
    await writeFile(path.join(projectPath, ".env.development.local"), "SECRET=3\n");
    await writeFile(path.join(projectPath, ".env.example"), "PUBLIC_VALUE=1\n");
    await writeFile(path.join(projectPath, ".env.sample"), "PUBLIC_VALUE=2\n");
    await writeFile(path.join(projectPath, "config.local"), "not an env file\n");
    await writeFile(path.join(projectPath, "environment-notes.md"), "notes\n");

    const envPayload = await searchPreviewFiles({
      projectId: "project-1",
      projectPath,
      query: "env",
      limit: 20,
    });
    const envPaths = envPayload.items.map((item) => item.path);
    expect(envPaths).toContain("environment-notes.md");
    expect(envPaths).toContain(".env.example");
    expect(envPaths).toContain(".env.sample");
    expect(envPaths).not.toContain(".env");
    expect(envPaths).not.toContain(".env.local");
    expect(envPaths).not.toContain(".env.development.local");

    const localPayload = await searchPreviewFiles({
      projectId: "project-1",
      projectPath,
      query: "local",
      limit: 20,
    });
    const localPaths = localPayload.items.map((item) => item.path);
    expect(localPaths).toContain("config.local");
    expect(localPaths).not.toContain(".env.local");
    expect(localPaths).not.toContain(".env.development.local");
  });

  it("keeps useful hidden project config searchable while excluding hidden system folders", async () => {
    const projectPath = await createProject();
    await mkdir(path.join(projectPath, ".vscode"), { recursive: true });
    await mkdir(path.join(projectPath, ".git/hooks"), { recursive: true });
    await writeFile(path.join(projectPath, ".vscode/preview-settings.json"), "{}\n");
    await writeFile(path.join(projectPath, ".git/hooks/preview-hook"), "ignored\n");
    await writeFile(path.join(projectPath, ".DS_Store"), "ignored\n");

    const payload = await searchPreviewFiles({
      projectId: "project-1",
      projectPath,
      query: "preview",
      limit: 20,
    });

    expect(payload.items.map((item) => item.path)).toContain(
      ".vscode/preview-settings.json",
    );
    expect(payload.items.map((item) => item.path)).not.toContain(
      ".git/hooks/preview-hook",
    );

    const systemPayload = await searchPreviewFiles({
      projectId: "project-1",
      projectPath,
      query: "store",
      limit: 20,
    });
    expect(systemPayload.items.map((item) => item.path)).not.toContain(".DS_Store");
  });

  it("ranks exact relative path matches before weak basename matches", async () => {
    const projectPath = await createProject();
    await mkdir(path.join(projectPath, "docs/architecture"), { recursive: true });
    await mkdir(path.join(projectPath, "src/preview"), { recursive: true });
    await writeFile(
      path.join(projectPath, "docs/architecture/terminal-code-preview.md"),
      "# Preview\n",
    );
    await writeFile(path.join(projectPath, "src/preview/terminal.ts"), "export {};\n");

    const payload = await searchPreviewFiles({
      projectId: "project-1",
      projectPath,
      query: "docs architecture terminal code preview",
      limit: 20,
    });

    expect(payload.items[0]?.path).toBe(
      "docs/architecture/terminal-code-preview.md",
    );
  });

  it("matches abbreviations as a single fuzzy query piece", async () => {
    const projectPath = await createProject();
    await mkdir(path.join(projectPath, "src"), { recursive: true });
    await writeFile(path.join(projectPath, "src/terminal-preview.ts"), "export {};\n");

    const payload = await searchPreviewFiles({
      projectId: "project-1",
      projectPath,
      query: "tp",
      limit: 20,
    });

    expect(payload.items.map((item) => item.path)).toContain(
      "src/terminal-preview.ts",
    );
  });

  it("scores space-separated query pieces independently while requiring every piece to match", async () => {
    const projectPath = await createProject();
    await mkdir(path.join(projectPath, "docs"), { recursive: true });
    await writeFile(path.join(projectPath, "docs/terminal-preview-plan.md"), "# Plan\n");
    await writeFile(path.join(projectPath, "terminal-only.md"), "# Terminal\n");
    await writeFile(path.join(projectPath, "preview-only.md"), "# Preview\n");

    const payload = await searchPreviewFiles({
      projectId: "project-1",
      projectPath,
      query: "preview terminal",
      limit: 20,
    });

    expect(payload.items.map((item) => item.path)).toContain(
      "docs/terminal-preview-plan.md",
    );
    expect(payload.items.map((item) => item.path)).not.toContain("terminal-only.md");
    expect(payload.items.map((item) => item.path)).not.toContain("preview-only.md");
  });

  it("reuses cached candidate files for repeated project searches", async () => {
    const projectPath = await createProject();
    await writeFile(path.join(projectPath, "first-preview.md"), "# First\n");

    const first = await searchPreviewFiles({
      projectId: "project-1",
      projectPath,
      query: "preview",
      limit: 20,
    });
    expect(first.items.map((item) => item.path)).toContain("first-preview.md");

    await writeFile(path.join(projectPath, "second-preview.md"), "# Second\n");

    const second = await searchPreviewFiles({
      projectId: "project-1",
      projectPath,
      query: "preview",
      limit: 20,
    });
    expect(second.items.map((item) => item.path)).toContain("first-preview.md");
    expect(second.items.map((item) => item.path)).not.toContain("second-preview.md");

    clearPreviewFileSearchCache("project-1");

    const afterClear = await searchPreviewFiles({
      projectId: "project-1",
      projectPath,
      query: "preview",
      limit: 20,
    });
    expect(afterClear.items.map((item) => item.path)).toContain(
      "second-preview.md",
    );
  });
});
