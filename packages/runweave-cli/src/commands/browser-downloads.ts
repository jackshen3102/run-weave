import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  BrowserDownloadChunk,
  BrowserDownloadSnapshot,
} from "@runweave/shared/browser-downloads";
import { getStringOption, parseArgs, requireStringOption } from "../args.js";
import { BrowserCdpClient } from "../client/browser-cdp.js";
import { CliError } from "../errors.js";
import {
  resolveBrowserProfile,
  type BrowserCommandIo,
} from "./browser-profile.js";

export async function runBrowserDownloadsCommand(
  args: string[],
  io: BrowserCommandIo,
): Promise<void> {
  const [command, ...rest] = args;
  const usage =
    "Usage: rw browser downloads <capture|release|list> [--profile 1|2|3] [--group-id <id>] [--json] | rw browser downloads fetch <download-id> --output <path> [--profile 1|2|3] [--group-id <id>] [--json]";
  if (!command || !["capture", "release", "list", "fetch"].includes(command))
    throw new CliError(usage, 2);
  const { options, positionals } = parseArgs(rest, new Set(["json"]));
  const allowed = new Set([
    "profile",
    "group-id",
    "json",
    ...(command === "fetch" ? ["output"] : []),
  ]);
  if (
    Object.keys(options).some((key) => !allowed.has(key)) ||
    positionals.length !== (command === "fetch" ? 1 : 0)
  )
    throw new CliError(usage, 2);
  const output =
    command === "fetch"
      ? path.resolve(requireStringOption(options, "output"))
      : null;
  if (output) {
    try {
      await lstat(output);
      throw new CliError("Output already exists; choose a new path", 2);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const profileArgs = ["profile", "group-id"].flatMap((key) => {
    const value = getStringOption(options, key);
    return value ? [`--${key}`, value] : [];
  });
  const resolved = await resolveBrowserProfile(profileArgs, io);
  const cdp = await BrowserCdpClient.connect(resolved.cdpEndpoint);
  try {
    let result: unknown;
    if (command === "capture" || command === "release") {
      const policy = await cdp.send<{
        enabled: boolean;
        expiresAt: number | null;
      }>("Runweave.captureDownloads", { enabled: command === "capture" });
      if (typeof policy.enabled !== "boolean")
        throw new CliError(
          "Desktop download control is unavailable; update the desktop",
          3,
        );
      result = policy;
    } else {
      const listing = await cdp.send<{ downloads: BrowserDownloadSnapshot[] }>(
        "Runweave.listDownloads",
      );
      if (!Array.isArray(listing.downloads))
        throw new CliError(
          "Desktop download control is unavailable; update the desktop",
          3,
        );
      if (command === "list") result = listing;
      else {
        const download = listing.downloads.find(
          (entry) => entry.id === positionals[0],
        );
        if (!download || download.state !== "completed")
          throw new CliError(
            "Download is missing or not completed; inspect downloads list",
            4,
          );
        result = await fetchDownload(cdp, download, output!);
      }
    }
    io.stdout.write(
      `${JSON.stringify({ profileId: resolved.profileId, browserGroupId: resolved.browserGroupId, ...(result as object) }, null, 2)}\n`,
    );
  } finally {
    cdp.close();
  }
}

async function fetchDownload(
  cdp: BrowserCdpClient,
  download: BrowserDownloadSnapshot,
  output: string,
) {
  const temporary = `${output}.${randomUUID()}.part`;
  const file = await open(temporary, "wx", 0o600);
  const digest = createHash("sha256");
  let offset = 0;
  try {
    for (;;) {
      const chunk = await cdp.send<BrowserDownloadChunk>(
        "Runweave.readDownload",
        { id: download.id, offset },
      );
      if (
        chunk.id !== download.id ||
        chunk.offset !== offset ||
        typeof chunk.dataBase64 !== "string" ||
        chunk.dataBase64.length > 350_000 ||
        chunk.totalBytes !== download.receivedBytes
      )
        throw new CliError("Invalid or changed download response", 4);
      const bytes = Buffer.from(chunk.dataBase64, "base64");
      if (
        chunk.nextOffset !== offset + bytes.length ||
        chunk.nextOffset > chunk.totalBytes ||
        chunk.eof !== (chunk.nextOffset === chunk.totalBytes) ||
        (!bytes.length && !chunk.eof)
      )
        throw new CliError("Invalid download offset", 4);
      await file.writeFile(bytes);
      digest.update(bytes);
      offset = chunk.nextOffset;
      if (chunk.eof) break;
    }
    await file.sync();
    await file.close();
    // Publish a complete file without replacing an existing destination.
    await link(temporary, output);
    return {
      id: download.id,
      filename: download.filename,
      output,
      bytes: offset,
      sha256: digest.digest("hex"),
    };
  } finally {
    await file.close();
    await unlink(temporary);
  }
}
