# Terminal Vim Regression Runbook

## Test Gates

- Unit smoke (backend): `pnpm --filter ./backend test -- src/terminal/pty-service.test.ts src/ws/heartbeat.test.ts src/ws/terminal-server.test.ts`
- Unit smoke (frontend): `pnpm --filter ./frontend test -- src/components/terminal-page.test.tsx src/features/terminal/use-terminal-connection.test.tsx`
- E2E smoke: `pnpm --filter ./frontend e2e -- tests/terminal.spec.ts tests/terminal-vim.spec.ts`

## Release Rule

- Treat terminal compatibility as blocked unless all three gates pass in the same commit range.

## Manual Verification

1. Open a terminal session from the home page.
2. Run `vim /tmp/viewer-vim-manual.txt` and enter insert mode.
3. Type `manual-check-before-resize`.
4. Resize the browser viewport while still in insert mode.
5. Continue typing `-after-resize`, then `Esc`, `:wq`, `Enter`.
6. Run `cat /tmp/viewer-vim-manual.txt`.
7. Confirm the output contains `manual-check-before-resize-after-resize`.

## Failure Triage

- If output is corrupted after resize, inspect terminal resize flow in `frontend/src/components/terminal/terminal-surface.tsx` and backend websocket runtime resize handling in `backend/src/ws/terminal-server.ts`.
- If session flips to offline during auth refresh, inspect terminal connection state transitions in `frontend/src/features/terminal/use-terminal-connection.ts`.
- If terminal disconnects unexpectedly under idle conditions, inspect websocket transport heartbeat in `backend/src/ws/heartbeat.ts` and terminal websocket wiring in `backend/src/ws/terminal-server.ts`.
