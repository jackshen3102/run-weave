import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

try {
  let rootSeen = false;
  for (let i = 0; i < args.length && args[i] !== "--"; i++) {
    const arg = args[i];
    if (arg === "--root" || arg.startsWith("--root=")) {
      // Astro ignores non-string roots (including repeated flags), falling back
      // to another source tree. Reject those inputs rather than building it.
      if (rootSeen) throw new Error("--root must be provided only once");
      rootSeen = true;
      const value = arg === "--root" ? args[++i] : arg.slice("--root=".length);
      if (!value || (arg === "--root" && value.startsWith("-"))) {
        throw new Error("--root requires a nonempty directory path");
      }
      // Vite resolves symlinks, while Astro's compile cache keys retain root.
      // Canonicalize only root; outDir and all other CLI options keep their semantics.
      const root = realpathSync(value);
      if (!statSync(root).isDirectory()) {
        throw new Error(`--root must be a directory: ${value}`);
      }
      args[i] = arg === "--root" ? root : `--root=${root}`;
    } else if (/^--(?:no-root(?:[.=]|$)|root\.)/.test(arg)) {
      throw new Error("Use --root <directory> or --root=<directory>");
    }
  }
} catch (error) {
  console.error(`[website:build] ${error.message}`);
  process.exit(1);
}

// Keep pnpm's package cwd for Astro's fallback prerender chunks and Sharp.
// Run the installed official CLI, including its Node checks and exit handling.
const astroPackage = new URL(import.meta.resolve("astro/package.json"));
const { bin } = JSON.parse(readFileSync(astroPackage, "utf8"));
const astroCli = new URL(bin.astro, astroPackage);
process.argv = [process.execPath, fileURLToPath(astroCli), "build", ...args];
await import(astroCli.href);
