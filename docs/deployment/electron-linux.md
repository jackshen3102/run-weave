# Linux x64 desktop (preview)

The opt-in Linux package runs the Electron desktop and its bundled backend on a
Linux x64 glibc host. Build on Linux x64 with Node and the repository's pinned
pnpm (see `packageManager` in `package.json`):

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm pack:electron:linux # linux-unpacked
corepack pnpm dist:electron:linux # linux-unpacked and tar.gz
```

These commands use `electron/.linux-build` as disposable staging and release
output; `RUNWEAVE_ELECTRON_BUILD_ROOT` selects another disposable directory.
They do not bump the app version, publish artifacts, or touch the macOS release
output. They build the frontend, desktop, backend and required native resources
without building unrelated services. Native rebuilds remain disabled because
node-pty, better-sqlite3 and fs-native-extensions ship platform prebuilds.

Run `electron/.linux-build/release/linux-unpacked/runweave`, or extract the
archive and run `runweave` there. A graphical Linux desktop and Electron's usual
system libraries, a Unix shell, `lsof` and `tmux` on PATH are required
(on Debian/Ubuntu, install the distribution packages with `apt install tmux lsof`).
Keep Chromium sandboxing enabled; a restricted
container may need a supported desktop environment before it can launch.
Closing the last Linux window quits the application. The tray is optional for
reopening a window, not required to recover from closing it.

The first launch uses the standard new-install configuration flow. Use an
isolated explicit `--config-dir /absolute/qa/config` plus an XDG profile for QA;
configuration defaults use the OS account home (overriding HOME alone is not
enough). Never point a smoke test at production data.
Set `VITE_CLARITY_ENABLED=false` when building a QA artifact to disable Clarity.
For an isolated run, set `RUNWEAVE_WHISTLE_PORTS` to three distinct available
ports (for example `18081,18082,18083`); stable defaults are `8081,8082,8083`.
Do not stop unrelated services if a default port is occupied.

## Verification

```bash
corepack pnpm --filter @runweave/electron typecheck
corepack pnpm --filter @runweave/electron lint
ELECTRON_RUN_AS_NODE=1 electron/.linux-build/release/linux-unpacked/runweave \
  scripts/verify/electron/linux-native.mjs \
  electron/.linux-build/release/linux-unpacked/resources
```

The native check uses the packaged Electron executable and packaged resources:
PTY spawn, input/output, resize and exit; SQLite persistence/integrity and runtime
manifest hashes; cross-process native file locks. It removes its temporary data.
A successful package/native check is not GUI acceptance: launch the extracted
application, initialize an isolated test profile and exercise a synthetic local
project and terminal before declaring a Linux artifact usable.

## Preview limits

The macOS companion, macOS native resource sampler/full system metrics, battery
integration and automatic updates are not part of this Linux preview. Long-text
terminal delivery retains its existing security gate; this package does not
bypass it. No Windows package is added. The macOS configuration keeps its native
companion and arm64 PTY resources and its existing signing hook/targets.
