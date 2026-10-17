import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { resolvePreviewPath, TerminalPreviewError } from "./paths";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

/** Open one validated descriptor for the whole response; never buffer the video. */
export async function openPreviewVideo(
  projectPath: string | null | undefined,
  requestedPath: string,
) {
  const resolved = await resolvePreviewPath(projectPath, requestedPath, {
    allowAbsoluteOutsideProject: true,
  });
  const mimeType = MIME[path.extname(resolved.absolutePath).toLowerCase()];
  if (!mimeType)
    throw new TerminalPreviewError("Unsupported video format", 415);
  const handle = await open(
    resolved.absolutePath,
    constants.O_RDONLY | constants.O_NONBLOCK,
  ).catch(() => {
    throw new TerminalPreviewError("Video file is unavailable", 404);
  });
  try {
    const stats = await handle.stat();
    if (!stats.isFile())
      throw new TerminalPreviewError(
        "Only regular video files can be previewed",
        400,
      );
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const sample = header.subarray(0, bytesRead);
    const valid =
      mimeType === "video/webm"
        ? sample.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
          sample.includes(Buffer.from("webm"))
        : sample.length >= 12 && sample.toString("ascii", 4, 8) === "ftyp";
    if (!valid)
      throw new TerminalPreviewError(
        "File is not a supported video container",
        415,
      );
    return {
      handle,
      absolutePath: resolved.absolutePath,
      mimeType,
      size: stats.size,
      version: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function previewVideoRange(
  value: string | undefined,
  size: number,
): { start: number; end: number; partial: boolean } {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  const invalid = () => {
    throw new TerminalPreviewError("Video range is not satisfiable", 416);
  };
  if (!match || (!match[1] && !match[2])) return invalid();
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalid();
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= size ||
      end < start
    )
      return invalid();
    end = Math.min(end, size - 1);
  }
  return { start, end, partial: true };
}
