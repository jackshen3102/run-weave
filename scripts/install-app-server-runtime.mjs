import { rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const repoRoot = process.cwd();
const requireFromCli = createRequire(
  path.join(repoRoot, "packages", "runweave-cli", "package.json"),
);
const { build } = requireFromCli("esbuild");
const releaseId =
  process.argv.find((arg) => arg.startsWith("--release-id="))?.slice(13) ??
  createReleaseId();
const homeArg = process.argv.find((arg) => arg.startsWith("--home="))?.slice(7);
const artifactDir = path.join(
  repoRoot,
  ".runtime-artifacts",
  "app-server",
  releaseId,
);
const entry = path.join(artifactDir, "index.cjs");

rmSync(artifactDir, { recursive: true, force: true });

await build({
  bundle: true,
  define: {
    "import.meta.url": "__IMPORT_META_URL__",
  },
  banner: {
    js: "const __IMPORT_META_URL__ = require('url').pathToFileURL(__filename).href;",
  },
  entryPoints: ["app-server/src/index.ts"],
  format: "cjs",
  outfile: entry,
  platform: "node",
  sourcemap: true,
  target: "node20",
});

const isolatedCliEntry = process.env.RUNWEAVE_CLI_BUNDLE_OUTFILE?.trim();
const cliEntry = isolatedCliEntry
  ? path.resolve(isolatedCliEntry)
  : path.join(repoRoot, "packages", "runweave-cli", "dist", "index.js");
if (isolatedCliEntry) {
  run("node", ["scripts/bundle.mjs"], {
    cwd: path.join(repoRoot, "packages", "runweave-cli"),
    env: { ...process.env, RUNWEAVE_CLI_BUNDLE_OUTFILE: cliEntry },
  });
} else {
  run("pnpm", ["--filter", "@runweave/cli", "build"]);
}
run("node", [
  cliEntry,
  "app-server",
  "install",
  "--entry",
  entry,
  "--release-id",
  releaseId,
  ...(homeArg ? ["--home", homeArg] : []),
]);

function createReleaseId() {
  const now = new Date();
  return [
    "local",
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("-");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}
