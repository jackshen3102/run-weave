# 终端完成绿点实时 WebSocket Plan Review

Review target: `docs/plans/2026-06-07-terminal-completion-events-websocket.md`

Scope: plan-vs-current-code review only. No implementation changes reviewed.

## Findings

### High: First-connect baseline can drop live completion events

The plan says first connection without a cursor should return `latestEventId` and not push history, while reconnects with `after` use catch-up. That avoids old markers, but it creates an unprotected window between the frontend deciding to subscribe and the `/ws/terminal-events` handshake completing. Any completion recorded after the page starts opening but before the first websocket baseline is established becomes part of `latestEventId` and is never delivered.

This violates the goal that an online frontend receives completion events in one websocket round trip. The same issue can also appear around catch-up if implementation sends catch-up before registering the live listener.

Evidence:

- `docs/plans/2026-06-07-terminal-completion-events-websocket.md:97` to `docs/plans/2026-06-07-terminal-completion-events-websocket.md:101` defines the no-cursor baseline behavior.
- `docs/plans/2026-06-07-terminal-completion-events-websocket.md:193` to `docs/plans/2026-06-07-terminal-completion-events-websocket.md:198` lists connect, catch-up, then subscribe responsibilities.
- Current store `listAfter(null)` returns all retained events, so the new no-history baseline needs distinct semantics: `backend/src/terminal/completion-events.ts:40` to `backend/src/terminal/completion-events.ts:47`.

Recommendation: make the ticket API return a baseline `latestEventId` together with the ticket, then always open the websocket with `after=<baseline>`. On the server, register the live listener before or atomically with the catch-up snapshot, so no event can land between catch-up and subscription.

### High: Removing the activeCommand hard gate broadens the completion trust model without a replacement

The plan changes `session.activeCommand` from a hard gate to a log-only field. That fixes late Stop hooks, but the current code intentionally uses `(source, activeCommand)` to prevent stale or mismatched hook events from lighting the green dot. With the proposed rule, any process that inherited `RUNWEAVE_HOOK_TOKEN` and `RUNWEAVE_TERMINAL_SESSION_ID` from a Runweave pane can later send a `source: "codex"` or `source: "trae"` Stop event even when the pane is no longer running that CLI, and the backend records it.

The plan acknowledges the tradeoff, but it does not specify a bounded replacement such as a recent activeCommand grace window, command/run correlation, or launcher-provided started/completed timestamps. That leaves implementers with no concrete way to preserve the existing false-positive boundary.

Evidence:

- Current code rejects unless the source matches the active command: `backend/src/routes/terminal-completion.ts:76` to `backend/src/routes/terminal-completion.ts:98`.
- Existing tests assert that `activeCommand: null` and mismatched Trae/Codex states are ignored: `backend/src/routes/terminal-completion.test.ts:143` to `backend/src/routes/terminal-completion.test.ts:210`, and `backend/src/routes/terminal-completion.test.ts:356` to `backend/src/routes/terminal-completion.test.ts:423`.
- The plan explicitly requires recording `activeCommand: null` if source/token/session are valid: `docs/plans/2026-06-07-terminal-completion-events-websocket.md:500` to `docs/plans/2026-06-07-terminal-completion-events-websocket.md:512`.

Recommendation: keep the late-hook fix, but add a concrete replacement gate. For example, store last known AI active command plus timestamp per terminal and accept a hook only when the source matched the active command currently or within a short grace window. If source-only is an intentional product decision, the plan should explicitly call out the false-positive regression and update the corresponding tests and architecture docs.

### Medium: Ignoring events for sessions not yet loaded can permanently lose markers

The plan tells `applyCompletionEvents()` to ignore events whose terminal session is not found in the current session list and still update the cursor to the max event id. During initial page load, backend switch, or slow session refresh, the websocket can deliver an event before `sessionsRef` is populated. If the handler ignores it and advances the cursor, the marker will never be applied after sessions load.

Current polling does not filter by session existence before setting the marker. Cleanup later removes markers for deleted sessions. The new plan changes that ordering and needs buffering or a delayed connection rule.

Evidence:

- `TerminalWorkspace` loads sessions asynchronously and only later populates `sessionsRef`: `frontend/src/components/terminal/terminal-workspace.tsx:117` to `frontend/src/components/terminal/terminal-workspace.tsx:166`.
- The plan says to ignore missing sessions and update the cursor to the max id: `docs/plans/2026-06-07-terminal-completion-events-websocket.md:336` to `docs/plans/2026-06-07-terminal-completion-events-websocket.md:341`.
- Current cleanup already removes markers for sessions that are no longer present: `frontend/src/components/terminal/terminal-workspace-effects.ts:162` to `frontend/src/components/terminal/terminal-workspace-effects.ts:180`.

Recommendation: either delay subscribing until sessions have loaded, or buffer unknown-session events until the next successful session load before advancing the durable cursor past them. If deleted-session suppression is required, let cleanup own that after the session list is known.

### Medium: The reconnect plan misses ticket acquisition failures

The plan says to reuse the existing terminal websocket reconnect and ticket pattern. The existing hook only auto-reconnects after a socket close; if ticket acquisition or websocket construction fails before a socket opens, it sets the connection closed and does not schedule another attempt. Because this new websocket is the only delivery path, a transient ticket API or network failure would permanently stop green-dot updates until remount.

Evidence:

- Existing hook fetches a ticket before opening the websocket: `frontend/src/features/terminal/use-terminal-connection.ts:177` to `frontend/src/features/terminal/use-terminal-connection.ts:194`.
- Non-401 errors in that pre-open path set error/closed without scheduling reconnect: `frontend/src/features/terminal/use-terminal-connection.ts:367` to `frontend/src/features/terminal/use-terminal-connection.ts:383`.
- The plan removes polling fallback and depends entirely on websocket reconnect: `docs/plans/2026-06-07-terminal-completion-events-websocket.md:350` to `docs/plans/2026-06-07-terminal-completion-events-websocket.md:354`.

Recommendation: specify retry behavior for ticket API failures and pre-open websocket errors, reusing the same backoff policy. Keep `401` as auth-expired and retry other failures.

## Notes

- The dedicated workspace websocket is the right direction. It avoids overloading `/ws/terminal`, which is currently session-scoped and attaches terminal runtime state.
- The plan should include docs updates for `docs/architecture/terminal-completion-hooks.md` if the activeCommand gate changes, because that doc currently describes the hook identity and security boundary.
- No validation commands were run; this was a static plan review against the current checkout.
