# 测试命令选择

| 变更场景                  | 推荐命令                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 前端文案/样式/TSX 组件    | `pnpm --filter ./frontend exec playwright test tests/smoke.spec.ts`；具体页面行为再按对应 Case 使用 `$toolkit:playwright-cli` 真实验收                                                                                               |
| 前端逻辑 / 状态 / URL     | `pnpm --filter ./frontend exec playwright test tests/smoke.spec.ts`；具体页面行为再按对应 Case 使用 `$toolkit:playwright-cli` 真实验收                                                                                               |
| 终端链路 / Vim / 预览     | 当前仓库仅有 `frontend/tests/smoke.spec.ts`；先执行 `pnpm test:e2e`，再按 `terminal/` 对应 Case 或 `runbooks/terminal-vim.md` 使用 `$toolkit:playwright-cli` 真实验收，不引用不存在的 spec 文件                                      |
| Terminal Browser 注释模式 | `pnpm --filter @runweave/shared typecheck && pnpm --filter ./electron typecheck && pnpm --filter ./frontend typecheck`，再按 Terminal Browser Case 使用 `$toolkit:playwright-cli`；Electron BrowserView 交互用 Electron dev 手工冒烟 |
| Web 日志上报入口          | `pnpm --filter ./frontend typecheck && pnpm --filter ./frontend lint`，再按 `docs/quality/ai-diagnostic-logging.md` 使用 `$toolkit:playwright-cli` 真实验收；当前没有独立 `terminal-diagnostic-logs.spec.ts`                         |
| 后端路由/服务逻辑         | `pnpm --filter ./backend typecheck && pnpm --filter ./backend lint`，必要时执行真实 API 或端到端冒烟                                                                                                                                 |
| CLI / 外部控制面          | `pnpm --filter ./packages/runweave-cli typecheck && pnpm --filter ./packages/runweave-cli lint`，再手工跑 CLI                                                                                                                        |
| 共享协议类型变更          | `pnpm --filter ./packages/shared typecheck && pnpm --filter ./frontend exec playwright test tests/smoke.spec.ts`                                                                                                                     |
| Electron 客户端开发       | `pnpm --filter ./electron typecheck`，再使用 `pnpm dev:session --profile electron`、`pnpm dev:open --surface desktop` 和 `$toolkit:playwright-cli` 验收；不要绕过 Dev Session 直接启动无关实例                                       |
| 关键用户路径              | `pnpm --filter ./frontend exec playwright test tests/smoke.spec.ts`                                                                                                                                                                  |
| 预合并自动化信心          | `pnpm test:e2e`（当前仅运行 `frontend/tests/smoke.spec.ts`）                                                                                                                                                                         |
| 架构重构 / 新增源码       | `pnpm architecture:check`；迁移期 baseline 只能递减，最终零豁免                                                                                                                                                                      |
| 纯文档整理 / 文档保鲜     | `git diff --check`，再用 `git diff --name-only` 确认只改允许的文档范围                                                                                                                                                               |

## 反模式

- 新增或恢复单元测试、Vitest、Node test、live test、coverage 门槛。
- 为非浏览器逻辑补 `*.test.*` 或非 `frontend/tests` 下的 `*.spec.*` 文件。
- 后端、Electron、CLI、shared 变更只跑 E2E；这类变更至少需要对应 package 的 typecheck/lint/build 或手工冒烟。
- 协议变更只改一端，不做 shared / backend / frontend 联动验证。
- 本矩阵只引用当前仓库实际存在的自动化入口；不存在的历史 spec 不得通过补文件或改命令的方式冒充本轮覆盖。
