import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readPreviewAsset,
  readPreviewFile,
  TerminalPreviewError,
} from "./preview";

const tempDirs: string[] = [];

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "preview-read-"));
  tempDirs.push(projectPath);
  return projectPath;
}

describe("preview file reading", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("marks standalone svg files as svg preview content", async () => {
    const projectPath = await createProject();
    await writeFile(
      path.join(projectPath, "diagram.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" /></svg>\n',
    );

    const payload = await readPreviewFile({
      projectId: "project-1",
      projectPath,
      requestedPath: "diagram.svg",
    });

    expect(payload.language).toBe("svg");
    expect(payload.content).toContain("<svg");
  });

  it("returns allowed image assets with detected mime type and no-store caching", async () => {
    const projectPath = await createProject();
    const imageBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
    ]);
    await writeFile(path.join(projectPath, "preview.png"), imageBytes);

    const payload = await readPreviewAsset({
      projectId: "project-1",
      projectPath,
      requestedPath: "preview.png",
    });

    expect(payload.path).toBe("preview.png");
    expect(payload.mimeType).toBe("image/png");
    expect(payload.cacheControl).toBe("no-store");
    expect(payload.content.equals(imageBytes)).toBe(true);
  });

  it("returns standalone svg files as image assets for markdown image previews", async () => {
    const projectPath = await createProject();
    const svgContent =
      '<svg xmlns="http://www.w3.org/2000/svg"><text>Preview</text></svg>\n';
    await mkdir(path.join(projectPath, "assets"), { recursive: true });
    await writeFile(path.join(projectPath, "assets/preview.svg"), svgContent);

    const payload = await readPreviewAsset({
      projectId: "project-1",
      projectPath,
      requestedPath: "assets/preview.svg",
    });

    expect(payload.path).toBe("assets/preview.svg");
    expect(payload.mimeType).toBe("image/svg+xml");
    expect(payload.cacheControl).toBe("no-store");
    expect(payload.content.toString("utf8")).toBe(svgContent);
  });

  it("rejects image assets whose bytes do not match the allowlist", async () => {
    const projectPath = await createProject();
    await writeFile(path.join(projectPath, "preview.png"), "not actually png\n");

    await expect(
      readPreviewAsset({
        projectId: "project-1",
        projectPath,
        requestedPath: "preview.png",
      }),
    ).rejects.toMatchObject({
      message: "Image format is not supported",
      statusCode: 415,
    } satisfies Partial<TerminalPreviewError>);
  });

  it("rejects image asset symlinks that escape the project path", async () => {
    const projectPath = await createProject();
    const outsidePath = await createProject();
    await writeFile(
      path.join(outsidePath, "outside.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    await mkdir(path.join(projectPath, "assets"), { recursive: true });
    await symlink(
      path.join(outsidePath, "outside.png"),
      path.join(projectPath, "assets/outside.png"),
    );

    await expect(
      readPreviewAsset({
        projectId: "project-1",
        projectPath,
        requestedPath: "assets/outside.png",
      }),
    ).rejects.toMatchObject({
      message: "Path is outside the project path",
      statusCode: 403,
    } satisfies Partial<TerminalPreviewError>);
  });
});
