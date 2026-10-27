import { build } from "esbuild";
import { fileURLToPath } from "node:url";
await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["src/cli.ts", "src/native-host.ts", "src/outbox.ts"],
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
});
