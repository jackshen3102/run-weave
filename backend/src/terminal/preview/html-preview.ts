import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { TerminalPreviewError, resolvePreviewPath } from "./paths";

const MAX_HTML_BYTES = 1024 * 1024;
const MAX_RESOURCE_BYTES = 5 * 1024 * 1024;

export async function resolveHtmlPreviewEntry(projectPath: string | null | undefined, requestedPath: string): Promise<string> {
  const { absolutePath } = await resolvePreviewPath(projectPath, requestedPath, { allowAbsoluteOutsideProject: true });
  if (!/\.html?$/i.test(absolutePath)) throw new TerminalPreviewError("Only HTML files can be previewed", 415);
  const info = await stat(absolutePath).catch(() => null);
  if (!info?.isFile()) throw new TerminalPreviewError("HTML file not found", 404);
  if (info.size > MAX_HTML_BYTES) throw new TerminalPreviewError("HTML file exceeds preview limit", 413);
  return absolutePath;
}

export async function resolveHtmlPreviewResource(entryPath: string, requestedPath: string): Promise<{
  filePath: string;
  size: number;
  stream: ReturnType<typeof createReadStream>;
}> {
  const root = path.dirname(entryPath);
  const resourcePath = requestedPath || path.basename(entryPath);
  if (resourcePath.startsWith("/") || resourcePath.includes("\\") || resourcePath.split("/").some((part) => part === ".." || part === "." || !part)) {
    throw new TerminalPreviewError("Invalid HTML preview resource path", 403);
  }
  const candidate = path.resolve(root, resourcePath);
  const resolved = await realpath(candidate).catch(() => null);
  if (!resolved) throw new TerminalPreviewError("HTML preview resource not found", 404);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new TerminalPreviewError("HTML preview resource is outside its directory", 403);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) throw new TerminalPreviewError("Only regular files can be previewed", 400);
  if (info.size > (resolved === entryPath ? MAX_HTML_BYTES : MAX_RESOURCE_BYTES)) throw new TerminalPreviewError("HTML preview resource exceeds limit", 413);
  return { filePath: resolved, size: info.size, stream: createReadStream(resolved) };
}
