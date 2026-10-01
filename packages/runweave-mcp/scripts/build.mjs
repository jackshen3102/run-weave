import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { copyNativeLockRuntime } from "../../config-node/scripts/native-runtime.mjs";
const root = fileURLToPath(new URL("../../..", import.meta.url));
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
const releaseId = `local-${Date.now()}`;
const sourceRevision = `${sha}${dirty ? "+dirty" : ""}`;
await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["fs-native-extensions"],
  sourcemap: true,
  define: { __MCP_SOURCE_REVISION__: JSON.stringify(sourceRevision), __MCP_RELEASE_ID__: JSON.stringify(releaseId) },
});
const outputDir = fileURLToPath(new URL("../dist", import.meta.url));
copyNativeLockRuntime(outputDir);
writeFileSync(`${outputDir}/release.json`, JSON.stringify({ sourceRevision, releaseId, bundleSha256: createHash("sha256").update(readFileSync(`${outputDir}/index.cjs`)).digest("hex") }, null, 2));
