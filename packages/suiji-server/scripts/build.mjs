import { copyNativeLockRuntime } from "../../config-node/scripts/native-runtime.mjs";
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: { index: "src/index.ts", configuration: "../config-node/src/index.ts", admin: "scripts/admin.ts", migrate: "scripts/migrate.ts", "mcp-credential": "scripts/mcp-credential.ts", "mcp-credentials": "scripts/mcp-credentials.ts" },
  outbase: ".",
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["fs-native-extensions", "express", "pg", "node-pg-migrate", "busboy", "sharp", "@modelcontextprotocol/sdk"],
  entryNames: "[name]",
});
await cp("migrations", "dist/migrations", { recursive: true });

copyNativeLockRuntime("dist");
