import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["src/index.ts"],
  format: "cjs",
  outfile: process.env.RUNWEAVE_CLI_BUNDLE_OUTFILE ?? "dist/index.js",
  platform: "node",
  sourcemap: true,
  target: "node20",
});
