import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { rebuild } from "@electron/rebuild";
import {
  artifactRoot,
  betterSqliteVersion,
  electronVersion,
  stagingAppDir,
} from "./activity-sqlite-runtime-paths.mjs";

rmSync(artifactRoot, { recursive: true, force: true });
mkdirSync(stagingAppDir, { recursive: true });
writeFileSync(
  path.join(stagingAppDir, "package.json"),
  `${JSON.stringify(
    {
      name: "runweave-activity-sqlite-runtime",
      private: true,
      version: "1.0.0",
      dependencies: { "better-sqlite3": betterSqliteVersion },
    },
    null,
    2,
  )}\n`,
);
execFileSync(
  "npm",
  ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"],
  { cwd: stagingAppDir, stdio: "inherit" },
);
await rebuild({
  buildPath: stagingAppDir,
  electronVersion,
  arch: process.arch,
  force: true,
  onlyModules: ["better-sqlite3"],
});
console.log(`[activity-sqlite] prepared ${electronVersion}/${process.platform}/${process.arch}`);
