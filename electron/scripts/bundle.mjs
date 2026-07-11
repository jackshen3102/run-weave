import { rmSync } from "node:fs";
import { build } from "esbuild";

const outputDir = process.env.RUNWEAVE_ELECTRON_BUNDLE_OUTDIR ?? "dist";

const shared = {
  bundle: true,
  platform: "node",
  external: ["electron"],
  sourcemap: true,
  target: "node20",
};

const desktopBuildDefines = {
  __RUNWEAVE_DESKTOP_CHANNEL__: JSON.stringify(
    process.env.RUNWEAVE_DESKTOP_CHANNEL === "beta" ? "beta" : "stable",
  ),
  __RUNWEAVE_DESKTOP_SOURCE_REVISION__: JSON.stringify(
    process.env.RUNWEAVE_DESKTOP_SOURCE_REVISION ?? "unknown",
  ),
  __RUNWEAVE_DESKTOP_INSTANCE_ID__: JSON.stringify(
    process.env.RUNWEAVE_DESKTOP_INSTANCE_ID ?? null,
  ),
  __RUNWEAVE_DEV_SESSION_ID__: JSON.stringify(
    process.env.RUNWEAVE_DEV_SESSION_ID ?? null,
  ),
  __RUNWEAVE_DESKTOP_USER_DATA_DIR__: JSON.stringify(
    process.env.RUNWEAVE_DESKTOP_USER_DATA_DIR ?? null,
  ),
  __RUNWEAVE_DESKTOP_STATUS_PATH__: JSON.stringify(
    process.env.RUNWEAVE_DESKTOP_STATUS_PATH ?? null,
  ),
  __RUNWEAVE_DESKTOP_CDP_PORT__: JSON.stringify(
    process.env.RUNWEAVE_DESKTOP_CDP_PORT ?? null,
  ),
  __RUNWEAVE_TERMINAL_BROWSER_CDP_PORT__: JSON.stringify(
    process.env.RUNWEAVE_TERMINAL_BROWSER_CDP_PROXY_PORT ?? null,
  ),
  __RUNWEAVE_APP_SERVER_HOME__: JSON.stringify(
    process.env.RUNWEAVE_APP_SERVER_HOME ?? null,
  ),
};

// Map ESM `import.meta.url` to a CJS-safe equivalent so modules that read it
// (e.g. hook-installer resource resolution) work in the bundled CJS output.
// `define` values must be an identifier or JS literal, so point it at a
// constant injected via `banner` rather than an inline expression.
const importMetaUrlShim = {
  define: {
    "import.meta.url": "__IMPORT_META_URL__",
  },
  banner: {
    js: "const __IMPORT_META_URL__ = require('url').pathToFileURL(__filename).href;",
  },
};

await build({
  ...shared,
  ...importMetaUrlShim,
  define: {
    ...importMetaUrlShim.define,
    ...desktopBuildDefines,
  },
  entryPoints: ["src/main.ts"],
  outdir: outputDir,
  format: "cjs",
  outExtension: { ".js": ".cjs" },
});

await build({
  ...shared,
  entryPoints: ["src/preload.ts"],
  outdir: outputDir,
  platform: "browser",
  external: ["electron"],
  format: "cjs",
  outExtension: { ".js": ".cjs" },
});

rmSync(`${outputDir}/backend`, { recursive: true, force: true });
rmSync(`${outputDir}/app-server`, { recursive: true, force: true });
rmSync(`${outputDir}/cli`, { recursive: true, force: true });

await build({
  ...shared,
  ...importMetaUrlShim,
  entryPoints: ["../backend/src/index.ts"],
  outdir: `${outputDir}/backend`,
  format: "cjs",
  external: ["node-pty"],
  outExtension: { ".js": ".cjs" },
});

await build({
  ...shared,
  ...importMetaUrlShim,
  entryPoints: ["../packages/runweave-cli/src/index.ts"],
  outdir: `${outputDir}/cli`,
  format: "cjs",
  outExtension: { ".js": ".cjs" },
});

console.log(
  "[bundle] electron main + preload + backend/cli runtime built successfully",
);
