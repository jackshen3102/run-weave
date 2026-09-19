import { isSupportedTerminalFileLinkPath } from "./preview-core";

/** A file reference, before resolution on the terminal's backend. */
export interface TerminalFileReference {
  path: string;
  line?: number;
  column?: number;
  context?: TerminalFileLinkContext;
}

/** Snapshot at click time, clipped to the source pane. Lines are oldest first. */
export interface TerminalFileLinkContext {
  linePrefix: string;
  precedingLines: string[];
}

export interface TerminalFileLinkRequest extends TerminalFileReference {
  terminalSessionId: string;
  panelId?: string;
}

export interface TerminalFileLinkCandidate {
  path: string;
  absolutePath: string;
  base: "project" | "filesystem";
}

export interface TerminalFileLinkResponse {
  candidates: TerminalFileLinkCandidate[];
}

/** Parse a reference to a common previewable format, including explicit file:// links. */
export function parseTerminalFileReference(
  text: string,
): TerminalFileReference | null {
  let path = text.trim();
  if (!path || Array.from(path).some((character) => character.charCodeAt(0) < 32)) return null;
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      // Resolve only on the connected backend; never follow a different file host.
      if (url.hostname && url.hostname !== "localhost") return null;
      path = decodeURIComponent(url.pathname);
      const position = /^#L(\d+)(?:C(\d+))?$/.exec(url.hash);
      if (position) path += `:${position[1]}:${position[2] ?? 1}`;
    } catch {
      return null;
    }
  } else if (
    /^[a-z][a-z\d+.-]*:/i.test(path) &&
    !/^[A-Za-z]:[\\/]/.test(path)
  ) {
    // A trailing line number is not a URI scheme (e.g. README.md:12).
    if (!/:\d+(?::\d+)?$/.test(path)) return null;
  }
  if (/^["'`]/.test(path) && path.at(-1) === path[0]) path = path.slice(1, -1);
  const position = /:(\d+)(?::(\d+))?$/.exec(path);
  if (!position) return isSupportedTerminalFileLinkPath(path) ? { path } : null;
  const line = Number(position[1]);
  const column = Number(position[2] ?? 1);
  if (
    !Number.isSafeInteger(line) ||
    !Number.isSafeInteger(column) ||
    line < 1 ||
    column < 1
  )
    return null;
  path = path.slice(0, position.index).replace(/^["'`]|["'`]$/g, "");
  return isSupportedTerminalFileLinkPath(path) ? { path, line, column } : null;
}

export function findTerminalFileReferences(text: string): Array<{
  start: number;
  end: number;
  text: string;
}> {
  const results: Array<{ start: number; end: number; text: string }> = [];
  // Quotes preserve spaces; unquoted paths end at whitespace or common log delimiters.
  const tokens =
    /"[^"\r\n]+"(?::\d+(?::\d+)?)?|'[^'\r\n]+'(?::\d+(?::\d+)?)?|`[^`\r\n]+`(?::\d+(?::\d+)?)?|[^\s<>"'`()[\]{},;]+/gu;
  for (const match of text.matchAll(tokens)) {
    const raw = match[0].replace(/[.!?:]+$/, "");
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw) && !/^file:\/\//i.test(raw))
      continue;
    const reference = parseTerminalFileReference(raw);
    if (!reference) continue;
    results.push({
      start: match.index,
      end: match.index + raw.length,
      text: raw,
    });
  }
  return results;
}
