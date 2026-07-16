# app-server Event Center Test Cases

## Scope

These cases cover the implemented Event Center slice described by
`docs/architecture/app-server-event-center.md`.

The implementation uses an append-only JSONL event log at
`~/.runweave/app-server/app-server-events.jsonl` with a default 7-day retention
window, while preserving the planned HTTP, WebSocket, singleton, token, dedupe,
restart-recovery, hook double-write, and backend-degraded-client semantics.

## Commands

```bash
pnpm app-server:verify
pnpm app-server:verify-cli-start
pnpm toolkit:verify-hooks
pnpm --filter @runweave/app-server typecheck
pnpm --filter @runweave/app-server lint
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/shared typecheck
git diff --check
```

## AS-EC-001 Singleton Owner

Steps:

1. Start app-server with a temporary `RUNWEAVE_APP_SERVER_STATE_DIR`.
2. Read `app-server.lock.json`.
3. Start a second app-server with the same state dir.

Expected:

- The first server writes lock and token files.
- `/healthz` returns `service: "runweave-app-server"` and
  `protocolVersion: 1`.
- The second process exits successfully after reporting the existing owner.
- The second process does not overwrite the token or take ownership.

Automated by: `pnpm app-server:verify`.

## AS-EC-002 Event Write, Query, And Dedupe

Steps:

1. Write `diagnostic.created` with `POST /events`.
2. Query `GET /events?after=0&kind=diagnostic.created`.
3. Write the same request again with the same `dedupeKey`.

Expected:

- First write returns `201` and string event id `1`.
- Query returns the written payload and `latestEventId: "1"`.
- Duplicate write returns `200` and the same event id.
- The log contains only one event for that `dedupeKey`.

Automated by: `pnpm app-server:verify`.

## AS-EC-003 WebSocket Catchup And Live Delivery

Steps:

1. Connect to `/events/stream?after=0&kind=diagnostic.created`.
2. Connect a second subscriber to the same stream.
3. Observe `connected` then `catchup` on both subscribers.
4. Write another matching event from a different `source.instanceId` through
   `POST /events`.

Expected:

- Catchup contains existing matching events for both subscribers.
- Live delivery emits the new event once to each subscriber.
- Event ids are monotonic strings.
- The script covers more than one producer `instanceId` and more than one
  active subscriber.

Automated by: `pnpm app-server:verify`.

## AS-EC-004 Restart Recovery

Steps:

1. Write events.
2. Stop app-server.
3. Restart app-server with the same state dir.
4. Query `GET /events?after=0`.

Expected:

- Previously written events remain queryable.
- `latestEventId` remains the maximum persisted id.
- New writes continue from the persisted maximum id.

Automated by: `pnpm app-server:verify`.

## AS-EC-005 Hook Double-Write With Backend Fallback

Steps:

1. Run the hook verification with a mock backend and mock app-server.
2. Simulate Codex Stop and Trae Stop hooks.
3. Simulate app-server 401.
4. Simulate missing Runweave terminal identity.

Expected:

- Codex and Trae Stop hooks still post to the existing backend
  `/internal/terminal/agent-hook` and `/internal/terminal-completion` endpoints.
- When app-server is available, each Stop hook also writes `agent.hook` and
  `agent.completion`.
- `agent.completion.payload.summary` matches the existing extraction result.
- app-server 401 does not prevent backend fallback.
- Missing `RUNWEAVE_TERMINAL_SESSION_ID` writes neither backend nor app-server.
- Hook process exit code remains `0`.

Automated by: `pnpm toolkit:verify-hooks`.

## AS-EC-007 Auth, Origin, And Hook Payload Validation

Steps:

1. Start app-server with a temporary `RUNWEAVE_APP_SERVER_STATE_DIR`.
2. Call `GET /healthz` and `GET /readyz` without `Authorization`.
3. Call `POST /events`, `GET /events`, `GET /events/latest`, and
   `WS /events/stream` without a bearer token, then with an incorrect bearer
   token.
4. Call an authenticated `POST /events` with a non-loopback `Origin`, for
   example `https://example.com`.
5. Call `POST /events` with invalid hook event bodies:
   - `agent.hook` without `scope.terminalSessionId`.
   - `agent.hook` with a non-object `payload`.
   - `agent.completion` with `payload.source: "traecli"`.
   - `agent.completion` with an unsupported `payload.completionReason`.
6. Call `GET /events?after=abc` and `GET /events?limit=0`.
7. Call `POST /events` with a valid `agent.completion` body using
   `payload.source: "codex"` and `payload.completionReason: "hook_stop"`.

Expected:

- `/healthz` returns `200` without token and includes
  `service: "runweave-app-server"` and `protocolVersion: 1`.
- `/readyz` returns `200` without token.
- Protected HTTP routes reject missing or incorrect bearer tokens with `401`.
- `WS /events/stream` rejects missing or incorrect bearer tokens during the
  upgrade.
- Any non-loopback `Origin` is rejected with `403` before event mutation.
- Invalid hook event bodies return `400` and do not append to
  `app-server-events.jsonl`.
- Invalid event query cursors or limits return `400`.
- A valid `agent.completion` event returns `201` and remains queryable through
  `GET /events?kind=agent.completion`.

Verification:

- This case is derived from `app-server/src/auth.ts`,
  `app-server/src/http-server.ts`, and `app-server/src/websocket-server.ts`.
- Automated by: `pnpm app-server:verify`.

## AS-EC-008 CLI-Owned App-Server Start

Steps:

1. Build the Runweave CLI.
2. Run `rw app-server start` with a temporary empty state dir.
3. Run `rw app-server start` again with the same state dir.
4. Write a stale lock and run `rw app-server start`.
5. Run `rw app-server start` concurrently from multiple callers.
6. Run `rw app-server start` with a missing CLI app-server entry.

Expected:

- Empty state starts one app-server and returns redacted status JSON.
- Existing healthy owner is reused; a second owner is not created.
- Stale lock is removed and replaced by a healthy owner.
- Concurrent CLI starts converge on one healthy owner.
- Missing entry exits nonzero and reports unavailable state.
- Token value is never printed to stdout.

Automated by: `pnpm app-server:verify-cli-start`.

## AS-EC-009 CLI App-Server Status And Start

Steps:

1. Run `rw app-server status` with an empty temporary state dir.
2. Run `rw app-server start`.
3. Run `rw app-server status` again.

Expected:

- First status reports unavailable and does not create a lock.
- Start creates a healthy owner and reports `baseUrl`, `pid`, lock path, and `hasToken`.
- Second status reports the same owner.
- Token value is never printed to stdout.

Automated by: `pnpm app-server:verify-cli-start`.

## AS-EC-010 Hook Does Not Auto-Start App-Server

Steps:

1. Run hook verification with a temporary `HOME`.
2. Do not provide `RUNWEAVE_APP_SERVER_URL` or `RUNWEAVE_APP_SERVER_TOKEN`.
3. Provide backend fallback endpoints and Runweave terminal identity.

Expected:

- Hook posts to backend fallback endpoints.
- Hook does not create `~/.runweave/app-server/app-server.lock.json`.
- Hook process exit code remains `0`.

Automated by: `pnpm toolkit:verify-hooks`.

## AS-EC-011 Isolated App-Server Discovery Propagates Into Terminal Panes

Steps:

1. Start a real App Server with a temporary `RUNWEAVE_APP_SERVER_HOME`.
2. Start Backend with `RUNWEAVE_APP_SERVER_DISCOVERY=explicit` and the
   matching isolated App Server URL/token.
3. Create a real tmux-backed terminal and inspect its tmux session
   environment.
4. Trigger the real hook bridge from the terminal Pane.

Expected:

- The tmux session environment contains the isolated discovery mode,
  App Server URL/token, and state home; the token value is never logged.
- Hook bridge writes `agent.hook` / `agent.completion` only to the isolated
  App Server event log.
- Global `~/.runweave/app-server/app-server-events.jsonl` does not receive the
  isolated terminal event.
- Existing backend fallback hook endpoints remain available.

Automated by: `pnpm toolkit:verify-hooks` plus isolated runtime verification.

## AS-EC-012 Existing Tmux Sessions Refresh Discovery After Backend Restart

Steps:

1. Start Backend A with isolated App Server A and create a tmux-backed
   terminal.
2. Stop Backend A without killing the tmux session.
3. Start Backend B against isolated App Server B while reusing the same
   browser profile/tmux socket.
4. Reattach to the terminal and trigger hook bridge from its existing Pane.

Expected:

- Backend B refreshes the existing tmux session environment before hooks run.
- The existing Pane discovers App Server B, not App Server A or the global
  default.
- App Server B receives the event; App Server A and global event logs do not.

Failure:

- Existing Pane keeps stale discovery values after reattach.
- Hook bridge falls back to global discovery when explicit isolated discovery
  is configured.

## AS-EC-013 Hook Discovery Honors HOME And Explicit Mode

Steps:

1. Run hook discovery with only `RUNWEAVE_APP_SERVER_HOME` pointing to a
   temporary healthy App Server.
2. Run with `RUNWEAVE_APP_SERVER_DISCOVERY=explicit` and no valid explicit
   URL/token while a healthy global App Server fixture exists.
3. Run with `RUNWEAVE_APP_SERVER_DISCOVERY=disabled`.

Expected:

- `RUNWEAVE_APP_SERVER_HOME` resolves lock/token from that directory.
- Explicit mode returns unavailable instead of reading global files.
- Disabled mode never contacts or reads an App Server.

Automated by: `pnpm toolkit:verify-hooks`.
