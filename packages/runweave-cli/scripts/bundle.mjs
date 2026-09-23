import { build } from "esbuild";
import path from "node:path";
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
