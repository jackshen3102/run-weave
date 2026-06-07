import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const HOOK_TOKEN_BYTES = 32;

// Persist the Runweave hook token across backend restarts so AI-CLI hook
// callbacks fired from existing tmux panes continue to authenticate. The
// token sits under the per-project profile dir, mode 0600.
export function loadOrCreateHookToken(filePath: string): string {
  try {
    const persisted = readFileSync(filePath, "utf8").trim();
    if (persisted) {
      return persisted;
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const generated = randomBytes(HOOK_TOKEN_BYTES).toString("hex");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, generated, "utf8");
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort permission tightening; non-fatal on filesystems that
    // do not support POSIX modes.
  }
  return generated;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
