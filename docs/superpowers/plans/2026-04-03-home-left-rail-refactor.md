# Home Left Rail Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the home page so session management is always visible on the left side, with the top-right session button and slide-out drawer removed entirely.

**Architecture:** Keep the existing home-page data flow and service calls in `frontend/src/pages/home/index.tsx`, but replace the drawer-driven presentation with a persistent left-side management rail. The header becomes lightweight branding, while a new sidebar component owns the relocated actions, session creation form, and flat session list. Session open, rename, and remove actions remain in-place on each card instead of hiding behind the drawer.

**Tech Stack:** React, React Router, TypeScript, Tailwind CSS, Vitest, Testing Library

---

## File Structure

- Modify: `frontend/src/pages/home/index.tsx`
  Keeps all stateful session/terminal logic, removes drawer state/effects, and renders the new left-rail layout.
- Modify: `frontend/src/pages/home/components/home-header.tsx`
  Simplifies the header so it no longer renders the session button or action cluster.
- Create: `frontend/src/pages/home/components/home-sidebar.tsx`
  New presentational wrapper that stacks connection controls, session creation, and the flat session list in the left column.
- Modify: `frontend/src/pages/home/components/new-session-form.tsx`
  Adapts spacing and width to work inside the left rail instead of as a right-column standalone card.
- Modify: `frontend/src/pages/home/components/session-list.tsx`
  Adds loading/empty-state presentation suitable for always-visible rendering.
- Modify: `frontend/src/pages/home/components/session-list-item.tsx`
  Makes `Open`, `Rename`, and `Remove` visible inline, removing the overflow menu dependency.
- Delete: `frontend/src/pages/home/components/session-drawer.tsx`
  Fully removed because the UI no longer uses a drawer.
- Modify: `frontend/src/App.test.tsx`
  Updates integration tests to validate the new home layout and the absence of the old drawer trigger.

### Task 1: Lock The New Behavior With Failing Tests

**Files:**

- Modify: `frontend/src/App.test.tsx`
- Test: `frontend/src/App.test.tsx`

- [ ] **Step 1: Write the failing integration test for the always-visible left rail**

```tsx
it("renders session management inline on the home page without a sessions drawer", async () => {
  localStorage.setItem("viewer.auth.token", "token-1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/session/cdp-endpoint-default") {
        return jsonResponse({ endpoint: "http://127.0.0.1:9333" });
      }
      if (url === "/api/session") {
        return jsonResponse([
          {
            sessionId: "session-1",
            name: "CDP Playweight",
            lastActivityAt: "2026-03-23T07:31:19.000Z",
            connected: true,
            proxyEnabled: false,
            sourceType: "connect-cdp",
            headers: {},
          },
        ]);
      }
      throw new Error(`Unhandled request: ${url}`);
    }),
  );

  renderApp();

  await waitFor(() => {
    expect(screen.getByText("New Session")).toBeInTheDocument();
  });

  expect(screen.queryByRole("button", { name: "Sessions 1" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Open Terminal" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Logout" })).toBeInTheDocument();
  expect(screen.getByText("CDP Playweight")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the targeted test to verify it fails against the current drawer UI**

Run: `pnpm --filter frontend test -- --run frontend/src/App.test.tsx -t "renders session management inline on the home page without a sessions drawer"`

Expected: FAIL because the current page still renders the `Sessions` button and does not show inline `Rename` / `Remove` controls.

- [ ] **Step 3: Add a regression test proving session metadata is visible without opening anything**

```tsx
it("shows proxy and header metadata in the inline session list", async () => {
  localStorage.setItem("viewer.auth.token", "token-1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          sessionId: "session-1",
          name: "Default Playweight",
          lastActivityAt: "2026-03-23T07:31:19.000Z",
          connected: false,
          proxyEnabled: true,
          sourceType: "launch",
          headers: { "x-team": "alpha" },
        },
      ],
    })),
  );

  renderApp();

  await waitFor(() => {
    expect(screen.getByText("Default Playweight")).toBeInTheDocument();
  });

  expect(
    screen.getByText((content) => content.includes("Proxy enabled")),
  ).toBeInTheDocument();
  expect(
    screen.getByText((content) => content.includes("1 header")),
  ).toBeInTheDocument();
  expect(screen.queryByText("Quiet history.")).toBeNull();
});
```

- [ ] **Step 4: Run the test file to confirm the new expectations fail before implementation**

Run: `pnpm --filter frontend test -- --run frontend/src/App.test.tsx`

Expected: FAIL with assertions around the removed drawer text/button and missing inline actions.

- [ ] **Step 5: Commit the red test checkpoint**

```bash
git add frontend/src/App.test.tsx
git commit -m "test: define inline home session management layout"
```

### Task 2: Build The Left Rail Container And Simplify The Header

**Files:**

- Create: `frontend/src/pages/home/components/home-sidebar.tsx`
- Modify: `frontend/src/pages/home/components/home-header.tsx`
- Modify: `frontend/src/pages/home/components/new-session-form.tsx`
- Test: `frontend/src/App.test.tsx`

- [ ] **Step 1: Create the left-rail wrapper component**

```tsx
import type { SessionListItem } from "@browser-viewer/shared";
import { ThemeToggle } from "../../../components/theme-toggle";
import { Button } from "../../../components/ui/button";
import { NewSessionForm } from "./new-session-form";
import { SessionList } from "./session-list";

interface HomeSidebarProps {
  terminalLoading: boolean;
  terminalError: string | null;
  connectionName?: string;
  onSwitchConnection?: () => void;
  onOpenTerminal: () => void;
  onLogout: () => void;
  sessionSourceType: "launch" | "connect-cdp";
  onSessionSourceTypeChange: (value: "launch" | "connect-cdp") => void;
  sessionName: string;
  onSessionNameChange: (value: string) => void;
  cdpEndpoint: string;
  cdpEndpointPlaceholder: string;
  onCdpEndpointChange: (value: string) => void;
  proxyEnabled: boolean;
  onProxyEnabledChange: (value: boolean) => void;
  requestHeadersInput: string;
  onRequestHeadersInputChange: (value: string) => void;
  loading: boolean;
  error: string | null;
  sessions: SessionListItem[];
  loadingSessions: boolean;
  deletingSessionId: string | null;
  onSubmitSession: () => void;
  onRenameSession: (sessionId: string) => void;
  onRemoveSession: (sessionId: string) => void;
  onResumeSession: (sessionId: string) => void;
}

export function HomeSidebar(props: HomeSidebarProps) {
  const {
    terminalLoading,
    terminalError,
    connectionName,
    onSwitchConnection,
    onOpenTerminal,
    onLogout,
    sessions,
    loadingSessions,
    deletingSessionId,
    onSubmitSession,
    onRenameSession,
    onRemoveSession,
    onResumeSession,
    ...formProps
  } = props;

  return (
    <aside className="flex h-full flex-col gap-5 rounded-[2rem] border border-border/60 bg-card/76 p-4 shadow-[0_30px_120px_-70px_rgba(17,24,39,0.65)] backdrop-blur-xl sm:p-5">
      <section className="space-y-3 rounded-[1.5rem] border border-border/60 bg-background/45 p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground/70">
            Workspace
          </p>
          <ThemeToggle />
        </div>

        <Button
          className="h-10 w-full rounded-full"
          onClick={onOpenTerminal}
          disabled={terminalLoading}
        >
          {terminalLoading ? "Opening..." : "Open Terminal"}
        </Button>

        {connectionName && onSwitchConnection ? (
          <Button
            variant="ghost"
            className="h-10 w-full rounded-full justify-between"
            onClick={onSwitchConnection}
          >
            <span>{connectionName}</span>
            <span>Switch</span>
          </Button>
        ) : null}

        <Button
          variant="ghost"
          className="h-10 w-full rounded-full"
          onClick={onLogout}
        >
          Logout
        </Button>

        {terminalError ? (
          <p className="text-sm text-red-500" role="alert">
            {terminalError}
          </p>
        ) : null}
      </section>

      <NewSessionForm {...formProps} onSubmit={onSubmitSession} />

      <section className="flex min-h-0 flex-1 flex-col rounded-[1.5rem] border border-border/60 bg-background/40 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground/70">
              Sessions
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {loadingSessions
                ? "Refreshing quietly..."
                : `${sessions.length} total`}
            </p>
          </div>
        </div>

        <div className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <SessionList
            sessions={sessions}
            loadingSessions={loadingSessions}
            deletingSessionId={deletingSessionId}
            onRenameSession={onRenameSession}
            onRemoveSession={onRemoveSession}
            onResumeSession={onResumeSession}
          />
        </div>
      </section>
    </aside>
  );
}
```

- [ ] **Step 2: Simplify the home header to branding only**

```tsx
interface HomeHeaderProps {
  connectionName?: string;
}

export function HomeHeader({ connectionName }: HomeHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.38em] text-muted-foreground/70">
          Browser Viewer
        </p>
        {connectionName ? (
          <span className="rounded-full border border-border/60 bg-background/60 px-3 py-1 text-[0.65rem] text-muted-foreground">
            {connectionName}
          </span>
        ) : null}
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Resize the session form so it fits naturally inside the rail**

```tsx
export function NewSessionForm(props: NewSessionFormProps) {
  const { sessionSourceType, loading, error, onSubmit } = props;

  return (
    <section className="w-full rounded-[1.5rem] border border-border/60 bg-background/48 p-4 backdrop-blur-xl">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground/70">
          New Session
        </p>
      </div>

      <div className="mt-4 space-y-3">
        {/* existing form fields remain the same */}
        <Button
          className="h-10 w-full rounded-full text-[13px] font-medium"
          onClick={onSubmit}
          disabled={loading}
        >
          {loading ? "Starting..." : "Connect"}
        </Button>

        {error ? (
          <p className="text-sm text-red-500" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run the integration tests to verify the UI still fails only because the page has not been wired yet**

Run: `pnpm --filter frontend test -- --run frontend/src/App.test.tsx`

Expected: FAIL, but with component compilation succeeding and failures now isolated to `index.tsx` still rendering the old drawer flow.

- [ ] **Step 5: Commit the presentational component checkpoint**

```bash
git add frontend/src/pages/home/components/home-sidebar.tsx frontend/src/pages/home/components/home-header.tsx frontend/src/pages/home/components/new-session-form.tsx frontend/src/App.test.tsx
git commit -m "feat: add home left rail presentation"
```

### Task 3: Rewire The Home Page To Use The Left Rail Instead Of The Drawer

**Files:**

- Modify: `frontend/src/pages/home/index.tsx`
- Delete: `frontend/src/pages/home/components/session-drawer.tsx`
- Test: `frontend/src/App.test.tsx`

- [ ] **Step 1: Remove drawer-only state and imports from the home page**

```tsx
import { HomeHeader } from "./components/home-header";
import { HomeSidebar } from "./components/home-sidebar";
import { LatestSessionCard } from "./components/latest-session-card";
import { parseSessionHeaders } from "./utils";

const [activeSessionMenuId, setActiveSessionMenuId] = useState<string | null>(
  null,
);
```

Replace with:

```tsx
import { HomeHeader } from "./components/home-header";
import { HomeSidebar } from "./components/home-sidebar";
import { LatestSessionCard } from "./components/latest-session-card";
import { parseSessionHeaders } from "./utils";
```

And remove:

```tsx
const [isSessionDrawerOpen, setIsSessionDrawerOpen] = useState(false);
const [activeSessionMenuId, setActiveSessionMenuId] = useState<string | null>(
  null,
);
```

- [ ] **Step 2: Delete the drawer refresh/menu effects that are no longer needed**

Remove this effect:

```tsx
useEffect(() => {
  if (!isSessionDrawerOpen) {
    setActiveSessionMenuId(null);
    return;
  }

  void loadSessions();
}, [isSessionDrawerOpen, loadSessions]);
```

Remove this effect too:

```tsx
useEffect(() => {
  if (!activeSessionMenuId) {
    return;
  }

  const handlePointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    if (target.closest("[data-session-menu-root='true']")) {
      return;
    }

    setActiveSessionMenuId(null);
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      setActiveSessionMenuId(null);
    }
  };

  window.addEventListener("pointerdown", handlePointerDown);
  window.addEventListener("keydown", handleKeyDown);

  return () => {
    window.removeEventListener("pointerdown", handlePointerDown);
    window.removeEventListener("keydown", handleKeyDown);
  };
}, [activeSessionMenuId]);
```

- [ ] **Step 3: Render the new two-column layout with the sidebar pinned on the left**

```tsx
return (
  <main className="relative min-h-screen overflow-hidden px-4 py-6 sm:px-8 sm:py-8">
    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(217,226,211,0.75),transparent_32%),radial-gradient(circle_at_80%_20%,rgba(68,136,146,0.16),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(191,166,122,0.18),transparent_28%)]" />
    <div className="relative mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-7xl flex-col gap-8">
      <HomeHeader connectionName={connectionName} />

      <section className="grid flex-1 gap-6 lg:grid-cols-[420px_minmax(0,1fr)]">
        <HomeSidebar
          terminalLoading={terminalLoading}
          terminalError={terminalError}
          connectionName={connectionName}
          onSwitchConnection={onSwitchConnection}
          onOpenTerminal={() => {
            void createTerminal();
          }}
          onLogout={() => {
            clearToken();
            navigate("/login", { replace: true });
          }}
          sessionSourceType={sessionSourceType}
          onSessionSourceTypeChange={changeSessionSourceType}
          sessionName={sessionName}
          onSessionNameChange={(value) => {
            setSessionName(value);
            setSessionNameCustomized(
              value.trim() !== "" &&
                value.trim() !== getDefaultSessionName(sessionSourceType),
            );
          }}
          cdpEndpoint={cdpEndpoint}
          cdpEndpointPlaceholder={defaultCdpEndpoint}
          onCdpEndpointChange={(value) => {
            setCdpEndpointCustomized(true);
            setCdpEndpoint(value);
          }}
          proxyEnabled={proxyEnabled}
          onProxyEnabledChange={setProxyEnabled}
          requestHeadersInput={requestHeadersInput}
          onRequestHeadersInputChange={setRequestHeadersInput}
          loading={loading}
          error={error}
          sessions={sortedSessions}
          loadingSessions={loadingSessions}
          deletingSessionId={deletingSessionId}
          onSubmitSession={() => {
            void createSession();
          }}
          onRenameSession={(sessionId) => {
            void renameSession(sessionId);
          }}
          onRemoveSession={(sessionId) => {
            void removeSession(sessionId);
          }}
          onResumeSession={enterSession}
        />

        <div className="flex min-h-[640px] items-stretch">
          <LatestSessionCard
            session={recentSession}
            onEnterSession={enterSession}
          />
        </div>
      </section>
    </div>
  </main>
);
```

- [ ] **Step 4: Remove the drawer close call after session creation and delete the old drawer file**

Replace:

```tsx
await loadSessions();
setIsSessionDrawerOpen(false);
enterSession(data.sessionId);
```

With:

```tsx
await loadSessions();
enterSession(data.sessionId);
```

Then remove the file:

```bash
rm frontend/src/pages/home/components/session-drawer.tsx
```

- [ ] **Step 5: Run the home integration test file to verify the wiring passes**

Run: `pnpm --filter frontend test -- --run frontend/src/App.test.tsx`

Expected: PASS, including the new assertions that the old drawer entry point no longer exists.

- [ ] **Step 6: Commit the layout rewiring**

```bash
git add frontend/src/pages/home/index.tsx frontend/src/pages/home/components/home-sidebar.tsx frontend/src/pages/home/components/home-header.tsx frontend/src/pages/home/components/new-session-form.tsx frontend/src/App.test.tsx frontend/src/pages/home/components/session-drawer.tsx
git commit -m "feat: move session management into home left rail"
```

### Task 4: Make Session Actions Flat And Always Visible

**Files:**

- Modify: `frontend/src/pages/home/components/session-list.tsx`
- Modify: `frontend/src/pages/home/components/session-list-item.tsx`
- Test: `frontend/src/App.test.tsx`

- [ ] **Step 1: Remove the overflow-menu API from the session list**

```tsx
interface SessionListProps {
  sessions: SessionListItem[];
  loadingSessions: boolean;
  deletingSessionId: string | null;
  onRenameSession: (sessionId: string) => void;
  onRemoveSession: (sessionId: string) => void;
  onResumeSession: (sessionId: string) => void;
}

export function SessionList({
  sessions,
  loadingSessions,
  deletingSessionId,
  onRenameSession,
  onRemoveSession,
  onResumeSession,
}: SessionListProps) {
  if (loadingSessions && sessions.length === 0) {
    return (
      <div className="rounded-[1.25rem] border border-dashed border-border/60 px-5 py-6 text-sm text-muted-foreground">
        Loading sessions...
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="rounded-[1.25rem] border border-dashed border-border/60 px-5 py-6 text-sm text-muted-foreground">
        No sessions yet.
      </div>
    );
  }

  return (
    <>
      {sessions.map((session) => (
        <SessionCard
          key={session.sessionId}
          session={session}
          isDeleting={deletingSessionId === session.sessionId}
          onRename={() => onRenameSession(session.sessionId)}
          onRemove={() => onRemoveSession(session.sessionId)}
          onResume={() => onResumeSession(session.sessionId)}
        />
      ))}
    </>
  );
}
```

- [ ] **Step 2: Replace the hidden action menu with visible inline buttons**

```tsx
import type { SessionListItem as SessionListItemType } from "@browser-viewer/shared";
import { Button } from "../../../components/ui/button";
import {
  getHeaderSummaryLabel,
  getProxyStatusLabel,
  getSessionSourceLabel,
} from "../utils";

export function SessionListItem({
  session,
  isDeleting,
  onRename,
  onRemove,
  onResume,
}: SessionListItemProps) {
  return (
    <article className="rounded-[1.25rem] border border-border/60 bg-card/72 p-4 transition-colors hover:border-border/80">
      <div className="min-w-0 space-y-3">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${session.connected ? "bg-emerald-500" : "bg-stone-400"}`}
          />
          <span className="text-xs text-muted-foreground">
            {session.connected ? "Live" : "Idle"}
          </span>
        </div>

        <p className="text-lg font-semibold tracking-[-0.04em] text-foreground">
          {session.name}
        </p>

        <p className="text-sm text-muted-foreground/80">
          {getSessionSourceLabel(session.sourceType)}
          {" · "}
          {getProxyStatusLabel(session.proxyEnabled)}
          {" · "}
          {getHeaderSummaryLabel(session.headers)}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" className="rounded-full px-4" onClick={onResume}>
          Open
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full px-4"
          onClick={onRename}
        >
          Rename
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full px-4 text-red-500 hover:text-red-600"
          disabled={isDeleting}
          onClick={onRemove}
        >
          {isDeleting ? "Removing..." : "Remove"}
        </Button>
      </div>
    </article>
  );
}
```

- [ ] **Step 3: Run the session-focused test case to verify inline actions are now present**

Run: `pnpm --filter frontend test -- --run frontend/src/App.test.tsx -t "renders session management inline on the home page without a sessions drawer"`

Expected: PASS with visible `Open`, `Rename`, and `Remove` buttons in the left rail.

- [ ] **Step 4: Run the broader frontend checks for the home route**

Run: `pnpm --filter frontend test -- --run frontend/src/App.test.tsx`

Expected: PASS

Run: `pnpm typecheck`

Expected: PASS

- [ ] **Step 5: Commit the visible session actions**

```bash
git add frontend/src/pages/home/components/session-list.tsx frontend/src/pages/home/components/session-list-item.tsx frontend/src/App.test.tsx
git commit -m "feat: show home session actions inline"
```

## Self-Review

### Spec Coverage

- Remove top-right `Sessions` entrance: covered in Task 1 and Task 3.
- Remove drawer UI entirely: covered in Task 3.
- Move session-related content to the left side: covered in Task 2 and Task 3.
- Flatten the session list and actions into always-visible cards: covered in Task 4.
- Keep create/open/rename/remove session capabilities: covered in Task 2, Task 3, and Task 4.
- Move top operations into the left area: covered in Task 2 and Task 3.

### Placeholder Scan

- No `TODO`, `TBD`, or “similar to previous task” references remain.
- Each code-changing step includes concrete TypeScript or shell content.
- Every verification step includes an exact command and expected result.

### Type Consistency

- The plan consistently uses `HomeSidebar`, `onSubmitSession`, `onRenameSession`, `onRemoveSession`, and `onResumeSession`.
- Session source types remain `"launch" | "connect-cdp"` everywhere.
- `SessionList` and `SessionListItem` both use the inline button API and no longer reference menu-toggle state.
