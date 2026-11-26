import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorktreeSetupDefinition } from "@runweave/shared/terminal/workspace-service";
import { resolveStoragePaths } from "../../utils/path";

export function setupRevision(
  repositoryId: string,
  setup: WorktreeSetupDefinition,
) {
  return createHash("sha256")
    .update(JSON.stringify([repositoryId, setup.cwd, setup.command]))
    .digest("hex");
}

// Each approval is immutable and independent. Concurrent repositories never rewrite a shared list.
function approvalPath(repositoryId: string, revision: string) {
  return path.join(
    resolveStoragePaths().browserProfileDir,
    "worktree-setup-approvals",
    repositoryId,
    revision,
  );
}

export async function isSetupApproved(repositoryId: string, revision: string) {
  const stored = await readFile(
    approvalPath(repositoryId, revision),
    "utf8",
  ).catch(() => null);
  return stored === revision;
}

export async function approveSetup(repositoryId: string, revision: string) {
  const file = approvalPath(repositoryId, revision);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomUUID();
  try {
    await writeFile(temporary, revision, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
