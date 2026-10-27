import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ["src/background.ts", "src/popup.ts"],
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "chrome120",
});
await mkdir(new URL("../dist", import.meta.url), { recursive: true });
for (const file of ["manifest.json", "popup.html", "popup.css"])
  await copyFile(`${root}/${file}`, `${root}/dist/${file}`);
