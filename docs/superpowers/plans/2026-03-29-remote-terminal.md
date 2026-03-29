# Remote Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-phase remote terminal feature with independent terminal sessions, a dedicated terminal websocket, PTY-backed interactive execution, arbitrary command execution, and a standalone frontend terminal page.

**Architecture:** Keep terminal functionality parallel to the existing viewer stack. Reuse the current backend app, auth model, and shared workspace package structure, but add a separate terminal domain with its own routes, websocket server, persistence model, and frontend connection flow. In phase one, accept arbitrary commands instead of introducing a profile registry.

**Tech Stack:** Express, ws, zod, better-sqlite3, React, existing shared workspace package, plus a PTY library and browser terminal renderer during implementation.

---

## File Structure

### Backend new files

- Create: `backend/src/routes/terminal.ts`
- Create: `backend/src/ws/terminal-server.ts`
- Create: `backend/src/ws/terminal-handshake.ts`
- Create: `backend/src/terminal/manager.ts`
- Create: `backend/src/terminal/runtime-registry.ts`
- Create: `backend/src/terminal/store.ts`
- Create: `backend/src/terminal/sqlite-store.ts`
- Create: `backend/src/terminal/pty-service.ts`
- Create: `backend/src/terminal/*.test.ts`

### Shared new files

- Create: `packages/shared/src/terminal-protocol.ts`
- Modify: `packages/shared/src/index.ts`

### Frontend new files

- Create: `frontend/src/services/terminal.ts`
- Create: `frontend/src/features/terminal/use-terminal-connection.ts`
- Create: `frontend/src/pages/terminal-page.tsx`
- Create: `frontend/src/components/terminal/*`
- Create: `frontend/src/components/terminal-page.test.tsx`

### Frontend modified files

- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/home/index.tsx`
- Modify: `frontend/src/services/session.ts` only if linked-terminal entry needs shared helpers

### Backend modified files

- Modify: `backend/src/index.ts`
- Modify: `backend/package.json`

## Task 1: Define terminal shared protocol and payloads

**Files:**

- Create: `packages/shared/src/terminal-protocol.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared` typecheck

- [ ] **Step 1: Write the shared protocol file with terminal request and event types**

Add a dedicated terminal protocol module that defines:

```ts
export interface CreateTerminalSessionRequest {
  name?: string;
  command: string;
  args?: string[];
  cwd?: string;
  linkedBrowserSessionId?: string;
}

export interface CreateTerminalSessionResponse {
  terminalSessionId: string;
  terminalUrl: string;
}

export interface TerminalSessionListItem {
  terminalSessionId: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  linkedBrowserSessionId?: string;
  status: "running" | "exited";
  createdAt: string;
  lastActivityAt: string;
}

export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "signal"; signal: "SIGINT" | "SIGTERM" | "SIGKILL" }
  | { type: "request-status" };

export type TerminalServerMessage =
  | { type: "connected"; terminalSessionId: string }
  | { type: "output"; data: string }
  | { type: "status"; status: "running" | "exited"; exitCode?: number }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; message: string };
```

- [ ] **Step 2: Export the protocol from the shared package**

Update the shared package barrel export:

```ts
export * from "./protocol";
export * from "./quality";
export * from "./terminal-protocol";
```

- [ ] **Step 3: Run shared typecheck**

Run: `pnpm --filter ./packages/shared typecheck`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/terminal-protocol.ts packages/shared/src/index.ts
git commit -m "feat: add terminal shared protocol"
```

## Task 2: Add backend terminal persistence and session manager

**Files:**

- Create: `backend/src/terminal/store.ts`
- Create: `backend/src/terminal/sqlite-store.ts`
- Create: `backend/src/terminal/manager.ts`
- Test: `backend/src/terminal/*.test.ts`

- [ ] **Step 1: Write failing tests for terminal session metadata lifecycle**

Create tests covering:

```ts
it("creates and lists terminal sessions", async () => {
  // create session metadata and verify it appears in list output
});

it("updates activity and exit state", async () => {
  // mark running session exited and verify persisted status
});

it("deletes terminal sessions", async () => {
  // remove session and verify lookup returns null
});
```

- [ ] **Step 2: Run backend test file to verify it fails**

Run: `pnpm --filter ./backend test -- src/terminal/manager.test.ts`  
Expected: FAIL because terminal manager modules do not exist yet

- [ ] **Step 3: Implement store contract and SQLite-backed metadata persistence**

Model the store after the existing browser session store, with fields for terminal session id, name, command, args, cwd, linked browser session id, status, created time, last activity, and exit code.

- [ ] **Step 4: Implement terminal session manager**

Create a manager responsible for:

```ts
createSession(...)
getSession(...)
listSessions()
markActivity(...)
markExited(...)
destroySession(...)
```

Keep PTY ownership separate from metadata persistence, but do not leave runtime ownership undefined. The manager should coordinate with a dedicated runtime registry introduced in the next task.

- [ ] **Step 5: Run targeted backend tests**

Run: `pnpm --filter ./backend test -- src/terminal/manager.test.ts src/terminal/sqlite-store.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/terminal/store.ts backend/src/terminal/sqlite-store.ts backend/src/terminal/manager.ts backend/src/terminal/*.test.ts
git commit -m "feat: add terminal session persistence"
```

## Task 3: Add PTY service and runtime registry

**Files:**

- Create: `backend/src/terminal/pty-service.ts`
- Create: `backend/src/terminal/runtime-registry.ts`
- Modify: `backend/package.json`
- Test: `backend/src/terminal/pty-service.test.ts`
- Test: `backend/src/terminal/runtime-registry.test.ts`

- [ ] **Step 1: Write failing tests for PTY session wrapper behavior and runtime ownership**

Cover:

```ts
it("spawns a PTY session with the provided command and args", () => {
  // command, args, and cwd are passed through
});

it("tracks terminalSessionId to runtime mapping and attach state", () => {
  // registry creates runtime, exposes lookup, and marks attached clients
});

it("disposes all runtimes during shutdown", async () => {
  // registry cleanup closes every active PTY
});
```

- [ ] **Step 2: Run the targeted test file to verify it fails**

Run: `pnpm --filter ./backend test -- src/terminal/pty-service.test.ts src/terminal/runtime-registry.test.ts`  
Expected: FAIL because the PTY service and runtime registry do not exist

- [ ] **Step 3: Add the PTY dependency**

Update `backend/package.json` to include the PTY library selected during implementation.

- [ ] **Step 4: Implement PTY service wrapper**

Wrap the PTY library behind a small interface with methods for:

```ts
spawnSession(...)
write(...)
resize(...)
signal(...)
dispose(...)
```

Keep the wrapper small so the websocket layer never talks to the PTY library directly.

- [ ] **Step 5: Implement runtime registry**

Create a dedicated runtime owner responsible for:

```ts
createRuntime(...)
getRuntime(...)
attachClient(...)
detachClient(...)
disposeRuntime(...)
disposeAll(...)
```

The registry should be the only in-memory owner of PTY instances and the only place that knows how `terminalSessionId` maps to a live process.

- [ ] **Step 6: Run backend targeted tests**

Run: `pnpm --filter ./backend test -- src/terminal/pty-service.test.ts src/terminal/runtime-registry.test.ts`  
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/package.json backend/src/terminal/pty-service.ts backend/src/terminal/runtime-registry.ts backend/src/terminal/*.test.ts
git commit -m "feat: add terminal runtime ownership"
```

## Task 4: Add backend terminal routes and websocket server

**Files:**

- Create: `backend/src/routes/terminal.ts`
- Create: `backend/src/ws/terminal-server.ts`
- Create: `backend/src/ws/terminal-handshake.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/src/routes/terminal.test.ts`
- Test: `backend/src/ws/terminal-server.test.ts`

- [ ] **Step 1: Write failing tests for terminal HTTP lifecycle**

Cover:

```ts
it("creates terminal sessions through the API", async () => {
  // POST /api/terminal/session returns terminal session metadata
});

it("lists terminal sessions through the API", async () => {
  // GET /api/terminal/session returns created sessions
});

it("deletes terminal sessions through the API", async () => {
  // DELETE removes the session
});
```

- [ ] **Step 2: Write failing websocket tests**

Cover:

```ts
it("rejects unauthorized terminal websocket requests", async () => {
  // missing or invalid token closes the socket
});

it("forwards input to PTY and output to the client", async () => {
  // websocket input yields output event
});

it("handles resize and signal messages", async () => {
  // resize and signal events are passed to the PTY service
});
```

- [ ] **Step 3: Run targeted tests to verify they fail**

Run: `pnpm --filter ./backend test -- src/routes/terminal.test.ts src/ws/terminal-server.test.ts`  
Expected: FAIL because route and websocket modules do not exist

- [ ] **Step 4: Implement terminal HTTP router**

Mirror existing route style:

- validate payloads with `zod`
- reuse bearer token auth by mounting under `/api`
- return structured JSON errors

- [ ] **Step 5: Implement terminal websocket handshake and server**

Mirror existing websocket style:

- validate `token`
- require `terminalSessionId`
- attach and detach websocket clients through the runtime registry
- emit `connected`, `status`, `output`, `exit`, `error`
- parse client messages with runtime validation

- [ ] **Step 6: Wire terminal services into backend runtime**

Update `backend/src/index.ts` to:

- create terminal runtime services
- mount `/api/terminal`
- attach `/ws/terminal`
- include runtime registry disposal in the shutdown path alongside `sessionManager.dispose()`

- [ ] **Step 7: Run backend targeted tests**

Run: `pnpm --filter ./backend test -- src/routes/terminal.test.ts src/ws/terminal-server.test.ts`  
Expected: PASS

- [ ] **Step 8: Run backend typecheck**

Run: `pnpm --filter ./backend typecheck`  
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add backend/src/routes/terminal.ts backend/src/ws/terminal-server.ts backend/src/ws/terminal-handshake.ts backend/src/index.ts backend/src/routes/terminal.test.ts backend/src/ws/terminal-server.test.ts
git commit -m "feat: add terminal backend transport"
```

## Task 5: Add frontend terminal service, route, and page

**Files:**

- Create: `frontend/src/services/terminal.ts`
- Create: `frontend/src/features/terminal/use-terminal-connection.ts`
- Create: `frontend/src/pages/terminal-page.tsx`
- Create: `frontend/src/components/terminal-page.test.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Write failing frontend tests for terminal page loading and auth failure handling**

Cover:

```tsx
it("renders the terminal page for a terminal session", async () => {
  // route mounts and requests session connection details
});

it("clears auth state when terminal APIs return 401", async () => {
  // unauthorized responses follow the existing frontend pattern
});
```

- [ ] **Step 2: Run targeted frontend tests to verify they fail**

Run: `pnpm --filter ./frontend test -- src/components/terminal-page.test.tsx`  
Expected: FAIL because the terminal page and services do not exist

- [ ] **Step 3: Implement terminal HTTP service client**

Create helpers for:

```ts
createTerminalSession(...)
listTerminalSessions(...)
deleteTerminalSession(...)
```

Follow the existing `requestJson` and `requestVoid` service pattern.

- [ ] **Step 4: Implement websocket connection hook**

The hook should:

- connect to `/ws/terminal`
- send input, resize, and signal messages
- expose output and status updates
- surface auth failures consistently

- [ ] **Step 5: Implement terminal page**

Build a first-phase page that:

- connects using `terminalSessionId` from the route
- hosts the browser terminal renderer
- shows terminal status and errors

- [ ] **Step 6: Wire the frontend route**

Update `frontend/src/App.tsx` to add a terminal route such as:

```tsx
<Route path="/terminal/:terminalSessionId" element={...} />
```

- [ ] **Step 7: Run targeted frontend tests**

Run: `pnpm --filter ./frontend test -- src/components/terminal-page.test.tsx`  
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add frontend/src/services/terminal.ts frontend/src/features/terminal/use-terminal-connection.ts frontend/src/pages/terminal-page.tsx frontend/src/components/terminal-page.test.tsx frontend/src/App.tsx
git commit -m "feat: add terminal frontend route"
```

## Task 6: Add terminal entry points from the home flow

**Files:**

- Modify: `frontend/src/pages/home/index.tsx`
- Create or modify: `frontend/src/pages/home/components/*`
- Test: `frontend/src/pages/home/*.test.tsx`

- [ ] **Step 1: Write failing tests for creating and entering a terminal session**

Cover:

```tsx
it("creates a terminal session from the home flow", async () => {
  // submit create action and navigate to the terminal page
});
```

- [ ] **Step 2: Run targeted tests to verify they fail**

Run: `pnpm --filter ./frontend test -- src/pages/home/*.test.tsx`  
Expected: FAIL or missing coverage for the new terminal flow

- [ ] **Step 3: Add a first-phase terminal creation entry point**

Keep scope small:

- simple create terminal action from home
- command、args、cwd 输入
- navigate to `/terminal/:terminalSessionId`

- [ ] **Step 4: Run targeted frontend tests**

Run: `pnpm --filter ./frontend test -- src/pages/home/*.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/home/index.tsx frontend/src/pages/home/components
git commit -m "feat: add terminal launch entry point"
```

## Task 7: Verify the first-phase end-to-end slice

**Files:**

- Modify: docs only if implementation details change
- Test: backend and frontend targeted suites

- [ ] **Step 1: Run shared typecheck**

Run: `pnpm --filter ./packages/shared typecheck`  
Expected: PASS

- [ ] **Step 2: Run backend targeted verification**

Run: `pnpm --filter ./backend test -- src/terminal src/routes/terminal.test.ts src/ws/terminal-server.test.ts`  
Expected: PASS

- [ ] **Step 3: Run frontend targeted verification**

Run: `pnpm --filter ./frontend test -- src/components/terminal-page.test.tsx`  
Expected: PASS

- [ ] **Step 4: Run workspace typechecks**

Run: `pnpm typecheck`  
Expected: PASS

- [ ] **Step 5: Run lint on touched files**

Run: `pnpm lint`  
Expected: PASS

- [ ] **Step 6: Commit the final verified slice**

```bash
git add .
git commit -m "feat: add remote terminal first phase"
```

## Notes for Implementation

- Keep terminal protocol separate from viewer protocol.
- Keep terminal session persistence separate from browser session persistence.
- Reuse existing auth patterns instead of inventing a new token flow.
- Do not couple terminal lifecycle to browser session lifecycle.
- Do define one explicit owner for live PTY instances and one explicit shutdown path for all runtimes.
- Start with a standalone terminal page; defer viewer embedding until the basic slice is stable.

## Self-Review

- Spec coverage: the plan covers shared protocol, backend model, PTY runtime, transport, frontend route, and entry flow. Viewer embedding and advanced recovery are intentionally deferred because they are outside first-phase scope.
- Placeholder scan: the plan avoids `TODO` and `TBD`, but leaves library selection abstract in the PTY step because package selection should be finalized during implementation. That is acceptable only if the implementation task explicitly updates `backend/package.json` as part of the step.
- Type consistency: `terminalSessionId`, `command`, `args`, `linkedBrowserSessionId`, `status`, `exitCode`, `/ws/terminal`, `/api/terminal/session`, and runtime registry ownership are used consistently throughout the plan.
