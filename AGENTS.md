# AGENTS.md

Repo-specific guidance for coding agents working in `browser-viewer-workspace`.
Use this file as the local source of truth for commands and style.

## Scope

- Repo root: `/Users/bytedance/Desktop/vscode/browser-hub/feat`
- Package manager: `pnpm@10.6.2`
- Workspaces: `frontend`, `backend`, `packages/shared`
- Root scripts fan out with `pnpm -r` or `pnpm --filter`

## Existing Rule Files

- No earlier `AGENTS.md` existed in this repo.
- No `.cursorrules` file exists.
- No files exist under `.cursor/rules/`.
- No `.github/copilot-instructions.md` file exists.
- If any of those files are added later, merge them with this document.

## Repo Layout

- `frontend`: React 19, Vite, Tailwind, Vitest, Playwright.
- `backend`: Express service plus Playwright-based browser control.
- `packages/shared`: shared protocol and payload types.
- Shared types should be the contract between frontend and backend.

## Setup

- Install deps: `pnpm install`
- Create backend env: `cp backend/.env.example backend/.env`
- Required env vars: `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_JWT_SECRET`
- Common optional env vars: `PORT`, `FRONTEND_ORIGIN`, `AUTH_TOKEN_TTL_SECONDS`, `BROWSER_PROFILE_DIR`, `BROWSER_HEADLESS`

## Root Commands

- Dev: `pnpm dev`
- Dev with headed browser: `pnpm dev:headed`
- Build all: `pnpm build`
- Lint all: `pnpm lint`
- Typecheck all: `pnpm typecheck`
- Test all: `pnpm test`
- Coverage: `pnpm coverage`
- Frontend e2e: `pnpm e2e`

## Workspace Commands

- Frontend: `pnpm --filter ./frontend dev|build|lint|typecheck|test|test:coverage|e2e`
- Backend: `pnpm --filter ./backend dev|dev:headed|build|lint|typecheck|test|test:coverage`
- Shared: `pnpm --filter ./packages/shared build|lint|typecheck|test`
- Note: shared `lint` is `tsc --noEmit`, not ESLint.

## Single-Test Recipes

- Frontend single file: `pnpm --filter ./frontend test -- src/App.test.tsx`
- Frontend single test name: `pnpm --filter ./frontend test -- src/App.test.tsx -t "renders login page by default"`
- Frontend watch one file: `pnpm --filter ./frontend exec vitest src/App.test.tsx`
- Backend single file: `pnpm --filter ./backend test -- src/routes/auth.test.ts`
- Backend single test name: `pnpm --filter ./backend test -- src/routes/auth.test.ts -t "returns token for valid credentials"`
- Backend watch one file: `pnpm --filter ./backend exec vitest src/routes/auth.test.ts`
- E2E single spec: `pnpm --filter ./frontend e2e -- tests/smoke.spec.ts`
- E2E single test name: `pnpm --filter ./frontend e2e -- tests/smoke.spec.ts -g "control panel page loads"`

## Lint And Verification

- Lint one frontend file: `pnpm --filter ./frontend exec eslint src/App.tsx`
- Lint one backend file: `pnpm --filter ./backend exec eslint src/routes/auth.ts`
- Pre-commit hook runs `pnpm lint-staged`.
- `lint-staged` rules: `*.{ts,tsx,js,jsx,mjs,cjs}` -> `eslint --fix`; `*.{json,md,yaml,yml,css}` -> `prettier --write`
- There is no dedicated single-file typecheck script; use the workspace `typecheck` command.

## Test Boundaries

- Frontend unit tests run in `jsdom`.
- Backend unit tests run in `node`.
- Frontend setup file: `frontend/src/test/setup.ts`
- Frontend unit tests live under `frontend/src/**/*.test.ts?(x)`.
- Backend unit tests live under `backend/src/**/*.test.ts`.
- Playwright specs live in `frontend/tests/**/*.spec.ts`.
- Coverage thresholds in frontend and backend are `lines 70`, `functions 70`, `statements 70`, `branches 60`.

## TypeScript Rules

- The repo uses ESM everywhere with `"type": "module"`.
- Base TS config is `tsconfig.base.json`.
- Important compiler settings: `strict: true`, `noUncheckedIndexedAccess: true`, `moduleResolution: "Bundler"`, `target: "ES2022"`.
- Keep explicit types at exported boundaries.
- Prefer `interface` for named object shapes such as props, config, payloads, and result objects.
- Prefer `type` aliases for unions, mapped types, and derived types.
- Use discriminated unions for protocol messages.
- Use exhaustive `never` checks in `switch` statements over unions.
- Prefer explicit `Promise<T>` return types on exported async functions.

## Imports

- Group imports as: Node built-ins, external packages, workspace packages, then relative local imports.
- Use `import type` for type-only imports.
- Relative imports are the norm inside each package.
- Do not add a new alias system unless the repo adopts one intentionally.

## Formatting

- Follow nearby file formatting first.
- Use 2-space indentation.
- Use double quotes.
- Keep semicolons.
- Keep trailing commas in multiline arrays, objects, and calls.
- Prefer early returns over nested conditionals.
- Split long objects and function calls across lines in the surrounding file's style.
- Avoid decorative comments; only comment non-obvious logic.

## Naming

- Components and classes: `PascalCase`
- Hooks: `useSomething`
- Functions and variables: `camelCase`
- Module-level constants: `UPPER_SNAKE_CASE`
- Interfaces and result objects commonly use suffixes like `Props`, `Options`, `Response`, or `Result`.
- Files generally use kebab-case.
- Unit tests use `*.test.ts` or `*.test.tsx`; Playwright uses `*.spec.ts`.

## Frontend Conventions

- Use React function components and hooks.
- Type component props with explicit interfaces.
- Tailwind utilities are the default styling approach.
- Use `cn` from `frontend/src/lib/utils.ts` for class merging.
- Use `class-variance-authority` for variant-heavy UI primitives.
- Preserve the existing `next-themes` pattern for theme-aware UI.
- Handle request failures with `HttpError` from `frontend/src/services/http.ts`.
- Direct browser globals such as `window.location` are acceptable when they fit the current pattern.

## Backend Conventions

- Build routers as factory functions like `createAuthRouter` and `createSessionRouter`.
- Validate request bodies with `zod` before doing real work.
- Return structured JSON errors with meaningful HTTP status codes.
- Use guard clauses for invalid input and missing resources.
- Throw `Error` for invalid env config, impossible states, and exhaustive-switch failures.
- Keep orchestration in route handlers and concrete work in services or classes.
- Reuse `@browser-viewer/shared` payload types instead of duplicating them.

## Error Handling And Logging

- Fail fast on missing required env vars.
- Use `safeParse` for untrusted request payloads.
- Keep runtime logs error-only: remove `console.log/info/debug/warn` from app runtime code unless explicitly required for temporary debugging.
- Use `console.error` for failures and include minimal structured context.
- Stable log prefixes matter: frontend uses `[viewer-fe]`, backend uses `[viewer-be]`.
- On expected `401` auth failures in the frontend, clear auth state rather than retrying blindly.

## Testing Conventions

- Import Vitest helpers explicitly: `describe`, `it`, `expect`, `beforeEach`, `afterEach`, `vi`.
- Frontend tests should assert visible behavior with Testing Library.
- Backend tests often create lightweight local Express servers instead of mocking the entire stack.
- Clean up sockets, timers, localStorage, and servers explicitly.
- Name tests after behavior, not implementation details.
- If you change shared protocol types, run both frontend and backend tests.
- If you change websocket behavior, run backend websocket tests and affected frontend viewer tests.
- If you change a browser flow, run the closest Vitest file and at least one Playwright spec when relevant.

## TDD Skill Policy

- Treat the `test-driven-development` skill as selective guidance, not a mandatory default for every task.
- Invoke the `test-driven-development` skill for bug fixes, backend route or service logic, auth flows, shared protocol or schema changes, state transitions, and other behavior-heavy changes with clear expected outcomes.
- Prefer a failing test first for high-risk regressions, contract changes, and logic with meaningful edge cases.
- Do not invoke the `test-driven-development` skill for pure styling, copy changes, layout tweaks, exploratory UI iteration, throwaway prototypes, or other work where behavior is not yet stable enough to specify precisely.
- For frontend visual work, lightweight verification is enough unless behavior changes: run the closest affected test, add or update tests only when user-visible behavior or a regression boundary changes.
- Do not force "every new function must have a test". Test critical behaviors, public contracts, and regression-prone paths instead of mechanically testing trivial helpers.
- When the skill is used, adapt it to this repo: use the smallest failing test that proves the change, prefer real behavior over mock-heavy tests, and stop at the level of coverage justified by risk.

## Playwright Skill Policy

- Treat `playwright-skill` as opt-in only. Do not load or invoke it unless the user explicitly asks for `playwright-skill` by name, or the user explicitly confirms its use after the agent proposes it.
- If the agent believes browser automation or visual verification would help, the agent must first explain why `playwright-skill` is the right tool for the task and ask for confirmation before loading it.
- Do not silently invoke `playwright-skill` for routine frontend work, simple UI edits, styling tweaks, copy changes, static analysis, or checks that can be covered by code reading, Vitest, Testing Library, or existing project Playwright commands.
- Prefer the repo's built-in commands such as `pnpm --filter ./frontend e2e` when the task is about maintaining or running project Playwright tests, and reserve `playwright-skill` for ad hoc browser automation, manual verification support, screenshots, or exploratory browser debugging.
- When proposing `playwright-skill`, state the expected benefit clearly, such as validating a login flow, reproducing a browser-only bug, checking responsive layout, or capturing screenshots for review.

## Agent Workflow Tips

- Start with the narrowest command that proves the change.
- Prefer targeted tests before full workspace runs.
- Avoid unnecessary new dependencies.
- Keep shared protocol edits compatible across both app sides.
- Do not remove useful diagnostic logs unless you replace them with equally useful signals.
- If you touch lint-sensitive files, consider running `pnpm lint-staged` before finishing.
