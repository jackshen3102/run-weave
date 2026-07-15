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

| Case ID | Case                                               | Expected result                                                 |
| ------- | -------------------------------------------------- | --------------------------------------------------------------- |
| LCU-001 | Deployed dirty files stay excluded                 | Changed content is required before re-entering the update plan  |
| LCU-002 | Deployed dirty files re-enter after content change | Changed content is included in the update plan                  |
| LCU-003 | No previous state                                  | Auto mode selects full app update                               |
| LCU-004 | Frontend/backend/shared changes                    | Auto mode selects runtime update                                |
| LCU-005 | App Server changes                                 | App Server is updated independently                             |
| LCU-006 | Explicit App Server mode                           | Explicit update/skip options are honored                        |
| LCU-007 | `electron/src/main.ts` change                      | Auto mode selects full app update                               |
| LCU-008 | Source shell version is newer than installed app   | Auto mode selects full app update                               |
| LCU-009 | Installed app version is newer than source package | Auto mode can still select runtime update                       |
| LCU-010 | Explicit runtime mode                              | Runtime mode is honored                                         |
| LCU-011 | App build version                                  | Generated app build version is newer than installed             |
| LCU-012 | Cross-worktree args                                | Update and desktop verification options parse correctly         |
| LCU-013 | `--no-restart` with app update                     | Rejected before any update action                               |
| LCU-014 | `--no-restart` with App Server update              | Rejected before any update action                               |
| LCU-015 | Beta update target isolation                       | Mismatched identity and paths are rejected                      |
| LCU-016 | Native path matcher                                | Update scripts, resources, and builder config are app-sensitive |
| LCU-017 | One-command update script change                   | Auto mode selects full app update                               |
| LCU-018 | Dotenv codesign identity                           | Only the configured identity changes; other keys remain         |

## Manual Smoke Cases

These commands do not replace the app unless `--dry-run` is removed.

```bash
pnpm runweave:update --dry-run
pnpm runweave:update --dry-run --mode runtime
pnpm runweave:update --dry-run --mode app
pnpm runweave:update --dry-run --repo /path/to/runweave
pnpm runweave:update --dry-run --verify-desktop
```

Expected result: each command prints the source worktree, installed app path,
installed version, source shell version, selected mode, and reason.
`--no-restart` is only valid for runtime updates; if auto mode resolves to a
full app update, the command exits before building or quitting Runweave.
`--verify-desktop` prints its status path during dry-run and, on a real run,
must emit `desktop verification ready` with the installed App identity, visible
window state, and main renderer CDP endpoint. Attach Playwright to that exact
endpoint and verify the terminal page; do not use the Terminal Browser proxy.
