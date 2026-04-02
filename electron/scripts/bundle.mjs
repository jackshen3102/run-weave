import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  external: ["electron"],
  format: "esm",
  outExtension: { ".js": ".mjs" },
  sourcemap: true,
  target: "node20",
};

await build({
  ...shared,
  entryPoints: ["src/main.ts"],
  outdir: "dist",
  external: [...shared.external, "electron-updater"],
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
