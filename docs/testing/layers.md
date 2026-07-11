# 测试层级与命名

## 当前策略

- 本仓库只保留 Playwright E2E 作为正式自动化测试。
- E2E 文件位于 `frontend/tests/*.spec.ts`。
- 架构约束由 `pnpm architecture:check` 的集成检查负责，不属于单元测试。
- 不维护 backend、Electron、CLI、`packages/shared` 的单元测试、Vitest 测试、Node test 测试、live test 或 coverage 门槛。
- 不新增 `*.test.*`、`*.ui.test.*` 或非 `frontend/tests` 下的 `*.spec.*` 测试文件。

## 保留

- `frontend/tests/smoke.spec.ts`

当前 smoke E2E 只覆盖真实登录和 Terminal Workspace 基线。terminal 创建与输入输出、terminal events、tmux/vim、Preview、日志、App、Electron 等路径继续按 `docs/testing/` 中对应测试案例，用真实服务和 `$playwright-cli` / `$computer-use` 验收；不要写成尚不存在的 spec。

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

- 架构门禁：`pnpm architecture:check`
- 浏览器行为：`pnpm --filter ./frontend exec playwright test tests/<name>.spec.ts`
- 前端类型：`pnpm --filter ./frontend typecheck`
- App 类型/构建：`pnpm --filter @runweave/app typecheck`、`pnpm --filter @runweave/app build`
- 后端/Electron/CLI/shared：使用对应 package 的 `typecheck`、`lint`、`build` 或手工冒烟验证。
