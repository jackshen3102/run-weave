# Windows x64 desktop preview

The Windows preview runs the desktop UI and Terminal Browser against the same
user's installed npm Server. Server, App Server and PTY Host remain owned by
`rw server`; closing, reconnecting or reloading the desktop never stops them.
Install and start Server first using the [Server CLI](../cli/server-cli.md).
The desktop reads that instance's `settings.yaml` and validates the local health
response's configuration identity. It does not create a second Backend.

Build on Windows x64 with Node 22 and the repository's pinned pnpm:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm pack:electron:windows # unpacked directory only
pnpm dist:electron:windows # unpacked directory and ZIP
```

Builds use disposable `electron/.windows-build` staging (override with
`RUNWEAVE_ELECTRON_BUILD_ROOT`). They do not publish, change the source version
or write to macOS release output. Extract the ZIP into its own directory and
run `Runweave.exe --instance stable`. `--config-dir` must select the same
configuration root as the running Server. Run in the signed-in user's desktop
session; an SSH service session alone does not provide a visible window.

Native addons use their shipped Windows prebuilds. The packaging command prepares
the pinned Electron download explicitly, so a Visual Studio toolchain is not required.

The [Windows desktop workflow](../../.github/workflows/windows-desktop.yml) builds
on Windows Server 2022 for main, packaging-related pull requests and manual runs.
It extracts the distributed ZIP and uses its Electron to verify packaged resources,
SQLite persistence and manifest hashes, cross-process native locks, Whistle module
loading and PTY input/output, resize and exit. Verified ZIPs and SHA-256 checksums
are available as workflow artifacts for 14 days. CI does not start or restart an
installed Server and does not replace interactive desktop acceptance.

Keep the entire extracted directory. The ZIP is an unsigned preview, with manual
updates; Windows automatic updates and macOS companion/ScreenJournal features
are outside this preview. The local Server must already be healthy; use the
desktop reconnect action after recovering it through `rw server`.

Before deployment record Server/Host identities and existing terminal IDs.
Verify the actual Windows window, login, terminal input/output and Browser
resolver/CDP connection, then close/reopen the client and confirm the same Server,
Host and existing terminals remain available. Packaging or native-module checks
alone are not desktop acceptance.
