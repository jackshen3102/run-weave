import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/index.ts", "scripts/admin.ts", "scripts/migrate.ts", "scripts/mcp-credential.ts"],
  outbase: ".",
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["express", "pg", "node-pg-migrate", "busboy", "sharp", "@modelcontextprotocol/sdk"],
  entryNames: "[name]",
});
await cp("migrations", "dist/migrations", { recursive: true });
