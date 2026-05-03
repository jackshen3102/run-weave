import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { savePreviewFile, TerminalPreviewError } from "./preview";

const tempDirs: string[] = [];

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "preview-save-"));
  tempDirs.push(projectPath);
  return projectPath;
}

async function expectPreviewError(
  action: () => Promise<unknown>,
  statusCode: number,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(TerminalPreviewError);
    expect((error as TerminalPreviewError).statusCode).toBe(statusCode);
    return;
  }
  throw new Error(`Expected TerminalPreviewError ${statusCode}`);
}

describe("savePreviewFile", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("saves text files and returns latest metadata", async () => {
    const projectPath = await createProject();
    await mkdir(path.join(projectPath, "src"), { recursive: true });
    const filePath = path.join(projectPath, "src/app.ts");
    await writeFile(filePath, "export const value = 1;\n");
    const before = await stat(filePath);

    const payload = await savePreviewFile({
      projectId: "project-1",
      projectPath,
      requestedPath: "src/app.ts",
      content: "export const value = 2;\n",
      expectedMtimeMs: before.mtimeMs,
    });

    expect(payload.path).toBe("src/app.ts");
    expect(payload.content).toBe("export const value = 2;\n");
    expect(payload.readonly).toBe(false);
    expect(payload.mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs);
    await expect(readFile(filePath, "utf8")).resolves.toBe(
      "export const value = 2;\n",
    );
  });

  it("rejects paths outside the project", async () => {
    const projectPath = await createProject();
    const outsideFile = path.join(os.tmpdir(), `preview-save-outside-${Date.now()}.txt`);
    await writeFile(outsideFile, "outside\n");
    tempDirs.push(outsideFile);

    await expectPreviewError(
      () =>
        savePreviewFile({
          projectId: "project-1",
          projectPath,
          requestedPath: outsideFile,
          content: "changed\n",
          expectedMtimeMs: 0,
        }),
      403,
    );
  });

  it("rejects directories", async () => {
    const projectPath = await createProject();
    await mkdir(path.join(projectPath, "src"), { recursive: true });

    await expectPreviewError(
      () =>
        savePreviewFile({
          projectId: "project-1",
          projectPath,
          requestedPath: "src",
          content: "changed\n",
          expectedMtimeMs: 0,
        }),
      400,
    );
  });

  it("rejects binary files", async () => {
    const projectPath = await createProject();
    await writeFile(path.join(projectPath, "image.bin"), Buffer.from([0, 1, 2, 3]));

    await expectPreviewError(
      () =>
        savePreviewFile({
          projectId: "project-1",
          projectPath,
          requestedPath: "image.bin",
          content: "changed\n",
          expectedMtimeMs: 0,
        }),
      415,
    );
  });

  it("rejects existing files above the preview size limit before saving", async () => {
    const projectPath = await createProject();
    const filePath = path.join(projectPath, "large.txt");
    await writeFile(filePath, Buffer.alloc(1024 * 1024 + 1, "a"));
    const before = await stat(filePath);

    await expectPreviewError(
      () =>
        savePreviewFile({
          projectId: "project-1",
          projectPath,
          requestedPath: "large.txt",
          content: "changed\n",
          expectedMtimeMs: before.mtimeMs,
        }),
      413,
    );
  });

  it("detects mtime conflicts", async () => {
    const projectPath = await createProject();
    const filePath = path.join(projectPath, "README.md");
    await writeFile(filePath, "one\n");
    const before = await stat(filePath);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(filePath, "external\n");

    await expectPreviewError(
      () =>
        savePreviewFile({
          projectId: "project-1",
          projectPath,
          requestedPath: "README.md",
          content: "draft\n",
          expectedMtimeMs: before.mtimeMs,
        }),
      409,
    );
    await expect(readFile(filePath, "utf8")).resolves.toBe("external\n");
  });

  it("allows overwrite after an mtime conflict", async () => {
    const projectPath = await createProject();
    const filePath = path.join(projectPath, "README.md");
    await writeFile(filePath, "one\n");
    const before = await stat(filePath);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(filePath, "external\n");

    const payload = await savePreviewFile({
      projectId: "project-1",
      projectPath,
      requestedPath: "README.md",
      content: "draft\n",
      expectedMtimeMs: before.mtimeMs,
      overwrite: true,
    });

    expect(payload.content).toBe("draft\n");
    await expect(readFile(filePath, "utf8")).resolves.toBe("draft\n");
  });
});
