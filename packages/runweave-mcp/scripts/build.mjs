import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { copyNativeLockRuntime } from "../../config-node/scripts/native-runtime.mjs";
import { publishComponentArtifact } from "../../../scripts/release/component-artifact.mjs";
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
});
const outputDir = fileURLToPath(new URL("../dist", import.meta.url));
copyNativeLockRuntime(outputDir);
const info = await publishComponentArtifact({
  component: "research-mcp",
  packageDirectory: fileURLToPath(new URL("..", import.meta.url)),
  roots: [{ name: "research-mcp", directory: outputDir }],
  metadataFile: `${outputDir}/build-info.json`,
  entries: [`${outputDir}/index.cjs`],
});
writeFileSync(
  `${outputDir}/release.json`,
  JSON.stringify(
    {
      sourceRevision: info.sourceRevision,
      releaseId: info.buildId,
      bundleSha256: createHash("sha256")
        .update(readFileSync(`${outputDir}/index.cjs`))
        .digest("hex"),
    },
    null,
    2,
  ),
);
