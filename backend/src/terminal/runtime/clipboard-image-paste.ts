import path from "node:path";
import os from "node:os";

export function splitClipboardImagePaste(text: string): string[] {
  // Codex recognizes an image only when its path is a standalone paste event.
  // Match only our uploaded-image path format, preserving all intervening text.
  const directory = `${path.join(os.tmpdir(), "runweave-terminal-images")}/`
    .replaceAll("'", "'\"'\"'").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const references = new RegExp(`'${directory}runweave-terminal-image-\\d{8}-\\d{6}-[a-f0-9]{6}\\.(?:png|jpg|webp|gif)'`, "g");
  const parts: string[] = [];
  let offset = 0;
  for (const match of text.matchAll(references)) {
    if (match.index > offset) parts.push(text.slice(offset, match.index));
    parts.push(match[0]);
    offset = match.index + match[0].length;
  }
  if (!parts.length) return [text];
  if (offset < text.length) parts.push(text.slice(offset));
  return parts;
}

