---
name: testing-layer-router
description: Route code changes to the minimum required test layers and commands for this repository.
---

# Testing Layer Router

Use this skill when:

- a user asks which test command should run
- a PR touches multiple test layers
- an agent needs a minimal risk-based verification set

## Output Contract

Always return:

1. selected layers
2. exact commands
3. why each layer is required

## Deterministic Rules

- If changed path starts with `packages/shared/`, include `default + ui + e2e`.
- If changed path starts with `backend/src/live/`, include `live`.
- If changed path starts with `frontend/src/components/`, include `ui`; include `e2e` when viewer journey paths are touched.

## Command Defaults

- `default`: `pnpm run test:default`
- `ui`: `pnpm run test:ui`
- `e2e`: `pnpm run test:e2e -- tests/smoke.spec.ts`
- `live`: `pnpm run test:live`
