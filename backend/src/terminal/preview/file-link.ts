import { stat } from "node:fs/promises";
import path from "node:path";
import type {
  TerminalFileLinkContext,
  TerminalFileLinkResponse,
} from "@runweave/shared/terminal/file-link";
import { isSupportedTerminalFileLinkPath } from "@runweave/shared/terminal-preview-core";
import { resolvePreviewPath, TerminalPreviewError } from "./paths";

function fileLinkPaths(
  path: string,
  context?: TerminalFileLinkContext,
): string[] {
  const paths = [path];
  // Only a token at the start of a display row can continue the previous row.
  if (!context || context.linePrefix.trim()) return paths;
  let joined = path;
  for (const line of context.precedingLines.slice(-4).reverse()) {
    // Read the last path-like fragment, not prose, prompts, or a closed link.
    const fragment = /([^\s<>"'`()[\]{},;|&$#!?]+)\s*$/u.exec(line);
    const prefix = fragment?.[1];
    if (
      !fragment || !prefix ||
      prefix.includes(":") || Array.from(prefix).some((char) => char.charCodeAt(0) < 32) ||
      isSupportedTerminalFileLinkPath(prefix)
    )
      break;
    joined = prefix + joined;
    if (joined.length > 4096) break;
    paths.push(joined);
    // A label/opening delimiter establishes the beginning of the reference.
    if (line.slice(0, fragment.index).trim()) break;
  }
  return [...new Set(paths)];
}

export async function resolveTerminalFileLink(input: {
  projectPath: string | null;
  cwd: string | null;
  requestedPath: string;
  context?: TerminalFileLinkContext;
}): Promise<TerminalFileLinkResponse> {
  const requestedPath = input.requestedPath.trim();
  if (
    !requestedPath ||
    requestedPath.startsWith("~") ||
    Array.from(requestedPath).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new TerminalPreviewError(
      "Enter an absolute or relative file path",
      400,
    );
  }
  if (!isSupportedTerminalFileLinkPath(requestedPath)) {
    throw new TerminalPreviewError(
      "This file format is not supported by terminal file links",
      415,
    );
  }
  const candidates: TerminalFileLinkResponse["candidates"] = [];
  // Resolve every hypothesis; an existing short suffix must not hide a full path.
  for (const requestedPath of fileLinkPaths(
    input.requestedPath.trim(),
    input.context,
  )) {
    const absolute = path.isAbsolute(requestedPath);
    const explicitRelative = /^\.{1,2}[\\/]/.test(requestedPath);
    const roots = absolute
      ? [null]
      : explicitRelative
        ? [input.cwd]
        : [input.cwd, input.projectPath];
    for (const root of new Set(roots)) {
      if (!absolute && (!root || !path.isAbsolute(root))) continue;
      const target = absolute
        ? requestedPath
        : path.resolve(root!, requestedPath);
      try {
        // Preserve the relative-path containment rule, including symlinks. A cwd
        // supplies a base, not permission to escape a configured project root.
        const resolved = await resolvePreviewPath(input.projectPath, target, {
          allowAbsoluteOutsideProject: absolute || !input.projectPath,
        });
        // Preview chooses its renderer from the resolved path, including symlinks.
        if (!isSupportedTerminalFileLinkPath(resolved.previewPath)) continue;
        if (!(await stat(resolved.absolutePath)).isFile()) continue;
        if (
          !candidates.some(
            (item) => item.absolutePath === resolved.absolutePath,
          )
        ) {
          candidates.push({
            path: resolved.previewPath,
            absolutePath: resolved.absolutePath,
            base: resolved.base,
          });
        }
      } catch (error) {
        if (error instanceof TerminalPreviewError && error.statusCode !== 403)
          throw error;
        if (
          !(error instanceof TerminalPreviewError) &&
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          (error as NodeJS.ErrnoException).code !== "ENOTDIR"
        )
          throw error;
      }
    }
  }
  if (!candidates.length) {
    throw new TerminalPreviewError(
      "File not found in the terminal working directory or project. For a file outside the project, use its absolute path.",
      404,
    );
  }
  return { candidates };
}
