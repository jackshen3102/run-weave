import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  external: ["electron"],
  sourcemap: true,
  target: "node20",
};

await build({
  ...shared,
  entryPoints: ["src/main.ts"],
  outdir: "dist",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
});

await build({
  ...shared,
  entryPoints: ["src/preload.ts"],
  outdir: "dist",
  platform: "browser",
  external: ["electron"],
  format: "cjs",
  outExtension: { ".js": ".cjs" },
});

console.log("[bundle] electron main + preload built successfully");
