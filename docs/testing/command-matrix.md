# 测试命令选择

| 变更场景                                | 推荐命令                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端文案/样式/TSX 组件                  | `pnpm run test:e2e -- tests/interaction.spec.ts`                                                                                                   |
| 前端逻辑 / 状态 / URL                   | `pnpm run test:e2e -- tests/interaction.spec.ts`                                                                                                   |
| 终端链路 / Vim / 预览                   | `pnpm run test:e2e -- tests/terminal.spec.ts tests/terminal-vim.spec.ts tests/terminal-preview.spec.ts`                                            |
| 终端 Git Submit UI                      | `pnpm --filter ./frontend typecheck`，再手工确认弹层向当前 terminal 发送 AI submit prompt                                                          |
| 终端 session 生命周期 / ID 生成         | `pnpm --filter ./backend test -- src/terminal/manager.test.ts`                                                                                     |
| 终端 project / session 排序持久化       | `pnpm --filter ./backend test -- src/terminal/manager.test.ts`，必要时补 `pnpm run test:e2e -- tests/terminal.spec.ts` 做拖拽交互回归              |
| 后端路由/服务逻辑                       | `pnpm --filter ./backend test -- src/...`                                                                                                          |
| CLI / 外部控制面                        | `pnpm --filter ./packages/runweave-cli test && pnpm --filter ./packages/runweave-cli typecheck`                                                    |
| 共享协议类型变更                        | `pnpm --filter ./packages/shared test && pnpm --filter ./backend test && pnpm run test:e2e`                                                        |
| Electron Terminal Browser CDP Proxy     | `pnpm --filter ./electron test -- terminal-browser-cdp-proxy.test.ts`，再按 `docs/testing/terminal-browser-cdp-mcp-test-cases.md` 做桌面端手工验收 |
| Electron Terminal Browser tab 恢复      | `pnpm --filter ./electron test -- terminal-browser-tabs-state.test.ts`                                                                             |
| Terminal Browser Header 规则类型 / 校验 | `pnpm --filter ./packages/shared test -- terminal-browser-headers.test.ts`                                                                         |
| 关键用户路径                            | `pnpm run test:e2e -- tests/interaction.spec.ts`                                                                                                   |
| 外部依赖风险                            | `pnpm run test:live`                                                                                                                               |
| 预合并全量信心                          | `pnpm run test:default && pnpm run test:e2e`                                                                                                       |
| Electron 客户端开发                     | `pnpm dev:electron`                                                                                                                                |
| 纯文档整理 / 文档保鲜                   | `git diff --check`，再用 `git diff --name-only` 确认只改允许的文档范围；删除文档或资产后补 `rg` 检查残留引用                                       |

## 反模式

- 不要为前端 `src/` 代码新增 Vitest / TDD 用例。
- 后端或共享包的纯逻辑变更不要只跑 E2E。
- 不要把 live 当作日常回归默认。
- 协议变更不要跳过 shared / backend / frontend 联动测试。
- 不要为前端 `*.tsx` 组件、页面、hooks 或 `*.ts` 状态逻辑新增单测。

## Terminal Git Submit 边界

Terminal Git Submit 首期只把提交任务 prompt 发送到当前 terminal，让正在运行的 Codex、Coco 或其他 AI agent 负责检查 diff、总结提交标题、处理 rebase 冲突、lint/hook 失败和 push 结果。前端不直接执行 Git，不新增后端 Git executor，也不依赖 `rw submit` CLI。
