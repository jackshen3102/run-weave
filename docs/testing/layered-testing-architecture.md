# Layered Testing Architecture

## Repository Baseline (2026-03-30)

- backend test files: 36
- frontend unit test files: 10
- frontend playwright specs: 3
- shared test files: 0

## Layer: default

Owns pure logic, deterministic regression, and in-process integration.

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

## Naming Convention

- Default-layer tests: `*.test.ts` / `*.test.tsx`
- New ui-layer tests: `*.ui.test.ts` / `*.ui.test.tsx`
- E2E browser specs: `*.e2e.spec.ts`
- New live-layer tests: `*.live.test.ts`

## Transition Rule

- Existing files with `*.test.ts(x)` and `*.spec.ts` remain valid.
- New default-layer tests should continue using `*.test.ts(x)`.
- Use special suffix only where needed: `*.ui.test.ts(x)` and `*.live.test.ts`.

## Current Mapping

- `frontend/src/**/*.test.ts(x)` -> ui (logic/state)
- `frontend/tests/*.spec.ts` -> e2e (browser critical path)
- `backend/src/**/*.test.ts` -> default (plus selected integration)
- `backend/src/**/*.live.test.ts` -> live
