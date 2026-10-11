import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { copyNativeLockRuntime } from "./native-lock-runtime.mjs";

import { createBuildInfo } from "../../../scripts/lib/build-info.mjs";
const { version: packageVersion, ...buildInfo } = createBuildInfo(path.resolve(import.meta.dirname, ".."));

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
fs.writeFileSync(
  path.join(path.dirname(outfile), "build-info.json"),
  JSON.stringify({ packageVersion, ...buildInfo }, null, 2) + "\n",
);
