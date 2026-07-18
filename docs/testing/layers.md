# 测试层级与命名

## 当前策略

- 本仓库只保留 Playwright E2E 作为正式自动化测试。
- 新增或重写的测试计划使用 `docs/testing/**/*.testplan.yaml`，格式见 `test-plan-format.md`；
  Agent Team 只解析该 YAML，不解析 Markdown 测试案例；单个计划最多 20 条 case。
- E2E 文件位于 `frontend/tests/*.spec.ts`。
- 架构约束由 `pnpm architecture:check` 的集成检查负责，不属于单元测试。
- 不维护 backend、Electron、CLI、`packages/shared` 的单元测试、Vitest 测试、Node test 测试、live test 或 coverage 门槛。
- 不新增 `*.test.*`、`*.ui.test.*` 或非 `frontend/tests` 下的 `*.spec.*` 测试文件。
- YAML 测试计划是可追溯的验收合同，不是自动化测试替代品。涉及浏览器页面的计划，仍须使用
  `$toolkit:playwright-cli` 在真实目标页面取证；涉及桌面端时先用 `$computer-use` 准备环境。

## 保留

- `frontend/tests/smoke.spec.ts`
- `frontend/tests/worktree-terminal-context.spec.ts`

两条 E2E 的责任边界：

- `smoke.spec.ts`：真实登录与 Terminal Workspace 的基础可用性。
- `worktree-terminal-context.spec.ts`：父 Project / Worktree 子 Project 的唯一生效 `projectId`、
  Terminal 创建、固定状态、折叠状态和 missing Context 的回归。

其余 Terminal、Agent Team、Browser、Activity、App、Electron、CLI 和平台路径，按
`docs/testing/**/*.testplan.yaml` 中对应计划在真实服务上验收；不要引用或补造不存在的 spec。

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
- YAML 格式：`pnpm testplan:verify`；新增或重写计划后执行
  `pnpm testplan:validate <path>`。
- 浏览器 E2E：`pnpm --filter @runweave/frontend test:e2e`；可按现存文件精确执行
  `tests/smoke.spec.ts` 或 `tests/worktree-terminal-context.spec.ts`。
- 浏览器与 App 行为：按对应 YAML 计划使用 `$toolkit:playwright-cli`；桌面端联动先用
  `$computer-use` 准备目标实例。
- 前端类型：`pnpm --filter ./frontend typecheck`
- App 类型/构建：`pnpm --filter @runweave/app typecheck`、`pnpm --filter @runweave/app build`
- 后端/Electron/CLI/shared：使用对应 package 的 `typecheck`、`lint`、`build` 或手工冒烟验证。
