import { rmSync } from "node:fs";
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

rmSync("dist/backend", { recursive: true, force: true });

await build({
  ...shared,
  entryPoints: ["../backend/src/index.ts"],
  outdir: "dist/backend",
  format: "cjs",
  external: ["node-pty"],
  outExtension: { ".js": ".cjs" },
});

console.log("[bundle] electron main + preload + backend runtime built successfully");
