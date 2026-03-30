# Vim-Compatible Terminal Hardening (Solution 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing `xterm.js + node-pty` terminal path reliably support `vim` and other full-screen TUI apps without expanding the terminal JSON protocol.

**Architecture:** Keep the current terminal architecture and harden it in-place: preserve byte-stream passthrough end-to-end, enforce PTY capability defaults, and reuse the existing WebSocket transport heartbeat mechanism already used by the main viewer socket. Do not add terminal-specific app-layer `ping/pong` message types.

**Tech Stack:** React 19, `@xterm/xterm`, Express, `ws`, `node-pty`, Vitest, Playwright, pnpm workspaces.

---

## File Structure

### Backend files to modify

- Modify: `backend/src/terminal/pty-service.ts`
- Modify: `backend/src/terminal/pty-service.test.ts`
- Modify: `backend/src/ws/heartbeat.ts`
- Modify: `backend/src/ws/heartbeat.test.ts`
- Modify: `backend/src/ws/terminal-server.ts`
- Modify: `backend/src/ws/terminal-server.test.ts`

### Frontend files to modify

- Modify: `frontend/src/components/terminal/terminal-surface.tsx`
- Modify: `frontend/src/components/terminal-page.test.tsx`
- Modify: `frontend/src/features/terminal/use-terminal-connection.ts`
- Modify: `frontend/src/features/terminal/use-terminal-connection.test.tsx`

### Shared contract files

- Verify only (no API expansion): `packages/shared/src/terminal-protocol.ts`

### Frontend files to create

- Create: `frontend/tests/terminal-vim.spec.ts`

### Docs files to create

- Create: `docs/testing/terminal-vim-regression.md`

## Task 1: Lock PTY Compatibility Defaults (`TERM`, color capability)

**Files:**

- Modify: `backend/src/terminal/pty-service.ts`
- Test: `backend/src/terminal/pty-service.test.ts`

- [ ] **Step 1: Write failing PTY env compatibility tests**

Add tests asserting:

```ts
it("uses xterm-256color when TERM is missing or dumb", () => {
  // expect spawn env TERM to be xterm-256color
});

it("keeps caller TERM when explicitly provided", () => {
  // options.env.TERM should override fallback
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./backend test -- src/terminal/pty-service.test.ts -t "TERM"`
Expected: FAIL because fallback/env precedence behavior is incomplete.

- [ ] **Step 3: Write minimal implementation**

```ts
function buildPtyEnv(
  baseEnv: NodeJS.ProcessEnv,
  sessionEnv?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const merged = { ...baseEnv, ...sessionEnv };
  const term = merged.TERM?.trim();
  if (!term || term === "dumb") {
    merged.TERM = "xterm-256color";
  }
  if (!merged.COLORTERM?.trim()) {
    merged.COLORTERM = "truecolor";
  }
  return merged;
}
```

Use PTY spawn option: `name: "xterm-256color"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./backend test -- src/terminal/pty-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/terminal/pty-service.ts backend/src/terminal/pty-service.test.ts
git commit -m "fix: harden PTY TERM defaults for vim compatibility"
```

## Task 2: Enforce Frontend Byte-Stream Transparency for xterm rendering

**Files:**

- Modify: `frontend/src/components/terminal/terminal-surface.tsx`
- Test: `frontend/src/components/terminal-page.test.tsx`

- [ ] **Step 1: Write/update failing rendering expectation test**

```ts
expect(terminalWriteMock).toHaveBeenCalledWith("$ pwd\n/tmp/demo\n");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./frontend test -- src/components/terminal-page.test.tsx -t "renders the terminal page"`
Expected: FAIL if output normalization mutates PTY stream.

- [ ] **Step 3: Write minimal implementation**

```ts
const nextChunk =
  output.length >= renderedOutputLengthRef.current
    ? output.slice(renderedOutputLengthRef.current)
    : output;

if (nextChunk) {
  terminal.write(nextChunk);
  renderedOutputLengthRef.current = output.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./frontend test -- src/components/terminal-page.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/terminal/terminal-surface.tsx frontend/src/components/terminal-page.test.tsx
git commit -m "fix: preserve raw PTY output for xterm rendering"
```

## Task 3: Add Protocol Guardrail (No terminal JSON heartbeat expansion)

**Files:**

- Verify: `packages/shared/src/terminal-protocol.ts`
- Modify: `backend/src/ws/terminal-server.test.ts`

- [ ] **Step 1: Write failing guardrail test for unsupported app-layer heartbeat**

```ts
it("rejects unsupported terminal app-layer ping messages", async () => {
  // send { type: "ping" } and expect { type: "error", message: "Invalid message" }
});
```

- [ ] **Step 2: Run test to verify failure (if ping was accidentally accepted)**

Run: `pnpm --filter ./backend test -- src/ws/terminal-server.test.ts -t "app-layer ping"`
Expected: FAIL if parser accepts custom ping.

- [ ] **Step 3: Keep shared protocol unchanged and parser strict**

Terminal protocol union remains:

```ts
type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "signal"; signal: TerminalSignal }
  | { type: "request-status" };
```

No `ping`/`pong` JSON types added.

- [ ] **Step 4: Run tests and shared typecheck**

Run: `pnpm --filter ./backend test -- src/ws/terminal-server.test.ts`
Expected: PASS.

Run: `pnpm --filter ./packages/shared typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/ws/terminal-server.test.ts
git commit -m "test: guard terminal protocol against app-layer heartbeat expansion"
```

## Task 4: Reuse Existing Transport Heartbeat in Terminal WebSocket (Recommended Path)

**Files:**

- Modify: `backend/src/ws/heartbeat.ts`
- Modify: `backend/src/ws/heartbeat.test.ts`
- Modify: `backend/src/ws/terminal-server.ts`
- Modify: `backend/src/ws/terminal-server.test.ts`

- [ ] **Step 1: Write failing tests for heartbeat reuse and lifecycle**

Add/adjust tests:

```ts
it("heartbeat controller works with minimal heartbeat state", () => {
  // no ConnectionContext casting required
});

it("terminal websocket starts and stops heartbeat lifecycle", async () => {
  // verify heartbeat setup is attached for terminal ws path
});
```

- [ ] **Step 2: Run tests to verify they fail first**

Run: `pnpm --filter ./backend test -- src/ws/heartbeat.test.ts src/ws/terminal-server.test.ts`
Expected: FAIL before refactor.

- [ ] **Step 3: Write minimal implementation to decouple heartbeat from viewer-only context**

Refactor heartbeat state shape:

```ts
export interface HeartbeatState {
  heartbeatTimer: NodeJS.Timeout | null;
  isAlive: boolean;
}

export function createHeartbeatController(
  socket: WebSocket,
  state: HeartbeatState,
) {
  // unchanged ping/terminate/markAlive logic
}
```

Wire terminal websocket to this controller:

```ts
const heartbeatState = { heartbeatTimer: null, isAlive: true };
const heartbeat = createHeartbeatController(socket, heartbeatState);
heartbeat.start();
socket.on("pong", heartbeat.markAlive);
socket.on("close", () => heartbeat.stop());
socket.on("error", () => heartbeat.stop());
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter ./backend test -- src/ws/heartbeat.test.ts src/ws/terminal-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/ws/heartbeat.ts backend/src/ws/heartbeat.test.ts backend/src/ws/terminal-server.ts backend/src/ws/terminal-server.test.ts
git commit -m "feat: reuse transport heartbeat controller for terminal websocket"
```

## Task 5: Define Frontend Connection State Machine + No-Message Watchdog

**Files:**

- Modify: `frontend/src/features/terminal/use-terminal-connection.ts`
- Modify: `frontend/src/features/terminal/use-terminal-connection.test.tsx`

- [ ] **Step 1: Write failing tests for retry semantics and stale-connection detection**

```ts
it("keeps connectionStatus as connecting during unauthorized ticket retry", () => {
  // first socket closes with 1008 Unauthorized, retry begins immediately
  // expected status sequence includes connecting, not intermediate closed flash
});

it("sets connectionStatus to closed only after retry budget is exhausted", () => {
  // unauthorized close after retry should settle to closed and trigger auth-expired path
});

it("marks connection closed after prolonged no-message timeout", () => {
  // use fake timers, no inbound message events, expect closed state
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./frontend test -- src/features/terminal/use-terminal-connection.test.tsx`
Expected: FAIL before state-machine and watchdog implementation.

- [ ] **Step 3: Write minimal state-machine + watchdog implementation**

```ts
const NO_MESSAGE_TIMEOUT_MS = 45_000;
const MAX_UNAUTHORIZED_RETRIES = 1;

// retry flow:
// close(Unauthorized) with retry budget -> setConnectionStatus("connecting"), reconnect
// close(Unauthorized) after retries exhausted -> setConnectionStatus("closed"), onAuthExpired?.()
//
// liveness flow:
// track lastMessageAt on every socket "message"
// if connected and Date.now() - lastMessageAt > timeout, close socket
//
// no protocol additions; no ping/pong JSON payloads
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./frontend test -- src/features/terminal/use-terminal-connection.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/terminal/use-terminal-connection.ts frontend/src/features/terminal/use-terminal-connection.test.tsx
git commit -m "feat: refine terminal connection state machine and no-message watchdog"
```

## Task 6: Add E2E Regression for `vim` Full-Screen Interaction

**Files:**

- Create: `frontend/tests/terminal-vim.spec.ts`

- [ ] **Step 1: Write failing Playwright spec for `vim` lifecycle**

```ts
test("supports vim write/exit and preserves interaction through resize", async ({
  page,
  request,
}) => {
  await loginAndSeedToken(request, page);
  await page.goto("/");

  await page.getByLabel("Terminal command").fill("bash");
  await page.getByRole("button", { name: "Open Terminal" }).click();
  await page.getByLabel("Terminal emulator").click({ force: true });

  await page.keyboard.type("vim /tmp/viewer-vim-e2e.txt");
  await page.keyboard.press("Enter");
  await page.keyboard.press("i");
  await page.keyboard.type("viewer-vim-e2e");
  await page.setViewportSize({ width: 1180, height: 840 });
  await page.keyboard.type("-after-resize");
  await page.keyboard.press("Escape");
  await page.keyboard.type(":wq");
  await page.keyboard.press("Enter");

  await page.keyboard.type("cat /tmp/viewer-vim-e2e.txt");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => page.getByLabel("Terminal output").textContent())
    .toContain("viewer-vim-e2e-after-resize");
});
```

- [ ] **Step 2: Run test to verify it fails first if a compatibility gap remains**

Run: `pnpm --filter ./frontend e2e -- tests/terminal-vim.spec.ts`
Expected: FAIL until compatibility path is complete.

- [ ] **Step 3: Apply minimal fix only if needed**

Allowed scope:

```txt
frontend/src/components/terminal/terminal-surface.tsx
frontend/src/features/terminal/use-terminal-connection.ts
backend/src/ws/terminal-server.ts
backend/src/terminal/pty-service.ts
```

- [ ] **Step 4: Re-run E2E spec**

Run: `pnpm --filter ./frontend e2e -- tests/terminal-vim.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/tests/terminal-vim.spec.ts frontend/src/components/terminal/terminal-surface.tsx frontend/src/features/terminal/use-terminal-connection.ts backend/src/ws/terminal-server.ts backend/src/terminal/pty-service.ts
git commit -m "test: add vim e2e regression for terminal compatibility"
```

## Task 7: Observability and Runbook

**Files:**

- Modify: `backend/src/ws/terminal-server.ts`
- Create: `docs/testing/terminal-vim-regression.md`

- [ ] **Step 1: Write failing expectation on structured terminal runtime errors**

```ts
expect(consoleErrorSpy).toHaveBeenCalledWith(
  "[viewer-be] terminal runtime action failed",
  expect.objectContaining({ action: "input", terminalSessionId: "terminal-1" }),
);
```

- [ ] **Step 2: Run backend terminal websocket tests to verify failure first**

Run: `pnpm --filter ./backend test -- src/ws/terminal-server.test.ts`
Expected: FAIL if context is incomplete.

- [ ] **Step 3: Write minimal logging + runbook documentation**

Error payload shape:

```ts
{
  terminalSessionId,
  action,
  error: String(error),
}
```

Runbook content:

```md
# Terminal Vim Regression Runbook

- Unit smoke: pty-service.test.ts + heartbeat.test.ts + terminal-server.test.ts
- E2E smoke: terminal.spec.ts + terminal-vim.spec.ts
- Release gate: all targeted suites pass before merge
- Manual check: resize while in vim insert mode, then :wq and verify file content
```

- [ ] **Step 4: Run verification commands**

Run: `pnpm --filter ./backend test -- src/ws/terminal-server.test.ts`
Expected: PASS.

Run: `pnpm --filter ./frontend e2e -- tests/terminal.spec.ts tests/terminal-vim.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/ws/terminal-server.ts docs/testing/terminal-vim-regression.md
git commit -m "docs: add terminal vim regression runbook and logging checks"
```

## Final Verification Gate

- [ ] **Step 1: Run backend targeted suite**

Run: `pnpm --filter ./backend test -- src/terminal/pty-service.test.ts src/ws/heartbeat.test.ts src/ws/terminal-server.test.ts`
Expected: PASS.

- [ ] **Step 2: Run frontend targeted suite**

Run: `pnpm --filter ./frontend test -- src/components/terminal-page.test.tsx src/features/terminal/use-terminal-connection.test.tsx`
Expected: PASS.

- [ ] **Step 3: Run frontend E2E terminal suite**

Run: `pnpm --filter ./frontend e2e -- tests/terminal.spec.ts tests/terminal-vim.spec.ts`
Expected: PASS.

- [ ] **Step 4: Run shared typecheck and package lint/typecheck**

Run: `pnpm --filter ./packages/shared typecheck && pnpm --filter ./backend lint && pnpm --filter ./backend typecheck && pnpm --filter ./frontend lint && pnpm --filter ./frontend typecheck`
Expected: PASS.

- [ ] **Step 5: Final merge readiness checkpoint**

```bash
git status
```

Expected: clean working tree or only intended tracked changes.

## Self-Review

### 1. Spec coverage

- Requirement: keep Solution 1 (`xterm.js + node-pty`) and improve `vim` support.
- Coverage mapping:
  - PTY defaults: Task 1
  - raw byte-stream rendering: Task 2
  - shared protocol no-expansion guardrail: Task 3
  - heartbeat reuse from existing transport mechanism: Task 4
  - frontend watchdog as secondary safety net: Task 5
  - vim user flow regression proof: Task 6
  - ops confidence/runbook: Task 7
- Gaps found: none.

### 2. Placeholder scan

- Checked for `TODO`, `TBD`, `implement later`, and `similar to Task N` placeholders.
- Result: none found.

### 3. Type/signature consistency

- Heartbeat work uses transport-level WS `ping`/`pong`, not shared terminal JSON message types.
- `TerminalClientMessage` and `TerminalServerMessage` unions remain unchanged.
- Timeout naming is consistent (`NO_MESSAGE_TIMEOUT_MS`) in Task 5 test and implementation snippets.
- Retry semantics are consistent in Task 5: retry window keeps `connectionStatus="connecting"`, terminal `closed` is only terminal-state after retries/timeouts.
