# 测试命令选择

| 变更场景               | 推荐命令                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 前端文案/样式/TSX 组件 | `pnpm --filter ./frontend exec playwright test tests/smoke.spec.ts`                                                              |
| 前端逻辑 / 状态 / URL  | `pnpm --filter ./frontend exec playwright test tests/smoke.spec.ts`                                                              |
| 终端链路 / Vim / 预览  | `pnpm --filter ./frontend exec playwright test tests/terminal.spec.ts tests/terminal-vim.spec.ts tests/terminal-preview.spec.ts` |
| 终端 Git Submit UI     | `pnpm --filter ./frontend typecheck`，再手工确认弹层向当前 terminal 发送 AI submit prompt                                        |
| 后端路由/服务逻辑      | `pnpm --filter ./backend typecheck && pnpm --filter ./backend lint`，必要时执行真实 API 或端到端冒烟                             |
| CLI / 外部控制面       | `pnpm --filter ./packages/runweave-cli typecheck && pnpm --filter ./packages/runweave-cli lint`，再手工跑 CLI                    |
| 共享协议类型变更       | `pnpm --filter ./packages/shared typecheck && pnpm --filter ./frontend exec playwright test tests/smoke.spec.ts`                 |
| Electron 客户端开发    | `pnpm --filter ./electron typecheck && pnpm dev:electron`                                                                        |
| 关键用户路径           | `pnpm --filter ./frontend exec playwright test tests/smoke.spec.ts`                                                              |
| 预合并自动化信心       | `pnpm run test:e2e`                                                                                                              |
| 纯文档整理 / 文档保鲜  | `git diff --check`，再用 `git diff --name-only` 确认只改允许的文档范围                                                           |

## 反模式

- 新增或恢复单元测试、Vitest、Node test、live test、coverage 门槛。
- 为非浏览器逻辑补 `*.test.*` 或非 `frontend/tests` 下的 `*.spec.*` 文件。
- 后端、Electron、CLI、shared 变更只跑 E2E；这类变更至少需要对应 package 的 typecheck/lint/build 或手工冒烟。
- 协议变更只改一端，不做 shared / backend / frontend 联动验证。

## Terminal Git Submit 边界

Terminal Git Submit 首期只把提交任务 prompt 发送到当前 terminal，让正在运行的 Codex、Coco 或其他 AI agent 负责检查 diff、总结提交标题、处理 rebase 冲突、lint/hook 失败和 push 结果。前端不直接执行 Git，不新增后端 Git executor，也不依赖 `rw submit` CLI。
