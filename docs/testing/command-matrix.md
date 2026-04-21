# 测试命令选择

| 变更场景               | 推荐命令                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| 前端文案/样式/TSX 组件 | `pnpm run test:e2e -- tests/interaction.spec.ts`                                            |
| 前端逻辑 / 状态 / URL  | `pnpm run test:e2e -- tests/interaction.spec.ts`                                            |
| 终端链路 / Vim / 预览  | `pnpm run test:e2e -- tests/terminal.spec.ts tests/terminal-vim.spec.ts`                    |
| 后端路由/服务逻辑      | `pnpm --filter ./backend test -- src/...`                                                   |
| 共享协议类型变更       | `pnpm --filter ./packages/shared test && pnpm --filter ./backend test && pnpm run test:e2e` |
| 关键用户路径           | `pnpm run test:e2e -- tests/interaction.spec.ts`                                            |
| 外部依赖风险           | `pnpm run test:live`                                                                        |
| 预合并全量信心         | `pnpm run test:default && pnpm run test:e2e`                                                |
| Electron 客户端开发    | `pnpm dev:electron`                                                                         |

## 反模式

- 不要为前端 `src/` 代码新增 Vitest / TDD 用例。
- 后端或共享包的纯逻辑变更不要只跑 E2E。
- 不要把 live 当作日常回归默认。
- 协议变更不要跳过 shared / backend / frontend 联动测试。
- 不要为前端 `*.tsx` 组件、页面、hooks 或 `*.ts` 状态逻辑新增单测。
