# 测试层级与命名

## 当前策略

- 本仓库只保留 Playwright E2E 作为正式自动化测试。
- E2E 文件位于 `frontend/tests/*.spec.ts`。
- 不维护 backend、Electron、CLI、`packages/shared` 的单元测试、Vitest 测试、Node test 测试、live test 或 coverage 门槛。
- 不新增 `*.test.*`、`*.ui.test.*` 或非 `frontend/tests` 下的 `*.spec.*` 测试文件。

## 保留

- `frontend/tests/smoke.spec.ts`
- `frontend/tests/terminal.spec.ts`
- `frontend/tests/terminal-vim.spec.ts`
- `frontend/tests/terminal-preview.spec.ts`
- `frontend/tests/terminal-snapshot-race.spec.ts`
- `frontend/tests/terminal-performance.spec.ts`

## 删除

- `backend/src/**/*.test.ts`
- `backend/src/**/*.live.test.ts`
- `electron/src/**/*.test.ts`
- `packages/shared/src/**/*.test.ts`
- `packages/runweave-cli/src/**/*.test.ts`
- `*.test.mjs`
- `vitest.config.ts`
- `vitest.live.config.ts`

## 验证替代

- 浏览器行为：`pnpm --filter ./frontend exec playwright test tests/<name>.spec.ts`
- 前端类型：`pnpm --filter ./frontend typecheck`
- App 类型/构建：`pnpm --filter @runweave/app typecheck`、`pnpm --filter @runweave/app build`
- 后端/Electron/CLI/shared：使用对应 package 的 `typecheck`、`lint`、`build` 或手工冒烟验证。
