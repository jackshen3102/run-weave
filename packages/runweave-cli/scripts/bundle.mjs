import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { copyNativeLockRuntime } from "./native-lock-runtime.mjs";

const outfile = process.env.RUNWEAVE_CLI_BUNDLE_OUTFILE ?? "dist/index.js";

await build({
  bundle: true,
  entryPoints: ["src/index.ts"],
  format: "cjs",
  outfile,
  external: ["fs-native-extensions"],
  platform: "node",
  sourcemap: true,
  target: "node20",
});

copyNativeLockRuntime(path.dirname(outfile));

// Provenance is separate from executable content so rebuilding identical code
// does not manufacture a new release solely because the clock or HEAD changed.
const sourceRoot = path.resolve(import.meta.dirname, "../../..");
const git = (args) =>
  execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8" }).trim();
fs.writeFileSync(
  path.join(path.dirname(outfile), "build-info.json"),
  JSON.stringify(
    {
      sourceRevision: git(["rev-parse", "HEAD"]),
      sourceDirty: git(["status", "--porcelain"]) !== "",
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
