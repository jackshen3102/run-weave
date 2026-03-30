# Browser Viewer Quality Harness Design

## 1. Purpose

This document defines a repo-specific quality architecture for `browser-viewer`.

The goal is not to add more end-to-end scripts. The goal is to let an agent:

- verify critical user journeys after code changes
- distinguish product regressions from test fragility and environment noise
- collect enough system evidence to make a reliable verdict
- rerun the smallest useful validation set
- form a practical self-verifying loop

The design is tailored to the current repo shape:

- frontend SPA: React + Vite + Tailwind
- backend: Express + WebSocket + Playwright
- shared protocol: `packages/shared`
- current quality baseline: unit tests, backend integration tests, a small Playwright suite

## Layered Test Entry Points

The repository-level validation model uses explicit layer entry commands:

- `pnpm run test:default`
- `pnpm run test:ui`
- `pnpm run test:e2e`
- `pnpm run test:live`

Detailed boundaries, naming conventions, and file-to-layer mapping are documented in `docs/testing/layered-testing-architecture.md`.

## 2. Problem Statement

The current quality model is necessary but insufficient for autonomous verification.

### 2.1 Current strengths

- Shared protocol types already exist in `packages/shared`.
- Backend has route, session, auth, and ws-level tests.
- Frontend has reducer and component tests.
- Playwright e2e already covers a basic session creation and viewer interaction path.

### 2.2 Current gaps

- E2E coverage is thin and mostly happy-path.
- E2E assertions are UI-heavy and do not reliably prove internal system convergence.
- The system lacks semantic probes for session health, first frame, ack flow, reconnect recovery, and failure classification.
- Validation mostly runs against dev servers, not a production-like build.
- There is no verdict engine that turns raw evidence into a stable quality decision.
- The agent can execute checks, but it cannot reliably decide whether the product is genuinely safe.

### 2.3 Design consequence

The repo needs a Quality Harness layer between raw tests and merge decisions.

That harness must be:

- semantic, not selector-driven
- layered, not e2e-only
- probe-based, not log-guessing
- deterministic where possible
- consumable by agents through structured outputs

## 3. Non-Goals

This design does not try to:

- fully replace Playwright
- automate arbitrary third-party websites with perfect reliability
- auto-fix all product bugs
- guarantee full autonomy on every change
- solve large-scale performance or load testing

The target is narrower and more realistic:

- achieve reliable autonomous verification for the repo's critical paths
- keep the scope small enough to implement incrementally

## 4. Critical Journeys

The system should treat the following as first-class quality contracts.

### 4.1 Tier-1 journeys

- `auth.login.success`
- `session.create.launch`
- `viewer.connect.initial-frame`
- `viewer.input.ack`
- `viewer.navigation.roundtrip`
- `viewer.ws.reconnect.recover`

### 4.2 Tier-2 journeys

- `viewer.popup-tab-sync`
- `viewer.restore.persisted-session`
- `viewer.clipboard.copy`
- `viewer.devtools.open`

Tier-1 journeys must be blocking quality gates.
Tier-2 journeys can initially be warning-level or change-triggered.

## 5. Quality Model

The core shift is:

> do not ask "did Playwright pass?"
>
> ask "did the system reach the expected semantic milestones for the impacted critical journeys?"

Each journey is defined by:

- intent
- preconditions
- stimulus
- expected milestones
- timeout budget
- success criteria
- failure taxonomy

Example:

```ts
interface QualityScenario {
  id: string;
  tier: "tier1" | "tier2";
  intent: string;
  preconditions: string[];
  stimulus: string[];
  requiredProbes: string[];
  milestones: Array<{
    id: string;
    timeoutMs: number;
  }>;
  successCriteria: string[];
  failureTaxonomy: string[];
  retryPolicy: {
    maxAttempts: number;
    retryableFailureKinds: string[];
  };
}
```

## 6. Architecture Overview

The Quality Harness should be implemented as six cooperating layers.

### 6.1 Scenario Contract Layer

Responsibility:

- define critical journeys in a stable machine-readable form
- map change impact to the minimum required verification set
- provide a consistent language for probes, tests, and verdicts

Suggested location:

- `packages/shared/src/quality.ts`
- `backend/src/quality/scenarios.ts`

### 6.2 Probe Layer

Responsibility:

- collect semantic runtime events
- maintain per-session quality snapshots
- expose a machine-readable health API

This is the most important missing layer in the current repo.

### 6.3 Deterministic Test World

Responsibility:

- provide test pages and fault injection scenarios that are owned by the repo
- reduce dependence on unstable third-party pages
- allow reliable reproduction of races and recovery paths

### 6.4 Gate Runner

Responsibility:

- execute layered validation
- gather evidence from tests, probes, and artifacts
- produce a normalized report

### 6.5 Verdict Engine

Responsibility:

- turn raw evidence into a stable decision
- classify failure cause
- recommend next action

### 6.6 Agent Orchestrator

Responsibility:

- analyze diff impact
- pick the smallest useful gate set
- run validation
- optionally perform one bounded repair attempt
- rerun only the affected validations

## 7. Probe Layer Design

### 7.1 Probe principles

- Probes must describe semantic milestones, not debug trivia.
- Probes must be cheap enough to leave enabled in validation mode.
- Probes must be queryable by test code and by agents.
- Probes must support timeline reconstruction.

### 7.2 Probe entities

Suggested event families:

- session lifecycle
- browser context lifecycle
- page lifecycle
- screencast lifecycle
- websocket lifecycle
- navigation lifecycle
- input/ack lifecycle
- reconnect lifecycle
- error events

Suggested event type examples:

- `session.created`
- `session.destroyed`
- `browser.context.ready`
- `viewer.ws.connected`
- `viewer.ws.disconnected`
- `viewer.ws.reconnect-started`
- `viewer.ws.reconnect-recovered`
- `viewer.tabs.initialized`
- `viewer.tab.activated`
- `viewer.frame.first`
- `viewer.frame.stalled`
- `viewer.navigation.requested`
- `viewer.navigation.committed`
- `viewer.navigation.settled`
- `viewer.input.received`
- `viewer.input.acked`
- `viewer.error`

### 7.3 Session quality snapshot

Suggested snapshot shape:

```ts
export interface SessionQualitySnapshot {
  sessionId: string;
  journeyStatus: "idle" | "running" | "healthy" | "degraded" | "failed";
  viewerConnected: boolean;
  activeTabId: string | null;
  tabCount: number;
  firstFrameAt: string | null;
  lastFrameAt: string | null;
  lastAckAt: string | null;
  lastNavigationSettledAt: string | null;
  reconnectCount: number;
  milestones: {
    tabsInitialized: boolean;
    firstFrame: boolean;
    navigationWorking: boolean;
    inputAckWorking: boolean;
    reconnectRecovered: boolean;
  };
  recentErrors: Array<{
    code: string;
    message: string;
    at: string;
  }>;
}
```

### 7.4 Proposed backend modules

Suggested new files:

- `backend/src/quality/probe-types.ts`
- `backend/src/quality/probe-store.ts`
- `backend/src/quality/session-probe.ts`
- `backend/src/quality/quality-report.ts`
- `backend/src/routes/quality.ts`

### 7.5 Integration points

Probe instrumentation should be added at these points:

- `SessionManager`
  record create, destroy, markConnected, restore
- `BrowserService`
  record launch/connect and page creation
- `attachWebSocketServer`
  record ws connect/disconnect, tabs initialized, ack emitted, errors
- screencast controller
  record first frame and frame stall
- navigation handler
  record request, commit, settle, failure
- input handler
  record input received and ack emitted
- reconnect logic in frontend
  optionally emit client-side quality events for correlation

### 7.6 Probe APIs

Suggested endpoints:

- `GET /api/quality/session/:id`
  returns `SessionQualitySnapshot`
- `GET /api/quality/session/:id/timeline`
  returns recent probe events
- `POST /api/quality/session/:id/reset`
  clears per-session probe data for fresh validation

These endpoints should be enabled only in local validation or test mode.

## 8. Deterministic Test World

The existing `/test/*` routes are a good start but need to become a reusable validation substrate.

### 8.1 Goals

- own the pages that model critical viewer behaviors
- make races reproducible
- inject bounded failures
- support journey validation without relying on external internet variability

### 8.2 Suggested test routes

- `/test/slow-frame`
- `/test/navigation-chain`
- `/test/popup-race`
- `/test/input-latency`
- `/test/cursor-state`
- `/test/clipboard-flow`
- `/test/disconnect-recover`
- `/test/dom-shift`
- `/test/error-page`

### 8.3 Fault injection controls

Add query or route-level controls for:

- delayed load
- delayed first frame
- delayed ack
- forced websocket close
- forced popup ordering differences
- navigation redirect chains

Examples:

- `/test/popup-race?children=2&delay=500`
- `/test/disconnect-recover?closeAfterMs=1500`
- `/test/input-latency?ackDelayMs=1000`

## 9. Layered Gates

A single `pnpm e2e` is not a sufficient release signal for this project.

### 9.1 Gate A: Contract Gate

Purpose:

- catch cheap, deterministic regressions early

Includes:

- shared protocol validation
- zod schema checks
- reducer and state transition tests
- backend route/service tests
- ws message parsing and handler tests

Blocking:

- yes

### 9.2 Gate B: Probe Gate

Purpose:

- verify system milestones with a real backend and real browser, without requiring full journey UI assertions

Examples:

- session create -> snapshot becomes healthy
- first frame appears within budget
- tabs initialize
- navigation settles
- ack path works

Blocking:

- yes

This is expected to become the highest-value gate for agent autonomy.

### 9.3 Gate C: Journey Gate

Purpose:

- validate the user-visible critical paths end to end

Execution rules:

- keep the suite intentionally small
- only tier-1 journeys are always blocking
- tier-2 journeys are impact-based
- every major journey assertion should be cross-checked with probe evidence

Blocking:

- yes for tier-1

### 9.4 Gate D: Resilience Gate

Purpose:

- prove the system is not only passing under perfect timing

Examples:

- delayed first frame
- one websocket disconnect and recovery
- popup/tab ordering variation
- delayed input ack

Blocking:

- initially warning-level
- move to blocking once the signal quality is stable

## 10. Production-Like Validation

Current e2e is wired to dev servers. That is useful but not sufficient.

At minimum, the harness should support:

- dev-mode validation for fast iteration
- production-like validation using built assets and `pnpm start`
- headless mode
- headed mode for one small canary set

Recommended policy:

- PR default: contract + probe + tier-1 journey on dev-mode
- pre-merge or release candidate: add production-like tier-1 journey run
- nightly: add headed and resilience canaries

## 11. Verdict Engine

The verdict engine should consume:

- test exit codes
- probe timelines
- quality snapshots
- Playwright traces
- console errors
- network errors
- change impact

It should output a stable structure:

```ts
export interface QualityVerdict {
  verdict:
    | "pass"
    | "pass_with_risk"
    | "fail_product_bug"
    | "fail_test_bug"
    | "fail_env_noise";
  confidence: number;
  impactedJourneys: string[];
  failedJourneys: string[];
  evidence: string[];
  rootCauseHypothesis: string;
  recommendedNextAction: string;
  score: number;
}
```

### 11.1 Failure taxonomy

Suggested coarse failure classes:

- `product.behavior`
- `product.timing`
- `product.state-sync`
- `test.selector-fragility`
- `test.assumption-mismatch`
- `env.startup`
- `env.port-conflict`
- `env.browser-crash`
- `unknown`

### 11.2 Hard fail rules

Immediate failure if any of these happen:

- a tier-1 journey is unreachable
- first frame never arrives
- reconnect never recovers where required
- probe state contradicts UI success
- uncategorized fatal backend/runtime error occurs

## 12. Quality Score

Use a simple weighted score instead of opaque heuristics.

Suggested initial weights:

- contract gate: 20
- session creation and viewer connect: 15
- first frame: 15
- navigation: 10
- input ack: 10
- reconnect recovery: 10
- popup/tab sync: 10
- resilience checks: 10

Initial thresholds:

- `85-100`: `pass`
- `70-84`: `pass_with_risk`
- `<70`: fail

Hard-fail rules override score.

## 13. Agent Self-Verification Loop

The agent workflow should be explicit and bounded.

### 13.1 Flow

1. Read git diff and changed file list.
2. Map changes to impacted areas.
3. Select the smallest required gate set.
4. Reset probe state for affected sessions.
5. Run gates in order: contract -> probe -> journey -> resilience as needed.
6. Aggregate artifacts and probe evidence.
7. Produce verdict.
8. If failure is in an allowed auto-repair class, perform one repair attempt.
9. Rerun only the impacted gates.
10. Produce final verdict and report.

### 13.2 Allowed auto-repair classes

Reasonable early-scope auto-repairs:

- selector fragility in e2e
- timeout budget adjustments where probe evidence proves health
- missing deterministic wait conditions in tests
- low-risk test harness bugs

Not recommended for early auto-repair:

- backend ordering bugs
- session lifecycle bugs
- tab identity or routing bugs
- reconnect design flaws
- state divergence between frontend and backend

## 14. Suggested File Layout

Suggested additions:

```txt
docs/
  quality-harness-design.md

backend/src/quality/
  probe-types.ts
  probe-store.ts
  session-probe.ts
  scenarios.ts
  quality-report.ts

backend/src/routes/
  quality.ts

frontend/tests/helpers/
  quality.ts

scripts/
  quality-gate.mjs
  quality-report.mjs
```

Possible shared additions:

```txt
packages/shared/src/
  quality.ts
```

## 15. Rollout Plan

Implement in stages. Do not try to ship the full harness in one pass.

### Stage M1: Minimum useful loop

Target:

- prove the harness can reliably validate the most important path

Scope:

- add probe store and session snapshot
- instrument ws connect, first frame, input ack
- add `GET /api/quality/session/:id`
- add `viewer.connect.initial-frame` scenario definition
- update one Playwright journey to cross-check probe state
- add `scripts/quality-gate.mjs`

Exit criteria:

- agent can tell whether session create + viewer connect + first frame + input ack truly succeeded

### Stage M2: State convergence and recovery

Scope:

- add tab and navigation probes
- extend `/test/*` routes for navigation and reconnect scenarios
- add reconnect and popup/tab scenarios
- add production-like run mode to gate runner

Exit criteria:

- agent can reliably judge viewer state convergence and basic recovery

### Stage M3: Resilience and verdict quality

Scope:

- add fault injection
- add resilience gate
- add failure classification
- add `pass_with_risk`
- refine change-impact mapping

Exit criteria:

- agent can separate product bugs from environment noise in most common cases

### Stage M4: Controlled auto-repair

Scope:

- allow one bounded retry/repair cycle
- restrict to harness/test fragility classes
- emit final machine-readable report

Exit criteria:

- agent can autonomously recover from a useful subset of non-product failures

## 16. Initial Implementation Backlog

Recommended implementation order:

1. Add shared quality types.
2. Add backend probe store.
3. Instrument ws connect, first frame, input ack.
4. Expose quality snapshot endpoint.
5. Add one journey that validates both UI and probe state.
6. Add quality gate script that emits a JSON report.
7. Add reconnect probes.
8. Extend test routes for deterministic recovery and timing scenarios.
9. Add verdict engine and score calculation.
10. Expand impact-based gate selection.

## 17. Risks and Mitigations

### Risk: probe noise makes verdicts unreliable

Mitigation:

- start with a small event vocabulary
- avoid logging everything
- define strict milestone semantics

### Risk: test harness becomes more complex than the product

Mitigation:

- prioritize tier-1 only first
- keep gate runner thin
- do not add speculative abstractions

### Risk: agent repair logic hides real regressions

Mitigation:

- allow only one bounded repair attempt
- never auto-repair product-behavior failures
- always retain raw artifacts and initial failure evidence

### Risk: production-like runs become too slow

Mitigation:

- make them selective
- keep nightly and pre-merge policy separate from local fast paths

## 18. Decision Log

### Decision 1

Use layered gates instead of relying on a single Playwright suite.

Reason:

- the project has multiple async boundaries
- e2e alone cannot prove semantic convergence

### Decision 2

Make probes the main quality signal.

Reason:

- agent autonomy depends more on reliable evidence than on more scripts

### Decision 3

Keep the initial scope to tier-1 journeys only.

Reason:

- reliable narrow autonomy is more valuable than broad unreliable autonomy

### Decision 4

Support production-like validation as a separate gate, not a replacement for dev-mode checks.

Reason:

- both speed and realism are needed

### Decision 5

Allow bounded auto-repair only for harness or test fragility classes.

Reason:

- aggressive repair on product bugs would reduce trust in the system

## 19. Acceptance Criteria

The design should be considered successfully implemented when all of the following are true:

- a code change triggers a deterministic gate selection
- tier-1 journeys can be verified with semantic probe evidence
- the agent can emit a structured verdict instead of raw logs
- production-like validation exists for the main path
- reconnect and timing regressions are catchable without manual browser inspection in common cases

## 20. Next Step

The next implementation document should specify:

- exact shared types for probes and verdicts
- exact probe insertion points in the backend
- exact quality gate command contract
- the first M1 task breakdown with file-level ownership
