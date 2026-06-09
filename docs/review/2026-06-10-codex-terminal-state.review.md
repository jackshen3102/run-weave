# 2026-06-10 Codex Terminal State Review

## Scope

- Review mode: review-only, no source/config/test/product-doc edits.
- Reviewed current unstaged workspace changes for Codex terminal state, App stop/input behavior, backend state routes, Electron hook bridge, CLI handoff/interrupt, and shared protocol changes.
- Intent inferred from diff and `docs/plans/2026-06-09-codex-cli-terminal-state.md`: replace Codex run-state inference with hook-driven `TerminalState`, expose state to App/CLI, and make App/CLI interruption send ESC through HTTP.

## 架构 / 策略发现

No blocking architecture findings.

Current decision: introduce a separate `TerminalStateService` backed by Codex lifecycle hooks, while leaving legacy completion event/feed code present but no longer used by this state machine.

Why this is acceptable at system level: the plan explicitly scopes notification/completion feed migration out of this phase, and the implementation keeps the legacy routes/types/websocket available instead of deleting them. This avoids mixing state-machine replacement with notification migration.

Candidate alternatives considered:

- Keep deriving App/CLI state from `activeCommand` and completion events. This has lower implementation cost but preserves the old ambiguity where Codex can be idle while the terminal session is still running.
- Fully migrate completion notifications into the new state/event model in the same change. This could produce a cleaner end state but has higher blast radius across Web/App/Electron notifications, websocket auth, and user-visible bells/markers.

Migration risk: users may temporarily lose old Codex completion markers/notifications in flows that depended on the old hook bridge, but the checked-in plan explicitly accepts that as out of scope for this phase.

## 代码 / 实现发现

### P2 - App composer clears and submits newline after HTTP send failure

Why this is a risk: `TerminalCommandComposer` assumes a rejected `onSendInput` means the send failed and should stop the submit sequence. The new App handler catches every `sendTerminalInput` failure, updates UI state, and then resolves normally. As a result, if the first HTTP request for the command text fails, the composer still sends a second request containing only `"\n"` and clears the user's input. On auth expiry this can also run the second request after `onAuthExpired()` has already been invoked. The visible behavior is data loss or an unintended bare Enter after a failed command send.

Evidence:

- `app/src/components/TerminalCommandComposer.tsx:29` to `app/src/components/TerminalCommandComposer.tsx:31`: submit sends `text`, then `"\n"`, then clears the value.
- `app/src/pages/AppTerminalPage.tsx:163` to `app/src/pages/AppTerminalPage.tsx:175`: `handleSendCommand` catches send failures and does not rethrow or return a failure signal.

Fix direction: make `handleSendCommand` reject/throw after setting the error, or change `onSendInput` to return a success boolean and have `TerminalCommandComposer` only send the newline and clear `value` after the text send succeeds. Add an App-level regression check for failed `sendTerminalInput` preserving the typed text and not sending the newline.

## Verification

- `git diff --check -- . ':(exclude)docs/review'`: passed.
- `pnpm --filter ./backend test -- terminal-state terminal`: passed, 60 files / 381 tests.
- `pnpm --filter ./electron test -- hook-installer`: passed, 94 tests.
- `pnpm --filter @runweave/cli test -- terminal`: passed, 3 files / 10 tests.
- `pnpm --filter @runweave/app typecheck`: passed.
- `pnpm --filter ./backend typecheck`: passed.
- `pnpm --filter @runweave/cli typecheck`: passed.
- `pnpm --filter ./electron typecheck`: passed.

## Remaining Risk

- No browser/App E2E was run for the mobile terminal composer failure path.
- The notification/completion marker behavior was treated as intentionally out of scope based on the current plan, not as a defect in this review.
