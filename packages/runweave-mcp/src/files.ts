import { open, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);

export async function gitIdentity(file: string) {
  const run = (args: string[]) =>
    exec("git", ["-C", path.dirname(file), ...args], {
      timeout: 3000,
      maxBuffer: 128 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  try {
    const [{ stdout: root }, { stdout: head }, { stdout: status }] =
      await Promise.all([
        run(["rev-parse", "--show-toplevel"]),
        run(["rev-parse", "HEAD"]),
        run(["status", "--porcelain=v1", "--", file]),
      ]);
    return {
      repository: root.trim(),
      head: head.trim(),
      dirty: Boolean(status.trim()),
      dirtyScope: "this file",
      deployed: "unknown",
    };
  } catch {
    return undefined;
  }
}

export async function readChunk(file: string, offset: number, length = 32_768) {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Not a regular file");
    if (offset > info.size) throw new Error("File offset exceeds current size");
    const bytes = Buffer.alloc(Math.min(length, info.size - offset));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
    let end = bytesRead;
    // Leave an incomplete UTF-8 character for the following page.
    if (offset + end < info.size && end > 0) {
      let start = end - 1;
      while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--;
      const first = bytes[start]!;
      const width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
      if (start + width > end) end = start;
    }
    return {
      text: bytes.subarray(0, end).toString("utf8"),
      nextOffset: offset + end,
      size: info.size,
      hasMore: offset + end < info.size,
    };
  } finally {
    await handle.close();
  }
}

export async function fileVersion(file: string) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("Not a regular file");
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
