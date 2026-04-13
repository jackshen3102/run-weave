# Terminal Ralph Performance Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a repeatable Ralph-style optimization loop for the terminal input echo latency problem, then run isolated candidate fixes against the same baseline and keep only changes that beat the baseline without terminal regressions.

**Architecture:** Treat performance optimization as an experiment harness first, implementation second. A benchmark creates many terminal tabs with large scrollback and background output, measures input-to-echo latency on the active terminal, records xterm/WebSocket render timings, then compares candidates from isolated git worktrees against the baseline. Winning candidates are cherry-picked or merged; losing candidates are removed with their worktrees.

**Tech Stack:** React 19, Vite, Playwright, xterm.js, Express, ws, node-pty, pnpm workspaces, git worktree.

---

## Code Facts

- The terminal workspace renders one `TerminalSurface` for every session in `sessions`, not just the active tab. Inactive surfaces are moved offscreen with `-left-[9999em] pointer-events-none`, but they remain mounted and connected. See `frontend/src/components/terminal/terminal-workspace.tsx`.
- Each `TerminalSurface` creates an xterm instance, loads renderer/search/link/unicode addons, opens a WebSocket through `useTerminalConnection`, and writes every output chunk into xterm via `terminal.write(...)`. See `frontend/src/components/terminal/terminal-surface.tsx`.
- The frontend connection hook logs every terminal WebSocket input/output/status event with `console.info("[terminal-perf-fe]", ...)`. See `frontend/src/features/terminal/use-terminal-connection.ts`.
- The backend terminal WebSocket path uses `TerminalOutputBatcher` with a 16 ms batch window and immediate flushing after input. See `backend/src/ws/terminal-server.ts` and `backend/src/terminal/output-batcher.ts`.
- Backend terminal code also logs every relevant output/input/batcher event with `console.info("[terminal-perf-be]", ...)` in `terminal-server.ts`, `output-batcher.ts`, and `pty-service.ts`.
- Live snapshots are limited to `TERMINAL_CLIENT_SCROLLBACK_LINES = 1_000`, but persisted scrollback can reach 10 MiB. See `packages/shared/src/terminal-limits.ts`.
- Existing regression entry points are `pnpm --filter ./frontend e2e -- tests/terminal.spec.ts tests/terminal-vim.spec.ts`, plus backend terminal tests listed in `docs/testing/runbooks/terminal-vim.md`.

## Working Hypotheses

1. Inactive terminal surfaces are doing unnecessary work: every open tab maintains an active WS subscriber and xterm renderer, so many terminals with large/active output can consume the main thread even when only one terminal is visible.
2. High-frequency perf logging is likely amplifying the slowdown. Logging every chunk and every input/output transition can be expensive in Chromium DevTools/Electron, especially with many terminals.
3. `terminal.write()` on large chunks or many surfaces can starve input echo callbacks. The backend prioritizes the next chunk after input, but the frontend has no explicit render queue that can prioritize active-terminal echo over background writes.
4. Snapshot restore and refresh/fitting work may contribute when switching tabs or reconnecting, but the symptom described, input echo lag while many terminals are open, points first at active background rendering/logging.

## Ralph Loop

The loop is:

1. Establish baseline metrics on current `main`.
2. Create one isolated worktree per candidate branch.
3. Apply exactly one optimization idea per candidate.
4. Run the same benchmark and terminal regression suite.
5. Compare candidate metrics to baseline.
6. Keep a candidate only if it clears the performance threshold and all regressions pass.
7. Remove losing worktrees/branches, then either stack compatible winners or keep the single best patch.

Recommended worktree location: use `~/.config/superpowers/worktrees/browser-viewer/<branch>` unless the repo adds and commits a `.worktrees/` ignore rule first. Current inspection found no existing `.worktrees/` or `worktrees/` directory and no ignore match for them.

## Benchmark Definition

Create `frontend/tests/terminal-performance.spec.ts` and tag it so it is not part of default E2E unless explicitly requested.

Scenario:

- Login with the existing E2E auth helper pattern from `frontend/tests/terminal.spec.ts`.
- Create `TERMINAL_PERF_SESSION_COUNT=8` terminal sessions through `/api/terminal/session`.
- Open the terminal workspace so every session mounts.
- For each terminal, seed large scrollback by running a deterministic command such as:

```bash
python3 - <<'PY'
for i in range(12000):
    print(f"seed-line-{i:05d} abcdefghijklmnopqrstuvwxyz")
PY
```

- On inactive terminals, start moderate background output:

```bash
while true; do python3 - <<'PY'
for i in range(120):
    print(f"bg-line-{i:03d} abcdefghijklmnopqrstuvwxyz")
PY
sleep 0.05
done &
```

- On the active terminal, run 30 echo probes. Each probe types a unique marker and waits until the accessible terminal output contains it:

```bash
printf 'BV_ECHO_MARKER_<run>_<probe>\n'
```

Collect:

- `echoLatencyMs` per probe, measured in Playwright from just before `page.keyboard.type(...)` to marker visibility in `getByLabel("Terminal output")`.
- Browser long tasks via `PerformanceObserver` injected with `page.addInitScript`.
- Browser console events with prefix `[terminal-perf-fe]`, summarized into counts and render-duration percentiles.
- Backend log events with prefix `[terminal-perf-be]`, summarized into counts and batch/input timing percentiles.
- Open/mount time until the active terminal is visible and first prompt/output appears.
- Error counts and WebSocket reconnect counts.

Output one JSON file per run:

```json
{
  "candidate": "baseline",
  "commit": "<git-sha>",
  "sessions": 8,
  "seedLinesPerSession": 12000,
  "probes": 30,
  "echoLatencyMs": { "p50": 0, "p95": 0, "max": 0 },
  "longTasks": { "count": 0, "totalMs": 0, "maxMs": 0 },
  "frontendRenderMs": { "p50": 0, "p95": 0, "max": 0 },
  "backendBatchFlushes": 0,
  "errors": []
}
```

Acceptance rule:

- Candidate must pass terminal regressions.
- Candidate median-of-runs `echoLatencyMs.p95` must improve by at least 20% versus baseline.
- Candidate must not regress `echoLatencyMs.p50`, open/mount time, or reconnect/error count by more than 10%.
- Run at least 5 iterations per candidate and compare median p50/p95 across iterations, not a single run.

## Candidate Experiments

### Candidate A: Gate Terminal Perf Logging

Change:

- Add a shared helper or local guard so terminal perf logs are disabled by default.
- Enable them only when an explicit env/localStorage flag is set, for example `VITE_TERMINAL_PERF_LOGS=true` on frontend and `TERMINAL_PERF_LOGS=true` on backend.

Files:

- `frontend/src/features/terminal/use-terminal-connection.ts`
- `frontend/src/components/terminal/terminal-surface.tsx`
- `backend/src/ws/terminal-server.ts`
- `backend/src/terminal/output-batcher.ts`
- `backend/src/terminal/pty-service.ts`

Why first:

- Very low behavior risk.
- Current code logs on every high-frequency terminal event.
- It can be measured independently and may remove a large source of main-thread and stdout pressure.

### Candidate B: Active-Only Terminal Surfaces

Change:

- In `terminal-workspace.tsx`, render `TerminalSurface` only for the active session.
- Preserve tab metadata via existing session list state and `/api/terminal/session/:id` metadata calls.
- On tab switch, mount the new surface and rely on the existing WebSocket `snapshot` to restore the latest live scrollback.

Files:

- `frontend/src/components/terminal/terminal-workspace.tsx`
- Possibly `frontend/src/components/terminal/terminal-surface.tsx` if active assumptions can be simplified.

Risks:

- Inactive tab activity/bell markers may no longer update live unless a lightweight non-rendering subscription is added later.
- Tab switching may show snapshot restore latency.

Pass criteria:

- Echo latency improves materially under many sessions.
- Existing tab selection refresh test still passes.
- Vim resize E2E still passes.
- Inactive terminals continue running on the backend even while not mounted.

### Candidate C: Headless Inactive Connections

Change:

- Split terminal connection from terminal rendering.
- Keep a lightweight inactive-session subscriber that reads WS output for activity/bell metadata without `Terminal` construction or `terminal.write(...)`.
- Mount full `TerminalSurface` only for the active session.

Files:

- Create `frontend/src/components/terminal/inactive-terminal-listener.tsx`
- Modify `frontend/src/components/terminal/terminal-workspace.tsx`
- Modify `frontend/src/components/terminal/terminal-surface.tsx` only if props need separation

Why:

- Keeps live activity markers while avoiding xterm renderer work for inactive tabs.

Risks:

- More code than Candidate B.
- Still keeps many WS subscriptions, so backend and JSON parse costs remain.

### Candidate D: Frontend Output Render Scheduler

Change:

- Introduce a small queue around `terminal.write(...)`.
- Coalesce background output into one write per animation frame.
- Mark output following local input as interactive and write it before queued bulk output.
- Keep snapshot writes serialized and never interleave snapshot and live output.

Files:

- Create `frontend/src/features/terminal/output-render-scheduler.ts`
- Modify `frontend/src/components/terminal/terminal-surface.tsx`
- Add Vitest coverage for the scheduler because it is non-UI `*.ts` logic.

Why:

- Directly targets xterm write pressure and input starvation.

Risks:

- Ordering bugs can corrupt terminal output.
- Needs careful tests around flush ordering and disposal.

### Candidate E: Tune Backend Interactive Batching

Change:

- Make `TerminalOutputBatcher` configurable.
- Experiment with a smaller interactive flush path and a larger non-interactive batch window, for example 8 ms interactive / 24 ms bulk.
- Keep the current 16 ms behavior as the default until benchmark proves otherwise.

Files:

- `backend/src/terminal/output-batcher.ts`
- `backend/src/ws/terminal-server.ts`
- `backend/src/terminal/output-batcher.test.ts`

Why:

- Backend already has the concept of `markNextChunkInteractive()`.
- This may improve echo latency if server-side flush timing is part of the lag.

Risks:

- Too many small flushes can increase WS and frontend parse overhead.

## Automation Script

Create `scripts/terminal-perf-ralph.mjs` after the benchmark exists.

Responsibilities:

- Record baseline commit with `git rev-parse HEAD`.
- Run baseline benchmark on the current tree.
- For each candidate name:
  - Create worktree at `~/.config/superpowers/worktrees/browser-viewer/perf-terminal-<candidate>`.
  - Create branch `perf/terminal-<candidate>`.
  - Run a candidate-specific patch instruction, or pause for agent implementation if running manually.
  - Run:

```bash
pnpm --filter ./backend test -- src/terminal/output-batcher.test.ts src/ws/terminal-server.test.ts
pnpm --filter ./frontend test -- src/features/terminal
pnpm --filter ./frontend e2e -- tests/terminal.spec.ts tests/terminal-vim.spec.ts tests/terminal-performance.spec.ts
```

- Save artifacts to `artifacts/terminal-perf/<timestamp>/<candidate>/`.
- Compare JSON summaries.
- Print a leaderboard and a keep/revert recommendation.

Do not let the automation run `git reset --hard`. Losing candidates should be abandoned by removing their worktrees with `git worktree remove <path>` after review.

## Execution Order

1. Add the Playwright terminal performance benchmark and artifact summarizer.
2. Run baseline 5 times on `main`; save the JSON report.
3. Run Candidate A in an isolated worktree.
4. If A wins and passes regressions, keep it as the new baseline for stacked experiments.
5. Run Candidate B and Candidate C separately against the same original baseline and, if A wins, against A-stacked baseline.
6. Run Candidate D only after B/C results show remaining frontend render starvation.
7. Run Candidate E only if backend timestamps show meaningful delay between input received and output flushed.
8. Merge the smallest winning set, then run:

```bash
pnpm typecheck
pnpm lint
pnpm --filter ./backend test -- src/terminal/pty-service.test.ts src/ws/heartbeat.test.ts src/ws/terminal-server.test.ts
pnpm --filter ./frontend test -- src/services/terminal.test.ts src/features/terminal
pnpm --filter ./frontend e2e -- tests/terminal.spec.ts tests/terminal-vim.spec.ts tests/terminal-performance.spec.ts
```

## Recommended First Bet

Start with Candidate A and Candidate B in parallel. Candidate A is the lowest-risk cleanup and likely removes measurable overhead. Candidate B attacks the most suspicious structural cause in the current code: every terminal tab is fully mounted, connected, and rendering even when hidden offscreen.

Candidate C is the fallback if Candidate B improves latency but loses important inactive-tab activity behavior. Candidate D is the more surgical render-path fix if active-only rendering is not enough. Candidate E should be evidence-driven because backend already has interactive flush logic and may not be the bottleneck.
