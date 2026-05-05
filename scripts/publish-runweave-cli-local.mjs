#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packagePath = "./packages/runweave-cli";
const packDir = mkdtempSync(join(tmpdir(), "runweave-cli-pack-"));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
}

try {
  const packOutput = run(
    "npm",
    ["pack", packagePath, "--pack-destination", packDir],
    { capture: true },
  );
  const tarballName = packOutput.trim().split(/\r?\n/).at(-1);
  if (!tarballName) {
    throw new Error("npm pack did not return a tarball name");
  }

  const tarballPath = join(packDir, tarballName);
  const contents = run("tar", ["-tf", tarballPath], { capture: true });
  const forbiddenEntry = contents
    .split(/\r?\n/)
    .find(
      (entry) =>
        entry.startsWith("package/src/") ||
        entry.startsWith("package/node_modules/"),
    );
  if (forbiddenEntry) {
    throw new Error(
      `Packed CLI contains forbidden source entry: ${forbiddenEntry}`,
    );
  }

  run("npm", ["install", "-g", tarballPath]);
  const rwPath = run("sh", ["-lc", "command -v rw"], { capture: true }).trim();
  console.log(`Installed rw from packed artifact: ${rwPath}`);
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
