# Terminal tmux Recovery Verification - 2026-04-18

## Environment

- Host: local macOS development machine
- tmux: `/opt/homebrew/bin/tmux`, version `tmux 3.6a`
- Repository: `/workspace/runweave`

## capture-pane Performance Baseline

Command under test:

```bash
tmux capture-pane -p -J -S -5000 -t runweave-bench
```

Setup:

- Dedicated temporary tmux socket under `/tmp/runweave-tmux-bench-*`.
- Dedicated tmux config with `history-limit 5000`, default `C-b` unbound, and prefix moved to `C-\`.
- Created a detached tmux session with an 8000-line shell transcript.
- Captured the latest 5000 lines 10 times from the same pane.

Result:

```json
{
  "command": "tmux capture-pane -p -J -S -5000",
  "runs": [6.81, 7.18, 7.65, 7.72, 7.76, 7.81, 7.87, 8.23, 8.63, 9.78],
  "avg": 7.94,
  "p95": 9.78,
  "max": 9.78,
  "bytes": 50009,
  "lines": 5001,
  "lastLine": "sh-3.2$ "
}
```

The observed max was `9.78 ms`, below the phase 1 target of `200 ms`.

## E2E Regression

Commands:

```bash
pnpm --filter ./frontend exec playwright test tests/terminal-vim.spec.ts --reporter=line
pnpm --filter ./frontend exec playwright test tests/terminal-preview.spec.ts --reporter=line
pnpm --filter ./frontend exec playwright test tests/terminal.spec.ts tests/terminal-snapshot-race.spec.ts tests/terminal-preview.spec.ts tests/terminal-vim.spec.ts --reporter=line
```

Results:

- `terminal-vim.spec.ts`: 2 passed.
- `terminal-preview.spec.ts`: 1 passed.
- Combined terminal E2E group: 8 passed using 4 workers.

Notes:

- The first vim E2E run reproduced a real tmux timing regression: input reached tmux before the interactive shell/vim was ready. The pane showed repeated text after `cat`, and the page assertion failed.
- The fix adds detached tmux session creation, interactive shell readiness waiting, and tmux input pacing after line breaks.
- A separate E2E isolation issue was exposed when running terminal specs in parallel: the vim test opened a terminal via shared home-page state and could attach to the preview test's session. The vim test now creates its own session via API and navigates directly to that session URL.
- `terminal-preview.spec.ts` had a stale selector expecting the temporary repo basename as a button label. It now clicks the actual project button label while keeping the no-refetch assertion.

## Page Refresh Regression

User-reported symptom:

- New tmux-backed terminal, start an interactive TUI, refresh the page.
- The terminal renders garbled text: prompt/status text repeats diagonally and TUI borders are displaced.

Root cause:

- WebSocket initial snapshot for tmux-backed sessions used `tmux capture-pane -p`, which returns plain text, not a raw terminal repaint stream.
- On page refresh, the backend could keep an idle tmux attach client alive. The new browser connection reused that runtime, so tmux did not emit a fresh full-screen ANSI repaint. The frontend then rendered the plain `capture-pane` text as normal terminal input, corrupting TUI layout.

Fix:

- WebSocket initial snapshot for tmux-backed sessions now uses buffered raw attach output and does not call `capture-pane`.
- If a tmux-backed runtime exists but has no attached websocket clients, the websocket server disposes that idle attach runtime and creates a fresh tmux attach runtime. The fresh attach gives xterm a real tmux repaint frame.
- HTTP history/status still use `capture-pane`, because those endpoints return textual scrollback rather than replaying an active terminal screen.

Regression coverage:

- Added backend websocket tests for:
  - tmux websocket snapshot does not use plain `capture-pane`.
  - buffered raw tmux attach output is used as the websocket snapshot.
  - idle tmux attach runtime is recycled before reconnect.
- Added Playwright coverage: `preserves vim screen and input after page refresh`.
- The refresh E2E waits for vim to enter insert mode, reloads the page, verifies the vim screen text is still visible, then continues typing, saves, and verifies the saved file contains the full text.

## Terminal Size Regression

User-reported symptom:

- New terminal does not fill the available width or height.
- tmux status line and TUI content stay around the default 80x24 area even when the browser terminal panel is much larger.

Root cause:

- The frontend sends the initial `resize` message as soon as the WebSocket opens.
- The backend previously registered `socket.on("message")` only after runtime recreation, subscription setup, and initial snapshot delivery.
- During tmux-backed session creation or attach, the initial resize could arrive before the backend message listener existed, so it was dropped. The tmux attach client then stayed at the node-pty default `80x24`.

Fix:

- The terminal WebSocket server now registers a message listener immediately after handshake validation.
- Client messages that arrive before the runtime is fully ready are queued and replayed once the runtime/action handler is installed.
- This preserves the initial resize, so tmux receives the full xterm dimensions instead of keeping the default `80x24`.

Regression coverage:

- Added backend websocket test: `queues resize messages that arrive while tmux runtime recreation is still pending`.
- Added Playwright coverage: `fits the terminal pane to the available viewport`.
- The E2E opens a terminal at `1780x900`, runs `stty size`, and asserts the shell sees more than `120` columns and more than `30` rows.

## Initial Repaint Flicker

User-reported symptom:

- After refreshing an active tmux-backed terminal page, the terminal can briefly render garbled content and then settle into the correct screen.

Root cause:

- A fresh tmux attach emits the full-screen repaint as multiple raw ANSI chunks.
- The websocket server subscribed to runtime output before sending the initial snapshot. Output that arrived during that window could be sent as a separate websocket `output` frame immediately after the snapshot path began.
- The frontend could therefore render a partial tmux frame for one paint, then render the later chunks and recover, producing the visible flash.

Fix:

- For tmux-backed websocket initial snapshots, the server now waits a short repaint settle window before resolving the buffered raw attach output.
- Output received during that settle window remains part of the runtime buffer used for the snapshot and is not replayed a second time as live output.
- The settle is only applied to tmux-backed initial snapshots; `snapshot=0` live consumers and plain pty sessions keep the existing behavior.

Regression coverage:

- Added backend websocket test: `coalesces tmux repaint chunks before the initial websocket snapshot`.
- The test emits one tmux repaint chunk before the websocket connects and another shortly after connection; the snapshot must contain both chunks, and the second chunk must not be duplicated as a live `output` message.

## Backend Restart Recovery Smoke

Manual process-level smoke:

1. Started backend on port `5511` with fixed files:
   - `TERMINAL_SESSION_STORE_FILE=/tmp/runweave-recovery-e2e-terminal-session.json`
   - `TERMINAL_TMUX_SOCKET_PATH=/tmp/runweave-recovery-e2e.tmux.sock`
2. Created terminal session `1364d870-a056-471c-a710-5c6418b2204b`.
3. Connected through `/ws/terminal`, wrote `WS_DEBUG_MARKER`, and confirmed it appeared in tmux pane history.
4. Stopped backend with `Ctrl-C`.
5. Restarted backend with the same store and tmux socket.
6. Confirmed `/api/terminal/session/:id/history` still contained `WS_DEBUG_MARKER`.
7. Reconnected WebSocket through the restarted backend, wrote `TMUX_RECOVERY_AFTER_1776484708924`, and confirmed history contained the new marker.

Result: backend process restart did not kill the tmux session, and the restarted backend could read and attach back to the existing terminal session.

## Project Verification

Commands:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Results:

- `pnpm typecheck`: passed for shared, backend, electron, and frontend.
- `pnpm lint`: passed for shared, backend, frontend, and electron.
- `pnpm test`: passed, including backend 48 files / 294 tests and frontend 24 files / 137 tests.
- `pnpm build`: passed for shared, backend, electron, and frontend. Vite reported the existing large chunk warning for `frontend/dist/assets/index-*.js`.
