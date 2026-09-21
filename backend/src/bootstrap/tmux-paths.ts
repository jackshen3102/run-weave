import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

function profileId(browserProfileDir: string): string {
  return createHash("sha256")
    .update(browserProfileDir)
    .digest("hex")
    .slice(0, 12);
}

export function resolvePersistentTmuxSocketPath(
  browserProfileDir: string,
): string {
  return path.join(
    os.homedir(),
    ".runweave",
    "tmux",
    profileId(browserProfileDir),
    "tmux.sock",
  );
}

export function resolveDefaultTmuxSocketPath(
  browserProfileDir: string,
  runtimeChannel: "stable" | "beta" | "dev",
): string {
  return runtimeChannel === "stable"
    ? resolvePersistentTmuxSocketPath(browserProfileDir)
    : path.join(
        os.tmpdir(),
        `rw-tmux-${profileId(browserProfileDir)}`,
        "tmux.sock",
      );
}
