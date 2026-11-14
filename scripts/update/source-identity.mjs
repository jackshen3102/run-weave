import { isDeepStrictEqual } from "node:util";
import { createWorktreeSnapshot, runCaptureChecked } from "./system.mjs";

async function readSourceIdentity(sourceRoot) {
  const git = async (args) =>
    (await runCaptureChecked("git", args, { cwd: sourceRoot })).stdout.trim();
  return {
    gitHead: await git(["rev-parse", "HEAD"]),
    gitDirty: (await git(["status", "--porcelain"])) !== "",
    worktreeSnapshot: await createWorktreeSnapshot(sourceRoot, { strict: true }),
  };
}

function sourceError(code, phase, detail) {
  const error = new Error(
    `${code}: ${phase}: ${detail}. Stop concurrent source edits and rerun the update. ` +
      "Earlier components may already be installed; the successful update state is not advanced.",
  );
  error.code = code;
  return error;
}

export async function assertUpdateSourceUnchanged(sourceRoot, expected, phase) {
  const current = await readSourceIdentity(sourceRoot);
  if (
    current.gitHead !== expected.gitHead ||
    current.gitDirty !== expected.gitDirty ||
    !isDeepStrictEqual(current.worktreeSnapshot, expected.worktreeSnapshot)
  ) {
    throw sourceError(
      "UPDATE_SOURCE_CHANGED",
      phase,
      `planned ${expected.gitHead} (dirty=${expected.gitDirty}), ` +
        `observed ${current.gitHead} (dirty=${current.gitDirty}); source contents must also match`,
    );
  }
}

// These are boundary checks, not an immutable checkout or a filesystem lock.
// Dirty inputs are supported, but their contents must remain unchanged.
export async function createUpdateSourceGuard(sourceRoot) {
  const identity = await readSourceIdentity(sourceRoot);
  const check = async (phase, artifact) => {
    await assertUpdateSourceUnchanged(sourceRoot, identity, phase);
    if (
      artifact !== undefined &&
      (artifact?.sourceRevision !== identity.gitHead ||
        artifact?.sourceDirty !== identity.gitDirty)
    ) {
      throw sourceError(
        "UPDATE_ARTIFACT_SOURCE_MISMATCH",
        phase,
        `artifact ${artifact?.sourceRevision ?? "missing"} (dirty=${artifact?.sourceDirty}) ` +
          `does not match planned ${identity.gitHead} (dirty=${identity.gitDirty})`,
      );
    }
  };
  // Reject an input that changed while the initial identity was being sampled.
  await check("capturing update source");
  return { identity, check };
}
