# Test Command Matrix

| Change scenario                 | Required command                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Frontend copy/style only        | `pnpm --filter ./frontend test -- src/...`                                                              |
| Frontend state/interaction      | `pnpm run test:ui`                                                                                      |
| Backend route/service logic     | `pnpm --filter ./backend test -- src/...`                                                               |
| Shared protocol type change     | `pnpm --filter ./packages/shared test && pnpm --filter ./backend test && pnpm --filter ./frontend test` |
| Critical browser user journey   | `pnpm run test:e2e -- tests/interaction.spec.ts`                                                        |
| External dependency risk change | `pnpm run test:live`                                                                                    |
| Pre-merge full confidence       | `pnpm run test:default && pnpm run test:ui && pnpm run test:e2e`                                        |

## Anti-patterns

- Do not run only E2E for pure logic changes.
- Do not use live as daily default regression.
- Do not skip shared tests after protocol changes.
