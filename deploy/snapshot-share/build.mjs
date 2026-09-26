import { copyNativeLockRuntime } from "../../packages/config-node/scripts/native-runtime.mjs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Reuse the repository-pinned tsx/esbuild toolchain; the artifact needs only Node at runtime.
const backendRequire = createRequire(new URL("../../backend/package.json", import.meta.url));
const { build } = createRequire(backendRequire.resolve("tsx/package.json"))("esbuild");
await build({
  absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
  entryPoints: ["backend/src/snapshot-share-host.ts"],
  outfile: "deploy/snapshot-share/dist/host.cjs",
  bundle: true,
  external: ["fs-native-extensions"],
  platform: "node",
  format: "cjs",
  target: "node22",
});
console.log("Built deploy/snapshot-share/dist/host.cjs");

copyNativeLockRuntime(fileURLToPath(new URL("./dist", import.meta.url)));
