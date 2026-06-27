#!/usr/bin/env node
import { cpSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const appServerDist = path.join(repoRoot, "app-server", "dist");
const cliAppServerDist = path.join(
  repoRoot,
  "packages",
  "runweave-cli",
  "dist",
  "app-server",
);

const result = spawnSync("pnpm", ["--filter", "@runweave/app-server", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (result.status !== 0) {
  throw new Error("Failed to build @runweave/app-server for CLI packaging");
}

rmSync(cliAppServerDist, { recursive: true, force: true });
cpSync(appServerDist, cliAppServerDist, { recursive: true });
writeFileSync(
  path.join(cliAppServerDist, "package.json"),
  `${JSON.stringify({ type: "module" }, null, 2)}\n`,
);
