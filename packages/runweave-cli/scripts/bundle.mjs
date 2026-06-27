import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["src/index.ts"],
  format: "cjs",
  outfile: "dist/index.js",
  platform: "node",
  sourcemap: true,
  target: "node20",
});
