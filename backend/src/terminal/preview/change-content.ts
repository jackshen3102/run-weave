import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { TerminalPreviewContentSide } from "@runweave/shared/terminal/preview";
import { detectImageMimeType, IMAGE_PREVIEW_MAX_BYTES } from "./image-format";
import { isLikelyBinary, resolvePreviewPath, TerminalPreviewError } from "./paths";

const exec = promisify(execFile);
const TEXT_LIMIT = 1024 * 1024;
export type ChangeContent = { side: TerminalPreviewContentSide; text: string; bytes?: Buffer };
async function git(root: string, args: string[], maxBuffer = 1024 * 1024) {
  return (await exec("git", args, { cwd: root, encoding: "buffer", maxBuffer, timeout: 5000,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" } })).stdout;
}

/** Read only bounded regular-file bytes. Git objects never pass through UTF-8 decoding first. */
export async function readChangeContent(options: {
  projectPath: string; repoRoot: string; repoPath: string;
  filePath: string; source: TerminalPreviewContentSide["source"];
}): Promise<ChangeContent> {
  const { projectPath, repoRoot, repoPath, filePath, source } = options;
  const side: TerminalPreviewContentSide = { source, path: filePath, state: "read-failed" };
  const result: ChangeContent = { side, text: "" };
  try {
    let bytes: Buffer;
    if (source === "working") {
      const resolved = await resolvePreviewPath(projectPath, filePath);
      // Do not follow a final symlink; parent path confinement is checked above.
      if (resolved.relativePath !== filePath) { side.state = "unsupported"; return result; }
      let handle;
      try { handle = await open(resolved.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { side.state = "missing"; return result; }
        throw error;
      }
      try {
        const stats = await handle.stat();
        side.sizeBytes = stats.size;
        if (!stats.isFile()) { side.state = "unsupported"; return result; }
        if (stats.size > IMAGE_PREVIEW_MAX_BYTES) { side.state = "too-large"; return result; }
        const buffer = Buffer.alloc(IMAGE_PREVIEW_MAX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length > IMAGE_PREVIEW_MAX_BYTES) { side.state = "too-large"; return result; }
        const after = await handle.stat();
        if (after.size !== stats.size || after.mtimeMs !== stats.mtimeMs || after.ctimeMs !== stats.ctimeMs) return result;
        bytes = buffer.subarray(0, length);
      } finally { await handle.close(); }
    } else {
      if (source === "head") {
        try { await git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]); }
        catch (error) {
          if ((error as { code?: number }).code === 1) { side.state = "missing"; return result; }
          throw error;
        }
      }
      const listing = (await git(repoRoot, source === "head"
        ? ["ls-tree", "-z", "HEAD", "--", repoPath]
        : ["ls-files", "--stage", "-z", "--", repoPath])).toString("utf8").split("\0").filter(Boolean);
      if (!listing.length) { side.state = "missing"; return result; }
      if (listing.length !== 1) { side.state = "unsupported"; return result; }
      const record = listing[0]!;
      const separator = record.indexOf("\t");
      const header = record.slice(0, separator);
      const listedPath = record.slice(separator + 1);
      const fields = header.split(" ");
      if (listedPath !== repoPath || !["100644", "100755"].includes(fields[0] ?? "")
        || (source === "index" && fields[2] !== "0")) { side.state = "unsupported"; return result; }
      const oid = fields[source === "head" ? 2 : 1];
      if (!oid || !/^[a-f0-9]{40,64}$/.test(oid)) return result;
      const size = Number((await git(repoRoot, ["cat-file", "-s", oid])).toString());
      side.sizeBytes = size;
      if (size > IMAGE_PREVIEW_MAX_BYTES) { side.state = "too-large"; return result; }
      bytes = await git(repoRoot, ["cat-file", "blob", oid], IMAGE_PREVIEW_MAX_BYTES + 1);
    }
    side.sizeBytes = bytes.length;
    side.version = createHash("sha256").update(bytes).digest("hex");
    const mime = detectImageMimeType(bytes, filePath);
    const isImage = mime && mime !== "image/svg+xml";
    let binary = isLikelyBinary(bytes) || bytes.subarray(0, 5).toString("ascii") === "%PDF-";
    if (!isImage && !binary) {
      try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { binary = true; }
    }
    side.contentKind = isImage ? "image" : binary ? "binary" : "text";
    if (mime) side.mimeType = mime;
    if (side.contentKind === "text" && bytes.length > TEXT_LIMIT) { side.state = "too-large"; return result; }
    // Extensions alone cannot turn arbitrary binary files into supported images.
    if (side.contentKind === "binary") { side.state = "unsupported"; return result; }
    if (!mime && /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(path.basename(filePath))) {
      side.contentKind = "binary"; side.state = "unsupported"; return result;
    }
    side.state = "ready";
    result.bytes = bytes;
    if (side.contentKind === "text") result.text = bytes.toString("utf8");
    return result;
  } catch (error) {
    if (error instanceof TerminalPreviewError && error.statusCode === 403) throw error;
    return result;
  }
}
