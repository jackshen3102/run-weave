import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const electronDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(electronDir, "..");
const targetDir = process.env.RUNWEAVE_WHISTLE_RUNTIME_DIR
  ? path.resolve(process.env.RUNWEAVE_WHISTLE_RUNTIME_DIR)
  : path.join(electronDir, ".whistle-runtime");

rmSync(targetDir, { recursive: true, force: true });
execFileSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  [
    "--filter",
    "@runweave/whistle-runtime",
    "deploy",
    "--legacy",
    "--prod",
    targetDir,
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

// pnpm's legacy deploy graph includes a workspace self-link under the virtual
// store. Whistle never resolves this package at runtime, and the link points
// outside the staged directory, so it would become dangling after packaging.
rmSync(
  path.join(
    targetDir,
    "node_modules",
    ".pnpm",
    "node_modules",
    "@runweave",
    "whistle-runtime",
  ),
  { force: true },
);

const required = [
  "node_modules/whistle/index.js",
  "node_modules/whistle/bin/whistle.js",
  "node_modules/whistle/biz/webui/htdocs/index.html",
  "node_modules/whistle/package.json",
  "node_modules/whistle/LICENSE",
];
for (const relativePath of required) {
  const absolutePath = path.join(targetDir, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Whistle runtime is incomplete: ${relativePath}`);
  }
}
console.log(`[whistle-runtime] prepared ${targetDir}`);
