# testing-layer-router examples

## Example: backend route change

Scenario: modify `backend/src/routes/session.ts`

Commands:

- `pnpm --filter ./backend test -- src/routes/session.test.ts`
- `pnpm run test:default`

## Example: shared protocol change

Scenario: modify `packages/shared/src/protocol.ts`

Commands:

- `pnpm run test:default`
- `pnpm run test:ui`
- `pnpm run test:e2e -- tests/smoke.spec.ts`
