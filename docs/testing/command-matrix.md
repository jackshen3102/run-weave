# 测试命令选择

先按 `docs/testing/` 中的 YAML 计划选择真实验收路径，再补与变更范围匹配的静态门禁。
`typecheck`、`lint` 和 `architecture:check` 只是前置门禁，不能代替页面、桌面或协议行为证据。

| 变更场景                                 | 必跑前置命令                                                                                                                           | 真实验收与计划入口                                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 测试计划或测试目录治理                   | `pnpm testplan:verify`；`pnpm testplan:validate [path]`；`git diff --check`                                                            | 无产品行为变更时不启动运行环境；确认仅保留 `*.testplan.yaml`、每份不超过 20 条 case，且 `docs/README.md` 索引一致。                                                                     |
| 前端文案、样式、TSX 组件                 | `pnpm --filter @runweave/frontend typecheck`；`pnpm --filter @runweave/frontend lint`                                                  | 执行 `pnpm --filter @runweave/frontend test:e2e -- tests/smoke.spec.ts`；页面变更再按对应 YAML 用 `$toolkit:playwright-cli` 验收。                                                      |
| Worktree Project Context                 | `pnpm --filter @runweave/backend typecheck`；`pnpm --filter @runweave/frontend typecheck`                                              | 执行 `pnpm --filter @runweave/frontend test:e2e -- tests/worktree-terminal-context.spec.ts`，再按 `terminal/worktree-project-context.testplan.yaml` 用 `$toolkit:playwright-cli` 取证。 |
| Terminal Runtime、Panel、状态或事件      | `pnpm --filter @runweave/backend typecheck`；`pnpm --filter @runweave/backend lint`；受影响端的 typecheck                              | 按 `terminal/terminal-runtime-core.testplan.yaml` 通过真实 tmux Terminal 和 `$toolkit:playwright-cli` 验收；不可用环境必须记录阻塞原因。                                                |
| Agent Team、outbox、repair 或 checkpoint | `pnpm --filter @runweave/backend typecheck`；`pnpm agent-team:verify-review-checkpoints`                                               | 按 `agent-team/agent-team-core.testplan.yaml` 在真实 tmux pane、outbox 和 sidecar 上验收。                                                                                              |
| Terminal Browser、CDP 或 MCP             | `pnpm --filter @runweave/shared typecheck`；`pnpm --filter @runweave/electron typecheck`；`pnpm --filter @runweave/frontend typecheck` | 按 `terminal/terminal-browser-core.testplan.yaml`；用 Dev Session 的 `terminal-browser` surface 附着 `$toolkit:playwright-cli`，不得使用默认或全局 endpoint。                           |
| App 连通性、认证或移动端 Terminal        | `pnpm --filter @runweave/app typecheck`；必要时 `pnpm --filter @runweave/app build`                                                    | 按 `app/app-connectivity-core.testplan.yaml` 用 `$toolkit:playwright-cli` 验证真实 App 页面和网络状态。                                                                                 |
| Activity 数据、查询或留存                | `pnpm --filter @runweave/backend typecheck`；`pnpm activity:verify`                                                                    | 按 `architecture/activity-data-foundation.testplan.yaml` 通过真实 Backend/API 和 `$toolkit:playwright-cli` 验证查询界面。                                                               |
| Dev Session、Beta、更新、Electron 或 CLI | 受影响 package 的 `typecheck`/`lint`；更新规划时执行对应 dry-run                                                                       | 按 `platform/development-control-plane.testplan.yaml`；Session 生命周期必须使用 `$toolkit:runweave-dev-session`，桌面端先用 `$computer-use`，页面再附着目标 CDP。                       |
| Prototype Gallery 或 Explorer 搜索       | `pnpm --filter @runweave/backend typecheck`；`pnpm --filter @runweave/frontend typecheck`                                              | 分别按 `browser/prototype-gallery-preview.testplan.yaml` 或 `runbooks/explorer-quick-search.testplan.yaml` 使用 `$toolkit:playwright-cli` 验收。                                        |
| 跨运行时架构或共享协议                   | `pnpm --filter @runweave/shared typecheck`；`pnpm architecture:check`；受影响 consumer 的 typecheck                                    | 按 `architecture/cross-runtime-architecture-regressions.testplan.yaml` 做跨端闭环核对；协议不能只验证单端。                                                                             |
| 预合并全量自动化信心                     | `pnpm quality:gate`                                                                                                                    | 该门禁会执行架构、typecheck、lint 与 `pnpm test:e2e`；当前 E2E 包含 `smoke.spec.ts` 和 `worktree-terminal-context.spec.ts`。                                                            |
| 纯文档整理或文档保鲜                     | `git diff --check`                                                                                                                     | 用 `git diff --name-only` 确认只改允许的文档范围；仅在测试计划格式/索引变更时执行对应 `testplan` 校验。                                                                                 |

## 反模式

- 新增或恢复单元测试、Vitest、Node test、live test、coverage 门槛。
- 为非浏览器逻辑补 `*.test.*` 或非 `frontend/tests` 下的 `*.spec.*` 文件。
- 后端、Electron、CLI、shared 变更只跑 E2E；这类变更至少需要对应 package 的 typecheck/lint/build 或手工冒烟。
- 协议变更只改一端，不做 shared / backend / frontend 联动验证。
- 用静态门禁、截图或代码阅读替代 YAML 计划承诺的真实页面/桌面/协议证据。
- 本矩阵只引用当前仓库实际存在的自动化入口；不存在的历史 spec、runbook 或测试计划不得通过补文件或改命令的方式冒充本轮覆盖。
