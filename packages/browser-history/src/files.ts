import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, chmod } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
export const defaultHistoryRoot = () =>
  path.join(os.homedir(), ".runweave/browser-history");
export const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export async function privateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("UNSAFE_DIRECTORY");
  await chmod(dir, 0o700);
}
export async function privateJson(file: string, data: unknown): Promise<void> {
  await privateDirectory(path.dirname(file));
  const temp = file + "." + randomUUID();
  const fd = await open(temp, "wx", 0o600);
  try {
    await fd.writeFile(JSON.stringify(data, null, 2) + "\n");
    await fd.sync();
  } finally {
    await fd.close();
  }
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
export async function snapshot(file: string): Promise<Buffer> {
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile()) throw Error("NOT_A_FILE");
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const part = await fd.read(buffer, read, buffer.length - read, read);
      if (!part.bytesRead) throw Error("SOURCE_TRUNCATED");
      read += part.bytesRead;
    }
    return buffer;
  } finally {
    await fd.close();
  }
}
