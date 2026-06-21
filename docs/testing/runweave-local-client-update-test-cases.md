# Runweave Local Client Update Test Cases

These cases verify the one-command local update flow exposed as:

```bash
pnpm runweave:update
```

The command updates the local macOS Runweave client from the current worktree.
It chooses a runtime update when the installed Electron shell can stay in
place, and chooses a full app update when Electron shell/native files must be
replaced.

## Scope

- Runtime update: frontend, backend bundle, and shared runtime contracts.
- Full app update: Electron main/preload/menu/tray/updater code, app resources,
  builder configuration, and local update scripts.
- Cross-worktree update: `--repo <path>` uses that worktree as the source.
- Permission behavior: runtime updates do not replace
  `/Applications/Runweave.app`, which avoids changing the app code signature.
  Full app updates still replace the bundle; the update command uses
  `RUNWEAVE_CODESIGN_IDENTITY` when provided, otherwise it reads or writes
  `RUNWEAVE_CODESIGN_IDENTITY` in `backend/.env`, auto-selects the first local
  codesigning identity when the stored value is empty or unavailable, and only
  falls back to ad-hoc when none is available.

## Automated Cases

Run:

```bash
pnpm runweave:update:test-cases
```

Expected cases:

| Case                                               | Expected result                                                 |
| -------------------------------------------------- | --------------------------------------------------------------- |
| No previous state                                  | auto mode selects full app update                               |
| Frontend/backend/shared changes                    | auto mode selects runtime update                                |
| `electron/src/main.ts` change                      | auto mode selects full app update                               |
| Source shell version is newer than installed app   | auto mode selects full app update                               |
| Installed app version is newer than source package | auto mode can still select runtime update                       |
| Explicit runtime mode                              | runtime mode is honored                                         |
| App build version                                  | generated app build version is newer than installed             |
| Cross-worktree args                                | `--repo`, `--mode`, `--no-restart`, `--dry-run` parse correctly |
| `--no-restart` with app update                     | rejected before any update action                               |
| Native path matcher                                | update scripts, resources, and builder config are app-sensitive |
| One-command update script change                   | auto mode selects full app update                               |
| Dotenv codesign identity                           | updates only the configured identity and preserves other keys   |

## Manual Smoke Cases

These commands do not replace the app unless `--dry-run` is removed.

```bash
pnpm runweave:update --dry-run
pnpm runweave:update --dry-run --mode runtime
pnpm runweave:update --dry-run --mode app
pnpm runweave:update --dry-run --repo /Users/bytedance/Code/browser-hub/feature
```

Expected result: each command prints the source worktree, installed app path,
installed version, source shell version, selected mode, and reason.
`--no-restart` is only valid for runtime updates; if auto mode resolves to a
full app update, the command exits before building or quitting Runweave.
