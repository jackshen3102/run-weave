import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../../electron/package.json", import.meta.url),
);
const { build } = require("esbuild");
const root = mkdtempSync(path.join(tmpdir(), "runweave-bookmarks-ipc-build-"));
try {
  const outfile = path.join(root, "main.cjs");
  const renderer = path.join(root, "renderer.js");
  await build({
    stdin: {
      contents:
        'import {useBookmarkStore} from "./frontend/src/features/terminal/bookmarks/store.ts"; window.bookmarkFixture=useBookmarkStore;',
      resolveDir: new URL("../../../", import.meta.url).pathname,
    },
    outfile: renderer,
    bundle: true,
    platform: "browser",
    format: "iife",
  });
  await build({
    entryPoints: [
      new URL("./browser-bookmarks-fixture.mjs", import.meta.url).pathname,
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    plugins: [
      {
        name: "isolated-desktop-identity",
        setup(build) {
          build.onLoad(
            { filter: /electron\/src\/desktop\/config\.ts$/ },
            () => ({
              contents:
                'export const isDev=false; export const CUSTOM_PROTOCOL="runweave"; export const DEV_SERVER_URL="http://127.0.0.1:1"; export const isManagedDevSession=false; export const desktopChannel="beta";',
              loader: "js",
            }),
          );
        },
      },
    ],
  });
  const env = { ...process.env, RW_BOOKMARK_FIXTURE_RENDERER: renderer };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron"), [outfile], {
    env,
    stdio: "inherit",
    timeout: 30000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
