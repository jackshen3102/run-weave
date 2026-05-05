import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deletePreviewFile,
  renamePreviewFile,
  TerminalPreviewError,
} from "./preview";

const tempPaths: string[] = [];

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "preview-mutate-"));
  tempPaths.push(projectPath);
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

describe("preview file mutations", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.map((targetPath) =>
        rm(targetPath, { recursive: true, force: true }),
      ),
    );
    tempPaths.length = 0;
  });

  it("deletes project files", async () => {
    const projectPath = await createProject();
    const filePath = path.join(projectPath, "README.md");
    await writeFile(filePath, "# Preview\n");
    const before = await stat(filePath);
    const realFilePath = await realpath(filePath);

    const payload = await deletePreviewFile({
      projectId: "project-1",
      projectPath,
      requestedPath: "README.md",
      expectedMtimeMs: before.mtimeMs,
    });

    expect(payload).toEqual({
      kind: "file-delete",
      projectId: "project-1",
      path: "README.md",
      absolutePath: realFilePath,
    });
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });

  it("rejects deleting directories and project-external paths", async () => {
    const projectPath = await createProject();
    await mkdir(path.join(projectPath, "src"));
    const outsideFile = path.join(
      os.tmpdir(),
      `preview-outside-${Date.now()}.txt`,
    );
    await writeFile(outsideFile, "outside\n");
    tempPaths.push(outsideFile);

    await expectPreviewError(
      () =>
        deletePreviewFile({
          projectId: "project-1",
          projectPath,
          requestedPath: "src",
        }),
      400,
    );
    await expectPreviewError(
      () =>
        deletePreviewFile({
          projectId: "project-1",
          projectPath,
          requestedPath: outsideFile,
        }),
      403,
    );
  });

  it("detects delete mtime conflicts", async () => {
    const projectPath = await createProject();
    const filePath = path.join(projectPath, "README.md");
    await writeFile(filePath, "one\n");
    const before = await stat(filePath);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(filePath, "external\n");

    await expectPreviewError(
      () =>
        deletePreviewFile({
          projectId: "project-1",
          projectPath,
          requestedPath: "README.md",
          expectedMtimeMs: before.mtimeMs,
        }),
      409,
    );
    await expect(readFile(filePath, "utf8")).resolves.toBe("external\n");
  });

  it("renames project files and returns the new preview payload", async () => {
    const projectPath = await createProject();
    await mkdir(path.join(projectPath, "docs"));
    const filePath = path.join(projectPath, "README.md");
    await writeFile(filePath, "# Preview\n");
    const before = await stat(filePath);

    const payload = await renamePreviewFile({
      projectId: "project-1",
      projectPath,
      requestedPath: "README.md",
      nextRequestedPath: "docs/renamed.md",
      expectedMtimeMs: before.mtimeMs,
    });
    const renamedPath = path.join(projectPath, "docs/renamed.md");
    const realRenamedPath = await realpath(renamedPath);

    expect(payload).toEqual(
      expect.objectContaining({
        kind: "file",
        projectId: "project-1",
        path: "docs/renamed.md",
        absolutePath: realRenamedPath,
        content: "# Preview\n",
        readonly: false,
      }),
    );
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
    await expect(readFile(renamedPath, "utf8")).resolves.toBe("# Preview\n");
  });

  it("rejects rename conflicts, missing parents, and outside paths", async () => {
    const projectPath = await createProject();
    await writeFile(path.join(projectPath, "README.md"), "# Preview\n");
    await writeFile(path.join(projectPath, "existing.md"), "exists\n");
    const outsideFile = path.join(
      os.tmpdir(),
      `preview-outside-${Date.now()}.txt`,
    );
    tempPaths.push(outsideFile);

    await expectPreviewError(
      () =>
        renamePreviewFile({
          projectId: "project-1",
          projectPath,
          requestedPath: "README.md",
          nextRequestedPath: "existing.md",
        }),
      409,
    );
    await expectPreviewError(
      () =>
        renamePreviewFile({
          projectId: "project-1",
          projectPath,
          requestedPath: "README.md",
          nextRequestedPath: "missing/renamed.md",
        }),
      400,
    );
    await expectPreviewError(
      () =>
        renamePreviewFile({
          projectId: "project-1",
          projectPath,
          requestedPath: "README.md",
          nextRequestedPath: outsideFile,
        }),
      403,
    );
  });
});
