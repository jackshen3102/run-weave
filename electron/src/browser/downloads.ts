import type { DownloadItem } from "electron";
import type {
  BrowserDownloadChunk,
  BrowserDownloadSnapshot,
} from "@runweave/shared/browser-downloads";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import { randomUUID } from "node:crypto";
import { constants, mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_BYTES = 512 * 1024 * 1024;
const RETENTION_MS = 60 * 60_000;
const captures = new Map<string, number>();
const downloads = new Map<
  string,
  {
    scope: string;
    file: string;
    item: DownloadItem;
    snapshot: BrowserDownloadSnapshot;
  }
>();
let directory: string | null = null;
const scopeKey = (profile: TerminalBrowserProfileId, group: string) =>
  `${profile}:${group}`;

function prune(): void {
  const now = Date.now();
  for (const [key, expires] of captures)
    if (expires <= now) captures.delete(key);
  for (const [id, record] of downloads) {
    if (
      record.snapshot.state !== "progressing" &&
      now - record.snapshot.createdAt >= RETENTION_MS
    ) {
      rmSync(record.file, { force: true });
      downloads.delete(id);
    }
  }
}

export function captureBrowserDownloads(
  profile: TerminalBrowserProfileId,
  group: string,
  enabled: boolean,
) {
  prune();
  const scope = scopeKey(profile, group);
  if (
    enabled &&
    (downloads.size >= 128 || (!captures.has(scope) && captures.size >= 64))
  )
    throw new Error("DOWNLOAD_CAPACITY_EXCEEDED");
  const expiresAt = enabled ? Date.now() + 30 * 60_000 : null;
  if (expiresAt) captures.set(scope, expiresAt);
  else captures.delete(scope);
  return {
    enabled,
    expiresAt,
    maxFileBytes: MAX_BYTES,
    retentionMs: RETENTION_MS,
  };
}

/** Capture only downloads from an explicitly enabled Profile/Group. */
export function trackBrowserDownload(
  item: DownloadItem,
  identity: {
    profileId: TerminalBrowserProfileId;
    browserGroupId: string;
    targetId: string;
  },
): void {
  prune();
  const scope = scopeKey(identity.profileId, identity.browserGroupId);
  if (!captures.has(scope)) return;
  if (downloads.size >= 128) {
    item.cancel();
    return;
  }
  const id = randomUUID();
  if (!directory)
    directory = mkdtempSync(path.join(tmpdir(), "runweave-downloads-"));
  const file = path.join(directory, id);
  const snapshot: BrowserDownloadSnapshot = {
    id,
    targetId: identity.targetId,
    filename: path.basename(item.getFilename()),
    mimeType: item.getMimeType(),
    state: "progressing",
    receivedBytes: 0,
    totalBytes: item.getTotalBytes(),
    createdAt: Date.now(),
  };
  item.setSavePath(file);
  downloads.set(id, { scope, file, item, snapshot });
  const update = () => {
    snapshot.receivedBytes = item.getReceivedBytes();
    snapshot.totalBytes = item.getTotalBytes();
    if (snapshot.receivedBytes > MAX_BYTES || snapshot.totalBytes > MAX_BYTES)
      item.cancel();
  };
  item.on("updated", update);
  item.once("done", (_event, state) => {
    snapshot.receivedBytes = item.getReceivedBytes();
    snapshot.totalBytes = item.getTotalBytes();
    snapshot.state = state;
    item.removeListener("updated", update);
    if (state !== "completed") rmSync(file, { force: true });
  });
  if (snapshot.totalBytes > MAX_BYTES) item.cancel();
}

export function listBrowserDownloads(
  profile: TerminalBrowserProfileId,
  group: string,
): BrowserDownloadSnapshot[] {
  prune();
  return [...downloads.values()]
    .filter((record) => record.scope === scopeKey(profile, group))
    .map((record) => ({ ...record.snapshot }));
}

export async function readBrowserDownload(
  profile: TerminalBrowserProfileId,
  group: string,
  id: string,
  offset: number,
): Promise<BrowserDownloadChunk> {
  prune();
  const record = downloads.get(id);
  if (!record || record.scope !== scopeKey(profile, group))
    throw new Error("DOWNLOAD_NOT_FOUND");
  if (record.snapshot.state !== "completed")
    throw new Error("DOWNLOAD_NOT_COMPLETED");
  const handle = await open(
    record.file,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > MAX_BYTES ||
      stat.size !== record.snapshot.receivedBytes ||
      offset > stat.size
    )
      throw new Error("DOWNLOAD_CHANGED");
    const buffer = Buffer.alloc(Math.min(256 * 1024, stat.size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (buffer.length && !bytesRead) throw new Error("DOWNLOAD_CHANGED");
    return {
      id,
      offset,
      nextOffset: offset + bytesRead,
      totalBytes: stat.size,
      dataBase64: buffer.subarray(0, bytesRead).toString("base64"),
      eof: offset + bytesRead === stat.size,
    };
  } finally {
    await handle.close();
  }
}

export function stopBrowserDownloads(): void {
  captures.clear();
  for (const { item, snapshot } of downloads.values())
    if (snapshot.state === "progressing") item.cancel();
  downloads.clear();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
}
