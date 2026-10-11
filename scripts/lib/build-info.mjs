import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// Capture once before building. The running artifact never reads the checkout.
export function createBuildInfo(packageDirectory) {
  const version = JSON.parse(
    readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
  ).version;
  const git = (args) =>
    execFileSync("git", args, {
      cwd: packageDirectory,
      encoding: "utf8",
    }).trim();
  const sourceRevision = git(["rev-parse", "HEAD"]);
  const sourceDirty = git(["status", "--porcelain"]) !== "";
  const builtAt = new Date().toISOString();
  const buildId = `${builtAt.replace(/[-:.]/g, "")}-${sourceRevision.slice(0, 8)}${sourceDirty ? "-dirty" : ""}`;
  return { version, buildId, sourceRevision, sourceDirty, builtAt };
}

export function buildInfoDefine(packageDirectory) {
  return {
    __RUNWEAVE_BUILD_INFO__: JSON.stringify(createBuildInfo(packageDirectory)),
  };
}
