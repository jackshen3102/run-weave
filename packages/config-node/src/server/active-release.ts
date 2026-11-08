import { createHash, randomUUID } from "node:crypto";
import { existsSync, openSync, closeSync, fsyncSync, writeFileSync, readFileSync, renameSync, realpathSync } from "node:fs";
import path from "node:path";
import { readPrivateFile } from "../private-file";

/** Windows switches a file, never replaces a live directory junction. */
export function resolveActiveServerRelease(home: string): string | undefined {
  const pointer = path.join(home, "active-release.json");
  if (process.platform === "win32" && existsSync(pointer)) {
    const value = JSON.parse(readPrivateFile(pointer, 16384)) as { schemaVersion: number; release: string; manifestDigest: string; transactionId: string };
    if (value.schemaVersion !== 1 || !/^releases\/[a-zA-Z0-9._-]+$/.test(value.release) || !/^[a-f0-9]{64}$/.test(value.manifestDigest) || !value.transactionId)
      throw new Error("SERVER_POINTER_INVALID");
    const release = realpathSync(path.join(home, value.release));
    if (path.dirname(release) !== realpathSync(path.join(home, "releases")) || digest(release) !== value.manifestDigest)
      throw new Error("SERVER_POINTER_INVALID");
    return release;
  }
  const legacy = path.join(home, "current");
  if (!existsSync(legacy)) return undefined;
  const release = realpathSync(legacy);
  if (path.dirname(release) !== realpathSync(path.join(home, "releases"))) throw new Error("SERVER_POINTER_INVALID");
  return release;
}
function digest(release: string): string {
  return createHash("sha256").update(readFileSync(path.join(release, "server-manifest.json"))).digest("hex");
}
export function activateWindowsServerRelease(home: string, release: string, transactionId = randomUUID()): void {
  release = realpathSync(release);
  if (path.dirname(release) !== realpathSync(path.join(home, "releases"))) throw new Error("SERVER_POINTER_INVALID");
  const pointer = path.join(home, "active-release.json");
  const temporary = `${pointer}.${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ schemaVersion: 1, release: `releases/${path.basename(release)}`, manifestDigest: digest(release), transactionId }) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, pointer);
}
