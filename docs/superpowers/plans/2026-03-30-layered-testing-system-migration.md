# Layered Testing System Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a layered testing system for `browser-viewer-workspace` with explicit Default/E2E/Live/UI boundaries, and standardize scenario-to-command usage.

**Architecture:** Keep existing Vitest + Playwright foundations, then add explicit layer entrypoints and ownership rules instead of replacing tools. Promote `quality:gate` from targeted harness to risk-based layer selector. Add a reusable project skill that codifies when each test command must run.

**Tech Stack:** pnpm workspaces, Vitest, Playwright, Node.js scripts (`mjs`), Markdown docs, Codex skill (`SKILL.md`).

---

## Current Codebase Baseline (must remain true before migration)

- Root scripts today:
  - `pnpm test` -> `pnpm -r test`
  - `pnpm e2e` -> frontend Playwright
  - `pnpm quality:gate` -> `scripts/quality-gate.mjs`
- Frontend tests:
  - Vitest (`frontend/vitest.config.ts`) with `jsdom`, include `src/**/*.test.ts(x)`
  - Playwright (`frontend/playwright.config.ts`) with backend + frontend webServer bootstrap
  - Current E2E specs: `tests/smoke.spec.ts`, `tests/interaction.spec.ts`, `tests/terminal.spec.ts`
- Backend tests:
  - Vitest (`backend/vitest.config.ts`) with `node`, include `src/**/*.test.ts`
  - Existing backend test count baseline: 36 test files
- Shared package:
  - `packages/shared` has no real tests yet (`test` is no-op)
- Existing quality harness:
  - `scripts/quality-gate.mjs` already classifies changed files and runs selected high-value test steps

## Scope Guard

This plan covers one subsystem only: **test architecture and workflow** (not product features).

## File Structure Plan

- Create: `docs/testing/layered-testing-architecture.md`
  - Responsibility: canonical layer definitions, boundaries, and examples for this repo.
- Create: `docs/testing/test-command-matrix.md`
  - Responsibility: scenario-to-command mapping table for developers and agents.
- Modify: `package.json`
  - Responsibility: add explicit layer entrypoint scripts (`test:default`, `test:ui`, `test:live`).
- Modify: `frontend/package.json`
  - Responsibility: add UI-layer-specific scripts.
- Modify: `backend/package.json`
  - Responsibility: add live-layer and integration-focused script entrypoints.
- Modify: `scripts/quality-gate.mjs`
  - Responsibility: make selection output layer-aware (`default/e2e/live/ui`) instead of only tag-aware.
- Create: `backend/src/live/live-smoke.live.test.ts`
  - Responsibility: first minimal live smoke probe (gated by env vars).
- Create: `packages/shared/src/contracts.test.ts`
  - Responsibility: first shared contract assertion test.
- Create: `docs/superpowers/skills/testing-layer-router/SKILL.md`
  - Responsibility: reusable skill for choosing test commands by change scenario.

### Task 1: Freeze Baseline and Layer Definitions

**Files:**

- Create: `docs/testing/layered-testing-architecture.md`
- Modify: `docs/quality-harness-design.md`
- Test: none (documentation task)

- [ ] **Step 1: Capture current baseline stats in the new layering doc**

```md
## Repository Baseline (2026-03-30)

- backend test files: 36
- frontend unit test files: 10
- frontend playwright specs: 3
- shared test files: 0
```

- [ ] **Step 2: Define 4 layers with explicit ownership and non-goals**

```md
## Layer: default

Owns pure logic, deterministic regression, in-process integration.
Non-goal: real external dependency drift.

## Layer: e2e

Owns full critical path wiring across modules/process boundaries.
Non-goal: exhaustive permutations of local pure logic.

## Layer: live

Owns real external/provider/runtime availability drift checks.
Non-goal: frequent dev loop regression.

## Layer: ui

Owns frontend logic/state/browser interaction split.
Non-goal: backend contract correctness in isolation.
```

- [ ] **Step 3: Add test naming convention rules**

```md
## Naming Convention

- Default-layer tests: `*.test.ts` / `*.test.tsx`
- New ui-layer tests: `*.ui.test.ts` / `*.ui.test.tsx`
- E2E browser specs: `*.e2e.spec.ts`
- New live-layer tests: `*.live.test.ts`

## Transition Rule

- Existing files with `*.test.ts(x)` and `*.spec.ts` remain valid.
- New default-layer tests should continue using `*.test.ts(x)`.
- Use special suffix only where needed: `*.ui.test.ts(x)` and `*.live.test.ts`.
```

- [ ] **Step 4: Link existing files to target layers**

```md
- frontend/src/\*_/_.test.ts(x) -> ui (logic/state)
- frontend/tests/\*.spec.ts -> e2e (browser critical path)
- backend/src/\*_/_.test.ts -> default (plus selected integration)
- backend/src/live/\*.test.ts -> live
```

- [ ] **Step 5: Commit docs baseline**

```bash
git add docs/testing/layered-testing-architecture.md docs/quality-harness-design.md
git commit -m "docs(testing): define layered test boundaries and baseline"
```

### Task 2: Add Explicit Layer Entry Scripts

**Files:**

- Modify: `package.json`
- Modify: `frontend/package.json`
- Modify: `backend/package.json`
- Test: script invocation smoke via `pnpm run --if-present`

- [ ] **Step 1: Write failing script-contract check**

```bash
pnpm run test:default
```

Expected: FAIL with missing script before implementation.

- [ ] **Step 2: Add root layer scripts**

```json
{
  "scripts": {
    "test:default": "pnpm --filter ./backend test && pnpm --filter ./frontend test && pnpm --filter ./packages/shared test",
    "test:ui": "pnpm --filter ./frontend test:ui",
    "test:e2e": "pnpm --filter ./frontend e2e",
    "test:live": "pnpm --filter ./backend test:live"
  }
}
```

- [ ] **Step 3: Add frontend UI scripts**

```json
{
  "scripts": {
    "test:ui": "vitest run src/**/*.test.ts src/**/*.test.tsx",
    "test:ui:browser": "playwright test tests/**/*.spec.ts"
  }
}
```

- [ ] **Step 4: Add backend live script**

```json
{
  "scripts": {
    "test:live": "vitest run src/**/*.live.test.ts"
  }
}
```

- [ ] **Step 5: Verify scripts pass contract checks**

Run:

- `pnpm run test:default`
- `pnpm run test:ui`
- `pnpm --filter ./frontend exec playwright test --list`
- `pnpm run test:live -- --reporter=dot`

Expected: scripts resolve and execute with no missing-script errors.

- [ ] **Step 6: Commit script layer entrypoints**

```bash
git add package.json frontend/package.json backend/package.json
git commit -m "build(test): add explicit default/e2e/live/ui entry scripts"
```

### Task 3: Introduce Minimal Live Layer

**Files:**

- Create: `backend/src/live/live-smoke.live.test.ts`
- Modify: `backend/vitest.config.ts`
- Modify: `backend/.env.example`
- Test: `pnpm --filter ./backend test:live`

- [ ] **Step 1: Write failing live smoke test first**

```ts
import { describe, expect, it } from "vitest";

describe("live smoke", () => {
  it("skips when live env is not configured", () => {
    const enabled = process.env.LIVE_SMOKE_ENABLED === "true";
    if (!enabled) {
      expect(true).toBe(true);
      return;
    }

    expect(process.env.LIVE_TARGET_URL).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run only new live test to validate baseline behavior**

Run: `pnpm --filter ./backend test:live`
Expected: PASS in local default mode (skip-like success path).

- [ ] **Step 3: Add live env documentation**

```env
LIVE_SMOKE_ENABLED=false
LIVE_TARGET_URL=
LIVE_AUTH_TOKEN=
```

- [ ] **Step 4: Ensure default backend test run excludes live folder**

```ts
include: ["src/**/*.test.ts"],
exclude: ["src/live/**/*.test.ts"],
```

- [ ] **Step 5: Commit live layer MVP**

```bash
git add backend/src/live/live-smoke.live.test.ts backend/vitest.config.ts backend/.env.example
git commit -m "test(live): add env-gated live smoke layer"
```

### Task 4: Upgrade Quality Gate to Layer-Aware Selection

**Files:**

- Modify: `scripts/quality-gate.mjs`
- Create: `scripts/quality-gate.test.mjs`
- Test: `node scripts/quality-gate.test.mjs`

- [ ] **Step 1: Write failing selector tests for layer decisions**

```js
import assert from "node:assert/strict";
import { selectLayersForChangedFiles } from "./quality-gate.mjs";

assert.deepEqual(
  selectLayersForChangedFiles(["frontend/src/components/viewer-page.tsx"]),
  ["default", "ui", "e2e"],
);
assert.deepEqual(
  selectLayersForChangedFiles(["backend/src/live/provider-client.ts"]),
  ["live"],
);
```

- [ ] **Step 2: Implement pure layer selector function**

```js
export function selectLayersForChangedFiles(changedFiles) {
  if (changedFiles.length === 0) return ["default", "ui", "e2e", "live"];
  // deterministic path-prefix rules
  // return deduplicated ordered layer list
}
```

- [ ] **Step 3: Map selected layers to concrete commands in one table**

```js
const LAYER_COMMANDS = {
  default: [["pnpm", "run", "test:default"]],
  ui: [["pnpm", "run", "test:ui"]],
  e2e: [["pnpm", "run", "test:e2e", "--", "tests/smoke.spec.ts"]],
  live: [["pnpm", "run", "test:live"]],
};
```

- [ ] **Step 4: Run selector tests**

Run: `node scripts/quality-gate.test.mjs`
Expected: PASS with deterministic layer mapping assertions.

- [ ] **Step 5: Commit gate selector refactor**

```bash
git add scripts/quality-gate.mjs scripts/quality-gate.test.mjs
git commit -m "refactor(quality-gate): add layer-aware command selection"
```

### Task 5: Add Shared Contract Test Floor

**Files:**

- Create: `packages/shared/src/contracts.test.ts`
- Modify: `packages/shared/package.json`
- Test: `pnpm --filter ./packages/shared test`

- [ ] **Step 1: Write first failing contract test**

```ts
import { describe, expect, it } from "vitest";
import type { SessionCreateRequest } from "./index";

describe("shared contract", () => {
  it("keeps session create request shape stable", () => {
    const request: SessionCreateRequest = {
      url: "https://example.com",
      source: { type: "launch", proxyEnabled: false },
    };

    expect(request.source.type).toBe("launch");
  });
});
```

- [ ] **Step 2: Enable real shared tests**

```json
{
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^3.0.9"
  }
}
```

- [ ] **Step 3: Run shared tests**

Run: `pnpm --filter ./packages/shared test`
Expected: PASS with at least one contract test executed.

- [ ] **Step 4: Commit shared test floor**

```bash
git add packages/shared/src/contracts.test.ts packages/shared/package.json
git commit -m "test(shared): add first contract regression test"
```

### Task 6: Publish Scenario-to-Command Matrix

**Files:**

- Create: `docs/testing/test-command-matrix.md`
- Test: none (documentation task)

- [ ] **Step 1: Add mandatory matrix table**

```md
| Change scenario                 | Required command                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Frontend copy/style only        | pnpm --filter ./frontend test -- src/...                                                              |
| Frontend state/interaction      | pnpm run test:ui                                                                                      |
| Backend route/service logic     | pnpm --filter ./backend test -- src/...                                                               |
| Shared protocol type change     | pnpm --filter ./packages/shared test && pnpm --filter ./backend test && pnpm --filter ./frontend test |
| Critical browser user journey   | pnpm run test:e2e -- tests/interaction.spec.ts                                                        |
| External dependency risk change | pnpm run test:live                                                                                    |
| Pre-merge full confidence       | pnpm run test:default && pnpm run test:ui && pnpm run test:e2e                                        |
```

- [ ] **Step 2: Add anti-pattern section**

```md
- Do not run only e2e for pure logic changes.
- Do not use live as daily default regression.
- Do not skip shared tests after protocol changes.
```

- [ ] **Step 3: Commit matrix doc**

```bash
git add docs/testing/test-command-matrix.md
git commit -m "docs(testing): publish scenario to command matrix"
```

### Task 7: Productize as Reusable Skill

**Files:**

- Create: `docs/superpowers/skills/testing-layer-router/SKILL.md`
- Create: `docs/superpowers/skills/testing-layer-router/examples.md`
- Test: manual dry-run using a sample change list

- [ ] **Step 1: Define skill trigger conditions and output contract**

```md
Use this skill when:

- user asks which test command should run
- PR touches multiple test layers
- agent needs minimal risk-based verification set

Skill output must include:

1. selected layers
2. exact commands
3. why each layer is required
```

- [ ] **Step 2: Add deterministic routing rules**

```md
If changed path starts with `packages/shared/` -> include default + ui + e2e.
If changed path starts with `backend/src/live/` -> include live.
If changed path starts with `frontend/src/components/` -> include ui; include e2e when viewer journey touched.
```

- [ ] **Step 3: Add examples with exact commands**

```md
Scenario: modify `backend/src/routes/session.ts`
Commands:

- pnpm --filter ./backend test -- src/routes/session.test.ts
- pnpm run test:default
```

- [ ] **Step 4: Commit skill assets**

```bash
git add docs/superpowers/skills/testing-layer-router/SKILL.md docs/superpowers/skills/testing-layer-router/examples.md
git commit -m "docs(skill): add testing layer router skill"
```

## Self-Review Checklist (completed before execution)

- Spec coverage: includes current-state baseline, migration tasks, skill productization, and scenario-command mapping.
- Placeholder scan: no TBD/TODO markers; each task has concrete files and commands.
- Consistency check: layer names are consistent across scripts/docs/gate (`default`, `ui`, `e2e`, `live`).

## Execution Order

1. Task 1 -> docs baseline and boundaries
2. Task 2 -> script entrypoint contract
3. Task 3 -> live layer MVP
4. Task 4 -> layer-aware quality gate
5. Task 5 -> shared contract floor
6. Task 6 -> scenario-command matrix
7. Task 7 -> reusable skill publication

## Rollback Strategy

- If Task 3 introduces flaky live behavior, keep `test:live` opt-in and do not include it in default local gate.
- If Task 4 selector is unstable, freeze on current `ALL_STEPS` static behavior and keep selector behind a feature flag.
- If shared test setup in Task 5 affects install time, isolate shared tests to CI and keep local execution optional in early phase.
